// Opens the SQLite database that holds the whole graph.
//
// Security rules (docs/01-design.md, section 7.3):
// - the directory is created with mode 0700 and the database with mode 0600;
//   SQLite gives the WAL and shared-memory files the same mode as the database;
// - query connections are read-only and `query_only`;
// - every statement uses bound parameters (callers must not build SQL from input);
// - with a key, the file is encrypted with SQLCipher (SQLite3 Multiple Ciphers).

import Database from 'better-sqlite3-multiple-ciphers';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

export const DEFAULT_DB_DIRECTORY = '.swiftgraph';
export const DB_FILE_NAME = 'graph.db';

const MIGRATIONS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface OpenOptions {
  readonly?: boolean;
  /** Receives warnings, for example about file permissions that are too wide. */
  warn?: (message: string) => void;
  /**
   * Encryption key: 64 hexadecimal digits (a raw 256-bit key) or a passphrase.
   * Required for an encrypted database; creates an encrypted database when the
   * file does not exist yet.
   */
  key?: string | null;
}

export class DatabaseKeyError extends Error {}

const SQLITE_HEADER = 'SQLite format 3\0';

/** True when the file exists, is not empty and has no plain SQLite header. */
export function isEncrypted(path: string): boolean {
  if (!existsSync(path) || statSync(path).size === 0) return false;
  const descriptor = openSync(path, 'r');
  try {
    const header = Buffer.alloc(16);
    readSync(descriptor, header, 0, 16, 0);
    return header.toString('latin1') !== SQLITE_HEADER;
  } finally {
    closeSync(descriptor);
  }
}

/** PRAGMA value for a key; only hex digits or a quoted passphrase reach SQL. */
function keyLiteral(key: string): string {
  if (/^[0-9a-fA-F]{64}$/.test(key)) return `"x'${key}'"`;
  return `'${key.replaceAll("'", "''")}'`;
}

function applyKey(db: Db, path: string, key: string): void {
  db.pragma("cipher = 'sqlcipher'");
  db.pragma(`key = ${keyLiteral(key)}`);
  try {
    db.prepare('SELECT COUNT(*) FROM sqlite_master').get();
  } catch {
    db.close();
    throw new DatabaseKeyError(`cannot open ${path}: wrong encryption key`);
  }
}

/**
 * Changes the encryption of a database: encrypts a plain database, changes
 * the key, or (with `newKey` null) decrypts it.
 */
export function rekeyDatabase(path: string, oldKey: string | null, newKey: string | null): void {
  const db = openDatabase(path, { key: oldKey });
  try {
    // SQLite3 Multiple Ciphers cannot rekey in WAL mode.
    db.pragma('journal_mode = DELETE');
    if (newKey) {
      db.pragma("cipher = 'sqlcipher'");
      db.pragma(`rekey = ${keyLiteral(newKey)}`);
    } else {
      db.pragma("rekey = ''");
    }
    db.pragma('journal_mode = WAL');
  } finally {
    db.close();
  }
  chmodSync(path, 0o600);
}

export function databasePath(repositoryRoot: string): string {
  return join(repositoryRoot, DEFAULT_DB_DIRECTORY, DB_FILE_NAME);
}

export function openDatabase(path: string, options: OpenOptions = {}): Db {
  const warn = options.warn ?? ((message: string) => process.emitWarning(message));
  const encrypted = isEncrypted(path);
  if (encrypted && !options.key) {
    throw new DatabaseKeyError(`${path} is encrypted; set SWIFTGRAPH_KEY or store the key in the Keychain (swiftgraph key create)`);
  }
  if (!encrypted && options.key && existsSync(path) && statSync(path).size > 0) {
    throw new DatabaseKeyError(`${path} is not encrypted; encrypt it with \`swiftgraph rekey --encrypt\``);
  }

  if (options.readonly) {
    checkPermissions(path, warn);
    const db = new Database(path, { readonly: true, fileMustExist: true });
    if (options.key) applyKey(db, path, options.key);
    db.pragma('query_only = ON');
    db.pragma('foreign_keys = ON');
    return db;
  }

  const directory = dirname(path);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  if (!existsSync(path)) {
    // Create the file with restrictive permissions before SQLite opens it.
    closeSync(openSync(path, 'a', 0o600));
  }
  chmodSync(directory, 0o700);
  chmodSync(path, 0o600);

  const db = new Database(path);
  if (options.key) applyKey(db, path, options.key);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  // A large page cache matters most for encrypted databases, where every page
  // read from disk is decrypted again.
  db.pragma('cache_size = -262144'); // 256 MiB
  db.pragma('temp_store = MEMORY');
  migrate(db);
  return db;
}

function checkPermissions(path: string, warn: (message: string) => void): void {
  if (process.platform === 'win32' || !existsSync(path)) return;
  const fileMode = statSync(path).mode & 0o777;
  if (fileMode & 0o077) {
    warn(`${path} is accessible by other users (mode ${fileMode.toString(8)}); expected 600`);
  }
  const directoryMode = statSync(dirname(path)).mode & 0o777;
  if (directoryMode & 0o077) {
    warn(`${dirname(path)} is accessible by other users (mode ${directoryMode.toString(8)}); expected 700`);
  }
}

/** Current schema version: the number of the last migration file. */
export function latestSchemaVersion(): number {
  return migrationFiles().at(-1)?.version ?? 0;
}

export function schemaVersion(db: Db): number {
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!hasMeta) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

function migrate(db: Db): void {
  const current = schemaVersion(db);
  for (const migration of migrationFiles()) {
    if (migration.version <= current) continue;
    const sql = readFileSync(migration.path, 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(
        String(migration.version),
      );
    })();
  }
}

function migrationFiles(): { version: number; path: string }[] {
  return readdirSync(MIGRATIONS_DIRECTORY)
    .map((name) => /^(\d+)_.*\.sql$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ version: Number(match[1]), path: join(MIGRATIONS_DIRECTORY, match[0]) }))
    .sort((a, b) => a.version - b.version);
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}
