// Loads the presets and the project's swiftgraph.yaml (or .yml, .json) into one rule set.
// See docs/05-data-flow.md, section 5.1.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'node:url';
import { RULE_KINDS, type ArgumentRef, type RuleFile, type RuleKind, type RuleSet } from './types.ts';

export const CONFIG_FILE = 'swiftgraph.json';

/** Project rule files, in YAML or JSON; a project has at most one. */
export const CONFIG_FILES = ['swiftgraph.yaml', 'swiftgraph.yml', CONFIG_FILE] as const;

/** The project's rule file, if any. Throws `RuleError` when there are several. */
export function configPath(root: string): string | undefined {
  const found = CONFIG_FILES.filter((name) => existsSync(join(root, name)));
  if (found.length > 1) throw new RuleError(`${found.join(' and ')}: keep one rule file`);
  return found[0] === undefined ? undefined : join(root, found[0]);
}

/** Reads a rule file: YAML, or JSON (which YAML also reads). */
export function readRuleFile(path: string): RuleFile {
  const name = basename(path);
  let file: RuleFile;
  try {
    file = (parseYaml(readFileSync(path, 'utf8')) ?? {}) as RuleFile;
  } catch (error) {
    throw new RuleError(`${name}: ${(error as Error).message}`);
  }
  validate(file, name);
  return file;
}

const PRESET_DIRECTORY = fileURLToPath(new URL('./presets/', import.meta.url));

interface Preset extends RuleFile {
  name: string;
  description: string;
  /** Applied by default when the project imports one of these modules (always when absent). */
  whenImports?: string[];
}

export class RuleError extends Error {}

let presetCache: Map<string, Preset> | undefined;

export function presets(): Map<string, Preset> {
  if (presetCache) return presetCache;
  presetCache = new Map();
  for (const name of readdirSync(PRESET_DIRECTORY)
    .filter((file) => file.endsWith('.json'))
    .sort()) {
    const preset = JSON.parse(readFileSync(join(PRESET_DIRECTORY, name), 'utf8')) as Preset;
    presetCache.set(preset.name, preset);
  }
  return presetCache;
}

/** Presets used when the project names none: the ones whose modules it imports. */
export function defaultPresets(imports: ReadonlySet<string>): string[] {
  return [...presets().values()]
    .filter((preset) => !preset.whenImports || preset.whenImports.some((module) => imports.has(module)))
    .map((preset) => preset.name);
}

/**
 * Reads the project's rule file (optional, see `configPath`) and merges it
 * over its presets. `imports` are the modules the project imports, for the default presets.
 */
export function loadRules(root: string, imports: ReadonlySet<string>): RuleSet {
  const path = configPath(root);
  return mergeRules(path ? readRuleFile(path) : {}, imports, path ? basename(path) : CONFIG_FILE);
}

export function mergeRules(project: RuleFile, imports: ReadonlySet<string>, origin: string = CONFIG_FILE): RuleSet {
  const available = presets();
  const names = project.extends ?? defaultPresets(imports);
  const layers: { origin: string; file: RuleFile }[] = [];
  for (const name of names) {
    const preset = available.get(name);
    if (!preset) throw new RuleError(`${origin}: unknown preset "${name}" (available: ${[...available.keys()].join(', ')})`);
    layers.push({ origin: name, file: preset });
  }
  layers.push({ origin, file: project });

  const disabled = new Set(layers.flatMap((layer) => layer.file.disable ?? []));
  const result = { presets: names, hash: '' } as RuleSet;
  for (const kind of RULE_KINDS) {
    const merged: Record<string, unknown>[] = [];
    for (const layer of layers) {
      for (const rule of (layer.file[kind] ?? []) as Record<string, unknown>[]) {
        const loaded = { ...rule, origin: layer.origin };
        const existing = typeof rule.id === 'string' ? merged.findIndex((other) => other.id === rule.id) : -1;
        if (existing >= 0) merged[existing] = loaded;
        else merged.push(loaded);
      }
    }
    // Later layers win: the project's rules first, then the last preset's; in file order within a layer.
    const rank = (rule: Record<string, unknown>) => layers.findIndex((layer) => layer.origin === rule.origin);
    (result as unknown as Record<RuleKind, unknown[]>)[kind] = merged
      .filter((rule) => typeof rule.id !== 'string' || !disabled.has(rule.id))
      .map((rule, position) => ({ rule, position }))
      .sort((a, b) => rank(b.rule) - rank(a.rule) || a.position - b.position)
      .map((entry) => entry.rule);
  }
  result.hash = createHash('sha256')
    .update(JSON.stringify(RULE_KINDS.map((kind) => result[kind])))
    .digest('hex')
    .slice(0, 16);
  return result;
}

/**
 * The effective rules of `kinds` as a rule file: presets in `extends`,
 * then each rule with its `id`. Copied into the project and edited, a rule
 * replaces the preset rule with the same `id`.
 */
export function ruleTemplate(rules: RuleSet, kinds: readonly RuleKind[]): RuleFile {
  const template: RuleFile = { extends: rules.presets };
  for (const kind of kinds) {
    (template as Record<string, unknown>)[kind] = (rules[kind] as { origin: string }[]).map(({ origin: _origin, ...rule }) => rule);
  }
  return template;
}

function validate(file: RuleFile, name: string): void {
  if (typeof file !== 'object' || file === null || Array.isArray(file)) throw new RuleError(`${name}: expected an object`);
  const known = new Set<string>(['$schema', 'extends', 'disable', ...RULE_KINDS]);
  for (const key of Object.keys(file)) {
    if (!known.has(key)) throw new RuleError(`${name}: unknown key "${key}"`);
  }
  for (const key of ['extends', 'disable', ...RULE_KINDS] as const) {
    const value = file[key];
    if (value !== undefined && !Array.isArray(value)) throw new RuleError(`${name}: "${key}" must be an array`);
  }
  for (const rule of file.layers ?? []) {
    if (typeof rule.layer !== 'string' || typeof rule.match !== 'object')
      throw new RuleError(`${name}: a layer rule needs "layer" and "match"`);
  }
  for (const rule of file.sources ?? []) {
    if (typeof rule.kind !== 'string' || (rule.call === undefined && rule.attribute === undefined && rule.member === undefined)) {
      throw new RuleError(`${name}: a source rule needs "kind" and "call", "member" or "attribute"`);
    }
    if (rule.member !== undefined && rule.keyFrom === undefined)
      throw new RuleError(`${name}: a source rule with "member" needs "keyFrom" (rawValue, case, self or a property)`);
  }
  for (const rule of file.sinks ?? []) {
    if ((rule.call === undefined) === (rule.property === undefined)) throw new RuleError(`${name}: a sink rule needs "call" or "property"`);
  }
  for (const rule of file.navigation ?? []) {
    if (typeof rule.call !== 'string' || !Array.isArray(rule.destination))
      throw new RuleError(`${name}: a navigation rule needs "call" and "destination"`);
    if (rule.transition !== undefined && (typeof rule.transition !== 'string' || rule.transition === ''))
      throw new RuleError(`${name}: "transition" of a navigation rule is a name: "push", "modal", ...`);
    if (rule.to !== undefined && typeof rule.to !== 'string') throw new RuleError(`${name}: "to" of a navigation rule is a type name`);
  }
  for (const rule of file.inputs ?? []) {
    const selectors = [rule.initializer, rule.method, rule.attribute, rule.memberwise].filter((value) => value !== undefined);
    if (typeof rule.kind !== 'string' || selectors.length !== 1)
      throw new RuleError(`${name}: an input rule needs "kind" and one of "initializer", "method", "attribute", "memberwise"`);
  }
  for (const rule of file.localization ?? []) {
    if (typeof rule.defaultLanguage !== 'string' || rule.defaultLanguage === '')
      throw new RuleError(`${name}: a localization rule needs "defaultLanguage" ("en", "ja", ...)`);
  }
  for (const rule of file.injection ?? []) {
    if (typeof rule.register !== 'string') throw new RuleError(`${name}: an injection rule needs "register"`);
  }
}

// --- Matching helpers ------------------------------------------------------------

export interface CallPattern {
  /** Receiver type; `*` for any; undefined for a call without receiver (`Text(_:)`). */
  type?: string;
  name: string;
  /** Argument labels; undefined when the pattern names no selector. */
  labels?: string[];
}

const patternCache = new Map<string, CallPattern>();

/** `JSONDecoder.decode(_:from:)`, `*.map`, `Text(_:)`. */
export function parseCallPattern(text: string): CallPattern {
  const cached = patternCache.get(text);
  if (cached) return cached;
  const open = text.indexOf('(');
  const head = open < 0 ? text : text.slice(0, open);
  const dot = head.lastIndexOf('.');
  const pattern: CallPattern = { name: dot < 0 ? head : head.slice(dot + 1) };
  if (dot >= 0) pattern.type = head.slice(0, dot);
  if (open >= 0)
    pattern.labels = text
      .slice(open + 1, -1)
      .split(':')
      .slice(0, -1);
  patternCache.set(text, pattern);
  return pattern;
}

/** Labels of a call selector: `sink(_:receiveValue:)` → `['_', 'receiveValue']`. */
export function selectorLabels(selector: string): string[] {
  const open = selector.indexOf('(');
  if (open < 0) return [];
  const inner = selector.slice(open + 1, -1);
  return inner === '' ? [] : inner.split(':').slice(0, -1);
}

/**
 * Maps each argument of a call to the label it fills in the pattern, or
 * undefined when the call cannot match. Pattern labels may be skipped
 * (default values). An unlabeled argument fills the next parameter, except
 * trailing closures: they fill the parameters just before the next labeled
 * argument, or the last parameters of the pattern.
 */
export function alignArguments(pattern: CallPattern, call: { label: string; closure?: boolean }[]): string[] | undefined {
  const callLabels = call.map((argument) => argument.label);
  if (!pattern.labels) return callLabels;
  const labels = pattern.labels;
  const result: string[] = [];
  let index = 0;
  for (const [position, argument] of call.entries()) {
    let target = -1;
    if (argument.label !== '_') {
      target = labels.indexOf(argument.label, index);
    } else if (argument.closure) {
      const next = call.findIndex((other, at) => at > position && other.label !== '_');
      if (next >= 0) {
        target = labels.indexOf(call[next]!.label, index) - (next - position);
      } else {
        target = labels.length - (call.length - position);
      }
      if (target < index) target = -1;
    } else {
      // An unlabeled argument fills the next unlabeled parameter.
      target = labels.indexOf('_', index);
    }
    if (target < 0) return undefined;
    result.push(labels[target]!);
    index = target + 1;
  }
  return result;
}

/** Index of the call argument an `ArgumentRef` points to, given the aligned labels. */
export function argumentIndex(reference: ArgumentRef, aligned: string[], callLabels: string[]): number {
  if (typeof reference === 'number') return reference < callLabels.length ? reference : -1;
  if (reference === 'trailing') return callLabels.length - 1;
  const index = aligned.indexOf(reference);
  if (index >= 0) return index;
  return /^\d+$/.test(reference) ? argumentIndex(Number(reference), aligned, callLabels) : -1;
}

const globCache = new Map<string, RegExp>();

export function globMatches(glob: string, text: string): boolean {
  let pattern = globCache.get(glob);
  if (!pattern) {
    pattern = new RegExp(
      `^${glob
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    );
    globCache.set(glob, pattern);
  }
  return pattern.test(text);
}

export function asList<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
