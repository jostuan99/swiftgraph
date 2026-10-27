// What the data-flow engine reads from the graph database: facts of a file,
// edges into and out of a symbol, and the languages of a module.

import type { Db } from '../store/db.ts';
import { storedFacts } from '../build.ts';
import type { FileFacts } from '../schema/types.ts';

export interface EdgeRef {
  /** Symbol id at the other end. */
  symbol: string;
  kind: string;
  evidence: { file: string; line: number }[];
}

export class GraphAccess {
  private readonly db: Db;
  private readonly factsCache = new Map<string, FileFacts | undefined>();
  private filePaths: Map<number, string> | undefined;

  constructor(db: Db) {
    this.db = db;
  }

  facts(path: string): FileFacts | undefined {
    if (!this.factsCache.has(path)) this.factsCache.set(path, storedFacts(this.db, path));
    return this.factsCache.get(path);
  }

  incoming(target: string, kinds: readonly string[]): EdgeRef[] {
    return this.edges('target', target, kinds);
  }

  outgoing(source: string, kinds: readonly string[]): EdgeRef[] {
    return this.edges('source', source, kinds);
  }

  /** Languages with localization files in a module (`.lproj` and String Catalog source languages). */
  languages(module: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT f.language AS language FROM files f JOIN modules m ON m.id = f.module_id
         WHERE m.name = ? AND f.language IS NOT NULL
         UNION
         SELECT DISTINCT t.source_language FROM localization_tables t JOIN modules m ON m.id = t.module_id
         WHERE m.name = ? AND t.source_language IS NOT NULL`,
      )
      .pluck()
      .all(module, module) as string[];
    return [...new Set(rows)].sort();
  }

  private edges(side: 'source' | 'target', symbol: string, kinds: readonly string[]): EdgeRef[] {
    const other = side === 'source' ? 'target' : 'source';
    const placeholders = kinds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT o.symbol_id AS symbol, e.kind, e.evidence FROM edges e
         JOIN nodes n ON n.id = e.${side}_id JOIN nodes o ON o.id = e.${other}_id
         WHERE n.symbol_id = ? AND e.kind IN (${placeholders})`,
      )
      .all(symbol, ...kinds) as { symbol: string; kind: string; evidence: string | null }[];
    const paths = this.paths();
    return rows.map((row) => ({
      symbol: row.symbol,
      kind: row.kind,
      evidence: ((row.evidence ? JSON.parse(row.evidence) : []) as [number, number][])
        .filter(([file]) => paths.has(file))
        .map(([file, line]) => ({ file: paths.get(file)!, line })),
    }));
  }

  private paths(): Map<number, string> {
    if (!this.filePaths) {
      const rows = this.db.prepare('SELECT id, path FROM files').all() as { id: number; path: string }[];
      this.filePaths = new Map(rows.map((row) => [row.id, row.path]));
    }
    return this.filePaths;
  }
}
