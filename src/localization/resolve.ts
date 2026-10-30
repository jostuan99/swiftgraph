// Localization part of the resolver: table and string nodes, USES_STRING
// edges, translations and issues. See docs/03-localization.md.

import type { Reference } from '../schema/types.ts';
import type { LocalizationFacts } from './types.ts';

export interface LocalizationFile {
  path: string;
  module: string;
  facts: LocalizationFacts;
  /** Default language of the module (`defaultLocalization`, `developmentRegion`). */
  defaultLanguage?: string;
}

export interface TranslationRecord {
  language: string;
  variationPath: string;
  value: string | null;
  valueHash: string;
  state: string | null;
  formatArgs: string[];
  file: string;
  line: number | null;
}

export interface StringRecord {
  symbolId: string;
  key: string;
  comment: string | null;
  extractionState: string | null;
  shouldTranslate: boolean;
  file: string;
  line: number | null;
  translations: TranslationRecord[];
}

export interface TableRecord {
  symbolId: string;
  module: string;
  name: string;
  sourceLanguage: string | null;
  files: string[];
  strings: Map<string, StringRecord>;
}

export type IssueKind =
  | 'missing_key'
  | 'unused_key'
  | 'missing_translation'
  | 'stale'
  | 'needs_review'
  | 'format_mismatch'
  | 'duplicate_key'
  | 'parse_error'
  | 'dynamic_key_usage';

export interface IssueRecord {
  kind: IssueKind;
  /** Symbol id of the localized string. */
  string?: string;
  /** Symbol id of the declaration that uses a key (missing_key, dynamic_key_usage). */
  node?: string;
  language?: string;
  file?: string;
  line?: number;
  detail?: string;
}

export interface LocalizationPayload {
  tables: Map<string, TableRecord>;
  issues: IssueRecord[];
}

export function tableId(module: string, table: string): string {
  return `l10n:${module}/${table}`;
}

export function stringId(module: string, table: string, key: string): string {
  return `l10n:${module}/${table}/${key}`;
}

/**
 * Builds tables, strings, translations and the file-level issues. Values and
 * languages were already filtered when the files were parsed.
 */
export function buildLocalization(files: LocalizationFile[]): LocalizationPayload {
  const tables = new Map<string, TableRecord>();
  const issues: IssueRecord[] = [];

  for (const file of files) {
    const facts = file.facts;
    const id = tableId(file.module, facts.table);
    let table = tables.get(id);
    if (!table) {
      table = { symbolId: id, module: file.module, name: facts.table, sourceLanguage: null, files: [], strings: new Map() };
      tables.set(id, table);
    }
    table.files.push(file.path);
    // A String Catalog's source language, else the module's default language.
    if (facts.sourceLanguage) table.sourceLanguage = facts.sourceLanguage;
    else if (!table.sourceLanguage && file.defaultLanguage) table.sourceLanguage = file.defaultLanguage;
    for (const warning of facts.warnings) {
      issues.push({
        kind: warning.kind,
        file: file.path,
        ...(warning.line !== null ? { line: warning.line } : {}),
        detail: warning.detail,
      });
    }
    for (const entry of facts.entries) {
      let record = table.strings.get(entry.key);
      if (!record) {
        record = {
          symbolId: stringId(file.module, facts.table, entry.key),
          key: entry.key,
          comment: entry.comment,
          extractionState: entry.extractionState,
          shouldTranslate: entry.shouldTranslate,
          file: file.path,
          line: entry.line,
          translations: [],
        };
        table.strings.set(entry.key, record);
      }
      record.comment ??= entry.comment;
      record.extractionState ??= entry.extractionState;
      if (!entry.shouldTranslate) record.shouldTranslate = false;
      if (entry.language === null) continue;
      record.translations.push({
        language: entry.language,
        variationPath: entry.variationPath,
        value: entry.value,
        valueHash: entry.valueHash,
        state: entry.state,
        formatArgs: entry.formatArgs,
        file: file.path,
        line: entry.line,
      });
    }
  }

  // Source language of tables without a String Catalog or a default language: English, else Base, else the first one.
  for (const table of tables.values()) {
    if (table.sourceLanguage) continue;
    const languages = new Set([...table.strings.values()].flatMap((record) => record.translations.map((t) => t.language)));
    table.sourceLanguage = languages.has('en') ? 'en' : languages.has('Base') ? 'Base' : ([...languages][0] ?? null);
  }

  // Languages of a module: every language of its tables.
  const moduleLanguages = new Map<string, Set<string>>();
  for (const table of tables.values()) {
    const languages = moduleLanguages.get(table.module) ?? new Set<string>();
    for (const record of table.strings.values()) {
      for (const translation of record.translations) if (translation.language !== 'Base') languages.add(translation.language);
    }
    moduleLanguages.set(table.module, languages);
  }

  for (const table of tables.values()) {
    const languages = moduleLanguages.get(table.module) ?? new Set<string>();
    for (const record of table.strings.values()) {
      if (record.extractionState === 'stale') issues.push({ kind: 'stale', string: record.symbolId });
      for (const translation of record.translations) {
        if (translation.state === 'needs_review' || translation.state === 'new') {
          issues.push({ kind: 'needs_review', string: record.symbolId, language: translation.language, detail: translation.state });
        }
      }
      if (record.shouldTranslate) {
        const translated = new Set(record.translations.map((translation) => translation.language));
        for (const language of languages) {
          // A key without any translation is its own source-language text.
          if (language === table.sourceLanguage && translated.size === 0) continue;
          if (!translated.has(language)) issues.push({ kind: 'missing_translation', string: record.symbolId, language });
        }
      }
      const source = record.translations.filter((translation) => translation.language === table.sourceLanguage);
      for (const translation of record.translations) {
        if (translation.language === table.sourceLanguage) continue;
        const reference = source.find((candidate) => candidate.variationPath === translation.variationPath) ?? source[0];
        if (!reference) continue;
        // Plural forms may legitimately drop the count (`one` → "an item").
        if (translation.variationPath.includes('plural.')) continue;
        if (sameArguments(reference.formatArgs, translation.formatArgs)) continue;
        issues.push({
          kind: 'format_mismatch',
          string: record.symbolId,
          language: translation.language,
          detail: `${reference.formatArgs.join(' ') || '(none)'} vs ${translation.formatArgs.join(' ') || '(none)'}`,
        });
      }
    }
  }
  return { tables, issues };
}

function sameArguments(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
}

export interface StringMatch {
  ids: string[];
  confidence: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
}

/**
 * Finds the strings a `string` reference uses. Undefined when the module has
 * no table to look in (no issue then); an empty match is a missing key.
 */
export function matchString(payload: LocalizationPayload, module: string, reference: Reference): StringMatch | undefined {
  const tableName = reference.table ?? 'Localizable';
  const table = payload.tables.get(tableId(module, tableName));
  if (!table) {
    const moduleHasTables = [...payload.tables.values()].some((candidate) => candidate.module === module);
    // A named table that does not exist is a missing key; the default table may simply not be used.
    return reference.table !== undefined && moduleHasTables ? { ids: [], confidence: 'INFERRED' } : undefined;
  }
  const base = reference.localization === 'explicit' ? 'EXTRACTED' : 'INFERRED';
  if (!reference.name.includes('%?')) {
    const record = table.strings.get(reference.name);
    return { ids: record ? [record.symbolId] : [], confidence: base };
  }
  const pattern = new RegExp(
    `^${reference.name
      .split('%?')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('%(?:\\d+\\$)?[-+ #0]*\\d*(?:\\.\\d+)?(?:hh|h|ll|l|q|L|z|t|j)?[@dDiuUxXoOfFeEgGcCsSpaA]')}$`,
  );
  const ids = [...table.strings.values()].filter((record) => pattern.test(record.key)).map((record) => record.symbolId);
  return { ids, confidence: ids.length === 1 ? 'INFERRED' : 'AMBIGUOUS' };
}
