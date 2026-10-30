import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { install, looksLikeSymbol, postToolUseHint, uninstall } from '../src/install.ts';
import { temporaryDirectory } from './helpers.ts';

const command = ['node', '/opt/swiftgraph/src/cli.ts'];

test('install keeps existing content, is idempotent, and uninstall restores it', () => {
  const { path: root, cleanup } = temporaryDirectory();
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(root, 'CLAUDE.md'), '# Project\n\nOwn rules.\n');
    mkdirSync(join(root, '.claude'));
    const settings = {
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'lint' }] }] },
    };
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'other' } } }));
    writeFileSync(join(root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\necho existing\n', { mode: 0o755 });
    const before = {
      claude: readFileSync(join(root, 'CLAUDE.md'), 'utf8'),
      hook: readFileSync(join(root, '.git', 'hooks', 'post-commit'), 'utf8'),
    };

    install({ root, command, targets: ['claude', 'agents', 'cursor', 'git'] });
    const second = install({ root, command, targets: ['claude', 'agents', 'cursor', 'git'] });
    assert.ok(
      second.every((change) => change.action === 'unchanged'),
      JSON.stringify(second),
    );

    const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    assert.ok(claude.startsWith('# Project\n\nOwn rules.\n'));
    assert.equal(claude.split('swiftgraph:begin').length, 2);
    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ['other', 'swiftgraph']);
    assert.deepEqual(mcp.mcpServers.swiftgraph, { command: 'node', args: ['/opt/swiftgraph/src/cli.ts', 'mcp', '.'] });
    const merged = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(merged.permissions, settings.permissions);
    assert.equal(merged.hooks.PostToolUse.length, 2);
    assert.ok(existsSync(join(root, '.claude', 'skills', 'swiftgraph', 'SKILL.md')));
    assert.ok(existsSync(join(root, '.cursor', 'rules', 'swiftgraph.mdc')));
    assert.ok(readFileSync(join(root, 'AGENTS.md'), 'utf8').includes('graph_overview'));
    const hook = readFileSync(join(root, '.git', 'hooks', 'post-commit'), 'utf8');
    assert.ok(hook.startsWith('#!/bin/sh\necho existing\n') && hook.includes('cli.ts sync'));
    assert.equal(statSync(join(root, '.git', 'hooks', 'post-checkout')).mode & 0o111, 0o111);

    uninstall(root);
    assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), before.claude);
    assert.equal(readFileSync(join(root, '.git', 'hooks', 'post-commit'), 'utf8'), before.hook);
    assert.equal(existsSync(join(root, '.git', 'hooks', 'post-checkout')), false);
    assert.equal(existsSync(join(root, 'AGENTS.md')), false);
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')), settings);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers), ['other']);
    assert.equal(existsSync(join(root, '.claude', 'skills', 'swiftgraph', 'SKILL.md')), false);
  } finally {
    cleanup();
  }
});

test('the post-tool-use hook only speaks up for Swift symbols in repositories with a graph', () => {
  for (const pattern of ['Store', 'func send', 'Store.send(_:)', 'send(_:)', 'class AppView', 'EventLoopPromise']) {
    assert.ok(looksLikeSymbol(pattern), pattern);
  }
  for (const pattern of ['TODO', 'error:', 'http://', 'foo bar baz', '*.swift', 'let']) {
    assert.ok(!looksLikeSymbol(pattern), pattern);
  }
  const input = { hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_input: { pattern: 'Store.send' } };
  const output = JSON.parse(postToolUseHint(input, true)!);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(output.hookSpecificOutput.additionalContext, /get_callers/);
  assert.equal(postToolUseHint(input, false), null);
  assert.equal(postToolUseHint({ tool_input: { pattern: 'TODO' } }, true), null);
});
