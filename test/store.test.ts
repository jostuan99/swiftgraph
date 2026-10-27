import assert from 'node:assert/strict';
import { chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { latestSchemaVersion, openDatabase, schemaVersion } from '../src/store/db.ts';
import { temporaryDirectory } from './helpers.ts';

test('creates the database with private permissions and the latest schema', () => {
  const { path, cleanup } = temporaryDirectory();
  try {
    const databasePath = join(path, '.swiftgraph', 'graph.db');
    const db = openDatabase(databasePath);
    assert.equal(schemaVersion(db), latestSchemaVersion());
    db.prepare("INSERT INTO meta (key, value) VALUES ('x', 'y')").run();
    db.close();
    assert.equal(statSync(databasePath).mode & 0o777, 0o600);
    assert.equal(statSync(join(path, '.swiftgraph')).mode & 0o777, 0o700);
  } finally {
    cleanup();
  }
});

test('read-only connections cannot write', () => {
  const { path, cleanup } = temporaryDirectory();
  try {
    const databasePath = join(path, 'graph.db');
    openDatabase(databasePath).close();
    const db = openDatabase(databasePath, { readonly: true });
    assert.throws(() => db.prepare("INSERT INTO meta (key, value) VALUES ('a', 'b')").run());
    db.close();
  } finally {
    cleanup();
  }
});

test('warns when the database is readable by other users', () => {
  const { path, cleanup } = temporaryDirectory();
  try {
    const databasePath = join(path, 'graph.db');
    openDatabase(databasePath).close();
    chmodSync(databasePath, 0o644);
    const warnings: string[] = [];
    openDatabase(databasePath, { readonly: true, warn: (message) => warnings.push(message) }).close();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /accessible by other users/);
  } finally {
    cleanup();
  }
});

test('reopening applies no migration twice', () => {
  const { path, cleanup } = temporaryDirectory();
  try {
    const databasePath = join(path, 'graph.db');
    openDatabase(databasePath).close();
    const db = openDatabase(databasePath);
    assert.equal(schemaVersion(db), latestSchemaVersion());
    db.close();
  } finally {
    cleanup();
  }
});
