// Compact text output for agents and the CLI. Every formatter takes a token
// budget (about 4 characters per token) and cuts lists to fit it.

import type { Db } from '../store/db.ts';
import {
  community,
  findPath,
  impact,
  neighbors,
  outline,
  readSource,
  resolveFile,
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

const modulePrefixes = new WeakMap<Db, string | null>();

/** `App.` when the project has a single module with declarations, else null. */
export function modulePrefix(db: Db): string | null {
  if (!modulePrefixes.has(db)) {
    const names = db
      .prepare(
        `SELECT m.name FROM modules m WHERE m.kind = 'target' AND EXISTS (
           SELECT 1 FROM files f JOIN nodes n ON n.file_id = f.id
           WHERE f.module_id = m.id AND n.kind IN ('class', 'struct', 'enum', 'actor', 'protocol', 'extension', 'function'))`,
      )
      .pluck()
      .all() as string[];
    modulePrefixes.set(db, names.length === 1 ? `${names[0]}.` : null);
  }
  return modulePrefixes.get(db)!;
}

/**
 * Names and locations as printed, to repeat as little as possible: without the
 * module when the project has only one, and `:N` for a line in the file named
 * on the line before.
 */
class Printer {
  private lastFile: string | null = null;
  private readonly prefix: string | null;

  constructor(db: Db) {
    this.prefix = modulePrefix(db);
  }

  /** `subject` shortens its members to `.member`. */
  name(row: { qualifiedName: string }, subject?: { qualifiedName: string }): string {
    const name = row.qualifiedName;
    if (subject && name.startsWith(`${subject.qualifiedName}.`)) return name.slice(subject.qualifiedName.length);
    return this.prefix && name.startsWith(this.prefix) ? name.slice(this.prefix.length) : name;
  }

  at(row: { file: string | null; line: number | null }): string {
    if (!row.file) return '';
    const same = row.file === this.lastFile;
    this.lastFile = row.file;
    return same ? `:${row.line ?? 1}` : location(row);
  }

  heading(row: SymbolRow): string {
    const access = row.access ? `, ${row.access}` : '';
    return `${this.name(row)}  [${row.kind}${access}${row.file ? `, ${this.at(row)}` : ''}]`;
  }
}

function confidence(row: { confidence: string }): string {
  return row.confidence === 'EXTRACTED' ? '' : ` (${row.confidence.toLowerCase()})`;
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
  const printer = new Printer(db);
  for (const row of rows) writer.line(`${printer.name(row)}  [${row.kind}${row.file ? `, ${printer.at(row)}` : ''}]`);
  return writer.toString();
}

/** Neighbors by direction and edge kind; the file of the symbol is left out (the heading names it). */
function groupNeighbors(rows: Neighbor[]): Map<string, Neighbor[]> {
  const groups = new Map<string, Neighbor[]>();
  for (const row of rows) {
    if (row.kind === 'file') continue;
    const key = `${row.direction === 'out' ? '→' : '←'} ${row.edgeKind}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}

export function formatSymbol(db: Db, text: string, budget = DEFAULT_BUDGET): string {
  const { symbol, message } = pickSymbol(db, text);
  if (!symbol) return message!;
  const writer = new Writer(budget);
  const printer = new Printer(db);
  writer.line(printer.heading(symbol));
  if (symbol.signature) writer.line(`  ${symbol.signature}`);
  if (symbol.doc) writer.line(`  /// ${symbol.doc.replaceAll('\n', ' ').slice(0, 300)}`);
  if (symbol.conditions) writer.line(`  #if ${(JSON.parse(symbol.conditions) as string[]).join(' | ')}`);
  if (symbol.community !== null) {
    const label = db.prepare('SELECT label FROM communities WHERE id = ?').pluck().get(symbol.community) as string | undefined;
    writer.line(`  area: #${symbol.community} ${label ?? ''}`);
  }
  for (const [group, rows] of groupNeighbors(neighbors(db, symbol.id, { limit: 200 }))) {
    const shown = rows.slice(0, 6).map((row) => `${printer.name(row, symbol)}${confidence(row)}`);
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
  const printer = new Printer(db);
  writer.line(printer.heading(symbol));
  const rows = neighbors(db, symbol.id, { limit: options.limit ?? 50, ...options });
  if (rows.length === 0) writer.line('  no neighbors');
  for (const [group, members] of groupNeighbors(rows)) {
    writer.line(`  ${group}`);
    for (const row of members)
      writer.line(`    ${[printer.name(row, symbol), printer.at(row)].filter(Boolean).join('  ')}${confidence(row)}`);
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
  const printer = new Printer(db);
  writer.line(`${printer.heading(symbol)}\n  ${direction === 'in' ? 'callers' : 'callees'} (depth ≤ ${options.depth ?? 3}):`);
  const rows = traverse(db, symbol.id, direction, options);
  if (rows.length === 0) writer.line('  none');
  // Depth first, so each node sits under the node it was reached from.
  // SDK symbols are leaves: one line at the end.
  const external = [...new Set(rows.filter((row) => row.kind === 'external_symbol').map((row) => row.qualifiedName))];
  const children = new Map<number | null, typeof rows>();
  for (const row of rows) {
    if (row.kind !== 'external_symbol') children.set(row.parent, [...(children.get(row.parent) ?? []), row]);
  }
  const visit = (parent: number | null) => {
    for (const row of children.get(parent) ?? []) {
      const names = row.dispatch.map((other) => printer.name(other)).join(', ');
      const dispatch = names ? (direction === 'in' ? `  via ${names}` : `  → ${names}`) : '';
      writer.line(`  ${'  '.repeat(row.depth - 1)}${row.depth}. ${printer.name(row)}  ${printer.at(row)}${dispatch}`);
      visit(row.id);
    }
  };
  visit(null);
  if (external.length > 0) writer.line(`  SDK: ${external.join(', ')}`);
  return writer.toString();
}

export function formatPath(db: Db, fromText: string, toText: string, maxDepth = 6, budget = DEFAULT_BUDGET): string {
  const from = pickSymbol(db, fromText);
  if (!from.symbol) return from.message!;
  const to = pickSymbol(db, toText);
  if (!to.symbol) return to.message!;
  const path = findPath(db, from.symbol.id, to.symbol.id, maxDepth);
  const printer = new Printer(db);
  if (!path) return `no path between ${printer.name(from.symbol)} and ${printer.name(to.symbol)} within ${maxDepth} steps`;
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
    writer.line(`${printer.name(step.node)}  ${printer.at(step.node)}`.trimEnd());
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
  const printer = new Printer(db);
  for (const row of result.affected) writer.line(`  ${row.depth}. ${printer.name(row)}  ${printer.at(row)}`.trimEnd());
  return writer.toString();
}

export function formatCommunity(db: Db, idOrSymbol: string, budget = DEFAULT_BUDGET): string {
  let id = /^\d+$/.test(idOrSymbol) ? Number(idOrSymbol) : undefined;
  if (id === undefined) {
    const { symbol, message } = pickSymbol(db, idOrSymbol);
    if (!symbol) return message!;
    if (symbol.community === null) return `${new Printer(db).name(symbol)} belongs to no area`;
    id = symbol.community;
  }
  const info = community(db, id);
  if (!info) return `no area #${id}`;
  const writer = new Writer(budget);
  writer.line(`area #${info.id} ${info.label}  (${info.size} declarations)`);
  writer.line('key members:');
  const printer = new Printer(db);
  for (const member of info.members)
    writer.line(`  ${printer.name(member)}  [${member.kind}${member.file ? `, ${printer.at(member)}` : ''}]`);
  if (info.links.length > 0)
    writer.line(`linked areas: ${info.links.map((link) => `#${link.community} ${link.label} (${link.edges})`).join('; ')}`);
  return writer.toString();
}

/**
 * Signatures of the declarations of a file, or of a type and its extensions,
 * without bodies: what to read before get_source.
 */
export function formatOutline(db: Db, text: string, budget = DEFAULT_BUDGET): string {
  let entries;
  if (/\.swift$/.test(text) || text.includes('/')) {
    const files = resolveFile(db, text);
    if (files.length === 0) return `no Swift file matches "${text}"`;
    if (files.length > 1) return `"${text}" matches several files; use one of:\n${files.map((file) => `  ${file}`).join('\n')}`;
    entries = outline(db, { file: files[0]! });
  } else {
    const { symbol, message } = pickSymbol(db, text);
    if (!symbol) return message!;
    entries = outline(db, { symbol: symbol.id });
  }
  const writer = new Writer(budget);
  let file: string | null = null;
  for (const entry of entries) {
    if (entry.file !== file) {
      file = entry.file;
      writer.line(file ?? '(no file)');
    }
    const lines = entry.endLine && entry.line && entry.endLine > entry.line ? `${entry.line}-${entry.endLine}` : `${entry.line ?? ''}`;
    // Attributes first, as usually written: `@Published private(set) var`.
    const words = entry.modifiers ? (JSON.parse(entry.modifiers) as string[]) : [];
    const prefix = [...words.filter((word) => word.startsWith('@')), ...words.filter((word) => !word.startsWith('@'))]
      .map((word) => `${word} `)
      .join('');
    const doc = entry.doc ? `  /// ${entry.doc.split('\n')[0]!.slice(0, 80)}` : '';
    writer.line(`${'  '.repeat(entry.depth)}${lines} ${prefix}${entry.signature ?? `${entry.kind} ${entry.name}`}${doc}`);
  }
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
