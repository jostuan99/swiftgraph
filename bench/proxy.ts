// Token benchmark without an LLM (docs/02-plan.md, G6).
//
// For each question it measures the text an agent reads:
// - with the graph: the output of the MCP tool calls (same formatters);
// - without it: grep output for the symbol, then the full text of the files
//   with the most matches (the usual "grep, then open the files" pattern).
// Tokens are estimated as characters / 4. The graph output must contain the
// expected strings of the question.
//
// Usage: node bench/proxy.ts <graph directory with <repo>.db files> <repos root>
//          [--min-correct N] [--min-ratio X]
// With thresholds, exits with status 1 when fewer than N answers are found or
// the total token ratio is below X. Repositories and tags: bench/repos.txt.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from '../src/mcp.ts';
import { discover } from '../src/discover/discover.ts';
import { openDatabase } from '../src/store/db.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { QUESTIONS } from './questions.ts';

const [graphDirectory, reposRoot, ...flags] = process.argv.slice(2);
if (!graphDirectory || !reposRoot) {
  console.error('usage: node bench/proxy.ts <graph directory> <repos root> [--min-correct N] [--min-ratio X]');
  process.exit(2);
}
const flag = (name: string) => {
  const index = flags.indexOf(name);
  return index >= 0 ? Number(flags[index + 1]) : undefined;
};
const minCorrect = flag('--min-correct');
const minRatio = flag('--min-ratio');

const tokens = (text: string) => Math.ceil(text.length / 4);

function baseline(root: string, greps: string[], readFiles: number): { tokens: number; calls: number } {
  const files = discover(root).files.filter((file) => file.kind === 'swift');
  const hits = new Map<string, number>();
  let output = '';
  for (const pattern of greps) {
    const expression = new RegExp(pattern);
    for (const file of files) {
      const lines = readFileSync(file.absolutePath, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!expression.test(line)) return;
        output += `${file.path}:${index + 1}:${line}\n`;
        hits.set(file.absolutePath, (hits.get(file.absolutePath) ?? 0) + 1);
      });
    }
  }
  const read = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, readFiles);
  for (const [path] of read) output += readFileSync(path, 'utf8');
  return { tokens: tokens(output), calls: greps.length + read.length };
}

const rows: string[][] = [];
let graphTotal = 0;
let baselineTotal = 0;
let correct = 0;
for (const question of QUESTIONS) {
  const root = join(reposRoot, question.repo);
  const db = openDatabase(join(graphDirectory, `${question.repo}.db`), { readonly: true });
  const server = createServer(db, root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'bench', version: '1.0.0' });
  await client.connect(clientTransport);
  let output = '';
  for (const call of question.graph) {
    const result = await client.callTool({ name: call.tool, arguments: call.args });
    output += (result.content as { text: string }[]).map((part) => part.text).join('\n');
  }
  await client.close();
  await server.close();
  db.close();

  const missing = question.expect.filter((text) => !output.includes(text));
  const rejected = (question.reject ?? []).filter((text) => output.includes(text));
  const ok = missing.length === 0 && rejected.length === 0;
  if (ok) correct++;
  const manual = baseline(root, question.baseline.greps, question.baseline.readFiles);
  graphTotal += tokens(output);
  baselineTotal += manual.tokens;
  rows.push([
    question.id,
    String(tokens(output)),
    String(question.graph.length),
    String(manual.tokens),
    String(manual.calls),
    `${(manual.tokens / Math.max(1, tokens(output))).toFixed(1)}×`,
    ok ? 'yes' : `NO (${[...missing.map((text) => `missing ${text}`), ...rejected.map((text) => `"${text}"`)].join('; ')})`,
  ]);
  if (process.env.BENCH_VERBOSE) console.error(`--- ${question.id}\n${output}\n`);
}

console.log('| Question | Graph tokens | Graph calls | Grep+read tokens | Grep+read calls | Ratio | Expected found |');
console.log('|---|---|---|---|---|---|---|');
for (const row of rows) console.log(`| ${row.join(' | ')} |`);
const ratio = baselineTotal / graphTotal;
console.log(
  `\nTotal: graph ${graphTotal} tokens, grep+read ${baselineTotal} tokens, ratio ${ratio.toFixed(1)}×; expected answers found in ${correct}/${QUESTIONS.length}.`,
);
const failures = [
  ...(minCorrect !== undefined && correct < minCorrect ? [`answers found ${correct} < ${minCorrect}`] : []),
  ...(minRatio !== undefined && ratio < minRatio ? [`token ratio ${ratio.toFixed(1)} < ${minRatio}`] : []),
];
if (failures.length > 0) {
  console.error(`FAIL: ${failures.join('; ')}`);
  process.exitCode = 1;
}
