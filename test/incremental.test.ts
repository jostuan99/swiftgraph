import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { build } from '../src/build.ts';
import { openDatabase } from '../src/store/db.ts';
import { fixtureCopy } from './helpers.ts';

/** Graph content independent of row ids. */
function dump(databasePath: string): { nodes: string[]; edges: string[]; fts: string[] } {
  const db = openDatabase(databasePath, { readonly: true });
  try {
    const nodes = (
      db
        .prepare(
          `SELECT symbol_id, kind, name, signature, access, modifiers, start_line, start_col, end_line, end_col,
             doc, conditions, fan_in, fan_out FROM nodes ORDER BY symbol_id`,
        )
        .all() as Record<string, unknown>[]
    ).map((row) => JSON.stringify(row));
    const edges = (
      db
        .prepare(
          `SELECT s.symbol_id AS source, e.kind, t.symbol_id AS target, e.confidence, e.weight, e.count, e.evidence
           FROM edges e JOIN nodes s ON s.id = e.source_id JOIN nodes t ON t.id = e.target_id`,
        )
        .all() as Record<string, unknown>[]
    )
      .map((row) => JSON.stringify(row))
      .sort();
    const fts = (
      db.prepare("SELECT n.symbol_id FROM symbol_fts f JOIN nodes n ON n.id = f.rowid WHERE symbol_fts MATCH 'store'").all() as {
        symbol_id: string;
      }[]
    )
      .map((row) => row.symbol_id)
      .sort();
    return { nodes, edges, fts };
  } finally {
    db.close();
  }
}

test('a body edit updates the graph partially, with the same result as a full build', async () => {
  const { root, cleanup } = fixtureCopy();
  try {
    const database = join(root, '.swiftgraph', 'graph.db');
    assert.equal((await build(root, { workers: 2 })).graphUpdate, 'full');
    assert.equal((await build(root, { workers: 2 })).graphUpdate, 'none');

    // Body and doc edits that move lines but keep every declaration.
    const store = join(root, 'Sources', 'Core', 'Store.swift');
    writeFileSync(
      store,
      readFileSync(store, 'utf8')
        .replace('/// Holds the items and applies actions to them.', '/// Holds the items.\n/// Applies the actions.')
        .replace(
          '        reduce(action)\n',
          '        reduce(action)\n        reduce(action)\n        _ = Item(title: "x").summary(maxLength: 2)\n',
        )
        .replace('        logger.log("send \\(action)")\n', ''),
    );
    const view = join(root, 'Sources', 'App', 'AppView.swift');
    writeFileSync(
      view,
      readFileSync(view, 'utf8').replace('ItemRow(item: item)', 'ItemRow(item: item)\n                Text(store.count.description)'),
    );
    // Moves `extension Logging` down a line: its id must not change.
    const logger = join(root, 'Sources', 'Core', 'Logger.swift');
    writeFileSync(logger, `// Logging.\n${readFileSync(logger, 'utf8')}`);

    const partial = await build(root, { workers: 2 });
    assert.equal(partial.graphUpdate, 'partial');
    assert.equal(partial.extracted, 3);
    const incremental = dump(database);

    const full = await build(root, { workers: 2, force: true, database: join(root, 'full.db') });
    assert.equal(full.graphUpdate, 'full');
    const expected = dump(join(root, 'full.db'));

    assert.deepEqual(incremental.nodes, expected.nodes);
    assert.deepEqual(incremental.edges, expected.edges);
    assert.deepEqual(incremental.fts, expected.fts);
    // The edit is visible: send no longer calls log, and now calls summary(maxLength:).
    assert.ok(
      incremental.edges.some((edge) => edge.includes('"source":"swift:Core/Store.send(_:)"') && edge.includes('summary(maxLength:)')),
    );
    assert.ok(!incremental.edges.some((edge) => edge.includes('"source":"swift:Core/Store.send(_:)"') && edge.includes('Logging.log')));
  } finally {
    cleanup();
  }
});

test('a declaration change rebuilds the whole graph', async () => {
  const { root, cleanup } = fixtureCopy();
  try {
    await build(root, { workers: 2 });
    const model = join(root, 'Sources', 'Core', 'Model.swift');
    writeFileSync(model, readFileSync(model, 'utf8').replace('func summary(maxLength: Int)', 'func summary(limit maxLength: Int)'));
    assert.equal((await build(root, { workers: 2 })).graphUpdate, 'full');
  } finally {
    cleanup();
  }
});

test('a body edit in a file that shares a symbol with another file rebuilds the whole graph', async () => {
  const { root, cleanup } = fixtureCopy();
  try {
    const database = join(root, '.swiftgraph', 'graph.db');
    const variant = (platform: string) =>
      `#if os(${platform})\npublic func platformName() -> String {\n    formatTitle("${platform}")\n}\n#endif\n`;
    writeFileSync(join(root, 'Sources', 'Core', 'PlatformIOS.swift'), variant('iOS'));
    writeFileSync(join(root, 'Sources', 'Core', 'PlatformMacOS.swift'), variant('macOS'));
    await build(root, { workers: 2 });

    const ios = join(root, 'Sources', 'Core', 'PlatformIOS.swift');
    writeFileSync(ios, readFileSync(ios, 'utf8').replace('formatTitle("iOS")', 'formatTitle("iOS" + "")'));
    assert.equal((await build(root, { workers: 2 })).graphUpdate, 'full');
    await build(root, { workers: 2, force: true, database: join(root, 'full.db') });
    assert.deepEqual(dump(database).edges, dump(join(root, 'full.db')).edges);
  } finally {
    cleanup();
  }
});

test('a build that stopped after storing facts is finished by the next build', async () => {
  const { root, cleanup } = fixtureCopy();
  try {
    await build(root, { workers: 2 });
    // As left by a build whose graph step failed (or was killed).
    const db = openDatabase(join(root, '.swiftgraph', 'graph.db'));
    try {
      db.prepare("UPDATE meta SET value = '1' WHERE key = 'graph_pending'").run();
    } finally {
      db.close();
    }
    assert.equal((await build(root, { workers: 2 })).graphUpdate, 'full');
    assert.equal((await build(root, { workers: 2 })).graphUpdate, 'none');
  } finally {
    cleanup();
  }
});

test('touching a file without changing it does not rebuild', async () => {
  const { root, cleanup } = fixtureCopy();
  try {
    await build(root, { workers: 2 });
    const model = join(root, 'Sources', 'Core', 'Model.swift');
    writeFileSync(model, readFileSync(model, 'utf8'));
    const result = await build(root, { workers: 2 });
    assert.equal(result.extracted, 0);
    assert.equal(result.graphUpdate, 'none');
  } finally {
    cleanup();
  }
});
