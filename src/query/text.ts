// Compact text output for agents and the CLI. Every formatter takes a token
// budget (about 4 characters per token) and cuts lists to fit it.

import type { Db } from '../store/db.ts';
import {
  community,
  findPath,
  impact,
  neighbors,
  readSource,
  resolveSymbol,
  searchSymbols,
  traverse,
  type Neighbor,
  type SymbolRow,
} from './graph.ts';
import { localizationIssues, searchStrings, stringDetails, stringsOfSymbol } from './strings.ts';

export const DEFAULT_BUDGET = 1500;

class Writer {
  private readonly lines: string[] = [];
  private used = 0;
  private truncated = 0;
  private readonly limit: number;

  constructor(budgetTokens: number) {
    this.limit = Math.max(200, budgetTokens * 4);
  }

  line(text: string): boolean {
    if (this.used + text.length + 1 > this.limit) {
      this.truncated++;
      return false;
    }
    this.lines.push(text);
    this.used += text.length + 1;
    return true;
  }

  toString(): string {
    return this.truncated > 0
      ? `${this.lines.join('\n')}\n… ${this.truncated} more line(s) cut by the token budget`
      : this.lines.join('\n');
  }
}

/** Cuts text to an approximate token budget, by whole lines. */
export function clipToBudget(text: string, budgetTokens: number): string {
  const writer = new Writer(budgetTokens);
  for (const line of text.split('\n')) if (!writer.line(line)) break;
  const total = text.split('\n').length;
  const kept = writer.toString().split('\n').length;
  return kept >= total ? text : `${writer.toString().replace(/\n… .*$/, '')}\n… ${total - kept} more line(s) cut by the token budget`;
}

function location(row: { file: string | null; line: number | null }): string {
  return row.file ? `${row.file}:${row.line ?? 1}` : '';
}

function heading(row: SymbolRow): string {
  const access = row.access ? `, ${row.access}` : '';
  return `${row.qualifiedName}  [${row.kind}${access}${row.file ? `, ${location(row)}` : ''}]`;
}

/** A symbol from user text, or a message listing candidates. */
export function pickSymbol(db: Db, text: string): { symbol?: SymbolRow; message?: string } {
  const candidates = resolveSymbol(db, text, 8);
  if (candidates.length === 0) return { message: `no symbol matches "${text}"; try search_symbols` };
  const first = candidates[0]!;
  const exact = candidates.filter((candidate) => candidate.symbolId === text || candidate.qualifiedName === text);
  if (exact.length === 1 || candidates.length === 1) return { symbol: exact[0] ?? first };
  // Several dotted-suffix matches: ambiguous unless one ranks first by kind of match.
  const suffix = candidates.filter((candidate) => candidate.qualifiedName.endsWith(`.${text}`));
  if (suffix.length === 1) return { symbol: suffix[0]! };
  return {
    message: `"${text}" matches several symbols; use one of:\n${candidates.map((candidate) => `  ${candidate.symbolId}  [${candidate.kind}, ${location(candidate)}]`).join('\n')}`,
  };
}

export function formatSearch(db: Db, query: string, kinds: string[] | undefined, limit: number, budget = DEFAULT_BUDGET): string {
  const writer = new Writer(budget);
  const rows = searchSymbols(db, query, { ...(kinds ? { kinds } : {}), limit });
  if (rows.length === 0) return `no symbols match "${query}"`;
  for (const row of rows) writer.line(`${row.symbolId}  [${row.kind}, ${location(row)}]`);
  return writer.toString();
}

function groupNeighbors(rows: Neighbor[]): Map<string, Neighbor[]> {
  const groups = new Map<string, Neighbor[]>();
  for (const row of rows) {
    const key = `${row.direction === 'out' ? '→' : '←'} ${row.edgeKind}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}

export function formatSymbol(db: Db, text: string, budget = DEFAULT_BUDGET): string {
  const { symbol, message } = pickSymbol(db, text);
  if (!symbol) return message!;
  const writer = new Writer(budget);
  writer.line(heading(symbol));
  if (symbol.signature) writer.line(`  ${symbol.signature}`);
  if (symbol.doc) writer.line(`  /// ${symbol.doc.replaceAll('\n', ' ').slice(0, 300)}`);
  if (symbol.conditions) writer.line(`  #if ${(JSON.parse(symbol.conditions) as string[]).join(' | ')}`);
  if (symbol.community !== null) {
    const label = db.prepare('SELECT label FROM communities WHERE id = ?').pluck().get(symbol.community) as string | undefined;
    writer.line(`  area: #${symbol.community} ${label ?? ''}`);
  }
  for (const [group, rows] of groupNeighbors(neighbors(db, symbol.id, { limit: 200 }))) {
    const shown = rows
      .slice(0, 6)
      .map((row) => `${row.qualifiedName}${row.confidence === 'EXTRACTED' ? '' : ` (${row.confidence.toLowerCase()})`}`);
    writer.line(`  ${group} (${rows.length}): ${shown.join(' · ')}${rows.length > 6 ? ' · …' : ''}`);
  }
  return writer.toString();
}

export function formatNeighbors(
  db: Db,
  text: string,
  options: { direction?: 'in' | 'out' | 'both'; kinds?: string[]; includeAmbiguous?: boolean; limit?: number },
  budget = DEFAULT_BUDGET,
): string {
  const { symbol, message } = pickSymbol(db, text);
  if (!symbol) return message!;
  const writer = new Writer(budget);
  writer.line(heading(symbol));
  const rows = neighbors(db, symbol.id, { limit: options.limit ?? 50, ...options });
  if (rows.length === 0) writer.line('  no neighbors');
  for (const row of rows) {
    writer.line(`  ${row.direction === 'out' ? '→' : '←'} ${row.edgeKind}  ${row.qualifiedName}  ${location(row)}  ${row.confidence}`);
  }
  return writer.toString();
}

export function formatTraversal(
  db: Db,
  text: string,
  direction: 'in' | 'out',
  options: { depth?: number; limit?: number; includeAmbiguous?: boolean },
  budget = DEFAULT_BUDGET,
): string {
  const { symbol, message } = pickSymbol(db, text);
  if (!symbol) return message!;
  const writer = new Writer(budget);
  writer.line(`${heading(symbol)}\n  ${direction === 'in' ? 'callers' : 'callees'} (depth ≤ ${options.depth ?? 3}):`);
  const rows = traverse(db, symbol.id, direction, options);
  if (rows.length === 0) writer.line('  none');
  for (const row of rows) writer.line(`  ${'  '.repeat(row.depth - 1)}${row.depth}. ${row.qualifiedName}  ${location(row)}`);
  return writer.toString();
}

export function formatPath(db: Db, fromText: string, toText: string, maxDepth = 6, budget = DEFAULT_BUDGET): string {
  const from = pickSymbol(db, fromText);
  if (!from.symbol) return from.message!;
  const to = pickSymbol(db, toText);
  if (!to.symbol) return to.message!;
  const path = findPath(db, from.symbol.id, to.symbol.id, maxDepth);
  if (!path) return `no path between ${from.symbol.qualifiedName} and ${to.symbol.qualifiedName} within ${maxDepth} steps`;
  const writer = new Writer(budget);
  if (!path.directed) {
    writer.line(`no path along calls, instantiations or reads within ${maxDepth} steps; closest chain of relations (any direction):`);
  }
  for (const step of path.steps) {
    if (step.edge) {
      writer.line(
        `  ${step.edge.reversed ? '↑' : '↓'} ${step.edge.kind}${step.edge.reversed ? ' (reversed)' : ''}${step.edge.confidence === 'EXTRACTED' ? '' : ` ${step.edge.confidence.toLowerCase()}`}`,
      );
    }
    writer.line(`${step.node.qualifiedName}  ${location(step.node)}`);
  }
  return writer.toString();
}

export function formatImpact(db: Db, input: { files?: string[]; symbols?: string[] }, depth = 3, budget = DEFAULT_BUDGET): string {
  const ids: number[] = [];
  const problems: string[] = [];
  for (const text of input.symbols ?? []) {
    const { symbol, message } = pickSymbol(db, text);
    if (symbol) ids.push(symbol.id);
    else problems.push(message!);
  }
  const result = impact(db, { ...(input.files ? { files: input.files } : {}), symbols: ids }, depth);
  const writer = new Writer(budget);
  for (const problem of problems) writer.line(problem);
  writer.line(
    `changed: ${result.seeds.length} declarations; affected: ${result.affected.length} declarations in ${result.files.length} files; tests: ${result.tests.length}`,
  );
  if (result.tests.length > 0) {
    // Grouped by test type (or file for free functions), largest groups first.
    const groups = new Map<string, number>();
    for (const test of result.tests) {
      const owner = test.qualifiedName.includes('.')
        ? test.qualifiedName.slice(0, test.qualifiedName.lastIndexOf('.'))
        : (test.file ?? test.qualifiedName);
      groups.set(owner, (groups.get(owner) ?? 0) + 1);
    }
    const ordered = [...groups.entries()].sort((a, b) => b[1] - a[1]);
    writer.line(
      `tests: ${ordered
        .slice(0, 12)
        .map(([owner, count]) => `${owner} (${count})`)
        .join(', ')}${ordered.length > 12 ? `, … ${ordered.length - 12} more` : ''}`,
    );
  }
  for (const row of result.affected) writer.line(`  ${row.depth}. ${row.qualifiedName}  ${location(row)}`);
  return writer.toString();
}

export function formatCommunity(db: Db, idOrSymbol: string, budget = DEFAULT_BUDGET): string {
  let id = /^\d+$/.test(idOrSymbol) ? Number(idOrSymbol) : undefined;
  if (id === undefined) {
    const { symbol, message } = pickSymbol(db, idOrSymbol);
    if (!symbol) return message!;
    if (symbol.community === null) return `${symbol.qualifiedName} belongs to no area`;
    id = symbol.community;
  }
  const info = community(db, id);
  if (!info) return `no area #${id}`;
  const writer = new Writer(budget);
  writer.line(`area #${info.id} ${info.label}  (${info.size} declarations)`);
  writer.line('key members:');
  for (const member of info.members) writer.line(`  ${member.qualifiedName}  [${member.kind}, ${location(member)}]`);
  if (info.links.length > 0)
    writer.line(`linked areas: ${info.links.map((link) => `#${link.community} ${link.label} (${link.edges})`).join('; ')}`);
  return writer.toString();
}

export function formatSource(db: Db, root: string, text: string, contextLines = 0, budget = 4000): string {
  const { symbol, message } = pickSymbol(db, text);
  if (!symbol) return message!;
  const source = readSource(db, root, symbol.id, contextLines);
  const writer = new Writer(budget);
  writer.line(`// ${source.file}:${source.startLine}`);
  source.text.split('\n').forEach((line) => writer.line(line));
  return writer.toString();
}

export function formatStringSearch(db: Db, query: string, language: string | undefined, limit: number, budget = DEFAULT_BUDGET): string {
  const writer = new Writer(budget);
  const hits = searchStrings(db, query, { ...(language ? { language } : {}), limit });
  if (hits.length === 0) return `no strings match "${query}"`;
  for (const hit of hits)
    writer.line(`${hit.key}  [${hit.module}/${hit.table}]${hit.language ? `  ${hit.language}: ${JSON.stringify(hit.value)}` : ''}`);
  return writer.toString();
}

export function formatString(db: Db, key: string, table: string | undefined, budget = DEFAULT_BUDGET): string {
  const details = stringDetails(db, key, table);
  if (details.length === 0) return `no string "${key}"`;
  const writer = new Writer(budget);
  for (const detail of details) {
    writer.line(`${detail.key}  [${detail.module}/${detail.table}]${detail.comment ? `  "${detail.comment}"` : ''}`);
    for (const translation of detail.translations) {
      writer.line(
        `  ${translation.language}${translation.variation ? ` (${translation.variation})` : ''}  ${JSON.stringify(translation.value)}  ${translation.state ?? ''}`.trimEnd(),
      );
    }
    for (const language of detail.languagesMissing) writer.line(`  ${language}  — missing`);
    for (const usage of detail.usages) writer.line(`  used by ${usage.symbol} (${usage.file}:${usage.line}, ${usage.confidence})`);
  }
  return writer.toString();
}

export function formatStringsOfSymbol(db: Db, text: string, depth: number, budget = DEFAULT_BUDGET): string {
  const writer = new Writer(budget);
  const rows = stringsOfSymbol(db, text, depth);
  if (rows.length === 0) return `no localized strings used by "${text}" (depth ${depth})`;
  for (const row of rows) writer.line(`${row.symbol}  ${row.table}/${row.key}  ${JSON.stringify(row.value)}`);
  return writer.toString();
}

export function formatIssues(db: Db, filter: { kind?: string; language?: string; limit?: number }, budget = DEFAULT_BUDGET): string {
  const writer = new Writer(budget);
  const rows = localizationIssues(db, filter);
  if (rows.length === 0) return 'no localization issues';
  for (const issue of rows) {
    const subject = issue.key !== null ? `${issue.table}/${issue.key}` : (issue.symbol ?? '');
    const where = issue.file ? `  ${issue.file}${issue.line ? `:${issue.line}` : ''}` : '';
    writer.line(
      `${issue.kind}  ${subject}${issue.language ? `  ${issue.language}` : ''}${issue.detail ? `  ${issue.detail}` : ''}${where}`,
    );
  }
  return writer.toString();
}
