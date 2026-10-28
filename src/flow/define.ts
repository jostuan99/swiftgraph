// `define <screen>`: the items of a screen and where the data of each item
// comes from. See docs/05-data-flow.md, section 6.1.

import { parseCallPattern } from '../rules/load.ts';
import type { Loaded, SinkArgument, SinkRule } from '../rules/types.ts';
import type { DeclarationInfo, TypeInfo } from '../resolve/resolve.ts';
import type { CallSite, FileFacts, ValueExpr } from '../schema/types.ts';
import { tyText, type FlowEngine, type Frame, type Location, type Traced, type Ty } from './engine.ts';

export interface DefineOptions {
  /** Include child views, cells and rows (default true). */
  children?: boolean;
  /** Only items with data from these source kinds: api, local, file, localization, literal, input. */
  sources?: string[];
  /** Only this item, with full paths. */
  item?: string;
}

export interface ScreenView {
  name: string;
  symbolId: string;
  kind: string;
  layer?: string;
  file: string;
  line: number;
}

export interface ScreenState {
  name: string;
  type?: string;
  value?: string;
  attribute?: string;
  at: Location;
}

export interface ItemData {
  role: string;
  /** The value as written. */
  value: string;
  at: Location;
  traced: Traced[];
  /** For `input`: the property the view writes. */
  input?: {
    property: string;
    type?: string;
    initial?: string;
    /** Sources of the initial value (`UserDefaults.standard.bool(forKey:)`), literals left out. */
    initialSources?: Traced[];
    at: Location;
    readElsewhere: boolean;
  };
  /** For `action`: the calls the closure makes. */
  action?: { calls: string[]; at: Location };
}

export interface ScreenItem {
  id: string;
  owner: string;
  /** Item of the parent screen that contains this one (a list). */
  parent?: string;
  path: string[];
  kind: string;
  direction: string;
  shownWhen: string[];
  at: Location;
  data: ItemData[];
}

export interface ConditionWrite {
  value: string;
  kind: 'initial' | 'assign' | 'init';
  when: string[];
  at: Location;
  symbol: string;
  layer?: string;
  /** Where the values that decide the write come from. */
  because: Traced[];
  /** The value written, when not a literal. */
  traced: Traced[];
  unreachable?: string;
}

export interface ScreenCondition {
  expression: string;
  property: string;
  type?: string;
  items: string[];
  writes: ConditionWrite[];
}

export interface ScreenDefinition {
  view: ScreenView;
  state: ScreenState[];
  children: { name: string; how: string; at: Location }[];
  items: ScreenItem[];
  conditions: ScreenCondition[];
}

export type ScreenLookup = { definition: ScreenDefinition } | { candidates: string[]; message: string };

/** View kind from the SDK types a type inherits or conforms to. */
export function viewKind(engine: FlowEngine, type: TypeInfo): string | undefined {
  const names = engine.index.externalNames(type);
  if (names.includes('View') && type.kind !== 'protocol') return 'SwiftUI View';
  for (const name of ['UITableViewCell', 'UICollectionViewCell', 'UIViewController', 'UIView']) if (names.includes(name)) return name;
  return undefined;
}

/** Types matching a screen name, qualified name or file path. */
export function findScreens(engine: FlowEngine, text: string): TypeInfo[] {
  const types = engine.index.types().filter((type) => type.kind !== 'protocol');
  if (text.endsWith('.swift')) {
    return types.filter((type) => {
      const file = engine.declaration(type.id)?.file.path ?? '';
      return (file === text || file.endsWith(`/${text}`)) && viewKind(engine, type) !== undefined;
    });
  }
  const exact = types.filter((type) => type.path === text || `${type.module}.${type.path}` === text);
  if (exact.length > 0) return exact;
  return types.filter((type) => type.name === text);
}

/** One screen for a name, or the candidates to choose from (view types first; pass the file path to pick one). */
export function pickScreen(engine: FlowEngine, text: string): { type: TypeInfo } | { candidates: string[]; message: string } {
  let found = findScreens(engine, text);
  if (found.length === 0) return { candidates: [], message: `no type named ${text}` };
  if (found.length > 1) {
    const views = found.filter((type) => viewKind(engine, type) !== undefined);
    if (views.length > 0) found = views;
  }
  if (found.length === 1) return { type: found[0]! };
  const candidates = found.map((type) => {
    const info = engine.declaration(type.id);
    return `${type.module}.${type.path}  ${info ? `${info.file.path}:${info.declaration.range[0]}` : ''}`.trimEnd();
  });
  return {
    candidates: [...new Set(candidates)],
    message: `${found.length} types match ${text}; pass ${text.endsWith('.swift') ? 'one type name' : 'the file path of one of them'}`,
  };
}

export function defineScreen(engine: FlowEngine, text: string, options: DefineOptions = {}): ScreenLookup {
  const picked = pickScreen(engine, text);
  return 'type' in picked ? { definition: defineType(engine, picked.type, options) } : picked;
}

export function defineType(engine: FlowEngine, type: TypeInfo, options: DefineOptions = {}): ScreenDefinition {
  return new Definer(engine, options).define(type);
}

// --- Building ---------------------------------------------------------------------

interface SinkMatch {
  rule: Loaded<SinkRule>;
  aligned: string[];
  frame: Frame;
  call: number;
  site: CallSite;
}

class Definer {
  private readonly engine: FlowEngine;
  private readonly options: DefineOptions;
  private readonly items: ScreenItem[] = [];
  private readonly children: ScreenDefinition['children'] = [];
  private readonly visited = new Set<TypeInfo>();
  /** Declarations of the screen and its children: reads from them are not "elsewhere". */
  private readonly screenMembers = new Set<string>();

  constructor(engine: FlowEngine, options: DefineOptions) {
    this.engine = engine;
    this.options = options;
  }

  define(type: TypeInfo): ScreenDefinition {
    const engine = this.engine;
    const info = engine.declaration(type.id)!;
    const view: ScreenView = {
      name: type.path,
      symbolId: type.id,
      kind: viewKind(engine, type) ?? type.kind,
      layer: engine.layerOf(type),
      file: info.file.path,
      line: info.declaration.range[0],
    };
    this.collect(type, undefined);
    const conditions = this.conditions();
    return { view, state: this.state(type), children: this.children, items: this.filtered(), conditions };
  }

  private filtered(): ScreenItem[] {
    let items = this.items;
    if (this.options.item) items = items.filter((item) => item.id === this.options.item);
    const kinds = this.options.sources;
    if (kinds && kinds.length > 0) {
      items = items.filter((item) =>
        item.data.some((data) =>
          data.input ? kinds.includes('input') : data.traced.some((traced) => kinds.includes(sourceGroup(traced))),
        ),
      );
    }
    return items;
  }

  /** Members of a type (with extensions) and their frames. */
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

  private state(type: TypeInfo): ScreenState[] {
    const engine = this.engine;
    const states: ScreenState[] = [];
    for (const info of this.members(type)) {
      const declaration = info.declaration;
      if (declaration.kind !== 'property' || declaration.isStatic || declaration.isComputed) continue;
      const wrapper = declaration.attributes.find((attribute) =>
        ['State', 'StateObject', 'ObservedObject', 'EnvironmentObject', 'Binding', 'Bindable', 'Environment', 'AppStorage'].includes(
          attribute,
        ),
      );
      const kind = viewKind(engine, type);
      if (
        kind === 'SwiftUI View'
          ? false
          : !/[Vv]iew[Mm]odel|[Pp]resenter|[Ii]nteractor/.test(`${declaration.name} ${declaration.type ?? declaration.inferredType ?? ''}`)
      ) {
        if (!wrapper && kind !== 'SwiftUI View') continue;
      }
      const frame = engine.frameOf(info);
      const initial = frame?.file.facts.flow.assignments.find((assignment) => assignment.from === declaration.localId);
      const state: ScreenState = { name: declaration.name, at: { file: info.file.path, line: declaration.range[0] } };
      const written = declaration.type ?? declaration.inferredType;
      if (written) state.type = written;
      if (wrapper) state.attribute = wrapper;
      if (initial && frame) state.value = engine.render(initial.value, frame.file.facts);
      states.push(state);
    }
    return states;
  }

  /** Path of a child view inside its screen: `VStack > PointsBadge`. */
  private readonly prefixes = new Map<TypeInfo, string[]>();

  private collect(type: TypeInfo, parent: string | undefined, prefix: string[] = []): void {
    if (this.visited.has(type)) return;
    this.visited.add(type);
    this.prefixes.set(type, prefix);
    for (const info of this.members(type)) this.screenMembers.add(info.id);
    const kind = viewKind(this.engine, type);
    if (kind === 'SwiftUI View') this.collectSwiftUI(type, parent);
    else this.collectUIKit(type, parent);
  }

  // --- SwiftUI --------------------------------------------------------------------

  private collectSwiftUI(type: TypeInfo, parent: string | undefined): void {
    const engine = this.engine;
    const builders = this.members(type).filter((info) => {
      const declaration = info.declaration;
      if (declaration.name === 'body' || declaration.attributes.includes('ViewBuilder')) return true;
      const written = declaration.returnType ?? declaration.type ?? '';
      return /\bView\b/.test(written);
    });
    const counter = { value: this.items.filter((item) => item.owner === type.path).length };
    const childViews: { type: TypeInfo; frame: Frame; site: CallSite; call: number }[] = [];
    const listNames = engine.rules.itemViews.flatMap((rule) => rule.closureOf ?? []);
    const listItems = new Map<string, string>();
    for (const info of builders) {
      const frame = engine.frameOf(info);
      if (!frame) continue;
      const calls = frame.file.facts.flow.calls;
      const sinks: SinkMatch[] = [];
      for (const [call, site] of calls.entries()) {
        if (site.from !== info.declaration.localId) continue;
        const sink =
          this.sinkOf(site, frame, call) ??
          (!site.receiver && listNames.includes(site.name) && site.arguments[0]?.value.kind !== 'closure'
            ? { rule: listRule(site.name), aligned: site.arguments.map((argument) => argument.label), frame, call, site }
            : undefined);
        if (sink) {
          sinks.push(sink);
          continue;
        }
        if (!site.receiver && isTypeName(site.name)) {
          const child = engine.resolveType(site.name, frame).info;
          if (child && child !== type && viewKind(engine, child)) childViews.push({ type: child, frame, site, call });
        }
      }
      // A view passed as an argument of another sink (`prompt: Text("…")`) is part of that item.
      const argumentOf = new Set(
        sinks.flatMap((sink) =>
          sink.site.arguments
            .map((argument) => argument.value)
            .filter((value) => value.kind === 'call')
            .map((value) => (value as { call: number }).call),
        ),
      );
      for (let index = sinks.length - 1; index >= 0; index--) if (argumentOf.has(sinks[index]!.call)) sinks.splice(index, 1);
      // Sinks inside the content of another sink (`Button { Text("Login") }`) belong to it.
      const folded = new Map<number, SinkMatch>();
      for (const sink of sinks) {
        for (const outer of sinks) {
          if (outer === sink) continue;
          const contentClosures = this.contentClosures(outer);
          if (
            contentClosures.length > 0 &&
            this.ancestors(frame.file.facts, sink.call).some(
              (ancestor) => contentClosures.includes(ancestor.closure ?? -1) && ancestor.call === outer.call,
            )
          ) {
            folded.set(sink.call, outer);
          }
        }
      }
      for (const sink of sinks) {
        if (folded.has(sink.call)) continue;
        const item = this.swiftUIItem(type, sink, ++counter.value, parent);
        if (sink.rule.direction === 'list') listItems.set(`${frame.file.path}:${sink.call}`, item.id);
        for (const inner of sinks.filter((candidate) => folded.get(candidate.call) === sink)) {
          const innerArguments = inner.rule.arguments ?? {};
          // The text of a view inside a content closure takes that closure's role: a button's `label`, an alert's `message`.
          const contentRole = this.contentRoleOf(sink, inner, frame) ?? 'label';
          for (const [position, argument] of inner.site.arguments.entries()) {
            const spec = this.argumentSpec(innerArguments, inner.aligned[position], position);
            if (!spec || spec.direction === 'action') continue;
            item.data.push(this.data(spec.role === 'text' ? contentRole : spec.role, spec, argument.value, inner.frame, inner.site));
          }
        }
        this.items.push(item);
      }
    }
    if (this.options.children === false) return;
    for (const child of childViews) {
      const listCall = this.listContainer(child.frame.file.facts, child.call);
      const list = listCall === undefined ? undefined : child.frame.file.facts.flow.calls[listCall];
      const parentItem = listCall === undefined ? undefined : listItems.get(`${child.frame.file.path}:${listCall}`);
      this.children.push({
        name: child.type.path,
        how: list ? `row of ${list.name}` : 'subview',
        at: { file: child.frame.file.path, line: child.site.line },
      });
      this.collect(child.type, parentItem ?? parent, [...this.containerPath(type, child.frame, child.call), child.type.name]);
    }
  }

  /**
   * View containers of a call inside a screen: the screen's own prefix, the
   * builder member when it is not `body` (`header` in an extension), then the
   * enclosing views.
   */
  private containerPath(type: TypeInfo, frame: Frame, call: number): string[] {
    const facts = frame.file.facts;
    const views = this.ancestors(facts, call)
      .map((ancestor) => facts.flow.calls[ancestor.call]!)
      .filter((site) => !site.receiver && isTypeName(site.name))
      .map((site) => site.name)
      .reverse();
    const member = frame.info?.declaration.name;
    return [...(this.prefixes.get(type) ?? []), ...(member && member !== 'body' ? [member] : []), ...views];
  }

  /** The `List`/`ForEach` (itemViews `closureOf`) a call is created in. */
  private listContainer(facts: FileFacts, call: number): number | undefined {
    const names = this.engine.rules.itemViews.flatMap((rule) => rule.closureOf ?? []);
    for (const ancestor of this.ancestors(facts, call)) {
      const site = facts.flow.calls[ancestor.call]!;
      if (ancestor.closure !== null && names.includes(site.name)) return ancestor.call;
    }
    return undefined;
  }

  /** Containers of a call, innermost first: the call and, when through a closure, the closure. */
  private ancestors(facts: FileFacts, call: number): { call: number; closure: number | null }[] {
    const result: { call: number; closure: number | null }[] = [];
    let current = facts.flow.calls[call];
    const seen = new Set<number>();
    while (current) {
      let next: number | null = null;
      let closure: number | null = null;
      if (current.parent !== null) next = current.parent;
      else if (current.closure !== null) {
        closure = current.closure;
        next = facts.flow.closures[current.closure]?.call ?? null;
      }
      if (next === null || seen.has(next)) break;
      seen.add(next);
      result.push({ call: next, closure });
      current = facts.flow.calls[next];
    }
    return result;
  }

  /** Role of the content closure of `outer` that contains `inner`. */
  private contentRoleOf(outer: SinkMatch, inner: SinkMatch, frame: Frame): string | undefined {
    const closures = this.ancestors(frame.file.facts, inner.call)
      .filter((ancestor) => ancestor.call === outer.call)
      .map((ancestor) => ancestor.closure);
    for (const [position, argument] of outer.site.arguments.entries()) {
      if (argument.value.kind !== 'closure' || !closures.includes(argument.value.closure)) continue;
      return this.argumentSpec(outer.rule.arguments ?? {}, outer.aligned[position], position)?.role;
    }
    return undefined;
  }

  private contentClosures(sink: SinkMatch): number[] {
    const result: number[] = [];
    for (const [position, argument] of sink.site.arguments.entries()) {
      const spec = this.argumentSpec(sink.rule.arguments ?? {}, sink.aligned[position], position);
      if (spec?.content && argument.value.kind === 'closure') result.push(argument.value.closure);
    }
    return result;
  }

  private sinkOf(site: CallSite, frame: Frame, call: number): SinkMatch | undefined {
    let fallback: SinkMatch | undefined;
    for (const rule of this.engine.rules.sinks) {
      if (!rule.call) continue;
      const pattern = parseCallPattern(rule.call);
      const aligned = this.engine.matchCall(pattern, site, frame);
      if (!aligned) continue;
      const match = { rule, aligned, frame, call, site };
      if (!pattern.labels || pattern.labels.length === site.arguments.length) return match;
      fallback ??= match;
    }
    return fallback;
  }

  private argumentSpec(specs: Record<string, SinkArgument>, label: string | undefined, position: number): SinkArgument | undefined {
    return (
      (label !== undefined && label !== '_' ? specs[label] : undefined) ??
      specs[String(position)] ??
      (label === '_' ? specs['_'] : undefined)
    );
  }

  private swiftUIItem(type: TypeInfo, sink: SinkMatch, number: number, parent: string | undefined): ScreenItem {
    const path = this.containerPath(type, sink.frame, sink.call);
    const kind = sink.rule.item ?? sink.site.name;
    const item: ScreenItem = {
      id: `${type.path}#${number}`,
      owner: type.path,
      path: [...path, kind],
      kind,
      direction: sink.rule.direction,
      shownWhen: sink.site.branch,
      at: { file: sink.frame.file.path, line: sink.site.line },
      data: [],
    };
    if (parent) item.parent = parent;
    for (const [position, argument] of sink.site.arguments.entries()) {
      const spec = this.argumentSpec(sink.rule.arguments ?? {}, sink.aligned[position], position);
      if (!spec || spec.content) continue;
      // `isPresented: $viewModel.showsError`: the item shows while the value is true.
      if (spec.role === 'shown') {
        item.shownWhen = [...item.shownWhen, this.engine.render(argument.value, sink.frame.file.facts).replace(/^\$/, '')];
        continue;
      }
      item.data.push(this.data(spec.role, spec, argument.value, sink.frame, sink.site));
    }
    return item;
  }

  private data(role: string, spec: SinkArgument | undefined, value: ValueExpr, frame: Frame, site: CallSite): ItemData {
    const engine = this.engine;
    const at = engine.location(frame, site.line);
    const data: ItemData = { role, value: engine.render(value, frame.file.facts), at, traced: [] };
    if (spec?.direction === 'action') {
      const calls = value.kind === 'closure' ? this.closureCalls(frame, value.closure) : [data.value];
      data.action = { calls, at };
      return data;
    }
    if (spec?.direction === 'input' && value.kind === 'path') {
      const property = this.propertyOfPath(value, frame);
      if (property) {
        const writerFrame = engine.frameOf(property);
        const initial = writerFrame?.file.facts.flow.assignments.find((assignment) => assignment.from === property.declaration.localId);
        const type =
          property.declaration.type ??
          property.declaration.inferredType ??
          (initial && writerFrame ? literalType(engine.typeOf(initial.value, writerFrame)) : undefined);
        data.input = {
          property: engine.symbolName(property),
          type,
          initial: initial && writerFrame ? engine.render(initial.value, writerFrame.file.facts) : undefined,
          at: { file: property.file.path, line: property.declaration.range[0] },
          readElsewhere: engine.readersOf(property, this.screenMembers).length > 0,
          ...(initial && writerFrame
            ? {
                initialSources: engine
                  .trace(initial.value, writerFrame, [], initial.line)
                  .filter((traced) => sourceGroup(traced) !== 'literal'),
              }
            : {}),
        };
        return data;
      }
    }
    // `prompt: Text("login.prompt")`: the text of a Text view given as a value is localized like the view.
    if (value.kind === 'call') {
      const site = frame.file.facts.flow.calls[value.call];
      const key =
        site && !site.receiver && site.name === 'Text' && site.arguments.length === 1 && site.arguments[0]!.label === '_'
          ? site.arguments[0]!.value
          : undefined;
      if (key?.kind === 'literal' && key.type === 'String') {
        const localized = this.engine.localizationOrigin(key.value, frame.file.module, at);
        if (localized) {
          data.traced = [localized];
          return data;
        }
      }
    }
    if (spec?.localized && value.kind === 'literal' && value.type === 'String') {
      const localized = this.engine.localizationOrigin(value.value, frame.file.module, at);
      if (localized) {
        data.traced = [localized];
        return data;
      }
    }
    data.traced = engine.trace(value, frame, [], site.line || undefined);
    return data;
  }

  private closureCalls(frame: Frame, closure: number): string[] {
    const engine = this.engine;
    return frame.file.facts.flow.calls
      .map((site, call) => ({ site, call }))
      .filter(({ site }) => site.closure === closure && site.parent === null)
      .map(({ call }) => engine.render({ kind: 'call', call }, frame.file.facts));
  }

  /** The property a path ends at: `self.vm.firstName` → `LoginViewModel.firstName`. */
  private propertyOfPath(value: Extract<ValueExpr, { kind: 'path' }>, frame: Frame): DeclarationInfo | undefined {
    const engine = this.engine;
    let type: TypeInfo | undefined;
    if (value.root.kind === 'self') type = frame.self;
    else if (value.root.kind === 'type') type = engine.resolveType(value.root.name, frame).info;
    else if (value.root.kind === 'local') type = engine.typeOf({ kind: 'path', root: value.root, members: [] }, frame)?.info;
    let property: DeclarationInfo | undefined;
    for (const member of value.members) {
      if (!type) return undefined;
      const found = engine.index.property(type, member);
      if (!found) return undefined;
      property = engine.infoOf(found);
      const next = engine.propertyType(found);
      type = next?.info;
    }
    return property;
  }

  // --- UIKit --------------------------------------------------------------------------

  private collectUIKit(type: TypeInfo, parent: string | undefined): void {
    const engine = this.engine;
    const byKey = new Map<string, ScreenItem>();
    const owners = new Map<string, TypeInfo>();
    const childTypes = new Map<TypeInfo, Location>();
    const counters = new Map<string, number>();
    const itemFor = (ownerType: TypeInfo, key: string, kind: string, direction: string, at: Location, branch: string[]) => {
      const mapKey = `${ownerType.path}|${key}`;
      let item = byKey.get(mapKey);
      if (!item) {
        const number = (counters.get(ownerType.path) ?? this.items.filter((existing) => existing.owner === ownerType.path).length) + 1;
        counters.set(ownerType.path, number);
        item = { id: `${ownerType.path}#${number}`, owner: ownerType.path, path: [key], kind, direction, shownWhen: branch, at, data: [] };
        if (ownerType !== type) item.parent = parent;
        else if (parent) item.parent = parent;
        byKey.set(mapKey, item);
        owners.set(mapKey, ownerType);
        this.items.push(item);
      }
      return item;
    };

    for (const info of this.members(type)) {
      const frame = engine.frameOf(info);
      if (!frame) continue;
      const facts = frame.file.facts;
      // Property sinks: `titleLabel.text = value`.
      for (const assignment of facts.flow.assignments) {
        if (assignment.from !== info.declaration.localId || assignment.target.kind !== 'path') continue;
        const target = assignment.target;
        const member = target.members.at(-1);
        if (!member) continue;
        const receiver: ValueExpr = { ...target, members: target.members.slice(0, -1) };
        for (const rule of engine.rules.sinks) {
          if (!rule.property) continue;
          const pattern = parseCallPattern(rule.property);
          if (pattern.name !== member) continue;
          if (
            receiver.kind === 'path' &&
            receiver.members.length === 0 &&
            receiver.root.kind === 'self' &&
            pattern.type !== 'UIViewController'
          )
            continue;
          const receiverType =
            receiver.kind === 'path' && (receiver.members.length > 0 || receiver.root.kind !== 'self')
              ? engine.typeOf(receiver, frame)
              : frame.self
                ? engine.tyOfInfo(frame.self)
                : undefined;
          if (!this.isKind(receiverType, pattern.type)) continue;
          const ownerType = this.ownerOf(receiver, frame, type);
          if (ownerType !== type) childTypes.set(ownerType, { file: frame.file.path, line: assignment.line });
          const key =
            receiver.kind === 'path' && receiver.members.length > 0 ? lastSegments(receiver, ownerType !== type) : (rule.item ?? member);
          const kind = rule.item ?? (receiverType ? baseName(receiverType) : (pattern.type ?? member));
          const item = itemFor(ownerType, key, kind, rule.direction, { file: frame.file.path, line: assignment.line }, assignment.branch);
          if (rule.role === 'hidden') {
            // `label.isHidden = cond`: the item shows when the condition is false.
            const condition = `!(${engine.render(assignment.value, facts)})`;
            if (!item.shownWhen.includes(condition)) item.shownWhen = [...item.shownWhen, condition];
            break;
          }
          const data = this.data(rule.role ?? member, { role: rule.role ?? member }, assignment.value, frame, {
            ...dummySite,
            line: assignment.line,
          });
          item.data.push(data);
          break;
        }
      }
      // Call sinks: `button.setTitle(_:for:)`, `addTarget(_:action:for:)`.
      for (const [call, site] of facts.flow.calls.entries()) {
        if (site.from !== info.declaration.localId) continue;
        const sink = site.receiver ? this.sinkOf(site, frame, call) : undefined;
        if (!sink || !sink.rule.call) continue;
        const receiver = site.receiver!;
        const ownerType = this.ownerOf(receiver, frame, type);
        const receiverType = engine.typeOf(receiver, frame);
        const key = receiver.kind === 'path' ? lastSegments(receiver, ownerType !== type) : engine.render(receiver, facts);
        const item = itemFor(
          ownerType,
          key,
          receiverType ? baseName(receiverType) : (sink.rule.item ?? site.name),
          sink.rule.direction,
          { file: frame.file.path, line: site.line },
          site.branch,
        );
        for (const [position, argument] of site.arguments.entries()) {
          const spec = this.argumentSpec(sink.rule.arguments ?? {}, sink.aligned[position], position);
          if (!spec) continue;
          item.data.push(this.data(spec.role, spec, argument.value, frame, site));
        }
      }
      // A table or collection: rows from `numberOfRowsInSection`.
      if (/^(tableView\(_:numberOfRowsInSection:\)|collectionView\(_:numberOfItemsInSection:\))$/.test(info.declaration.selector)) {
        for (const item of facts.flow.returns.filter((returned) => returned.from === info.declaration.localId)) {
          const value = item.value;
          const rows: ValueExpr =
            value.kind === 'path' && value.members.at(-1) === 'count' ? { ...value, members: value.members.slice(0, -1) } : value;
          const kind = info.declaration.selector.startsWith('tableView') ? 'UITableView' : 'UICollectionView';
          const list = itemFor(
            type,
            kind === 'UITableView' ? 'tableView' : 'collectionView',
            kind,
            'list',
            { file: frame.file.path, line: item.line },
            [],
          );
          list.data.push({
            role: 'rows',
            value: engine.render(rows, facts),
            at: { file: frame.file.path, line: item.line },
            traced: engine.trace(rows, frame),
          });
        }
      }
    }
    if (this.options.children === false) return;
    // Cells and custom views referenced by the screen.
    for (const info of this.members(type)) {
      for (const edge of engine.graph.outgoing(info.id, ['REFERENCES', 'INSTANTIATES'])) {
        const target = engine.declaration(edge.symbol);
        const child = target ? engine.index.typeOf(target.declaration) : undefined;
        if (!child || child === type || !viewKind(engine, child)) continue;
        if (!childTypes.has(child)) childTypes.set(child, edge.evidence[0] ?? { file: info.file.path, line: info.declaration.range[0] });
      }
    }
    for (const [child, at] of childTypes) {
      if (this.visited.has(child)) continue;
      const isItemView = engine.rules.itemViews.some((rule) => rule.match && engine.matchesType(child, rule.match));
      const list = this.items.find((item) => item.owner === type.path && item.direction === 'list');
      this.children.push({ name: child.path, how: isItemView ? `cell${list ? ` of ${list.id}` : ''}` : 'subview', at });
      this.collect(child, isItemView ? list?.id : parent);
    }
  }

  /** Whether a type is (or derives from) an SDK or repository type name. */
  private isKind(type: Ty | undefined, name: string | undefined): boolean {
    if (!name || name === '*') return true;
    if (!type) return false;
    if (baseName(type) === name) return true;
    if (type.info) return this.engine.index.externalNames(type.info).includes(name);
    return uikitKind(baseName(type), name);
  }

  /** The view an item belongs to: a cell held in a local (`cell.nameLabel`) belongs to the cell. */
  private ownerOf(receiver: ValueExpr, frame: Frame, screen: TypeInfo): TypeInfo {
    if (receiver.kind !== 'path' || receiver.root.kind !== 'local') return screen;
    const type = this.engine.typeOf({ kind: 'path', root: receiver.root, members: [] }, frame)?.info;
    return type && viewKind(this.engine, type) ? type : screen;
  }

  // --- Conditions --------------------------------------------------------------------

  private conditions(): ScreenCondition[] {
    const engine = this.engine;
    const byProperty = new Map<string, ScreenCondition>();
    for (const item of this.items) {
      const frameInfo = engine.declaration(engine.index.types().find((type) => type.path === item.owner)?.id ?? '');
      const ownerType = frameInfo ? engine.index.typeOf(frameInfo.declaration) : undefined;
      if (!ownerType) continue;
      for (const condition of item.shownWhen) {
        for (const expression of conditionPaths(condition)) {
          const property = this.propertyOfText(expression, ownerType);
          if (!property) continue;
          let entry = byProperty.get(property.id);
          if (!entry) {
            const member = property.enclosing?.members.get(property.declaration.name)?.find((candidate) => candidate.id === property.id);
            const type = member ? engine.propertyType(member) : undefined;
            entry = {
              expression,
              property: engine.symbolName(property),
              type: type ? tyText(type) : property.declaration.type,
              items: [],
              writes: this.writes(property),
            };
            byProperty.set(property.id, entry);
          }
          if (!entry.items.includes(item.id)) entry.items.push(item.id);
        }
      }
    }
    return [...byProperty.values()];
  }

  private propertyOfText(expression: string, owner: TypeInfo): DeclarationInfo | undefined {
    const engine = this.engine;
    let type: TypeInfo | undefined = owner;
    let property: DeclarationInfo | undefined;
    for (const member of expression.replace(/^self\./, '').split('.')) {
      if (!type) return undefined;
      const found = engine.index.property(type, member);
      if (!found) return property && member === 'isEmpty' ? property : undefined;
      property = engine.infoOf(found);
      type = engine.propertyType(found)?.info;
    }
    return property;
  }

  private writes(property: DeclarationInfo): ConditionWrite[] {
    const engine = this.engine;
    return engine.writersOf(property).map((writer) => {
      const value = engine.render(writer.value, writer.frame.file.facts);
      const write: ConditionWrite = {
        value,
        kind: writer.kind,
        when: writer.branch,
        at: writer.at,
        symbol: engine.symbolName(writer.frame.info),
        layer: engine.layerOf(writer.frame.self),
        because: [],
        traced: writer.value.kind === 'literal' || writer.value.kind === 'case' ? [] : engine.trace(writer.value, writer.frame),
      };
      if (writer.kind !== 'initial') {
        for (const name of conditionRoots(writer.branch.join(' && '))) {
          const scope = this.scopeOf(name, writer.frame);
          if (scope === undefined) continue;
          write.because.push(...engine.trace({ kind: 'path', root: { kind: 'local', name, scope }, members: [] }, writer.frame));
        }
        if (write.because.length > 0 && write.because.every((traced) => traced.failingCast)) {
          write.unreachable = write.because.find((traced) => traced.failingCast)!.warnings.find((warning) => warning.startsWith('cast'))!;
        }
      }
      return write;
    });
  }

  /** Scope of a local or parameter visible in a frame; -1 for a parameter. */
  private scopeOf(name: string, frame: Frame): number | undefined {
    const from = frame.info?.declaration.localId ?? null;
    const binding = frame.file.facts.flow.bindings.find((candidate) => candidate.from === from && candidate.name === name);
    if (binding) return binding.scope;
    if (this.engine.parameterNamed(frame, name)) return -1;
    return undefined;
  }
}

/** UIKit classes by suffix: `UILabel` is a `UIView`, `UIButton` a `UIControl`. */
function uikitKind(type: string, name: string): boolean {
  if (!type.startsWith('UI')) return false;
  if (name === 'UIView') return /(View|Label|Button|Field|Control|Switch|Slider|Stepper|Bar|Indicator|Cell)$/.test(type);
  if (name === 'UIControl') return /(Button|Field|Control|Switch|Slider|Stepper)$/.test(type);
  return false;
}

/** A `List`/`ForEach` shown as an item: its rows come from the first argument. */
function listRule(name: string): Loaded<SinkRule> {
  return { call: name, item: name, direction: 'list', arguments: { '0': { role: 'rows' } }, origin: 'itemViews' };
}

const dummySite: CallSite = {
  from: null,
  name: '',
  selector: '',
  reference: -1,
  parent: null,
  closure: null,
  arguments: [],
  branch: [],
  line: 0,
  column: 0,
};

function isTypeName(name: string): boolean {
  const first = name.replace(/^`/, '')[0];
  return first !== undefined && first !== first.toLowerCase();
}

function baseName(type: Ty): string {
  return type.info ? type.info.name : type.text.replace(/[<?].*$/, '');
}

function literalType(type: Ty | undefined): string | undefined {
  return type ? tyText(type) : undefined;
}

function lastSegments(path: Extract<ValueExpr, { kind: 'path' }>, withRoot: boolean): string {
  const members = path.members.filter((member) => member !== '[]');
  if (withRoot && path.root.kind === 'local') return members.join('.') || path.root.name;
  return members.join('.');
}

/** Member paths in a condition: `vm.state == .login` → `vm.state`. */
export function conditionPaths(condition: string): string[] {
  const paths = new Set<string>();
  for (const match of condition.matchAll(/(?<![.\w$])([A-Za-z_]\w*(?:\??\.[A-Za-z_]\w*)*)/g)) {
    const path = match[1]!.replace(/\?\./g, '.');
    if (['let', 'var', 'case', 'nil', 'true', 'false', 'self', 'is', 'as', 'some', 'none'].includes(path)) continue;
    paths.add(path.replace(/\.(isEmpty|count|isNil)$/, ''));
  }
  return [...paths];
}

/** Root names of the values a condition reads: `!entity.isEmpty` → `entity`. */
function conditionRoots(condition: string): string[] {
  return [...new Set(conditionPaths(condition).map((path) => path.split('.')[0]!))].filter((name) => name !== '' && !isTypeName(name));
}

/** `api`, `local`, `file`, `localization`, `literal`, `input`, `unresolved`. */
export function sourceGroup(traced: Traced): string {
  const origin = traced.origin;
  if (origin.kind === 'source') {
    if (origin.source === 'local.file') return 'file';
    if (origin.source.startsWith('local')) return 'local';
    return origin.source;
  }
  if (origin.kind === 'case' || origin.kind === 'instance') return 'literal';
  if (origin.kind === 'derived') return 'computed';
  if (origin.kind === 'error') return 'error';
  return origin.kind;
}
