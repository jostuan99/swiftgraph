// `flows <screen>`: the processing flows of a screen, from each entry point
// (creation, item actions, lifecycle, tasks) through the layers, in execution
// order. See docs/05-data-flow.md, section 6.2.

import { argumentIndex, parseCallPattern } from '../rules/load.ts';
import type { DeclarationInfo, TypeInfo } from '../resolve/resolve.ts';
import type { CallSite, ValueExpr } from '../schema/types.ts';
import { defineType, findScreens, pickScreen, type ScreenDefinition, type ScreenView } from './define.ts';
import { apiName, tyText, type FlowEngine, type Frame, type Location, type Traced, type Ty } from './engine.ts';
import { jsonPathText, shortSources, viewModelVariable } from './format-define.ts';

export interface FlowsOptions {
  /** A flow id (`LoginView/F2`) or an item id from `define` (`LoginView#5`). */
  entry?: string;
  /** Include the flows of child views, cells and rows (default true). */
  children?: boolean;
  /** Maximum call depth (default 12). */
  depth?: number;
  /**
   * Only steps of these layers (`ViewModel`, `Repository`; case does not
   * matter). The data sources and outcomes of hidden steps go to the nearest
   * step kept above them; flows with no such step are left out.
   */
  layers?: string[];
}

export interface FlowStep {
  depth: number;
  kind: 'call' | 'source' | 'chain' | 'closure' | 'write' | 'external' | 'guard';
  text: string;
  layer?: string;
  at: Location;
  /** Conditions under which the step runs, relative to its block. */
  when?: string;
  /** DI binding, generic binding, dispatch. */
  notes: string[];
  async?: boolean;
  warnings: string[];
  /** For `write`: the view-model property written (undefined for a UIKit view property). */
  property?: string;
  /** For `write`: where the written value comes from and how it is mapped. */
  mapping?: WriteMapping;
  /** For `write`: layer of the type that owns the written property. */
  targetLayer?: string;
}

export interface WriteMapping {
  /** Where the value comes from: `GET https://…/products title`, `userDefaults "lastUpdated"`, `ProfileViewModel.name`. */
  from: string[];
  /** The collection is mapped to this type (`items.map { ProductRowViewData(…) }`). */
  mappedTo?: string;
  /** Fields of the written type and the JSON path or source each comes from. */
  fields: { field: string; from: string; computed?: boolean }[];
}

/** The short form of a flow: what it calls, what it writes on success and on failure. */
export interface FlowSummary {
  /** Numbered steps; a step that can fail (a request, a `try?`) carries its success and failure outcomes. */
  steps: SummaryStep[];
  path: string[];
  success: FlowOutcome[];
  failure: FlowOutcome[];
  /** Data written to storage: `userDefaults "lastUpdated" ← Date()`. */
  stores: string[];
  warnings: string[];
}

export interface SummaryStep {
  number: number;
  /** Nesting below the entry (calls inside calls). */
  depth: number;
  layer?: string;
  text: string;
  notes: string[];
  at: Location;
  /** The step can fail: a response, a call whose error is caught or ignored. */
  failable?: boolean;
  success: FlowOutcome[];
  failure: FlowOutcome[];
  /** Writes of a step that cannot fail. */
  writes: FlowOutcome[];
  /** The flow goes no further: a cast that always fails. */
  stops?: string;
}

export interface FlowOutcome {
  /** `ProductListViewModel.rows`, or a view property (`titleLabel.text`). */
  target: string;
  value: string;
  /** `catch let error as AFError`, `on failure`, a branch condition. */
  when?: string;
  mapping?: WriteMapping;
  /** Items of `define` that show the target. */
  shown: string[];
  at: Location;
  /** The write never runs: the reason (a cast that always fails). */
  never?: string;
  /** A failure handler with an empty body. */
  empty?: boolean;
  /** Done inside the failure handler listed before it. */
  nested?: boolean;
  /** The error of this call is dropped with `try?`. */
  ignored?: boolean;
}

export interface ScreenFlow {
  id: string;
  /** `create`, `action`, `appear`, `task`, `lifecycle`, ... */
  kind: string;
  title: string;
  /** The `define` item the flow starts from. */
  item?: string;
  owner: string;
  at: Location;
  steps: FlowStep[];
  writes: { property: string; values: string[] }[];
  shown: { property: string; items: string[] }[];
  /** How the flow handles errors: catch blocks, failure closures, errors ignored with `try?`. */
  errors: string[];
  summary: FlowSummary;
}

export interface ScreenFlows {
  view: ScreenView;
  flows: ScreenFlow[];
}

export type FlowsLookup = { flows: ScreenFlows } | { candidates: string[]; message: string };

export function screenFlows(engine: FlowEngine, text: string, options: FlowsOptions = {}): FlowsLookup {
  const picked = pickScreen(engine, text);
  if (!('type' in picked)) return picked;
  const definition = defineType(engine, picked.type, { children: options.children !== false });
  if (options.depth !== undefined) engine.depthLimit = options.depth;
  const result = new FlowBuilder(engine, definition, options).build(picked.type);
  if (options.entry) {
    result.flows = result.flows.filter((flow) => flow.id === options.entry || flow.item === options.entry);
  }
  if (options.layers && options.layers.length > 0) {
    const layers = new Set(options.layers.map((layer) => layer.toLowerCase()));
    for (const flow of result.flows) flow.summary = keepLayers(flow.summary, layers);
    result.flows = result.flows.filter((flow) => flow.summary.steps.length > 0);
  }
  return { flows: result };
}

// --- Building ---------------------------------------------------------------------------

class FlowBuilder {
  private readonly engine: FlowEngine;
  private readonly definition: ScreenDefinition;
  private readonly options: FlowsOptions;
  private readonly flows: ScreenFlow[] = [];
  /** Property → items of `define` whose data or conditions read it. */
  private readonly shownBy = new Map<string, string[]>();

  constructor(engine: FlowEngine, definition: ScreenDefinition, options: FlowsOptions) {
    this.engine = engine;
    this.definition = definition;
    this.options = options;
    const add = (property: string, item: string) => {
      const items = this.shownBy.get(property) ?? [];
      if (!items.includes(item)) items.push(item);
      this.shownBy.set(property, items);
    };
    for (const item of definition.items) {
      for (const data of item.data) {
        if (data.input) add(data.input.property, item.id);
        const visit = (traced: Traced) => {
          for (const step of traced.steps) if (step.kind === 'property' && step.symbol) add(step.symbol, item.id);
          if (traced.origin.kind === 'derived') traced.origin.inputs.forEach(visit);
          if (traced.origin.kind === 'source') traced.origin.input?.forEach(visit);
        };
        data.traced.forEach(visit);
      }
    }
    for (const condition of definition.conditions) for (const item of condition.items) add(condition.property, item);
  }

  build(type: TypeInfo): ScreenFlows {
    this.collect(type);
    if (this.options.children !== false) {
      for (const child of this.definition.children) {
        const childType = findScreens(this.engine, child.name)[0];
        if (childType && childType !== type) this.collect(childType);
      }
    }
    const screen = this.definition.view.name;
    this.flows.forEach((flow, index) => (flow.id = `${screen}/F${index + 1}`));
    return { view: this.definition.view, flows: this.flows };
  }

  private members(type: TypeInfo): DeclarationInfo[] {
    const result: DeclarationInfo[] = [];
    for (const list of type.members.values()) {
      for (const member of list) {
        const info = this.engine.infoOf(member);
        if (info && !result.includes(info)) result.push(info);
      }
    }
    return result.sort((a, b) => a.file.path.localeCompare(b.file.path) || a.declaration.range[0] - b.declaration.range[0]);
  }

  private collect(type: TypeInfo): void {
    const engine = this.engine;
    const members = this.members(type);
    // Creation: stored properties whose initial value makes something (`vm = LoginViewModel()`).
    for (const info of members) {
      const declaration = info.declaration;
      if (declaration.kind !== 'property' || declaration.isStatic || declaration.isComputed) continue;
      const frame = engine.frameOf(info);
      const initial = frame?.file.facts.flow.assignments.find((assignment) => assignment.from === declaration.localId);
      if (!frame || !initial || !containsCall(initial.value) || !this.reachesRepository(frame)) continue;
      const value = engine.render(initial.value, frame.file.facts);
      const flow = this.flow('create', `${type.path} init → ${declaration.name} = ${value}`, type, {
        file: frame.file.path,
        line: initial.line,
      });
      flow.steps.push({
        depth: 0,
        kind: 'call',
        text: `${declaration.name} = ${value}`,
        layer: engine.layerOf(type),
        at: flow.at,
        notes: [],
        warnings: [],
      });
      new Walker(engine, flow).body(frame, null, 1, [info.id]);
      this.finish(flow);
    }
    // Entry points in the body: closures of `Button(action:)`, `.task`, `.onAppear`, ...
    for (const info of members) {
      const frame = engine.frameOf(info);
      if (!frame) continue;
      for (const [call, site] of frame.file.facts.flow.calls.entries()) {
        if (site.from !== info.declaration.localId) continue;
        for (const rule of engine.rules.entryPoints) {
          if (!rule.call) continue;
          const aligned = engine.matchCall(parseCallPattern(rule.call), site, frame);
          if (!aligned) continue;
          const position =
            rule.closure === undefined
              ? site.arguments.length - 1
              : argumentIndex(
                  rule.closure,
                  aligned,
                  site.arguments.map((argument) => argument.label),
                );
          const value = site.arguments[position]?.value;
          if (value?.kind !== 'closure') continue;
          const item = this.itemAt(frame.file.path, site.line, site.name);
          const title = item
            ? `${item.id} ${item.kind}${this.itemLabel(item.id)} ${rule.kind === 'action' ? 'tap' : rule.kind}`
            : `${type.path} .${site.name}`;
          const flow = this.flow(rule.kind, title, type, engine.location(frame, site.line), item?.id);
          flow.steps.push({
            depth: 0,
            kind: 'closure',
            text: `${site.name} closure`,
            layer: engine.layerOf(type),
            at: flow.at,
            notes: [],
            warnings: [],
          });
          new Walker(engine, flow).body(frame, value.closure, 1, [info.id]);
          this.finish(flow);
          break;
        }
        // UIKit: `addTarget(self, action: #selector(method), for:)`.
        if (site.name === 'addTarget') {
          const selector = site.arguments.find((argument) => argument.label === 'action')?.value;
          const name = selector?.kind === 'compound' ? /#selector\(([\w.]+)/.exec(selector.text)?.[1]?.split('.').at(-1) : undefined;
          const method = name
            ? members.find((candidate) => candidate.declaration.name === name && candidate.declaration.kind === 'function')
            : undefined;
          if (!method) continue;
          const receiver = site.receiver ? engine.render(site.receiver, frame.file.facts) : '';
          const item = this.definition.items.find((candidate) => candidate.owner === type.path && candidate.path.join('.') === receiver);
          const flow = this.flow(
            'action',
            `${item ? `${item.id} ` : ''}${receiver} tap → ${method.declaration.selector}`,
            type,
            engine.location(frame, site.line),
            item?.id,
          );
          this.method(flow, method, 0);
        }
      }
    }
    // Methods the framework calls: `viewDidLoad()`, `tableView(_:didSelectRowAt:)`.
    for (const info of members) {
      for (const rule of engine.rules.entryPoints) {
        if (!rule.method || rule.method !== info.declaration.selector) continue;
        if (rule.match && !engine.matchesType(type, rule.match)) continue;
        const flow = this.flow(rule.kind, `${type.path}.${info.declaration.selector}`, type, {
          file: info.file.path,
          line: info.declaration.range[0],
        });
        this.method(flow, info, 0);
        break;
      }
    }
  }

  /** Whether a property initializer calls code of the repository (not only SDK initializers). */
  private reachesRepository(frame: Frame): boolean {
    const from = frame.info?.declaration.localId ?? null;
    return frame.file.facts.flow.calls.some((site, call) => {
      if (site.from !== from) return false;
      if (this.engine.callTargets(call, frame).length > 0) return true;
      return !site.receiver && isTypeName(site.name) && this.engine.resolveType(site.name, frame).info !== undefined;
    });
  }

  private method(flow: ScreenFlow, info: DeclarationInfo, depth: number): void {
    const engine = this.engine;
    const frame = engine.frameOf(info);
    if (!frame) return;
    flow.steps.push({
      depth,
      kind: 'call',
      text: engine.symbolName(info),
      layer: engine.layerOf(info.enclosing),
      at: { file: info.file.path, line: info.declaration.range[0] },
      notes: [],
      warnings: [],
    });
    new Walker(engine, flow).body(frame, null, depth + 1, [info.id]);
    this.finish(flow);
  }

  private flow(kind: string, title: string, type: TypeInfo, at: Location, item?: string): ScreenFlow {
    const flow: ScreenFlow = {
      id: '',
      kind,
      title,
      owner: type.path,
      at,
      steps: [],
      writes: [],
      shown: [],
      errors: [],
      summary: { steps: [], path: [], success: [], failure: [], stores: [], warnings: [] },
    };
    if (item) flow.item = item;
    return flow;
  }

  private finish(flow: ScreenFlow): void {
    const written = new Map<string, string[]>();
    for (const step of flow.steps) {
      if (step.kind !== 'write' || !step.property) continue;
      const property = step.property;
      const value = step.text.slice(step.text.indexOf(' = ') + 3);
      const values = written.get(property) ?? [];
      if (value && !values.includes(value)) values.push(value);
      written.set(property, values);
    }
    flow.writes = [...written.entries()].map(([property, values]) => ({ property, values }));
    flow.shown = flow.writes.map((write) => ({ property: write.property, items: this.shownBy.get(write.property) ?? [] }));
    flow.errors = errorHandling(flow.steps);
    flow.summary = summarize(flow.steps, this.shownBy);
    this.flows.push(flow);
  }

  private itemAt(file: string, line: number, kind: string) {
    return this.definition.items.find((item) => item.at.file === file && item.at.line === line && item.kind === kind);
  }

  private itemLabel(id: string): string {
    const item = this.definition.items.find((candidate) => candidate.id === id);
    const label = item?.data.find((data) => data.role === 'label' || data.role === 'title');
    const origin = label?.traced[0]?.origin;
    if (origin?.kind === 'localization') return ` ${JSON.stringify(origin.key)}`;
    if (origin?.kind === 'literal') return ` ${JSON.stringify(origin.value)}`;
    return '';
  }
}

// --- Walking bodies --------------------------------------------------------------------------

class Walker {
  private readonly engine: FlowEngine;
  private readonly flow: ScreenFlow;

  constructor(engine: FlowEngine, flow: ScreenFlow) {
    this.engine = engine;
    this.flow = flow;
  }

  /** The calls and writes of a body (or of one closure in it), in execution order. */
  body(frame: Frame, closure: number | null, depth: number, stack: string[]): void {
    const engine = this.engine;
    if (depth > engine.depthLimit) return;
    const facts = frame.file.facts;
    const from = frame.info?.declaration.localId ?? null;
    const base = closure === null ? [] : (facts.flow.calls[facts.flow.closures[closure]?.call ?? -1]?.branch ?? []);
    type Event = { line: number; column: number; order: number; call?: number; assignment?: number };
    const events: Event[] = [];
    facts.flow.calls.forEach((site, call) => {
      if (site.from !== from || site.closure !== closure) return;
      events.push({ line: site.line, column: site.column, order: -nesting(facts.flow.calls, call), call });
    });
    facts.flow.assignments.forEach((assignment, index) => {
      if (assignment.from !== from || frame.info?.declaration.kind === 'property' || (assignment.closure ?? null) !== closure) return;
      events.push({ line: assignment.line, column: 1e6, order: 0, assignment: index });
    });
    events.sort((a, b) => a.line - b.line || a.column - b.column || a.order - b.order);
    const start = this.flow.steps.length;
    for (const event of events) {
      if (event.call !== undefined) this.call(frame, event.call, depth, stack, base);
      else if (event.assignment !== undefined) this.write(frame, event.assignment, depth, base);
    }
    this.mergeChains(start);
  }

  private call(frame: Frame, call: number, depth: number, stack: string[], base: string[]): void {
    const engine = this.engine;
    const facts = frame.file.facts;
    const site = facts.flow.calls[call]!;
    const at = engine.location(frame, site.line);
    const when = relativeBranch(site.branch, base);
    const layer = engine.layerOf(frame.self);

    const source = engine.sourceRule(site, frame);
    if (source) {
      const traced = engine.trace({ kind: 'call', call }, frame);
      const origin = traced.find((result) => result.origin.kind === 'source')?.origin;
      const type = engine.typeOfCall(call, frame);
      const kind = origin?.kind === 'source' ? origin.source : source.rule.kind;
      const step = this.push({
        depth,
        kind: 'source',
        text: `${apiName(source.rule.call!)}${type ? (apiName(source.rule.call!).endsWith(')') ? ` → ${tyText(type)}` : `(${tyText(type)})`) : ''}`,
        layer: kind,
        at,
        when,
        notes: [],
        warnings: [...new Set(traced.flatMap((result) => result.warnings)), ...ignored(site)],
      });
      const keyArgument =
        source.rule.key === undefined
          ? undefined
          : site.arguments[
              argumentIndex(
                source.rule.key,
                source.aligned,
                site.arguments.map((argument) => argument.label),
              )
            ]?.value;
      if (keyArgument?.kind === 'literal' && origin?.kind !== 'source') step.notes.push(`key ${JSON.stringify(keyArgument.value)}`);
      if (source.rule.direction === 'write') step.notes.push('write');
      if (origin?.kind === 'source') {
        if (origin.endpoint) step.notes.push(`${origin.method ? `${origin.method} ` : ''}${JSON.stringify(origin.endpoint)}`);
        if (origin.key) step.notes.push(`key ${JSON.stringify(origin.key)}`);
        for (const input of origin.input ?? []) {
          if (input.origin.kind === 'literal') step.notes.push(`input: literal ${JSON.stringify(input.origin.value)}`);
        }
      }
      return;
    }

    const flowRule = engine.flowRule(site, frame);
    if (flowRule) {
      const closures = site.arguments
        .map((argument, position) => ({ argument, position }))
        .filter(({ argument }) => argument.value.kind === 'closure');
      const receiver =
        site.receiver?.kind === 'path' && site.receiver.root.kind !== 'call' ? `${engine.render(site.receiver, facts)}.` : '';
      const step = this.push({ depth, kind: 'chain', text: `${receiver}${site.name}`, layer, at, when, notes: [], warnings: [] });
      const asyncClosures: { label: string; closure: number; on?: string }[] = [];
      for (const { argument, position } of closures) {
        if (argument.value.kind !== 'closure') continue;
        const label = flowRule.aligned[position] ?? argument.label;
        const spec =
          flowRule.rule.closures?.[label] ??
          flowRule.rule.closures?.[String(position)] ??
          (position === site.arguments.length - 1 ? flowRule.rule.closures?.trailing : undefined);
        if (spec?.async) asyncClosures.push({ label, closure: argument.value.closure, on: spec.on });
        else this.body(frame, argument.value.closure, depth + 1, stack);
      }
      if (asyncClosures.length > 0) {
        step.kind = 'closure';
        step.async = true;
        step.text = `${receiver}${site.name}  async${asyncClosures.some((closure) => closure.on === 'value' || closure.on === 'completion') ? ' (after the publisher emits)' : ''}`;
        for (const closure of asyncClosures) {
          this.push({ depth: depth + 1, kind: 'closure', text: `on ${closure.on ?? closure.label}:`, at, notes: [], warnings: [] });
          this.body(frame, closure.closure, depth + 2, stack);
        }
      }
      return;
    }

    const targets = engine.callTargets(call, frame);
    if (targets.length === 0) {
      // An SDK call: show it near the entry; walk closures it runs (animations, dispatch).
      const closures = site.arguments.filter((argument) => argument.value.kind === 'closure');
      const external = !site.receiver || (site.receiver.kind === 'path' && site.receiver.root.kind === 'self');
      if (depth <= 1 && external && !isTypeName(site.name)) {
        this.push({
          depth,
          kind: 'external',
          text: engine.render({ kind: 'call', call }, facts),
          layer,
          at,
          when,
          notes: [],
          warnings: [],
        });
      }
      for (const argument of closures) if (argument.value.kind === 'closure') this.body(frame, argument.value.closure, depth + 1, stack);
      return;
    }
    for (const target of targets.slice(0, 3)) {
      const info = target.target;
      const declaration = info.declaration;
      const calleeType = info.enclosing;
      const name =
        declaration.kind === 'initializer'
          ? `${info.enclosing?.path ?? site.name}.init${declaration.selector.slice(4)}`
          : engine.symbolName(info);
      const notes: string[] = [];
      if (target.injection)
        notes.push(`DI: ${target.injection.service.name} → ${target.injection.implementation.name}  ${where(target.injection.at)}`);
      else if (target.requirement && target.via !== 'generic') notes.push(`${target.via}: ${engine.symbolName(target.requirement)}`);
      for (const [generic, type] of target.bound) notes.push(`${generic} = ${tyText(type)}`);
      const callee = engine.enter(info, target.bound, { frame, call });
      const warnings: string[] = [];
      if (callee && isEmpty(callee, declaration.localId) && declaration.kind === 'function') warnings.push('empty');
      warnings.push(...this.castWarnings(frame, site), ...ignored(site));
      this.push({
        depth,
        kind: 'call',
        text: `${name}`,
        layer: engine.layerOf(calleeType),
        at: { file: info.file.path, line: declaration.range[0] },
        when,
        notes,
        warnings,
        async: site.await,
      });
      if (!callee || stack.includes(info.id)) continue;
      if (declaration.kind === 'initializer' && info.enclosing) this.storedInitializers(info.enclosing, depth + 1, [...stack, info.id]);
      this.body(callee, null, depth + 1, [...stack, info.id]);
    }
  }

  /**
   * A call under `if let x = y as? T` (or its else branch) where the cast
   * between two known types always fails.
   */
  private castWarnings(frame: Frame, site: CallSite): string[] {
    const engine = this.engine;
    const from = frame.info?.declaration.localId ?? null;
    const warnings = new Set<string>();
    for (const condition of site.branch) {
      const match = /let (\w+) = .+ as\? /.exec(condition);
      if (!match) continue;
      const binding = frame.file.facts.flow.bindings
        .filter((candidate) => candidate.from === from && candidate.name === match[1] && candidate.line <= site.line)
        .at(-1);
      if (!binding) continue;
      for (const traced of engine.trace(binding.value, frame)) {
        if (traced.failingCast) for (const warning of traced.warnings) if (warning.startsWith('cast')) warnings.add(warning);
      }
    }
    return [...warnings];
  }

  /** Initial values of the stored properties of a type being created that call something. */
  private storedInitializers(type: TypeInfo, depth: number, stack: string[]): void {
    const engine = this.engine;
    for (const list of type.members.values()) {
      for (const member of list) {
        const info = engine.infoOf(member);
        if (!info || info.declaration.kind !== 'property' || info.declaration.isStatic || stack.includes(info.id)) continue;
        const frame = engine.frameOf(info);
        const initial = frame?.file.facts.flow.assignments.find((assignment) => assignment.from === info.declaration.localId);
        if (!frame || !initial || !containsCall(initial.value)) continue;
        this.push({
          depth,
          kind: 'call',
          text: `${info.declaration.name} = ${engine.render(initial.value, frame.file.facts)}`,
          layer: engine.layerOf(type),
          at: { file: frame.file.path, line: initial.line },
          notes: [],
          warnings: [],
        });
        this.body(frame, null, depth + 1, [...stack, info.id]);
      }
    }
  }

  private write(frame: Frame, index: number, depth: number, base: string[]): void {
    const engine = this.engine;
    const assignment = frame.file.facts.flow.assignments[index]!;
    const target = assignment.target;
    if (target.kind !== 'path' || target.members.length === 0) return;
    const property = this.propertyOf(target, frame);
    const value = engine.render(assignment.value, frame.file.facts);
    // A UIKit view property of self (`titleLabel.text = title`) is shown as written.
    if (!property && !(target.root.kind === 'self' && target.members.length >= 2)) return;
    // Dependencies stored by an initializer (`self.service = service`) are not data.
    const stored = assignment.value;
    const dependency = target.root.kind === 'self' && target.members.length === 1 && frame.info?.declaration.kind === 'initializer';
    if (
      dependency &&
      stored.kind === 'path' &&
      stored.root.kind === 'local' &&
      stored.members.length === 0 &&
      stored.root.name === target.members[0]
    )
      return;
    this.push({
      depth,
      kind: 'write',
      mapping: this.mapping(assignment.value, frame, property),
      ...(property ? { targetLayer: engine.layerOf(property.enclosing) } : {}),
      text: `${property ? engine.symbolName(property) : engine.render(target, frame.file.facts)} = ${value}`,
      ...(property ? { property: engine.symbolName(property) } : {}),
      layer: engine.layerOf(frame.self),
      at: engine.location(frame, assignment.line),
      when: relativeBranch(assignment.branch, base),
      notes: [],
      warnings: [],
    });
  }

  /**
   * Where a written value comes from: its sources (a JSON path for a
   * response), and for a type of the repository, the source of each field.
   */
  private mapping(value: ValueExpr, frame: Frame, property: DeclarationInfo | undefined): WriteMapping {
    const engine = this.engine;
    const traced = engine.trace(value, frame);
    // A view property shows a view-model variable: name it rather than the source behind it.
    const variables = property ? [] : unique(traced.map(viewModelVariable).filter((text) => text !== ''));
    const from = variables.length > 0 ? variables : unique(traced.flatMap(mappingSource).filter((text) => text !== ''));
    const result: WriteMapping = { from, fields: [] };
    const fromData = traced.some((result) => ['source', 'error', 'derived'].includes(result.origin.kind));
    if (!property || !fromData) return result;
    const member = property?.enclosing?.members.get(property.declaration.name)?.find((candidate) => candidate.id === property.id);
    const type = member ? engine.propertyType(member) : unwrapTy(engine.typeOf(value, frame));
    const element = type ? engine.elementType(type) : undefined;
    const model = (element ?? type)?.info;
    if (!model || model.kind === 'protocol' || traced.every((result) => result.origin.kind === 'literal' || result.origin.kind === 'case'))
      return result;
    if (element) result.mappedTo = model.path;
    for (const list of model.members.values()) {
      for (const field of list) {
        if (field.declaration.kind !== 'property' || field.declaration.isStatic || field.declaration.isComputed) continue;
        const fieldTraced = engine.trace(value, frame, element ? ['[]', field.declaration.name] : [field.declaration.name]);
        const sources = unique(fieldTraced.flatMap(mappingSource).filter((text) => text !== ''));
        if (sources.length === 0) continue;
        const computed = fieldTraced.some((result) => result.steps.some((step) => step.kind === 'compound'));
        result.fields.push({ field: field.declaration.name, from: sources.join(' | '), ...(computed ? { computed } : {}) });
      }
    }
    return result;
  }

  /** The property a written path ends at, when the path goes through properties from self or a typed local. */
  private propertyOf(target: Extract<ValueExpr, { kind: 'path' }>, frame: Frame): DeclarationInfo | undefined {
    const engine = this.engine;
    let type: TypeInfo | undefined;
    if (target.root.kind === 'self') type = frame.self;
    else if (target.root.kind === 'local') type = engine.typeOf({ kind: 'path', root: target.root, members: [] }, frame)?.info;
    else if (target.root.kind === 'type') type = engine.resolveType(target.root.name, frame).info;
    let property: DeclarationInfo | undefined;
    for (const member of target.members) {
      if (!type) return undefined;
      const found = engine.index.property(type, member);
      if (!found) return undefined;
      property = engine.infoOf(found);
      type = engine.propertyType(found)?.info;
    }
    return property;
  }

  private push(step: FlowStep): FlowStep {
    if (step.when === '') delete step.when;
    this.flow.steps.push(step);
    return step;
  }

  /** Runs of operators at one depth (`Just → compactMap → tryMap`) become one step. */
  private mergeChains(start: number): void {
    const steps = this.flow.steps;
    for (let index = start; index < steps.length; index++) {
      const step = steps[index]!;
      if (step.kind !== 'chain') continue;
      let end = index;
      const names = [step.text];
      for (let next = index + 1; next < steps.length; next++) {
        const candidate = steps[next]!;
        if (candidate.depth > step.depth) continue;
        if (candidate.depth < step.depth || candidate.kind !== 'chain') break;
        names.push(candidate.text);
        end = next;
      }
      if (end === index) continue;
      step.text = names.join(' → ');
      for (let remove = end; remove > index; remove--)
        if (steps[remove]!.kind === 'chain' && steps[remove]!.depth === step.depth) steps.splice(remove, 1);
    }
  }
}

/** A source for the mapping view: a JSON path for a response field, else the short source or the view-model variable. */
function mappingSource(traced: Traced): string[] {
  const origin = traced.origin;
  if (origin.kind === 'source' && origin.source === 'api')
    return [traced.jsonPath ? jsonPathText(traced.jsonPath) : origin.type ? tyText(origin.type) : origin.api];
  if (origin.kind === 'derived') return origin.inputs.flatMap(mappingSource);
  if (origin.kind === 'unresolved') return [];
  if (origin.kind === 'source' || origin.kind === 'error' || origin.kind === 'localization') return shortSources(traced);
  const variable = viewModelVariable(traced);
  return [variable || shortSources(traced)[0] || ''];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function unwrapTy(type: Ty | undefined): Ty | undefined {
  return type?.optional ? { ...type, optional: undefined } : type;
}

/** The short form of a flow (see `FlowSummary`). */
function summarize(steps: FlowStep[], shownBy: Map<string, string[]>): FlowSummary {
  const summary: FlowSummary = { steps: [], path: [], success: [], failure: [], stores: [], warnings: [] };
  let current: SummaryStep | undefined;
  let failable: SummaryStep | undefined;
  let ignoredNext = false;
  // Numbered steps that enclose the current one: their raw depth, and whether they can own writes.
  const stack: { depth: number; entry: SummaryStep; owner: boolean }[] = [];
  const number = (step: FlowStep, text: string, layer: string | undefined): SummaryStep => {
    while (stack.length > 0 && stack.at(-1)!.depth >= step.depth) stack.pop();
    const entry: SummaryStep = {
      number: summary.steps.length + 1,
      depth: stack.length,
      text,
      notes: step.notes,
      at: step.at,
      success: [],
      failure: [],
      writes: [],
    };
    if (layer) entry.layer = layer;
    summary.steps.push(entry);
    stack.push({ depth: step.depth, entry, owner: step.kind !== 'source' });
    current = entry;
    return entry;
  };
  /**
   * Success and failure belong to the last step that can fail; other writes
   * to the innermost enclosing step that runs code (not a read of a source).
   */
  const attach = (outcome: FlowOutcome, failure: boolean, depth: number) => {
    if (failure) return (failable ?? current)?.failure.push(outcome);
    if (failable) return failable.success.push(outcome);
    const owner = [...stack].reverse().find((entry) => entry.owner && entry.depth < depth)?.entry ?? current;
    owner?.writes.push(outcome);
  };
  // Steps nested under a failure (a failure closure, a call made on failure) are failure too;
  // steps under a call reached only through a cast that always fails never run.
  let failureDepth: number | undefined;
  let failureLabel = 'on failure';
  let deadDepth: number | undefined;
  let deadReason = '';
  let handlerDepth: number | undefined;
  for (const step of steps) {
    if (failureDepth !== undefined && step.depth <= failureDepth) failureDepth = undefined;
    if (deadDepth !== undefined && step.depth <= deadDepth) deadDepth = undefined;
    if (handlerDepth !== undefined && step.depth <= handlerDepth) handlerDepth = undefined;
    if (step.kind === 'closure' && /^on (completion|failure):$/.test(step.text)) {
      failureDepth = step.depth;
      failureLabel = 'on failure';
      continue;
    }
    if (step.kind === 'closure' && step.async && failureDepth === undefined && deadDepth === undefined && /\.\w+\s+async/.test(step.text)) {
      // A subscription (`viewModel.$title.sink`): what it does runs each time the publisher emits.
      number(step, step.text, step.layer);
      continue;
    }
    const when = step.when ?? '';
    const own = failureCondition(when);
    const failure = own !== undefined || failureDepth !== undefined;
    const label = own ?? failureLabel;
    const dead = deadDepth !== undefined;
    for (const warning of dead ? [] : step.warnings) {
      // A cast or decoding problem is one warning, wherever the flow meets it; empty handlers are marked inline.
      if (warning === 'empty') continue;
      if (warning === ERROR_IGNORED) {
        summary.failure.push({ target: step.text, value: '', when: 'try?', shown: [], at: step.at, ignored: true });
        ignoredNext = true;
        continue;
      } else if (warning.startsWith('cast') || warning.startsWith('input is not valid')) summary.warnings.push(warning);
      else summary.warnings.push(`${step.text}: ${warning}`);
    }
    const castFails = step.warnings.find((warning) => warning.startsWith('cast') && warning.includes('always fails'));
    if (step.kind === 'write') {
      const [target, value] = [step.text.slice(0, step.text.indexOf(' = ')), step.text.slice(step.text.indexOf(' = ') + 3)];
      const shown = step.property ? (shownBy.get(step.property) ?? []) : [];
      // Internal state of other layers (a mapper's request) is not what the screen shows.
      if (step.property && shown.length === 0 && step.targetLayer !== 'ViewModel') continue;
      if (value === 'self') continue;
      const outcome: FlowOutcome = { target, value, shown, at: step.at };
      if (step.mapping) outcome.mapping = step.mapping;
      const condition = failure ? label : when;
      if (condition) outcome.when = condition;
      if (dead) {
        // What a failure handler would do in code that never runs is left out.
        if (failure) continue;
        outcome.never = deadReason;
      }
      if (failure && handlerDepth !== undefined) outcome.nested = true;
      (failure ? summary.failure : summary.success).push(outcome);
      attach(outcome, failure, step.depth);
      continue;
    }
    if (failure) {
      if (step.kind === 'call') {
        if (!dead) {
          const handler: FlowOutcome = {
            target: step.text,
            value: '',
            when: label,
            shown: [],
            at: step.at,
            ...(step.warnings.includes('empty') ? { empty: true } : {}),
          };
          summary.failure.push(handler);
          attach(handler, true, step.depth);
        }
        failureDepth ??= step.depth;
        handlerDepth = step.depth;
        if (own !== undefined) failureLabel = own;
      }
      continue;
    }
    if (castFails && step.kind === 'call' && deadDepth === undefined) {
      deadDepth = step.depth;
      deadReason = castFails;
      summary.path.push(step.text, `⚠ stops: ${castFails}`);
      number(step, step.text, step.layer).stops = castFails;
      continue;
    }
    if (dead) continue;
    if (step.kind === 'source' && step.notes.includes('write')) {
      const key = step.notes
        .filter((note) => note.startsWith('key '))
        .map((note) => ` ${note.slice(4)}`)
        .join('');
      summary.stores.push(`${step.layer?.replace(/^local\./, '') ?? 'store'}${key}  (${step.text})`);
      number(step, `write${key}  (${step.text})`, step.layer?.replace(/^local\./, ''));
      continue;
    }
    if (step.kind === 'call' || step.kind === 'source') {
      let text = step.text;
      if (step.kind === 'source') {
        const endpoint = step.notes.find((note) => /^[A-Z]+ "/.test(note) || note.startsWith('"'));
        const key = step.notes.find((note) => note.startsWith('key '));
        if (step.layer === 'api') text = endpoint ? endpoint.replace(/"/g, '') : `api ${step.text}`;
        else text = `${step.layer?.replace(/^local\./, '') ?? step.text}${key ? ` ${key.slice(4)}` : ''}`;
      }
      if (summary.path.at(-1) !== text) summary.path.push(text);
      const entry = number(
        step,
        step.kind === 'source' && step.layer !== 'api'
          ? `read${text.slice(text.indexOf(' ') >= 0 ? text.indexOf(' ') : text.length)}`
          : text,
        step.layer?.replace(/^local\./, ''),
      );
      if (step.kind === 'source' && step.layer === 'api' && !text.startsWith('api '))
        entry.text = `${text} → ${step.text.replace(/^[^(]*\(|\)$/g, '')}`;
      if ((step.kind === 'source' && step.layer === 'api') || ignoredNext) {
        entry.failable = true;
        failable = entry;
        if (ignoredNext) entry.failure.push({ target: step.text, value: '', when: 'try?', shown: [], at: step.at, ignored: true });
        ignoredNext = false;
      }
    }
  }
  summary.warnings = unique(summary.warnings);
  return summary;
}

/**
 * A summary with the numbered steps of some layers only. A hidden data source
 * (`GET …`, `read "accessToken"`) becomes a note of the kept step above it;
 * outcomes of hidden steps move to that step too (or to the next kept step
 * when none is above). Steps are numbered again.
 */
function keepLayers(summary: FlowSummary, layers: ReadonlySet<string>): FlowSummary {
  const kept: SummaryStep[] = [];
  const stack: { depth: number; entry: SummaryStep }[] = [];
  let orphans: SummaryStep[] = [];
  const merge = (target: SummaryStep, from: SummaryStep) => {
    target.success.push(...from.success);
    target.failure.push(...from.failure);
    target.writes.push(...from.writes);
    if (from.failable) target.failable = true;
    if (from.stops) target.stops ??= from.stops;
  };
  for (const step of summary.steps) {
    while (stack.length > 0 && stack.at(-1)!.depth >= step.depth) stack.pop();
    if (step.layer && layers.has(step.layer.toLowerCase())) {
      const entry: SummaryStep = {
        ...step,
        depth: stack.length,
        number: kept.length + 1,
        notes: [...step.notes],
        success: [...step.success],
        failure: [...step.failure],
        writes: [...step.writes],
      };
      for (const orphan of orphans) merge(entry, orphan);
      orphans = [];
      kept.push(entry);
      stack.push({ depth: step.depth, entry });
      continue;
    }
    const owner = stack.at(-1)?.entry;
    if (!owner) {
      orphans.push(step);
      continue;
    }
    // A source or a step of another layer: what it reads, and what happens on its success or failure.
    if (step.layer && !/^[A-Z]/.test(step.layer)) owner.notes.push(`→ ${step.text.replace(/  \(.*\)$/, '')}`);
    merge(owner, step);
  }
  return { ...summary, steps: kept };
}

/** The failure a condition stands for: `catch …`, a `.failure` case, an optional binding or cast that failed. */
function failureCondition(when: string): string | undefined {
  const catchIndex = when.search(/(^|&& )catch\b/);
  if (catchIndex >= 0) return when.slice(when.indexOf('catch'));
  if (/\.failure\b/.test(when)) return 'on failure';
  const failed = /!\(let (\w+) = (.*)\)/.exec(when);
  if (failed) return `${failed[2]!.includes(' as') ? 'cast' : 'nil'} fails (${failed[1]})`;
  return undefined;
}

function ignored(site: CallSite): string[] {
  if (site.try === 'try?') return [ERROR_IGNORED];
  if (site.try === 'try!') return ['crashes on error (try!)'];
  return [];
}

const ERROR_IGNORED = 'error ignored (try?)';

/** Error handling of a flow: steps under `catch` or `.failure`, failure closures, `try?`. */
function errorHandling(steps: FlowStep[]): string[] {
  const errors: string[] = [];
  let failureDepth: number | undefined;
  for (const step of steps) {
    if (failureDepth !== undefined && step.depth <= failureDepth) failureDepth = undefined;
    if (step.kind === 'closure' && /^on (completion|failure):$/.test(step.text)) {
      failureDepth = step.depth;
      continue;
    }
    const when = step.when ?? '';
    const handler = /(^|&& )catch\b/.test(when) || /\.failure\b/.test(when) || failureDepth !== undefined;
    const label = /(^|&& )catch\b/.test(when) ? when.slice(when.search(/catch\b/)) : 'on failure';
    if (handler && step.kind !== 'closure') {
      errors.push(`${label} → ${step.text}${step.warnings.includes('empty') ? ' ⚠ empty' : ''}`);
    }
    if (step.warnings.includes(ERROR_IGNORED)) errors.push(`${step.text}: ⚠ ${ERROR_IGNORED}`);
  }
  if (errors.length === 0 && steps.some((step) => step.kind === 'source' && step.layer === 'api'))
    errors.push('⚠ no error handling on this flow');
  return [...new Set(errors)];
}

function nesting(calls: CallSite[], call: number): number {
  let depth = 0;
  for (let current = calls[call]?.parent ?? null; current !== null && depth < 50; current = calls[current]?.parent ?? null) depth++;
  return depth;
}

function relativeBranch(branch: string[], base: string[]): string {
  return branch.slice(base.length).join(' && ');
}

function containsCall(value: ValueExpr): boolean {
  if (value.kind === 'call' || value.kind === 'closure') return value.kind === 'call';
  if (value.kind === 'path') return value.root.kind === 'call';
  if (value.kind === 'compound') return value.operands.some(containsCall);
  return false;
}

function isEmpty(frame: Frame, localId: number): boolean {
  const flow = frame.file.facts.flow;
  return (
    !flow.calls.some((site) => site.from === localId) &&
    !flow.assignments.some((assignment) => assignment.from === localId) &&
    !flow.returns.some((item) => item.from === localId) &&
    !flow.bindings.some((binding) => binding.from === localId)
  );
}

function isTypeName(name: string): boolean {
  const first = name.replace(/^`/, '')[0];
  return first !== undefined && first !== first.toLowerCase();
}

function where(at: Location): string {
  return `${at.file.split('/').at(-1)}:${at.line}`;
}
