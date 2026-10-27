import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mini-app');
export const GOLDEN_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'golden');

/** Copies the fixture into a fresh temporary directory. */
export function fixtureCopy(): { root: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'swiftgraph-test-'));
  const root = join(base, 'mini-app');
  cpSync(FIXTURE_ROOT, root, { recursive: true });
  return { root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export function temporaryDirectory(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'swiftgraph-test-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
