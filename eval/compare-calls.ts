// Compares the CALLS/INSTANTIATES and READS/WRITES edges of a graph database
// with the calls recorded by the compiler's index store (G2 evaluation).
//
// Usage:
//   node eval/compare-calls.ts <graph.db> <calls.tsv> [--show N] [--min-precision P]
//
// With --min-precision, exits with status 1 when the CALLS + INSTANTIATES
// precision (EXTRACTED + INFERRED) is below P percent (SG4: 95).
//
// <calls.tsv> is the output of eval/indexstore-calls (see eval/README.md).
// Index locations are mapped to graph nodes by file and line: the innermost
// declaration whose range contains the line.

import Database from 'better-sqlite3-multiple-ciphers';
import { readFileSync } from 'node:fs';

const [databasePath, callsPath, ...rest] = process.argv.slice(2);
if (!databasePath || !callsPath) {
  console.error('usage: node eval/compare-calls.ts <graph.db> <calls.tsv> [--show N]');
  process.exit(2);
}
const showIndex = rest.indexOf('--show');
const show = showIndex >= 0 ? Number(rest[showIndex + 1]) : 15;
const minPrecisionIndex = rest.indexOf('--min-precision');
const minPrecision = minPrecisionIndex >= 0 ? Number(rest[minPrecisionIndex + 1]) : undefined;

interface NodeRow {
  id: number;
  symbol_id: string;
  kind: string;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
}

const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const nodes = db
  .prepare(
    `SELECT n.id, n.symbol_id, n.kind, f.path, n.start_line, n.end_line
     FROM nodes n LEFT JOIN files f ON f.id = n.file_id`,
  )
  .all() as NodeRow[];
const byId = new Map(nodes.map((node) => [node.id, node]));
const byFile = new Map<string, NodeRow[]>();
for (const node of nodes) {
  if (!node.path || node.start_line === null || node.end_line === null) continue;
  if (node.kind === 'file' || node.kind === 'module' || node.kind === 'extension') continue;
  byFile.set(node.path, [...(byFile.get(node.path) ?? []), node]);
}

const bySymbol = new Map(nodes.map((node) => [node.symbol_id, node]));

/**
 * Innermost declaration containing the line. Declarations from several `#if`
 * branches share one node that keeps the first range, so a line outside every
 * range falls back to a node of the file with the same name.
 */
function nodeAt(path: string, line: number, name?: string): NodeRow | undefined {
  let best: NodeRow | undefined;
  for (const node of byFile.get(path) ?? []) {
    if (node.start_line! > line || node.end_line! < line) continue;
    if (!best || node.end_line! - node.start_line! < best.end_line! - best.start_line!) best = node;
  }
  if (best || !name) return best;
  const named = (byFile.get(path) ?? []).filter((node) => node.symbol_id.endsWith(`/${name}`) || node.symbol_id.endsWith(`.${name}`));
  return named.length === 1 ? named[0] : undefined;
}

/** `swift:M/Item.init(title:)` → node of `swift:M/Item`. */
function initializedType(node: NodeRow): NodeRow | undefined {
  const index = node.symbol_id.lastIndexOf('.init(');
  return index > 0 ? bySymbol.get(node.symbol_id.slice(0, index)) : undefined;
}

const TYPE_KINDS = new Set(['class', 'struct', 'enum', 'actor', 'protocol']);

// --- Index store ---------------------------------------------------------------------

const reference = { calls: new Set<string>(), accesses: new Set<string>() };
let unmapped = 0;
for (const line of readFileSync(callsPath, 'utf8').split('\n')) {
  if (line.trim() === '') continue;
  const [callerFile, callerLine, calleeFile, calleeLine, calleeName] = line.split('\t');
  if (!callerFile || !calleeFile || !calleeName) continue;
  if (callerFile.startsWith('.build/') || calleeFile.startsWith('.build/')) continue;
  const caller = nodeAt(callerFile, Number(callerLine));
  const callee = nodeAt(calleeFile, Number(calleeLine), calleeName);
  if (!caller || !callee) {
    unmapped++;
    continue;
  }
  if (calleeName.startsWith('getter:') || calleeName.startsWith('setter:')) {
    if (callee.kind !== 'property' || caller.id === callee.id) continue;
    const kind = calleeName.startsWith('getter:') ? 'READS' : 'WRITES';
    reference.accesses.add(`${caller.id}|${kind}|${callee.id}`);
    continue;
  }
  // Self-calls of test macros are expansion artefacts.
  if (caller.id === callee.id) continue;
  if (TYPE_KINDS.has(callee.kind) && calleeName.startsWith('init')) {
    // A synthesized initializer is defined on the type line.
    reference.calls.add(`${caller.id}|INSTANTIATES|${callee.id}`);
    continue;
  }
  reference.calls.add(`${caller.id}|CALLS|${callee.id}`);
  // Calling an initializer instantiates its type.
  const type = callee.kind === 'initializer' ? initializedType(callee) : undefined;
  if (type) reference.calls.add(`${caller.id}|INSTANTIATES|${type.id}`);
}

// --- Graph ------------------------------------------------------------------------------

interface EdgeRow {
  source_id: number;
  target_id: number;
  kind: string;
  confidence: string;
}
const edges = db
  .prepare(`SELECT source_id, target_id, kind, confidence FROM edges WHERE kind IN ('CALLS', 'INSTANTIATES', 'READS', 'WRITES')`)
  .all() as EdgeRow[];

/** Prints the comparison; returns the precision in percent. */
function evaluate(label: string, kinds: string[], expected: Set<string>): number {
  const relevant = edges.filter((edge) => {
    if (!kinds.includes(edge.kind)) return false;
    const target = byId.get(edge.target_id);
    return target !== undefined && target.kind !== 'external_symbol' && target.path !== null;
  });
  const confident = relevant.filter((edge) => edge.confidence !== 'AMBIGUOUS');
  const key = (edge: EdgeRow) => `${edge.source_id}|${edge.kind}|${edge.target_id}`;
  const confidentKeys = new Set(confident.map(key));
  const allKeys = new Set(relevant.map(key));

  const truePositives = [...confidentKeys].filter((item) => expected.has(item));
  const falsePositives = [...confidentKeys].filter((item) => !expected.has(item));
  const missed = [...expected].filter((item) => !allKeys.has(item));
  const precision = confidentKeys.size === 0 ? 100 : (100 * truePositives.length) / confidentKeys.size;
  const recall = expected.size === 0 ? 100 : (100 * (expected.size - missed.length)) / expected.size;
  const byConfidence = (confidence: string) => {
    const keys = new Set(relevant.filter((edge) => edge.confidence === confidence).map(key));
    const correct = [...keys].filter((item) => expected.has(item)).length;
    return keys.size === 0 ? '-' : `${correct}/${keys.size} (${((100 * correct) / keys.size).toFixed(1)}%)`;
  };

  console.log(`\n${label}`);
  console.log(`  index: ${expected.size}; graph (EXTRACTED+INFERRED): ${confidentKeys.size}`);
  console.log(`  precision (EXTRACTED+INFERRED): ${precision.toFixed(2)}%`);
  console.log(`  recall (any confidence): ${recall.toFixed(2)}%`);
  console.log(
    `  correct by confidence: EXTRACTED ${byConfidence('EXTRACTED')}; INFERRED ${byConfidence('INFERRED')}; AMBIGUOUS ${byConfidence('AMBIGUOUS')}`,
  );
  const describe = (item: string) => {
    const [source, kind, target] = item.split('|');
    return `    ${byId.get(Number(source))?.symbol_id} ${kind} ${byId.get(Number(target))?.symbol_id}`;
  };
  if (falsePositives.length > 0) {
    console.log(`  only in graph (${falsePositives.length}):`);
    falsePositives.slice(0, show).forEach((item) => console.log(describe(item)));
  }
  if (missed.length > 0) {
    console.log(`  missed (${missed.length}):`);
    missed.slice(0, show).forEach((item) => console.log(describe(item)));
  }
  return precision;
}

console.log(`index call sites not mapped to graph nodes: ${unmapped}`);
const callPrecision = evaluate('CALLS + INSTANTIATES', ['CALLS', 'INSTANTIATES'], reference.calls);
evaluate('READS + WRITES', ['READS', 'WRITES'], reference.accesses);
if (minPrecision !== undefined && callPrecision < minPrecision) {
  console.error(`FAIL: CALLS + INSTANTIATES precision ${callPrecision.toFixed(2)}% < ${minPrecision}%`);
  process.exitCode = 1;
}
