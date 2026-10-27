import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { build } from '../src/build.ts';
import { DatabaseKeyError, databasePath, isEncrypted, openDatabase, rekeyDatabase } from '../src/store/db.ts';
import { generateKey } from '../src/store/key.ts';
import { fixtureCopy } from './helpers.ts';

test('an encrypted database cannot be read without its key', async () => {
  const { root, cleanup } = fixtureCopy();
  try {
    const key = generateKey();
    await build(root, { workers: 1, key });
    const path = databasePath(root);
    assert.equal(isEncrypted(path), true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    // No readable symbol names in the file.
    assert.equal(readFileSync(path).includes(Buffer.from('formatTitle')), false);

    assert.throws(() => openDatabase(path, { readonly: true }), DatabaseKeyError);
    assert.throws(() => openDatabase(path, { readonly: true, key: generateKey() }), /wrong encryption key/);

    const db = openDatabase(path, { readonly: true, key });
    const count = (
      db.prepare("SELECT COUNT(*) AS count FROM nodes WHERE symbol_id = 'swift:Core/formatTitle(_:)'").get() as { count: number }
    ).count;
    db.close();
    assert.equal(count, 1);

    // Incremental builds keep working with the key.
    assert.equal((await build(root, { workers: 1, key })).graphUpdate, 'none');
  } finally {
    cleanup();
  }
});

test('rekey encrypts, rotates and decrypts', async () => {
  const { root, cleanup } = fixtureCopy();
  try {
    await build(root, { workers: 1 });
    const path = databasePath(root);
    assert.equal(isEncrypted(path), false);
    assert.throws(() => openDatabase(path, { key: generateKey() }), /not encrypted/);

    const first = generateKey();
    rekeyDatabase(path, null, first);
    assert.equal(isEncrypted(path), true);

    const second = "a passphrase with 'quotes'";
    rekeyDatabase(path, first, second);
    assert.throws(() => openDatabase(path, { readonly: true, key: first }), /wrong encryption key/);
    openDatabase(path, { readonly: true, key: second }).close();

    rekeyDatabase(path, second, null);
    assert.equal(isEncrypted(path), false);
    const db = openDatabase(path, { readonly: true });
    assert.ok((db.prepare('SELECT COUNT(*) AS count FROM edges').get() as { count: number }).count > 0);
    db.close();
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    cleanup();
  }
});

test('the database directory holds only the database files', async () => {
  const { root, cleanup } = fixtureCopy();
  try {
    await build(root, { workers: 1 });
    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(join(root, '.swiftgraph')).sort();
    assert.ok(
      entries.every((name) => name.startsWith('graph.db')),
      entries.join(', '),
    );
  } finally {
    cleanup();
  }
});
