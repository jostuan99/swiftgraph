// Builds the directory → module map from `Package.swift` files, which are
// parsed with tree-sitter like any other Swift file, and from the folders next
// to `*.xcodeproj` directories (`project.pbxproj` is never read).

import { readFileSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';
import { parseSwift, type SyntaxNode } from '../parse/swift-parser.ts';

const TARGET_FACTORIES: ReadonlyMap<string, string> = new Map([
  ['target', 'Sources'],
  ['executableTarget', 'Sources'],
  ['macro', 'Sources'],
  ['plugin', 'Plugins'],
  ['testTarget', 'Tests'],
]);

export interface ModuleEntry {
  /** Directory relative to the repository root, without a trailing slash ('' for the root). */
  directory: string;
  module: string;
  source: 'override' | 'manifest' | 'xcode' | 'convention';
}

export interface ModuleMap {
  entries: ModuleEntry[];
  /** Module of files outside every known directory. */
  rootModule: string;
}

export interface ManifestTarget {
  name: string;
  path: string | null;
  factory: string;
}

/** Reads the targets declared in a `Package.swift` source. */
export function manifestTargets(source: string): ManifestTarget[] {
  const tree = parseSwift(source);
  const targets: ManifestTarget[] = [];
  const visit = (node: SyntaxNode) => {
    if (node.type === 'call_expression') {
      const callee = node.childForFieldName('function');
      const member = callee?.type === 'implicit_member_expression' ? callee.childForFieldName('member')?.text : undefined;
      if (member && TARGET_FACTORIES.has(member)) {
        const name = stringArgument(node, 'name');
        if (name) targets.push({ name, path: stringArgument(node, 'path'), factory: member });
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(tree.rootNode);
  return targets;
}

function stringArgument(call: SyntaxNode, label: string): string | null {
  const argumentsNode = call.childForFieldName('arguments');
  if (!argumentsNode) return null;
  for (const argument of argumentsNode.namedChildren) {
    if (argument.type !== 'value_argument') continue;
    if (argument.childForFieldName('name')?.text !== label) continue;
    const value = argument.childForFieldName('value');
    if (value?.type !== 'line_string_literal') return null;
    // Only plain literals: interpolated paths cannot be resolved statically.
    if (value.namedChildren.some((child) => child.type !== 'string_content')) return null;
    return value.namedChildren.map((child) => child.text).join('');
  }
  return null;
}

export interface XcodeLayout {
  /** `*.xcodeproj` directories, relative to the root. */
  projects: string[];
  /** Relevant files, relative to the root. */
  files: string[];
}

export function readModuleMap(
  root: string,
  manifestPaths: string[],
  overrides: Record<string, string>,
  xcode: XcodeLayout = { projects: [], files: [] },
): ModuleMap {
  const entries: ModuleEntry[] = [];
  for (const [directory, module] of Object.entries(overrides)) {
    entries.push({ directory: trimSlashes(directory), module, source: 'override' });
  }
  for (const manifestPath of manifestPaths) {
    const packageDirectory = dirname(manifestPath) === '.' ? '' : dirname(manifestPath);
    let source: string;
    try {
      source = readFileSync(join(root, manifestPath), 'utf8');
    } catch {
      continue;
    }
    for (const target of manifestTargets(source)) {
      const relativeDirectory = target.path ?? `${TARGET_FACTORIES.get(target.factory)}/${target.name}`;
      const directory = trimSlashes(normalize(join(packageDirectory, relativeDirectory)).split('\\').join('/'));
      entries.push({ directory: directory === '.' ? '' : directory, module: target.name, source: 'manifest' });
    }
  }
  entries.push(...xcodeEntries(xcode, entries));
  return { entries, rootModule: basename(root) };
}

/**
 * Xcode creates one folder per target next to the project (`App/`,
 * `AppTests/`). Each such folder holding a Swift file becomes a module, unless
 * a manifest or override already maps it or a directory inside it. A generic
 * folder name (`Source/`) takes the project's name instead.
 */
function xcodeEntries(xcode: XcodeLayout, known: ModuleEntry[]): ModuleEntry[] {
  const entries: ModuleEntry[] = [];
  const seen = new Set<string>();
  for (const project of [...xcode.projects].sort()) {
    const projectDirectory = dirname(project) === '.' ? '' : dirname(project);
    const projectName = basename(project).replace(/\.xcodeproj$/i, '');
    const prefix = projectDirectory === '' ? '' : `${projectDirectory}/`;
    for (const file of xcode.files) {
      if (!file.endsWith('.swift') || !file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length).split('/');
      if (rest.length < 2) continue;
      const folder = rest[0]!;
      const directory = `${prefix}${folder}`;
      if (seen.has(directory) || CONVENTION_FOLDERS.has(folder)) continue;
      seen.add(directory);
      const covered = known.some((entry) => entry.directory === directory || entry.directory.startsWith(`${directory}/`));
      const name = GENERIC_FOLDERS.has(folder) ? projectName : folder;
      if (!covered) entries.push({ directory, module: productModuleName(name), source: 'xcode' });
    }
  }
  return entries;
}

const CONVENTION_FOLDERS: ReadonlySet<string> = new Set(['Sources', 'Tests', 'Plugins', 'Packages']);
const GENERIC_FOLDERS: ReadonlySet<string> = new Set(['Source', 'Src', 'Classes', 'Code']);

/** Xcode's PRODUCT_MODULE_NAME rule: `My App-iOS` → `My_App_iOS`, `2D` → `_2D`. */
export function productModuleName(name: string): string {
  const identifier = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(identifier) ? `_${identifier}` : identifier;
}

/**
 * Module of a file: the longest matching directory of the map, else the
 * `Sources/<Name>`/`Tests/<Name>` convention, else the top-level directory,
 * else the repository name.
 */
export function moduleForPath(map: ModuleMap, path: string): string {
  const byDirectory = directoryIndex(map);
  // The path itself (a mapped directory), then each parent, longest first.
  const exact = byDirectory.get(path);
  if (exact) return exact.module;
  for (let end = path.lastIndexOf('/'); ; end = path.lastIndexOf('/', end - 1)) {
    const entry = byDirectory.get(end < 0 ? '' : path.slice(0, end));
    if (entry) return entry.module;
    if (end <= 0) break;
  }

  const parts = path.split('/');
  const conventional = parts.findIndex((part) => part === 'Sources' || part === 'Tests');
  if (conventional >= 0 && parts.length > conventional + 2) return parts[conventional + 1]!;
  if (parts.length > 1) return parts[0]!;
  return map.rootModule;
}

const directoryIndexes = new WeakMap<ModuleMap, Map<string, ModuleEntry>>();

/** Entry per directory; an override wins over other entries for the same directory. */
function directoryIndex(map: ModuleMap): Map<string, ModuleEntry> {
  let index = directoryIndexes.get(map);
  if (!index) {
    index = new Map();
    for (const entry of map.entries) {
      const existing = index.get(entry.directory);
      if (!existing || (entry.source === 'override' && existing.source !== 'override')) index.set(entry.directory, entry);
    }
    directoryIndexes.set(map, index);
  }
  return index;
}

function trimSlashes(path: string): string {
  return path.replace(/^\.?\/+/, '').replace(/\/+$/, '');
}
