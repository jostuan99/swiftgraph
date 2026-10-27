// Turns the facts of every file into graph nodes and edges.
// See docs/01-design.md, section 5.
//
// The resolver has no type checker. It resolves names with the receiver hints
// collected by the extractor, the argument labels of calls, and the
// declarations of the repository; SDK names come from the table in sdk.ts.

import { createHash } from 'node:crypto';
import { TYPE_DECLARATION_KINDS, type Declaration, type FileFacts, type Parameter, type Reference } from '../schema/types.ts';
import { addEdge, createGraph, type Confidence, type EdgeKind, type Evidence, type Graph, type GraphNode } from './graph.ts';
import { buildLocalization, matchString, type LocalizationFile } from '../localization/resolve.ts';
import { sdkSymbol, type SdkKind } from './sdk.ts';

export interface ResolverFile {
  path: string;
  module: string;
  facts: FileFacts;
  /**
   * Loads the references when `facts.references` is left empty, so only one
   * file's references are in memory at a time.
   */
  loadReferences?: () => Reference[];
}

/** Attached macros → the protocol their expansion conforms the type to. */
const MACRO_CONFORMANCES: Readonly<Record<string, string>> = {
  Observable: 'Observable',
  Model: 'PersistentModel',
  Reducer: 'Reducer',
  ObservableState: 'ObservableState',
  DependencyClient: 'Sendable',
};

/** Most candidates kept for an ambiguous reference; beyond it no edge is made. */
const AMBIGUITY_LIMIT = 3;

export interface TypeInfo {
  id: string;
  kind: Declaration['kind'];
  module: string;
  /** Dotted path inside the module: `Outer.Inner`. */
  path: string;
  name: string;
  declaration: Declaration;
  /** Members by base name, including members declared in extensions. */
  members: Map<string, MemberInfo[]>;
  /** Inheritance clause entries of the type and its extensions, with the declaring node. */
  inherits: { name: string; from: string; file: string; line: number; module: string; imports: string[] }[];
  superclass?: TypeInfo;
  protocols: TypeInfo[];
  external: { name: string; symbol: { module: string; kind: SdkKind } }[];
}

export interface MemberInfo {
  id: string;
  declaration: Declaration;
  owner: TypeInfo;
  fromExtension: boolean;
  file: string;
  module: string;
  imports: string[];
}

export interface DeclarationInfo {
  id: string;
  file: ResolverFile;
  declaration: Declaration;
  /** Type that encloses the declaration (through an extension, the extended type). */
  enclosing?: TypeInfo;
}

interface Target {
  ids: string[];
  confidence: Confidence;
}

export interface ResolveOptions {
  /**
   * Resolve only the references of these files (paths). The other files only
   * contribute declarations; their facts may have empty `references`.
   */
  only?: ReadonlySet<string>;
  /** Parsed localization files (.strings, .stringsdict, .xcstrings). */
  localization?: LocalizationFile[];
}

export function resolve(files: ResolverFile[], options: ResolveOptions = {}): Graph {
  return new Resolver(files, options.only, options.localization ?? []).run();
}

/**
 * Types, members and inheritance of the repository without resolving
 * references: what the data-flow queries look names up in.
 */
export function indexRepository(files: ResolverFile[], localization: LocalizationFile[] = []): RepositoryIndex {
  const resolver = new Resolver(files, new Set(), localization);
  resolver.index();
  return resolver;
}

export interface RepositoryIndex {
  readonly files: ResolverFile[];
  readonly graph: Graph;
  declarationsOf(fileIndex: number): DeclarationInfo[];
  /** A type name as written in `file` inside `context`; generic parameters are the caller's business. */
  typeNamed(written: string, file: ResolverFile, context: TypeInfo | undefined): TypeInfo | undefined;
  typeOf(declaration: Declaration): TypeInfo | undefined;
  members(type: TypeInfo, name: string, selector: string | undefined, accept: (member: MemberInfo) => boolean): MemberInfo[];
  property(type: TypeInfo, name: string): MemberInfo | undefined;
  /** Type of a property from its annotation, initializer or initializer chain. */
  propertyTypeOf(property: MemberInfo): TypeInfo | undefined;
  types(): TypeInfo[];
  /** Types that conform to a protocol, directly or through other protocols. */
  conformers(protocol: TypeInfo): TypeInfo[];
  /** Whether `type` is `other`, a subclass of it, or conforms to it. */
  isSubtype(type: TypeInfo, other: TypeInfo): boolean;
  /** Protocols of a type, its superclasses and the protocols they inherit. */
  protocolsOf(type: TypeInfo): TypeInfo[];
  /** Names of the SDK types a type inherits or conforms to (with its superclasses). */
  externalNames(type: TypeInfo): string[];
  /** Top-level declarations named `name` visible from `file`. */
  topLevelNamed(file: ResolverFile, name: string): DeclarationInfo[];
  fileOf(member: MemberInfo): ResolverFile;
}

class Resolver implements RepositoryIndex {
  readonly graph = createGraph();
  private readonly declarations: DeclarationInfo[][] = [];
  private readonly typesByPath = new Map<string, TypeInfo[]>();
  private readonly typesByName = new Map<string, TypeInfo[]>();
  private readonly typeByDeclaration = new Map<Declaration, TypeInfo>();
  private readonly topLevel = new Map<string, Map<string, DeclarationInfo[]>>();
  private readonly membersByName = new Map<string, MemberInfo[]>();
  /** Type an extension extends (null when not found), resolved once per extension. */
  private readonly extendedTypes = new Map<Declaration, TypeInfo | null>();
  /** Every type, once indexing is done. */
  private typeList: TypeInfo[] | undefined;
  /** Generic parameters in scope of the declaration being resolved. */
  private generics: ReadonlySet<string> = new Set();
  private readonly modules = new Set<string>();

  readonly files: ResolverFile[];
  private readonly only: ReadonlySet<string> | undefined;
  private readonly localizationFiles: LocalizationFile[];

  constructor(files: ResolverFile[], only: ReadonlySet<string> | undefined, localization: LocalizationFile[]) {
    this.files = files;
    this.only = only;
    this.localizationFiles = localization;
  }

  run(): Graph {
    this.index();
    for (const [fileIndex, file] of this.files.entries()) {
      if (!this.only || this.only.has(file.path)) this.resolveReferences(file, fileIndex);
    }
    this.addImplementsAndOverrides();
    this.addRenders();
    this.addTests();
    return this.graph;
  }

  index(): void {
    for (const file of this.files) this.modules.add(file.module);
    for (const file of this.localizationFiles) this.modules.add(file.module);
    this.createNodes();
    this.createLocalizationNodes();
    this.indexTypes();
    this.resolveInheritance();
    this.generics = new Set();
  }

  // --- RepositoryIndex ---------------------------------------------------------

  declarationsOf(fileIndex: number): DeclarationInfo[] {
    return this.declarations[fileIndex] ?? [];
  }

  typeNamed(written: string, file: ResolverFile, context: TypeInfo | undefined): TypeInfo | undefined {
    const saved = this.generics;
    this.generics = new Set();
    try {
      const resolved = this.resolveTypeName(written, file, context);
      return resolved.unique ? resolved.type : undefined;
    } finally {
      this.generics = saved;
    }
  }

  typeOf(declaration: Declaration): TypeInfo | undefined {
    return this.typeByDeclaration.get(declaration);
  }

  members(type: TypeInfo, name: string, selector: string | undefined, accept: (member: MemberInfo) => boolean): MemberInfo[] {
    return this.lookupMember(type, name, selector, accept);
  }

  property(type: TypeInfo, name: string): MemberInfo | undefined {
    return this.lookupProperty(type, name);
  }

  propertyTypeOf(property: MemberInfo): TypeInfo | undefined {
    const saved = this.generics;
    this.generics = new Set();
    try {
      return this.propertyType(property, this.fileOf(property))?.type;
    } finally {
      this.generics = saved;
    }
  }

  types(): TypeInfo[] {
    return this.allTypes();
  }

  conformers(protocol: TypeInfo): TypeInfo[] {
    return this.allTypes().filter((type) => type !== protocol && this.protocolsOf(type).includes(protocol));
  }

  isSubtype(type: TypeInfo, other: TypeInfo): boolean {
    if (type === other) return true;
    for (let current = type.superclass; current; current = current.superclass) if (current === other) return true;
    return this.protocolsOf(type).includes(other);
  }

  protocolsOf(type: TypeInfo): TypeInfo[] {
    const found = allProtocols(type);
    for (let current = type.superclass; current; current = current.superclass) {
      for (const protocol of allProtocols(current)) if (!found.includes(protocol)) found.push(protocol);
    }
    return found;
  }

  externalNames(type: TypeInfo): string[] {
    const names: string[] = [];
    const visit = (current: TypeInfo) => {
      for (const external of current.external) if (!names.includes(external.name)) names.push(external.name);
    };
    for (let current: TypeInfo | undefined = type; current; current = current.superclass) visit(current);
    for (const protocol of this.protocolsOf(type)) visit(protocol);
    return names;
  }

  topLevelNamed(file: ResolverFile, name: string): DeclarationInfo[] {
    return this.findTopLevel(file, name);
  }

  // --- Nodes ----------------------------------------------------------------

  private createNodes(): void {
    for (const module of this.modules) {
      this.addNode({ symbolId: moduleId(module), kind: 'module', name: module, qualifiedName: module });
    }
    for (const [fileIndex, file] of this.files.entries()) {
      const fileNode = fileId(file.path);
      this.addNode({ symbolId: fileNode, kind: 'file', name: file.path.split('/').at(-1)!, qualifiedName: file.path, file: file.path });
      // A partial update keeps the stored edges of the other files.
      const ownEdges = !this.only || this.only.has(file.path);
      if (ownEdges) addEdge(this.graph, moduleId(file.module), 'CONTAINS', fileNode, 'EXTRACTED', null);
      for (const name of ownEdges ? file.facts.imports : []) {
        const imported = name.split('.')[0]!;
        if (this.modules.has(imported))
          addEdge(this.graph, fileNode, 'IMPORTS', moduleId(imported), 'EXTRACTED', { file: file.path, line: 1 });
      }

      const infos: DeclarationInfo[] = [];
      const usedIds = new Map<string, Declaration>();
      const extensionCounts = new Map<string, number>();
      for (const declaration of file.facts.declarations) {
        let ordinal = 0;
        if (declaration.kind === 'extension') {
          const extended = declaration.extendedType ?? declaration.name;
          ordinal = (extensionCounts.get(extended) ?? 0) + 1;
          extensionCounts.set(extended, ordinal);
        }
        let id = this.declarationId(file, declaration, ordinal);
        const existing = this.graph.nodes.get(id);
        if (existing) {
          const previous = usedIds.get(id);
          // The same symbol declared in exclusive `#if` branches is one node.
          // Anything else (a protocol requirement and its default implementation,
          // overloads by parameter type) gets its own node.
          const sameSymbol = declaration.conditions.length > 0 && (previous?.conditions.length ?? existing.conditions.length) > 0;
          if (sameSymbol) {
            if (existing.file !== file.path) {
              this.graph.sharedSymbolFiles.add(file.path);
              if (existing.file) this.graph.sharedSymbolFiles.add(existing.file);
            }
            for (const condition of declaration.conditions) {
              if (!existing.conditions.includes(condition)) existing.conditions.push(condition);
            }
            infos.push({ id, file, declaration });
            continue;
          }
          const parentKind = declaration.parent === null ? '' : (file.facts.declarations[declaration.parent]?.kind ?? '');
          const base = id;
          id = `${base}#${shortHash(`${declaration.signature}|${file.path}|${parentKind}`)}`;
          for (let counter = 2; this.graph.nodes.has(id); counter++) {
            id = `${base}#${shortHash(`${declaration.signature}|${file.path}|${parentKind}|${counter}`)}`;
          }
        }
        usedIds.set(id, declaration);
        infos.push({ id, file, declaration });
        this.addNode({
          symbolId: id,
          kind: declaration.kind,
          name: declaration.selector,
          qualifiedName: `${file.module}.${id.slice(id.indexOf('/') + 1)}`,
          signature: declaration.signature,
          access: declaration.access,
          modifiers: [...declaration.modifiers, ...declaration.attributes.map((attribute) => `@${attribute}`)],
          file: file.path,
          range: declaration.range,
          doc: declaration.doc,
          conditions: [...declaration.conditions],
        });
      }
      this.declarations[fileIndex] = infos;

      for (const info of infos) {
        const parent = info.declaration.parent;
        const container = parent === null ? fileNode : infos[parent]?.id;
        if (container && ownEdges)
          addEdge(this.graph, container, 'CONTAINS', info.id, 'EXTRACTED', evidenceOf(file, info.declaration.range[0]));
        if (parent === null && !TYPE_DECLARATION_KINDS.has(info.declaration.kind)) {
          this.indexTopLevel(file.module, info);
        }
      }
    }
  }

  /**
   * `extensionOrdinal` numbers the extensions of a type within the file, so an
   * extension keeps its id when a body edit moves it to another line (a
   * partial update relies on ids that only declaration changes affect).
   */
  private declarationId(file: ResolverFile, declaration: Declaration, extensionOrdinal: number): string {
    if (declaration.kind === 'extension') {
      return `swift:${file.module}/${declaration.extendedType ?? declaration.name}+ext@${file.path}#${extensionOrdinal}`;
    }
    const container = this.containerPath(file, declaration);
    // Macros live in their own namespace: `@Reducer` next to `protocol Reducer`.
    if (declaration.kind === 'macro') return `swift:${file.module}/${container ? `${container}.` : ''}macro:${declaration.name}`;
    const name =
      TYPE_DECLARATION_KINDS.has(declaration.kind) ||
      declaration.kind === 'property' ||
      declaration.kind === 'enum_case' ||
      declaration.kind === 'typealias' ||
      declaration.kind === 'associatedtype'
        ? declaration.name
        : declaration.selector;
    return `swift:${file.module}/${container ? `${container}.` : ''}${name}`;
  }

  /** Dotted path of the types that contain a declaration. */
  private containerPath(file: ResolverFile, declaration: Declaration): string {
    const parts: string[] = [];
    let parent = declaration.parent;
    while (parent !== null) {
      const container = file.facts.declarations[parent];
      if (!container) break;
      if (container.kind === 'extension') {
        parts.unshift(container.extendedType ?? container.name);
        break; // an extension names its type fully
      }
      if (TYPE_DECLARATION_KINDS.has(container.kind)) parts.unshift(container.name);
      parent = container.parent;
    }
    return parts.join('.');
  }

  private addNode(node: Partial<GraphNode> & Pick<GraphNode, 'symbolId' | 'kind' | 'name' | 'qualifiedName'>): void {
    this.graph.nodes.set(node.symbolId, {
      signature: null,
      access: null,
      modifiers: [],
      file: null,
      range: null,
      doc: null,
      conditions: [],
      ...node,
    });
  }

  private indexTopLevel(module: string, info: DeclarationInfo): void {
    let byName = this.topLevel.get(module);
    if (!byName) this.topLevel.set(module, (byName = new Map()));
    const name = info.declaration.name;
    const list = byName.get(name) ?? [];
    if (!list.some((existing) => existing.id === info.id)) list.push(info);
    byName.set(name, list);
  }

  private externalNode(name: string): string | undefined {
    const symbol = sdkSymbol(name);
    if (!symbol) return undefined;
    const id = `swift:${symbol.module}/${name}`;
    if (!this.graph.nodes.has(id)) {
      this.addNode({ symbolId: id, kind: 'external_symbol', name, qualifiedName: `${symbol.module}.${name}`, signature: symbol.kind });
    }
    return id;
  }

  // --- Types ----------------------------------------------------------------

  private indexTypes(): void {
    // Types first, so extensions in any file can find them.
    for (const [fileIndex, file] of this.files.entries()) {
      for (const info of this.declarations[fileIndex] ?? []) {
        const declaration = info.declaration;
        if (!TYPE_DECLARATION_KINDS.has(declaration.kind) || declaration.kind === 'extension') continue;
        if (this.typeByDeclaration.has(declaration)) continue;
        const path = this.containerPath(file, declaration);
        const type: TypeInfo = {
          id: info.id,
          kind: declaration.kind,
          module: file.module,
          path: path ? `${path}.${declaration.name}` : declaration.name,
          name: declaration.name,
          declaration,
          members: new Map(),
          inherits: [],
          protocols: [],
          external: [],
        };
        this.typeByDeclaration.set(declaration, type);
        const existingPath = this.typesByPath.get(type.path) ?? [];
        // One TypeInfo per node: `#if` variants of a type share the node.
        if (existingPath.some((other) => other.id === type.id)) {
          this.typeByDeclaration.set(
            declaration,
            existingPath.find((other) => other.id === type.id)!,
          );
          continue;
        }
        // Appended in place: copying made common names quadratic.
        existingPath.push(type);
        this.typesByPath.set(type.path, existingPath);
        const sameName = this.typesByName.get(type.name);
        if (sameName) sameName.push(type);
        else this.typesByName.set(type.name, [type]);
      }
    }

    // Members and enclosing types.
    for (const [fileIndex, file] of this.files.entries()) {
      const infos = this.declarations[fileIndex] ?? [];
      for (const info of infos) {
        const declaration = info.declaration;
        const owner = this.ownerType(file, infos, declaration.parent);
        if (owner) info.enclosing = owner.type;
        if (declaration.kind === 'extension') {
          const extended = this.resolveTypeName(declaration.extendedType ?? declaration.name, file, undefined);
          const evidence = evidenceOf(file, declaration.range[0]);
          if (extended.type) {
            addEdge(this.graph, info.id, 'EXTENDS', extended.type.id, extended.unique ? 'EXTRACTED' : 'AMBIGUOUS', evidence);
          } else {
            const external = this.externalNode(baseTypeName(declaration.extendedType ?? declaration.name));
            if (external) addEdge(this.graph, info.id, 'EXTENDS', external, 'INFERRED', evidence);
          }
          continue;
        }
        if (!owner || TYPE_DECLARATION_KINDS.has(declaration.kind)) continue;
        const member: MemberInfo = {
          id: info.id,
          declaration,
          owner: owner.type,
          fromExtension: owner.viaExtension,
          file: file.path,
          module: file.module,
          imports: file.facts.imports,
        };
        const list = owner.type.members.get(declaration.name) ?? [];
        if (!list.some((existing) => existing.id === member.id)) {
          list.push(member);
          owner.type.members.set(declaration.name, list);
          const sameName = this.membersByName.get(declaration.name);
          if (sameName) sameName.push(member);
          else this.membersByName.set(declaration.name, [member]);
        }
      }
    }
  }

  /** Type that owns members declared under `parent` (a type or an extension). */
  private ownerType(
    file: ResolverFile,
    infos: DeclarationInfo[],
    parent: number | null,
  ): { type: TypeInfo; viaExtension: boolean } | undefined {
    if (parent === null) return undefined;
    const container = infos[parent];
    if (!container) return undefined;
    if (container.declaration.kind === 'extension') {
      let extended = this.extendedTypes.get(container.declaration);
      if (extended === undefined) {
        const resolved = this.resolveTypeName(container.declaration.extendedType ?? container.declaration.name, file, undefined);
        extended = resolved.type ?? null;
        this.extendedTypes.set(container.declaration, extended);
      }
      return extended ? { type: extended, viaExtension: true } : undefined;
    }
    const type = this.typeByDeclaration.get(container.declaration);
    if (type) return { type, viaExtension: false };
    // A property or function container: walk further up.
    return this.ownerType(file, infos, container.declaration.parent);
  }

  /**
   * Resolves a type name as written in a file. Nested names are tried relative
   * to the enclosing type first; ties prefer the same module, then imports.
   */
  private resolveTypeName(
    written: string,
    file: ResolverFile,
    context: TypeInfo | undefined,
  ): { type?: TypeInfo; unique: boolean; candidates: TypeInfo[] } {
    const name = baseTypeName(written);
    if (name === 'Self' && context) return { type: context, unique: true, candidates: [context] };
    // A generic parameter in scope shadows every type of that name.
    if (this.generics.has(name.split('.')[0]!)) return { unique: false, candidates: [] };
    if (context) {
      const parts = context.path.split('.');
      for (let length = parts.length; length > 0; length--) {
        const nested = this.typesByPath.get(`${parts.slice(0, length).join('.')}.${name}`);
        if (nested?.length === 1) return { type: nested[0]!, unique: true, candidates: nested };
      }
    }
    // Nested types are found through the context above; by plain name only
    // top-level types (and `Outer.Inner` paths) match.
    let candidates = this.typesByPath.get(name) ?? [];
    if (candidates.length === 0 && name.includes('.')) {
      // `Module.Type`
      const [first, ...rest] = name.split('.');
      if (first && this.modules.has(first)) {
        candidates = (this.typesByPath.get(rest.join('.')) ?? []).filter((type) => type.module === first);
      }
    }
    // Only types of this module or of an imported module are visible.
    const visible = (type: TypeInfo) =>
      type.module === file.module || file.facts.imports.some((imported) => imported.split('.')[0] === type.module);
    candidates = candidates.filter(visible);
    if (candidates.length <= 1)
      return { type: candidates[0], unique: candidates.length === 1, candidates } as {
        type?: TypeInfo;
        unique: boolean;
        candidates: TypeInfo[];
      };
    const sameModule = candidates.filter((type) => type.module === file.module);
    if (sameModule.length === 1) return { type: sameModule[0]!, unique: true, candidates };
    const imported = candidates.filter((type) => file.facts.imports.some((name) => name.split('.')[0] === type.module));
    if (imported.length === 1) return { type: imported[0]!, unique: true, candidates };
    return { type: candidates[0]!, unique: false, candidates };
  }

  private resolveInheritance(): void {
    for (const [fileIndex, file] of this.files.entries()) {
      for (const info of this.declarations[fileIndex] ?? []) {
        this.addMacroConformances(file, info);
        const declaration = info.declaration;
        if (!declaration.inherits) continue;
        this.generics = this.genericsInScope(file, info);
        const subject =
          declaration.kind === 'extension' ? (info.enclosing ?? this.extendedType(info)) : this.typeByDeclaration.get(declaration);
        for (const written of declaration.inherits) {
          const evidence = evidenceOf(file, declaration.range[0]);
          const resolved = this.resolveTypeName(written, file, subject);
          if (resolved.type) {
            const target = resolved.type;
            const confidence: Confidence = resolved.unique ? 'EXTRACTED' : 'AMBIGUOUS';
            if (target.kind === 'protocol') {
              addEdge(this.graph, info.id, 'CONFORMS_TO', target.id, confidence, evidence);
              if (subject && !subject.protocols.includes(target)) subject.protocols.push(target);
            } else if (target.kind === 'class' && (declaration.kind === 'class' || declaration.kind === 'actor')) {
              addEdge(this.graph, info.id, 'INHERITS', target.id, confidence, evidence);
              if (subject) subject.superclass = target;
            }
            continue;
          }
          const name = baseTypeName(written);
          const symbol = sdkSymbol(name);
          if (!symbol) continue;
          if (symbol.kind === 'protocol') {
            addEdge(this.graph, info.id, 'CONFORMS_TO', this.externalNode(name)!, 'INFERRED', evidence);
          } else if (symbol.kind === 'class' && declaration.kind === 'class') {
            addEdge(this.graph, info.id, 'INHERITS', this.externalNode(name)!, 'INFERRED', evidence);
          } else {
            continue;
          }
          if (subject) subject.external.push({ name, symbol });
        }
      }
    }
  }

  /**
   * Conformances added by well-known attached macros, which expand outside the
   * source: `@Observable class` conforms to `Observable`, `@Reducer struct`
   * to `Reducer`, ...
   */
  private addMacroConformances(file: ResolverFile, info: DeclarationInfo): void {
    const declaration = info.declaration;
    if (!TYPE_DECLARATION_KINDS.has(declaration.kind) || declaration.kind === 'extension') return;
    const subject = this.typeByDeclaration.get(declaration);
    for (const attribute of declaration.attributes) {
      const protocol = MACRO_CONFORMANCES[attribute];
      if (!protocol) continue;
      const evidence = evidenceOf(file, declaration.range[0]);
      const resolved = this.resolveTypeName(protocol, file, subject);
      if (resolved.type?.kind === 'protocol' && resolved.unique) {
        addEdge(this.graph, info.id, 'CONFORMS_TO', resolved.type.id, 'INFERRED', evidence);
        if (subject && !subject.protocols.includes(resolved.type)) subject.protocols.push(resolved.type);
        continue;
      }
      const symbol = sdkSymbol(protocol);
      if (symbol?.kind !== 'protocol') continue;
      addEdge(this.graph, info.id, 'CONFORMS_TO', this.externalNode(protocol)!, 'INFERRED', evidence);
      if (subject) subject.external.push({ name: protocol, symbol });
    }
  }

  /** Generic parameters of a declaration, its containers and its enclosing type. */
  private genericsInScope(file: ResolverFile, info: DeclarationInfo | undefined): ReadonlySet<string> {
    const names = new Set<string>();
    if (!info) return names;
    for (let current: Declaration | undefined = info.declaration; current;) {
      for (const name of current.genericParameters ?? []) names.add(name);
      current = current.parent === null ? undefined : file.facts.declarations[current.parent];
    }
    for (const name of info.enclosing?.declaration.genericParameters ?? []) names.add(name);
    return names;
  }

  private extendedType(info: DeclarationInfo): TypeInfo | undefined {
    return this.resolveTypeName(info.declaration.extendedType ?? info.declaration.name, info.file, undefined).type;
  }

  // --- Member lookup -----------------------------------------------------------

  /**
   * Finds members named `name` in a type, then its superclasses, then its
   * protocols (requirements before default implementations).
   */
  private lookupMember(
    type: TypeInfo,
    name: string,
    selector: string | undefined,
    accept: (member: MemberInfo) => boolean,
    visited = new Set<TypeInfo>(),
  ): MemberInfo[] {
    if (visited.has(type)) return [];
    visited.add(type);
    let found = (type.members.get(name) ?? []).filter(accept);
    if (selector !== undefined) found = found.filter((member) => selectorMatches(selector, member.declaration));
    if (found.length > 0) {
      if (type.kind === 'protocol') {
        const requirements = found.filter((member) => !member.fromExtension);
        if (requirements.length > 0) found = requirements;
      }
      return dedupeMembers(found);
    }
    if (type.superclass) {
      const inherited = this.lookupMember(type.superclass, name, selector, accept, visited);
      if (inherited.length > 0) return inherited;
    }
    for (const protocol of type.protocols) {
      const inherited = this.lookupMember(protocol, name, selector, accept, visited);
      if (inherited.length > 0) return inherited;
    }
    return [];
  }

  private lookupProperty(type: TypeInfo, name: string): MemberInfo | undefined {
    const found = this.lookupMember(type, name, undefined, (member) => member.declaration.kind === 'property');
    return found.length === 1 ? found[0] : undefined;
  }

  /** Type of a property, and whether it comes from an annotation. */
  private propertyType(property: MemberInfo, file: ResolverFile): { type: TypeInfo; explicit: boolean } | undefined {
    const written = property.declaration.type ?? property.declaration.inferredType;
    if (!written) {
      const chain = property.declaration.initializerChain;
      const type = chain ? this.chainType(chain, this.fileOf(property), property.owner, new Set([property.id])) : undefined;
      return type ? { type, explicit: false } : undefined;
    }
    const resolved = this.resolveTypeName(written, file, property.owner);
    if (!resolved.type || !resolved.unique) return undefined;
    return { type: resolved.type, explicit: property.declaration.type !== undefined };
  }

  /** Protocols a generic parameter in scope of `from` is constrained to; undefined when `name` is not one. */
  private constraintsOf(name: string, from: DeclarationInfo | undefined): TypeInfo[] | undefined {
    if (!from || !this.generics.has(name)) return undefined;
    const file = from.file;
    const found: TypeInfo[] = [];
    const visit = (declaration: Declaration, context: TypeInfo | undefined) => {
      for (const written of declaration.genericConstraints?.[name] ?? []) {
        const resolved = this.resolveTypeName(written, file, context);
        if (resolved.type && resolved.unique && !found.includes(resolved.type)) found.push(resolved.type);
      }
    };
    for (let current: Declaration | undefined = from.declaration; current;) {
      visit(current, from.enclosing);
      current = current.parent === null ? undefined : file.facts.declarations[current.parent];
    }
    return found;
  }

  /** File of a member, for resolving the type names written in it. */
  fileOf(member: MemberInfo): ResolverFile {
    return this.filesByPath().get(member.file)!;
  }

  private fileIndexByPath: Map<string, ResolverFile> | undefined;

  private filesByPath(): Map<string, ResolverFile> {
    return (this.fileIndexByPath ??= new Map(this.files.map((file) => [file.path, file])));
  }

  /**
   * Type of a member chain written in `file` inside `context`:
   * `DIContainer.shared.getLoginRepository()` → the return type of
   * `getLoginRepository()`. Properties in `visiting` are not followed again.
   */
  private chainType(chain: string, file: ResolverFile, context: TypeInfo | undefined, visiting: Set<string>): TypeInfo | undefined {
    const parts = chain.split('.');
    let current: TypeInfo | undefined;
    let isStatic = false;
    const first = parts[0]!;
    if (!first.endsWith('()') && isTypeName(first)) {
      const resolved = this.resolveTypeName(first, file, context);
      if (!resolved.type || !resolved.unique) return undefined;
      current = resolved.type;
      isStatic = true;
    } else {
      current = context;
      parts.unshift('');
    }
    for (const part of parts.slice(1)) {
      if (!current) return undefined;
      const owner: TypeInfo = current;
      if (part.endsWith('()')) {
        const name = part.slice(0, -2);
        const methods = this.lookupMember(
          owner,
          name,
          undefined,
          (member) => member.declaration.kind === 'function' && (member.declaration.isStatic === true) === isStatic,
        );
        const returns = unique(methods.map((member) => member.declaration.returnType).filter((type): type is string => type !== undefined));
        if (methods.length === 0 || returns.length !== 1) return undefined;
        const method = methods[0]!;
        if (returns[0] === 'Self') {
          current = owner;
        } else {
          const resolved = this.resolveTypeName(returns[0]!, this.fileOf(method), method.owner);
          current = resolved.unique ? resolved.type : undefined;
        }
      } else {
        const property = this.lookupProperty(owner, part);
        if (!property || visiting.has(property.id)) return undefined;
        visiting.add(property.id);
        // `Foo.shared` without an annotation: assume it holds a Foo.
        current =
          this.propertyType(property, this.fileOf(property))?.type ?? (isStatic && property.declaration.isStatic ? owner : undefined);
      }
      isStatic = false;
    }
    return current;
  }

  // --- References --------------------------------------------------------------

  private resolveReferences(file: ResolverFile, fileIndex: number): void {
    const infos = this.declarations[fileIndex] ?? [];
    for (const reference of file.loadReferences?.() ?? file.facts.references) {
      const from = reference.from === null ? undefined : infos[reference.from];
      this.generics = this.genericsInScope(file, from);
      const source = from?.id ?? fileId(file.path);
      const evidence = evidenceOf(file, reference.line);
      switch (reference.kind) {
        case 'call':
          this.resolveCall(file, from, source, reference, evidence);
          break;
        case 'read':
        case 'write':
          this.resolveAccess(file, from, source, reference, evidence);
          break;
        case 'type':
          this.resolveTypeReference(file, from, source, reference, evidence);
          break;
        case 'attribute':
          this.resolveAttribute(file, from, source, reference, evidence);
          break;
        case 'macro':
          for (const macro of this.findTopLevel(file, reference.name).filter((info) => info.declaration.kind === 'macro')) {
            addEdge(this.graph, source, 'EXPANDS', macro.id, 'INFERRED', evidence);
          }
          break;
        case 'inherit':
          break; // handled by resolveInheritance
        case 'string':
          this.resolveString(file, source, reference, evidence);
          break;
      }
    }
  }

  private resolveCall(
    file: ResolverFile,
    from: DeclarationInfo | undefined,
    source: string,
    reference: Reference,
    evidence: Evidence,
  ): void {
    const receiver = reference.receiver ?? { kind: 'none' };
    const selector = reference.selector ?? `${reference.name}()`;
    const callable = (member: MemberInfo) => isCallable(member.declaration);
    const enclosing = from?.enclosing;

    const callMember = (type: TypeInfo | undefined, name: string, confidence: Confidence) => {
      if (!type) return false;
      const memberSelector = name === 'init' ? `init${selector.slice(selector.indexOf('('))}` : selector;
      const found = this.lookupMember(type, name, memberSelector, callable);
      this.addTargets(source, 'CALLS', { ids: found.map((member) => member.id), confidence }, evidence);
      return found.length > 0;
    };

    switch (receiver.kind) {
      case 'none': {
        if (isTypeName(reference.name)) {
          this.instantiate(file, from, source, reference.name, selector, evidence);
          return;
        }
        if (enclosing && callMember(enclosing, reference.name, 'INFERRED')) return;
        const functions = this.findTopLevel(file, reference.name).filter(
          (info) => isCallable(info.declaration) && selectorMatches(selector, info.declaration),
        );
        this.addTargets(source, 'CALLS', { ids: unique(functions.map((info) => info.id)), confidence: 'INFERRED' }, evidence);
        return;
      }
      case 'self':
        callMember(enclosing, reference.name, 'EXTRACTED');
        return;
      case 'super':
        callMember(enclosing?.superclass, reference.name, 'EXTRACTED');
        return;
      case 'type': {
        const resolved = this.resolveTypeName(receiver.name, file, enclosing);
        if (resolved.type && resolved.unique) callMember(resolved.type, reference.name, 'EXTRACTED');
        return;
      }
      case 'variable': {
        const constraints = receiver.typeHint ? this.constraintsOf(baseTypeName(receiver.typeHint), from) : undefined;
        if (constraints) {
          // `mapper.mapping(x)` with `mapper: Mapper` and `Mapper: ViewModelMapper`: the requirement.
          for (const protocol of constraints) if (callMember(protocol, reference.name, 'INFERRED')) return;
          return;
        }
        if (receiver.typeHint) {
          const resolved = this.resolveTypeName(receiver.typeHint, file, enclosing);
          if (resolved.type && resolved.unique) callMember(resolved.type, reference.name, receiver.explicit ? 'EXTRACTED' : 'INFERRED');
          return;
        }
        this.resolveByName(source, reference, selector, evidence);
        return;
      }
      case 'self_member': {
        const property = enclosing ? this.lookupProperty(enclosing, receiver.name) : undefined;
        const type = property ? this.propertyType(property, file) : undefined;
        if (type) {
          callMember(type.type, reference.name, type.explicit ? 'EXTRACTED' : 'INFERRED');
        } else if (!property) {
          this.resolveByName(source, reference, selector, evidence);
        }
        return;
      }
      case 'type_member': {
        const resolved = this.resolveTypeName(receiver.type, file, enclosing);
        if (!resolved.type || !resolved.unique) return;
        const property = this.lookupProperty(resolved.type, receiver.name);
        // `Foo.shared.bar()`: without an annotation, assume the property holds a Foo.
        const type = property ? (this.propertyType(property, file)?.type ?? resolved.type) : undefined;
        if (type) callMember(type, reference.name, 'INFERRED');
        return;
      }
      case 'instance': {
        const resolved = this.resolveTypeName(receiver.type, file, enclosing);
        if (resolved.type && resolved.unique) callMember(resolved.type, reference.name, 'INFERRED');
        return;
      }
      case 'implicit': {
        if (reference.name === 'init') return;
        const candidates = (this.membersByName.get(reference.name) ?? []).filter(
          (member) =>
            member.declaration.kind === 'enum_case' ||
            (member.declaration.isStatic === true && isCallable(member.declaration) && selectorMatches(selector, member.declaration)),
        );
        const ids = unique(candidates.map((member) => member.id));
        const kind: EdgeKind = candidates.every((member) => member.declaration.kind === 'enum_case') ? 'REFERENCES' : 'CALLS';
        this.addTargets(source, kind, { ids, confidence: ids.length === 1 ? 'INFERRED' : 'AMBIGUOUS' }, evidence);
        return;
      }
      case 'expression':
        this.resolveByName(source, reference, selector, evidence);
        return;
    }
  }

  /** Receiver of unknown type: match the method by name and labels across the repository. */
  private resolveByName(source: string, reference: Reference, selector: string, evidence: Evidence): void {
    const candidates = (this.membersByName.get(reference.name) ?? []).filter(
      (member) => isCallable(member.declaration) && member.declaration.isStatic !== true && selectorMatches(selector, member.declaration),
    );
    // Prefer protocol requirements over their implementations.
    const requirements = candidates.filter((member) => member.owner.kind === 'protocol' && !member.fromExtension);
    const chosen = unique((requirements.length > 0 ? requirements : candidates).map((member) => member.id));
    const hasLabels = /\([^)]*[^_:)][^)]*\)/.test(selector);
    const confidence: Confidence = chosen.length === 1 && hasLabels ? 'INFERRED' : 'AMBIGUOUS';
    this.addTargets(source, 'CALLS', { ids: chosen, confidence }, evidence);
  }

  private instantiate(
    file: ResolverFile,
    from: DeclarationInfo | undefined,
    source: string,
    name: string,
    selector: string,
    evidence: Evidence,
  ): void {
    const resolved = this.resolveTypeName(name, file, from?.enclosing);
    if (resolved.type) {
      const confidence: Confidence = resolved.unique ? 'INFERRED' : 'AMBIGUOUS';
      for (const candidate of resolved.unique ? [resolved.type] : resolved.candidates.slice(0, AMBIGUITY_LIMIT)) {
        addEdge(this.graph, source, 'INSTANTIATES', candidate.id, confidence, evidence);
      }
      if (resolved.unique) {
        const initSelector = `init${selector.slice(selector.indexOf('('))}`;
        const initializers = this.lookupMember(resolved.type, 'init', initSelector, (member) => member.declaration.kind === 'initializer');
        this.addTargets(source, 'CALLS', { ids: initializers.map((member) => member.id), confidence: 'INFERRED' }, evidence);
      }
      return;
    }
    const external = this.externalNode(name);
    if (external) addEdge(this.graph, source, 'INSTANTIATES', external, 'INFERRED', evidence);
  }

  private resolveAccess(
    file: ResolverFile,
    from: DeclarationInfo | undefined,
    source: string,
    reference: Reference,
    evidence: Evidence,
  ): void {
    const kind: EdgeKind = reference.kind === 'write' ? 'WRITES' : 'READS';
    const receiver = reference.receiver ?? { kind: 'none' };
    const enclosing = from?.enclosing;
    const property = (type: TypeInfo | undefined, confidence: Confidence) => {
      if (!type) return;
      const found = this.lookupMember(type, reference.name, undefined, (member) => member.declaration.kind === 'property');
      this.addTargets(source, kind, { ids: found.map((member) => member.id), confidence }, evidence);
    };
    switch (receiver.kind) {
      case 'none': {
        if (enclosing) {
          const found = this.lookupMember(enclosing, reference.name, undefined, (member) => member.declaration.kind === 'property');
          if (found.length > 0) {
            this.addTargets(source, kind, { ids: found.map((member) => member.id), confidence: 'INFERRED' }, evidence);
            return;
          }
        }
        const globals = this.findTopLevel(file, reference.name).filter((info) => info.declaration.kind === 'property');
        this.addTargets(source, kind, { ids: unique(globals.map((info) => info.id)), confidence: 'INFERRED' }, evidence);
        return;
      }
      case 'self':
        property(enclosing, 'EXTRACTED');
        return;
      case 'super':
        property(enclosing?.superclass, 'EXTRACTED');
        return;
      case 'type': {
        const resolved = this.resolveTypeName(receiver.name, file, enclosing);
        if (resolved.type && resolved.unique) property(resolved.type, 'EXTRACTED');
        return;
      }
      case 'variable': {
        if (!receiver.typeHint) return;
        const constraints = this.constraintsOf(baseTypeName(receiver.typeHint), from);
        if (constraints) {
          for (const protocol of constraints) property(protocol, 'INFERRED');
          return;
        }
        const resolved = this.resolveTypeName(receiver.typeHint, file, enclosing);
        if (resolved.type && resolved.unique) property(resolved.type, receiver.explicit ? 'EXTRACTED' : 'INFERRED');
        return;
      }
      case 'self_member': {
        const holder = enclosing ? this.lookupProperty(enclosing, receiver.name) : undefined;
        const type = holder ? this.propertyType(holder, file) : undefined;
        if (type) property(type.type, type.explicit ? 'EXTRACTED' : 'INFERRED');
        return;
      }
      case 'instance': {
        const resolved = this.resolveTypeName(receiver.type, file, enclosing);
        if (resolved.type && resolved.unique) property(resolved.type, 'INFERRED');
        return;
      }
      default:
        return;
    }
  }

  private resolveTypeReference(
    file: ResolverFile,
    from: DeclarationInfo | undefined,
    source: string,
    reference: Reference,
    evidence: Evidence,
  ): void {
    const resolved = this.resolveTypeName(reference.name, file, from?.enclosing);
    if (resolved.type) {
      if (resolved.type.id === source) return;
      const ids = resolved.unique ? [resolved.type.id] : resolved.candidates.map((type) => type.id);
      this.addTargets(source, 'REFERENCES', { ids, confidence: resolved.unique ? 'EXTRACTED' : 'AMBIGUOUS' }, evidence);
      return;
    }
    const external = this.externalNode(baseTypeName(reference.name));
    if (external) addEdge(this.graph, source, 'REFERENCES', external, 'INFERRED', evidence);
  }

  private resolveAttribute(
    file: ResolverFile,
    from: DeclarationInfo | undefined,
    source: string,
    reference: Reference,
    evidence: Evidence,
  ): void {
    // An attribute names a macro before anything else: `@Reducer` next to `protocol Reducer`.
    const macros = this.findTopLevel(file, reference.name).filter((info) => info.declaration.kind === 'macro');
    if (macros.length > 0) {
      this.addTargets(source, 'EXPANDS', { ids: unique(macros.map((info) => info.id)), confidence: 'INFERRED' }, evidence);
      return;
    }
    const resolved = this.resolveTypeName(reference.name, file, from?.enclosing);
    if (resolved.type && resolved.unique) {
      if (resolved.type.declaration.attributes.includes('propertyWrapper')) {
        addEdge(this.graph, source, 'WRAPS', resolved.type.id, 'INFERRED', evidence);
      }
      return;
    }
    if (sdkSymbol(reference.name)?.kind === 'property_wrapper' && from?.declaration.kind === 'property') {
      addEdge(this.graph, source, 'WRAPS', this.externalNode(reference.name)!, 'INFERRED', evidence);
    }
  }

  private createLocalizationNodes(): void {
    const payload = buildLocalization(this.localizationFiles);
    this.graph.localization = payload;
    for (const table of payload.tables.values()) {
      this.addNode({
        symbolId: table.symbolId,
        kind: 'localization_table',
        name: table.name,
        qualifiedName: `${table.module}.${table.name}`,
        signature: table.files.join(', '),
        file: table.files[0] ?? null,
      });
      addEdge(this.graph, moduleId(table.module), 'CONTAINS', table.symbolId, 'EXTRACTED', null);
      for (const record of table.strings.values()) {
        this.addNode({
          symbolId: record.symbolId,
          kind: 'localized_string',
          name: record.key,
          qualifiedName: `${table.module}.${table.name}.${record.key}`,
          doc: record.comment,
          file: record.file,
          range: record.line === null ? null : [record.line, 1, record.line, 1],
        });
        addEdge(this.graph, table.symbolId, 'CONTAINS', record.symbolId, 'EXTRACTED', null);
      }
    }
  }

  private resolveString(file: ResolverFile, source: string, reference: Reference, evidence: Evidence): void {
    if (reference.localization === 'dynamic') {
      this.graph.referenceIssues.push({ kind: 'dynamic_key_usage', node: source, file: file.path, line: reference.line });
      return;
    }
    const match = matchString(this.graph.localization, file.module, reference);
    if (!match) return;
    if (match.ids.length === 0) {
      this.graph.referenceIssues.push({
        kind: 'missing_key',
        node: source,
        file: file.path,
        line: reference.line,
        detail: `${reference.table ?? 'Localizable'}: ${reference.name}`,
      });
      return;
    }
    this.addTargets(source, 'USES_STRING', match, evidence);
  }

  /** Top-level declarations visible from a file: its module, then imported repository modules. */
  private findTopLevel(file: ResolverFile, name: string): DeclarationInfo[] {
    const own = this.topLevel.get(file.module)?.get(name) ?? [];
    if (own.length > 0) return own;
    const found: DeclarationInfo[] = [];
    for (const imported of file.facts.imports) {
      const module = imported.split('.')[0]!;
      if (module === file.module) continue;
      found.push(...(this.topLevel.get(module)?.get(name) ?? []));
    }
    return found;
  }

  private addTargets(source: string, kind: EdgeKind, target: Target, evidence: Evidence): void {
    const ids = unique(target.ids);
    if (ids.length === 0 || ids.length > AMBIGUITY_LIMIT) return;
    const confidence: Confidence = ids.length > 1 ? 'AMBIGUOUS' : target.confidence;
    for (const id of ids) addEdge(this.graph, source, kind, id, confidence, evidence, 1 / ids.length);
  }

  // --- Derived edges -------------------------------------------------------------

  private allTypes(): TypeInfo[] {
    return (this.typeList ??= [...this.typesByPath.values()].flat());
  }

  private addImplementsAndOverrides(): void {
    for (const type of this.allTypes()) {
      for (const protocol of allProtocols(type)) {
        for (const requirements of protocol.members.values()) {
          for (const requirement of requirements) {
            if (requirement.fromExtension) continue;
            const isProperty = requirement.declaration.kind === 'property';
            const implementations = (type.members.get(requirement.declaration.name) ?? []).filter((member) =>
              isProperty ? member.declaration.kind === 'property' : member.declaration.selector === requirement.declaration.selector,
            );
            for (const implementation of implementations) {
              addEdge(this.graph, implementation.id, 'IMPLEMENTS', requirement.id, 'INFERRED', {
                file: implementation.file,
                line: implementation.declaration.range[0],
              });
            }
          }
        }
      }
      if (!type.superclass) continue;
      for (const members of type.members.values()) {
        for (const member of members) {
          if (!member.declaration.modifiers.includes('override')) continue;
          const accept = (candidate: MemberInfo) => candidate.declaration.kind === member.declaration.kind;
          const selector = isCallable(member.declaration) ? member.declaration.selector : undefined;
          const overridden = this.lookupMember(type.superclass, member.declaration.name, selector, accept);
          const exact = overridden.filter((candidate) => candidate.declaration.selector === member.declaration.selector);
          this.addTargets(
            member.id,
            'OVERRIDES',
            { ids: exact.map((candidate) => candidate.id), confidence: 'EXTRACTED' },
            { file: member.file, line: member.declaration.range[0] },
          );
        }
      }
    }
  }

  /** SwiftUI: a view's body (or a @ViewBuilder member) renders the views it creates. */
  private addRenders(): void {
    const isView = (type: TypeInfo) =>
      type.external.some((external) => ['View', 'App', 'Scene'].includes(external.name) && external.symbol.module === 'SwiftUI');
    const views = new Set(
      this.allTypes()
        .filter(isView)
        .map((type) => type.id),
    );
    if (views.size === 0) return;
    const builders = new Set<string>();
    for (const type of this.allTypes()) {
      if (!views.has(type.id)) continue;
      for (const members of type.members.values()) {
        for (const member of members) {
          if (member.declaration.name === 'body' || member.declaration.attributes.includes('ViewBuilder')) builders.add(member.id);
        }
      }
    }
    for (const edge of [...this.graph.edges.values()]) {
      if (edge.kind !== 'INSTANTIATES' || !builders.has(edge.source) || !views.has(edge.target)) continue;
      addEdge(this.graph, edge.source, 'RENDERS', edge.target, 'INFERRED', edge.evidence[0] ?? null);
    }
  }

  /** XCTest `test*` methods and Swift Testing `@Test` functions test what they call. */
  private addTests(): void {
    const tests = new Set<string>();
    for (const infos of this.declarations) {
      for (const info of infos ?? []) {
        const declaration = info.declaration;
        if (declaration.kind !== 'function') continue;
        const xcTest =
          declaration.name.startsWith('test') && info.enclosing?.external.some((external) => external.name === 'XCTestCase') === true;
        if (xcTest || declaration.attributes.includes('Test')) tests.add(info.id);
      }
    }
    for (const edge of [...this.graph.edges.values()]) {
      if (edge.kind !== 'CALLS' || edge.confidence === 'AMBIGUOUS') continue;
      if (!tests.has(edge.source) || tests.has(edge.target)) continue;
      addEdge(this.graph, edge.source, 'TESTS', edge.target, 'INFERRED', edge.evidence[0] ?? null);
    }
  }
}

// --- Helpers -----------------------------------------------------------------------

export function moduleId(module: string): string {
  return `module:${module}`;
}

export function fileId(path: string): string {
  return `file:${path}`;
}

function evidenceOf(file: ResolverFile, line: number): Evidence {
  return { file: file.path, line };
}

function shortHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 4);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Protocols of a type and the protocols they inherit, without its superclasses. */
function allProtocols(type: TypeInfo): TypeInfo[] {
  const found: TypeInfo[] = [];
  const visit = (protocol: TypeInfo) => {
    if (found.includes(protocol) || protocol === type) return;
    found.push(protocol);
    for (const inherited of protocol.protocols) visit(inherited);
  };
  for (const protocol of type.protocols) visit(protocol);
  return found;
}

function dedupeMembers(members: MemberInfo[]): MemberInfo[] {
  const seen = new Set<string>();
  return members.filter((member) => !seen.has(member.id) && seen.add(member.id));
}

function isCallable(declaration: Declaration): boolean {
  return declaration.kind === 'function' || declaration.kind === 'initializer' || declaration.kind === 'subscript';
}

function isTypeName(name: string): boolean {
  const first = name.replace(/^`/, '')[0];
  return first !== undefined && first !== first.toLowerCase();
}

/** `Store<Void>?` → `Store`; `[Item]` stays unresolvable; `some View` → `View`. */
export function baseTypeName(written: string): string {
  let name = written.trim().replace(/^(some|any|inout|borrowing|consuming)\s+/, '');
  name = name.replace(/[?!]+$/, '');
  let depth = 0;
  let result = '';
  for (const char of name) {
    if (char === '<') depth++;
    else if (char === '>') depth--;
    else if (depth === 0) result += char;
  }
  return result.replace(/\s+/g, '');
}

function parseSelector(selector: string): string[] {
  const open = selector.indexOf('(');
  const inner = selector.slice(open + 1, -1);
  return inner === '' ? [] : inner.split(':').slice(0, -1);
}

/**
 * Whether a call selector can call a declaration: labels in order, parameters
 * with default values may be skipped, an unlabeled argument (`_`) may fill a
 * closure parameter (trailing closures), and a variadic parameter takes
 * several unlabeled arguments.
 */
export function selectorMatches(callSelector: string, declaration: Declaration): boolean {
  if (callSelector === declaration.selector) return true;
  const labels = parseSelector(callSelector);
  const parameters: Parameter[] = declaration.parameters ?? [];
  let index = 0;
  for (const parameter of parameters) {
    const label = labels[index];
    const fits = label !== undefined && (label === parameter.label || (label === '_' && /->/.test(parameter.type)));
    if (fits) {
      index++;
      if (parameter.variadic) while (labels[index] === '_') index++;
      continue;
    }
    if (parameter.hasDefault || parameter.variadic) continue;
    return false;
  }
  return index === labels.length;
}
