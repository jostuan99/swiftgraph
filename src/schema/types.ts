// Shared data types of swiftgraph. See docs/01-design.md, section 3.
//
// Positions: lines and columns are 1-based everywhere.

export type FileKind = 'swift' | 'strings' | 'stringsdict' | 'xcstrings';

export type DeclarationKind =
  | 'class'
  | 'struct'
  | 'enum'
  | 'actor'
  | 'protocol'
  | 'extension'
  | 'function'
  | 'initializer'
  | 'deinitializer'
  | 'subscript'
  | 'property'
  | 'enum_case'
  | 'typealias'
  | 'associatedtype'
  | 'macro';

export const TYPE_DECLARATION_KINDS: ReadonlySet<DeclarationKind> = new Set(['class', 'struct', 'enum', 'actor', 'protocol', 'extension']);

export type AccessLevel = 'open' | 'public' | 'package' | 'internal' | 'fileprivate' | 'private';

/** Start line, start column, end line, end column (1-based). */
export type Range = [number, number, number, number];

export interface Parameter {
  /** Argument label, `_` when the parameter has none. */
  label: string;
  name: string;
  type: string;
  /** The parameter has a default value and may be omitted by callers. */
  hasDefault?: boolean;
  variadic?: boolean;
}

export interface Declaration {
  /** Identifier local to the file; container and reference links use it. */
  localId: number;
  /** Enclosing declaration (type, extension or property), or null at top level. */
  parent: number | null;
  kind: DeclarationKind;
  name: string;
  /** Name with argument labels for callables: `move(to:)`, `init(from:)`, `subscript(_:)`. */
  selector: string;
  signature: string;
  access: AccessLevel | null;
  modifiers: string[];
  /** Attribute names without `@`: `MainActor`, `Published`, `available`. */
  attributes: string[];
  range: Range;
  doc: string | null;
  /** Conditions of the enclosing `#if` branches, outermost first. */
  conditions: string[];
  /** Extended type of an extension: `Array`, `Foo.Bar`. */
  extendedType?: string;
  /** Types listed in the inheritance clause. */
  inherits?: string[];
  /** Generic parameter names (`T`, `each U`): they shadow type names inside the declaration. */
  genericParameters?: string[];
  /** Conformance constraints of generic parameters: `<M: P>`, `where M: P & Q` → `{ M: ['P', 'Q'] }`. */
  genericConstraints?: Record<string, string[]>;
  parameters?: Parameter[];
  returnType?: string;
  /** Declared type of a property, or the aliased type of a typealias. */
  type?: string;
  /** Type of a property without annotation, from its initializer: `= Store()`. */
  inferredType?: string;
  /**
   * Initializer of a property without annotation when it is a chain of members
   * and calls from a name: `DIContainer.shared.getLoginRepository()`. The
   * resolver types the property from the chain.
   */
  initializerChain?: string;
  isStatic?: boolean;
  isComputed?: boolean;
}

export type Receiver =
  /** No receiver: a free function, or a member of the enclosing type. */
  | { kind: 'none' }
  | { kind: 'self' }
  | { kind: 'super' }
  /** `.member` with the type taken from context. */
  | { kind: 'implicit' }
  /** A type name: `Foo.make()`, `Self.make()`. */
  | { kind: 'type'; name: string }
  /** A local variable or parameter, with its type when known. */
  /**
   * A local variable or parameter. `explicit` is true when the type comes
   * from an annotation, false when it is inferred from an initializer.
   */
  | { kind: 'variable'; name: string; typeHint?: string; explicit?: boolean }
  /** A property of self: `self.store.send()` or `store.send()`. */
  | { kind: 'self_member'; name: string }
  /** A static member: `Foo.shared.send()`. */
  | { kind: 'type_member'; type: string; name: string }
  /** The result of an initializer call: `Foo().send()`. */
  | { kind: 'instance'; type: string }
  | { kind: 'expression' };

export type ReferenceKind =
  | 'call'
  /** A type name used in a signature, annotation, cast or generic argument. */
  | 'type'
  /** A type listed in an inheritance clause. */
  | 'inherit'
  | 'read'
  | 'write'
  | 'attribute'
  | 'macro'
  /** A localization key used in code (`name` is the key). */
  | 'string';

export interface Reference {
  /** Local id of the enclosing declaration, or null for top-level code. */
  from: number | null;
  kind: ReferenceKind;
  name: string;
  /** Call selector with labels: `send(_:)`, `animate(withDuration:_:)`. */
  selector?: string;
  receiver?: Receiver;
  /** `string` references: table named in the call (`tableName:`, `table:`). */
  table?: string;
  /**
   * `string` references: `explicit` for Foundation APIs, `swiftui` for views
   * and modifiers taking a LocalizedStringKey, `dynamic` when the key is not a
   * literal (name is then empty). Unknown interpolation types appear as `%?`.
   */
  localization?: 'explicit' | 'swiftui' | 'dynamic';
  line: number;
  column: number;
}

// --- Data flow (docs/05-data-flow.md, section 7) -------------------------------

/** Where a value path starts. */
export type PathRoot =
  /** `self`, or a member of self written without it. */
  | { kind: 'self' }
  /** A local variable, parameter or closure parameter, in the scope that declared it. */
  | { kind: 'local'; name: string; scope: number }
  /** A type: `UserDefaults.standard`, `DIContainer.shared`. */
  | { kind: 'type'; name: string }
  /** The result of a call: `AF.request(url).serializingDecodable(T.self).value`. */
  | { kind: 'call'; call: number };

/** A value as written in source, reduced to what data flow needs. */
export type ValueExpr =
  /**
   * Member accesses from a root: `vm.items[]` (subscripts as `[]`; optional
   * chaining dropped). `binding` marks a SwiftUI binding: `$vm.firstName`.
   */
  | { kind: 'path'; root: PathRoot; members: string[]; binding?: true }
  | { kind: 'literal'; type: 'String' | 'Int' | 'Double' | 'Bool' | 'nil'; value: string }
  /** An implicit member: `.main`, `.login`. */
  | { kind: 'case'; name: string }
  /** The result of a call: index into `FlowFacts.calls`. */
  | { kind: 'call'; call: number }
  /** A closure: index into `FlowFacts.closures`. */
  | { kind: 'closure'; closure: number }
  /** Anything else (interpolation, operators, casts, ...) with the values it is made of. */
  | { kind: 'compound'; text: string; operands: ValueExpr[] };

export interface CallArgument {
  /** Argument label, `_` when there is none (also for the first trailing closure). */
  label: string;
  value: ValueExpr;
}

export interface CallSite {
  /** Declaration the call belongs to (as `Reference.from`). */
  from: number | null;
  name: string;
  selector: string;
  /** Index of the matching `call` reference. */
  reference: number;
  /**
   * The call whose arguments or receiver contain this call: the enclosing
   * view in a SwiftUI view tree, the next operator of a Combine chain.
   */
  parent: number | null;
  /** Closure whose body contains the call (index into `FlowFacts.closures`). */
  closure: number | null;
  receiver?: ValueExpr;
  arguments: CallArgument[];
  /** Conditions of the enclosing `if`/`switch`/`guard` in the body, outermost first. */
  branch: string[];
  await?: true;
  /** The call is marked `try`, `try?` (errors ignored) or `try!`. */
  try?: 'try' | 'try?' | 'try!';
  line: number;
  column: number;
}

export interface ClosureFact {
  /** Scope id of the closure body (see `PathRoot.local`). */
  scope: number;
  /** Call the closure is an argument (or trailing closure) of: `VStack { … }`, `.sink { … }`. */
  call: number | null;
  /** Enclosing closure. */
  parent: number | null;
  /** Parameter names; `$0`, `$1`, ... when the closure uses shorthand names. */
  parameters: string[];
  /** Returned values, including the value of a single-expression body. */
  returns: ValueExpr[];
}

export interface Assignment {
  from: number | null;
  target: ValueExpr;
  value: ValueExpr;
  /** `=`, `+=`, ... */
  operator: string;
  branch: string[];
  /** Closure whose body contains the assignment. */
  closure?: number;
  line: number;
}

/** `let x = value`, `if let x = value`, `guard let x = value`. */
export interface LocalBinding {
  from: number | null;
  scope: number;
  name: string;
  value: ValueExpr;
  /** Annotated type: `let x: T = value`. */
  type?: string;
  line: number;
}

/** A value returned by a function, initializer or computed property body (not by a closure). */
export interface ReturnFact {
  from: number | null;
  value: ValueExpr;
  line: number;
}

export interface FlowFacts {
  calls: CallSite[];
  closures: ClosureFact[];
  assignments: Assignment[];
  bindings: LocalBinding[];
  returns: ReturnFact[];
}

export interface FileFacts {
  /** Version of the extractor; facts from older versions are re-extracted. */
  version: number;
  imports: string[];
  declarations: Declaration[];
  references: Reference[];
  flow: FlowFacts;
  /** True when the syntax tree contains ERROR or MISSING nodes. */
  hasErrors: boolean;
}

export interface DiscoveredFile {
  /** Path relative to the repository root, with `/` separators. */
  path: string;
  absolutePath: string;
  kind: FileKind;
  size: number;
  mtimeMs: number;
  /** Language of a localization file from its `<lang>.lproj` directory. */
  language: string | null;
  module: string;
}
