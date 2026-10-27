// Replaces the nodes and edges of the database with a resolved graph, in one
// transaction, and refreshes the search index and degree metrics.

import type { IssueRecord } from '../localization/resolve.ts';
import type { Graph } from '../resolve/graph.ts';
import type { Db } from './db.ts';

const LOCALIZATION_TABLES = ['localization_issues', 'string_fts', 'translations', 'localized_strings', 'localization_tables'];

/** Writes the localization tables of a graph whose nodes are already stored. */
function writeLocalization(db: Db, graph: Graph, nodeIds: Map<string, number>, fileIds: Map<string, number>): void {
  const moduleIds = new Map(
    (db.prepare('SELECT id, name FROM modules').all() as { id: number; name: string }[]).map((row) => [row.name, row.id]),
  );
  const insertTable = db.prepare('INSERT INTO localization_tables (node_id, module_id, name, source_language) VALUES (?, ?, ?, ?)');
  const insertString = db.prepare(
    `INSERT INTO localized_strings (node_id, table_id, key, comment, extraction_state, should_translate)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertTranslation = db.prepare(
    `INSERT INTO translations (string_id, language, variation_path, value, value_hash, state, format_args, file_id, line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (string_id, language, variation_path, file_id) DO UPDATE SET
       value = excluded.value, value_hash = excluded.value_hash, state = excluded.state,
       format_args = excluded.format_args, line = excluded.line`,
  );
  const insertSearch = db.prepare('INSERT INTO string_fts (key, comment, value, string_id, language) VALUES (?, ?, ?, ?, ?)');

  for (const table of graph.localization.tables.values()) {
    const tableNode = nodeIds.get(table.symbolId);
    if (tableNode === undefined) continue;
    insertTable.run(tableNode, moduleIds.get(table.module) ?? null, table.name, table.sourceLanguage);
    for (const record of table.strings.values()) {
      const stringNode = nodeIds.get(record.symbolId);
      if (stringNode === undefined) continue;
      insertString.run(stringNode, tableNode, record.key, record.comment, record.extractionState, record.shouldTranslate ? 1 : 0);
      insertSearch.run(record.key, record.comment ?? '', '', stringNode, null);
      for (const translation of record.translations) {
        const fileId = fileIds.get(translation.file);
        if (fileId === undefined) continue;
        insertTranslation.run(
          stringNode,
          translation.language,
          translation.variationPath,
          translation.value,
          translation.valueHash,
          translation.state,
          translation.formatArgs.length > 0 ? JSON.stringify(translation.formatArgs) : null,
          fileId,
          translation.line,
        );
        if (translation.value) insertSearch.run(record.key, '', translation.value, stringNode, translation.language);
      }
    }
  }
  insertIssues(db, [...graph.localization.issues, ...graph.referenceIssues], nodeIds, fileIds);
}

function insertIssues(db: Db, issues: IssueRecord[], nodeIds: Map<string, number>, fileIds: Map<string, number>): void {
  const insert = db.prepare(
    'INSERT INTO localization_issues (kind, string_id, node_id, language, file_id, line, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const issue of issues) {
    insert.run(
      issue.kind,
      issue.string ? (nodeIds.get(issue.string) ?? null) : null,
      issue.node ? (nodeIds.get(issue.node) ?? null) : null,
      issue.language ?? null,
      issue.file ? (fileIds.get(issue.file) ?? null) : null,
      issue.line ?? null,
      issue.detail ?? null,
    );
  }
}

/** Keys that no code uses: derived from the USES_STRING edges in the database. */
function refreshUnusedKeys(db: Db): void {
  db.prepare("DELETE FROM localization_issues WHERE kind = 'unused_key'").run();
  db.prepare(
    `INSERT INTO localization_issues (kind, string_id)
     SELECT 'unused_key', s.node_id FROM localized_strings s
     WHERE COALESCE(s.extraction_state, '') != 'manual'
       AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.target_id = s.node_id AND e.kind = 'USES_STRING')`,
  ).run();
}

export function writeGraph(db: Db, graph: Graph): void {
  const fileIds = new Map<string, number>();
  for (const row of db.prepare('SELECT id, path FROM files').all() as { id: number; path: string }[]) {
    fileIds.set(row.path, row.id);
  }

  const insertNode = db.prepare(
    `INSERT INTO nodes (id, symbol_id, kind, name, qualified_name, signature, access, modifiers, file_id,
       start_line, start_col, end_line, end_col, doc, conditions, fan_in, fan_out)
     VALUES (@id, @symbolId, @kind, @name, @qualifiedName, @signature, @access, @modifiers, @fileId,
       @startLine, @startCol, @endLine, @endCol, @doc, @conditions, @fanIn, @fanOut)`,
  );
  const insertEdge = db.prepare(
    `INSERT INTO edges (source_id, target_id, kind, confidence, weight, count, evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  // Fan-in and fan-out of every node, counted over the edges written below.
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  for (const edge of graph.edges.values()) {
    if (!FAN_KIND_SET.has(edge.kind) || !graph.nodes.has(edge.source) || !graph.nodes.has(edge.target)) continue;
    fanOut.set(edge.source, (fanOut.get(edge.source) ?? 0) + 1);
    fanIn.set(edge.target, (fanIn.get(edge.target) ?? 0) + 1);
  }

  // The graph is replaced as a whole and every reference below is built from
  // the same in-memory maps, so per-row foreign key checks are skipped during
  // the bulk write (the pragma cannot change inside a transaction).
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      // Secondary indexes are created again after the bulk insert: building an
      // index from all rows at once is faster than updating it row by row.
      const indexes = db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('nodes', 'edges') AND sql IS NOT NULL")
        .all() as { name: string; sql: string }[];
      for (const index of indexes) db.exec(`DROP INDEX "${index.name}"`);
      db.prepare('DELETE FROM edges').run();
      for (const table of LOCALIZATION_TABLES) db.prepare(`DELETE FROM ${table}`).run();
      db.prepare('DELETE FROM nodes').run();

      const nodeIds = new Map<string, number>();
      let nextId = 1;
      for (const node of graph.nodes.values()) {
        const id = nextId++;
        insertNode.run({
          id,
          symbolId: node.symbolId,
          kind: node.kind,
          name: node.name,
          qualifiedName: node.qualifiedName,
          signature: node.signature,
          access: node.access,
          modifiers: node.modifiers.length > 0 ? JSON.stringify(node.modifiers) : null,
          fileId: node.file ? (fileIds.get(node.file) ?? null) : null,
          startLine: node.range?.[0] ?? null,
          startCol: node.range?.[1] ?? null,
          endLine: node.range?.[2] ?? null,
          endCol: node.range?.[3] ?? null,
          doc: node.doc,
          conditions: node.conditions.length > 0 ? JSON.stringify(node.conditions) : null,
          fanIn: fanIn.get(node.symbolId) ?? 0,
          fanOut: fanOut.get(node.symbolId) ?? 0,
        });
        nodeIds.set(node.symbolId, id);
      }

      for (const edge of graph.edges.values()) {
        const source = nodeIds.get(edge.source);
        const target = nodeIds.get(edge.target);
        if (source === undefined || target === undefined) continue;
        const evidence = edge.evidence.map((item) => [fileIds.get(item.file), item.line]).filter((pair) => pair[0] !== undefined);
        insertEdge.run(
          source,
          target,
          edge.kind,
          edge.confidence,
          edge.weight,
          edge.count,
          evidence.length > 0 ? JSON.stringify(evidence) : null,
        );
      }

      for (const index of indexes) db.exec(index.sql);
      db.prepare("INSERT INTO symbol_fts(symbol_fts) VALUES ('rebuild')").run();
      writeLocalization(db, graph, nodeIds, fileIds);
      refreshUnusedKeys(db);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

const FAN_KIND_SET: ReadonlySet<string> = new Set(['CALLS', 'INSTANTIATES', 'REFERENCES', 'READS', 'WRITES']);
const FAN_KINDS = `(${[...FAN_KIND_SET].map((kind) => `'${kind}'`).join(', ')})`;

/**
 * Replaces the part of the graph that comes from `paths`: the edges whose
 * source is declared in those files (or is the file itself), and the
 * positions, docs and modifiers of their nodes. Used when the files keep their
 * declaration digest, so the set of nodes is unchanged.
 */
export function replaceFileContributions(db: Db, graph: Graph, paths: ReadonlySet<string>): void {
  const fileIds = new Map<string, number>();
  for (const row of db.prepare('SELECT id, path FROM files').all() as { id: number; path: string }[]) {
    fileIds.set(row.path, row.id);
  }
  const changedFileIds = [...paths].map((path) => fileIds.get(path)).filter((id): id is number => id !== undefined);
  if (changedFileIds.length === 0) return;
  const placeholders = changedFileIds.map(() => '?').join(', ');

  const nodeId = db.prepare('SELECT id FROM nodes WHERE symbol_id = ?').pluck();
  const insertNode = db.prepare(
    `INSERT INTO nodes (symbol_id, kind, name, qualified_name, signature)
     VALUES (@symbolId, @kind, @name, @qualifiedName, @signature) RETURNING id`,
  );
  const oldNode = db.prepare('SELECT id, name, qualified_name, doc FROM nodes WHERE symbol_id = ?');
  const updateNode = db.prepare(
    `UPDATE nodes SET signature = @signature, access = @access, modifiers = @modifiers,
       start_line = @startLine, start_col = @startCol, end_line = @endLine, end_col = @endCol,
       doc = @doc, conditions = @conditions
     WHERE id = @id`,
  );
  const ftsDelete = db.prepare("INSERT INTO symbol_fts (symbol_fts, rowid, name, qualified_name, doc) VALUES ('delete', ?, ?, ?, ?)");
  const ftsInsert = db.prepare('INSERT INTO symbol_fts (rowid, name, qualified_name, doc) VALUES (?, ?, ?, ?)');
  const insertEdge = db.prepare(
    `INSERT INTO edges (source_id, target_id, kind, confidence, weight, count, evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateFan = db.prepare(
    `UPDATE nodes SET
       fan_in = (SELECT COUNT(*) FROM edges WHERE target_id = nodes.id AND kind IN ${FAN_KINDS}),
       fan_out = (SELECT COUNT(*) FROM edges WHERE source_id = nodes.id AND kind IN ${FAN_KINDS})
     WHERE id = ?`,
  );

  db.transaction(() => {
    const affected = new Set<number>();
    const sourceIds = db
      .prepare(`SELECT id FROM nodes WHERE file_id IN (${placeholders})`)
      .pluck()
      .all(...changedFileIds) as number[];
    for (const id of sourceIds) affected.add(id);
    const oldTargets = db
      .prepare(
        `SELECT DISTINCT target_id FROM edges
         WHERE source_id IN (SELECT id FROM nodes WHERE file_id IN (${placeholders}))`,
      )
      .pluck()
      .all(...changedFileIds) as number[];
    for (const id of oldTargets) affected.add(id);
    db.prepare(`DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file_id IN (${placeholders}))`).run(...changedFileIds);

    // Nodes of the changed files: same ids, new positions and docs.
    for (const node of graph.nodes.values()) {
      if (!node.file || !paths.has(node.file)) continue;
      const old = oldNode.get(node.symbolId) as { id: number; name: string; qualified_name: string; doc: string | null } | undefined;
      if (!old) continue;
      updateNode.run({
        id: old.id,
        signature: node.signature,
        access: node.access,
        modifiers: node.modifiers.length > 0 ? JSON.stringify(node.modifiers) : null,
        startLine: node.range?.[0] ?? null,
        startCol: node.range?.[1] ?? null,
        endLine: node.range?.[2] ?? null,
        endCol: node.range?.[3] ?? null,
        doc: node.doc,
        conditions: node.conditions.length > 0 ? JSON.stringify(node.conditions) : null,
      });
      if (old.doc !== node.doc) {
        ftsDelete.run(old.id, old.name, old.qualified_name, old.doc);
        ftsInsert.run(old.id, node.name, node.qualifiedName, node.doc);
      }
    }

    const idOf = (symbolId: string): number | undefined => {
      const existing = nodeId.get(symbolId) as number | undefined;
      if (existing !== undefined) return existing;
      // A newly referenced SDK symbol.
      const node = graph.nodes.get(symbolId);
      if (!node || node.kind !== 'external_symbol') return undefined;
      const id = (
        insertNode.get({ symbolId, kind: node.kind, name: node.name, qualifiedName: node.qualifiedName, signature: node.signature }) as {
          id: number;
        }
      ).id;
      ftsInsert.run(id, node.name, node.qualifiedName, null);
      return id;
    };

    for (const edge of graph.edges.values()) {
      const sourceNode = graph.nodes.get(edge.source);
      if (!sourceNode?.file || !paths.has(sourceNode.file)) continue;
      const source = idOf(edge.source);
      const target = idOf(edge.target);
      if (source === undefined || target === undefined) continue;
      const evidence = edge.evidence.map((item) => [fileIds.get(item.file), item.line]).filter((pair) => pair[0] !== undefined);
      insertEdge.run(
        source,
        target,
        edge.kind,
        edge.confidence,
        edge.weight,
        edge.count,
        evidence.length > 0 ? JSON.stringify(evidence) : null,
      );
      affected.add(target);
    }

    for (const id of affected) updateFan.run(id);

    // Issues found in the references of the changed files.
    db.prepare(
      `DELETE FROM localization_issues WHERE kind IN ('missing_key', 'dynamic_key_usage')
       AND node_id IN (SELECT id FROM nodes WHERE file_id IN (${placeholders}))`,
    ).run(...changedFileIds);
    const issues = graph.referenceIssues.filter((issue) => issue.file !== undefined && paths.has(issue.file));
    const issueNodeIds = new Map<string, number>();
    for (const issue of issues) {
      if (issue.node && !issueNodeIds.has(issue.node)) {
        const id = idOf(issue.node);
        if (id !== undefined) issueNodeIds.set(issue.node, id);
      }
    }
    insertIssues(db, issues, issueNodeIds, fileIds);
    refreshUnusedKeys(db);
  })();
}
