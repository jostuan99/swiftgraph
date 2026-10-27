// Extracts the local facts of one Swift file: declarations, references and
// imports. Name resolution across files happens later (docs/01-design.md,
// sections 4 and 5).
//
// One recursive walk over the syntax tree keeps the context that queries
// cannot: the enclosing declaration, the local variables in scope with their
// types, and the conditions of enclosing `#if` branches.

import { parseSwift, type SyntaxNode } from '../parse/swift-parser.ts';
import type {
  AccessLevel,
  Assignment,
  CallSite,
  Declaration,
  DeclarationKind,
  FileFacts,
  FlowFacts,
  LocalBinding,
  Parameter,
  Range,
  Receiver,
  Reference,
  ReferenceKind,
  ValueExpr,
} from '../schema/types.ts';

/** Bump when the extracted facts change, so cached facts are re-extracted. */
export const EXTRACTOR_VERSION = 10;

const DECLARATION_KINDS: Readonly<Record<string, DeclarationKind>> = {
  class_declaration: 'class',
  struct_declaration: 'struct',
  enum_declaration: 'enum',
  actor_declaration: 'actor',
  protocol_declaration: 'protocol',
  extension_declaration: 'extension',
  function_declaration: 'function',
  init_declaration: 'initializer',
  deinit_declaration: 'deinitializer',
  subscript_declaration: 'subscript',
  typealias_declaration: 'typealias',
  associatedtype_declaration: 'associatedtype',
  macro_declaration: 'macro',
};

const ACCESS_LEVELS: ReadonlySet<string> = new Set(['open', 'public', 'package', 'internal', 'fileprivate', 'private']);

const SIGNATURE_LIMIT = 300;
const DOC_LIMIT = 2000;

interface VariableType {
  name: string;
  /** From an annotation (true) or inferred from an initializer (false). */
  explicit: boolean;
}

interface Scope {
  /** Local variables and parameters → type when known. */
  variables: Map<string, VariableType | undefined>;
  /** Local variables and parameters → id of the scope that declared them. */
  declaredIn: Map<string, number>;
  /** Id of this scope: a function, accessor or closure body (0 outside bodies). */
  id: number;
}

interface Context {
  /** Enclosing type, extension or property declaration. */
  container: number | null;
  /** Declaration that owns references found here. */
  owner: number | null;
  /** Inside a function, initializer, accessor or closure body. */
  inBody: boolean;
  scope: Scope;
  conditions: string[];
  /** Innermost call whose arguments, receiver or trailing closures contain this node. */
  call: number | null;
  /** Conditions of the enclosing `if`/`switch`/`guard` inside the body. */
  branch: string[];
  /** Innermost closure (index into `flow.closures`): its returns are its own. */
  closure: number | null;
}

export function extractSwiftFacts(source: string): FileFacts {
  const tree = parseSwift(source);
  const extractor = new Extractor();
  extractor.visit(tree.rootNode, {
    container: null,
    owner: null,
    inBody: false,
    scope: { variables: new Map(), declaredIn: new Map(), id: 0 },
    conditions: [],
    call: null,
    branch: [],
    closure: null,
  });
  return {
    version: EXTRACTOR_VERSION,
    imports: extractor.imports,
    declarations: extractor.declarations,
    references: extractor.references,
    flow: extractor.flow,
    hasErrors: tree.rootNode.hasError,
  };
}

class Extractor {
  readonly imports: string[] = [];
  readonly declarations: Declaration[] = [];
  readonly references: Reference[] = [];
  readonly flow: FlowFacts = { calls: [], closures: [], assignments: [], bindings: [], returns: [] };
  private readonly seenReferences = new Map<string, number>();
  /** Syntax node id → index in `flow.calls` / `flow.closures`. */
  private readonly callsByNode = new Map<number, number>();
  private readonly closuresByNode = new Map<number, number>();
  private nextScope = 1;

  private newScope(variables: Map<string, VariableType | undefined>, declaredIn: Map<string, number>): Scope {
    return { variables, declaredIn, id: this.nextScope++ };
  }

  visit(node: SyntaxNode, context: Context): void {
    const kind = DECLARATION_KINDS[node.type];
    if (kind) {
      this.visitDeclaration(node, kind, context);
      return;
    }

    switch (node.type) {
      case 'property_declaration':
        this.visitProperty(node, context);
        return;
      case 'enum_case_declaration':
        this.visitEnumCase(node, context);
        return;
      case 'import_declaration': {
        const name = node.childForFieldName('name')?.text;
        if (name) this.imports.push(name);
        return;
      }
      case 'if_directive':
        this.visitDirective(node, context);
        return;
      case 'call_expression':
        this.visitCall(node, context);
        return;
      case 'macro_expansion_expression': {
        const name = node.childForFieldName('name');
        if (name) this.addReference(context, 'macro', name.text.slice(1), name);
        this.visitChildren(node, context);
        return;
      }
      case 'user_type':
        this.visitType(node, context, 'type');
        return;
      case 'attribute':
        this.visitAttribute(node, context);
        return;
      case 'navigation_expression':
        this.visitNavigation(node, context);
        return;
      case 'assignment_expression':
        this.visitAssignment(node, context);
        return;
      case 'closure_expression':
        this.visitClosure(node, context);
        return;
      case 'optional_binding_condition':
        this.visitOptionalBinding(node, context);
        return;
      case 'value_binding_pattern':
        // `case .add(let item)`, `catch let error as E`: names enter the scope.
        for (const name of patternNames(node)) context.scope.variables.set(name, undefined);
        this.visitChildren(node, context);
        return;
      case 'for_statement': {
        const pattern = node.childForFieldName('pattern');
        const collection = node.childForFieldName('collection');
        if (collection) this.visitValue(collection, context);
        if (pattern) {
          for (const name of patternNames(pattern)) this.declareLocal(name, undefined, context);
          // `for item in items`: item is an element of items.
          if (pattern.type === 'simple_identifier' && collection) {
            this.addBinding(context, pattern.text, element(this.valueOf(collection, context)), pattern);
          }
        }
        for (const child of node.namedChildren) {
          if (!sameNode(child, pattern) && !sameNode(child, collection)) this.visit(child, context);
        }
        return;
      }
      case 'simple_identifier':
        this.visitIdentifier(node, context);
        return;
      case 'if_statement':
        this.visitIf(node, context);
        return;
      case 'guard_statement':
        this.visitGuard(node, context);
        return;
      case 'switch_statement':
        this.visitSwitch(node, context);
        return;
      case 'do_statement':
        this.visitDo(node, context);
        return;
      case 'return_statement':
        this.visitReturn(node, context);
        return;
      default:
        this.visitChildren(node, context);
    }
  }

  private visitChildren(node: SyntaxNode, context: Context): void {
    for (const child of node.namedChildren) this.visit(child, context);
  }

  // --- Declarations ---------------------------------------------------------

  private visitDeclaration(node: SyntaxNode, kind: DeclarationKind, context: Context): void {
    const isCallable = kind === 'function' || kind === 'initializer' || kind === 'deinitializer' || kind === 'subscript';

    // Functions nested in function bodies are local helpers, not graph nodes;
    // their references belong to the enclosing declaration.
    if (isCallable && context.inBody) {
      this.visitBody(node, context, context.owner);
      return;
    }

    const declaration = this.createDeclaration(node, kind, context);

    if (kind === 'extension') {
      declaration.extendedType = typeName(node.childForFieldName('name'));
    }
    const inheritance = node.namedChildren.find((child) => child.type === 'inheritance_clause');
    if (inheritance) {
      declaration.inherits = inheritance.namedChildren.map((type) => typeName(type) ?? type.text);
      for (const type of inheritance.namedChildren) {
        this.addReference({ ...context, owner: declaration.localId }, 'inherit', typeName(type) ?? type.text, type);
      }
    }
    if (kind === 'typealias') {
      declaration.type = compact(node.childForFieldName('value')?.text);
    }

    const childContext: Context = {
      container: declaration.localId,
      owner: declaration.localId,
      inBody: false,
      scope: { variables: new Map(), declaredIn: new Map(), id: 0 },
      conditions: context.conditions,
      call: null,
      branch: [],
      closure: null,
    };

    if (isCallable) {
      const parameters = this.parameters(node);
      declaration.parameters = parameters;
      declaration.selector = selector(
        kind === 'initializer' ? 'init' : kind === 'subscript' ? 'subscript' : declaration.name,
        parameters.map((p) => p.label),
      );
      const returnType = node.childForFieldName('return_type');
      if (returnType) declaration.returnType = compact(returnType.text);
      this.visitBody(node, { ...childContext, container: context.container }, declaration.localId);
      return;
    }

    for (const child of node.namedChildren) {
      if (child.type === 'inheritance_clause' || child.type === 'modifiers') continue;
      if (sameNode(child, node.childForFieldName('name'))) continue;
      this.visit(child, childContext);
    }
    this.visitModifiers(node, { ...context, owner: declaration.localId });
  }

  /** Visits a function-like declaration: parameters enter the scope of its body. */
  private visitBody(node: SyntaxNode, context: Context, owner: number | null): void {
    const variables = new Map(context.inBody ? context.scope.variables : []);
    const declaredIn = new Map(context.inBody ? context.scope.declaredIn : []);
    const scope = this.newScope(variables, declaredIn);
    const parameterClause = node.childForFieldName('parameters');
    for (const parameter of parameterClause?.namedChildren ?? []) {
      if (parameter.type !== 'parameter') continue;
      const name = parameter.childForFieldName('name')?.text;
      const type = typeName(parameter.childForFieldName('type'));
      if (name && name !== '_') {
        variables.set(name, type ? { name: type, explicit: true } : undefined);
        declaredIn.set(name, scope.id);
      }
    }
    const bodyContext: Context = {
      container: context.container,
      owner,
      inBody: true,
      scope,
      conditions: context.conditions,
      call: null,
      branch: [],
      closure: null,
    };
    for (const child of node.namedChildren) {
      if (child.type === 'modifiers') {
        this.visitModifiers(node, { ...bodyContext });
        continue;
      }
      if (sameNode(child, node.childForFieldName('name'))) continue;
      this.visit(child, bodyContext);
    }
    // A single-expression body returns its value.
    if (node.childForFieldName('return_type')) this.implicitReturn(node.childForFieldName('body'), bodyContext);
  }

  /** Records the value of a body made of one expression as returned. */
  private implicitReturn(body: SyntaxNode | null, context: Context): void {
    const statements = body?.namedChildren.filter((child) => child.type !== 'comment' && child.type !== 'multiline_comment') ?? [];
    if (statements.length !== 1 || !isExpression(statements[0]!)) return;
    const value = this.valueOf(statements[0]!, context);
    if (context.closure !== null) this.flow.closures[context.closure]!.returns.push(value);
    else this.flow.returns.push({ from: context.owner, value, line: statements[0]!.startPosition.row + 1 });
  }

  private visitProperty(node: SyntaxNode, context: Context): void {
    const keyword = node.children.find((child) => child.type === 'let' || child.type === 'var')?.type ?? 'var';
    const bindings = node.namedChildren.filter((child) => child.type === 'property_binding');

    if (context.inBody) {
      // Local variables: record their types for receiver hints.
      for (const binding of bindings) {
        this.visitBindingParts(binding, context);
        const type = bindingVariableType(binding);
        const names = bindingNames(binding.childForFieldName('name'));
        for (const name of names) this.declareLocal(name, type, context);
        const value = binding.childForFieldName('value');
        const annotation = binding.namedChildren.find((child) => child.type === 'type_annotation');
        const written = annotation ? compact(annotation.childForFieldName('type')?.text) : undefined;
        if (value && names.length === 1) this.addBinding(context, names[0]!, this.valueOf(value, context), binding, written);
      }
      this.visitModifiers(node, context);
      return;
    }

    for (const binding of bindings) {
      const nameNode = binding.childForFieldName('name');
      for (const name of bindingNames(nameNode)) {
        const declaration = this.createDeclaration(node, 'property', context, name, binding);
        const annotation = binding.namedChildren.find((child) => child.type === 'type_annotation');
        const type = annotation ? compact(annotation.childForFieldName('type')?.text) : undefined;
        if (type) {
          declaration.type = type;
        } else {
          const inferred = bindingType(binding);
          if (inferred) declaration.inferredType = inferred;
          const chain = inferred ? undefined : memberChain(binding.childForFieldName('value'));
          if (chain) declaration.initializerChain = chain;
        }
        declaration.signature = `${keyword} ${name}${type ? `: ${type}` : ''}`;
        declaration.isComputed = binding.childForFieldName('value') === null && binding.childForFieldName('accessors') !== null;
        const ownerContext: Context = {
          container: context.container,
          owner: declaration.localId,
          inBody: true,
          scope: this.newScope(new Map(), new Map()),
          conditions: context.conditions,
          call: null,
          branch: [],
          closure: null,
        };
        this.visitBindingParts(binding, ownerContext);
        this.visitModifiers(node, ownerContext);
        const value = binding.childForFieldName('value');
        if (value) {
          // A stored property with an initial value: `@Published var state: State = .login`.
          this.flow.assignments.push({
            from: declaration.localId,
            target: { kind: 'path', root: { kind: 'self' }, members: [name] },
            value: this.valueOf(value, ownerContext),
            operator: '=',
            branch: [],
            line: value.startPosition.row + 1,
          });
        } else if (declaration.isComputed) {
          this.implicitReturn(binding.childForFieldName('accessors'), ownerContext);
        }
      }
    }
  }

  private visitBindingParts(binding: SyntaxNode, context: Context): void {
    const nameNode = binding.childForFieldName('name');
    for (const child of binding.namedChildren) {
      if (sameNode(child, nameNode)) continue;
      if (sameNode(child, binding.childForFieldName('value'))) {
        this.visitValue(child, context);
      } else {
        this.visit(child, context);
      }
    }
  }

  private visitEnumCase(node: SyntaxNode, context: Context): void {
    for (const element of node.namedChildren.filter((child) => child.type === 'enum_case_element')) {
      const name = element.childForFieldName('name')?.text;
      if (!name) continue;
      const declaration = this.createDeclaration(node, 'enum_case', context, name, element);
      declaration.signature = `case ${compact(element.text)}`;
      const associated = element.childForFieldName('associated_values');
      if (associated) this.visit(associated, { ...context, owner: declaration.localId });
    }
  }

  private createDeclaration(
    node: SyntaxNode,
    kind: DeclarationKind,
    context: Context,
    explicitName?: string,
    rangeNode: SyntaxNode = node,
  ): Declaration {
    const modifiers = node.namedChildren.find((child) => child.type === 'modifiers');
    const modifierWords = modifiers
      ? modifiers.namedChildren.filter((child) => child.type === 'modifier').map((child) => compact(child.text)!)
      : [];
    const attributes = modifiers
      ? modifiers.namedChildren
          .filter((child) => child.type === 'attribute')
          .map((child) => typeName(child.childForFieldName('name')) ?? child.text)
      : [];
    const access = modifierWords.map((word) => word.replace(/\(set\)$/, '')).find((word) => ACCESS_LEVELS.has(word)) as
      AccessLevel | undefined;

    const name = explicitName ?? declarationName(node, kind);
    const declaration: Declaration = {
      localId: this.declarations.length,
      parent: context.container,
      kind,
      name,
      selector: name,
      signature: signature(node),
      access: access ?? null,
      modifiers: modifierWords,
      attributes,
      range: range(rangeNode),
      doc: docComment(node),
      conditions: context.conditions,
    };
    if (modifierWords.includes('static') || modifierWords.includes('class')) declaration.isStatic = true;
    const typeParameters = node.namedChildren.find((child) => child.type === 'type_parameters');
    const generics = (typeParameters?.namedChildren ?? [])
      .filter((child) => child.type === 'type_parameter')
      .map((child) => child.childForFieldName('name')?.text)
      .filter((name): name is string => name !== undefined);
    if (generics.length > 0) declaration.genericParameters = generics;
    const constraints = genericConstraints(node);
    if (constraints) declaration.genericConstraints = constraints;
    this.declarations.push(declaration);
    return declaration;
  }

  private parameters(node: SyntaxNode): Parameter[] {
    const clause = node.childForFieldName('parameters');
    if (!clause) return [];
    const isSubscript = node.type === 'subscript_declaration';
    return clause.namedChildren
      .filter((child) => child.type === 'parameter')
      .map((parameter) => {
        const name = parameter.childForFieldName('name')?.text ?? '_';
        const external = parameter.childForFieldName('external_name')?.text;
        // Subscript parameters have no argument label unless one is written.
        const label = external ?? (isSubscript ? '_' : name);
        const result: Parameter = { label, name, type: compact(parameter.childForFieldName('type')?.text) ?? '' };
        if (parameter.childForFieldName('default_value')) result.hasDefault = true;
        if (parameter.children.some((child) => child.type === '...')) result.variadic = true;
        return result;
      });
  }

  private visitModifiers(node: SyntaxNode, context: Context): void {
    const modifiers = node.namedChildren.find((child) => child.type === 'modifiers');
    if (modifiers) this.visitChildren(modifiers, context);
  }

  private visitAttribute(node: SyntaxNode, context: Context): void {
    const name = typeName(node.childForFieldName('name'));
    if (name) this.addReference(context, 'attribute', name, node);
    for (const child of node.namedChildren) {
      if (child.type === 'attribute_argument') this.visitChildren(child, context);
    }
  }

  // --- Compiler directives ----------------------------------------------------

  private visitDirective(node: SyntaxNode, context: Context): void {
    const target = node.childForFieldName('target');
    if (target) this.visit(target, context);

    const previous: string[] = [];
    let current: string | null = null;
    for (const child of node.children) {
      if (sameNode(child, target)) continue;
      if (child.type === '#if' || child.type === '#elseif' || child.type === '#endif') continue;
      if (child.type === '#else') {
        current = `!(${previous.join(' || ')})`;
        continue;
      }
      if (node.childrenForFieldName('condition').some((condition) => condition.id === child.id)) {
        const condition = compact(child.text)!;
        current = previous.length === 0 ? condition : `!(${previous.join(' || ')}) && ${condition}`;
        previous.push(condition);
        continue;
      }
      if (!child.isNamed) continue;
      this.visit(child, { ...context, conditions: current ? [...context.conditions, current] : context.conditions });
    }
  }

  // --- References ---------------------------------------------------------

  private visitCall(node: SyntaxNode, context: Context): void {
    const callee = node.childForFieldName('function');
    const argumentsNode = node.childForFieldName('arguments');
    const trailing = node.childForFieldName('trailing_closures');
    const labels = [...argumentLabels(argumentsNode), ...trailingClosureLabels(trailing)];

    const target = callee ? this.callTarget(callee, context) : undefined;
    // `a.b().c()`: a call through a member sits at the member name, not at the start of the chain.
    const position = callee ? memberPosition(callee) : node;
    const site: CallSite = {
      from: context.owner,
      name: target?.name ?? '',
      selector: target ? selector(target.name, labels) : '',
      reference: -1,
      parent: context.call,
      closure: context.closure,
      arguments: [],
      branch: context.branch,
      line: position.startPosition.row + 1,
      column: position.startPosition.column + 1,
    };
    if (isAwaited(node)) site.await = true;
    const attempt = triedWith(node);
    if (attempt) site.try = attempt;
    const index = this.flow.calls.length;
    this.flow.calls.push(site);
    this.callsByNode.set(node.id, index);
    const inner: Context = { ...context, call: index };

    if (callee) {
      if (target) {
        site.reference = this.addReference(context, 'call', target.name, memberPosition(callee), {
          selector: site.selector,
          receiver: target.receiver,
        });
        this.localizationUsage(target.name, target.receiver, argumentsNode, context, callee);
      }
      this.visitCallee(callee, inner);
    }
    if (argumentsNode) this.visitArguments(argumentsNode, inner);
    if (trailing) this.visit(trailing, inner);

    // Values are read after the visit: nested calls and closures have their indexes then.
    if (callee?.type === 'navigation_expression') {
      const receiverNode = callee.childForFieldName('target');
      if (receiverNode) site.receiver = this.valueOf(receiverNode, context);
    }
    for (const argument of argumentsNode?.namedChildren ?? []) {
      if (argument.type !== 'value_argument') continue;
      const value = argument.childForFieldName('value');
      if (value) site.arguments.push({ label: argument.childForFieldName('name')?.text ?? '_', value: this.valueOf(value, context) });
    }
    if (trailing) {
      const trailingLabels = trailingClosureLabels(trailing);
      trailing.namedChildren
        .filter((child) => child.type === 'closure_expression')
        .forEach((closure, position) => {
          site.arguments.push({ label: trailingLabels[position] ?? '_', value: this.valueOf(closure, context) });
        });
    }
  }

  private callTarget(callee: SyntaxNode, context: Context): { name: string; receiver: Receiver } | undefined {
    switch (callee.type) {
      case 'simple_identifier':
        return { name: callee.text, receiver: { kind: 'none' } };
      case 'self_expression':
        return { name: 'init', receiver: { kind: 'self' } };
      case 'super_expression':
        return { name: 'init', receiver: { kind: 'super' } };
      case 'generic_specialization_expression': {
        const name = callee.childForFieldName('name');
        return name?.type === 'simple_identifier' ? { name: name.text, receiver: { kind: 'none' } } : undefined;
      }
      case 'implicit_member_expression': {
        const member = callee.childForFieldName('member')?.text;
        return member ? { name: member, receiver: { kind: 'implicit' } } : undefined;
      }
      case 'navigation_expression': {
        const member = callee.childForFieldName('member');
        const target = callee.childForFieldName('target');
        if (!member || !target || member.type !== 'simple_identifier') return undefined;
        return { name: member.text, receiver: this.receiver(target, context) };
      }
      default:
        return undefined;
    }
  }

  /** Describes the expression a member is accessed on. */
  private receiver(target: SyntaxNode, context: Context): Receiver {
    const unwrapped = optionalOperand(target);
    if (unwrapped) return this.receiver(unwrapped, context);
    switch (target.type) {
      case 'self_expression':
        return { kind: 'self' };
      case 'super_expression':
        return { kind: 'super' };
      case 'simple_identifier': {
        const name = target.text;
        if (name.startsWith('$')) return { kind: 'variable', name };
        if (context.scope.variables.has(name)) {
          const type = context.scope.variables.get(name);
          return type ? { kind: 'variable', name, typeHint: type.name, explicit: type.explicit } : { kind: 'variable', name };
        }
        if (isTypeName(name)) return { kind: 'type', name };
        return { kind: 'self_member', name };
      }
      case 'generic_specialization_expression': {
        const name = target.childForFieldName('name');
        return name?.type === 'simple_identifier' ? { kind: 'type', name: name.text } : { kind: 'expression' };
      }
      case 'navigation_expression': {
        const inner = target.childForFieldName('target');
        const member = target.childForFieldName('member')?.text;
        if (!inner || !member) return { kind: 'expression' };
        if (inner.type === 'self_expression') return { kind: 'self_member', name: member };
        if (inner.type === 'simple_identifier' && isTypeName(inner.text) && !context.scope.variables.has(inner.text)) {
          // `Foo.Bar.make()`: a nested type, or a static member of Foo.
          return isTypeName(member)
            ? { kind: 'type', name: `${inner.text}.${member}` }
            : { kind: 'type_member', type: inner.text, name: member };
        }
        return { kind: 'expression' };
      }
      case 'call_expression': {
        const callee = target.childForFieldName('function');
        const name =
          callee?.type === 'simple_identifier'
            ? callee.text
            : callee?.type === 'generic_specialization_expression'
              ? callee.childForFieldName('name')?.text
              : undefined;
        return name && isTypeName(name) ? { kind: 'instance', type: name } : { kind: 'expression' };
      }
      default:
        return { kind: 'expression' };
    }
  }

  /** Visits the callee without recording the called member as a read. */
  private visitCallee(callee: SyntaxNode, context: Context): void {
    if (callee.type === 'simple_identifier') return;
    if (callee.type === 'navigation_expression') {
      const target = callee.childForFieldName('target');
      if (target) this.visitValue(target, context);
      return;
    }
    if (callee.type === 'implicit_member_expression') return;
    this.visit(callee, context);
  }

  private visitArguments(argumentsNode: SyntaxNode, context: Context): void {
    for (const argument of argumentsNode.namedChildren) {
      if (argument.type !== 'value_argument') continue;
      const value = argument.childForFieldName('value');
      if (value) this.visitValue(value, context);
    }
  }

  /** Records the localization key of NSLocalizedString, String(localized:), SwiftUI views, ... */
  private localizationUsage(
    name: string,
    receiver: Receiver,
    argumentsNode: SyntaxNode | null,
    context: Context,
    position: SyntaxNode,
  ): void {
    const argumentsList = argumentsNode?.namedChildren.filter((child) => child.type === 'value_argument') ?? [];
    const labeled = (label: string) => argumentsList.find((argument) => argument.childForFieldName('name')?.text === label);
    const first = argumentsList[0];
    const firstUnlabeled = first && !first.childForFieldName('name') ? first : undefined;

    let keyArgument: SyntaxNode | undefined;
    let tableLabel = 'tableName';
    let kind: 'explicit' | 'swiftui';
    if (receiver.kind === 'none' && name === 'NSLocalizedString') {
      keyArgument = firstUnlabeled;
      kind = 'explicit';
    } else if (receiver.kind === 'none' && name === 'String' && labeled('localized')) {
      keyArgument = labeled('localized');
      tableLabel = 'table';
      kind = 'explicit';
    } else if (receiver.kind === 'none' && (name === 'LocalizedStringResource' || name === 'LocalizedStringKey')) {
      keyArgument = firstUnlabeled;
      tableLabel = 'table';
      kind = 'explicit';
    } else if (
      (receiver.kind === 'none' && SWIFTUI_LOCALIZED_VIEWS.has(name)) ||
      (receiver.kind !== 'none' && receiver.kind !== 'type' && SWIFTUI_LOCALIZED_MODIFIERS.has(name))
    ) {
      keyArgument = firstUnlabeled;
      kind = 'swiftui';
      // A non-literal first argument of a view is a plain String, not a key.
      const literal = keyArgument?.childForFieldName('value');
      if (literal?.type !== 'line_string_literal') return;
    } else {
      return;
    }

    const value = keyArgument?.childForFieldName('value');
    const tableValue = labeled(tableLabel)?.childForFieldName('value');
    const table = tableValue ? literalText(tableValue, context) : undefined;
    const extra: { table?: string; localization: 'explicit' | 'swiftui' | 'dynamic' } = { localization: kind };
    if (table !== undefined && !table.includes('%?')) extra.table = table;
    const key = value ? literalText(value, context) : undefined;
    if (key === undefined) {
      if (kind === 'explicit') this.addReference(context, 'string', '', position, { localization: 'dynamic' });
      return;
    }
    this.addReference(context, 'string', key, value ?? position, extra);
  }

  private visitNavigation(node: SyntaxNode, context: Context): void {
    const target = node.childForFieldName('target');
    const member = node.childForFieldName('member');
    if (target && member?.type === 'simple_identifier') {
      if (target.type === 'self_expression') {
        this.addReference(context, 'read', member.text, member, { receiver: { kind: 'self' } });
      } else {
        const receiver = this.receiver(target, context);
        if (receiver.kind !== 'expression') this.addReference(context, 'read', member.text, member, { receiver });
      }
    }
    if (target) this.visitValue(target, context);
  }

  private visitAssignment(node: SyntaxNode, context: Context): void {
    const target = node.childForFieldName('target');
    const value = node.childForFieldName('value');
    if (target?.type === 'navigation_expression') {
      const inner = target.childForFieldName('target');
      const member = target.childForFieldName('member');
      if (inner && member?.type === 'simple_identifier') {
        const receiver = this.receiver(inner, context);
        this.addReference(context, 'write', member.text, member, { receiver });
        if (inner.type !== 'self_expression') this.visitValue(inner, context);
      }
    } else if (target?.type === 'simple_identifier') {
      if (!context.scope.variables.has(target.text)) {
        this.addReference(context, 'write', target.text, target, { receiver: { kind: 'none' } });
      }
    } else if (target) {
      this.visit(target, context);
    }
    if (value) this.visitValue(value, context);
    if (target && value) {
      const assignment: Assignment = {
        from: context.owner,
        target: this.valueOf(target, context),
        value: this.valueOf(value, context),
        operator: node.childForFieldName('operator')?.text ?? '=',
        branch: context.branch,
        line: node.startPosition.row + 1,
      };
      if (context.closure !== null) assignment.closure = context.closure;
      this.flow.assignments.push(assignment);
    }
  }

  /** Visits an expression in value position: a bare identifier is a read. */
  private visitValue(node: SyntaxNode, context: Context): void {
    if (node.type === 'simple_identifier') {
      this.readIdentifier(node, context);
    } else {
      this.visit(node, context);
    }
  }

  private visitIdentifier(node: SyntaxNode, context: Context): void {
    // Identifiers reached through the generic walk are operands of
    // expressions (binary, prefix, return, conditions, collection elements).
    const parent = node.parent;
    if (!parent) return;
    if (VALUE_PARENTS.has(parent.type)) this.readIdentifier(node, context);
  }

  private readIdentifier(node: SyntaxNode, context: Context): void {
    const name = node.text;
    if (context.scope.variables.has(name) || name.startsWith('$')) return;
    if (isTypeName(name)) {
      this.addReference(context, 'type', name, node);
      return;
    }
    this.addReference(context, 'read', name, node, { receiver: { kind: 'none' } });
  }

  private visitType(node: SyntaxNode, context: Context, kind: ReferenceKind): void {
    const name = typeName(node);
    if (name) this.addReference(context, kind, name, node);
    // Generic arguments and an array/dictionary base hold further types.
    for (const child of node.namedChildren) {
      if (child.type !== 'type_identifier') this.visit(child, context);
    }
  }

  private visitClosure(node: SyntaxNode, context: Context): void {
    const variables = new Map(context.scope.variables);
    const declaredIn = new Map(context.scope.declaredIn);
    const scope = this.newScope(variables, declaredIn);
    const signature = node.namedChildren.find((child) => child.type === 'closure_signature');
    const parameters: string[] = [];
    for (const parameter of signature?.descendantsOfType('closure_parameter') ?? []) {
      // Shorthand parameters (`{ a, b in }`) have no `name` field.
      const name = (parameter.childForFieldName('name') ?? parameter.namedChildren[0])?.text;
      const type = typeName(parameter.childForFieldName('type'));
      parameters.push(name ?? '_');
      if (name && name !== '_') {
        variables.set(name, type ? { name: type, explicit: true } : undefined);
        declaredIn.set(name, scope.id);
      }
    }
    if (!signature?.descendantsOfType('closure_parameter').length) {
      // `{ $0.id }`: as many parameters as the highest shorthand name used.
      const used = node.descendantsOfType('simple_identifier').map((child) => /^\$(\d+)$/.exec(child.text)?.[1]);
      const highest = Math.max(-1, ...used.filter((digits) => digits !== undefined).map(Number));
      for (let index = 0; index <= highest; index++) parameters.push(`$${index}`);
    }
    for (const item of signature?.descendantsOfType('capture_list_item') ?? []) {
      const name = item.namedChildren.find((child) => child.type === 'simple_identifier')?.text;
      if (name) {
        variables.set(name, undefined);
        declaredIn.set(name, scope.id);
      }
    }
    const index = this.flow.closures.length;
    this.flow.closures.push({ scope: scope.id, call: context.call, parent: context.closure, parameters, returns: [] });
    this.closuresByNode.set(node.id, index);
    // The closure is only created when the enclosing conditions hold.
    const closureContext: Context = { ...context, inBody: true, scope, call: null, closure: index };
    for (const child of node.namedChildren) this.visit(child, closureContext);
    const statements = node.namedChildren.filter((child) => child.type !== 'closure_signature');
    if (statements.length === 1 && isExpression(statements[0]!)) {
      this.flow.closures[index]!.returns.push(this.valueOf(statements[0]!, closureContext));
    }
  }

  private visitOptionalBinding(node: SyntaxNode, context: Context): void {
    const value = node.childForFieldName('value');
    if (value) this.visitValue(value, context);
    const annotation = node.namedChildren.find((child) => child.type === 'type_annotation');
    if (annotation) this.visit(annotation, context);
    const annotated = annotation ? typeName(annotation.childForFieldName('type')) : undefined;
    let type: VariableType | undefined = annotated ? { name: annotated, explicit: true } : undefined;
    if (!type && value?.type === 'cast_expression') {
      const cast = typeName(value.childForFieldName('type'));
      if (cast) type = { name: cast, explicit: true };
    }
    if (!type && value?.type === 'simple_identifier') type = context.scope.variables.get(value.text);
    const names = bindingNames(node.childForFieldName('name'));
    // `if let x { }` shadows x with its own (unwrapped) type.
    const shorthand = value === null && names.length === 1 ? this.valueOf(node.childForFieldName('name')!, context) : undefined;
    for (const name of names) this.declareLocal(name, type ?? context.scope.variables.get(name), context);
    if (names.length === 1) {
      const bound = value ? this.valueOf(value, context) : shorthand;
      if (bound) this.addBinding(context, names[0]!, bound, node);
    }
  }

  // --- Data flow ------------------------------------------------------------

  private declareLocal(name: string, type: VariableType | undefined, context: Context): void {
    context.scope.variables.set(name, type);
    context.scope.declaredIn.set(name, context.scope.id);
  }

  private addBinding(context: Context, name: string, value: ValueExpr, node: SyntaxNode, type?: string): void {
    const binding: LocalBinding = { from: context.owner, scope: context.scope.id, name, value, line: node.startPosition.row + 1 };
    if (type) binding.type = type;
    this.flow.bindings.push(binding);
  }

  private visitIf(node: SyntaxNode, context: Context): void {
    const conditions = node.childrenForFieldName('condition');
    for (const condition of conditions) this.visit(condition, context);
    const text = conditions.map((condition) => compact(condition.text, CONDITION_LIMIT)!).join(', ');
    const consequence = node.childForFieldName('consequence');
    const alternative = node.childForFieldName('alternative');
    if (consequence) this.visit(consequence, { ...context, branch: [...context.branch, text] });
    if (alternative) this.visit(alternative, { ...context, branch: [...context.branch, `!(${text})`] });
  }

  private visitGuard(node: SyntaxNode, context: Context): void {
    const conditions = node.childrenForFieldName('condition');
    for (const condition of conditions) this.visit(condition, context);
    const text = conditions.map((condition) => compact(condition.text, CONDITION_LIMIT)!).join(', ');
    const body = node.childForFieldName('body');
    if (body) this.visit(body, { ...context, branch: [...context.branch, `!(${text})`] });
  }

  private visitSwitch(node: SyntaxNode, context: Context): void {
    const subject = node.childForFieldName('value');
    if (subject) this.visitValue(subject, context);
    const subjectText = compact(subject?.text, CONDITION_LIMIT) ?? '';
    for (const entry of node.namedChildren.filter((child) => child.type === 'switch_case')) {
      const patterns = entry.namedChildren.filter((child) => child.type === 'switch_pattern').map((pattern) => compact(pattern.text)!);
      const text = patterns.length > 0 ? `${subjectText} ~ ${patterns.join(' | ')}` : `${subjectText} ~ default`;
      for (const child of entry.namedChildren) {
        if (child.type === 'switch_pattern' || child.type === 'default_keyword') {
          this.visitChildren(child, context);
        } else {
          this.visit(child, { ...context, branch: [...context.branch, text] });
        }
      }
    }
  }

  /**
   * `do { … } catch let e as APIError { … } catch { … }`: each catch block is a
   * branch (`catch`, `catch let e as APIError`) whose error binding stands for
   * the calls marked `try` in the `do` body.
   */
  private visitDo(node: SyntaxNode, context: Context): void {
    const body = node.childForFieldName('body');
    if (body) this.visit(body, context);
    const thrown: ValueExpr[] = (body?.descendantsOfType('try_expression') ?? [])
      .filter((attempt) => !/^try\s*[?!]/.test(attempt.text))
      .map((attempt) => attempt.childForFieldName('expression') ?? attempt.namedChildren.at(-1))
      .filter((expression): expression is SyntaxNode => expression !== null && expression !== undefined)
      .map((expression) => this.valueOf(expression, context))
      .filter((value) => value.kind === 'call' || (value.kind === 'path' && value.root.kind === 'call'));
    for (const block of node.namedChildren.filter((child) => child.type === 'catch_block')) {
      const blockBody = block.childForFieldName('body');
      const pattern = block.namedChildren.find((child) => !sameNode(child, blockBody) && child.type !== 'comment');
      const text = pattern ? `catch ${compact(pattern.text, CONDITION_LIMIT)}` : 'catch';
      const scope = this.newScope(new Map(context.scope.variables), new Map(context.scope.declaredIn));
      const inner: Context = { ...context, scope, branch: [...context.branch, text] };
      const cast = pattern?.descendantsOfType('cast_expression')[0];
      const type = cast ? typeName(cast.childForFieldName('type')) : undefined;
      const castName = cast?.childForFieldName('value');
      const names = castName?.type === 'simple_identifier' ? [castName.text] : pattern ? patternNames(pattern) : ['error'];
      for (const name of names) {
        this.declareLocal(name, type ? { name: type, explicit: true } : undefined, inner);
        this.addBinding(inner, name, { kind: 'compound', text, operands: thrown }, block, type);
      }
      if (blockBody) this.visit(blockBody, inner);
    }
  }

  private visitReturn(node: SyntaxNode, context: Context): void {
    this.visitChildren(node, context);
    const valueNode = node.namedChildren.find((child) => child.type !== 'comment');
    if (!valueNode) return;
    const value = this.valueOf(valueNode, context);
    if (context.closure !== null) this.flow.closures[context.closure]!.returns.push(value);
    else this.flow.returns.push({ from: context.owner, value, line: node.startPosition.row + 1 });
  }

  /** The value an expression stands for (docs/05-data-flow.md, section 7). */
  private valueOf(node: SyntaxNode, context: Context): ValueExpr {
    switch (node.type) {
      case 'simple_identifier': {
        const name = node.text;
        if (name.startsWith('$') && !/^\$\d+$/.test(name)) return { ...this.path(name.slice(1), context), binding: true };
        return this.path(name, context);
      }
      case 'self_expression':
        return { kind: 'path', root: { kind: 'self' }, members: [] };
      case 'navigation_expression': {
        const target = node.childForFieldName('target');
        const member = node.childForFieldName('member');
        if (!target || member?.type !== 'simple_identifier') break;
        const base = this.valueOf(target, context);
        if (base.kind === 'path') return { ...base, members: [...base.members, member.text] };
        if (base.kind === 'call') return { kind: 'path', root: { kind: 'call', call: base.call }, members: [member.text] };
        break;
      }
      case 'postfix_expression': {
        const operand = optionalOperand(node);
        if (operand) return this.valueOf(operand, context);
        break;
      }
      case 'subscript_expression': {
        const base = node.namedChildren[0];
        const value = base ? this.valueOf(base, context) : undefined;
        if (value?.kind === 'path') return { ...value, members: [...value.members, '[]'] };
        break;
      }
      case 'call_expression': {
        const call = this.callsByNode.get(node.id);
        if (call !== undefined) return { kind: 'call', call };
        break;
      }
      case 'closure_expression': {
        const closure = this.closuresByNode.get(node.id);
        if (closure !== undefined) return { kind: 'closure', closure };
        break;
      }
      case 'implicit_member_expression': {
        const member = node.childForFieldName('member')?.text;
        if (member) return { kind: 'case', name: member };
        break;
      }
      case 'line_string_literal':
      case 'multi_line_string_literal': {
        const interpolations = node.namedChildren.filter((child) => child.type === 'interpolation');
        if (interpolations.length === 0) return { kind: 'literal', type: 'String', value: stringValue(node) };
        const operands = interpolations.flatMap((part) =>
          part.namedChildren
            .filter((child) => child.type === 'value_argument')
            .map((argument) => argument.childForFieldName('value'))
            .filter((value): value is SyntaxNode => value !== null)
            .map((value) => this.valueOf(value, context)),
        );
        return { kind: 'compound', text: compact(node.text, VALUE_TEXT_LIMIT)!, operands };
      }
      case 'integer_literal':
      case 'hex_literal':
      case 'oct_literal':
      case 'bin_literal':
        return { kind: 'literal', type: 'Int', value: node.text };
      case 'real_literal':
        return { kind: 'literal', type: 'Double', value: node.text };
      case 'boolean_literal':
        return { kind: 'literal', type: 'Bool', value: node.text };
      case 'nil':
        return { kind: 'literal', type: 'nil', value: 'nil' };
      case 'try_expression':
      case 'await_expression':
      case 'parenthesized_expression': {
        const inner = node.childForFieldName('expression') ?? node.namedChildren[0];
        if (inner) return this.valueOf(inner, context);
        break;
      }
    }
    return {
      kind: 'compound',
      text: compact(node.text, VALUE_TEXT_LIMIT)!,
      operands: node.namedChildren.filter(isExpression).map((child) => this.valueOf(child, context)),
    };
  }

  /** A name in value position: a local, a type, or a member of self. */
  private path(name: string, context: Context): Extract<ValueExpr, { kind: 'path' }> {
    if (context.scope.variables.has(name) || /^\$\d+$/.test(name)) {
      const scope = context.scope.declaredIn.get(name) ?? context.scope.id;
      return { kind: 'path', root: { kind: 'local', name, scope }, members: [] };
    }
    if (isTypeName(name)) return { kind: 'path', root: { kind: 'type', name }, members: [] };
    return { kind: 'path', root: { kind: 'self' }, members: [name] };
  }

  private addReference(
    context: Context,
    kind: ReferenceKind,
    name: string,
    node: SyntaxNode,
    extra: { selector?: string; receiver?: Receiver; table?: string; localization?: Reference['localization'] } = {},
  ): number {
    const line = node.startPosition.row + 1;
    const column = node.startPosition.column + 1;
    const key = `${context.owner}|${kind}|${name}|${extra.selector ?? ''}|${line}|${column}`;
    const seen = this.seenReferences.get(key);
    if (seen !== undefined) return seen;
    this.seenReferences.set(key, this.references.length);
    const reference: Reference = { from: context.owner, kind, name, line, column };
    if (extra.selector !== undefined) reference.selector = extra.selector;
    if (extra.receiver !== undefined) reference.receiver = extra.receiver;
    if (extra.table !== undefined) reference.table = extra.table;
    if (extra.localization !== undefined) reference.localization = extra.localization;
    this.references.push(reference);
    return this.references.length - 1;
  }
}

/** Parents whose identifier children are values (operands), not names. */
const VALUE_PARENTS: ReadonlySet<string> = new Set([
  'binary_expression',
  'prefix_expression',
  'postfix_expression',
  'ternary_expression',
  'return_statement',
  'throw_statement',
  'condition_list',
  'array_literal',
  'dictionary_element',
  'tuple_expression',
  'subscript_expression',
  'cast_expression',
  'check_expression',
  'try_expression',
  'await_expression',
  'switch_statement',
  'yield_statement',
  'interpolation',
]);

/** SwiftUI views whose first unlabeled String literal is a LocalizedStringKey. */
const SWIFTUI_LOCALIZED_VIEWS: ReadonlySet<string> = new Set([
  'Text',
  'Button',
  'Label',
  'Toggle',
  'Link',
  'NavigationLink',
  'TextField',
  'SecureField',
  'Picker',
  'Menu',
  'Stepper',
  'DatePicker',
  'ColorPicker',
  'Section',
  'GroupBox',
  'LabeledContent',
  'ProgressView',
  'Tab',
  'ShareLink',
  'ControlGroup',
  'DisclosureGroup',
  'ContentUnavailableView',
  'Gauge',
  'MultiDatePicker',
]);

/** SwiftUI modifiers whose first unlabeled String literal is a LocalizedStringKey. */
const SWIFTUI_LOCALIZED_MODIFIERS: ReadonlySet<string> = new Set([
  'navigationTitle',
  'navigationSubtitle',
  'alert',
  'confirmationDialog',
  'help',
  'accessibilityLabel',
  'accessibilityHint',
  'accessibilityValue',
  'badge',
  'searchable',
  'keyboardShortcut',
  'contextMenu',
]);

const FORMAT_FOR_TYPE: Readonly<Record<string, string>> = {
  String: '%@',
  Substring: '%@',
  NSString: '%@',
  Character: '%@',
  URL: '%@',
  Date: '%@',
  Int: '%lld',
  Int8: '%lld',
  Int16: '%lld',
  Int32: '%lld',
  Int64: '%lld',
  UInt: '%llu',
  UInt8: '%llu',
  UInt16: '%llu',
  UInt32: '%llu',
  UInt64: '%llu',
  Double: '%lf',
  CGFloat: '%lf',
  Float: '%f',
};

const STRING_ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', "'": "'", '\\': '\\' };

/**
 * Text of a string literal as a localization key: escapes decoded and each
 * interpolation replaced by the format specifier of its type (`%?` when the
 * type is unknown). Undefined for anything but a single-line literal.
 */
function literalText(node: SyntaxNode, context: Context): string | undefined {
  if (node.type !== 'line_string_literal') return undefined;
  let text = '';
  for (const part of node.namedChildren) {
    if (part.type === 'string_content') {
      text += part.text;
    } else if (part.type === 'escape_sequence') {
      const escaped = part.text.slice(1);
      const unicode = /^u\{([0-9a-fA-F]+)\}$/.exec(escaped);
      text += unicode ? String.fromCodePoint(Number.parseInt(unicode[1]!, 16)) : (STRING_ESCAPES[escaped] ?? escaped);
    } else if (part.type === 'interpolation') {
      const argumentsList = part.namedChildren.filter((child) => child.type === 'value_argument');
      const value =
        argumentsList.length === 1 && !argumentsList[0]!.childForFieldName('name') ? argumentsList[0]!.childForFieldName('value') : null;
      let format = '%?';
      if (value?.type === 'integer_literal') format = '%lld';
      else if (value?.type === 'real_literal') format = '%lf';
      else if (value?.type === 'line_string_literal') format = '%@';
      else if (value?.type === 'simple_identifier') {
        const type = context.scope.variables.get(value.text)?.name;
        if (type && FORMAT_FOR_TYPE[type]) format = FORMAT_FOR_TYPE[type];
      }
      text += format;
    }
  }
  return text;
}

// --- Helpers -----------------------------------------------------------------

const CONDITION_LIMIT = 200;
const VALUE_TEXT_LIMIT = 120;

/** Statement nodes; any other named node in a body is an expression. */
const STATEMENT_TYPES: ReadonlySet<string> = new Set([
  'if_statement',
  'guard_statement',
  'switch_statement',
  'for_statement',
  'while_statement',
  'repeat_while_statement',
  'do_statement',
  'return_statement',
  'throw_statement',
  'control_transfer_statement',
  'property_declaration',
  'assignment_expression',
  'function_declaration',
  'class_declaration',
  'struct_declaration',
  'enum_declaration',
  'typealias_declaration',
  'statement_label',
  'comment',
  'multiline_comment',
  'value_arguments',
  'type_annotation',
  'user_type',
  'type_identifier',
  'closure_signature',
  'value_argument',
  'simple_identifier_list',
  'modifiers',
]);

function isExpression(node: SyntaxNode): boolean {
  return node.isNamed && !STATEMENT_TYPES.has(node.type) && !node.type.endsWith('_type') && !node.type.endsWith('_declaration');
}

/** `x?` / `x!` (optional chaining, force unwrap): the operand x. */
function optionalOperand(node: SyntaxNode): SyntaxNode | undefined {
  if (node.type !== 'postfix_expression') return undefined;
  const operator = node.children.find((child) => !child.isNamed)?.type;
  if (operator !== '?' && operator !== '!') return undefined;
  return node.childForFieldName('operand') ?? undefined;
}

/** An element of a collection value: `items[]`. */
function element(value: ValueExpr): ValueExpr {
  return value.kind === 'path' ? { ...value, members: [...value.members, '[]'] } : { kind: 'compound', text: 'element', operands: [value] };
}

/** True when the call is (part of) an awaited expression in the same statement. */
/** `try` (thrown to the caller), `try?` (error ignored) or `try!` (crash on error) marking a call. */
function triedWith(node: SyntaxNode): 'try' | 'try?' | 'try!' | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'try_expression') {
      const match = /^try\s*([?!])?/.exec(current.text);
      return match?.[1] === '?' ? 'try?' : match?.[1] === '!' ? 'try!' : 'try';
    }
    if (!['navigation_expression', 'call_expression', 'await_expression', 'postfix_expression'].includes(current.type)) return undefined;
  }
  return undefined;
}

function isAwaited(node: SyntaxNode): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'await_expression') return true;
    if (
      current.type !== 'navigation_expression' &&
      current.type !== 'call_expression' &&
      current.type !== 'try_expression' &&
      current.type !== 'postfix_expression'
    ) {
      return false;
    }
  }
  return false;
}

/** Text of a string literal without interpolation, escapes decoded. */
function stringValue(node: SyntaxNode): string {
  let text = '';
  for (const part of node.namedChildren) {
    if (part.type === 'string_content' || part.type === 'multi_line_str_text') text += part.text;
    else if (part.type === 'escape_sequence') {
      const escaped = part.text.slice(1);
      const unicode = /^u\{([0-9a-fA-F]+)\}$/.exec(escaped);
      text += unicode ? String.fromCodePoint(Number.parseInt(unicode[1]!, 16)) : (STRING_ESCAPES[escaped] ?? escaped);
    }
  }
  return text;
}

/** node-tree-sitter returns a new object for every node access; compare ids. */
function sameNode(a: SyntaxNode | null | undefined, b: SyntaxNode | null | undefined): boolean {
  return a != null && b != null && a.id === b.id;
}

function declarationName(node: SyntaxNode, kind: DeclarationKind): string {
  if (kind === 'initializer') return 'init';
  if (kind === 'deinitializer') return 'deinit';
  if (kind === 'subscript') return 'subscript';
  const name = node.childForFieldName('name');
  if (!name) return '';
  if (kind === 'extension') return typeName(name) ?? compact(name.text)!;
  return name.text;
}

function selector(name: string, labels: string[]): string {
  return `${name}(${labels.map((label) => `${label}:`).join('')})`;
}

function argumentLabels(argumentsNode: SyntaxNode | null): string[] {
  if (!argumentsNode) return [];
  const labels: string[] = [];
  for (const argument of argumentsNode.namedChildren) {
    if (argument.type === 'value_argument') {
      labels.push(argument.childForFieldName('name')?.text ?? '_');
    }
  }
  return labels;
}

function trailingClosureLabels(trailing: SyntaxNode | null): string[] {
  if (!trailing) return [];
  const labels = ['_'];
  for (const label of trailing.childrenForFieldName('label')) labels.push(label.text);
  return labels;
}

/** Dotted name of a type, without generic arguments: `Foo.Bar`. */
function typeName(node: SyntaxNode | null | undefined): string | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case 'user_type': {
      const parts = node.namedChildren.filter((child) => child.type === 'type_identifier').map((child) => child.text);
      return parts.length > 0 ? parts.join('.') : undefined;
    }
    case 'type_identifier':
    case 'simple_identifier':
      return node.text;
    case 'optional_type':
    case 'implicitly_unwrapped_type':
    case 'attributed_type':
    case 'opaque_type':
    case 'existential_type':
      return typeName(node.namedChildren.at(-1));
    default:
      return undefined;
  }
}

function bindingType(binding: SyntaxNode): string | undefined {
  const annotation = binding.namedChildren.find((child) => child.type === 'type_annotation');
  if (annotation) return typeName(annotation.childForFieldName('type'));
  const value = binding.childForFieldName('value');
  if (!value) return undefined;
  if (value.type === 'call_expression') {
    const callee = value.childForFieldName('function');
    const name =
      callee?.type === 'simple_identifier'
        ? callee.text
        : callee?.type === 'generic_specialization_expression'
          ? callee.childForFieldName('name')?.text
          : undefined;
    if (name && isTypeName(name)) return name;
  }
  if (value.type === 'cast_expression') return typeName(value.childForFieldName('type'));
  return undefined;
}

function memberPosition(callee: SyntaxNode): SyntaxNode {
  if (callee.type !== 'navigation_expression') return callee;
  return callee.childForFieldName('suffix')?.namedChildren.at(-1) ?? callee.childForFieldName('member') ?? callee;
}

/** `<M: P & Q>` and `where M: R`; same-type requirements (`==`) are left out. */
function genericConstraints(node: SyntaxNode): Record<string, string[]> | undefined {
  const result: Record<string, string[]> = {};
  const add = (name: string | undefined, constraint: SyntaxNode | null | undefined) => {
    if (!name || !constraint) return;
    const parts = constraint.type === 'protocol_composition_type' ? constraint.namedChildren : [constraint];
    for (const part of parts) {
      const written = typeName(part);
      if (written) (result[name] ??= []).push(written);
    }
  };
  const typeParameters = node.namedChildren.find((child) => child.type === 'type_parameters');
  for (const parameter of typeParameters?.namedChildren ?? []) {
    if (parameter.type === 'type_parameter') add(parameter.childForFieldName('name')?.text, parameter.childForFieldName('constraint'));
  }
  for (const clause of node.namedChildren.filter((child) => child.type === 'where_clause')) {
    for (const requirement of clause.namedChildren) {
      if (requirement.type !== 'type_requirement' || requirement.children.some((child) => child.type === '==')) continue;
      add(typeName(requirement.childForFieldName('left')), requirement.childForFieldName('right'));
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * `A.shared.make()`, `container.resolve(P.self)!`: members and calls from a
 * name, with arguments dropped. Undefined for anything else.
 */
function memberChain(node: SyntaxNode | null): string | undefined {
  const parts: string[] = [];
  let current = node;
  while (current) {
    if (current.type === 'simple_identifier') {
      parts.unshift(current.text);
      break;
    }
    if (
      current.type === 'call_expression' &&
      current.namedChildren.some((child) => child.type === 'call_suffix' || child.type === 'value_arguments')
    ) {
      const callee = current.childForFieldName('function') ?? current.namedChildren[0] ?? null;
      if (!callee) return undefined;
      if (callee.type === 'simple_identifier') {
        parts.unshift(`${callee.text}()`);
        break;
      }
      if (callee.type !== 'navigation_expression') return undefined;
      const member = callee.childForFieldName('suffix')?.namedChildren.at(-1) ?? callee.childForFieldName('member');
      if (!member) return undefined;
      parts.unshift(`${member.text}()`);
      current = callee.childForFieldName('target');
      continue;
    }
    if (current.type === 'navigation_expression') {
      const member = current.childForFieldName('suffix')?.namedChildren.at(-1) ?? current.childForFieldName('member');
      if (!member || member.type !== 'simple_identifier') return undefined;
      parts.unshift(member.text);
      current = current.childForFieldName('target');
      continue;
    }
    if (current.type === 'postfix_expression' || current.type === 'try_expression' || current.type === 'await_expression') {
      current = current.namedChildren.find((child) => child.type !== 'bang') ?? null;
      continue;
    }
    return undefined;
  }
  return parts.length > 1 ? parts.join('.') : undefined;
}

function bindingVariableType(binding: SyntaxNode): VariableType | undefined {
  const annotation = binding.namedChildren.find((child) => child.type === 'type_annotation');
  const name = bindingType(binding);
  if (!name) return undefined;
  const explicit = annotation !== undefined || binding.childForFieldName('value')?.type === 'cast_expression';
  return { name, explicit };
}

function bindingNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === 'simple_identifier') return [node.text];
  if (node.type === 'wildcard') return [];
  return node.descendantsOfType('simple_identifier').map((child) => child.text);
}

/** Names bound by a pattern; enum case names and labels are not bindings. */
function patternNames(node: SyntaxNode): string[] {
  if (node.type === 'simple_identifier') return [node.text];
  const names: string[] = [];
  const visit = (current: SyntaxNode) => {
    for (const child of current.namedChildren) {
      if (child.type === 'simple_identifier') {
        const parentType = current.type;
        if (
          parentType === 'value_binding_pattern' ||
          parentType === 'tuple_pattern_item' ||
          parentType === 'tuple_pattern' ||
          parentType === 'for_statement'
        ) {
          names.push(child.text);
        }
      } else if (child.type !== 'user_type') {
        visit(child);
      }
    }
  };
  visit(node);
  return names;
}

function isTypeName(name: string): boolean {
  const first = name.replace(/^`/, '')[0];
  return first !== undefined && first !== first.toLowerCase();
}

function signature(node: SyntaxNode): string {
  const modifiers = node.namedChildren.find((child) => child.type === 'modifiers');
  const body = node.childForFieldName('body') ?? node.childForFieldName('accessors');
  const start = modifiers ? modifiers.endIndex - node.startIndex : 0;
  const end = body ? body.startIndex - node.startIndex : node.endIndex - node.startIndex;
  return compact(node.text.slice(start, end), SIGNATURE_LIMIT) ?? '';
}

function docComment(node: SyntaxNode): string | null {
  const lines: string[] = [];
  let expectedRow = node.startPosition.row;
  let sibling = node.previousSibling;
  while (sibling && (sibling.type === 'comment' || sibling.type === 'multiline_comment')) {
    if (sibling.endPosition.row < expectedRow - 1) break;
    const text = sibling.text;
    if (sibling.type === 'comment' && text.startsWith('///')) {
      lines.unshift(text.slice(3).replace(/^ /, ''));
    } else if (sibling.type === 'multiline_comment' && text.startsWith('/**')) {
      const body = text
        .slice(3, -2)
        .split('\n')
        .map((line) => line.replace(/^\s*\* ?/, '').trimEnd());
      lines.unshift(...body.filter((line, index) => line !== '' || (index > 0 && index < body.length - 1)));
    } else {
      break;
    }
    expectedRow = sibling.startPosition.row;
    sibling = sibling.previousSibling;
  }
  if (lines.length === 0) return null;
  const doc = lines.join('\n').trim();
  return doc.length > DOC_LIMIT ? `${doc.slice(0, DOC_LIMIT)}…` : doc;
}

function range(node: SyntaxNode): Range {
  return [node.startPosition.row + 1, node.startPosition.column + 1, node.endPosition.row + 1, node.endPosition.column + 1];
}

/** Collapses whitespace and truncates. */
function compact(text: string | undefined, limit = Number.POSITIVE_INFINITY): string | undefined {
  if (text === undefined) return undefined;
  const result = text.replace(/\s+/g, ' ').trim();
  return result.length > limit ? `${result.slice(0, limit)}…` : result;
}
