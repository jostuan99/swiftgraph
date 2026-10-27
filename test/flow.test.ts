import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractSwiftFacts } from '../src/extract/swift.ts';
import type { FileFacts, ValueExpr } from '../src/schema/types.ts';

/** Compact text of a value, for assertions. */
function show(facts: FileFacts, value: ValueExpr): string {
  switch (value.kind) {
    case 'path': {
      const root = value.root;
      const start =
        root.kind === 'self'
          ? 'self'
          : root.kind === 'local'
            ? root.name
            : root.kind === 'type'
              ? root.name
              : `${facts.flow.calls[root.call]!.name}()`;
      return `${value.binding ? '$' : ''}${[start, ...value.members].join('.')}`;
    }
    case 'literal':
      return `${value.type}:${value.value}`;
    case 'case':
      return `.${value.name}`;
    case 'call':
      return `${facts.flow.calls[value.call]!.name}()`;
    case 'closure':
      return `{closure}`;
    case 'compound':
      return `(${value.operands.map((operand) => show(facts, operand)).join(', ')})`;
  }
}

const SOURCE = `
struct ItemListView: View {
    @ObservedObject var vm: ItemListViewModel
    var body: some View {
        if vm.isLoading {
            ProgressView()
        } else {
            List(vm.items) { item in
                ItemRow(title: item.title, price: "\\(item.price)円")
            }
        }
        TextField("Search", text: $vm.query)
    }
}

final class ItemListViewModel {
    weak var coordinator: Coordinator?
    @Published var items: [ItemViewData] = []
    let repository: ItemRepository

    func load() async {
        let response = try? await AF.request(url).serializingDecodable(ItemResponse.self).value
        for dto in response?.items ?? [] {
            items.append(ItemViewData(title: dto.name))
        }
        coordinator?.state = .loaded
    }

    func title(_ item: ItemDTO) -> String { item.name }
}
`;

test('records the values of calls, assignments, bindings and returns', () => {
  const facts = extractSwiftFacts(SOURCE);
  const calls = facts.flow.calls;
  const call = (name: string) => calls.find((site) => site.name === name)!;

  // SwiftUI tree: ItemRow is created in the closure of List, under the else branch.
  const row = call('ItemRow');
  assert.equal(facts.flow.closures[row.closure!]!.call, calls.indexOf(call('List')));
  assert.deepEqual(row.branch, ['!(vm.isLoading)']);
  assert.deepEqual(
    row.arguments.map((argument) => `${argument.label}: ${show(facts, argument.value)}`),
    ['title: item.title', 'price: (item.price)'],
  );
  assert.deepEqual(call('ProgressView').branch, ['vm.isLoading']);
  assert.deepEqual(
    call('TextField').arguments.map((argument) => show(facts, argument.value)),
    ['String:Search', '$self.vm.query'],
  );

  // async/await and a value read from the result of a call chain.
  assert.equal(call('serializingDecodable').await, true);
  const response = facts.flow.bindings.find((binding) => binding.name === 'response')!;
  assert.equal(show(facts, response.value), 'serializingDecodable().value');
  const dto = facts.flow.bindings.find((binding) => binding.name === 'dto')!;
  // An element of `response?.items ?? []`.
  assert.equal(show(facts, dto.value), '((response.items, ()))');

  // Optional chaining in an assignment target, and a stored property's initial value.
  const assignments = facts.flow.assignments.map((assignment) => `${show(facts, assignment.target)} = ${show(facts, assignment.value)}`);
  assert.ok(assignments.includes('self.coordinator.state = .loaded'));
  assert.ok(assignments.includes('self.items = ()'));
  assert.equal(show(facts, call('append').arguments[0]!.value), 'ItemViewData()');
  assert.equal(show(facts, call('ItemViewData').arguments[0]!.value), 'dto.name');

  // Single-expression bodies return their value.
  const title = facts.declarations.find((declaration) => declaration.selector === 'title(_:)')!;
  assert.deepEqual(
    facts.flow.returns.filter((item) => item.from === title.localId).map((item) => show(facts, item.value)),
    ['item.name'],
  );
});

test('a member written through optional chaining keeps its receiver', () => {
  const facts = extractSwiftFacts('final class M { weak var viewModel: VM?\n func f() { viewModel?.state = .main; viewModel?.login() } }');
  const write = facts.references.find((reference) => reference.kind === 'write' && reference.name === 'state')!;
  assert.deepEqual(write.receiver, { kind: 'self_member', name: 'viewModel' });
  const login = facts.references.find((reference) => reference.kind === 'call' && reference.name === 'login')!;
  assert.deepEqual(login.receiver, { kind: 'self_member', name: 'viewModel' });
});
