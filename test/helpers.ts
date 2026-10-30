import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mini-app');
export const GOLDEN_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'golden');

/** Copies a fixture without a graph database built inside it (`.swiftgraph/`). */
export function copyFixture(from: string, to: string): void {
  cpSync(from, to, { recursive: true, filter: (source) => basename(source) !== '.swiftgraph' });
}

/** Copies the fixture into a fresh temporary directory. */
export function fixtureCopy(): { root: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'swiftgraph-test-'));
  const root = join(base, 'mini-app');
  copyFixture(FIXTURE_ROOT, root);
  return { root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export function temporaryDirectory(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'swiftgraph-test-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
