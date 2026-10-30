import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { extractSwiftFacts } from '../src/extract/swift.ts';
import type { Reference } from '../src/schema/types.ts';
import { FIXTURE_ROOT, GOLDEN_DIRECTORY } from './helpers.ts';

function swiftFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.swift'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

// Golden facts: run with UPDATE_GOLDEN=1 to regenerate, then review the diff.
for (const file of swiftFiles(FIXTURE_ROOT)) {
  const name = relative(FIXTURE_ROOT, file);
  test(`golden facts: ${name}`, () => {
    const facts = extractSwiftFacts(readFileSync(file, 'utf8'));
    const goldenPath = join(GOLDEN_DIRECTORY, `${name.replaceAll('/', '__')}.json`);
    const actual = `${JSON.stringify(facts, null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(goldenPath, actual);
    assert.equal(actual, readFileSync(goldenPath, 'utf8'));
  });
}

function calls(source: string): Reference[] {
  return extractSwiftFacts(source).references.filter((reference) => reference.kind === 'call');
}

test('selectors include argument labels and trailing closures', () => {
  const facts = extractSwiftFacts(`
    struct S {
      func move(to point: Point, by delta: Int = 0) {}
      init(from decoder: Decoder) throws {}
      subscript(index: Int) -> Int { 0 }
      subscript(key key: String) -> Int { 0 }
      func run() {
        UIView.animate(withDuration: 1) { } completion: { _ in }
        move(to: p)
      }
    }
  `);
  assert.deepEqual(
    facts.declarations.map((declaration) => declaration.selector),
    ['S', 'move(to:by:)', 'init(from:)', 'subscript(_:)', 'subscript(key:)', 'run()'],
  );
  assert.deepEqual(
    facts.references.filter((reference) => reference.kind === 'call').map((reference) => reference.selector),
    ['animate(withDuration:_:completion:)', 'move(to:)'],
  );
});

test('receivers carry type hints', () => {
  const references = calls(`
    func f(store: Store) {
      let logger = ConsoleLogger()
      let typed: Formatter = make()
      store.send(a)
      logger.log(b)
      typed.format(c)
      self.reload()
      super.viewDidLoad()
      Store.preview()
      Store.shared.reset()
      Store().send(d)
      items.append(e)
      $0.run()
      handle(.some(x))
    }
  `);
  assert.deepEqual(
    references.map((reference) => `${reference.name} ${JSON.stringify(reference.receiver)}`),
    [
      'ConsoleLogger {"kind":"none"}',
      'make {"kind":"none"}',
      'send {"kind":"variable","name":"store","typeHint":"Store","explicit":true}',
      'log {"kind":"variable","name":"logger","typeHint":"ConsoleLogger","explicit":false}',
      'format {"kind":"variable","name":"typed","typeHint":"Formatter","explicit":true}',
      'reload {"kind":"self"}',
      'viewDidLoad {"kind":"super"}',
      'preview {"kind":"type","name":"Store"}',
      'reset {"kind":"type_member","type":"Store","name":"shared"}',
      'send {"kind":"instance","type":"Store"}',
      'Store {"kind":"none"}',
      'append {"kind":"self_member","name":"items"}',
      'run {"kind":"variable","name":"$0"}',
      'handle {"kind":"none"}',
      'some {"kind":"implicit"}',
    ],
  );
});

test('local declarations are not graph nodes', () => {
  const facts = extractSwiftFacts(`
    func outer() {
      let local = 1
      func helper() { work() }
      helper()
    }
  `);
  assert.deepEqual(
    facts.declarations.map((declaration) => declaration.name),
    ['outer'],
  );
  assert.ok(facts.references.some((reference) => reference.name === 'work' && reference.from === 0));
});

test('#if branches are recorded as conditions', () => {
  const facts = extractSwiftFacts(`
    #if os(iOS)
    func a() {}
    #elseif os(macOS)
    func b() {}
    #else
    func c() {}
    #endif
  `);
  assert.deepEqual(
    facts.declarations.map((declaration) => [declaration.name, declaration.conditions]),
    [
      ['a', ['os(iOS)']],
      ['b', ['!(os(iOS)) && os(macOS)']],
      ['c', ['!(os(iOS) || os(macOS))']],
    ],
  );
});

test('doc comments, access levels and attributes', () => {
  const facts = extractSwiftFacts(`
    /// First line.
    /// Second line.
    @MainActor
    public final class A {
      /**
       * Block doc.
       */
      @Published private(set) var x = 0
      // not a doc comment
      func f() {}
      public private(set) var y = 0
    }
  `);
  const [a, x, f, y] = facts.declarations;
  assert.equal(a?.doc, 'First line.\nSecond line.');
  assert.deepEqual(a?.attributes, ['MainActor']);
  assert.equal(a?.access, 'public');
  assert.deepEqual(a?.modifiers, ['public', 'final']);
  assert.equal(x?.doc, 'Block doc.');
  // `private(set)` limits the setter, not the getter.
  assert.equal(x?.access, null);
  assert.deepEqual(x?.modifiers, ['private(set)']);
  assert.equal(y?.access, 'public');
  assert.equal(f?.doc, null);
});

test('files with syntax errors still produce facts', () => {
  const facts = extractSwiftFacts('func ok() {}\nfunc broken( {\n');
  assert.equal(facts.hasErrors, true);
  assert.ok(facts.declarations.some((declaration) => declaration.name === 'ok'));
});
