#!/usr/bin/env node
// Command-line interface of swiftgraph. See docs/01-design.md, section 8.1.

import { Command } from 'commander';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { build, sync, type BuildResult } from './build.ts';
import { databasePath, getMeta, isEncrypted, latestSchemaVersion, openDatabase, rekeyDatabase, schemaVersion } from './store/db.ts';
import { findKey, generateKey, KEY_ENVIRONMENT_VARIABLE, storeKeychainKey } from './store/key.ts';
import { localizationIssues, searchStrings, stringDetails, stringsOfSymbol } from './query/strings.ts';
import { graphReport } from './report/report.ts';
import { viewData, viewHtml } from './view/view.ts';
import { serveStdio } from './mcp.ts';
import { install, postToolUseHint, uninstall, type InstallTarget } from './install.ts';
import { fileURLToPath } from 'node:url';
import {
  formatCommunity,
  formatImpact,
  formatNeighbors,
  formatPath,
  formatSearch,
  formatOutline,
  formatSource,
  formatSymbol,
  formatTraversal,
} from './query/text.ts';
import { defineText, flowsText, rulesText, SCREEN_RULE_KINDS } from './flow/commands.ts';
import type { FlowsFormat } from './flow/format-flows.ts';
import type { DefineFormat } from './flow/format-define.ts';
import { RuleError } from './rules/load.ts';

const program = new Command();

program.name('swiftgraph').description('Code graph of Swift projects for coding agents, stored in SQLite');

const collect = (value: string, previous: string[]) => [...previous, value];
const warn = (message: string) => console.error(`warning: ${message}`);

function locate(rootArgument: string, db: string | undefined): { root: string; path: string } {
  const root = resolve(rootArgument);
  return { root, path: db ? resolve(db) : databasePath(root) };
}

/** Key for opening `path`; with `encrypt`, also for creating it encrypted. */
function keyFor(root: string, path: string, encrypt = false): string | null {
  const needed = isEncrypted(path) || encrypt;
  if (!needed) return null;
  const key = findKey(root);
  if (!key) {
    program.error(`no encryption key for ${root}: run \`swiftgraph key create\` (macOS) or set ${KEY_ENVIRONMENT_VARIABLE}`);
  }
  return key;
}

function openReadonly(root: string, path: string) {
  if (!existsSync(path)) program.error(`no graph database at ${path}; run \`swiftgraph build\` first`);
  return openDatabase(path, { readonly: true, warn, key: keyFor(root, path) });
}

program
  .command('build')
  .description('Scan .swift and localization files and update the graph database')
  .argument('[root]', 'repository root', '.')
  .option('--exclude <glob>', 'skip paths matching the glob (repeatable)', collect, [])
  .option('--git-tracked-only', 'list files with `git ls-files` instead of walking directories')
  .option('--module <dir=Name>', 'assign a directory to a module (repeatable; saved for later builds)', collect, [])
  .option('--reset-modules', 'forget the --module values saved by earlier builds')
  .option('--force', 're-extract every file and rebuild the graph')
  .option('--encrypt', 'create the database encrypted (key from the Keychain or SWIFTGRAPH_KEY)')
  .option('--db <path>', 'database path (default: <root>/.swiftgraph/graph.db)')
  .option('--workers <count>', 'number of parser processes', (value) => Number.parseInt(value, 10))
  .option('--no-string-values', 'store localization keys, comments and states, but no translated text')
  .option('--languages <list>', 'only store these localization languages (comma separated)')
  .action(async (rootArgument: string, options) => {
    const { root, path } = locate(rootArgument, options.db);
    if (options.encrypt && existsSync(path) && statSync(path).size > 0 && !isEncrypted(path)) {
      program.error(`${path} exists and is not encrypted; run \`swiftgraph rekey --encrypt\``);
    }
    const modules: Record<string, string> | undefined = (options.module as string[]).length > 0 || options.resetModules ? {} : undefined;
    for (const entry of options.module as string[]) {
      const separator = entry.indexOf('=');
      if (separator <= 0) program.error(`invalid --module value: ${entry} (expected <dir>=<Name>)`);
      modules![entry.slice(0, separator)] = entry.slice(separator + 1);
    }
    const result = await build(root, {
      ...(options.workers ? { workers: options.workers } : {}),
      exclude: options.exclude,
      gitTrackedOnly: options.gitTrackedOnly === true,
      ...(modules ? { modules } : {}),
      force: options.force === true,
      database: path,
      key: keyFor(root, path, options.encrypt === true),
      localization: {
        noValues: options.stringValues === false,
        languages: options.languages
          ? String(options.languages)
              .split(',')
              .map((language) => language.trim())
              .filter(Boolean)
          : [],
      },
      warn,
    });
    printBuild(result);
  });

program
  .command('sync')
  .description('Update the graph database with the files changed since the last build, using the options of that build')
  .argument('[root]', 'repository root', '.')
  .option('--db <path>', 'database path (default: <root>/.swiftgraph/graph.db)')
  .option('--workers <count>', 'number of parser processes', (value) => Number.parseInt(value, 10))
  .option('--list', 'list the files added, changed and removed')
  .action(async (rootArgument: string, options) => {
    const { root, path } = locate(rootArgument, options.db);
    if (!existsSync(path)) program.error(`no graph database at ${path}; run \`swiftgraph build\` first`);
    const result = await sync(root, {
      ...(options.workers ? { workers: options.workers } : {}),
      database: path,
      key: keyFor(root, path),
      warn,
    });
    printBuild(result);
    if (options.list) {
      for (const changed of result.changedPaths) console.log(`  ~ ${changed}`);
      for (const removed of result.removedPaths) console.log(`  - ${removed}`);
    }
  });

function printBuild(result: BuildResult): void {
  console.log(
    `files: ${result.files}; extracted: ${result.extracted}; unchanged: ${result.unchanged}; ` +
      `removed: ${result.removed}; with syntax errors: ${result.withErrors.length}; ` +
      `nodes: ${result.nodes}; edges: ${result.edges}; graph update: ${result.graphUpdate}; ${result.durationMs} ms`,
  );
  for (const skipped of result.skippedLarge) warn(`skipped large file ${skipped}`);
}

program
  .command('stats')
  .description('Show what the graph database contains')
  .argument('[root]', 'repository root', '.')
  .option('--db <path>', 'database path')
  .action((rootArgument: string, options) => {
    const { root, path } = locate(rootArgument, options.db);
    const db = openReadonly(root, path);
    try {
      const count = (sql: string) => (db.prepare(sql).get() as { count: number }).count;
      const files = db.prepare('SELECT kind, COUNT(*) AS count FROM files GROUP BY kind ORDER BY kind').all() as {
        kind: string;
        count: number;
      }[];
      const edges = db
        .prepare('SELECT kind, confidence, COUNT(*) AS count FROM edges GROUP BY kind, confidence ORDER BY kind, confidence')
        .all() as { kind: string; confidence: string; count: number }[];
      console.log(`database: ${path}${isEncrypted(path) ? ' (encrypted)' : ''}`);
      console.log(`built at: ${getMeta(db, 'built_at') ?? 'never'}`);
      console.log(`modules: ${count('SELECT COUNT(*) AS count FROM modules')}`);
      for (const row of files) console.log(`${row.kind} files: ${row.count}`);
      console.log(`files with syntax errors: ${count('SELECT COUNT(*) AS count FROM files WHERE has_errors = 1')}`);
      console.log(`nodes: ${count('SELECT COUNT(*) AS count FROM nodes')}`);
      for (const row of edges) console.log(`edges ${row.kind} ${row.confidence}: ${row.count}`);
    } finally {
      db.close();
    }
  });

program
  .command('doctor')
  .description('Check the integrity, permissions and encryption of the graph database')
  .argument('[root]', 'repository root', '.')
  .option('--db <path>', 'database path')
  .action((rootArgument: string, options) => {
    const { root, path } = locate(rootArgument, options.db);
    const problems: string[] = [];
    const db = openDatabase(path, {
      readonly: true,
      warn: (message) => problems.push(message),
      key: existsSync(path) ? keyFor(root, path) : null,
    });
    try {
      const integrity = db.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') problems.push(`integrity check: ${String(integrity)}`);
      const version = schemaVersion(db);
      if (version !== latestSchemaVersion()) {
        problems.push(`schema version ${version}; run \`swiftgraph build\` to migrate to ${latestSchemaVersion()}`);
      }
      console.log(`database: ${path}`);
      console.log(`encrypted: ${isEncrypted(path) ? 'yes' : 'no'}`);
      console.log(`schema version: ${version}`);
      console.log(`directory mode: ${(statSync(dirname(path)).mode & 0o777).toString(8)}`);
      console.log(`file mode: ${(statSync(path).mode & 0o777).toString(8)}`);
    } finally {
      db.close();
    }
    for (const problem of problems) console.log(`problem: ${problem}`);
    if (problems.length > 0) process.exitCode = 1;
    else console.log('no problems found');
  });

const key = program.command('key').description('Manage the encryption key (macOS Keychain)');

key
  .command('create')
  .description('Generate a key and store it in the Keychain for this repository')
  .argument('[root]', 'repository root', '.')
  .option('--force', 'replace an existing key (the database must be re-keyed first)')
  .action((rootArgument: string, options) => {
    const root = resolve(rootArgument);
    if (findKey(root) && !options.force) program.error(`a key already exists for ${root}; use --force to replace it`);
    storeKeychainKey(root, generateKey());
    console.log(`stored a new key in the Keychain (service "swiftgraph", account "${root}")`);
  });

program
  .command('rekey')
  .description('Encrypt, decrypt or change the key of the graph database')
  .argument('[root]', 'repository root', '.')
  .option('--db <path>', 'database path')
  .option('--encrypt', 'encrypt a plain database with the configured key')
  .option('--decrypt', 'store the database without encryption')
  .option('--rotate', 'replace the key: a new key is generated and stored in the Keychain')
  .action((rootArgument: string, options) => {
    const { root, path } = locate(rootArgument, options.db);
    if (!existsSync(path)) program.error(`no graph database at ${path}`);
    const chosen = ['encrypt', 'decrypt', 'rotate'].filter((name) => options[name]);
    if (chosen.length !== 1) program.error('choose exactly one of --encrypt, --decrypt, --rotate');
    const encrypted = isEncrypted(path);
    if (options.encrypt) {
      if (encrypted) program.error(`${path} is already encrypted`);
      rekeyDatabase(path, null, keyFor(root, path, true));
      console.log(`encrypted ${path}`);
    } else if (options.decrypt) {
      if (!encrypted) program.error(`${path} is not encrypted`);
      rekeyDatabase(path, keyFor(root, path), null);
      console.log(`decrypted ${path}`);
    } else {
      if (!encrypted) program.error(`${path} is not encrypted`);
      const oldKey = keyFor(root, path);
      const newKey = generateKey();
      rekeyDatabase(path, oldKey, newKey);
      storeKeychainKey(root, newKey);
      console.log(`changed the key of ${path} and stored it in the Keychain`);
    }
  });

program
  .command('report')
  .description('Print an overview of the graph for agents (Markdown)')
  .argument('[root]', 'repository root', '.')
  .option('--db <path>', 'database path')
  .option('--write <file>', 'also write the report to this file')
  .action((rootArgument: string, options) => {
    const { root, path } = locate(rootArgument, options.db);
    const db = openReadonly(root, path);
    try {
      const report = graphReport(db, root);
      process.stdout.write(report);
      if (options.write) writeFileSync(resolve(options.write), report, { mode: 0o600 });
    } finally {
      db.close();
    }
  });

program
  .command('view')
  .description('Write an interactive HTML view of the graph (self-contained, no network) to a private temporary file')
  .argument('[root]', 'repository root', '.')
  .option('--db <path>', 'database path')
  .option('--max-nodes <n>', 'most central symbols to show', (value) => Number.parseInt(value, 10), 20000)
  .option('--out <file>', 'write here instead of a temporary file')
  .option('--open', 'open the page in the default browser')
  .action((rootArgument: string, options) => {
    const { root, path } = locate(rootArgument, options.db);
    const db = openReadonly(root, path);
    let html: string;
    try {
      html = viewHtml(viewData(db, basename(root), options.maxNodes));
    } finally {
      db.close();
    }
    // The page holds code structure: keep it readable by this user only.
    const file = options.out ? resolve(options.out) : join(mkdtempSync(join(tmpdir(), 'swiftgraph-view-')), 'graph.html');
    writeFileSync(file, html, { mode: 0o600 });
    console.log(file);
    if (options.open) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      spawn(opener, [file], { detached: true, stdio: 'ignore' }).unref();
    }
  });

const strings = program.command('strings').description('Query localization keys and translations');
const withDatabase = <T>(rootArgument: string, db: string | undefined, run: (database: ReturnType<typeof openReadonly>) => T): T => {
  const { root, path } = locate(rootArgument, db);
  const database = openReadonly(root, path);
  try {
    return run(database);
  } finally {
    database.close();
  }
};

strings
  .command('find')
  .description('Find strings by key, comment or translated text')
  .argument('<text>')
  .option('--root <root>', 'repository root', '.')
  .option('--db <path>', 'database path')
  .option('--language <code>', 'only this language')
  .action((text: string, options) =>
    withDatabase(options.root, options.db, (db) => {
      for (const hit of searchStrings(db, text, options.language ? { language: options.language } : {})) {
        console.log(`${hit.key}  [${hit.module}/${hit.table}]${hit.language ? `  ${hit.language}: ${JSON.stringify(hit.value)}` : ''}`);
      }
    }),
  );

strings
  .command('show')
  .description('Show the translations and usages of a key')
  .argument('<key>')
  .option('--table <name>', 'table name')
  .option('--root <root>', 'repository root', '.')
  .option('--db <path>', 'database path')
  .action((key: string, options) =>
    withDatabase(options.root, options.db, (db) => {
      const details = stringDetails(db, key, options.table);
      if (details.length === 0) console.log(`no string "${key}"`);
      for (const detail of details) {
        console.log(`${detail.key}  [${detail.module}/${detail.table}]${detail.comment ? `  "${detail.comment}"` : ''}`);
        for (const translation of detail.translations) {
          const variation = translation.variation ? ` (${translation.variation})` : '';
          console.log(`  ${translation.language}${variation}  ${JSON.stringify(translation.value)}  ${translation.state ?? ''}`.trimEnd());
        }
        for (const language of detail.languagesMissing) console.log(`  ${language}  — missing`);
        for (const usage of detail.usages) console.log(`  used by ${usage.symbol} (${usage.file}:${usage.line}, ${usage.confidence})`);
      }
    }),
  );

strings
  .command('usages')
  .description('List the declarations that use a key')
  .argument('<key>')
  .option('--table <name>', 'table name')
  .option('--root <root>', 'repository root', '.')
  .option('--db <path>', 'database path')
  .action((key: string, options) =>
    withDatabase(options.root, options.db, (db) => {
      for (const detail of stringDetails(db, key, options.table)) {
        for (const usage of detail.usages) console.log(`${usage.symbol}  ${usage.file}:${usage.line}  ${usage.confidence}`);
      }
    }),
  );

strings
  .command('of')
  .description('List the strings a declaration uses (and its callees with --depth)')
  .argument('<symbol>', 'symbol id or qualified name, e.g. AppView.body')
  .option('--depth <n>', 'follow CALLS and RENDERS edges', (value) => Number.parseInt(value, 10), 0)
  .option('--root <root>', 'repository root', '.')
  .option('--db <path>', 'database path')
  .action((symbol: string, options) =>
    withDatabase(options.root, options.db, (db) => {
      for (const row of stringsOfSymbol(db, symbol, options.depth)) {
        console.log(`${row.symbol}  ${row.table}/${row.key}  ${JSON.stringify(row.value)}`);
      }
    }),
  );

strings
  .command('issues')
  .description('List localization issues')
  .option('--kind <kind>', 'missing_key, unused_key, missing_translation, needs_review, stale, format_mismatch, ...')
  .option('--language <code>', 'only this language')
  .option('--root <root>', 'repository root', '.')
  .option('--db <path>', 'database path')
  .action((options) =>
    withDatabase(options.root, options.db, (db) => {
      for (const issue of localizationIssues(db, {
        ...(options.kind ? { kind: options.kind } : {}),
        ...(options.language ? { language: options.language } : {}),
      })) {
        const where = issue.file ? `  ${issue.file}${issue.line ? `:${issue.line}` : ''}` : '';
        const subject = issue.key !== null ? `${issue.table}/${issue.key}` : (issue.symbol ?? '');
        console.log(
          `${issue.kind}  ${subject}${issue.language ? `  ${issue.language}` : ''}${issue.detail ? `  ${issue.detail}` : ''}${where}`,
        );
      }
    }),
  );

// --- Graph queries -------------------------------------------------------------------

const queryCommand = (name: string, description: string) =>
  program
    .command(name)
    .description(description)
    .option('--root <root>', 'repository root', '.')
    .option('--db <path>', 'database path')
    .option('--budget <tokens>', 'approximate output size in tokens', (value) => Number.parseInt(value, 10), 1500);

queryCommand('find', 'Find declarations by name or doc comment')
  .argument('<text>')
  .option('--kind <kind>', 'only this kind (repeatable)', collect, [])
  .option('--limit <n>', 'maximum results', (value) => Number.parseInt(value, 10), 20)
  .action((text: string, options) =>
    withDatabase(options.root, options.db, (db) =>
      console.log(formatSearch(db, text, options.kind.length > 0 ? options.kind : undefined, options.limit, options.budget)),
    ),
  );

queryCommand('explain', 'Signature, doc, area and relations of a symbol')
  .argument('<symbol>')
  .action((symbol: string, options) =>
    withDatabase(options.root, options.db, (db) => console.log(formatSymbol(db, symbol, options.budget))),
  );

queryCommand('neighbors', 'Direct relations of a symbol')
  .argument('<symbol>')
  .option('--direction <in|out|both>', 'edge direction', 'both')
  .option('--kinds <list>', 'edge kinds, comma separated')
  .option('--include-ambiguous', 'show AMBIGUOUS edges')
  .action((symbol: string, options) =>
    withDatabase(options.root, options.db, (db) =>
      console.log(
        formatNeighbors(
          db,
          symbol,
          {
            direction: options.direction,
            ...(options.kinds ? { kinds: String(options.kinds).split(',') } : {}),
            includeAmbiguous: options.includeAmbiguous === true,
          },
          options.budget,
        ),
      ),
    ),
  );

for (const [name, direction] of [
  ['callers', 'in'],
  ['callees', 'out'],
] as const) {
  queryCommand(name, `Transitive ${name} of a symbol`)
    .argument('<symbol>')
    .option('--depth <n>', 'traversal depth', (value) => Number.parseInt(value, 10), 3)
    .option('--include-ambiguous', 'follow AMBIGUOUS edges')
    .action((symbol: string, options) =>
      withDatabase(options.root, options.db, (db) =>
        console.log(
          formatTraversal(
            db,
            symbol,
            direction,
            { depth: options.depth, includeAmbiguous: options.includeAmbiguous === true },
            options.budget,
          ),
        ),
      ),
    );
}

queryCommand('path', 'Shortest chain of relations between two symbols')
  .argument('<from>')
  .argument('<to>')
  .option('--max-depth <n>', 'maximum length', (value) => Number.parseInt(value, 10), 6)
  .action((from: string, to: string, options) =>
    withDatabase(options.root, options.db, (db) => console.log(formatPath(db, from, to, options.maxDepth, options.budget))),
  );

queryCommand('impact', 'What changing files or symbols may affect')
  .argument('<targets...>', 'files (relative paths) or symbols')
  .option('--depth <n>', 'traversal depth', (value) => Number.parseInt(value, 10), 3)
  .action((targets: string[], options) =>
    withDatabase(options.root, options.db, (db) => {
      const isFile = (target: string) => /\.(swift|strings|stringsdict|xcstrings)$/.test(target);
      console.log(
        formatImpact(
          db,
          { files: targets.filter(isFile), symbols: targets.filter((target) => !isFile(target)) },
          options.depth,
          options.budget,
        ),
      );
    }),
  );

queryCommand('define', 'Items of a screen and the data source of each item (API, local storage, file, localization)')
  .argument('<screen>', 'view type name, qualified name or file path')
  .option('--no-children', 'only the items of the view itself, not of child views, cells and rows')
  .option('--depth <n>', 'maximum steps when tracing a value back to its source', (value) => Number.parseInt(value, 10), 12)
  .option('--source <kinds>', 'only items with data from these sources: api,local,file,localization,literal,input')
  .option('--item <id>', 'only this item (LoginView#5), with full paths')
  .option('--detail', 'also DATA (path of each value) and CONDITIONS')
  .option('--format <format>', 'text, compact (fewest tokens), pretty (aligned columns), json or markdown', 'text')
  .action((screen: string, options) =>
    withDatabase(options.root, options.db, (db) => {
      if (!['text', 'compact', 'pretty', 'json', 'markdown'].includes(options.format)) program.error(`unknown format ${options.format}`);
      try {
        console.log(
          defineText(db, resolve(options.root), {
            screen,
            depth: options.depth,
            format: options.format as DefineFormat,
            budget: options.budget,
            children: options.children !== false,
            detail: options.detail === true,
            ...(options.source ? { sources: String(options.source).split(',') } : {}),
            ...(options.item ? { item: options.item } : {}),
            ...(options.root !== '.' ? { rootArgument: options.root } : {}),
          }),
        );
      } catch (error) {
        if (error instanceof RuleError) program.error(error.message);
        throw error;
      }
    }),
  );

queryCommand('flows', 'Processing flows of a screen: each entry point and its steps in execution order, through the layers')
  .argument('<screen>', 'view type name, qualified name or file path')
  .option('--entry <id>', 'only one flow: a flow id (LoginView/F2) or an item id from define (LoginView#5)')
  .option('--depth <n>', 'maximum call depth', (value) => Number.parseInt(value, 10), 12)
  .option('--no-children', 'leave out the flows of child views, cells and rows')
  .option('--steps', 'every step in execution order')
  .option('--calls', 'the numbered calls through the layers (default: one step per get/set of data)')
  .option('--layers <list>', 'only steps of these layers, comma separated (ViewModel,Repository)')
  .option('--until <layer>', 'every step from the view down to this layer (Repository); what runs below it is folded into it')
  .option('--format <format>', 'text, compact (fewest tokens), pretty (aligned columns), json, markdown or mermaid', 'text')
  .action((screen: string, options) =>
    withDatabase(options.root, options.db, (db) => {
      if (!['text', 'compact', 'pretty', 'json', 'markdown', 'mermaid'].includes(options.format))
        program.error(`unknown format ${options.format}`);
      try {
        console.log(
          flowsText(db, resolve(options.root), {
            screen,
            depth: options.depth,
            children: options.children !== false,
            format: options.format as FlowsFormat,
            steps: options.steps === true,
            calls: options.calls === true,
            ...(options.layers ? { layers: String(options.layers).split(',') } : {}),
            ...(options.until ? { until: String(options.until) } : {}),
            budget: options.budget,
            ...(options.entry ? { entry: options.entry } : {}),
          }),
        );
      } catch (error) {
        if (error instanceof RuleError) program.error(error.message);
        throw error;
      }
    }),
  );

program
  .command('rules')
  .description(
    'Print the rules in effect (presets and swiftgraph.yaml/.json) as a YAML template: edit a rule and keep its id to replace the preset rule',
  )
  .option('--root <root>', 'repository root', '.')
  .option('--db <path>', 'database path')
  .option(
    '--kind <list>',
    `rule kinds, comma separated, or all (default ${SCREEN_RULE_KINDS.join(',')}: INPUT and OUTPUT of flows, default language)`,
  )
  .option('--write', 'write them into the rule file (swiftgraph.yaml when there is none), keeping its other keys')
  .action((options) =>
    withDatabase(options.root, options.db, (db) => {
      try {
        console.log(
          rulesText(db, resolve(options.root), options.kind ? String(options.kind).split(',') : undefined, options.write === true),
        );
      } catch (error) {
        if (error instanceof RuleError) program.error(error.message);
        throw error;
      }
    }),
  );

queryCommand('area', 'An area (community) of the codebase: key members and linked areas')
  .argument('<area-or-symbol>')
  .action((area: string, options) =>
    withDatabase(options.root, options.db, (db) => console.log(formatCommunity(db, area, options.budget))),
  );

queryCommand('outline', 'Signatures of the declarations of a file, or of a type and its extensions, without bodies')
  .argument('<target>', 'Swift file path, or a type or extension symbol')
  .action((target: string, options) =>
    withDatabase(options.root, options.db, (db) => console.log(formatOutline(db, target, options.budget))),
  );

queryCommand('source', 'Source code of a declaration')
  .argument('<symbol>')
  .option('--context <n>', 'extra lines around the declaration', (value) => Number.parseInt(value, 10), 0)
  .action((symbol: string, options) =>
    withDatabase(options.root, options.db, (db) =>
      console.log(formatSource(db, resolve(options.root), symbol, options.context, options.budget)),
    ),
  );

program
  .command('mcp')
  .description('Run the MCP server on stdio (read-only)')
  .argument('[root]', 'repository root', '.')
  .option('--db <path>', 'database path')
  .action(async (rootArgument: string, options) => {
    const { root, path } = locate(rootArgument, options.db);
    if (!existsSync(path)) program.error(`no graph database at ${path}; run \`swiftgraph build\` first`);
    await serveStdio(root, path, keyFor(root, path));
  });

program
  .command('install')
  .description('Connect agents to the graph: CLAUDE.md, .mcp.json, skill and hook (Claude Code), AGENTS.md, Cursor rules, git hooks')
  .argument('[root]', 'repository root', '.')
  .option('--targets <list>', 'claude,agents,cursor,git', 'claude')
  .option('--command <command>', 'how to start swiftgraph (default: node <path of this cli.ts>)')
  .action((rootArgument: string, options) => {
    const root = resolve(rootArgument);
    const targets = String(options.targets)
      .split(',')
      .map((target) => target.trim())
      .filter(Boolean) as InstallTarget[];
    const unknown = targets.filter((target) => !['claude', 'agents', 'cursor', 'git'].includes(target));
    if (unknown.length > 0) program.error(`unknown target(s): ${unknown.join(', ')}`);
    const command = options.command
      ? String(options.command).split(' ').filter(Boolean)
      : [process.execPath, fileURLToPath(import.meta.url)];
    for (const change of install({ root, command, targets })) console.log(`${change.action}: ${change.path}`);
    console.log('Add `.swiftgraph/` to .gitignore: the graph database stays on this machine.');
  });

program
  .command('uninstall')
  .description('Remove everything `install` added')
  .argument('[root]', 'repository root', '.')
  .action((rootArgument: string) => {
    for (const change of uninstall(resolve(rootArgument))) console.log(`${change.action}: ${change.path}`);
  });

program
  .command('hook')
  .description('Hook handlers for coding agents (reads the hook JSON on stdin)')
  .argument('<event>', 'post-tool-use')
  .action(async (event: string) => {
    if (event !== 'post-tool-use') program.error(`unknown hook event: ${event}`);
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      return; // never break the agent's tool call
    }
    const cwd = typeof (input as { cwd?: unknown }).cwd === 'string' ? (input as { cwd: string }).cwd : process.cwd();
    const output = postToolUseHint(input, existsSync(databasePath(cwd)));
    if (output) process.stdout.write(output);
  });

program
  .command('clean')
  .description('Delete the graph database')
  .argument('[root]', 'repository root', '.')
  .option('--db <path>', 'database path')
  .action((rootArgument: string, options) => {
    const { path } = locate(rootArgument, options.db);
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    console.log(`deleted ${path}`);
  });

await program.parseAsync();
