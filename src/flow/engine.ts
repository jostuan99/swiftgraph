// Data-flow engine over the stored facts: types of expressions, call targets
// (generic constraints, protocols, DI bindings) and backward tracing of a
// value to where it comes from. See docs/05-data-flow.md, sections 4 and 7.
//
// Analysis is per function body; values cross functions through argument →
// parameter, return → result and the flowThrough rules. There is no alias or
// pointer analysis: a property stands for every instance of its type.

import type { Db } from '../store/db.ts';
import { loadLocalizationFiles, loadResolverFiles } from '../build.ts';
import {
  baseTypeName,
  indexRepository,
  selectorMatches,
  type DeclarationInfo,
  type MemberInfo,
  type RepositoryIndex,
  type ResolverFile,
  type TypeInfo,
} from '../resolve/resolve.ts';
import { loadRules, alignArguments, argumentIndex, asList, globMatches, parseCallPattern, type CallPattern } from '../rules/load.ts';
import type { FlowThroughRule, Loaded, RuleSet, SourceRule, TypeMatch } from '../rules/types.ts';
import type { CallSite, Declaration, FileFacts, Parameter, ValueExpr } from '../schema/types.ts';
import { GraphAccess } from './graph-access.ts';
import { parseTypeText, type TypeText } from './type-text.ts';

// --- Model ------------------------------------------------------------------------

/** A resolved type. */
export interface Ty {
  text: string;
  info?: TypeInfo;
  args: Ty[];
  optional?: boolean;
  /** The type itself used as a value: `T.self`, `Foo.shared`'s receiver. */
  meta?: boolean;
  /** An unbound generic parameter and the protocols it is constrained to. */
  generic?: { name: string; constraints: TypeInfo[] };
}

export interface FileContext {
  path: string;
  module: string;
  resolverFile: ResolverFile;
  facts: FileFacts;
  infos: DeclarationInfo[];
}

/** A function, property or initializer body, as entered from a call or on its own. */
export interface Frame {
  file: FileContext;
  info?: DeclarationInfo;
  self?: TypeInfo;
  /** Generic parameters bound to concrete types. */
  bound: Map<string, Ty>;
  /** The call that entered this body; parameters are its arguments. */
  caller?: { frame: Frame; call: number };
}

export interface Location {
  file: string;
  line: number;
}

export interface CallTarget {
  /** Declaration that runs (the implementation when dispatched). */
  target: DeclarationInfo;
  /** Protocol requirement the call names, when dispatched to `target`. */
  requirement?: DeclarationInfo;
  /** Why `target` was chosen for a requirement. */
  via?: 'generic' | 'protocol' | 'di' | 'unique' | 'all';
  injection?: Injection;
  /** Generic parameters of the target, bound from the arguments. */
  bound: Map<string, Ty>;
  confidence: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
}

export interface Injection {
  service: TypeInfo;
  implementation: TypeInfo;
  rule: string;
  at: Location;
}

export interface Step {
  /** `param`, `return`, `property`, `closure`, `binding`, `cast`, `write`, `call`, `input`, `element`. */
  kind: string;
  text: string;
  /** Declaration the step happens in. */
  symbol?: string;
  layer?: string;
  at: Location;
  async?: boolean;
  note?: string;
}

export type Origin =
  | { kind: 'literal'; type: string; value: string; at: Location }
  | { kind: 'case'; name: string; type?: string; at: Location }
  | {
      kind: 'localization';
      table: string;
      key: string;
      missing: string[];
      values: { language: string; value: string | null }[];
      at: Location;
    }
  | {
      kind: 'source';
      source: string;
      rule: string;
      /** The call as written, and the API it matched (`JSONDecoder.decode`). */
      call: string;
      api: string;
      type?: Ty;
      key?: string;
      endpoint?: string;
      method?: string;
      input?: Traced[];
      direction?: 'read' | 'write';
      at: Location;
    }
  | { kind: 'input'; property: string; type?: string; initial?: string; at: Location }
  | { kind: 'instance'; type: string; call: string; at: Location }
  /** The result of an API with no rule (a formatter, an SDK call): made from these values. */
  | { kind: 'derived'; call: string; inputs: Traced[]; at: Location }
  /** An error caught by `catch`: the calls that throw it and where their data comes from. */
  | { kind: 'error'; type?: string; thrownBy: string[]; sources: Traced[]; at: Location }
  | { kind: 'unresolved'; reason: string; at: Location };

/** A value traced back to an origin. */
export interface Traced {
  origin: Origin;
  /** Members read from the origin's value: `sessionId`, `[]` for an element. */
  fields: string[];
  /** Type of the value after the fields, when known. */
  type?: Ty;
  /** JSON key of the last field of a decoded type. */
  jsonKey?: string;
  /** JSON path of the fields of a decoded response: `items[].product_name`. */
  jsonPath?: string[];
  /** From the origin towards the value (the value's own step last). */
  steps: Step[];
  warnings: string[];
  /** The path passes a cast between two known types that always fails. */
  failingCast?: boolean;
}

export interface Writer {
  frame: Frame;
  value: ValueExpr;
  target: ValueExpr;
  branch: string[];
  at: Location;
  /** `initial` for a stored property's initial value, `init` for a memberwise initializer argument. */
  kind: 'initial' | 'assign' | 'init';
}

// --- Engine -------------------------------------------------------------------------

const DEFAULT_DEPTH = 12;
/** Test targets and DocC snippets. */
const TEST_PATH = /(^|\/)(Tests?|[^/]*Tests|[^/]*UITests)\/|\.docc\//;
const RESULT_LIMIT = 24;
const CALLER_LIMIT = 12;

const ELEMENT_TYPES = new Set([
  'Array',
  'Set',
  'ArraySlice',
  'ContiguousArray',
  'AnyPublisher',
  'Just',
  'Future',
  'PassthroughSubject',
  'CurrentValueSubject',
  'Deferred',
  'Fail',
  'Empty',
  'Task',
  'AsyncStream',
  'AsyncThrowingStream',
  'Published.Publisher',
]);

export class FlowEngine {
  readonly index: RepositoryIndex;
  readonly rules: RuleSet;
  readonly graph: GraphAccess;
  readonly root: string;
  private readonly fileByPath = new Map<string, number>();
  private readonly contexts = new Map<string, FileContext | null>();
  private readonly declarationById = new Map<string, DeclarationInfo>();
  private injections: Map<TypeInfo, Injection[]> | undefined;
  private readonly callMemo = new WeakMap<Frame, Map<number, CallTarget[]>>();
  private readonly frameMemo = new WeakMap<DeclarationInfo, Frame>();
  private readonly languageMemo = new Map<string, string[]>();
  depthLimit = DEFAULT_DEPTH;

  constructor(db: Db, root: string, rules?: RuleSet) {
    this.graph = new GraphAccess(db);
    this.root = root;
    const files = loadResolverFiles(db);
    this.index = indexRepository(files, loadLocalizationFiles(db));
    for (const [position, file] of files.entries()) {
      this.fileByPath.set(file.path, position);
      for (const info of this.index.declarationsOf(position)) {
        if (!this.declarationById.has(info.id)) this.declarationById.set(info.id, info);
      }
    }
    const imports = new Set(files.flatMap((file) => file.facts.imports.map((name) => name.split('.')[0]!)));
    this.rules = rules ?? loadRules(root, imports);
  }

  // --- Files, declarations, frames -------------------------------------------------

  context(path: string): FileContext | undefined {
    if (this.contexts.has(path)) return this.contexts.get(path) ?? undefined;
    const position = this.fileByPath.get(path);
    const facts = position === undefined ? undefined : this.graph.facts(path);
    const context =
      position === undefined || !facts
        ? null
        : {
            path,
            module: this.index.files[position]!.module,
            resolverFile: this.index.files[position]!,
            facts,
            infos: this.index.declarationsOf(position),
          };
    this.contexts.set(path, context);
    return context ?? undefined;
  }

  declaration(id: string): DeclarationInfo | undefined {
    return this.declarationById.get(id);
  }

  /** Body of a declaration on its own (not entered from a call). */
  frameOf(info: DeclarationInfo): Frame | undefined {
    const cached = this.frameMemo.get(info);
    if (cached) return cached;
    const file = this.context(info.file.path);
    if (!file) return undefined;
    const frame: Frame = { file, info, self: info.enclosing, bound: new Map() };
    this.frameMemo.set(info, frame);
    return frame;
  }

  /** Body of a declaration entered from a call, with bound generic parameters. */
  enter(
    info: DeclarationInfo,
    bound: Map<string, Ty>,
    caller: { frame: Frame; call: number } | undefined,
    self?: TypeInfo,
  ): Frame | undefined {
    const file = this.context(info.file.path);
    if (!file) return undefined;
    return { file, info, self: self ?? info.enclosing, bound, caller };
  }

  declarationFrom(file: FileContext, from: number | null): DeclarationInfo | undefined {
    return from === null ? undefined : file.infos[from];
  }

  /** Layer of a type by the `layers` rules (project rules first). */
  layerOf(type: TypeInfo | undefined): string | undefined {
    if (!type) return undefined;
    for (const rule of this.rules.layers) if (this.matchesType(type, rule.match)) return rule.layer;
    return undefined;
  }

  matchesType(type: TypeInfo, match: TypeMatch): boolean {
    const names = asList(match.name);
    if (names.length > 0 && !names.some((glob) => globMatches(glob, type.name))) return false;
    const conforms = asList(match.conformsTo);
    if (conforms.length > 0) {
      const own = [...this.index.protocolsOf(type).map((protocol) => protocol.name), ...this.index.externalNames(type)];
      if (!conforms.some((name) => own.includes(name))) return false;
    }
    const inherits = asList(match.inherits);
    if (inherits.length > 0) {
      const chain: string[] = [];
      for (let current: TypeInfo | undefined = type; current; current = current.superclass) chain.push(current.name);
      chain.push(...this.index.externalNames(type));
      if (!inherits.some((name) => chain.includes(name))) return false;
    }
    const attributes = asList(match.attribute);
    if (attributes.length > 0 && !attributes.some((name) => type.declaration.attributes.includes(name))) return false;
    const modules = asList(match.module);
    if (modules.length > 0 && !modules.includes(type.module)) return false;
    const paths = asList(match.path);
    if (paths.length > 0) {
      const file = this.declarationById.get(type.id)?.file.path ?? '';
      if (!paths.some((glob) => globMatches(glob, file))) return false;
    }
    return true;
  }

  /** `Type.selector` of a declaration for display. */
  symbolName(info: DeclarationInfo | undefined): string {
    if (!info) return '<top level>';
    const owner = info.enclosing?.path;
    const name = info.declaration.kind === 'property' ? info.declaration.name : info.declaration.selector;
    return owner ? `${owner}.${name}` : name;
  }

  location(frame: Frame, line: number): Location {
    return { file: frame.file.path, line };
  }

  // --- Types -------------------------------------------------------------------------

  tyOfInfo(info: TypeInfo): Ty {
    return { text: info.path, info, args: [] };
  }

  /** Generic parameters in scope of a frame and their constraints. */
  genericScope(frame: Frame): Map<string, string[]> {
    const names = new Map<string, string[]>();
    const add = (declaration: Declaration) => {
      for (const name of declaration.genericParameters ?? [])
        if (!names.has(name)) names.set(name, declaration.genericConstraints?.[name] ?? []);
      for (const [name, constraints] of Object.entries(declaration.genericConstraints ?? {})) {
        if (!names.has(name)) continue;
        for (const constraint of constraints) if (!names.get(name)!.includes(constraint)) names.get(name)!.push(constraint);
      }
    };
    const declarations = frame.file.facts.declarations;
    for (let current = frame.info?.declaration; current; current = current.parent === null ? undefined : declarations[current.parent])
      add(current);
    if (frame.self) add(frame.self.declaration);
    return names;
  }

  /** Resolves a type as written in a frame (generic parameters substituted). */
  resolveType(written: string, frame: Frame): Ty {
    return this.resolveTypeText(parseTypeText(written), frame.file.resolverFile, frame.self, frame);
  }

  resolveTypeText(type: TypeText, file: ResolverFile, context: TypeInfo | undefined, frame?: Frame): Ty {
    if (type.opaque) return { text: type.name, args: [], optional: type.optional };
    const segments = type.name.split('.');
    const first = segments[0]!;
    let base: Ty | undefined;
    let rest = segments.slice(1);
    const generics = frame ? this.genericScope(frame) : undefined;
    if (generics?.has(first)) {
      base = frame!.bound.get(first);
      if (!base) {
        const constraints = generics
          .get(first)!
          .map((written) => this.index.typeNamed(written, file, context))
          .filter((found): found is TypeInfo => found !== undefined);
        base = { text: first, args: [], generic: { name: first, constraints } };
      }
    } else if (first === 'Self' && context) {
      base = this.tyOfInfo(context);
    } else {
      const whole = this.index.typeNamed(type.name, file, context);
      if (whole) {
        base = this.tyOfInfo(whole);
        rest = [];
      } else {
        const head = segments.length > 1 ? this.index.typeNamed(first, file, context) : undefined;
        if (head) base = this.tyOfInfo(head);
        else {
          base = { text: type.name, args: [] };
          rest = [];
        }
      }
    }
    for (const segment of rest) {
      base = this.associatedType(base, segment) ?? { text: `${base.text}.${segment}`, args: [] };
    }
    const result: Ty = { ...base };
    if (type.args.length > 0 && base.args.length === 0)
      result.args = type.args.map((arg) => this.resolveTypeText(arg, file, context, frame));
    if (type.optional) result.optional = true;
    if (result.args.length > 0 && !result.info) {
      if (result.text === 'Array' && result.args.length === 1) result.text = `[${tyText(result.args[0]!)}]`;
      else if (result.text === 'Dictionary' && result.args.length === 2)
        result.text = `[${tyText(result.args[0]!)}: ${tyText(result.args[1]!)}]`;
      else result.text = `${result.text}<${result.args.map(tyText).join(', ')}>`;
    }
    return result;
  }

  /** `X.Name` with X concrete: a typealias, a nested type, or an associated type inferred from a requirement. */
  associatedType(base: Ty, name: string): Ty | undefined {
    const type = base.info;
    if (!type) return undefined;
    const aliases = this.index.members(
      type,
      name,
      undefined,
      (member) => member.declaration.kind === 'typealias' && member.owner.kind !== 'protocol',
    );
    if (aliases.length === 1 && aliases[0]!.declaration.type) {
      const alias = aliases[0]!;
      return this.resolveTypeText(parseTypeText(alias.declaration.type!), this.index.fileOf(alias), alias.owner);
    }
    const declaringFile = this.declarationById.get(type.id)?.file;
    if (declaringFile) {
      const nested = this.index.typeNamed(name, declaringFile, type);
      if (nested && nested.path.startsWith(`${type.path}.`)) return this.tyOfInfo(nested);
    }
    // Inferred from the implementation of a requirement that uses it.
    for (const protocol of this.index.protocolsOf(type)) {
      if (!(protocol.members.get(name) ?? []).some((member) => member.declaration.kind === 'associatedtype')) continue;
      for (const requirements of protocol.members.values()) {
        for (const requirement of requirements) {
          if (requirement.fromExtension || requirement.declaration.kind !== 'function') continue;
          const declaration = requirement.declaration;
          const uses = (written: string | undefined) => written !== undefined && [name, `Self.${name}`].includes(baseTypeName(written));
          const positions = (declaration.parameters ?? []).map((parameter, at) => (uses(parameter.type) ? at : -1)).filter((at) => at >= 0);
          const inReturn = uses(declaration.returnType);
          if (positions.length === 0 && !inReturn) continue;
          const implementation = this.index
            .members(type, declaration.name, declaration.selector, (member) => member.declaration.kind === 'function')
            .find((member) => member.owner.kind !== 'protocol');
          if (!implementation) continue;
          const written = inReturn ? implementation.declaration.returnType : implementation.declaration.parameters?.[positions[0]!]?.type;
          if (!written || uses(written)) continue;
          return this.resolveTypeText(parseTypeText(written), this.index.fileOf(implementation), implementation.owner);
        }
      }
    }
    return undefined;
  }

  /** What a collection contains or a publisher emits. */
  elementType(type: Ty | undefined): Ty | undefined {
    if (!type) return undefined;
    const name = type.info
      ? type.info.name
      : type.text.startsWith('[')
        ? type.args.length === 2
          ? 'Dictionary'
          : 'Array'
        : baseTypeName(type.text.replace(/<.*$/, ''));
    if (type.args.length > 0 && (ELEMENT_TYPES.has(name) || /(Publisher|Subject|Stream)$/.test(name))) {
      return name === 'Dictionary' ? type.args[1] : type.args[0];
    }
    if (name === 'Dictionary' && type.args.length === 2) return type.args[1];
    return undefined;
  }

  /** Type of a property of `owner`, with the owner's generic arguments. */
  propertyType(property: MemberInfo): Ty | undefined {
    const written = property.declaration.type ?? property.declaration.inferredType;
    if (written) return this.resolveTypeText(parseTypeText(written), this.index.fileOf(property), property.owner);
    const type = this.index.propertyTypeOf(property);
    return type ? this.tyOfInfo(type) : undefined;
  }

  memberType(base: Ty | undefined, member: string, frame: Frame): Ty | undefined {
    if (!base) return undefined;
    if (member === '[]') return this.elementType(base);
    if (member === 'self' && base.meta) return { ...base, meta: true };
    if (member.startsWith('$')) {
      // The publisher of a `@Published` property.
      const value = this.memberType(base, member.slice(1), frame);
      return { text: 'Published.Publisher', args: value ? [value] : [] };
    }
    const owners = base.generic ? base.generic.constraints : base.info ? [base.info] : [];
    for (const owner of owners) {
      const property = this.index.property(owner, member);
      if (!property) continue;
      const type = this.propertyType(property);
      if (type && base.generic && type.text.startsWith('Self.')) return { text: `${base.generic.name}${type.text.slice(4)}`, args: [] };
      return type;
    }
    void frame;
    return undefined;
  }

  typeOf(expr: ValueExpr | undefined, frame: Frame, depth = 0): Ty | undefined {
    if (!expr || depth > this.depthLimit) return undefined;
    switch (expr.kind) {
      case 'literal':
        return expr.type === 'nil' ? undefined : { text: expr.type, args: [] };
      case 'case':
      case 'closure':
        return undefined;
      case 'call':
        return this.typeOfCall(expr.call, frame, depth + 1);
      case 'compound': {
        if (isCatch(expr.text)) {
          const caught = /\sas\s+([\w.]+)$/.exec(expr.text)?.[1];
          return caught ? this.resolveType(caught, frame) : { text: 'Error', args: [] };
        }
        const cast = castOf(expr);
        if (cast) {
          const type = this.resolveType(cast.type, frame);
          return cast.operator === '?' ? { ...type, optional: true } : type;
        }
        if (/\?\?/.test(expr.text) && expr.operands[0]) return unwrap(this.typeOf(expr.operands[0], frame, depth + 1));
        // `[Item].self`, `[String: Item].self`
        const metatype = /^(\[.+\])\.self$/.exec(expr.text);
        if (metatype) return { ...this.resolveType(metatype[1]!, frame), meta: true };
        return undefined;
      }
      case 'path': {
        let type: Ty | undefined;
        const root = expr.root;
        let members = expr.members;
        if (root.kind === 'self') type = frame.self ? this.tyOfInfo(frame.self) : undefined;
        else if (root.kind === 'type') {
          // `Mapper.ResponseEntity.self`: leading type names form one type.
          let count = 0;
          while (count < members.length && isTypeName(members[count]!)) count++;
          type = { ...this.resolveType([root.name, ...members.slice(0, count)].join('.'), frame), meta: true };
          members = members.slice(count);
        } else if (root.kind === 'local') type = this.typeOfLocal(root.name, root.scope, frame, depth + 1);
        else type = this.typeOfCall(root.call, frame, depth + 1);
        for (const member of members) {
          type = this.memberType(unwrap(type), member, frame);
          if (!type) return undefined;
        }
        return type;
      }
    }
  }

  private typeOfLocal(name: string, scope: number, frame: Frame, depth: number): Ty | undefined {
    const binding = this.findBinding(name, scope, frame, new Set());
    if (binding) {
      if (binding.type) return this.resolveType(binding.type, frame);
      return unwrap(this.typeOf(binding.value, frame, depth));
    }
    const closure = frame.file.facts.flow.closures.findIndex(
      (candidate) => candidate.scope === scope && candidate.parameters.includes(name),
    );
    if (closure >= 0)
      return this.typeOfClosureParameter(closure, frame.file.facts.flow.closures[closure]!.parameters.indexOf(name), frame, depth);
    const parameter = this.parameterNamed(frame, name);
    if (parameter) return this.resolveType(parameter.parameter.type, frame);
    return undefined;
  }

  private typeOfClosureParameter(closure: number, position: number, frame: Frame, depth: number): Ty | undefined {
    const fact = frame.file.facts.flow.closures[closure]!;
    if (fact.call === null) return undefined;
    const site = frame.file.facts.flow.calls[fact.call]!;
    const flow = this.flowRule(site, frame);
    const spec = flow ? closureSpec(flow, site, closure)?.parameters?.[position] : undefined;
    if (!spec) return undefined;
    const { base, element } = parseSpec(spec);
    const value = specValue(base, site, frame);
    if (!value) return undefined;
    const type = value.kind === 'closure' ? undefined : this.typeOf(value, frame, depth + 1);
    return element ? this.elementType(unwrap(type)) : type;
  }

  typeOfCall(call: number, frame: Frame, depth = 0): Ty | undefined {
    if (depth > this.depthLimit) return undefined;
    const site = frame.file.facts.flow.calls[call]!;
    const source = this.sourceRule(site, frame);
    if (source) return this.sourceType(source.rule, source.aligned, site, frame);
    const flow = this.flowRule(site, frame);
    if (flow?.rule.result) {
      const { base, element } = parseSpec(asList(flow.rule.result)[0]!);
      const value = specValue(base, site, frame);
      const type = value && value.kind !== 'closure' ? this.typeOf(value, frame, depth + 1) : undefined;
      return element ? this.elementType(type) : type;
    }
    if (flow?.rule.elements) {
      const { base, element } = parseSpec(asList(flow.rule.elements)[0]!);
      const value = specValue(base, site, frame);
      let type: Ty | undefined;
      if (value?.kind === 'closure') {
        const returned = frame.file.facts.flow.closures[value.closure]?.returns[0];
        type = this.typeOf(returned, frame, depth + 1);
      } else {
        type = this.typeOf(value, frame, depth + 1);
      }
      if (element) type = this.elementType(type);
      return { text: `${site.name}<${type ? tyText(type) : '?'}>`, args: type ? [type] : [] };
    }
    if (!site.receiver && isTypeName(site.name)) {
      const type = this.resolveType(site.name, frame);
      return type;
    }
    for (const target of this.callTargets(call, frame)) {
      const declaration = target.target.declaration;
      if (declaration.kind === 'initializer') return target.target.enclosing ? this.tyOfInfo(target.target.enclosing) : undefined;
      const written = declaration.returnType;
      if (!written) continue;
      const callee = this.enter(target.target, target.bound, { frame, call });
      if (!callee) continue;
      if (written === 'Self') return this.typeOf(site.receiver, frame, depth + 1);
      return this.resolveType(written, callee);
    }
    return undefined;
  }

  // --- Rules on calls --------------------------------------------------------------

  /** Whether a call (name, labels, receiver type) fits a `Type.selector` pattern. */
  matchCall(pattern: CallPattern, site: CallSite, frame: Frame): string[] | undefined {
    if (pattern.name !== site.name) return undefined;
    const labels = site.arguments.map((argument) => ({ label: argument.label, closure: argument.value.kind === 'closure' }));
    const aligned = alignArguments(pattern, labels);
    if (!aligned) return undefined;
    if (pattern.type === undefined) {
      // A call without receiver: a free function or a type construction.
      return site.receiver ? undefined : aligned;
    }
    if (pattern.type === '*') return aligned;
    if (!site.receiver) {
      // `Type.member` patterns also match an initializer of the type itself (`Data(contentsOf:)`).
      return undefined;
    }
    const type = this.typeOf(site.receiver, frame);
    if (!type) {
      // Receiver of unknown type: accept a type name written as the receiver, or the member name alone.
      return aligned;
    }
    if (type.text === pattern.type || baseTypeName(type.text) === pattern.type) return aligned;
    if (type.info) {
      if (type.info.name === pattern.type) return aligned;
      const names = [...this.index.externalNames(type.info), ...this.index.protocolsOf(type.info).map((protocol) => protocol.name)];
      for (let current = type.info.superclass; current; current = current.superclass) names.push(current.name);
      if (names.includes(pattern.type)) return aligned;
      return undefined;
    }
    // An SDK type we know nothing about: trust the member name.
    return aligned;
  }

  sourceRule(site: CallSite, frame: Frame): { rule: Loaded<SourceRule>; aligned: string[] } | undefined {
    for (const rule of this.rules.sources) {
      if (!rule.call) continue;
      const pattern = parseCallPattern(rule.call);
      const aligned = this.matchCall(pattern, site, frame);
      if (aligned) return { rule, aligned };
    }
    return undefined;
  }

  flowRule(site: CallSite, frame: Frame): { rule: Loaded<FlowThroughRule>; aligned: string[] } | undefined {
    let fallback: { rule: Loaded<FlowThroughRule>; aligned: string[] } | undefined;
    for (const rule of this.rules.flowThrough) {
      if (!rule.call) continue;
      const pattern = parseCallPattern(rule.call);
      const aligned = this.matchCall(pattern, site, frame);
      if (!aligned) continue;
      if (!pattern.labels || pattern.labels.length === site.arguments.length) return { rule, aligned };
      fallback ??= { rule, aligned };
    }
    return fallback;
  }

  /** A member read that a rule turns into an element access: `items.first`. */
  memberRule(member: string): Loaded<FlowThroughRule> | undefined {
    return this.rules.flowThrough.find((rule) => rule.member !== undefined && parseCallPattern(rule.member).name === member);
  }

  private sourceType(rule: SourceRule, aligned: string[], site: CallSite, frame: Frame): Ty | undefined {
    if (rule.type === undefined) return undefined;
    if (typeof rule.type === 'object') return this.resolveType(rule.type.fixed, frame);
    const position = argumentIndex(
      rule.type,
      aligned,
      site.arguments.map((argument) => argument.label),
    );
    const value = site.arguments[position]?.value;
    if (!value) return undefined;
    const type = this.typeOf(value, frame);
    return type ? { ...type, meta: undefined } : undefined;
  }

  // --- Call targets ----------------------------------------------------------------

  callTargets(call: number, frame: Frame): CallTarget[] {
    let memo = this.callMemo.get(frame);
    if (!memo) this.callMemo.set(frame, (memo = new Map()));
    const cached = memo.get(call);
    if (cached) return cached;
    memo.set(call, []);
    const targets = this.computeCallTargets(call, frame);
    memo.set(call, targets);
    return targets;
  }

  private computeCallTargets(call: number, frame: Frame): CallTarget[] {
    const site = frame.file.facts.flow.calls[call]!;
    const selector = site.selector;
    const callable = (member: MemberInfo) => isCallable(member.declaration);
    let found: { member: DeclarationInfo; confidence: CallTarget['confidence'] }[] = [];
    let receiverType: Ty | undefined;

    if (!site.receiver) {
      if (isTypeName(site.name)) {
        const type = this.resolveType(site.name, frame).info;
        if (!type) return [];
        const initializers = this.index.members(
          type,
          'init',
          `init${selector.slice(selector.indexOf('('))}`,
          (member) => member.declaration.kind === 'initializer',
        );
        return initializers
          .map((member) => ({ target: this.infoOf(member)!, bound: new Map(), confidence: 'INFERRED' as const }))
          .filter((target) => target.target);
      }
      if (frame.self) {
        found = this.index
          .members(frame.self, site.name, selector, callable)
          .map((member) => ({ member: this.infoOf(member)!, confidence: 'INFERRED' as const }));
      }
      if (found.length === 0) {
        found = this.index
          .topLevelNamed(frame.file.resolverFile, site.name)
          .filter((info) => isCallable(info.declaration) && selectorMatches(selector, info.declaration))
          .map((info) => ({ member: info, confidence: 'INFERRED' as const }));
      }
    } else {
      receiverType = unwrap(this.typeOf(site.receiver, frame));
      const owners = receiverType?.generic ? receiverType.generic.constraints : receiverType?.info ? [receiverType.info] : [];
      for (const owner of owners) {
        const members = this.index.members(
          owner,
          site.name,
          site.name === 'init' ? `init${selector.slice(selector.indexOf('('))}` : selector,
          callable,
        );
        found.push(
          ...members.map((member) => ({
            member: this.infoOf(member)!,
            confidence: (receiverType?.generic ? 'INFERRED' : 'EXTRACTED') as CallTarget['confidence'],
          })),
        );
        if (members.length > 0) break;
      }
      if (found.length === 0 && !receiverType) found = this.callTargetsFromGraph(site, frame);
    }

    const targets: CallTarget[] = [];
    for (const { member, confidence } of found.filter((entry) => entry.member)) {
      const owner = member.enclosing;
      const isRequirement =
        owner?.kind === 'protocol' && member.file.facts.declarations[member.declaration.parent ?? -1]?.kind === 'protocol';
      if (!isRequirement || !owner) {
        targets.push({ target: member, bound: this.bindGenerics(member, site, frame), confidence });
        continue;
      }
      const dispatched = this.dispatch(member, owner, receiverType);
      if (dispatched.length === 0) {
        targets.push({ target: member, bound: this.bindGenerics(member, site, frame), confidence });
        continue;
      }
      for (const entry of dispatched) {
        targets.push({
          target: entry.target,
          requirement: member,
          via: entry.via,
          injection: entry.injection,
          bound: this.bindGenerics(entry.target, site, frame),
          confidence: dispatched.length > 1 ? 'AMBIGUOUS' : confidence,
        });
      }
    }
    return targets;
  }

  /** CALLS edges of the stored graph from the frame's declaration at the call's line. */
  private callTargetsFromGraph(site: CallSite, frame: Frame): { member: DeclarationInfo; confidence: CallTarget['confidence'] }[] {
    if (!frame.info) return [];
    return this.graph
      .outgoing(frame.info.id, ['CALLS'])
      .filter((edge) => edge.evidence.some((evidence) => evidence.file === frame.file.path && evidence.line === site.line))
      .map((edge) => this.declarationById.get(edge.symbol))
      .filter((info): info is DeclarationInfo => info !== undefined && info.declaration.name === site.name)
      .map((info) => ({ member: info, confidence: 'AMBIGUOUS' as const }));
  }

  /**
   * Implementations of a protocol requirement. A receiver bound to a concrete
   * type was resolved before; here the receiver is the protocol itself or a
   * generic parameter. A DI binding of the protocol picks its implementation.
   */
  dispatch(
    requirement: DeclarationInfo,
    protocol: TypeInfo,
    receiver: Ty | undefined,
  ): { target: DeclarationInfo; via: CallTarget['via']; injection?: Injection }[] {
    const declaration = requirement.declaration;
    const implementations: { target: DeclarationInfo; owner: TypeInfo }[] = [];
    for (const type of this.index.conformers(protocol)) {
      if (type.kind === 'protocol') continue;
      const members = this.index
        .members(type, declaration.name, declaration.selector, (member) => member.declaration.kind === declaration.kind)
        .filter((member) => member.owner.kind !== 'protocol' || member.fromExtension);
      for (const member of members) {
        const info = this.infoOf(member);
        if (info && !implementations.some((entry) => entry.target === info)) implementations.push({ target: info, owner: type });
      }
    }
    const generic = receiver?.generic !== undefined;
    const bindings = this.injectionsOf(protocol);
    if (!generic && bindings.length > 0) {
      const chosen = implementations.filter((entry) =>
        bindings.some((binding) => this.index.isSubtype(entry.owner, binding.implementation)),
      );
      if (chosen.length > 0)
        return chosen.map((entry) => ({
          target: entry.target,
          via: 'di',
          injection: bindings.find((binding) => this.index.isSubtype(entry.owner, binding.implementation)),
        }));
    }
    if (implementations.length === 1) return [{ target: implementations[0]!.target, via: generic ? 'generic' : 'unique' }];
    return implementations.map((entry) => ({ target: entry.target, via: generic ? 'generic' : 'all' }));
  }

  /** Generic parameters of a callee bound from the types of the arguments. */
  bindGenerics(callee: DeclarationInfo, site: CallSite, frame: Frame): Map<string, Ty> {
    const bound = new Map<string, Ty>();
    const declaration = callee.declaration;
    const generics = new Set(declaration.genericParameters ?? []);
    if (generics.size === 0) return bound;
    const mapping = mapArguments(declaration.parameters ?? [], site);
    for (const [parameterIndex, argumentIndex] of mapping) {
      const parameter = declaration.parameters![parameterIndex]!;
      const name = baseTypeName(parameter.type);
      if (!generics.has(name)) continue;
      const type = unwrap(this.typeOf(site.arguments[argumentIndex]!.value, frame));
      if (type && !type.generic) bound.set(name, { ...type, optional: undefined });
      else if (type?.generic) bound.set(name, type);
    }
    return bound;
  }

  /** DI bindings by service protocol, from the `injection` rules. */
  injectionsOf(service: TypeInfo): Injection[] {
    if (!this.injections) {
      this.injections = new Map();
      for (const rule of this.rules.injection) {
        const pattern = parseCallPattern(rule.register);
        for (const [position, file] of this.index.files.entries()) {
          if (rule.imports && !file.facts.imports.some((name) => name.split('.')[0] === rule.imports)) continue;
          void position;
          const context = this.context(file.path);
          if (!context) continue;
          for (const [callIndex, site] of context.facts.flow.calls.entries()) {
            if (site.name !== pattern.name) continue;
            const info = this.declarationFrom(context, site.from);
            const frame = info ? this.frameOf(info) : { file: context, bound: new Map() };
            if (!frame) continue;
            const aligned = this.matchCall(pattern, site, frame);
            if (!aligned) continue;
            const labels = site.arguments.map((argument) => argument.label);
            const serviceValue = site.arguments[argumentIndex(rule.service, aligned, labels)]?.value;
            const factory = site.arguments[argumentIndex(rule.factory, aligned, labels)]?.value;
            const serviceType = serviceValue ? this.typeOf(serviceValue, frame)?.info : undefined;
            if (!serviceType || factory?.kind !== 'closure') continue;
            for (const returned of context.facts.flow.closures[factory.closure]?.returns ?? []) {
              const implementation = unwrap(this.typeOf(returned, frame))?.info;
              if (!implementation) continue;
              const list = this.injections.get(serviceType) ?? [];
              list.push({
                service: serviceType,
                implementation,
                rule: rule.id ?? rule.origin,
                at: { file: context.path, line: site.line },
              });
              this.injections.set(serviceType, list);
            }
            void callIndex;
          }
        }
      }
    }
    return this.injections.get(service) ?? [];
  }

  infoOf(member: MemberInfo): DeclarationInfo | undefined {
    return this.declarationById.get(member.id);
  }

  parameterNamed(frame: Frame, name: string): { parameter: Parameter; position: number } | undefined {
    const parameters = frame.info?.declaration.parameters ?? [];
    const position = parameters.findIndex((parameter) => parameter.name === name);
    return position >= 0 ? { parameter: parameters[position]!, position } : undefined;
  }

  findBinding(name: string, scope: number, frame: Frame, exclude: ReadonlySet<object>) {
    const from = frame.info?.declaration.localId ?? null;
    const candidates = frame.file.facts.flow.bindings.filter(
      (binding) => binding.name === name && binding.scope === scope && binding.from === from && !exclude.has(binding),
    );
    return candidates.at(-1);
  }

  /** Languages of the module, for missing translations. */
  languages(module: string): string[] {
    let languages = this.languageMemo.get(module);
    if (!languages) this.languageMemo.set(module, (languages = this.graph.languages(module)));
    return languages;
  }

  /** A localized string by key, with its translations and the languages that miss it. Undefined when the module has no tables. */
  localizationOrigin(key: string, module: string, at: Location, tableName?: string): Traced | undefined {
    const payload = this.index.graph.localization;
    const tables = [...payload.tables.values()].filter((table) => table.module === module);
    if (tables.length === 0) return undefined;
    const table = tables.find((candidate) => candidate.name === (tableName ?? 'Localizable')) ?? tables[0]!;
    const record = table.strings.get(key);
    const translated = new Map<string, string | null>();
    for (const translation of record?.translations ?? []) {
      if (translation.variationPath === '' || !translated.has(translation.language))
        translated.set(translation.language, translation.value);
    }
    const missing = this.languages(module).filter((language) => !translated.has(language));
    return {
      origin: {
        kind: 'localization',
        table: table.name,
        key,
        missing,
        values: [...translated.entries()].map(([language, value]) => ({ language, value })),
        at,
      },
      fields: [],
      steps: [],
      warnings: [],
      type: { text: 'String', args: [] },
    };
  }

  // --- Callers and writers --------------------------------------------------------

  /** Call sites of a declaration (or of the requirements it implements). */
  callersOf(info: DeclarationInfo): { frame: Frame; call: number; requirement?: string }[] {
    const ids = [info.id, ...this.graph.outgoing(info.id, ['IMPLEMENTS', 'OVERRIDES']).map((edge) => edge.symbol)];
    const result: { frame: Frame; call: number; requirement?: string }[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      for (const edge of this.graph.incoming(id, ['CALLS']).filter((edge) => this.isProduction(edge))) {
        const caller = this.declarationById.get(edge.symbol);
        if (!caller) continue;
        const frame = this.frameOf(caller);
        if (!frame) continue;
        for (const evidence of edge.evidence) {
          if (evidence.file !== frame.file.path) continue;
          frame.file.facts.flow.calls.forEach((site, callIndex) => {
            const names = info.declaration.kind === 'initializer' ? ['init', info.enclosing?.name] : [info.declaration.name];
            if (site.line !== evidence.line || !names.includes(site.name)) return;
            if (site.from !== caller.declaration.localId) return;
            const key = `${frame.file.path}:${callIndex}`;
            if (seen.has(key)) return;
            seen.add(key);
            result.push({ frame, call: callIndex, requirement: id === info.id ? undefined : id });
          });
        }
        if (result.length >= CALLER_LIMIT) return result;
      }
    }
    return result;
  }

  /** Every place a property gets its value. */
  writersOf(property: DeclarationInfo): Writer[] {
    const writers: Writer[] = [];
    const name = property.declaration.name;
    const own = this.context(property.file.path);
    if (own) {
      for (const assignment of own.facts.flow.assignments) {
        if (assignment.from !== property.declaration.localId) continue;
        writers.push({
          frame: this.frameOf(property)!,
          value: assignment.value,
          target: assignment.target,
          branch: assignment.branch,
          at: { file: own.path, line: assignment.line },
          kind: 'initial',
        });
      }
    }
    for (const edge of this.graph.incoming(property.id, ['WRITES']).filter((edge) => this.isProduction(edge))) {
      const writer = this.declarationById.get(edge.symbol);
      if (!writer) continue;
      const frame = this.frameOf(writer);
      if (!frame) continue;
      const lines = new Set(edge.evidence.filter((evidence) => evidence.file === frame.file.path).map((evidence) => evidence.line));
      for (const assignment of frame.file.facts.flow.assignments) {
        if (assignment.from !== writer.declaration.localId || !lines.has(assignment.line)) continue;
        if (assignment.target.kind !== 'path' || assignment.target.members.at(-1) !== name) continue;
        writers.push({
          frame,
          value: assignment.value,
          target: assignment.target,
          branch: assignment.branch,
          at: { file: frame.file.path, line: assignment.line },
          kind: 'assign',
        });
      }
    }
    // Memberwise initializer of a struct without its own initializers.
    const owner = property.enclosing;
    if (owner?.kind === 'struct' && !owner.members.has('init') && property.declaration.inferredType === undefined) {
      for (const edge of this.graph.incoming(owner.id, ['INSTANTIATES']).filter((edge) => this.isProduction(edge))) {
        const caller = this.declarationById.get(edge.symbol);
        const frame = caller ? this.frameOf(caller) : undefined;
        if (!frame) continue;
        const lines = new Set(edge.evidence.filter((evidence) => evidence.file === frame.file.path).map((evidence) => evidence.line));
        for (const site of frame.file.facts.flow.calls) {
          if (site.name !== owner.name || site.receiver || !lines.has(site.line) || site.from !== caller!.declaration.localId) continue;
          const argument = site.arguments.find((candidate) => candidate.label === name);
          if (!argument) continue;
          writers.push({
            frame,
            value: argument.value,
            target: { kind: 'path', root: { kind: 'self' }, members: [name] },
            branch: site.branch,
            at: { file: frame.file.path, line: site.line },
            kind: 'init',
          });
        }
      }
    }
    return writers;
  }

  /**
   * Whether an edge comes from app code, not from tests or documentation
   * snippets: their calls and writes are not what a screen shows.
   */
  isProduction(edge: { evidence: { file: string }[] }): boolean {
    return edge.evidence.some((evidence) => !TEST_PATH.test(evidence.file));
  }

  /** Declarations other than `except` that read a property. */
  readersOf(property: DeclarationInfo, except: ReadonlySet<string>): { symbol: string; at: Location }[] {
    return this.graph
      .incoming(property.id, ['READS'])
      .filter((edge) => !except.has(edge.symbol))
      .map((edge) => ({ symbol: edge.symbol, at: edge.evidence[0] ?? { file: '', line: 0 } }));
  }

  // --- Tracing ---------------------------------------------------------------------

  /** Where a value comes from. `members` are read from the value afterwards. */
  /** Where a value comes from. `line` locates literals written at a call site. */
  trace(expr: ValueExpr, frame: Frame, members: string[] = [], line?: number): Traced[] {
    return limit(new Tracer(this).trace(expr, frame, members, 0, line));
  }

  traceProperty(property: DeclarationInfo, members: string[] = []): Traced[] {
    return limit(new Tracer(this).property(property, members, 0, undefined));
  }

  render(expr: ValueExpr | undefined, facts: FileFacts, depth = 0): string {
    return renderValue(expr, facts, depth);
  }
}

// --- Tracer ------------------------------------------------------------------------

class Tracer {
  private readonly engine: FlowEngine;
  private readonly active = new Set<string>();
  private readonly excluded = new Set<object>();

  constructor(engine: FlowEngine) {
    this.engine = engine;
  }

  trace(expr: ValueExpr, frame: Frame, members: string[], depth: number, line?: number): Traced[] {
    if (depth > this.engine.depthLimit) return [this.unresolved('depth limit reached', frame, line ?? lineOf(expr, frame))];
    const key = `${frame.file.path}|${frame.info?.id ?? ''}|${JSON.stringify(expr)}|${members.join('.')}|${[...frame.bound.entries()].map(([name, type]) => `${name}=${type.text}`).join(',')}|${this.excluded.size}`;
    if (this.active.has(key)) return [];
    this.active.add(key);
    try {
      return limit(this.traceValue(expr, frame, members, depth, line));
    } finally {
      this.active.delete(key);
    }
  }

  private traceValue(expr: ValueExpr, frame: Frame, members: string[], depth: number, hint: number | undefined): Traced[] {
    const engine = this.engine;
    const line = hint ?? lineOf(expr, frame);
    switch (expr.kind) {
      case 'literal':
        return [
          this.finish(
            {
              origin: { kind: 'literal', type: expr.type, value: expr.value, at: engine.location(frame, line) },
              fields: [],
              steps: [],
              warnings: [],
            },
            members,
            frame,
            expr.type === 'nil' ? undefined : { text: expr.type, args: [] },
          ),
        ];
      case 'case':
        return [
          this.finish(
            { origin: { kind: 'case', name: expr.name, at: engine.location(frame, line) }, fields: [], steps: [], warnings: [] },
            members,
            frame,
            undefined,
          ),
        ];
      case 'closure':
        return [this.unresolved('closure value', frame, line)];
      case 'compound':
        return this.compound(expr, frame, members, depth, line);
      case 'call':
        return this.call(expr.call, frame, members, depth);
      case 'path': {
        const path = projected([...expr.members, ...members]);
        const root = expr.root;
        if (root.kind === 'self') return this.selfMembers(frame, path, depth, line);
        if (root.kind === 'type') return this.typeMembers(root.name, frame, path, depth, line);
        if (root.kind === 'call') return this.call(root.call, frame, path, depth);
        return this.local(root.name, root.scope, frame, path, depth, line);
      }
    }
  }

  private compound(expr: Extract<ValueExpr, { kind: 'compound' }>, frame: Frame, members: string[], depth: number, line: number): Traced[] {
    const engine = this.engine;
    if (isCatch(expr.text)) {
      // The error of the calls marked `try` in the `do` body, with the sources those calls read.
      const sources: Traced[] = [];
      for (const operand of expr.operands) {
        for (const traced of this.trace(operand, frame, [], depth + 1, line)) {
          if (traced.origin.kind === 'source' && !sources.some((known) => JSON.stringify(known.origin) === JSON.stringify(traced.origin))) {
            sources.push({ ...traced, fields: [], jsonKey: undefined, jsonPath: undefined });
          }
        }
      }
      const caught = /\sas\s+([\w.]+)$/.exec(expr.text)?.[1];
      const origin: Origin = {
        kind: 'error',
        thrownBy: expr.operands.map((operand) => engine.render(operand, frame.file.facts)),
        sources,
        at: engine.location(frame, line),
      };
      if (caught) origin.type = caught;
      return [this.finish({ origin, fields: [], steps: [], warnings: [] }, members, frame, engine.typeOf(expr, frame))];
    }
    const cast = castOf(expr);
    if (cast && expr.operands[0]) {
      const target = engine.resolveType(cast.type, frame);
      const results = this.trace(expr.operands[0], frame, [], depth, line);
      return results.map((result) => {
        const traced: Traced = { ...result, steps: [...result.steps], warnings: [...result.warnings] };
        const from = result.type;
        const fails = from !== undefined && cast.operator !== '' && castAlwaysFails(engine, from, target);
        traced.steps.push({
          kind: 'cast',
          text: `${expr.text}`,
          at: engine.location(frame, line),
          note: `${from ? tyText(from) : '?'} → ${tyText(target)}`,
        });
        if (fails) {
          traced.warnings.push(`cast ${tyText(from!)} → ${tyText(target)} always fails (${frame.file.path.split('/').at(-1)}:${line})`);
          traced.failingCast = true;
        }
        traced.type = target;
        return this.applyMembers(traced, members, frame);
      });
    }
    const results: Traced[] = [];
    for (const operand of expr.operands) {
      for (const result of this.trace(operand, frame, members, depth, line)) {
        results.push({ ...result, steps: [...result.steps, { kind: 'compound', text: expr.text, at: engine.location(frame, line) }] });
      }
    }
    return results;
  }

  private selfMembers(frame: Frame, path: string[], depth: number, line: number): Traced[] {
    const engine = this.engine;
    if (path.length === 0 || !frame.self) return [this.unresolved('self', frame, line)];
    const property = engine.index.property(frame.self, path[0]!);
    if (property) {
      const info = engine.infoOf(property);
      if (info) return this.property(info, path.slice(1), depth + 1, frame);
    }
    // A method value or an unknown member.
    return [this.unresolved(`member ${path[0]} of ${frame.self.name}`, frame, line)];
  }

  private typeMembers(name: string, frame: Frame, path: string[], depth: number, line: number): Traced[] {
    const engine = this.engine;
    const type = engine.resolveType(name, frame);
    if (path.length === 0 || !type.info) {
      if (path[0] && !type.info)
        return [
          this.finish(
            { origin: { kind: 'case', name: path[0], type: name, at: engine.location(frame, line) }, fields: [], steps: [], warnings: [] },
            path.slice(1),
            frame,
            undefined,
          ),
        ];
      return [this.unresolved(`type ${name}`, frame, line)];
    }
    const property = engine.index.property(type.info, path[0]!);
    if (property) {
      const info = engine.infoOf(property);
      if (info) return this.property(info, path.slice(1), depth + 1, frame);
    }
    const cases = type.info.members.get(path[0]!)?.find((member) => member.declaration.kind === 'enum_case');
    if (cases)
      return [
        this.finish(
          {
            origin: { kind: 'case', name: path[0]!, type: type.info.name, at: engine.location(frame, line) },
            fields: [],
            steps: [],
            warnings: [],
          },
          path.slice(1),
          frame,
          this.engine.tyOfInfo(type.info),
        ),
      ];
    return [this.unresolved(`member ${path[0]} of ${name}`, frame, line)];
  }

  /** Values of a property: descend into a stored property of its type when the path continues. */
  property(info: DeclarationInfo, path: string[], depth: number, from: Frame | undefined): Traced[] {
    const engine = this.engine;
    const owner = info.enclosing;
    // A SwiftUI view's own input (`let row: ProductRowViewData`) is followed to the values passed in, so the
    // path keeps the view-model variable; other properties stand for every instance of their type.
    const viewInput =
      owner !== undefined &&
      owner.kind === 'struct' &&
      engine.index.externalNames(owner).includes('View') &&
      !info.declaration.attributes.some((attribute) =>
        ['StateObject', 'ObservedObject', 'EnvironmentObject', 'State'].includes(attribute),
      ) &&
      !info.declaration.isComputed;
    if (path.length > 0 && path[0] !== '[]' && owner && !viewInput) {
      const type = this.propertyTy(info);
      const nextOwner = unwrap(type)?.info;
      const next = nextOwner ? engine.index.property(nextOwner, path[0]!) : undefined;
      const nextInfo = next ? engine.infoOf(next) : undefined;
      if (nextInfo) return this.property(nextInfo, path.slice(1), depth + 1, from);
    }
    const key = `property:${info.id}:${path.join('.')}`;
    if (this.active.has(key)) return [];
    this.active.add(key);
    try {
      const step: Step = {
        kind: 'property',
        text: `${engine.symbolName(info)}${info.declaration.type ? `: ${info.declaration.type}` : ''}`,
        symbol: engine.symbolName(info),
        layer: engine.layerOf(owner),
        at: { file: info.file.path, line: info.declaration.range[0] },
      };
      const results: Traced[] = [];
      if (info.declaration.isComputed) {
        const frame = engine.frameOf(info);
        const returns = frame ? frame.file.facts.flow.returns.filter((item) => item.from === info.declaration.localId) : [];
        for (const item of returns)
          results.push(...this.trace(item.value, frame!, path, depth + 1).map((result) => withStep(result, step)));
        if (results.length > 0) return results;
      }
      const sourceRule = engine.rules.sources.find((rule) => rule.attribute && info.declaration.attributes.includes(rule.attribute));
      if (sourceRule) {
        results.push(
          this.finish(
            {
              origin: {
                kind: 'source',
                source: sourceRule.kind,
                rule: sourceRule.id ?? sourceRule.origin,
                call: `@${sourceRule.attribute}`,
                api: `@${sourceRule.attribute}`,
                type: this.propertyTy(info),
                at: step.at,
              },
              fields: [],
              steps: [step],
              warnings: [],
            },
            path,
            engine.frameOf(info)!,
            this.propertyTy(info),
          ),
        );
      }
      for (const writer of engine.writersOf(info)) {
        const writeStep: Step = {
          kind: 'write',
          text: `${engine.symbolName(info)} = ${engine.render(writer.value, writer.frame.file.facts)}`,
          symbol: engine.symbolName(writer.frame.info),
          layer: engine.layerOf(writer.frame.self),
          at: writer.at,
          note: writer.branch.length > 0 ? `when ${writer.branch.join(' && ')}` : undefined,
        };
        for (const result of this.trace(writer.value, writer.frame, path, depth + 1)) {
          results.push(withStep(withStep(result, writeStep), step));
        }
      }
      if (results.length === 0) {
        const type = this.propertyTy(info);
        results.push({
          origin: { kind: 'unresolved', reason: `${engine.symbolName(info)} is never written`, at: step.at },
          fields: path,
          type,
          steps: [step],
          warnings: [],
        });
      }
      return results;
    } finally {
      this.active.delete(key);
    }
  }

  private propertyTy(info: DeclarationInfo): Ty | undefined {
    const owner = info.enclosing;
    if (!owner) return undefined;
    const member = owner.members.get(info.declaration.name)?.find((candidate) => candidate.id === info.id);
    return member ? this.engine.propertyType(member) : undefined;
  }

  private local(name: string, scope: number, frame: Frame, path: string[], depth: number, line: number): Traced[] {
    const engine = this.engine;
    const binding = engine.findBinding(name, scope, frame, this.excluded);
    if (binding) {
      this.excluded.add(binding);
      try {
        const step: Step = {
          kind: 'binding',
          text: `${name} = ${engine.render(binding.value, frame.file.facts)}`,
          symbol: engine.symbolName(frame.info),
          at: engine.location(frame, binding.line),
        };
        return this.trace(binding.value, frame, path, depth, binding.line).map((result) => withStep(result, step));
      } finally {
        this.excluded.delete(binding);
      }
    }
    const closures = frame.file.facts.flow.closures;
    const closure = closures.findIndex((candidate) => candidate.scope === scope && candidate.parameters.includes(name));
    if (closure >= 0) return this.closureParameter(closure, closures[closure]!.parameters.indexOf(name), frame, path, depth);
    const parameter = engine.parameterNamed(frame, name);
    if (parameter) return this.parameter(frame, parameter.position, path, depth);
    return [this.unresolved(`local ${name}`, frame, line)];
  }

  private parameter(frame: Frame, position: number, path: string[], depth: number): Traced[] {
    const engine = this.engine;
    const info = frame.info!;
    const parameter = info.declaration.parameters![position]!;
    const step: Step = {
      kind: 'param',
      text: `${parameter.name}: ${parameter.type}`,
      symbol: engine.symbolName(info),
      layer: engine.layerOf(frame.self),
      at: { file: frame.file.path, line: info.declaration.range[0] },
    };
    const callers = frame.caller
      ? [{ frame: frame.caller.frame, call: frame.caller.call, requirement: undefined as string | undefined }]
      : engine.callersOf(info);
    const results: Traced[] = [];
    for (const caller of callers) {
      const site = caller.frame.file.facts.flow.calls[caller.call]!;
      const mapping = mapArguments(info.declaration.parameters ?? [], site);
      const argument = mapping.get(position);
      if (argument === undefined) continue;
      let callerFrame = caller.frame;
      // Reached through a requirement on a generic receiver: bind the receiver's generic to this implementation.
      if (!frame.caller && caller.requirement && site.receiver && frame.self) {
        const receiver = unwrap(engine.typeOf(site.receiver, caller.frame));
        if (receiver?.generic) {
          if (!receiver.generic.constraints.every((constraint) => engine.index.isSubtype(frame.self!, constraint))) continue;
          if (!this.feasible(caller.frame, receiver.generic.name, frame.self)) continue;
          callerFrame = { ...caller.frame, bound: new Map([...caller.frame.bound, [receiver.generic.name, engine.tyOfInfo(frame.self)]]) };
        }
      }
      const callStep: Step = {
        kind: 'call',
        text: engine.render({ kind: 'call', call: caller.call }, caller.frame.file.facts),
        symbol: engine.symbolName(caller.frame.info),
        layer: engine.layerOf(caller.frame.self),
        at: { file: caller.frame.file.path, line: site.line },
        async: this.isAsync(caller.frame, site),
      };
      for (const result of this.trace(site.arguments[argument]!.value, callerFrame, path, depth + 1)) {
        results.push(withStep(withStep(result, callStep), step));
      }
    }
    if (results.length === 0)
      results.push({
        origin: { kind: 'unresolved', reason: `no caller of ${engine.symbolName(info)} found`, at: step.at },
        fields: path,
        steps: [step],
        warnings: [],
      });
    return results;
  }

  /**
   * Whether a function generic over `name` can be called with `type`: false
   * when every caller passes a known type that is not `type`.
   */
  private feasible(frame: Frame, name: string, type: TypeInfo): boolean {
    const engine = this.engine;
    const info = frame.info;
    if (!info) return true;
    const positions = (info.declaration.parameters ?? [])
      .map((parameter, at) => (baseTypeName(parameter.type) === name ? at : -1))
      .filter((at) => at >= 0);
    if (positions.length === 0) return true;
    const callers = engine.callersOf(info);
    if (callers.length === 0) return true;
    return callers.some((caller) => {
      const site = caller.frame.file.facts.flow.calls[caller.call]!;
      const mapping = mapArguments(info.declaration.parameters ?? [], site);
      return positions.some((position) => {
        const argument = mapping.get(position);
        if (argument === undefined) return true;
        const passed = unwrap(engine.typeOf(site.arguments[argument]!.value, caller.frame));
        return !passed?.info || engine.index.isSubtype(passed.info, type) || engine.index.isSubtype(type, passed.info);
      });
    });
  }

  private closureParameter(closure: number, position: number, frame: Frame, path: string[], depth: number): Traced[] {
    const engine = this.engine;
    const fact = frame.file.facts.flow.closures[closure]!;
    if (fact.call === null) return [this.unresolved(`parameter ${fact.parameters[position]} of a closure`, frame, 0)];
    const site = frame.file.facts.flow.calls[fact.call]!;
    const source = engine.sourceRule(site, frame);
    if (source?.rule.yields?.startsWith('closure:')) return this.sourceOrigin(source.rule, source.aligned, fact.call, frame, path, depth);
    const flow = engine.flowRule(site, frame);
    const spec = flow ? closureSpec(flow, site, closure) : undefined;
    const parameterSpec = spec?.parameters?.[position];
    const step: Step = {
      kind: 'closure',
      text: `${site.name} { ${fact.parameters[position]} in … }`,
      symbol: engine.symbolName(frame.info),
      layer: engine.layerOf(frame.self),
      at: engine.location(frame, site.line),
      async: spec?.async,
      note: spec?.on,
    };
    if (parameterSpec) {
      const { base, element } = parseSpec(parameterSpec);
      const value = specValue(base, site, frame);
      if (value && value.kind !== 'closure') {
        return this.trace(value, frame, element ? ['[]', ...path] : path, depth + 1).map((result) => withStep(result, step));
      }
    }
    // A closure passed to a function of the repository: values it is called with.
    const results: Traced[] = [];
    for (const target of engine.callTargets(fact.call, frame)) {
      const declaration = target.target.declaration;
      const mapping = mapArguments(declaration.parameters ?? [], site);
      const argument = site.arguments.findIndex((candidate) => candidate.value.kind === 'closure' && candidate.value.closure === closure);
      const parameterIndex = [...mapping.entries()].find(([, at]) => at === argument)?.[0];
      if (parameterIndex === undefined) continue;
      const name = declaration.parameters![parameterIndex]!.name;
      const callee = engine.enter(target.target, target.bound, { frame, call: fact.call });
      if (!callee) continue;
      for (const inner of callee.file.facts.flow.calls) {
        if (inner.from !== declaration.localId || inner.receiver || inner.name !== name) continue;
        const value = inner.arguments[position]?.value;
        if (!value) continue;
        const innerStep: Step = {
          kind: 'call',
          text: `${name}(${engine.render(value, callee.file.facts)})`,
          symbol: engine.symbolName(target.target),
          layer: engine.layerOf(callee.self),
          at: engine.location(callee, inner.line),
        };
        for (const result of this.trace(value, callee, path, depth + 1)) results.push(withStep(withStep(result, innerStep), step));
      }
    }
    if (results.length > 0) return results;
    return [
      {
        ...this.unresolved(`parameter ${fact.parameters[position]} of the closure passed to ${site.name}`, frame, site.line),
        fields: path,
      },
    ];
  }

  private call(call: number, frame: Frame, members: string[], depth: number): Traced[] {
    const engine = this.engine;
    const site = frame.file.facts.flow.calls[call]!;
    const source = engine.sourceRule(site, frame);
    if (source && source.rule.direction !== 'write' && !source.rule.yields?.startsWith('closure:')) {
      return this.sourceOrigin(source.rule, source.aligned, call, frame, members, depth);
    }
    const flow = engine.flowRule(site, frame);
    if (flow) {
      const element = members[0] === '[]';
      // A whole collection made by `map` comes from the collection it maps.
      const specs =
        element && flow.rule.elements
          ? asList(flow.rule.elements)
          : flow.rule.result
            ? asList(flow.rule.result)
            : flow.rule.derivedFrom
              ? asList(flow.rule.derivedFrom)
              : [];
      const rest = element && flow.rule.elements ? members.slice(1) : members;
      if (specs.length > 0) {
        const step: Step = {
          kind: 'call',
          text: `.${site.name}`,
          symbol: engine.symbolName(frame.info),
          layer: engine.layerOf(frame.self),
          at: engine.location(frame, site.line),
        };
        const results: Traced[] = [];
        for (const spec of specs) {
          const parsed = parseSpec(spec);
          const value = specValue(parsed.base, site, frame);
          if (!value) continue;
          const next = parsed.element ? ['[]', ...rest] : rest;
          if (value.kind === 'closure') {
            for (const returned of frame.file.facts.flow.closures[value.closure]?.returns ?? []) {
              results.push(...this.trace(returned, frame, next, depth, site.line).map((result) => withStep(result, step)));
            }
          } else {
            results.push(...this.trace(value, frame, next, depth, site.line).map((result) => withStep(result, step)));
          }
        }
        return results;
      }
    }
    const text = engine.render({ kind: 'call', call }, frame.file.facts);
    if (!site.receiver && isTypeName(site.name)) {
      const type = engine.resolveType(site.name, frame);
      if (type.info) return this.instance(type.info, call, frame, members, depth);
      if (site.arguments.length === 0) {
        // `Date()`, `UUID()`: a new value of an SDK type.
        const at = engine.location(frame, site.line);
        return [
          this.finish(
            { origin: { kind: 'instance', type: type.text, call: text, at }, fields: [], steps: [], warnings: [] },
            members,
            frame,
            type,
          ),
        ];
      }
    }
    const results: Traced[] = [];
    for (const target of engine.callTargets(call, frame)) {
      const declaration = target.target.declaration;
      const callee = engine.enter(target.target, target.bound, { frame, call });
      if (!callee) continue;
      const via = target.requirement
        ? target.via === 'di' && target.injection
          ? `DI: ${target.injection.service.name} → ${target.injection.implementation.name} ${where(target.injection.at)}`
          : `${target.via}: ${engine.symbolName(target.requirement)} → ${engine.symbolName(target.target)}`
        : undefined;
      const step: Step = {
        kind: 'return',
        text: `${engine.symbolName(target.target)}`,
        symbol: engine.symbolName(target.target),
        layer: engine.layerOf(callee.self),
        at: { file: callee.file.path, line: declaration.range[0] },
        note:
          [via, ...[...target.bound.entries()].map(([name, type]) => `${name} = ${tyText(type)}`)].filter(Boolean).join('; ') || undefined,
        async: this.isAsync(frame, site),
      };
      const returns = callee.file.facts.flow.returns.filter((item) => item.from === declaration.localId);
      for (const item of returns) {
        for (const result of this.trace(item.value, callee, members, depth + 1)) results.push(withStep(result, step));
      }
    }
    if (results.length > 0) return results;
    if (engine.callTargets(call, frame).length === 0) {
      const values = [
        ...(site.receiver && !(site.receiver.kind === 'path' && site.receiver.root.kind === 'type') ? [site.receiver] : []),
        ...site.arguments.map((argument) => argument.value).filter((value) => value.kind !== 'closure' && value.kind !== 'case'),
      ].filter((value) => value.kind !== 'literal');
      const inputs = values.flatMap((value) => this.trace(value, frame, [], depth + 1, site.line));
      if (inputs.length > 0) {
        return [
          {
            origin: { kind: 'derived', call: text, inputs, at: engine.location(frame, site.line) },
            fields: members,
            steps: [],
            warnings: [],
          },
        ];
      }
    }
    return [{ ...this.unresolved(`result of ${text}`, frame, site.line), fields: members }];
  }

  /** A value created by an initializer: a field read from it is the argument (or the value) the initializer stored. */
  private instance(type: TypeInfo, call: number, frame: Frame, members: string[], depth: number): Traced[] {
    const engine = this.engine;
    const site = frame.file.facts.flow.calls[call]!;
    const text = engine.render({ kind: 'call', call }, frame.file.facts);
    const at = engine.location(frame, site.line);
    if (members.length === 0 || members[0] === '[]') {
      return [
        this.finish(
          { origin: { kind: 'instance', type: type.path, call: text, at }, fields: [], steps: [], warnings: [] },
          members,
          frame,
          engine.tyOfInfo(type),
        ),
      ];
    }
    const field = members[0]!;
    const step: Step = { kind: 'call', text, symbol: engine.symbolName(frame.info), layer: engine.layerOf(frame.self), at };
    const property = engine.index.property(type, field);
    const propertyInfo = property ? engine.infoOf(property) : undefined;
    const results: Traced[] = [];
    const initializers = engine.callTargets(call, frame);
    for (const target of initializers) {
      const callee = engine.enter(target.target, target.bound, { frame, call }, type);
      if (!callee) continue;
      for (const assignment of callee.file.facts.flow.assignments) {
        if (assignment.from !== target.target.declaration.localId) continue;
        if (assignment.target.kind !== 'path' || assignment.target.members.at(-1) !== field) continue;
        if (assignment.target.root.kind !== 'self' && assignment.target.root.kind !== 'local') continue;
        for (const result of this.trace(assignment.value, callee, members.slice(1), depth + 1)) results.push(withStep(result, step));
      }
    }
    if (initializers.length === 0) {
      // Memberwise initializer.
      const argument = site.arguments.find((candidate) => candidate.label === field);
      if (argument)
        for (const result of this.trace(argument.value, frame, members.slice(1), depth + 1)) results.push(withStep(result, step));
    }
    if (results.length > 0) return results;
    if (propertyInfo) return this.property(propertyInfo, members.slice(1), depth + 1, frame);
    return [{ ...this.unresolved(`${field} of ${text}`, frame, site.line), fields: members }];
  }

  private sourceOrigin(
    rule: Loaded<SourceRule>,
    aligned: string[],
    call: number,
    frame: Frame,
    members: string[],
    depth: number,
  ): Traced[] {
    const engine = this.engine;
    const site = frame.file.facts.flow.calls[call]!;
    const labels = site.arguments.map((argument) => argument.label);
    const argumentValue = (reference: string | number | undefined) =>
      reference === undefined ? undefined : site.arguments[argumentIndex(reference, aligned, labels)]?.value;
    let rest = [...members];
    if (rule.yields === 'elements' && rest[0] === '[]') rest = rest.slice(1);
    while (rest.length > 0 && rule.unwrap?.includes(rest[0]!)) rest = rest.slice(1);
    const keyValue = argumentValue(rule.key);
    const inputValue = argumentValue(rule.input);
    if (rule.kind === 'localization' && keyValue?.kind === 'literal') {
      const localized = engine.localizationOrigin(keyValue.value, frame.file.module, engine.location(frame, site.line));
      if (localized) return [this.applyMembers(localized, rest, frame)];
    }
    const origin: Extract<Origin, { kind: 'source' }> = {
      kind: 'source',
      source: rule.kind,
      rule: rule.id ?? rule.origin,
      call: engine.render({ kind: 'call', call }, frame.file.facts),
      api: apiName(rule.call!),
      at: engine.location(frame, site.line),
    };
    const type = engine.typeOfCall(call, frame);
    if (type) origin.type = type;
    if (keyValue) origin.key = this.keyText(keyValue, frame);
    if (rule.direction) origin.direction = rule.direction;
    if (rule.endpoint) {
      const endpoint = this.endpoint(rule.endpoint, site, frame);
      if (endpoint) Object.assign(origin, endpoint);
    }
    if (inputValue) {
      origin.input = this.trace(inputValue, frame, [], 0, site.line);
      // Data decoded from a file or a store is that kind of data.
      const stored = origin.input.find((input) => input.origin.kind === 'source' && input.origin.source !== origin.source);
      if (stored?.origin.kind === 'source') origin.source = stored.origin.source;
    }
    const traced: Traced = { origin, fields: [], steps: [], warnings: [] };
    if (origin.input?.some((input) => input.warnings.length > 0))
      traced.warnings.push(...new Set(origin.input.flatMap((input) => input.warnings)));
    const literal = origin.input?.find((input) => input.origin.kind === 'literal');
    if (literal && literal.origin.kind === 'literal' && rule.id === 'foundation.json-decode' && !isJson(literal.origin.value)) {
      traced.warnings.push(`input is not valid JSON (${literal.origin.at.file.split('/').at(-1)}:${literal.origin.at.line})`);
    }
    return [this.finish(traced, rest, frame, type)];
  }

  /** A key, path or table name: its literal value when one is found, else the expression. */
  private keyText(value: ValueExpr, frame: Frame): string {
    if (value.kind === 'literal') return value.value;
    const traced = this.trace(value, frame, [], 0);
    const literal = traced.find((result) => result.origin.kind === 'literal');
    if (literal?.origin.kind === 'literal') return literal.origin.value;
    const unresolved = traced.find((result) => result.origin.kind === 'unresolved');
    const derived = traced.find((result) => result.origin.kind === 'derived');
    if (derived?.origin.kind === 'derived') return derived.origin.call;
    if (unresolved?.origin.kind === 'unresolved' && unresolved.origin.reason.startsWith('result of '))
      return unresolved.origin.reason.slice(10);
    return this.engine.render(value, frame.file.facts);
  }

  private endpoint(
    spec: NonNullable<SourceRule['endpoint']>,
    site: CallSite,
    frame: Frame,
  ): { endpoint?: string; method?: string } | undefined {
    const engine = this.engine;
    const pattern = parseCallPattern(spec.call);
    for (let current: ValueExpr | undefined = site.receiver; current;) {
      const callIndex =
        current.kind === 'call' ? current.call : current.kind === 'path' && current.root.kind === 'call' ? current.root.call : undefined;
      if (callIndex === undefined) return undefined;
      const inner = frame.file.facts.flow.calls[callIndex]!;
      const aligned = engine.matchCall(pattern, inner, frame);
      if (aligned) {
        const labels = inner.arguments.map((argument) => argument.label);
        const value = inner.arguments[argumentIndex(spec.argument, aligned, labels)]?.value;
        const method = spec.method === undefined ? undefined : inner.arguments[argumentIndex(spec.method, aligned, labels)]?.value;
        const describe = (expr: ValueExpr | undefined) => {
          if (!expr) return undefined;
          if (expr.kind === 'literal') return expr.value;
          const traced = this.trace(expr, frame, [], 0).find((result) => result.origin.kind === 'literal');
          return traced?.origin.kind === 'literal' ? traced.origin.value : engine.render(expr, frame.file.facts);
        };
        return {
          endpoint: describe(value),
          method: method?.kind === 'case' ? method.name.toUpperCase() : (describe(method) ?? spec.defaultMethod),
        };
      }
      current = inner.receiver;
    }
    return undefined;
  }

  /** Reads `members` from a traced value: field types, JSON keys, element rules. */
  private finish(traced: Traced, members: string[], frame: Frame, type: Ty | undefined): Traced {
    traced.type = type;
    return this.applyMembers(traced, members, frame);
  }

  private applyMembers(traced: Traced, members: string[], frame: Frame): Traced {
    const engine = this.engine;
    let type = traced.type;
    const fields = [...traced.fields];
    let jsonKey = traced.jsonKey;
    const jsonPath = [...(traced.jsonPath ?? [])];
    for (const member of members) {
      if (member !== '[]' && engine.memberRule(member) && !(unwrap(type)?.info && engine.index.property(unwrap(type)!.info!, member))) {
        fields.push('[]');
        jsonPath.push('[]');
        type = engine.elementType(unwrap(type));
        continue;
      }
      const owner = unwrap(type)?.info;
      fields.push(member);
      jsonKey = owner && member !== '[]' ? this.jsonKeyOf(owner, member, traced) : jsonKey;
      jsonPath.push(member === '[]' ? '[]' : ((owner ? this.jsonKeyOf(owner, member, traced) : undefined) ?? member));
      type = engine.memberType(unwrap(type), member, frame);
    }
    const result: Traced = { ...traced, fields, type, jsonKey };
    if (traced.origin.kind === 'source' && traced.origin.source === 'api' && jsonPath.length > 0) result.jsonPath = jsonPath;
    return result;
  }

  /** Key of a field of a Decodable type: its CodingKeys case, or the name (snake case after `.convertFromSnakeCase`). */
  private jsonKeyOf(owner: TypeInfo, field: string, traced: Traced): string | undefined {
    const engine = this.engine;
    if (traced.origin.kind !== 'source' || traced.origin.source !== 'api') return undefined;
    const codingKeys = owner.members.get('CodingKeys');
    void codingKeys;
    const keysType = engine.associatedType(engine.tyOfInfo(owner), 'CodingKeys')?.info;
    const keyCase = keysType?.members.get(field)?.find((member) => member.declaration.kind === 'enum_case');
    const raw = keyCase?.declaration.signature.match(/=\s*"([^"]*)"/)?.[1];
    if (raw !== undefined) return raw;
    if (keyCase) return field;
    const context = engine.context(traced.origin.at.file);
    const snake = context?.facts.flow.assignments.some(
      (assignment) =>
        assignment.target.kind === 'path' &&
        assignment.target.members.at(-1) === 'keyDecodingStrategy' &&
        assignment.value.kind === 'case' &&
        assignment.value.name === 'convertFromSnakeCase',
    );
    return snake ? field.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`) : field;
  }

  private isAsync(frame: Frame, site: CallSite): boolean | undefined {
    if (site.await) return true;
    for (let closure = site.closure; closure !== null; closure = frame.file.facts.flow.closures[closure]?.parent ?? null) {
      const fact = frame.file.facts.flow.closures[closure]!;
      if (fact.call === null) continue;
      const owner = frame.file.facts.flow.calls[fact.call]!;
      const flow = this.engine.flowRule(owner, frame);
      if (flow && closureSpec(flow, owner, closure)?.async) return true;
    }
    return undefined;
  }

  private unresolved(reason: string, frame: Frame, line: number): Traced {
    return { origin: { kind: 'unresolved', reason, at: this.engine.location(frame, line) }, fields: [], steps: [], warnings: [] };
  }
}

// --- Helpers ---------------------------------------------------------------------------

/** `JSONDecoder.decode(_:from:)` → `JSONDecoder.decode`; `*.serializingDecodable(_:)` → `serializingDecodable`. */
export function apiName(call: string): string {
  const pattern = parseCallPattern(call);
  if (pattern.type && pattern.type !== '*') return `${pattern.type}.${pattern.name}`;
  // `Data(contentsOf:options:)` → `Data(contentsOf:)`: a type constructed with its first label.
  if (isTypeName(pattern.name) && pattern.labels && pattern.labels.length > 0) return `${pattern.name}(${pattern.labels[0]}:)`;
  return pattern.name;
}

/** `$title` followed by an element (what the publisher emits) is the property itself. */
function projected(members: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < members.length; index++) {
    const member = members[index]!;
    if (member.startsWith('$') && members[index + 1] === '[]') {
      result.push(member.slice(1));
      index++;
    } else {
      result.push(member);
    }
  }
  return result;
}

function limit(results: Traced[]): Traced[] {
  return results.length > RESULT_LIMIT ? results.slice(0, RESULT_LIMIT) : results;
}

function withStep(traced: Traced, step: Step): Traced {
  return { ...traced, steps: [...traced.steps, step] };
}

export function tyText(type: Ty): string {
  return type.text + (type.optional && !type.text.endsWith('?') ? '?' : '');
}

function unwrap(type: Ty | undefined): Ty | undefined {
  return type?.optional ? { ...type, optional: undefined } : type;
}

function isCallable(declaration: Declaration): boolean {
  return declaration.kind === 'function' || declaration.kind === 'initializer' || declaration.kind === 'subscript';
}

function isTypeName(name: string): boolean {
  const first = name.replace(/^`/, '')[0];
  return first !== undefined && first !== first.toLowerCase();
}

function isCatch(text: string): boolean {
  return text === 'catch' || text.startsWith('catch ');
}

/** `x as? T`, `x as! T`, `x as T`. */
export function castOf(expr: Extract<ValueExpr, { kind: 'compound' }>): { operator: '?' | '!' | ''; type: string } | undefined {
  const match = /\sas([?!]?)\s+([A-Za-z_][\w.<>, [\]:?]*)$/.exec(expr.text);
  if (!match) return undefined;
  return { operator: match[1] as '?' | '!' | '', type: match[2]!.trim() };
}

/** Both types are known, concrete and unrelated. */
function castAlwaysFails(engine: FlowEngine, from: Ty, to: Ty): boolean {
  if (from.generic || to.generic) return false;
  const a = baseTypeName(from.text);
  const b = baseTypeName(to.text);
  if (a === b) return false;
  if (from.info && to.info)
    return (
      !engine.index.isSubtype(from.info, to.info) &&
      !engine.index.isSubtype(to.info, from.info) &&
      to.info.kind !== 'protocol' &&
      from.info.kind !== 'protocol'
    );
  const concrete = (type: Ty) =>
    type.info
      ? type.info.kind === 'struct' || type.info.kind === 'enum'
      : ['String', 'Int', 'Double', 'Bool', 'Float', 'Data', 'Date', 'URL'].includes(baseTypeName(type.text));
  return concrete(from) && concrete(to);
}

/** Maps parameters of a declaration to the call's arguments (by label, defaults skipped, trailing closures). */
export function mapArguments(parameters: Parameter[], site: CallSite): Map<number, number> {
  const mapping = new Map<number, number>();
  const labels = parameters.map((parameter) => parameter.label);
  const aligned = alignArguments(
    { name: site.name, labels },
    site.arguments.map((argument) => ({ label: argument.label, closure: argument.value.kind === 'closure' })),
  );
  if (!aligned) {
    site.arguments.forEach((_, position) => position < parameters.length && mapping.set(position, position));
    return mapping;
  }
  let from = 0;
  aligned.forEach((label, argument) => {
    const parameter = labels.indexOf(label, from);
    if (parameter >= 0) {
      mapping.set(parameter, argument);
      from = parameter + 1;
    }
  });
  return mapping;
}

function parseSpec(spec: string): { base: string; element: boolean } {
  return spec.endsWith('[]') ? { base: spec.slice(0, -2), element: true } : { base: spec, element: false };
}

function specValue(base: string, site: CallSite, frame: Frame): ValueExpr | undefined {
  void frame;
  if (base === 'receiver') return site.receiver;
  const [kind, reference] = base.split(':') as [string, string | undefined];
  if (reference === undefined) return undefined;
  const labels = site.arguments.map((argument) => argument.label);
  if (kind === 'argument' || kind === 'closure') {
    const position = /^\d+$/.test(reference) ? Number(reference) : reference === 'trailing' ? labels.length - 1 : labels.indexOf(reference);
    return site.arguments[position]?.value;
  }
  return undefined;
}

/** The closure spec of a flowThrough rule that applies to `closure`, an argument of `site`. */
function closureSpec(flow: { rule: FlowThroughRule; aligned: string[] }, site: CallSite, closure: number) {
  const position = site.arguments.findIndex((argument) => argument.value.kind === 'closure' && argument.value.closure === closure);
  if (position < 0 || !flow.rule.closures) return undefined;
  const label = flow.aligned[position];
  const closures = flow.rule.closures;
  const closurePositions = site.arguments.map((argument, at) => (argument.value.kind === 'closure' ? at : -1)).filter((at) => at >= 0);
  return (
    (label !== undefined ? closures[label] : undefined) ??
    closures[String(position)] ??
    (position === site.arguments.length - 1 ? closures.trailing : undefined) ??
    (closurePositions.indexOf(position) === 0 ? closures['0'] : undefined)
  );
}

function lineOf(expr: ValueExpr, frame: Frame): number {
  if (expr.kind === 'call') return frame.file.facts.flow.calls[expr.call]?.line ?? 0;
  if (expr.kind === 'path' && expr.root.kind === 'call') return frame.file.facts.flow.calls[expr.root.call]?.line ?? 0;
  return frame.info?.declaration.range[0] ?? 0;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Source-like text of a value. */
export function renderValue(expr: ValueExpr | undefined, facts: FileFacts, depth = 0): string {
  if (!expr) return '?';
  if (depth > 4) return '…';
  switch (expr.kind) {
    case 'literal':
      return expr.type === 'String' ? JSON.stringify(expr.value) : expr.value;
    case 'case':
      return `.${expr.name}`;
    case 'closure': {
      // A closure of one expression shows it: `map { ProductRowViewData(name: $0.name) }`.
      const returned = facts.flow.closures[expr.closure]?.returns;
      return returned?.length === 1 ? `{ ${renderValue(returned[0], facts, depth + 1)} }` : '{ … }';
    }
    case 'compound':
      return expr.text;
    case 'call': {
      const site = facts.flow.calls[expr.call];
      if (!site) return '?';
      const args = site.arguments
        .filter((argument) => argument.value.kind !== 'closure' || site.arguments.length === 1 || argument.label !== '_')
        .map((argument) => `${argument.label === '_' ? '' : `${argument.label}: `}${renderValue(argument.value, facts, depth + 1)}`)
        .join(', ');
      const receiver = site.receiver ? `${renderValue(site.receiver, facts, depth + 1)}.` : '';
      return `${receiver}${site.name}(${args})`;
    }
    case 'path': {
      const root = expr.root;
      const start =
        root.kind === 'self'
          ? 'self'
          : root.kind === 'local' || root.kind === 'type'
            ? root.name
            : renderValue({ kind: 'call', call: root.call }, facts, depth + 1);
      const parts = root.kind === 'self' && expr.members.length > 0 ? [] : [start];
      for (const member of expr.members) {
        if (member === '[]') parts[parts.length - 1] = `${parts.at(-1) ?? ''}[]`;
        else parts.push(member);
      }
      return `${expr.binding ? '$' : ''}${parts.join('.')}`;
    }
  }
}

function where(at: Location): string {
  return `${at.file.split('/').at(-1)}:${at.line}`;
}
