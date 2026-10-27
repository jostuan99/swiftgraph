// Encryption keys for the graph database.
//
// Sources, in order: the SWIFTGRAPH_KEY environment variable, then (macOS) a
// Keychain item with service "swiftgraph" and the repository root as account.
// A key never appears in a command line: Keychain writes go through the
// standard input of `security -i`.

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const KEY_ENVIRONMENT_VARIABLE = 'SWIFTGRAPH_KEY';
const KEYCHAIN_SERVICE = 'swiftgraph';

export function generateKey(): string {
  return randomBytes(32).toString('hex');
}

/** The key for a repository, or null when none is configured. */
export function findKey(root: string): string | null {
  const fromEnvironment = process.env[KEY_ENVIRONMENT_VARIABLE];
  if (fromEnvironment) return fromEnvironment;
  if (process.platform !== 'darwin') return null;
  const result = spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', root, '-w'], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

/** Stores a key in the macOS Keychain, replacing an existing one. */
export function storeKeychainKey(root: string, key: string): void {
  if (process.platform !== 'darwin') {
    throw new Error(`the Keychain is only available on macOS; set ${KEY_ENVIRONMENT_VARIABLE} instead`);
  }
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Keychain keys must be 64 hexadecimal digits');
  const quote = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  execFileSync('security', ['-i'], {
    input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${quote(root)} -w ${key}\n`,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
}
