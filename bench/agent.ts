// Benchmark with a real agent (docs/02-plan.md, G6): every question is
// asked twice with Claude Code in headless mode, once with only Read/Grep/Glob
// and once with the swiftgraph MCP server as well, and the token usage, cost,
// turns and answers are compared.
//
// This spends tokens of the Claude account that runs it. Usage:
//   node bench/agent.ts <graph directory> <repos root> [--only <question id>] [--model <model>]

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUESTIONS } from './questions.ts';

const args = process.argv.slice(2);
const [graphDirectory, reposRoot] = args;
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
if (!graphDirectory || !reposRoot) {
  console.error('usage: node bench/agent.ts <graph directory> <repos root> [--only <id>] [--model <model>]');
  process.exit(2);
}
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'swiftgraph-bench-'));

interface Run {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
  answer: string;
}

function ask(question: string, cwd: string, mcpConfig: string, allowedTools: string): Run {
  const output = execFileSync(
    'claude',
    [
      '-p',
      `${question}\nAnswer concisely with symbol names and file paths.`,
      '--output-format',
      'json',
      '--mcp-config',
      mcpConfig,
      '--strict-mcp-config',
      '--allowedTools',
      allowedTools,
      ...(option('--model') ? ['--model', option('--model')!] : []),
    ],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 },
  );
  const result = JSON.parse(output) as {
    result?: string;
    num_turns?: number;
    total_cost_usd?: number;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  };
  const usage = result.usage ?? {};
  return {
    inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
    costUsd: result.total_cost_usd ?? 0,
    turns: result.num_turns ?? 0,
    answer: result.result ?? '',
  };
}

const rows: string[] = [];
try {
  for (const question of QUESTIONS.filter((item) => !option('--only') || item.id === option('--only'))) {
    const cwd = resolve(reposRoot, question.repo);
    const none = join(scratch, 'none.json');
    writeFileSync(none, JSON.stringify({ mcpServers: {} }));
    const withGraph = join(scratch, `${question.repo}.json`);
    writeFileSync(
      withGraph,
      JSON.stringify({
        mcpServers: {
          swiftgraph: { command: process.execPath, args: [cli, 'mcp', cwd, '--db', resolve(graphDirectory, `${question.repo}.db`)] },
        },
      }),
    );
    const baseline = ask(question.question, cwd, none, 'Read,Grep,Glob');
    const graph = ask(question.question, cwd, withGraph, 'Read,Grep,Glob,mcp__swiftgraph');
    const correct = (run: Run) => (question.expect.every((text) => run.answer.includes(text.split('.').at(-1)!)) ? 'yes' : 'no');
    rows.push(
      `| ${question.id} | ${baseline.inputTokens + baseline.outputTokens} | ${baseline.turns} | $${baseline.costUsd.toFixed(3)} | ${correct(baseline)} ` +
        `| ${graph.inputTokens + graph.outputTokens} | ${graph.turns} | $${graph.costUsd.toFixed(3)} | ${correct(graph)} |`,
    );
    console.error(`done: ${question.id}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log('| Question | Tokens (no graph) | Turns | Cost | Correct | Tokens (graph) | Turns | Cost | Correct |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const row of rows) console.log(row);
