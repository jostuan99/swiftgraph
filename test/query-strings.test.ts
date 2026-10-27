import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from '../src/build.ts';
import { localizationIssues, searchStrings, stringDetails, stringsOfSymbol } from '../src/query/strings.ts';
import { databasePath, openDatabase } from '../src/store/db.ts';
import { fixtureCopy } from './helpers.ts';

test('string queries', async () => {
  const { root, cleanup } = fixtureCopy();
  try {
    await build(root, { workers: 1 });
    const db = openDatabase(databasePath(root), { readonly: true });
    try {
      assert.deepEqual(
        searchStrings(db, 'Danh sách').map((hit) => [hit.key, hit.language, hit.value]),
        [['items_title', 'vi', 'Danh sách']],
      );
      const [detail] = stringDetails(db, 'add_button');
      assert.deepEqual(
        detail?.translations.map((translation) => [translation.language, translation.value]),
        [
          ['en', 'Add'],
          ['vi', 'Thêm %@'],
        ],
      );
      assert.deepEqual(
        detail?.usages.map((usage) => usage.symbol),
        ['swift:App/AppView.body'],
      );
      assert.deepEqual(stringDetails(db, 'empty_message')[0]?.languagesMissing, ['vi']);
      assert.deepEqual(
        stringsOfSymbol(db, 'MiniApp.body', 2).map((row) => row.key),
        ['add_button', 'items_title'],
      );
      assert.equal(localizationIssues(db, { kind: 'unused_key' }).length, 2);
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('hostile input is treated as text', async () => {
  const { root, cleanup } = fixtureCopy();
  try {
    await build(root, { workers: 1 });
    const db = openDatabase(databasePath(root), { readonly: true });
    try {
      for (const input of ['"', "'; DROP TABLE nodes; --", 'title OR key:*', 'NEAR(a b)', '*', '%', '_', '\\']) {
        assert.doesNotThrow(() => searchStrings(db, input), input);
        assert.doesNotThrow(() => stringDetails(db, input), input);
        assert.doesNotThrow(() => stringsOfSymbol(db, input, 3), input);
      }
      // LIKE wildcards in a symbol name do not match everything.
      assert.deepEqual(stringsOfSymbol(db, '%'), []);
      assert.ok((db.prepare('SELECT COUNT(*) FROM nodes').pluck().get() as number) > 0);
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});
