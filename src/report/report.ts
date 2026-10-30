// Overview of the graph for an agent: what the codebase contains, its main
// areas, the symbols everything depends on, entry points and localization.
// Kept to roughly 2,000 tokens. See docs/01-design.md, section 7.2.

import { basename } from 'node:path';
import type { Db } from '../store/db.ts';
import { getMeta } from '../store/db.ts';
import { modulePrefix } from '../query/text.ts';

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
  // Names without the module when the project has only one.
  const prefix = modulePrefix(db);
  const short = (name: string) => (prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name);

  const swiftFiles = one<number>("SELECT COUNT(*) FROM files WHERE kind = 'swift'");
  const localizationFiles = one<number>("SELECT COUNT(*) FROM files WHERE kind != 'swift'");
  // Modules with declarations: not the package manifest's own.
  const modules = one<number>(
    `SELECT COUNT(*) FROM modules m WHERE m.kind = 'target' AND EXISTS (
       SELECT 1 FROM files f JOIN nodes n ON n.file_id = f.id WHERE f.module_id = m.id AND n.kind NOT IN ('file', 'module', 'property'))`,
  );
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
      )
        // A module with no declarations is the package manifest's own.
        .filter((row) => row.types + row.functions > 0)
        .map((row) => [row.name, row.files, row.types, row.functions]),
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
      all<{ id: number; label: string; size: number }>('SELECT id, label, size FROM communities ORDER BY size DESC LIMIT 12').map((row) => {
        const label = short(row.label);
        // The area is named after its first key type: not repeated.
        const types = (keySymbols.all(row.id) as string[]).map(short).filter((name) => !label.startsWith(`${name} `));
        return [row.id, label, row.size, types.join(', ')];
      }),
    ),
  );

  parts.push(screens(db, short));

  parts.push('## Most depended-on symbols (by PageRank)\n');
  parts.push(
    table(
      ['Symbol', 'Kind', 'Used by', 'Location'],
      all<{ qualified_name: string; kind: string; fan_in: number; path: string | null; start_line: number | null }>(
        `SELECT n.qualified_name, n.kind, n.fan_in, f.path, n.start_line FROM nodes n LEFT JOIN files f ON f.id = n.file_id
         WHERE n.pagerank IS NOT NULL ORDER BY n.pagerank DESC LIMIT 15`,
      ).map((row) => [short(row.qualified_name), row.kind, row.fan_in, row.path ? `${row.path}:${row.start_line}` : '']),
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
      : `${entries.map((row) => `- ${short(row.qualified_name)} (${row.why}) — ${row.path}:${row.start_line}`).join('\n')}\n`,
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
    parts.push(
      `${bridges.map((row) => `- ${short(row.source)} ${row.kind} ${short(row.target)} (${short(row.a)} → ${short(row.b)})`).join('\n')}\n`,
    );
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

  parts.push(
    'Next: get_screen_definition / get_screen_flows <screen>, get_outline <file or type>, search_symbols <name>, get_symbol <symbol>.\n',
  );
  return parts.join('\n');
}

/** SDK types a screen inherits from or conforms to, and how the screen is listed. */
const SCREEN_BASES: [string, string][] = [
  ['swift:SwiftUI/View', 'SwiftUI View'],
  ['swift:UIKit/UIViewController', 'UIViewController'],
  ['swift:AppKit/NSViewController', 'NSViewController'],
];

/**
 * Screens, for get_screen_definition and get_screen_flows: view controllers and
 * SwiftUI views that no other view renders. Views rendered inside another one
 * (rows, subviews, NavigationLink destinations) are named on one line.
 */
function screens(db: Db, short: (name: string) => string): string {
  const rows = db.prepare(
    `WITH RECURSIVE base(id, kind) AS (
         SELECT n.id, ? FROM nodes n WHERE n.symbol_id = ?
         UNION
         SELECT e.source_id, b.kind FROM edges e JOIN base b ON e.target_id = b.id
         WHERE e.kind IN ('INHERITS', 'CONFORMS_TO') AND e.confidence != 'AMBIGUOUS'
       )
       SELECT DISTINCT n.id, n.qualified_name AS name, b.kind, f.path, n.start_line AS line
       FROM base b JOIN nodes n ON n.id = b.id LEFT JOIN files f ON f.id = n.file_id
       WHERE n.kind IN ('class', 'struct', 'enum', 'actor') AND n.symbol_id NOT GLOB 'swift:*Tests/*'
       ORDER BY f.path, n.start_line`,
  );
  const found = SCREEN_BASES.flatMap(
    ([symbol, kind]) => rows.all(kind, symbol) as { id: number; name: string; kind: string; path: string | null; line: number | null }[],
  );
  if (found.length === 0) return '';
  // Rendered by a member of another view (not by an App scene, say).
  const views = new Set(found.map((row) => row.id));
  const renderedBy = db
    .prepare(
      `SELECT r.target_id AS view, COALESCE(c.source_id, r.source_id) AS owner FROM edges r
       LEFT JOIN edges c ON c.target_id = r.source_id AND c.kind = 'CONTAINS'
       WHERE r.kind = 'RENDERS'`,
    )
    .all() as { view: number; owner: number }[];
  const nested = new Set(renderedBy.filter((row) => views.has(row.owner) && row.owner !== row.view).map((row) => row.view));
  const top = found.filter((row) => !nested.has(row.id));
  const inside = found.filter((row) => nested.has(row.id));
  const limit = 40;
  const lines = top.slice(0, limit).map((row) => `- ${short(row.name)} [${row.kind}] ${row.path ?? ''}:${row.line ?? 1}`);
  if (top.length > limit) lines.push(`- … ${top.length - limit} more (search_symbols)`);
  if (inside.length > 0) {
    const names = inside.map((row) => short(row.name));
    lines.push(
      `- Rendered inside or opened from another view: ${names.slice(0, limit).join(', ')}${names.length > limit ? `, … ${names.length - limit} more` : ''}`,
    );
  }
  return `## Screens\n\n${lines.join('\n')}\n`;
}
