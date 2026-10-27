// Read-only queries over localization data, shared by the CLI and (G5) the
// MCP server. Every statement binds its inputs; FTS input is quoted as a
// phrase so user text cannot inject FTS syntax.

import type { Db } from '../store/db.ts';

export const VALUE_PREVIEW_LIMIT = 200;

export function ftsPhrase(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

function preview(value: string | null): string | null {
  if (value === null) return null;
  return value.length > VALUE_PREVIEW_LIMIT ? `${value.slice(0, VALUE_PREVIEW_LIMIT)}…` : value;
}

export interface StringHit {
  stringId: number;
  key: string;
  table: string;
  module: string | null;
  language: string | null;
  value: string | null;
}

/** Finds strings by key, comment or translated text. */
export function searchStrings(db: Db, query: string, options: { language?: string; limit?: number } = {}): StringHit[] {
  const rows = db
    .prepare(
      `SELECT f.string_id AS stringId, s.key, t.name AS "table", m.name AS module, f.language, f.value
       FROM string_fts f
       JOIN localized_strings s ON s.node_id = f.string_id
       JOIN localization_tables t ON t.node_id = s.table_id
       LEFT JOIN modules m ON m.id = t.module_id
       WHERE string_fts MATCH ? AND (? IS NULL OR f.language = ? OR f.language IS NULL)
       ORDER BY rank LIMIT ?`,
    )
    .all(ftsPhrase(query), options.language ?? null, options.language ?? null, options.limit ?? 20) as StringHit[];
  const seen = new Set<string>();
  return rows
    .filter((row) => {
      const key = `${row.stringId}|${row.language}`;
      return !seen.has(key) && seen.add(key);
    })
    .map((row) => ({ ...row, value: preview(row.value || null) }));
}

export interface StringDetail {
  stringId: number;
  key: string;
  table: string;
  module: string | null;
  comment: string | null;
  translations: { language: string; variation: string; value: string | null; state: string | null }[];
  languagesMissing: string[];
  usages: { symbol: string; confidence: string; file: string | null; line: number | null }[];
}

export function stringDetails(db: Db, key: string, table?: string): StringDetail[] {
  const strings = db
    .prepare(
      `SELECT s.node_id AS stringId, s.key, t.name AS "table", m.name AS module, s.comment
       FROM localized_strings s JOIN localization_tables t ON t.node_id = s.table_id
       LEFT JOIN modules m ON m.id = t.module_id
       WHERE s.key = ? AND (? IS NULL OR t.name = ?) ORDER BY m.name, t.name`,
    )
    .all(key, table ?? null, table ?? null) as Omit<StringDetail, 'translations' | 'languagesMissing' | 'usages'>[];
  const translations = db.prepare(
    `SELECT language, variation_path AS variation, value, state FROM translations
     WHERE string_id = ? ORDER BY language, variation_path`,
  );
  const missing = db
    .prepare("SELECT language FROM localization_issues WHERE string_id = ? AND kind = 'missing_translation' ORDER BY language")
    .pluck();
  const usages = db.prepare(
    `SELECT n.symbol_id AS symbol, e.confidence, f.path AS file, json_extract(e.evidence, '$[0][1]') AS line
     FROM edges e JOIN nodes n ON n.id = e.source_id LEFT JOIN files f ON f.id = n.file_id
     WHERE e.target_id = ? AND e.kind = 'USES_STRING' ORDER BY n.symbol_id`,
  );
  return strings.map((string) => ({
    ...string,
    translations: (translations.all(string.stringId) as StringDetail['translations']).map((row) => ({
      ...row,
      value: preview(row.value),
    })),
    languagesMissing: missing.all(string.stringId) as string[],
    usages: usages.all(string.stringId) as StringDetail['usages'],
  }));
}

export interface SymbolString {
  symbol: string;
  key: string;
  table: string;
  value: string | null;
}

/**
 * Keys used by a symbol (matched by symbol id, qualified name, or a suffix of
 * it such as `AppView.body`) and, with depth, by what it calls or renders.
 */
export function stringsOfSymbol(db: Db, symbol: string, depth = 0): SymbolString[] {
  return (
    db
      .prepare(
        `WITH RECURSIVE roots(id) AS (
           SELECT id FROM nodes WHERE symbol_id = ? OR qualified_name = ? OR qualified_name LIKE '%.' || ? ESCAPE '\\'
         ),
         reach(id, depth) AS (
           SELECT id, 0 FROM roots
           UNION
           SELECT e.target_id, r.depth + 1 FROM edges e JOIN reach r ON e.source_id = r.id
           WHERE e.kind IN ('CALLS', 'RENDERS') AND e.confidence != 'AMBIGUOUS' AND r.depth < ?
           UNION
           -- A rendered view shows the strings of its body.
           SELECT e.target_id, r.depth FROM edges e JOIN reach r ON e.source_id = r.id
           JOIN nodes member ON member.id = e.target_id
           WHERE e.kind = 'CONTAINS' AND member.name = 'body' AND member.kind = 'property'
         )
         SELECT DISTINCT n.symbol_id AS symbol, s.key, t.name AS "table",
           (SELECT value FROM translations tr WHERE tr.string_id = s.node_id AND tr.language = t.source_language
            ORDER BY tr.variation_path LIMIT 1) AS value
         FROM reach r JOIN edges e ON e.source_id = r.id AND e.kind = 'USES_STRING'
         JOIN nodes n ON n.id = r.id
         JOIN localized_strings s ON s.node_id = e.target_id
         JOIN localization_tables t ON t.node_id = s.table_id
         ORDER BY n.symbol_id, s.key`,
      )
      .all(symbol, symbol, escapeLike(symbol), depth) as SymbolString[]
  ).map((row) => ({ ...row, value: preview(row.value) }));
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export interface IssueRow {
  kind: string;
  table: string | null;
  key: string | null;
  language: string | null;
  symbol: string | null;
  file: string | null;
  line: number | null;
  detail: string | null;
}

export function localizationIssues(db: Db, filter: { kind?: string; language?: string; limit?: number } = {}): IssueRow[] {
  return db
    .prepare(
      `SELECT i.kind, t.name AS "table", s.key, i.language, n.symbol_id AS symbol,
         COALESCE(f.path, nf.path) AS file, i.line, i.detail
       FROM localization_issues i
       LEFT JOIN localized_strings s ON s.node_id = i.string_id
       LEFT JOIN localization_tables t ON t.node_id = s.table_id
       LEFT JOIN nodes n ON n.id = i.node_id
       LEFT JOIN files f ON f.id = i.file_id
       LEFT JOIN files nf ON nf.id = n.file_id
       WHERE (? IS NULL OR i.kind = ?) AND (? IS NULL OR i.language = ?)
       ORDER BY i.kind, t.name, s.key, i.language LIMIT ?`,
    )
    .all(filter.kind ?? null, filter.kind ?? null, filter.language ?? null, filter.language ?? null, filter.limit ?? 200) as IssueRow[];
}
