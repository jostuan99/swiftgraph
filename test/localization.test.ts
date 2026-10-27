import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { build } from '../src/build.ts';
import { extractSwiftFacts } from '../src/extract/swift.ts';
import { formatArguments, parseStringCatalog, parseStrings, parseStringsDictionary, decodeText } from '../src/localization/parse.ts';
import { databasePath, openDatabase } from '../src/store/db.ts';
import { FIXTURE_ROOT, fixtureCopy } from './helpers.ts';

test('.strings: quoted and unquoted entries, escapes, comments, duplicates, errors', () => {
  const facts = parseStrings(
    'Localizable',
    [
      '/* Greeting */',
      '"hello" = "Hello, \\"%@\\"\\nWelcome";',
      '// Line comment',
      'plain_key = plain_value;',
      '"unicode" = "\\U00e9t\\u00e9";',
      '"broken" "missing equals";',
      '"hello" = "Again";',
    ].join('\n'),
    'en',
  );
  assert.deepEqual(
    facts.entries.map((entry) => [entry.key, entry.value, entry.comment, entry.line]),
    [
      ['hello', 'Again', null, 7],
      ['plain_key', 'plain_value', 'Line comment', 4],
      ['unicode', 'été', null, 5],
    ],
  );
  assert.deepEqual(
    facts.warnings.map((warning) => [warning.kind, warning.line]),
    [
      ['parse_error', 6],
      ['duplicate_key', 7],
    ],
  );
});

test('text decoding: UTF-8, UTF-16 with and without byte order mark', () => {
  const text = '"k" = "Thêm";';
  assert.equal(decodeText(Buffer.from(text, 'utf8')), text);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])), text);
  assert.equal(decodeText(Buffer.from(text, 'utf16le')), text);
  const bigEndian = Buffer.from(text, 'utf16le');
  bigEndian.swap16();
  assert.equal(decodeText(bigEndian), text);
});

test('.stringsdict never expands DTD entities', () => {
  const facts = parseStringsDictionary(
    'Localizable',
    `<?xml version="1.0"?>
<!DOCTYPE plist [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<plist version="1.0"><dict>
  <key>%lld files</key>
  <dict>
    <key>NSStringLocalizedFormatKey</key><string>%#@files@ &amp; &xxe;</string>
    <key>files</key>
    <dict>
      <key>NSStringFormatSpecTypeKey</key><string>NSStringPluralRuleType</string>
      <key>one</key><string>%lld file</string>
      <key>other</key><string>%lld files</string>
    </dict>
  </dict>
</dict></plist>`,
    'en',
  );
  assert.deepEqual(
    facts.entries.map((entry) => [entry.variationPath, entry.value]),
    [
      ['', '%#@files@ & &xxe;'],
      ['plural.files.one', '%lld file'],
      ['plural.files.other', '%lld files'],
    ],
  );
});

test('.xcstrings: variations, substitutions, keys without translations, bad input', () => {
  const facts = parseStringCatalog(
    'Main',
    JSON.stringify({
      sourceLanguage: 'en',
      strings: {
        a: {
          localizations: {
            en: {
              variations: { device: { iphone: { variations: { plural: { one: { stringUnit: { state: 'translated', value: '1' } } } } } } },
            },
          },
        },
        b: { localizations: { en: { stringUnit: { value: '%#@n@' }, substitutions: { n: { stringUnit: { value: '%lld' } } } } } },
        c: { shouldTranslate: false },
        d: 'not an object',
      },
    }),
  );
  assert.deepEqual(
    facts.entries.map((entry) => [entry.key, entry.language, entry.variationPath, entry.shouldTranslate]),
    [
      ['a', 'en', 'device.iphone|plural.one', true],
      ['b', 'en', '', true],
      ['b', 'en', 'sub.n', true],
      ['c', null, '', false],
    ],
  );
  assert.equal(facts.warnings.length, 1);
  assert.equal(parseStringCatalog('X', '{ not json').warnings[0]?.kind, 'parse_error');
});

test('format arguments', () => {
  assert.deepEqual(formatArguments('%@ has %lld items (%.1f%%) %2$@ %#@n@'), ['%@', '%lld', '%.1f', '%@', '%#@n@']);
});

test('extracts localization keys from Swift code', () => {
  const facts = extractSwiftFacts(`
    func f(name: String, count: Int, value: Value) {
      _ = NSLocalizedString("plain", tableName: "Errors", comment: "")
      _ = String(localized: "Hello \\(name), \\(count) items, \\(value)")
      _ = NSLocalizedString(dynamicKey, comment: "")
      Text("title")
      Text(verbatim: "not a key")
      Text(name)
      view.navigationTitle("nav")
    }
  `);
  assert.deepEqual(
    facts.references
      .filter((reference) => reference.kind === 'string')
      .map((reference) => [reference.name, reference.table ?? null, reference.localization]),
    [
      ['plain', 'Errors', 'explicit'],
      ['Hello %@, %lld items, %?', null, 'explicit'],
      ['', null, 'dynamic'],
      ['title', null, 'swiftui'],
      ['nav', null, 'swiftui'],
    ],
  );
});

function issues(databasePathValue: string): string[] {
  const db = openDatabase(databasePathValue, { readonly: true });
  try {
    return (
      db
        .prepare(
          `SELECT i.kind, t.name AS table_name, s.key, COALESCE(i.language, '-') AS language
           FROM localization_issues i
           JOIN localized_strings s ON s.node_id = i.string_id
           JOIN localization_tables t ON t.node_id = s.table_id`,
        )
        .all() as { kind: string; table_name: string; key: string; language: string }[]
    )
      .map((row) => [row.kind, row.table_name, row.key, row.language].join('\t'))
      .sort();
  } finally {
    db.close();
  }
}

test('localization issues of the fixture match the expected list', async () => {
  const { root, cleanup } = fixtureCopy();
  try {
    await build(root, { workers: 1 });
    const expected = readFileSync(join(FIXTURE_ROOT, '..', '..', 'expected', 'mini-app.issues.tsv'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'))
      .sort();
    assert.deepEqual(issues(databasePath(root)), expected);
  } finally {
    cleanup();
  }
});

test('--no-string-values keeps translated text out of the database file', async () => {
  const { root, cleanup } = fixtureCopy();
  try {
    await build(root, { workers: 1, localization: { noValues: true } });
    const bytes = readFileSync(databasePath(root));
    assert.equal(bytes.includes(Buffer.from('Never shown')), false);
    assert.equal(bytes.includes(Buffer.from('Danh s')), false);
    // Analyses keep working from hashes and format arguments.
    assert.ok(issues(databasePath(root)).some((line) => line.startsWith('format_mismatch\tLocalizable\tadd_button')));

    // Turning values back on re-reads the files.
    await build(root, { workers: 1 });
    const db = openDatabase(databasePath(root), { readonly: true });
    const value = db.prepare("SELECT value FROM translations WHERE value = 'Never shown'").get();
    db.close();
    assert.ok(value);
  } finally {
    cleanup();
  }
});

test('Swift edits update usages and missing keys; localization edits rebuild', async () => {
  const { root, cleanup } = fixtureCopy();
  try {
    await build(root, { workers: 1 });
    const view = join(root, 'Sources', 'App', 'AppView.swift');
    writeFileSync(view, readFileSync(view, 'utf8').replace('Button("add_button")', 'Button("no_such_key")'));
    const partial = await build(root, { workers: 1 });
    assert.equal(partial.graphUpdate, 'partial');
    const db = openDatabase(databasePath(root), { readonly: true });
    const missing = db.prepare("SELECT detail FROM localization_issues WHERE kind = 'missing_key'").pluck().all();
    const unused = db
      .prepare(
        "SELECT s.key FROM localization_issues i JOIN localized_strings s ON s.node_id = i.string_id WHERE i.kind = 'unused_key' ORDER BY s.key",
      )
      .pluck()
      .all();
    db.close();
    assert.deepEqual(missing, ['Localizable: no_such_key']);
    assert.deepEqual(unused, ['%lld devices', 'add_button', 'unused_key']);

    const strings = join(root, 'Sources', 'App', 'Resources', 'en.lproj', 'Localizable.strings');
    writeFileSync(strings, `${readFileSync(strings, 'utf8')}"no_such_key" = "Now it exists";\n`);
    assert.equal((await build(root, { workers: 1 })).graphUpdate, 'full');
    const after = openDatabase(databasePath(root), { readonly: true });
    const stillMissing = after.prepare("SELECT COUNT(*) FROM localization_issues WHERE kind = 'missing_key'").pluck().get();
    after.close();
    assert.equal(stillMissing, 0);
  } finally {
    cleanup();
  }
});
