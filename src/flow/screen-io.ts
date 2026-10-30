// What a screen receives and where it goes: the data passed in when it is
// created (INPUT, by the `inputs` rules) and the screens it pushes or
// presents, with the values passed to them (OUTPUT, by the `navigation`
// rules). Printed by `flows`; see docs/05-data-flow.md, section 6.2.

import { asList, globMatches, parseCallPattern } from '../rules/load.ts';
import type { InputRule, Loaded } from '../rules/types.ts';
import type { DeclarationInfo, TypeInfo } from '../resolve/resolve.ts';
import type { CallArgument, CallSite, FileFacts, ValueExpr } from '../schema/types.ts';
import { mapArguments, type FlowEngine, type Frame, type Location, type Traced } from './engine.ts';

/** A value passed to a screen: `item: row`. */
export interface PassedArgument {
  /** The screen's parameter or property that receives the value (`_` when unknown). */
  label: string;
  value: string;
  traced: Traced[];
  /** How it is passed after the screen is created: `property` (`vc.item = row`) or an input method (`configure(with:)`). */
  via?: string;
}

/** Data a screen receives when it is created. */
export interface ScreenInput {
  name: string;
  /** Argument label callers write (`_` when none). */
  label: string;
  type?: string;
  /** Kind of the `inputs` rule that matched: `init`, `memberwise`, `binding`, `environment`, `configure`, ... */
  kind: string;
  /** Initializer or method the value is passed through. */
  selector?: string;
  /** Default value: callers may leave the argument out. */
  default?: string;
  /** Property the value is stored in. */
  property?: string;
  attribute?: string;
  at: Location;
}

/** A place that creates the screen, or calls one of its input methods, with what it passes. */
export interface ScreenCaller {
  /** Type (or declaration) that creates the screen. */
  from: string;
  at: Location;
  /** Input method called (`configure(with:)`); absent when the screen is created. */
  selector?: string;
  transition?: string;
  arguments: PassedArgument[];
}

/** A screen this one pushes or presents. */
export interface ScreenOutput {
  id: string;
  /** `push`, `modal`, or a transition named by a project rule. */
  transition: string;
  to: string;
  /** Router method the navigation goes through. */
  via?: string;
  /** What starts it: an item (`#3 tap`), a modifier (`#6 .onTapGesture`), a method. */
  trigger: string;
  when: string[];
  at: Location;
  arguments: PassedArgument[];
}

/** INPUT and OUTPUT of a screen, printed by `flows`. */
export interface ScreenIO {
  inputs: ScreenInput[];
  callers: ScreenCaller[];
  outputs: ScreenOutput[];
}

type InputMethod = { info: DeclarationInfo; rule: Loaded<InputRule> };

/**
 * What a screen receives and where it goes. `members` are the screen's own
 * members (with extensions); `itemAt` names the item of the screen at a line.
 */
export function screenIO(
  engine: FlowEngine,
  type: TypeInfo,
  members: DeclarationInfo[],
  itemAt: (file: string, line: number) => string | undefined,
): ScreenIO {
  const methods = inputMethods(engine, type, members);
  const callers = screenCallers(
    engine,
    type,
    methods.map((method) => method.info),
  );
  return {
    inputs: screenInputs(engine, type, members, methods, callers),
    callers,
    outputs: screenOutputs(engine, type, members, itemAt),
  };
}

/** The first `inputs` rule for a member of the screen (the project's rules come first). */
function inputRule(engine: FlowEngine, type: TypeInfo, test: (rule: Loaded<InputRule>) => boolean): Loaded<InputRule> | undefined {
  return engine.rules.inputs.find((rule) => test(rule) && (!rule.match || engine.matchesType(type, rule.match)));
}

/** Initializers and methods whose parameters are inputs, with the rule that says so. */
function inputMethods(engine: FlowEngine, type: TypeInfo, members: DeclarationInfo[]): InputMethod[] {
  const methods: InputMethod[] = [];
  for (const info of members) {
    const declaration = info.declaration;
    const initializer = declaration.kind === 'initializer';
    if (!initializer && (declaration.kind !== 'function' || declaration.isStatic)) continue;
    if (declaration.attributes.includes('available')) continue;
    const rule = inputRule(engine, type, (candidate) => {
      const glob = initializer ? candidate.initializer : candidate.method;
      return glob !== undefined && globMatches(glob, declaration.selector);
    });
    if (rule && !rule.ignore) methods.push({ info, rule });
  }
  return methods;
}

function screenInputs(
  engine: FlowEngine,
  type: TypeInfo,
  members: DeclarationInfo[],
  methods: InputMethod[],
  callers: ScreenCaller[],
): ScreenInput[] {
  const inputs: ScreenInput[] = [];
  const at = (info: DeclarationInfo): Location => ({ file: info.file.path, line: info.declaration.range[0] });
  for (const { info, rule } of methods) {
    const frame = engine.frameOf(info);
    for (const parameter of info.declaration.parameters ?? []) {
      // The property the method stores the parameter in: `self.viewModel = viewModel`.
      const stored = frame?.file.facts.flow.assignments.find(
        (assignment) =>
          assignment.from === info.declaration.localId &&
          assignment.value.kind === 'path' &&
          assignment.value.root.kind === 'local' &&
          assignment.value.root.name === parameter.name &&
          assignment.value.members.length === 0 &&
          assignment.target.kind === 'path' &&
          assignment.target.root.kind === 'self' &&
          assignment.target.members.length === 1,
      );
      const input: ScreenInput = {
        name: parameter.name,
        label: parameter.label,
        type: parameter.type,
        kind: rule.kind,
        selector: info.declaration.selector,
        at: at(info),
      };
      if (parameter.hasDefault) input.default = '…';
      if (stored?.target.kind === 'path') input.property = stored.target.members[0]!;
      inputs.push(input);
    }
  }
  const stored = new Set(inputs.flatMap((input) => (input.property ? [input.property] : [])));
  // Swift's memberwise initializer: a struct without initializers of its own.
  const memberwise =
    type.kind === 'struct' && !members.some((info) => info.declaration.kind === 'initializer')
      ? inputRule(engine, type, (rule) => rule.memberwise === true)
      : undefined;
  const passed = new Set(
    callers
      .filter((caller) => !caller.selector)
      .flatMap((caller) => caller.arguments.filter((argument) => !argument.via).map((argument) => argument.label)),
  );
  // Properties the creators set after creating the screen: `detail.item = row`.
  const set = new Set(
    callers.flatMap((caller) => caller.arguments.filter((argument) => argument.via === 'property').map((argument) => argument.label)),
  );
  for (const info of members) {
    const declaration = info.declaration;
    if (declaration.kind !== 'property' || declaration.isStatic || declaration.isComputed) continue;
    // Filled by an initializer already listed: `_text = text`.
    if (stored.has(declaration.name) || stored.has(`_${declaration.name}`)) continue;
    const written = declaration.type ?? declaration.inferredType;
    const wrapped = inputRule(
      engine,
      type,
      (rule) => rule.attribute !== undefined && asList(rule.attribute).some((attribute) => declaration.attributes.includes(attribute)),
    );
    if (wrapped) {
      if (wrapped.ignore) continue;
      inputs.push({
        name: declaration.name,
        label: declaration.name,
        ...(written ? { type: written } : {}),
        kind: wrapped.kind,
        attribute: asList(wrapped.attribute).find((attribute) => declaration.attributes.includes(attribute))!,
        at: at(info),
      });
      continue;
    }
    if (set.has(declaration.name) && !(memberwise && !memberwise.ignore)) {
      const frame = engine.frameOf(info);
      const initial = frame?.file.facts.flow.assignments.find((assignment) => assignment.from === declaration.localId);
      inputs.push({
        name: declaration.name,
        label: declaration.name,
        ...(written ? { type: written } : {}),
        kind: 'property',
        ...(initial && frame ? { default: engine.render(initial.value, frame.file.facts) } : {}),
        at: at(info),
      });
      continue;
    }
    if (!memberwise || memberwise.ignore || declaration.access === 'private' || declaration.access === 'fileprivate') continue;
    if (declaration.modifiers.includes('lazy')) continue;
    const frame = engine.frameOf(info);
    const initial = frame?.file.facts.flow.assignments.find((assignment) => assignment.from === declaration.localId);
    // A `let` with a value is not settable; a `var` with one only when a caller passes it.
    const constant = /(^|\s)let\s/.test(declaration.signature.slice(0, declaration.signature.indexOf(declaration.name)));
    if (initial && constant) continue;
    if (initial && !passed.has(declaration.name)) continue;
    const input: ScreenInput = {
      name: declaration.name,
      label: declaration.name,
      ...(written ? { type: written } : {}),
      kind: memberwise.kind,
      at: at(info),
    };
    if (initial && frame) input.default = engine.render(initial.value, frame.file.facts);
    inputs.push(input);
  }
  return inputs;
}

/**
 * Places in the repository that create the screen (`ProductRow(row: row)`,
 * `ProfileViewController()`) or call one of its input methods (`vc.configure(with: item)`).
 */
function screenCallers(engine: FlowEngine, type: TypeInfo, methods: DeclarationInfo[]): ScreenCaller[] {
  const files = new Set<string>();
  const ids = [
    type.id,
    ...[...type.members.values()]
      .flat()
      .filter((member) => member.declaration.kind === 'initializer')
      .map((member) => member.id),
    ...methods.map((method) => method.id),
  ];
  for (const id of ids)
    for (const edge of engine.graph.incoming(id, ['INSTANTIATES', 'CALLS', 'REFERENCES']))
      if (engine.isProduction(edge)) for (const evidence of edge.evidence) files.add(evidence.file);
  const names = new Set(methods.filter((method) => method.declaration.kind === 'function').map((method) => method.declaration.name));
  const callers: ScreenCaller[] = [];
  for (const path of [...files].sort()) {
    const file = engine.context(path);
    if (!file) continue;
    file.facts.flow.calls.forEach((site, call) => {
      const creates = !site.receiver && site.name === type.name;
      if (!creates && !names.has(site.name)) return;
      const info = engine.declarationFrom(file, site.from);
      // Code outside declarations: a `#Preview`.
      if (!info) return;
      const frame: Frame = engine.frameOf(info) ?? { file, bound: new Map() };
      let selector: string | undefined;
      if (creates) {
        if (engine.resolveType(site.name, frame).info !== type) return;
      } else {
        const method = engine.callTargets(call, frame).find((target) => methods.includes(target.target))?.target;
        // The screen calling its own method is not a caller.
        if (!method || info.enclosing === type) return;
        selector = method.declaration.selector;
      }
      const caller: ScreenCaller = {
        from: info.enclosing?.path ?? engine.symbolName(info),
        at: { file: path, line: site.line },
        ...(selector ? { selector } : {}),
        arguments: named(engine, site.arguments, call, frame),
      };
      // `let detail = DetailViewController()` then `detail.item = row`: the properties set are passed too.
      const bound = creates
        ? file.facts.flow.bindings.find((binding) => binding.value.kind === 'call' && binding.value.call === call)
        : undefined;
      if (bound) caller.arguments.push(...propertiesSet(engine, bound.name, frame, info, Number.MAX_SAFE_INTEGER));
      const navigation = engine.enclosingNavigation(frame, call);
      if (navigation) caller.transition = navigation.transition;
      callers.push(caller);
    });
  }
  return callers;
}

/** Screens pushed or presented from the screen's own code, with the values passed to them. */
function screenOutputs(
  engine: FlowEngine,
  type: TypeInfo,
  members: DeclarationInfo[],
  itemAt: (file: string, line: number) => string | undefined,
): ScreenOutput[] {
  const outputs: ScreenOutput[] = [];
  for (const info of members) {
    const frame = engine.frameOf(info);
    if (!frame) continue;
    const facts = frame.file.facts;
    facts.flow.calls.forEach((site, call) => {
      if (site.from !== info.declaration.localId) return;
      const navigation = engine.navigation(site, frame, call);
      if (!navigation) return;
      for (const destination of engine.shownBy(navigation, site, frame)) {
        if (destination.type === type) continue;
        const created = destination.call === undefined ? undefined : facts.flow.calls[destination.call];
        // A screen named by the rule gets the call's own arguments: `router.showDetail(id: item.id)`.
        const passed = created
          ? named(engine, created.arguments, destination.call!, frame)
          : destination.fixed
            ? passedArguments(
                engine,
                site.arguments.filter((_, position) => !navigation.destination.includes(position)),
                frame,
              )
            : [];
        // Values set on the screen between its creation and the navigation: `vc.item = row`, `vc.configure(with: row)`.
        for (const position of navigation.destination) {
          const value = site.arguments[position]?.value;
          if (value) passed.push(...setBefore(engine, destination.type, value, frame, info, site.line));
        }
        const output: ScreenOutput = {
          id: `O${outputs.length + 1}`,
          transition: navigation.transition,
          to: destination.type.path,
          trigger: triggerOf(engine, frame, call, info, itemAt),
          when: site.branch,
          at: { file: frame.file.path, line: site.line },
          arguments: passed,
        };
        if (navigation.via) output.via = engine.symbolName(navigation.via);
        outputs.push(output);
      }
    });
  }
  return outputs;
}

/** Arguments of the call that creates the next screen, each named by the parameter it fills: `DetailView(row)` → `item: row`. */
function named(engine: FlowEngine, args: CallArgument[], call: number, frame: Frame): PassedArgument[] {
  const passed = passedArguments(engine, args, frame);
  const parameters = engine.callTargets(call, frame)[0]?.target.declaration.parameters ?? [];
  for (const [parameter, argument] of mapArguments(parameters, frame.file.facts.flow.calls[call]!))
    if (passed[argument]) passed[argument]!.label = parameters[parameter]!.name;
  return passed;
}

/**
 * Values the code sets on the screen held by a local variable before showing
 * it: properties (`vc.viewModel = vm`) and calls of its input methods
 * (`vc.configure(with: row)`), in the same declaration, above the navigation.
 */
function setBefore(
  engine: FlowEngine,
  type: TypeInfo,
  value: ValueExpr,
  frame: Frame,
  info: DeclarationInfo,
  line: number,
): PassedArgument[] {
  if (value.kind !== 'path' || value.root.kind !== 'local' || value.members.length > 0) return [];
  const name = value.root.name;
  const facts = frame.file.facts;
  const local = (expr: ValueExpr | undefined, members: number) =>
    expr?.kind === 'path' && expr.root.kind === 'local' && expr.root.name === name && expr.members.length === members;
  const passed = propertiesSet(engine, name, frame, info, line);
  const members = [...type.members.values()].flat().flatMap((member) => engine.infoOf(member) ?? []);
  const methods = inputMethods(engine, type, members).filter((method) => method.info.declaration.kind === 'function');
  facts.flow.calls.forEach((site, call) => {
    if (site.from !== info.declaration.localId || site.line > line || !local(site.receiver, 0)) return;
    const method = engine.callTargets(call, frame).find((target) => methods.some((candidate) => candidate.info === target.target));
    if (!method) return;
    for (const argument of named(engine, site.arguments, call, frame))
      passed.push({ ...argument, via: method.target.declaration.selector });
  });
  return passed;
}

/** Properties set on a local variable in a declaration, above `line`: `detail.item = row`. */
function propertiesSet(engine: FlowEngine, name: string, frame: Frame, info: DeclarationInfo, line: number): PassedArgument[] {
  const facts = frame.file.facts;
  const passed: PassedArgument[] = [];
  for (const assignment of facts.flow.assignments) {
    const target = assignment.target;
    if (assignment.from !== info.declaration.localId || assignment.line > line) continue;
    if (target.kind !== 'path' || target.root.kind !== 'local' || target.root.name !== name || target.members.length !== 1) continue;
    passed.push({
      label: target.members[0]!,
      value: engine.render(assignment.value, facts),
      traced: engine.trace(assignment.value, frame),
      via: 'property',
    });
  }
  return passed;
}

function passedArguments(engine: FlowEngine, args: CallArgument[], frame: Frame): PassedArgument[] {
  return args.map((argument) => ({
    label: argument.label,
    value: engine.render(argument.value, frame.file.facts),
    traced: argument.value.kind === 'closure' ? [] : engine.trace(argument.value, frame),
  }));
}

/**
 * What starts a navigation: the item tapped (the label of a `NavigationLink`,
 * the view an `.onTapGesture` is attached to, a `Button`), else the closure's
 * modifier, else the method it is in.
 */
function triggerOf(
  engine: FlowEngine,
  frame: Frame,
  call: number,
  info: DeclarationInfo,
  itemAt: (file: string, line: number) => string | undefined,
): string {
  const facts = frame.file.facts;
  const path = frame.file.path;
  // A navigation call with a label (`NavigationLink { Text("…") }`): the item in the label.
  const label = labelItem(facts, call, path, itemAt);
  if (label) return `${label} tap`;
  for (let current: number | null = call, steps = 0; current !== null && steps < 64; steps++) {
    const inner: CallSite = facts.flow.calls[current]!;
    const outer = inner.parent ?? (inner.closure !== null ? (facts.flow.closures[inner.closure]?.call ?? null) : null);
    if (outer === null) break;
    const outerSite = facts.flow.calls[outer]!;
    const entry = engine.rules.entryPoints.find((rule) => rule.call && engine.matchCall(parseCallPattern(rule.call), outerSite, frame));
    if (entry) {
      const own = itemAt(path, outerSite.line);
      if (own) return `${own} ${entry.kind === 'action' ? 'tap' : entry.kind}`;
      // A modifier on a view: the view it is attached to.
      const receiver = receiverItem(facts, outerSite.receiver, path, itemAt);
      return `${receiver ? `${receiver} ` : ''}.${outerSite.name}`;
    }
    current = outer;
  }
  return info.declaration.selector;
}

function labelItem(
  facts: FileFacts,
  call: number,
  path: string,
  itemAt: (file: string, line: number) => string | undefined,
): string | undefined {
  const closures = new Set(facts.flow.closures.flatMap((closure, index) => (closure.call === call ? [index] : [])));
  for (const site of facts.flow.calls) if (site.closure !== null && closures.has(site.closure)) return itemAt(path, site.line);
  return undefined;
}

function receiverItem(
  facts: FileFacts,
  receiver: CallArgument['value'] | undefined,
  path: string,
  itemAt: (file: string, line: number) => string | undefined,
): string | undefined {
  for (let value = receiver, steps = 0; value && steps < 32; steps++) {
    const call = value.kind === 'call' ? value.call : value.kind === 'path' && value.root.kind === 'call' ? value.root.call : undefined;
    if (call === undefined) return undefined;
    const site = facts.flow.calls[call]!;
    const item = itemAt(path, site.line);
    if (item) return item;
    value = site.receiver;
  }
  return undefined;
}
