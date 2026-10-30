// Read-only graph queries shared by the CLI and the MCP server.
// See docs/01-design.md, section 8.
//
// Inputs are always bound as parameters; FTS input is quoted as a phrase and
// LIKE input is escaped. Source code is read only from files recorded in the
// database and located inside the repository root.

import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Db } from '../store/db.ts';
import { ftsPhrase } from './strings.ts';

export interface SymbolRow {
  id: number;
  symbolId: string;
  kind: string;
  name: string;
  qualifiedName: string;
  signature: string | null;
  access: string | null;
  /** JSON array of modifiers and attributes as written: `["private(set)", "@Published"]`. */
  modifiers: string | null;
  file: string | null;
  line: number | null;
  endLine: number | null;
  doc: string | null;
  conditions: string | null;
  community: number | null;
  pagerank: number | null;
  fanIn: number | null;
  fanOut: number | null;
}

const SYMBOL_COLUMNS = `n.id, n.symbol_id AS symbolId, n.kind, n.name, n.qualified_name AS qualifiedName, n.signature,
  n.access, n.modifiers, f.path AS file, n.start_line AS line, n.end_line AS endLine, n.doc, n.conditions, n.community,
  n.pagerank, n.fan_in AS fanIn, n.fan_out AS fanOut`;

const FROM_NODES = 'FROM nodes n LEFT JOIN files f ON f.id = n.file_id';

/** Edge kinds that carry meaning between declarations (not structure). */
export const SEMANTIC_KINDS = [
  'CALLS',
  'INSTANTIATES',
  'READS',
  'WRITES',
  'REFERENCES',
  'CONFORMS_TO',
  'INHERITS',
  'EXTENDS',
  'IMPLEMENTS',
  'OVERRIDES',
  'RENDERS',
  'TESTS',
  'WRAPS',
  'EXPANDS',
  'USES_STRING',
] as const;

/** Edges along which a change propagates to the source of the edge. */
const IMPACT_KINDS = [
  'CALLS',
  'INSTANTIATES',
  'READS',
  'WRITES',
  'REFERENCES',
  'CONFORMS_TO',
  'INHERITS',
  'EXTENDS',
  'IMPLEMENTS',
  'OVERRIDES',
  'RENDERS',
  'WRAPS',
  'EXPANDS',
];

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function inList(values: readonly string[]): string {
  // Only constants of this module reach here, never user input.
  return `(${values.map((value) => `'${value}'`).join(', ')})`;
}

/**
 * Finds symbols by exact symbol id, qualified name, a dotted suffix of it
 * (`Store.send(_:)`), or a name. Exact matches come first, then by PageRank.
 */
export function resolveSymbol(db: Db, text: string, limit = 10): SymbolRow[] {
  return db
    .prepare(
      `SELECT ${SYMBOL_COLUMNS},
         CASE WHEN n.symbol_id = ? THEN 0 WHEN n.qualified_name = ? THEN 1
              WHEN n.qualified_name LIKE '%.' || ? ESCAPE '\\' THEN 2 ELSE 3 END AS score
       ${FROM_NODES}
       WHERE n.symbol_id = ? OR n.qualified_name = ? OR n.qualified_name LIKE '%.' || ? ESCAPE '\\' OR n.name = ?
         OR (n.kind IN ('function', 'initializer', 'subscript')
             AND (n.name LIKE ? || '(%' ESCAPE '\\' OR n.qualified_name LIKE ? || '(%' ESCAPE '\\'
                  OR n.qualified_name LIKE '%.' || ? || '(%' ESCAPE '\\'))
       ORDER BY score, COALESCE(n.pagerank, 0) DESC LIMIT ?`,
    )
    .all(
      text,
      text,
      escapeLike(text),
      text,
      text,
      escapeLike(text),
      text,
      escapeLike(text),
      escapeLike(text),
      escapeLike(text),
      limit,
    ) as SymbolRow[];
}

/**
 * Full-text search over names, qualified names and doc comments (prefix
 * match). Exact names first, then types, then members; file nodes only when
 * asked for by kind.
 */
export function searchSymbols(db: Db, query: string, options: { kinds?: string[]; limit?: number } = {}): SymbolRow[] {
  const kinds = options.kinds?.length ? options.kinds : [];
  const kindFilter = kinds.length > 0 ? `AND n.kind IN (${kinds.map(() => '?').join(', ')})` : "AND n.kind != 'file'";
  return db
    .prepare(
      `SELECT ${SYMBOL_COLUMNS} FROM symbol_fts s JOIN nodes n ON n.id = s.rowid LEFT JOIN files f ON f.id = n.file_id
       WHERE symbol_fts MATCH ? ${kindFilter}
       ORDER BY n.name = ? COLLATE NOCASE DESC,
         n.kind IN ('class', 'struct', 'enum', 'actor', 'protocol') DESC,
         rank, COALESCE(n.pagerank, 0) DESC
       LIMIT ?`,
    )
    .all(`${ftsPhrase(query)}*`, ...kinds, query, options.limit ?? 20) as SymbolRow[];
}

export function symbolById(db: Db, id: number): SymbolRow | undefined {
  return db.prepare(`SELECT ${SYMBOL_COLUMNS} ${FROM_NODES} WHERE n.id = ?`).get(id) as SymbolRow | undefined;
}

export interface Neighbor extends SymbolRow {
  edgeKind: string;
  confidence: string;
  direction: 'in' | 'out';
  evidenceLine: number | null;
}

export interface NeighborOptions {
  direction?: 'in' | 'out' | 'both';
  kinds?: string[];
  includeAmbiguous?: boolean;
  limit?: number;
}

/** Direct neighbors of a node, strongest and most important first. */
export function neighbors(db: Db, id: number, options: NeighborOptions = {}): Neighbor[] {
  const kinds = options.kinds?.length ? options.kinds : [...SEMANTIC_KINDS, 'CONTAINS'];
  const direction = options.direction ?? 'both';
  const placeholders = kinds.map(() => '?').join(', ');
  const ambiguity = options.includeAmbiguous ? '' : "AND e.confidence != 'AMBIGUOUS'";
  const query = (side: 'in' | 'out') => `
    SELECT ${SYMBOL_COLUMNS}, e.kind AS edgeKind, e.confidence, '${side}' AS direction,
      json_extract(e.evidence, '$[0][1]') AS evidenceLine
    FROM edges e JOIN nodes n ON n.id = e.${side === 'out' ? 'target_id' : 'source_id'}
    LEFT JOIN files f ON f.id = n.file_id
    WHERE e.${side === 'out' ? 'source_id' : 'target_id'} = ? AND e.kind IN (${placeholders}) ${ambiguity}`;
  const parts: string[] = [];
  const parameters: unknown[] = [];
  if (direction !== 'in') {
    parts.push(query('out'));
    parameters.push(id, ...kinds);
  }
  if (direction !== 'out') {
    parts.push(query('in'));
    parameters.push(id, ...kinds);
  }
  return db
    .prepare(
      `SELECT * FROM (${parts.join(' UNION ALL ')})
       ORDER BY CASE confidence WHEN 'EXTRACTED' THEN 0 WHEN 'INFERRED' THEN 1 ELSE 2 END, COALESCE(pagerank, 0) DESC
       LIMIT ?`,
    )
    .all(...parameters, options.limit ?? 50) as Neighbor[];
}

export interface Reached extends SymbolRow {
  depth: number;
}

export interface TraversalNode extends Reached {
  /** Node this one was reached from; null at depth 1. */
  parent: number | null;
  /**
   * Dynamic dispatch on the way: for callers, the protocol requirements (or
   * overridden methods) of the parent that this node calls; for callees, the
   * implementations (or overrides) of this node that run instead.
   */
  dispatch: SymbolRow[];
}

/**
 * Transitive callers (`in`) or callees (`out`) through CALLS/INSTANTIATES,
 * closest first, as a tree (`parent`). Calls through a protocol requirement or
 * an overridable method continue to its implementations, so a chain of layers
 * behind protocols is followed to the end. Breadth-first, one query per level.
 */
export function traverse(
  db: Db,
  id: number,
  direction: 'in' | 'out',
  options: { depth?: number; limit?: number; kinds?: string[]; includeAmbiguous?: boolean } = {},
): TraversalNode[] {
  const kinds = inList(options.kinds?.length ? options.kinds.filter((kind) => /^[A-Z_]+$/.test(kind)) : ['CALLS', 'INSTANTIATES']);
  const ambiguity = options.includeAmbiguous ? '' : "AND e.confidence != 'AMBIGUOUS'";
  const maxDepth = Math.min(options.depth ?? 3, 6);
  const limit = options.limit ?? 50;
  const [from, to] = direction === 'in' ? ['target_id', 'source_id'] : ['source_id', 'target_id'];
  const rows = (sql: string, ids: number[]) =>
    ids.length === 0
      ? []
      : (db.prepare(sql.replace('$ids', ids.map(() => '?').join(', '))).all(...ids) as (SymbolRow & { origin: number })[]);
  const calls = (ids: number[]) =>
    rows(
      `SELECT DISTINCT e.${from} AS origin, ${SYMBOL_COLUMNS} FROM edges e JOIN nodes n ON n.id = e.${to}
       LEFT JOIN files f ON f.id = n.file_id
       WHERE e.${from} IN ($ids) AND e.kind IN ${kinds} ${ambiguity}
       ORDER BY COALESCE(n.pagerank, 0) DESC`,
      ids,
    );
  // Callers: the requirements a node implements (their callers call it too).
  // Callees: the implementations of a called requirement (they run instead).
  const [dispatchFrom, dispatchTo] = direction === 'in' ? ['source_id', 'target_id'] : ['target_id', 'source_id'];
  const dispatch = (ids: number[]) =>
    rows(
      `SELECT DISTINCT e.${dispatchFrom} AS origin, ${SYMBOL_COLUMNS} FROM edges e JOIN nodes n ON n.id = e.${dispatchTo}
       LEFT JOIN files f ON f.id = n.file_id
       WHERE e.${dispatchFrom} IN ($ids) AND e.kind IN ('IMPLEMENTS', 'OVERRIDES') ${ambiguity}`,
      ids,
    );
  const group = (list: (SymbolRow & { origin: number })[]) => {
    const groups = new Map<number, SymbolRow[]>();
    for (const { origin, ...row } of list) groups.set(origin, [...(groups.get(origin) ?? []), row]);
    return groups;
  };

  type Entry = { node: number | null; via: SymbolRow | null };
  const result: TraversalNode[] = [];
  const seen = new Set<number>([id]);
  // Nodes whose calls are followed next: the result node each belongs to and,
  // for a requirement of that node, the requirement itself.
  let frontier = new Map<number, Entry>([[id, { node: null, via: null }]]);
  // Transitive: an override of an implementation, a requirement of an overridden method.
  const addDispatch = (ids: { id: number; node: number | null }[]) => {
    for (let pending = ids; pending.length > 0;) {
      const groups = group(dispatch(pending.map((entry) => entry.id)));
      const next: typeof ids = [];
      for (const { id: from, node } of pending) {
        for (const other of groups.get(from) ?? []) {
          if (seen.has(other.id)) continue;
          seen.add(other.id);
          frontier.set(other.id, { node, via: direction === 'in' ? other : null });
          if (direction === 'out') result.find((entry) => entry.id === node)?.dispatch.push(other);
          next.push({ id: other.id, node });
        }
      }
      pending = next;
    }
  };
  if (direction === 'in') addDispatch([{ id, node: null }]);
  for (let depth = 1; depth <= maxDepth && frontier.size > 0 && result.length < limit; depth++) {
    const current = frontier;
    frontier = new Map();
    const level: TraversalNode[] = [];
    for (const { origin, ...row } of calls([...current.keys()])) {
      if (seen.has(row.id) || result.length + level.length >= limit) continue;
      seen.add(row.id);
      const entry = current.get(origin)!;
      level.push({ ...row, depth, parent: entry.node, dispatch: entry.via ? [entry.via] : [] });
    }
    result.push(...level);
    for (const node of level) frontier.set(node.id, { node: node.id, via: null });
    addDispatch(level.map((node) => ({ id: node.id, node: node.id })));
  }
  return result;
}

export interface PathStep {
  node: SymbolRow;
  /** Edge from the previous step to this node; null for the first node. */
  edge: { kind: string; confidence: string; reversed: boolean } | null;
}

/** Edges that follow the flow of execution, used for directed paths. */
const FLOW_KINDS = ['CALLS', 'INSTANTIATES', 'RENDERS', 'READS', 'WRITES', 'USES_STRING'];

/**
 * Shortest path between two nodes. First along the flow of execution (calls,
 * instantiations, reads, writes, rendering) from `from` to `to`; if there is
 * none, over any semantic edge in either direction. Bidirectional
 * breadth-first search, one query per frontier.
 */
export function findPath(db: Db, from: number, to: number, maxDepth = 6): { steps: PathStep[]; directed: boolean } | null {
  if (from === to) return { steps: [{ node: symbolById(db, from)!, edge: null }], directed: true };
  const directed = searchPath(db, from, to, maxDepth, FLOW_KINDS, true);
  if (directed) return { steps: directed, directed: true };
  const any = searchPath(db, from, to, maxDepth, [...SEMANTIC_KINDS], false);
  return any ? { steps: any, directed: false } : null;
}

type Link = { previous: number; kind: string; confidence: string; reversed: boolean } | null;

function searchPath(db: Db, from: number, to: number, maxDepth: number, kindList: string[], directed: boolean): PathStep[] | null {
  const kinds = inList(kindList);
  /** Neighbors of a frontier; `forward` follows edges source → target. */
  const step = (frontier: number[], forward: boolean) => {
    const placeholders = frontier.map(() => '?').join(', ');
    // SDK symbols (String, Array, ...) are hubs that connect everything; a
    // path through them explains nothing, so they are not traversed.
    const outgoing = `SELECT e.source_id AS a, e.target_id AS b, e.kind, e.confidence, 0 AS reversed FROM edges e
      JOIN nodes n ON n.id = e.target_id
      WHERE e.source_id IN (${placeholders}) AND e.kind IN ${kinds} AND e.confidence != 'AMBIGUOUS'
        AND n.kind != 'external_symbol'`;
    const incoming = `SELECT e.target_id AS a, e.source_id AS b, e.kind, e.confidence, 1 AS reversed FROM edges e
      JOIN nodes n ON n.id = e.source_id
      WHERE e.target_id IN (${placeholders}) AND e.kind IN ${kinds} AND e.confidence != 'AMBIGUOUS'
        AND n.kind != 'external_symbol'`;
    // Directed paths also step from a type into its members (a created view
    // runs its body) and from a protocol requirement to its implementations.
    const typeKinds = "('class', 'struct', 'enum', 'actor')";
    const intoMembers = `SELECT e.source_id AS a, e.target_id AS b, 'CONTAINS' AS kind, e.confidence, 0 AS reversed FROM edges e
      JOIN nodes s ON s.id = e.source_id
      WHERE e.source_id IN (${placeholders}) AND e.kind = 'CONTAINS' AND s.kind IN ${typeKinds}`;
    const fromMembers = `SELECT e.target_id AS a, e.source_id AS b, 'CONTAINS' AS kind, e.confidence, 1 AS reversed FROM edges e
      JOIN nodes s ON s.id = e.source_id
      WHERE e.target_id IN (${placeholders}) AND e.kind = 'CONTAINS' AND s.kind IN ${typeKinds}`;
    const toImplementations = `SELECT e.target_id AS a, e.source_id AS b, 'IMPLEMENTS' AS kind, e.confidence, 1 AS reversed FROM edges e
      WHERE e.target_id IN (${placeholders}) AND e.kind IN ('IMPLEMENTS', 'OVERRIDES') AND e.confidence != 'AMBIGUOUS'`;
    const fromImplementations = `SELECT e.source_id AS a, e.target_id AS b, 'IMPLEMENTS' AS kind, e.confidence, 0 AS reversed FROM edges e
      WHERE e.source_id IN (${placeholders}) AND e.kind IN ('IMPLEMENTS', 'OVERRIDES') AND e.confidence != 'AMBIGUOUS'`;
    const sql = directed
      ? forward
        ? `${outgoing} UNION ALL ${intoMembers} UNION ALL ${toImplementations}`
        : `${incoming} UNION ALL ${fromMembers} UNION ALL ${fromImplementations}`
      : `${outgoing} UNION ALL ${incoming}`;
    const parameters = directed ? [...frontier, ...frontier, ...frontier] : [...frontier, ...frontier];
    return db.prepare(sql).all(...parameters) as { a: number; b: number; kind: string; confidence: string; reversed: number }[];
  };
  const forwardLinks = new Map<number, Link>([[from, null]]);
  const backwardLinks = new Map<number, Link>([[to, null]]);
  let forwardFrontier = [from];
  let backwardFrontier = [to];
  let meeting: number | undefined;
  for (let depth = 0; depth < maxDepth && meeting === undefined; depth++) {
    const expandForward = forwardFrontier.length <= backwardFrontier.length;
    const frontier = expandForward ? forwardFrontier : backwardFrontier;
    const seen = expandForward ? forwardLinks : backwardLinks;
    const other = expandForward ? backwardLinks : forwardLinks;
    const next: number[] = [];
    for (const edge of step(frontier.slice(0, 500), expandForward)) {
      if (seen.has(edge.b)) continue;
      // Links are stored as seen from the start of the path.
      seen.set(edge.b, {
        previous: edge.a,
        kind: edge.kind,
        confidence: edge.confidence,
        reversed: expandForward ? edge.reversed === 1 : edge.reversed === 0,
      });
      next.push(edge.b);
      if (other.has(edge.b)) {
        meeting = edge.b;
        break;
      }
    }
    if (next.length === 0) return null;
    if (expandForward) forwardFrontier = next;
    else backwardFrontier = next;
  }
  if (meeting === undefined) return null;

  const left: PathStep[] = [];
  for (let current: number | undefined = meeting; current !== undefined;) {
    const link: Link | undefined = forwardLinks.get(current);
    left.unshift({
      node: symbolById(db, current)!,
      edge: link ? { kind: link.kind, confidence: link.confidence, reversed: link.reversed } : null,
    });
    current = link?.previous;
  }
  const right: PathStep[] = [];
  for (let current = meeting; ;) {
    const link = backwardLinks.get(current);
    if (!link) break;
    right.push({ node: symbolById(db, link.previous)!, edge: { kind: link.kind, confidence: link.confidence, reversed: link.reversed } });
    current = link.previous;
  }
  return [...left, ...right];
}

export interface Impact {
  seeds: SymbolRow[];
  affected: Reached[];
  tests: SymbolRow[];
  files: string[];
}

/**
 * What a change to some files or symbols may affect: declarations that depend
 * on them (transitively, up to `depth`), the tests that exercise those, and
 * their files.
 */
export function impact(db: Db, input: { files?: string[]; symbols?: number[] }, depth = 3, limit = 100): Impact {
  const seedIds = new Set<number>(input.symbols ?? []);
  for (const path of input.files ?? []) {
    const ids = db
      .prepare(
        `SELECT n.id FROM nodes n JOIN files f ON f.id = n.file_id
         WHERE f.path = ? AND n.kind NOT IN ('file', 'module', 'extension')`,
      )
      .pluck()
      .all(path) as number[];
    for (const id of ids) seedIds.add(id);
  }
  const seeds = [...seedIds].map((id) => symbolById(db, id)).filter((row): row is SymbolRow => row !== undefined);
  if (seeds.length === 0) return { seeds, affected: [], tests: [], files: [] };

  const kinds = inList(IMPACT_KINDS);
  const placeholders = [...seedIds].map(() => '?').join(', ');
  const affected = db
    .prepare(
      `WITH RECURSIVE reach(id, depth) AS (
         SELECT id, 0 FROM nodes WHERE id IN (${placeholders})
         UNION
         SELECT e.source_id, r.depth + 1 FROM edges e JOIN reach r ON e.target_id = r.id
         WHERE e.kind IN ${kinds} AND e.confidence != 'AMBIGUOUS' AND r.depth < ?
         LIMIT 50000
       )
       SELECT ${SYMBOL_COLUMNS}, MIN(r.depth) AS depth FROM reach r JOIN nodes n ON n.id = r.id
       LEFT JOIN files f ON f.id = n.file_id
       WHERE r.depth > 0 AND n.kind NOT IN ('file', 'module')
       GROUP BY n.id ORDER BY depth, COALESCE(n.pagerank, 0) DESC`,
    )
    .all(...seedIds, Math.min(depth, 6)) as Reached[];
  const reachedIds = [...seedIds, ...affected.map((row) => row.id)];
  const reachedPlaceholders = reachedIds.map(() => '?').join(', ');
  const tests = db
    .prepare(
      `SELECT DISTINCT ${SYMBOL_COLUMNS} FROM edges e JOIN nodes n ON n.id = e.source_id LEFT JOIN files f ON f.id = n.file_id
       WHERE e.kind = 'TESTS' AND e.target_id IN (${reachedPlaceholders}) ORDER BY n.qualified_name LIMIT 100`,
    )
    .all(...reachedIds) as SymbolRow[];
  // Declarations of a changed file are part of the change, not affected by it.
  const changed = new Set(input.files ?? []);
  const outside = affected.filter((row) => row.file === null || !changed.has(row.file));
  const files = [...new Set(outside.map((row) => row.file).filter((file): file is string => file !== null))].sort();
  return { seeds, affected: outside.slice(0, limit), tests, files };
}

/** Files whose path is `text` or ends with `/text`. */
export function resolveFile(db: Db, text: string): string[] {
  return db
    .prepare(`SELECT path FROM files WHERE kind = 'swift' AND (path = ? OR path LIKE '%/' || ? ESCAPE '\\') ORDER BY path LIMIT 10`)
    .pluck()
    .all(text, escapeLike(text)) as string[];
}

export interface OutlineEntry extends SymbolRow {
  /** Nesting level: 0 for a top-level declaration of the outline. */
  depth: number;
}

/**
 * Declarations of a file, or of a type with its members and its extensions in
 * any file: in source order (by file), nested as in the source.
 */
export function outline(db: Db, input: { file: string } | { symbol: number }): OutlineEntry[] {
  const ids =
    'file' in input
      ? (db
          .prepare(`SELECT n.id FROM nodes n JOIN files f ON f.id = n.file_id WHERE f.path = ? AND n.kind NOT IN ('file', 'module')`)
          .pluck()
          .all(input.file) as number[])
      : (db
          .prepare(
            `WITH RECURSIVE tree(id) AS (
               SELECT ? UNION SELECT source_id FROM edges WHERE kind = 'EXTENDS' AND target_id = ?
               UNION SELECT e.target_id FROM edges e JOIN tree t ON e.source_id = t.id WHERE e.kind = 'CONTAINS'
             )
             SELECT id FROM tree`,
          )
          .pluck()
          .all(input.symbol, input.symbol) as number[]);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT ${SYMBOL_COLUMNS} ${FROM_NODES} WHERE n.id IN (${placeholders}) ORDER BY f.path, n.start_line, n.id`)
    .all(...ids) as SymbolRow[];
  const parentOf = new Map(
    (
      db
        .prepare(
          `SELECT source_id AS parent, target_id AS child FROM edges
           WHERE kind = 'CONTAINS' AND target_id IN (${placeholders}) AND source_id IN (${placeholders})`,
        )
        .all(...ids, ...ids) as { parent: number; child: number }[]
    ).map(({ parent, child }) => [child, parent]),
  );
  const depthOf = (id: number, seen = 0): number => {
    const parent = parentOf.get(id);
    return parent === undefined || seen > 20 ? 0 : 1 + depthOf(parent, seen + 1);
  };
  // The file of the type itself first, then the files of its extensions.
  const home = 'symbol' in input ? rows.find((row) => row.id === input.symbol)?.file : undefined;
  return rows.map((row) => ({ ...row, depth: depthOf(row.id) })).sort((a, b) => Number(a.file !== home) - Number(b.file !== home));
}

export interface CommunityInfo {
  id: number;
  label: string;
  size: number;
  members: SymbolRow[];
  links: { community: number; label: string; edges: number }[];
}

export function community(db: Db, id: number, limit = 20): CommunityInfo | undefined {
  const row = db.prepare('SELECT id, label, size FROM communities WHERE id = ?').get(id) as
    { id: number; label: string; size: number } | undefined;
  if (!row) return undefined;
  const members = db
    .prepare(`SELECT ${SYMBOL_COLUMNS} ${FROM_NODES} WHERE n.community = ? ORDER BY COALESCE(n.pagerank, 0) DESC LIMIT ?`)
    .all(id, limit) as SymbolRow[];
  const links = db
    .prepare(
      `SELECT other.community, c.label, COUNT(*) AS edges FROM edges e
       JOIN nodes self ON self.id = e.source_id JOIN nodes other ON other.id = e.target_id
       JOIN communities c ON c.id = other.community
       WHERE self.community = ? AND other.community IS NOT NULL AND other.community != ?
         AND e.kind IN ${inList(SEMANTIC_KINDS)} AND e.confidence != 'AMBIGUOUS'
       GROUP BY other.community ORDER BY edges DESC LIMIT 10`,
    )
    .all(id, id) as CommunityInfo['links'];
  return { ...row, members, links };
}

export class SourceAccessError extends Error {}

/**
 * Source text of a declaration. Only files recorded in the database, located
 * inside the repository root after resolving symbolic links, are read.
 */
export function readSource(
  db: Db,
  root: string,
  id: number,
  contextLines = 0,
  maxLines = 400,
): { file: string; startLine: number; text: string } {
  const symbol = symbolById(db, id);
  if (!symbol?.file || symbol.line === null) throw new SourceAccessError('no source location for this symbol');
  const recorded = db.prepare('SELECT 1 FROM files WHERE path = ?').get(symbol.file);
  if (!recorded) throw new SourceAccessError('file is not part of the graph');
  if (symbol.file.split('/').includes('..') || symbol.file.startsWith('/')) throw new SourceAccessError('invalid file path');

  const realRoot = realpathSync(root);
  const absolute = join(realRoot, symbol.file);
  if (lstatSync(absolute).isSymbolicLink()) throw new SourceAccessError('refusing to follow a symbolic link');
  const real = realpathSync(absolute);
  if (!real.startsWith(realRoot + sep)) throw new SourceAccessError('file is outside the repository');

  const descriptor = openSync(real, 'r');
  let text: string;
  try {
    const size = Math.min(fstatSync(descriptor).size, 8 * 1024 * 1024);
    const buffer = Buffer.alloc(size);
    readSync(descriptor, buffer, 0, size, 0);
    text = buffer.toString('utf8');
  } finally {
    closeSync(descriptor);
  }
  const lines = text.split('\n');
  const start = Math.max(1, symbol.line - contextLines);
  const end = Math.min(lines.length, (symbol.endLine ?? symbol.line) + contextLines, start + maxLines - 1);
  return { file: symbol.file, startLine: start, text: lines.slice(start - 1, end).join('\n') };
}
