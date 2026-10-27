// Builds or updates the graph database of a repository.
//
// 1. Discover files; files whose size and mtime are unchanged are not read.
// 2. Extract the facts of new and changed Swift files (worker threads).
// 3. Resolve: when the changed files keep their declaration digest (a body or
//    comment edit), only their references are resolved again and only their
//    part of the graph is replaced; otherwise the whole graph is rebuilt.
// See docs/01-design.md, section 9.

import { analyze } from './analyze/analyze.ts';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { discover, type DiscoverOptions, type Discovery } from './discover/discover.ts';
import type { ModuleMap } from './discover/package-manifest.ts';
import { extractInPool, type PoolOptions } from './extract/pool.ts';
import { EXTRACTOR_VERSION } from './extract/swift.ts';
import type { DeclarationSummary } from './extract/summary.ts';
import { parseLocalizationFile } from './localization/parse.ts';
import type { LocalizationFile } from './localization/resolve.ts';
import type { LocalizationFacts, LocalizationOptions } from './localization/types.ts';
import type { RebuildRequest, RebuildResponse } from './rebuild-worker.ts';
import { resolve, type ResolverFile } from './resolve/resolve.ts';
import type { FileFacts } from './schema/types.ts';
import { databasePath, getMeta, openDatabase, setMeta, type Db } from './store/db.ts';
import { decodeFacts, encodeFacts } from './store/facts-codec.ts';
import { replaceFileContributions, writeGraph } from './store/write-graph.ts';

export interface BuildOptions extends Omit<DiscoverOptions, 'moduleMapCache'>, PoolOptions {
  /** Database path; defaults to `<root>/.swiftgraph/graph.db`. */
  database?: string;
  /** Re-extract every file and rebuild the whole graph. */
  force?: boolean;
  /** Encryption key of the database (see store/key.ts). */
  key?: string | null;
  /** What is stored from localization files (values, languages). */
  localization?: LocalizationOptions;
  warn?: (message: string) => void;
}

export type GraphUpdate = 'none' | 'partial' | 'full';

export interface BuildResult {
  files: number;
  extracted: number;
  unchanged: number;
  removed: number;
  /** Swift files whose syntax tree contains ERROR or MISSING nodes. */
  withErrors: string[];
  skippedLarge: string[];
  nodes: number;
  edges: number;
  graphUpdate: GraphUpdate;
  durationMs: number;
}

/** Above this many changed files a full rebuild is as fast as a partial one. */
const PARTIAL_UPDATE_LIMIT = 50;

interface StoredFile {
  path: string;
  hash: string;
  module: string | null;
  mtime_ms: number | null;
  size: number | null;
  declaration_digest: string | null;
}

interface Pending {
  path: string;
  absolutePath: string;
  kind: string;
  language: string | null;
  module: string;
  size: number;
  mtimeMs: number;
  hash: string;
  /** Content changed (or forced): facts must be extracted and stored. */
  changed: boolean;
  facts: Uint8Array | null;
  summary: Uint8Array | null;
  digest: string | null;
  hasErrors: boolean;
}

/**
 * A build writes mostly new pages: a smaller page cache than the one queries
 * use (store/db.ts) keeps its memory down at the same speed.
 */
export function useBuildCache(db: Db): void {
  db.pragma('cache_size = -65536'); // 64 MiB
}

export async function build(root: string, options: BuildOptions = {}): Promise<BuildResult> {
  const started = performance.now();
  const db = openDatabase(options.database ?? databasePath(root), {
    ...(options.warn ? { warn: options.warn } : {}),
    key: options.key ?? null,
  });
  try {
    useBuildCache(db);
    return await buildInto(db, root, options, started);
  } finally {
    db.close();
  }
}

async function buildInto(db: Db, root: string, options: BuildOptions, started: number): Promise<BuildResult> {
  const cachedModuleMap = getMeta(db, 'module_map');
  // `--module` values are kept, so later builds (git hooks) map files the same way.
  const savedModules = getMeta(db, 'module_overrides');
  const modules = options.modules ?? (savedModules ? (JSON.parse(savedModules) as Record<string, string>) : {});
  if (options.modules) setMeta(db, 'module_overrides', JSON.stringify(options.modules));
  const discovery = discover(root, {
    ...options,
    modules,
    ...(cachedModuleMap ? { moduleMapCache: JSON.parse(cachedModuleMap) as { key: string; map: ModuleMap } } : {}),
  });
  const extractorChanged = getMeta(db, 'extractor_version') !== String(EXTRACTOR_VERSION);
  const force = options.force === true || extractorChanged;
  const localizationOptions: LocalizationOptions = {
    noValues: options.localization?.noValues === true,
    languages: [...(options.localization?.languages ?? [])].sort(),
  };
  const localizationKey = JSON.stringify(localizationOptions);
  // Changed options re-read every localization file, so dropped values leave the database.
  const localizationOptionsChanged = getMeta(db, 'localization_options') !== localizationKey;

  const stored = new Map<string, StoredFile>();
  const storedRows = db
    .prepare(
      `SELECT f.path, f.hash, m.name AS module, f.mtime_ms, f.size, f.declaration_digest
       FROM files f LEFT JOIN modules m ON m.id = f.module_id`,
    )
    .all() as StoredFile[];
  for (const row of storedRows) stored.set(row.path, row);

  const pending: Pending[] = [];
  for (const file of discovery.files) {
    const previous = stored.get(file.path);
    const statUnchanged = !force && previous !== undefined && previous.size === file.size && previous.mtime_ms === file.mtimeMs;
    const hash = statUnchanged ? previous.hash : createHash('sha256').update(readFileSync(file.absolutePath)).digest('hex');
    pending.push({
      path: file.path,
      absolutePath: file.absolutePath,
      kind: file.kind,
      language: file.language,
      module: file.module,
      size: file.size,
      mtimeMs: file.mtimeMs,
      hash,
      changed: force || previous?.hash !== hash || (file.kind !== 'swift' && localizationOptionsChanged),
      facts: null,
      summary: null,
      digest: null,
      hasErrors: false,
    });
  }

  const discovered = new Set(discovery.files.map((file) => file.path));
  const removedPaths = [...stored.keys()].filter((path) => !discovered.has(path));
  const modulesChanged = pending.some((file) => stored.has(file.path) && stored.get(file.path)?.module !== file.module);
  // Set by storeFiles and cleared once the graph matches the stored facts: still
  // set here means a previous build stored new facts but did not finish.
  const interrupted = getMeta(db, 'graph_pending') === '1';
  await storeFiles(db, pending, removedPaths, options, localizationOptions, localizationKey, discovery);

  // --- Graph ---------------------------------------------------------------------
  const changedSwift = pending.filter((file) => file.changed && file.kind === 'swift');
  const localizationChanged = pending.some((file) => file.changed && file.kind !== 'swift');
  const graphCurrent = getMeta(db, 'graph_version') === String(EXTRACTOR_VERSION) && !interrupted;
  let graphUpdate: GraphUpdate;
  if (graphCurrent && !force && changedSwift.length === 0 && !localizationChanged && removedPaths.length === 0 && !modulesChanged) {
    graphUpdate = 'none';
  } else {
    const summariesComplete =
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM files f LEFT JOIN file_facts x ON x.file_id = f.id
             WHERE f.kind = 'swift' AND x.declarations IS NULL`,
          )
          .get() as { count: number }
      ).count === 0;
    const partial =
      graphCurrent &&
      summariesComplete &&
      !localizationChanged &&
      !force &&
      removedPaths.length === 0 &&
      !modulesChanged &&
      changedSwift.length <= PARTIAL_UPDATE_LIMIT &&
      !sharesSymbols(db, changedSwift) &&
      changedSwift.every((file) => {
        const previous = stored.get(file.path);
        return previous !== undefined && previous.declaration_digest !== null && previous.declaration_digest === file.digest;
      });
    if (partial) {
      updateGraph(db, new Set(changedSwift.map((file) => file.path)));
      graphUpdate = 'partial';
    } else {
      await rebuildGraphInProcess(options.database ?? databasePath(root), options.key ?? null);
      graphUpdate = 'full';
    }
    setMeta(db, 'graph_version', String(EXTRACTOR_VERSION));
    // Communities and PageRank are recomputed after a full rebuild, or when the
    // number of edges moved by more than 5% since the last analysis.
    const edgeCount = db.prepare('SELECT COUNT(*) FROM edges').pluck().get() as number;
    const analyzedEdges = Number(getMeta(db, 'analyzed_edges') ?? 0);
    if (graphUpdate === 'full' || analyzedEdges === 0 || Math.abs(edgeCount - analyzedEdges) > 0.05 * analyzedEdges) {
      analyze(db);
      setMeta(db, 'analyzed_edges', String(edgeCount));
    }
  }
  setMeta(db, 'graph_pending', '0');

  const count = (sql: string) => (db.prepare(sql).get() as { count: number }).count;
  const withErrors = (db.prepare('SELECT path FROM files WHERE has_errors = 1 ORDER BY path').all() as { path: string }[]).map(
    (row) => row.path,
  );
  return {
    files: discovery.files.length,
    extracted: pending.filter((file) => file.changed && file.kind === 'swift').length,
    unchanged: pending.filter((file) => !file.changed).length,
    removed: removedPaths.length,
    withErrors,
    skippedLarge: discovery.skippedLarge,
    nodes: count('SELECT COUNT(*) AS count FROM nodes'),
    edges: count('SELECT COUNT(*) AS count FROM edges'),
    graphUpdate,
    durationMs: Math.round(performance.now() - started),
  };
}

/**
 * Stores every discovered file in one transaction. Swift facts are extracted
 * here and each worker result is written as it arrives, so the facts of the
 * whole repository are never in memory at once.
 */
async function storeFiles(
  db: Db,
  pending: Pending[],
  removedPaths: string[],
  options: BuildOptions,
  localizationOptions: LocalizationOptions,
  localizationKey: string,
  discovery: Discovery,
): Promise<void> {
  const writer = fileWriter(db);
  const toExtract = pending.filter((file) => file.changed && file.kind === 'swift');
  const poolOptions: PoolOptions = {};
  if (options.workers !== undefined) poolOptions.workers = options.workers;
  if (options.filesPerWorker !== undefined) poolOptions.filesPerWorker = options.filesPerWorker;

  // A manual transaction: better-sqlite3's transaction() cannot span awaits.
  db.exec('BEGIN');
  try {
    // Rows are written in path order, so new files get the same ids in every
    // build; only results that arrive early wait for their turn.
    const arrived = new Set<number>();
    let nextToWrite = 0;
    await extractInPool(
      toExtract.map((file) => file.absolutePath),
      poolOptions,
      (index, result) => {
        const file = toExtract[index]!;
        file.facts = result.facts;
        file.summary = result.summary;
        file.digest = result.digest;
        file.hasErrors = result.hasErrors;
        arrived.add(index);
        while (arrived.delete(nextToWrite)) writer.write(toExtract[nextToWrite++]!);
      },
    );
    for (const file of pending) {
      if (file.changed && file.kind === 'swift') continue;
      if (file.changed) {
        const facts = parseLocalizationFile(file.path, readFileSync(file.absolutePath), file.language, localizationOptions);
        file.facts = encodeFacts(facts);
        file.hasErrors = facts.warnings.some((warning) => warning.kind === 'parse_error');
      }
      writer.write(file);
    }
    const deleteFile = db.prepare('DELETE FROM files WHERE path = ?');
    for (const path of removedPaths) deleteFile.run(path);
    db.prepare("DELETE FROM modules WHERE kind = 'target' AND id NOT IN (SELECT module_id FROM files WHERE module_id IS NOT NULL)").run();
    setMeta(db, 'extractor_version', String(EXTRACTOR_VERSION));
    setMeta(db, 'built_at', new Date().toISOString());
    setMeta(db, 'module_map', JSON.stringify({ key: discovery.moduleMapKey, map: discovery.moduleMap }));
    setMeta(db, 'localization_options', localizationKey);
    setMeta(db, 'graph_pending', '1');
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/** Writes one file row: a changed file with its facts (then released), else new stat values. */
function fileWriter(db: Db): { write(file: Pending): void } {
  const upsertModule = db.prepare(
    "INSERT INTO modules (name, kind) VALUES (?, 'target') ON CONFLICT (name) DO UPDATE SET kind = 'target' RETURNING id",
  );
  const upsertFile = db.prepare(
    `INSERT INTO files (path, kind, language, module_id, hash, declaration_digest, has_errors, parsed_at, mtime_ms, size)
     VALUES (@path, @kind, @language, @moduleId, @hash, @digest, @hasErrors, @parsedAt, @mtimeMs, @size)
     ON CONFLICT (path) DO UPDATE SET
       kind = excluded.kind, language = excluded.language, module_id = excluded.module_id,
       hash = excluded.hash, declaration_digest = excluded.declaration_digest, has_errors = excluded.has_errors,
       parsed_at = excluded.parsed_at, mtime_ms = excluded.mtime_ms, size = excluded.size
     RETURNING id`,
  );
  const upsertFacts = db.prepare(
    `INSERT INTO file_facts (file_id, declarations, facts) VALUES (?, ?, ?)
     ON CONFLICT (file_id) DO UPDATE SET facts = excluded.facts, declarations = excluded.declarations`,
  );
  const touchFile = db.prepare('UPDATE files SET module_id = ?, mtime_ms = ?, size = ? WHERE path = ?');
  const moduleIds = new Map<string, number>();
  const moduleId = (name: string) => {
    let id = moduleIds.get(name);
    if (id === undefined) {
      id = (upsertModule.get(name) as { id: number }).id;
      moduleIds.set(name, id);
    }
    return id;
  };
  const now = Date.now();
  return {
    write(file) {
      if (!file.changed) {
        // Package.swift edits can move unchanged files to another module.
        touchFile.run(moduleId(file.module), file.mtimeMs, file.size, file.path);
        return;
      }
      const { id } = upsertFile.get({
        path: file.path,
        kind: file.kind,
        language: file.language,
        moduleId: moduleId(file.module),
        hash: file.hash,
        digest: file.digest,
        hasErrors: file.hasErrors ? 1 : 0,
        parsedAt: now,
        mtimeMs: file.mtimeMs,
        size: file.size,
      }) as { id: number };
      if (file.facts) upsertFacts.run(id, file.summary, file.facts);
      // The resolver reads facts back one file at a time.
      file.facts = null;
      file.summary = null;
    },
  };
}

const REBUILD_WORKER_PATH = fileURLToPath(new URL('./rebuild-worker.ts', import.meta.url));

/**
 * Runs rebuildGraph in a child process (see rebuild-worker.ts). The key goes
 * over the IPC channel, never through arguments or the environment.
 */
function rebuildGraphInProcess(database: string, key: string | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = fork(REBUILD_WORKER_PATH, [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      execArgv: [...process.execArgv, '--disable-warning=DEP0151'],
    });
    let response: RebuildResponse | undefined;
    child.once('message', (message: RebuildResponse) => (response = message));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (response && 'ok' in response) resolve();
      else if (response) reject(new Error(`graph rebuild failed: ${response.error}`));
      else reject(new Error(`graph rebuild process exited (${signal ?? `code ${code}`})`));
    });
    const request: RebuildRequest = { database, key };
    child.send(request);
  });
}

// The resolved graph lives only inside these functions: once they return it is
// garbage, so it is not kept alive (by this function's frame) during analysis.

export function rebuildGraph(db: Db): void {
  const graph = resolve(loadResolverFiles(db), { localization: loadLocalizationFiles(db) });
  writeGraph(db, graph);
  // Read before a partial update (see sharesSymbols); a partial update keeps
  // every declaration, so the list stays valid until the next full rebuild.
  setMeta(db, 'shared_symbol_files', JSON.stringify([...graph.sharedSymbolFiles].sort()));
}

function updateGraph(db: Db, only: ReadonlySet<string>): void {
  replaceFileContributions(db, resolve(loadResolverFiles(db, only), { only, localization: loadLocalizationFiles(db) }), only);
}

/**
 * True when one of the files declares a symbol together with another file
 * (`#if` variants in two files): the stored edges of that symbol come from
 * both files, so only a full rebuild is exact.
 */
function sharesSymbols(db: Db, files: Pending[]): boolean {
  const shared = new Set(JSON.parse(getMeta(db, 'shared_symbol_files') ?? '[]') as string[]);
  return files.some((file) => shared.has(file.path));
}

/**
 * Files for the resolver, built from the declaration summaries. References
 * are decoded one file at a time while the resolver walks them (all files, or
 * only the files in `only`), which keeps them out of memory as a whole.
 */
export function loadResolverFiles(db: Db, only?: ReadonlySet<string>): ResolverFile[] {
  const rows = db
    .prepare(
      `SELECT f.id, f.path, m.name AS module, x.declarations
       FROM files f JOIN modules m ON m.id = f.module_id JOIN file_facts x ON x.file_id = f.id
       WHERE f.kind = 'swift' ORDER BY f.path`,
    )
    .all() as { id: number; path: string; module: string; declarations: Uint8Array | null }[];
  const fullFacts = db.prepare('SELECT facts FROM file_facts WHERE file_id = ?').pluck();
  const readFacts = (id: number) => decodeFacts<FileFacts>(fullFacts.get(id) as Uint8Array);
  return rows.map((row) => {
    // Databases written before summaries existed have none.
    if (!row.declarations) return { path: row.path, module: row.module, facts: readFacts(row.id) };
    const summary = decodeFacts<DeclarationSummary>(row.declarations);
    const facts: FileFacts = {
      version: EXTRACTOR_VERSION,
      imports: summary.imports,
      declarations: summary.declarations,
      references: [],
      flow: { calls: [], closures: [], assignments: [], bindings: [], returns: [] },
      hasErrors: false,
    };
    const file: ResolverFile = { path: row.path, module: row.module, facts };
    if (!only || only.has(row.path)) file.loadReferences = () => readFacts(row.id).references;
    return file;
  });
}

export function loadLocalizationFiles(db: Db): LocalizationFile[] {
  const rows = db
    .prepare(
      `SELECT f.path, m.name AS module, x.facts
       FROM files f JOIN modules m ON m.id = f.module_id JOIN file_facts x ON x.file_id = f.id
       WHERE f.kind != 'swift' ORDER BY f.path`,
    )
    .all() as { path: string; module: string; facts: Uint8Array }[];
  return rows.map((row) => ({ path: row.path, module: row.module, facts: decodeFacts<LocalizationFacts>(row.facts) }));
}

/** Reads the stored facts of a Swift file. */
export function storedFacts(db: Db, path: string): FileFacts | undefined {
  const row = db
    .prepare("SELECT x.facts FROM files f JOIN file_facts x ON x.file_id = f.id WHERE f.path = ? AND f.kind = 'swift'")
    .get(path) as { facts: Uint8Array | null } | undefined;
  return row?.facts ? decodeFacts<FileFacts>(row.facts) : undefined;
}
