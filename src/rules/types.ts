// Declarative architecture rules: presets and the project's swiftgraph.json.
// See docs/05-data-flow.md, section 5.
//
// Rules are data only. swiftgraph never runs code from the repository.

/** An argument by label (`"forKey"`) or position (`0`). */
export type ArgumentRef = string | number;

/**
 * Matches a type. Conditions combine with AND; a list of values means OR.
 * Names are globs where `*` matches any run of characters.
 */
export interface TypeMatch {
  name?: string | string[];
  /** A protocol the type conforms to, directly or through other protocols. */
  conformsTo?: string | string[];
  /** A superclass, direct or not. */
  inherits?: string | string[];
  /** An attribute of the declaration, without `@`. */
  attribute?: string | string[];
  module?: string | string[];
  /** Glob on the file path. */
  path?: string | string[];
}

interface RuleBase {
  /** Lets a later preset or the project replace the rule, or `disable` it. */
  id?: string;
}

export interface LayerRule extends RuleBase {
  layer: string;
  match: TypeMatch;
}

/**
 * A value spec, relative to a call: `receiver`, `argument:<label|n>`,
 * `closure:<label|n>` (values the closure returns). A `[]` suffix takes the
 * elements: what a collection contains, or what a publisher emits.
 */
export type ValueSpec = string;

/** Where data is produced: a response, a local store, a file, a localized string. */
export interface SourceRule extends RuleBase {
  /** `api`, `local.userDefaults`, `local.keychain`, `local.file`, `localization`, or a project kind. */
  kind: string;
  /** `Type.selector`: `JSONDecoder.decode(_:from:)`, `*.serializingDecodable(_:)`. `Type` may be `*`. */
  call?: string;
  /** A property attribute: `AppStorage`. */
  attribute?: string;
  /**
   * Type of the value: the argument that holds `T.self`, or a fixed type
   * written as a string (`"String?"`). Without it the declared type is used.
   */
  type?: ArgumentRef | { fixed: string };
  /** Argument holding the key, path or table name. */
  key?: ArgumentRef;
  /** Argument holding the raw data the value is made from (`decode(_:from:)`). */
  input?: ArgumentRef;
  /**
   * Where the value comes out: `result` (default), `elements` (what the
   * returned publisher emits), `closure:<label|n>` (first parameter of the
   * closure passed there).
   */
  yields?: string;
  /** Members read on the value that only unwrap it: `value`, `result`. */
  unwrap?: string[];
  /** For responses: the call in the receiver chain that names the endpoint. */
  /** `defaultMethod` applies when the method argument is left out (`AF.request(url)` is a GET). */
  endpoint?: { call: string; argument: ArgumentRef; method?: ArgumentRef; defaultMethod?: string };
  /** `write` for calls that store data (`UserDefaults.set(_:forKey:)`). */
  direction?: 'read' | 'write';
  /** Argument holding the value written (`direction: write`). */
  value?: ArgumentRef;
}

export interface SinkArgument {
  /** What the argument shows or receives: `text`, `placeholder`, `label`, `image`, `action`. */
  role: string;
  /** A string literal here is a localization key (SwiftUI `LocalizedStringKey`). */
  localized?: boolean;
  /** `input` for bindings the view writes (`TextField(text:)`), `action` for closures run on tap. */
  direction?: 'display' | 'input' | 'action';
  /** Closure content shown as part of the item (`Button { Text("Login") }`). */
  content?: boolean;
}

/** Where data is shown: a SwiftUI view, or a UIKit property or method. */
export interface SinkRule extends RuleBase {
  /** `Text(_:)`, `TextField(_:text:)`, `UIButton.setTitle(_:for:)`. */
  call?: string;
  /** A UIKit property written to show a value: `UILabel.text`. */
  property?: string;
  /** Item kind printed: `Text`, `UILabel`. Defaults to the type name. */
  item?: string;
  direction: 'display' | 'input' | 'action' | 'list';
  /** Role of the value of a `property` sink. */
  role?: string;
  arguments?: Record<string, SinkArgument>;
}

/** A view that is one item of a list: a cell, a row. */
export interface ItemViewRule extends RuleBase {
  match?: TypeMatch;
  /** Views created in the closure of these calls: `List`, `ForEach`. */
  closureOf?: string[];
}

export interface ClosureFlow {
  /** Value of each closure parameter, in order. */
  parameters?: ValueSpec[];
  /** The closure runs later (after the publisher emits, when the task runs). */
  async?: boolean;
  /** Printed by `flows`: `value`, `failure`, `completion`, `action`. */
  on?: string;
}

/** An API that passes values through closures or over time (Combine, collections, concurrency). */
export interface FlowThroughRule extends RuleBase {
  /** `Type.selector`; `*.map(_:)`. */
  call?: string;
  /** A member read: `*.first`. */
  member?: string;
  /** The value of the call: `receiver` for operators that pass it on. */
  result?: ValueSpec | ValueSpec[];
  /** What the result contains or emits. */
  elements?: ValueSpec | ValueSpec[];
  /**
   * Where the whole result comes from when it is neither passed on nor an
   * element: the collection a `map` transforms.
   */
  derivedFrom?: ValueSpec | ValueSpec[];
  /** Closure arguments by label or position. `trailing` is the last closure. */
  closures?: Record<string, ClosureFlow>;
}

/** A dependency-injection binding: protocol → implementation. */
export interface InjectionRule extends RuleBase {
  /** `Container.register(_:factory:)`. */
  register: string;
  /** Argument holding `Protocol.self`. */
  service: ArgumentRef;
  /** Closure argument that returns the implementation. */
  factory: ArgumentRef;
  /** Only files importing this module are scanned for registrations. */
  imports?: string;
}

/** A project convention for converting values (`EntityMapper.mapping(_:)`). */
export interface MapperRule extends RuleBase {
  protocol: string;
  method: string;
  /** Associated type of the input and the output. */
  input?: string;
  output?: string;
}

/** Where a processing flow starts. */
export interface EntryPointRule extends RuleBase {
  /** `Button(action:_:)`; `*.onAppear(perform:)`. */
  call?: string;
  /** Closure argument that runs (label or position). */
  closure?: ArgumentRef;
  /** A method called by the framework: `viewDidLoad()`, in types matching `match`. */
  method?: string;
  match?: TypeMatch;
  /** `action`, `appear`, `task`, `lifecycle`, `refresh`. */
  kind: string;
}

export interface RuleFile {
  $schema?: string;
  extends?: string[];
  disable?: string[];
  layers?: LayerRule[];
  sources?: SourceRule[];
  sinks?: SinkRule[];
  itemViews?: ItemViewRule[];
  flowThrough?: FlowThroughRule[];
  injection?: InjectionRule[];
  mappers?: MapperRule[];
  entryPoints?: EntryPointRule[];
}

export const RULE_KINDS = ['layers', 'sources', 'sinks', 'itemViews', 'flowThrough', 'injection', 'mappers', 'entryPoints'] as const;

export type RuleKind = (typeof RULE_KINDS)[number];

/** A rule with where it comes from. */
export type Loaded<T> = T & { origin: string };

export interface RuleSet {
  /** Presets applied, in order. */
  presets: string[];
  /** Hash of the effective rules. */
  hash: string;
  layers: Loaded<LayerRule>[];
  sources: Loaded<SourceRule>[];
  sinks: Loaded<SinkRule>[];
  itemViews: Loaded<ItemViewRule>[];
  flowThrough: Loaded<FlowThroughRule>[];
  injection: Loaded<InjectionRule>[];
  mappers: Loaded<MapperRule>[];
  entryPoints: Loaded<EntryPointRule>[];
}
