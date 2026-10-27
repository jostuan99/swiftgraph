// Connects a repository to coding agents. See docs/01-design.md, section 8.3.
//
// Everything written is marked so `uninstall` can remove exactly that:
// - Markdown files get a block between swiftgraph markers;
// - JSON files get a `swiftgraph` entry that is merged, never overwritten;
// - git hooks get a marked block appended to existing scripts.
// `.gitignore` is never edited: the command prints the line to add instead.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type InstallTarget = 'claude' | 'agents' | 'cursor' | 'git';

export interface InstallOptions {
  root: string;
  /** How agents and hooks start swiftgraph, e.g. `node /abs/path/cli.ts` or `swiftgraph`. */
  command: string[];
  targets: InstallTarget[];
}

export interface InstallChange {
  path: string;
  action: 'created' | 'updated' | 'unchanged' | 'removed';
}

const BEGIN = '<!-- swiftgraph:begin -->';
const END = '<!-- swiftgraph:end -->';
const SHELL_BEGIN = '# swiftgraph:begin';
const SHELL_END = '# swiftgraph:end';
const GIT_HOOKS = ['post-commit', 'post-checkout', 'post-merge'];

export const AGENT_INSTRUCTIONS = `## Swift code graph (swiftgraph)

This repository has a code graph of its Swift code and localization files, served by the \`swiftgraph\` MCP server.

- Start with \`graph_overview\` to learn the modules, main areas, central symbols and entry points.
- For structural questions use the graph before grep or reading files:
  - where is X / what is X: \`search_symbols\`, \`get_symbol\`
  - who calls X / what does X call: \`get_callers\`, \`get_callees\`
  - how does A reach B: \`find_path\`
  - what does a change affect, which tests to run: \`get_impact\`
  - localized strings, translations, missing keys: \`search_strings\`, \`get_string\`, \`get_strings_for_symbol\`, \`get_localization_issues\`
  - what a screen shows and where each value comes from (API, UserDefaults/Keychain/file, localization): \`get_screen_definition\`
  - what runs when a screen appears or a button is tapped, layer by layer: \`get_screen_flows\`
- Read code with \`get_source\` (one declaration) instead of whole files when possible.
- Relations marked \`inferred\` come from name resolution without a type checker; \`ambiguous\` ones are hidden unless requested. Confirm critical conclusions in the source.
- Use grep for string literals, comments and non-Swift files.
`;

function quote(argument: string): string {
  return /^[\w./:@=-]+$/.test(argument) ? argument : `'${argument.replaceAll("'", `'\\''`)}'`;
}

function writeIfChanged(path: string, content: string, changes: InstallChange[], mode?: number): void {
  const existed = existsSync(path);
  if (existed && readFileSync(path, 'utf8') === content) {
    changes.push({ path, action: 'unchanged' });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, mode === undefined ? undefined : { mode });
  if (mode !== undefined) chmodSync(path, mode);
  changes.push({ path, action: existed ? 'updated' : 'created' });
}

/** Replaces (or appends) the marked block of a text file. */
function upsertBlock(path: string, block: string, begin: string, end: string, changes: InstallChange[], mode?: number): void {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const marked = `${begin}\n${block.trimEnd()}\n${end}\n`;
  const start = current.indexOf(begin);
  const stop = current.indexOf(end);
  let next: string;
  if (start >= 0 && stop > start) {
    next = current.slice(0, start) + marked + current.slice(stop + end.length).replace(/^\n/, '');
  } else {
    next = current === '' ? marked : `${current.replace(/\n*$/, '\n\n')}${marked}`;
  }
  writeIfChanged(path, next, changes, mode);
}

function removeBlock(path: string, begin: string, end: string, changes: InstallChange[]): void {
  if (!existsSync(path)) return;
  const current = readFileSync(path, 'utf8');
  const start = current.indexOf(begin);
  const stop = current.indexOf(end);
  if (start < 0 || stop < start) return;
  // `upsertBlock` separated the block with a blank line; drop it again.
  const next = (current.slice(0, start) + current.slice(stop + end.length).replace(/^\n/, '')).replace(/\n+$/, '\n');
  if (next.trim() === '' || next.trim() === '#!/bin/sh') {
    rmSync(path);
    changes.push({ path, action: 'removed' });
  } else {
    writeFileSync(path, next);
    changes.push({ path, action: 'updated' });
  }
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

function writeJson(path: string, value: Record<string, unknown>, changes: InstallChange[]): void {
  writeIfChanged(path, `${JSON.stringify(value, null, 2)}\n`, changes);
}

interface HookEntry {
  matcher?: string;
  hooks?: { type: string; command: string }[];
}

const isOurHook = (entry: HookEntry) =>
  entry.hooks?.some((hook) => hook.command.includes('swiftgraph') && hook.command.includes('hook')) === true;

export function install(options: InstallOptions): InstallChange[] {
  const { root, command, targets } = options;
  const changes: InstallChange[] = [];
  const commandLine = command.map(quote).join(' ');

  if (targets.includes('claude')) {
    upsertBlock(join(root, 'CLAUDE.md'), AGENT_INSTRUCTIONS, BEGIN, END, changes);

    // Project MCP server for Claude Code.
    const mcpPath = join(root, '.mcp.json');
    const mcp = readJson(mcpPath);
    const servers = (mcp['mcpServers'] as Record<string, unknown> | undefined) ?? {};
    servers['swiftgraph'] = { command: command[0], args: [...command.slice(1), 'mcp', '.'] };
    writeJson(mcpPath, { ...mcp, mcpServers: servers }, changes);

    // Skill to build and query the graph from the CLI.
    writeIfChanged(
      join(root, '.claude', 'skills', 'swiftgraph', 'SKILL.md'),
      `---
name: swiftgraph
description: Build or update the Swift code graph of this repository and answer questions about Swift code structure (callers, callees, impact of a change, conformances, localized strings) from it.
---

# swiftgraph

Update the graph after code changes (fast when only a few files changed):

\`\`\`sh
${commandLine} build .
\`\`\`

Prefer the \`swiftgraph\` MCP tools. Without them, use the CLI:

\`\`\`sh
${commandLine} report .                         # overview
${commandLine} find <text> --root .
${commandLine} explain '<Type.member(label:)>' --root .
${commandLine} callers '<symbol>' --depth 2 --root .
${commandLine} impact <file.swift> --root .
${commandLine} strings show <key> --root .
\`\`\`

${AGENT_INSTRUCTIONS}`,
      changes,
    );

    // Hint after Grep/Glob calls that look for Swift symbols.
    const settingsPath = join(root, '.claude', 'settings.json');
    const settings = readJson(settingsPath);
    const hooks = (settings['hooks'] as Record<string, HookEntry[]> | undefined) ?? {};
    const postToolUse = (hooks['PostToolUse'] ?? []).filter((entry) => !isOurHook(entry));
    postToolUse.push({ matcher: 'Grep|Glob', hooks: [{ type: 'command', command: `${commandLine} hook post-tool-use` }] });
    hooks['PostToolUse'] = postToolUse;
    writeJson(settingsPath, { ...settings, hooks }, changes);
  }

  if (targets.includes('agents')) upsertBlock(join(root, 'AGENTS.md'), AGENT_INSTRUCTIONS, BEGIN, END, changes);

  if (targets.includes('cursor')) {
    writeIfChanged(
      join(root, '.cursor', 'rules', 'swiftgraph.mdc'),
      `---
description: Use the swiftgraph code graph for questions about Swift code structure
alwaysApply: true
---

${AGENT_INSTRUCTIONS}`,
      changes,
    );
  }

  if (targets.includes('git')) {
    const hooksDirectory = join(root, '.git', 'hooks');
    if (!existsSync(join(root, '.git'))) throw new Error(`${root} is not a git repository (no .git directory)`);
    for (const hook of GIT_HOOKS) {
      const path = join(hooksDirectory, hook);
      const block = `# Update the swiftgraph database in the background.\n(${commandLine} build "$(git rev-parse --show-toplevel)" >/dev/null 2>&1 &)`;
      if (!existsSync(path)) writeFileSync(path, '#!/bin/sh\n', { mode: 0o755 });
      upsertBlock(path, block, SHELL_BEGIN, SHELL_END, changes, 0o755);
    }
  }
  return changes;
}

export function uninstall(root: string): InstallChange[] {
  const changes: InstallChange[] = [];
  for (const file of ['CLAUDE.md', 'AGENTS.md']) removeBlock(join(root, file), BEGIN, END, changes);
  for (const hook of GIT_HOOKS) removeBlock(join(root, '.git', 'hooks', hook), SHELL_BEGIN, SHELL_END, changes);
  for (const path of [join(root, '.claude', 'skills', 'swiftgraph', 'SKILL.md'), join(root, '.cursor', 'rules', 'swiftgraph.mdc')]) {
    if (existsSync(path)) {
      rmSync(path);
      changes.push({ path, action: 'removed' });
    }
  }
  const mcpPath = join(root, '.mcp.json');
  if (existsSync(mcpPath)) {
    const mcp = readJson(mcpPath);
    const servers = mcp['mcpServers'] as Record<string, unknown> | undefined;
    if (servers && 'swiftgraph' in servers) {
      delete servers['swiftgraph'];
      if (Object.keys(servers).length === 0 && Object.keys(mcp).length === 1) {
        rmSync(mcpPath);
        changes.push({ path: mcpPath, action: 'removed' });
      } else {
        writeJson(mcpPath, mcp, changes);
      }
    }
  }
  const settingsPath = join(root, '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    const settings = readJson(settingsPath);
    const hooks = settings['hooks'] as Record<string, HookEntry[]> | undefined;
    if (hooks?.['PostToolUse']) {
      hooks['PostToolUse'] = hooks['PostToolUse'].filter((entry) => !isOurHook(entry));
      if (hooks['PostToolUse'].length === 0) delete hooks['PostToolUse'];
      if (Object.keys(hooks).length === 0) delete settings['hooks'];
      writeJson(settingsPath, settings, changes);
    }
  }
  return changes;
}

// --- Hook ---------------------------------------------------------------------------

/** A search pattern that names a Swift declaration rather than text. */
export function looksLikeSymbol(pattern: string): boolean {
  const cleaned = pattern.replace(/\\b|\^|\$/g, '').trim();
  if (/^(func|class|struct|enum|protocol|extension|actor|var|let|case)\s+\w+/.test(cleaned)) return true;
  // UpperCamelCase type names (not ALL-CAPS words such as TODO), with optional members.
  if (/^[A-Z](?=[A-Za-z0-9]*[a-z])[A-Za-z0-9]+(\.[A-Za-z_][A-Za-z0-9_]*)*(\(([A-Za-z_]*:)*\))?$/.test(cleaned)) return true;
  return /^[a-z][A-Za-z0-9]*\((?:[A-Za-z_]+:)*\)$/.test(cleaned);
}

/**
 * PostToolUse hook for Grep/Glob: when the search looks for a Swift symbol
 * and the repository has a graph, remind the agent of the graph tools.
 * Input and output follow the Claude Code hook JSON protocol.
 */
export function postToolUseHint(input: unknown, hasGraph: boolean): string | null {
  if (!hasGraph || typeof input !== 'object' || input === null) return null;
  const toolInput = (input as { tool_input?: Record<string, unknown> }).tool_input ?? {};
  const pattern = typeof toolInput['pattern'] === 'string' ? toolInput['pattern'] : '';
  if (!looksLikeSymbol(pattern)) return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        `"${pattern}" looks like a Swift symbol. The swiftgraph MCP tools answer structural questions with less reading: ` +
        'search_symbols / get_symbol (definition and relations), get_callers / get_callees, get_impact, find_path, get_source.',
    },
  });
}
