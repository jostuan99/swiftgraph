// Lists the files swiftgraph reads: Swift sources and localization files only.
// See docs/01-design.md, section 2.1.
//
// Other files are never opened. Directories are walked by name; symbolic links
// are not followed.

import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import type { DiscoveredFile, FileKind } from '../schema/types.ts';
import { readModuleMap, type ModuleMap, moduleForPath } from './package-manifest.ts';

const KINDS_BY_EXTENSION: ReadonlyMap<string, FileKind> = new Map([
  ['.swift', 'swift'],
  ['.strings', 'strings'],
  ['.stringsdict', 'stringsdict'],
  ['.xcstrings', 'xcstrings'],
]);

const EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.build',
  '.swiftpm',
  '.swiftgraph',
  'DerivedData',
  'Pods',
  'Carthage',
  'node_modules',
]);

const EXCLUDED_DIRECTORY_EXTENSIONS: ReadonlySet<string> = new Set(['.xcodeproj', '.xcworkspace', '.xcassets']);

export const DEFAULT_SIZE_LIMITS: Readonly<Record<FileKind, number>> = {
  swift: 5 * 1024 * 1024,
  strings: 50 * 1024 * 1024,
  stringsdict: 50 * 1024 * 1024,
  xcstrings: 50 * 1024 * 1024,
};

export interface DiscoverOptions {
  /** Glob patterns, relative to the root, of paths to skip (`Generated/**`). */
  exclude?: string[];
  /** List paths with `git ls-files` instead of walking the directory tree. */
  gitTrackedOnly?: boolean;
  /** Directory → module overrides (`--module App/Sources=App`). */
  modules?: Record<string, string>;
  sizeLimits?: Partial<Record<FileKind, number>>;
  /** Module map of a previous run, reused while the manifests are unchanged. */
  moduleMapCache?: { key: string; map: ModuleMap };
}

export interface Discovery {
  files: DiscoveredFile[];
  moduleMap: ModuleMap;
  /** Identifies the manifests the module map was built from (for moduleMapCache). */
  moduleMapKey: string;
  /** Files skipped because they exceed the size limit, relative paths. */
  skippedLarge: string[];
}

export function fileKind(path: string): FileKind | undefined {
  return KINDS_BY_EXTENSION.get(extname(path).toLowerCase());
}

export function discover(root: string, options: DiscoverOptions = {}): Discovery {
  const excludePatterns = (options.exclude ?? []).map(globToRegExp);
  const isExcluded = (relativePath: string) => excludePatterns.some((pattern) => pattern.test(relativePath));
  const limits = { ...DEFAULT_SIZE_LIMITS, ...options.sizeLimits };

  const xcodeProjects: string[] = [];
  const candidates = options.gitTrackedOnly ? gitFiles(root, xcodeProjects) : walk(root, isExcluded, xcodeProjects);
  const relevant = candidates.filter((path) => fileKind(path) !== undefined && !isExcluded(path));

  const manifests = relevant.filter((path) => basename(path) === 'Package.swift').sort();
  const projects = xcodeProjects.filter((path) => !isExcluded(path)).sort();
  const moduleMapKey = JSON.stringify({
    overrides: options.modules ?? {},
    manifests: manifests.map((path) => {
      const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
      return [path, stat?.mtimeMs ?? 0, stat?.size ?? 0];
    }),
    // `developmentRegion` is read from each project file.
    projects: projects.map((path) => {
      const stat = lstatSync(join(root, path, 'project.pbxproj'), { throwIfNoEntry: false });
      return [path, stat?.mtimeMs ?? 0, stat?.size ?? 0];
    }),
    // Xcode target folders are inferred from the directories holding files.
    folders: projects.length > 0 ? [...new Set(relevant.map(parentDirectory))].sort() : [],
  });
  const moduleMap =
    options.moduleMapCache?.key === moduleMapKey
      ? options.moduleMapCache.map
      : readModuleMap(root, manifests, options.modules ?? {}, { projects, files: relevant });

  const files: DiscoveredFile[] = [];
  const skippedLarge: string[] = [];
  for (const path of relevant.sort()) {
    const absolutePath = join(root, path);
    const stat = lstatSync(absolutePath, { throwIfNoEntry: false });
    if (!stat?.isFile()) continue; // also drops symbolic links
    const kind = fileKind(path)!;
    if (stat.size > limits[kind]) {
      skippedLarge.push(path);
      continue;
    }
    files.push({
      path,
      absolutePath,
      kind,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      language: kind === 'swift' || kind === 'xcstrings' ? null : lprojLanguage(path),
      module: moduleForPath(moduleMap, path),
    });
  }
  return { files, moduleMap, moduleMapKey, skippedLarge };
}

/** Walks the tree; `*.xcodeproj` directories are recorded by name, never entered. */
function walk(root: string, isExcluded: (path: string) => boolean, xcodeProjects: string[]): string[] {
  const result: string[] = [];
  const pending = [''];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(join(root, directory), { withFileTypes: true });
    } catch {
      continue; // unreadable directory
    }
    for (const entry of entries) {
      const path = directory === '' ? entry.name : `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
        if (extname(entry.name).toLowerCase() === '.xcodeproj') xcodeProjects.push(path);
        if (EXCLUDED_DIRECTORY_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
        if (isExcluded(path) || isExcluded(`${path}/`)) continue;
        pending.push(path);
      } else if (entry.isFile() && fileKind(entry.name)) {
        result.push(path);
      }
    }
  }
  return result;
}

function gitFiles(root: string, xcodeProjects: string[]): string[] {
  // git applies .gitignore itself; swiftgraph never reads that file.
  const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const paths = output
    .split('\0')
    .filter((path) => path.length > 0)
    .filter((path) => !path.split('/').some((part) => EXCLUDED_DIRECTORY_NAMES.has(part)));
  const projects = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    const index = parts.findIndex((part) => extname(part).toLowerCase() === '.xcodeproj');
    if (index >= 0) projects.add(parts.slice(0, index + 1).join('/'));
  }
  xcodeProjects.push(...projects);
  return paths.filter((path) => !path.split('/').some((part) => EXCLUDED_DIRECTORY_EXTENSIONS.has(extname(part).toLowerCase())));
}

function parentDirectory(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

/** `vi.lproj/Localizable.strings` → `vi`; `Base.lproj/...` → `Base`. */
export function lprojLanguage(path: string): string | null {
  const directory = basename(dirname(path));
  return directory.toLowerCase().endsWith('.lproj') ? directory.slice(0, -'.lproj'.length) : null;
}

/** Converts a glob (`*`, `**`, `?`) to an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        pattern += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

export function toPosixPath(path: string): string {
  return path.split(sep).join('/');
}

export function relativePosix(root: string, path: string): string {
  return toPosixPath(relative(root, path));
}
