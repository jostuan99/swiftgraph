import assert from 'node:assert/strict';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { build, storedFacts } from '../src/build.ts';
import { databasePath, openDatabase } from '../src/store/db.ts';
import { fixtureCopy } from './helpers.ts';

test('builds, then only re-extracts changed files', async () => {
  const { root, cleanup } = fixtureCopy();
  try {
    const first = await build(root, { workers: 2 });
    assert.equal(first.files, 14);
    assert.equal(first.extracted, 10);
    assert.deepEqual(first.withErrors, []);

    const second = await build(root, { workers: 2 });
    assert.equal(second.extracted, 0);
    assert.equal(second.unchanged, 14);

    appendFileSync(join(root, 'Sources', 'Core', 'Model.swift'), '\npublic func added() {}\n');
    writeFileSync(join(root, 'Sources', 'Core', 'New.swift'), 'struct New {}\n');
    rmSync(join(root, 'Sources', 'App', 'ItemRow.swift'));
    const third = await build(root, { workers: 2 });
    assert.equal(third.extracted, 2);
    assert.equal(third.removed, 1);
    assert.equal(third.files, 14);

    const db = openDatabase(databasePath(root), { readonly: true });
    try {
      const facts = storedFacts(db, 'Sources/Core/Model.swift');
      assert.ok(facts?.declarations.some((declaration) => declaration.name === 'added'));
      assert.equal(storedFacts(db, 'Sources/App/ItemRow.swift'), undefined);
      const localization = db.prepare("SELECT path, language FROM files WHERE kind != 'swift' ORDER BY path").all() as {
        path: string;
        language: string | null;
      }[];
      assert.equal(localization.length, 4);
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('never stores files other than Swift and localization files', async () => {
  const { root, cleanup } = fixtureCopy();
  try {
    await build(root, { workers: 1 });
    const db = openDatabase(databasePath(root), { readonly: true });
    try {
      const paths = (db.prepare('SELECT path FROM files').all() as { path: string }[]).map((row) => row.path);
      assert.ok(paths.every((path) => /\.(swift|strings|stringsdict|xcstrings)$/.test(path)));
      assert.ok(!paths.some((path) => path.endsWith('Info.plist') || path.includes('.xcodeproj')));
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('keeps --module overrides for later builds', async () => {
  const { root, cleanup } = fixtureCopy();
  try {
    const moduleOf = (path: string) => {
      const db = openDatabase(databasePath(root), { readonly: true });
      try {
        return (
          db.prepare('SELECT m.name FROM files f JOIN modules m ON m.id = f.module_id WHERE f.path = ?').get(path) as {
            name: string;
          }
        ).name;
      } finally {
        db.close();
      }
    };
    await build(root, { workers: 2, modules: { 'Sources/Core': 'Kit' } });
    assert.equal(moduleOf('Sources/Core/Model.swift'), 'Kit');
    await build(root, { workers: 2 });
    assert.equal(moduleOf('Sources/Core/Model.swift'), 'Kit');
    await build(root, { workers: 2, modules: {} });
    assert.equal(moduleOf('Sources/Core/Model.swift'), 'Core');
  } finally {
    cleanup();
  }
});
