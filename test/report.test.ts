import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from '../src/build.ts';
import { graphReport } from '../src/report/report.ts';
import { databasePath, openDatabase } from '../src/store/db.ts';
import { fixtureCopy } from './helpers.ts';

test('analysis and report of the fixture', async () => {
  const { root, cleanup } = fixtureCopy();
  try {
    await build(root, { workers: 1 });
    const db = openDatabase(databasePath(root), { readonly: true });
    try {
      // Every type of the fixture belongs to a community and has a PageRank.
      const unassigned = db
        .prepare(
          "SELECT COUNT(*) FROM nodes WHERE kind IN ('class', 'struct', 'enum', 'protocol') AND (community IS NULL OR pagerank IS NULL)",
        )
        .pluck()
        .get();
      assert.equal(unassigned, 0);
      // A type and its members land in the same community.
      const storeCommunities = db
        .prepare(
          "SELECT DISTINCT community FROM nodes WHERE symbol_id IN ('swift:Core/Store', 'swift:Core/Store.send(_:)', 'swift:Core/Store.reduce(_:)')",
        )
        .pluck()
        .all();
      assert.equal(storeCommunities.length, 1);

      const report = graphReport(db, root);
      assert.match(report, /^# Code graph: mini-app/);
      assert.match(report, /App\.MiniApp \(@main\)/);
      assert.match(report, /\| vi \| 3 \| 43% \|/);
      assert.match(report, /Issues: .*missing_translation 4/);
      // About 2,000 tokens at most.
      assert.ok(report.length < 8000, `${report.length} characters`);
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});
