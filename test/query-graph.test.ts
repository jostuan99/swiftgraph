import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { build } from '../src/build.ts';
import {
  findPath,
  impact,
  neighbors,
  outline,
  readSource,
  resolveSymbol,
  searchSymbols,
  SourceAccessError,
  traverse,
} from '../src/query/graph.ts';
import { formatOutline } from '../src/query/text.ts';
import { databasePath, openDatabase } from '../src/store/db.ts';
import { fixtureCopy } from './helpers.ts';

async function withFixture(run: (root: string, db: ReturnType<typeof openDatabase>) => void | Promise<void>): Promise<void> {
  const { root, cleanup } = fixtureCopy();
  try {
    await build(root, { workers: 1 });
    const db = openDatabase(databasePath(root), { readonly: true });
    try {
      await run(root, db);
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
}

const id = (db: ReturnType<typeof openDatabase>, text: string) => resolveSymbol(db, text)[0]!.id;

test('symbol lookup, search, neighbors and traversals', async () => {
  await withFixture((_root, db) => {
    assert.equal(resolveSymbol(db, 'Store.send(_:)')[0]?.symbolId, 'swift:Core/Store.send(_:)');
    assert.equal(resolveSymbol(db, 'swift:Core/Store')[0]?.qualifiedName, 'Core.Store');
    assert.ok(searchSymbols(db, 'Logg').some((row) => row.symbolId === 'swift:Core/Logging'));
    assert.ok(searchSymbols(db, 'shown in a list').some((row) => row.symbolId === 'swift:Core/Listable'));

    const send = id(db, 'Store.send(_:)');
    const out = neighbors(db, send, { direction: 'out', kinds: ['CALLS'] })
      .map((row) => row.symbolId)
      .sort();
    assert.deepEqual(out, ['swift:Core/Logging.log(_:)', 'swift:Core/Store.reduce(_:)']);

    const callers = traverse(db, send, 'in', { depth: 2 }).map((row) => `${row.depth} ${row.symbolId}`);
    assert.ok(callers.includes('1 swift:App/AppView.body'));
    assert.ok(callers.includes('2 swift:AppTests/previewHasOneItem()'));

    // Calls through a protocol requirement continue to its implementations and their overrides.
    const callees = traverse(db, send, 'out', { depth: 1 });
    const log = callees.find((row) => row.symbolId === 'swift:Core/Logging.log(_:)')!;
    assert.deepEqual(log.dispatch.map((row) => row.symbolId).sort(), [
      'swift:Core/ConsoleLogger.log(_:)',
      'swift:Core/PrefixLogger.log(_:)',
    ]);
    // And the callers of an implementation include those that call the requirement.
    const viaProtocol = traverse(db, id(db, 'ConsoleLogger.log(_:)'), 'in', { depth: 1 });
    const sender = viaProtocol.find((row) => row.symbolId === 'swift:Core/Store.send(_:)')!;
    assert.deepEqual(
      sender.dispatch.map((row) => row.symbolId),
      ['swift:Core/Logging.log(_:)'],
    );
    const deeper = traverse(db, id(db, 'ConsoleLogger.log(_:)'), 'in', { depth: 2 });
    assert.equal(deeper.find((row) => row.symbolId === 'swift:App/AppView.body')?.parent, sender.id);
  });
});

test('outline of a file and of a type with its extensions', async () => {
  await withFixture((_root, db) => {
    const store = outline(db, { symbol: id(db, 'Core.Store') });
    assert.deepEqual(
      store.map((row) => `${row.depth} ${row.file}:${row.line} ${row.name}`),
      [
        '0 Sources/Core/Store.swift:9 Store',
        '1 Sources/Core/Store.swift:10 items',
        '1 Sources/Core/Store.swift:11 logger',
        '1 Sources/Core/Store.swift:13 init(logger:)',
        '1 Sources/Core/Store.swift:17 send(_:)',
        '1 Sources/Core/Store.swift:22 reduce(_:)',
        '1 Sources/Core/Store.swift:31 preview()',
        '0 Sources/Core/Store+Observation.swift:3 Store',
        '1 Sources/Core/Store+Observation.swift:4 count',
      ],
    );
    const text = formatOutline(db, 'Core/Store.swift');
    assert.ok(text.startsWith('Sources/Core/Store.swift\n3-6 public enum Action\n  4 case add(Item)\n'));
    assert.ok(text.includes('\n9-36 public final class Store<State>  /// Holds the items and applies actions to them.\n'));
    assert.ok(text.includes('\n  10 @Published public private(set) var items: [Item]\n'));
  });
});

test('path and impact', async () => {
  await withFixture((_root, db) => {
    const path = findPath(db, id(db, 'MiniApp.body'), id(db, 'Logging.log(_:)'));
    assert.ok(path?.directed);
    assert.deepEqual(
      path.steps.map((step) => step.node.symbolId),
      ['swift:App/MiniApp.body', 'swift:App/MiniApp.store', 'swift:Core/Store', 'swift:Core/Store.send(_:)', 'swift:Core/Logging.log(_:)'],
    );

    const result = impact(db, { files: ['Sources/Core/Logger.swift'] }, 3);
    assert.ok(result.affected.some((row) => row.symbolId === 'swift:Core/Store.send(_:)'));
    assert.ok(result.tests.some((row) => row.symbolId === 'swift:AppTests/StoreTests.testSendAddsItem()'));
  });
});

test('source is read only from recorded files inside the repository', async () => {
  await withFixture((root, db) => {
    const reduce = id(db, 'Store.reduce(_:)');
    assert.match(readSource(db, root, reduce).text, /private func reduce/);

    // A recorded file replaced by a symbolic link to a file outside the repository.
    const outside = mkdtempSync(join(tmpdir(), 'swiftgraph-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'top secret\n');
      const model = join(root, 'Sources', 'Core', 'Model.swift');
      rmSync(model);
      symlinkSync(join(outside, 'secret.txt'), model);
      assert.throws(() => readSource(db, root, id(db, 'Core.Item')), SourceAccessError);

      // A recorded directory replaced by a link that leaves the repository.
      cpSync(join(root, 'Sources', 'Core'), join(outside, 'Core'), { recursive: true, verbatimSymlinks: true });
      renameSync(join(root, 'Sources', 'Core'), join(root, 'Sources', 'CoreMoved'));
      symlinkSync(join(outside, 'Core'), join(root, 'Sources', 'Core'));
      assert.throws(() => readSource(db, root, reduce), SourceAccessError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
