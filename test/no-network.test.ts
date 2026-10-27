import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Security requirement: swiftgraph never talks to the network
// (docs/01-design.md, section 7.3). This static check fails when source
// code starts using networking modules or fetch.
const SOURCE_DIRECTORY = fileURLToPath(new URL('../src', import.meta.url));
const FORBIDDEN = [
  /from ['"](node:)?(http|https|http2|net|tls|dgram|dns)['"]/,
  /require\(['"](node:)?(http|https|http2|net|tls|dgram|dns)['"]\)/,
  /\bfetch\s*\(/,
  /\bWebSocket\b/,
];

test('source code does not use the network', () => {
  const offenders: string[] = [];
  for (const entry of readdirSync(SOURCE_DIRECTORY, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const path = join(entry.parentPath, entry.name);
    const text = readFileSync(path, 'utf8');
    for (const pattern of FORBIDDEN) {
      if (pattern.test(text)) offenders.push(`${path}: ${pattern}`);
    }
  }
  assert.deepEqual(offenders, []);
});
