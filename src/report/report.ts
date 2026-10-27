// Overview of the graph for an agent: what the codebase contains, its main
// areas, the symbols everything depends on, entry points and localization.
// Kept to roughly 2,000 tokens. See docs/01-design.md, section 7.2.

import { basename } from 'node:path';
import type { Db } from '../store/db.ts';
import { getMeta } from '../store/db.ts';

const TYPE_KINDS = "('class', 'struct', 'enum', 'actor', 'protocol')";

function table(headers: string[], rows: (string | number | null)[][]): string {
  if (rows.length === 0) return '_none_\n';
  const escape = (value: string | number | null) => String(value ?? '').replaceAll('|', '\\|');
  return (
    [
      `| ${headers.join(' | ')} |`,
      `| ${headers.map(() => '---').join(' | ')} |`,
      ...rows.map((row) => `| ${row.map(escape).join(' | ')} |`),
    ].join('\n') + '\n'
  );
}

export function graphReport(db: Db, root: string): string {
  const one = <T>(sql: string, ...parameters: unknown[]) =>
    db
      .prepare(sql)
      .pluck()
      .get(...parameters) as T;
  const all = <T>(sql: string, ...parameters: unknown[]) => db.prepare(sql).all(...parameters) as T[];
  const parts: string[] = [];

  const swiftFiles = one<number>("SELECT COUNT(*) FROM files WHERE kind = 'swift'");
  const localizationFiles = one<number>("SELECT COUNT(*) FROM files WHERE kind != 'swift'");
  const modules = one<number>("SELECT COUNT(*) FROM modules WHERE kind = 'target'");
  const declarations = one<number>(
    "SELECT COUNT(*) FROM nodes WHERE kind NOT IN ('module', 'file', 'external_symbol', 'localization_table', 'localized_string')",
  );
  const edges = one<number>('SELECT COUNT(*) FROM edges');
  const calls = one<number>("SELECT COUNT(*) FROM edges WHERE kind = 'CALLS'");
  const ambiguous = one<number>("SELECT COUNT(*) FROM edges WHERE kind = 'CALLS' AND confidence = 'AMBIGUOUS'");

  parts.push(`# Code graph: ${basename(root)}\n`);
  parts.push(
    `Built ${getMeta(db, 'built_at') ?? 'never'}. ${swiftFiles} Swift files, ${localizationFiles} localization files, ` +
      `${modules} modules, ${declarations} declarations, ${edges} edges ` +
      `(${calls} calls, ${calls === 0 ? 0 : Math.round((100 * ambiguous) / calls)}% ambiguous and hidden by default).\n`,
  );

  parts.push('## Modules\n');
  parts.push(
    table(
      ['Module', 'Files', 'Types', 'Functions'],
      all<{ name: string; files: number; types: number; functions: number }>(
        `SELECT m.name,
           (SELECT COUNT(*) FROM files f WHERE f.module_id = m.id AND f.kind = 'swift') AS files,
           (SELECT COUNT(*) FROM nodes n JOIN files f ON f.id = n.file_id WHERE f.module_id = m.id AND n.kind IN ${TYPE_KINDS}) AS types,
           (SELECT COUNT(*) FROM nodes n JOIN files f ON f.id = n.file_id WHERE f.module_id = m.id AND n.kind IN ('function', 'initializer')) AS functions
         FROM modules m WHERE m.kind = 'target' ORDER BY files DESC LIMIT 15`,
      ).map((row) => [row.name, row.files, row.types, row.functions]),
    ),
  );

  parts.push('## Areas (communities)\n');
  const keySymbols = db
    .prepare(
      `SELECT qualified_name FROM nodes WHERE community = ? AND kind IN ${TYPE_KINDS}
     ORDER BY pagerank DESC LIMIT 3`,
    )
    .pluck();
  parts.push(
    table(
      ['#', 'Area', 'Size', 'Key types'],
      all<{ id: number; label: string; size: number }>('SELECT id, label, size FROM communities ORDER BY size DESC LIMIT 12').map((row) => [
        row.id,
        row.label,
        row.size,
        (keySymbols.all(row.id) as string[]).join(', '),
      ]),
    ),
  );

  parts.push('## Most depended-on symbols\n');
  parts.push(
    table(
      ['Symbol', 'Kind', 'Used by', 'Location'],
      all<{ qualified_name: string; kind: string; fan_in: number; path: string | null; start_line: number | null }>(
        `SELECT n.qualified_name, n.kind, n.fan_in, f.path, n.start_line FROM nodes n LEFT JOIN files f ON f.id = n.file_id
         WHERE n.pagerank IS NOT NULL ORDER BY n.pagerank DESC LIMIT 15`,
      ).map((row) => [row.qualified_name, row.kind, row.fan_in, row.path ? `${row.path}:${row.start_line}` : '']),
    ),
  );

  parts.push('## Entry points\n');
  const entries = all<{ qualified_name: string; path: string | null; start_line: number | null; why: string }>(
    `SELECT n.qualified_name, f.path, n.start_line, '@main' AS why FROM nodes n LEFT JOIN files f ON f.id = n.file_id
       WHERE n.modifiers LIKE '%"@main"%'
     UNION
     SELECT n.qualified_name, f.path, n.start_line, 'conforms to ' || t.name FROM edges e
       JOIN nodes n ON n.id = e.source_id JOIN nodes t ON t.id = e.target_id LEFT JOIN files f ON f.id = n.file_id
       WHERE e.kind = 'CONFORMS_TO' AND t.symbol_id IN ('swift:SwiftUI/App', 'swift:UIKit/UIApplicationDelegate', 'swift:AppKit/NSApplicationDelegate')
     UNION
     SELECT f.path, f.path, 1, 'top-level code' FROM files f WHERE f.path = 'main.swift' OR f.path LIKE '%/main.swift'
     LIMIT 15`,
  );
  parts.push(
    entries.length === 0
      ? '_none found_\n'
      : `${entries.map((row) => `- ${row.qualified_name} (${row.why}) — ${row.path}:${row.start_line}`).join('\n')}\n`,
  );

  // Unusual links: large areas joined by a single edge. Often accidental
  // coupling, sometimes a deliberate seam worth knowing about.
  const bridges = all<{ source: string; kind: string; target: string; a: string; b: string }>(
    `WITH pairs AS (
       SELECT s.community AS a, t.community AS b, COUNT(*) AS edges, MIN(e.id) AS edge_id
       FROM edges e JOIN nodes s ON s.id = e.source_id JOIN nodes t ON t.id = e.target_id
       WHERE s.community IS NOT NULL AND t.community IS NOT NULL AND s.community != t.community
         AND e.confidence != 'AMBIGUOUS' AND e.kind NOT IN ('CONTAINS', 'TESTS')
       GROUP BY s.community, t.community
     )
     SELECT s.qualified_name AS source, e.kind, t.qualified_name AS target, ca.label AS a, cb.label AS b
     FROM pairs p JOIN edges e ON e.id = p.edge_id JOIN nodes s ON s.id = e.source_id JOIN nodes t ON t.id = e.target_id
     JOIN communities ca ON ca.id = p.a JOIN communities cb ON cb.id = p.b
     WHERE p.edges = 1 AND ca.size >= 20 AND cb.size >= 20
       -- Tests reach into everything; their links are expected.
       AND s.symbol_id NOT GLOB 'swift:*Tests/*' AND t.symbol_id NOT GLOB 'swift:*Tests/*'
       AND NOT EXISTS (SELECT 1 FROM pairs r WHERE r.a = p.b AND r.b = p.a)
     ORDER BY ca.size * cb.size DESC LIMIT 8`,
  );
  if (bridges.length > 0) {
    parts.push('## Unusual links between areas\n');
    parts.push(`${bridges.map((row) => `- ${row.source} ${row.kind} ${row.target} (${row.a} → ${row.b})`).join('\n')}\n`);
  }

  const tables = one<number>('SELECT COUNT(*) FROM localization_tables');
  if (tables > 0) {
    parts.push('## Localization\n');
    const keys = one<number>('SELECT COUNT(*) FROM localized_strings');
    parts.push(`${tables} tables, ${keys} keys.\n`);
    parts.push(
      table(
        ['Language', 'Translated keys', 'Complete'],
        all<{ language: string; translated: number; total: number }>(
          `SELECT tr.language, COUNT(DISTINCT tr.string_id) AS translated,
             (SELECT COUNT(*) FROM localized_strings s WHERE s.should_translate = 1) AS total
           FROM translations tr WHERE tr.language != 'Base' GROUP BY tr.language ORDER BY tr.language`,
        ).map((row) => [row.language, row.translated, `${row.total === 0 ? 100 : Math.round((100 * row.translated) / row.total)}%`]),
      ),
    );
    const issues = all<{ kind: string; count: number }>(
      'SELECT kind, COUNT(*) AS count FROM localization_issues GROUP BY kind ORDER BY count DESC',
    );
    parts.push(
      issues.length === 0 ? 'No localization issues.\n' : `Issues: ${issues.map((row) => `${row.kind} ${row.count}`).join(', ')}.\n`,
    );
  }

  parts.push('## How to query\n');
  parts.push(
    [
      '- `swiftgraph strings find|show|of|issues ...` — localization keys, translations, usages, issues',
      '- `swiftgraph stats` — counts by edge kind and confidence',
      '- Edges: CALLS, INSTANTIATES, READS, WRITES, REFERENCES, CONFORMS_TO, INHERITS, EXTENDS, IMPLEMENTS, OVERRIDES, RENDERS, TESTS, WRAPS, EXPANDS, USES_STRING; confidence EXTRACTED > INFERRED > AMBIGUOUS.',
      '',
    ].join('\n'),
  );
  return parts.join('\n');
}
