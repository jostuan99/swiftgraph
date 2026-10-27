// Parsers for `.strings`, `.stringsdict` and `.xcstrings` files.
// See docs/03-localization.md, section 4.
//
// None of them executes or resolves anything from the file: the plist reader
// ignores DOCTYPE declarations and only decodes the five predefined XML
// entities and numeric character references (no XXE), and String Catalogs go
// through JSON.parse with shape checks.

import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import {
  LOCALIZATION_FACTS_VERSION,
  type LocalizationEntry,
  type LocalizationFacts,
  type LocalizationOptions,
  type LocalizationWarning,
} from './types.ts';

export function parseLocalizationFile(
  path: string,
  bytes: Buffer,
  language: string | null,
  options: LocalizationOptions = {},
): LocalizationFacts {
  const table = basename(path, extname(path));
  const extension = extname(path).toLowerCase();
  const facts =
    extension === '.xcstrings'
      ? parseStringCatalog(table, decodeText(bytes))
      : extension === '.stringsdict'
        ? parseStringsDictionary(table, decodeText(bytes), language)
        : parseStrings(table, decodeText(bytes), language);
  return applyOptions(facts, options);
}

/** Drops values and languages before the facts are stored anywhere. */
function applyOptions(facts: LocalizationFacts, options: LocalizationOptions): LocalizationFacts {
  const languages = options.languages?.length ? new Set(options.languages) : undefined;
  facts.entries = facts.entries
    .filter((item) => !languages || item.language === null || languages.has(item.language))
    .map((item) => (options.noValues ? { ...item, value: null } : item));
  return facts;
}

/** UTF-16 (with BOM) or UTF-8 text. */
export function decodeText(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  // UTF-16 without a byte order mark: ASCII text has a zero in every other byte.
  if (bytes.length >= 2 && bytes[0] !== 0 && bytes[1] === 0) return bytes.toString('utf16le');
  if (bytes.length >= 2 && bytes[0] === 0 && bytes[1] !== 0) {
    const swapped = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return bytes.toString('utf8');
}

function entry(
  key: string,
  language: string | null,
  value: string | null,
  line: number | null,
  extra: Partial<LocalizationEntry> = {},
): LocalizationEntry {
  return {
    key,
    language,
    variationPath: '',
    value,
    valueHash: createHash('sha256')
      .update(value ?? '')
      .digest('hex'),
    formatArgs: value === null ? [] : formatArguments(value),
    state: null,
    comment: null,
    extractionState: null,
    shouldTranslate: true,
    line,
    ...extra,
  };
}

// --- .strings ------------------------------------------------------------------------

/**
 * `"key" = "value";` entries with block and line comments; keys and values
 * may also be unquoted words. The comment right before an entry becomes its
 * comment. A repeated key keeps the last value, as at runtime.
 */
export function parseStrings(table: string, text: string, language: string | null): LocalizationFacts {
  const entries = new Map<string, LocalizationEntry>();
  const warnings: LocalizationWarning[] = [];
  let index = 0;
  let line = 1;
  let pendingComment: string | null = null;

  const peek = () => text[index];
  const advance = () => {
    const char = text[index++];
    if (char === '\n') line++;
    return char;
  };
  const fail = (detail: string) => {
    warnings.push({ kind: 'parse_error', line, detail });
    // Skip to the next statement.
    while (index < text.length && peek() !== ';') advance();
    if (index < text.length) advance();
  };
  const skipSpace = () => {
    for (;;) {
      while (index < text.length && /\s/.test(peek()!)) advance();
      if (text.startsWith('/*', index)) {
        const end = text.indexOf('*/', index + 2);
        const body = text.slice(index + 2, end < 0 ? text.length : end);
        pendingComment = body.trim() || null;
        while (index < (end < 0 ? text.length : end + 2)) advance();
      } else if (text.startsWith('//', index)) {
        const start = index + 2;
        while (index < text.length && peek() !== '\n') advance();
        pendingComment = text.slice(start, index).trim() || null;
      } else {
        return;
      }
    }
  };
  const readToken = (): string | null => {
    if (peek() === '"') {
      advance();
      let value = '';
      while (index < text.length && peek() !== '"') {
        const char = advance()!;
        if (char !== '\\') {
          value += char;
          continue;
        }
        const escaped = advance();
        switch (escaped) {
          case 'n':
            value += '\n';
            break;
          case 't':
            value += '\t';
            break;
          case 'r':
            value += '\r';
            break;
          case '"':
            value += '"';
            break;
          case '\\':
            value += '\\';
            break;
          case 'U':
          case 'u': {
            const hex = text.slice(index, index + 4);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              value += String.fromCharCode(Number.parseInt(hex, 16));
              index += 4;
            } else {
              value += `\\${escaped}`;
            }
            break;
          }
          default:
            value += escaped ?? '';
        }
      }
      if (index >= text.length) return null;
      advance();
      return value;
    }
    const match = /^[A-Za-z0-9_.\-$:/]+/.exec(text.slice(index));
    if (!match) return null;
    for (let i = 0; i < match[0].length; i++) advance();
    return match[0];
  };

  for (;;) {
    skipSpace();
    if (index >= text.length) break;
    const entryLine = line;
    const comment = pendingComment;
    pendingComment = null;
    const key = readToken();
    if (key === null) {
      fail('expected a key');
      continue;
    }
    skipSpace();
    if (peek() !== '=') {
      fail(`expected '=' after "${key}"`);
      continue;
    }
    advance();
    skipSpace();
    const value = readToken();
    if (value === null) {
      fail(`expected a value for "${key}"`);
      continue;
    }
    skipSpace();
    if (peek() !== ';') {
      fail(`expected ';' after the value of "${key}"`);
      continue;
    }
    advance();
    if (entries.has(key)) warnings.push({ kind: 'duplicate_key', line: entryLine, detail: key });
    entries.set(key, entry(key, language, value, entryLine, { comment }));
  }
  return { version: LOCALIZATION_FACTS_VERSION, table, sourceLanguage: null, entries: [...entries.values()], warnings };
}

// --- .stringsdict (XML property list) ----------------------------------------------

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

interface XmlNode {
  name: string;
  children: XmlNode[];
  text: string;
  line: number;
}

const XML_ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    // Unknown (DTD-defined) entities are left as they are: never expanded.
    return XML_ENTITIES[entity] ?? whole;
  });
}

/** Minimal XML element parser for property lists. */
function parseXml(text: string): XmlNode {
  const root: XmlNode = { name: '#root', children: [], text: '', line: 1 };
  const stack: XmlNode[] = [root];
  const pattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w.-]*)[^>]*?(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const line = text.slice(0, match.index).split('\n').length;
    const current = stack.at(-1)!;
    if (match[1] !== undefined) {
      current.text += match[1];
    } else if (match[3] !== undefined) {
      const [, , closing, name, selfClosing] = match;
      if (closing) {
        if (current.name !== name) throw new Error(`line ${line}: unexpected </${name}>`);
        stack.pop();
      } else {
        const node: XmlNode = { name: name!, children: [], text: '', line };
        current.children.push(node);
        if (!selfClosing) stack.push(node);
      }
    } else if (match[5] !== undefined) {
      current.text += decodeXmlText(match[5]);
    }
  }
  if (stack.length !== 1) throw new Error(`unclosed <${stack.at(-1)!.name}>`);
  return root;
}

function plistValue(node: XmlNode): PlistValue {
  switch (node.name) {
    case 'string':
      return node.text;
    case 'integer':
    case 'real':
      return Number(node.text.trim());
    case 'true':
      return true;
    case 'false':
      return false;
    case 'array':
      return node.children.map(plistValue);
    case 'dict': {
      const result: { [key: string]: PlistValue } = {};
      for (let i = 0; i + 1 < node.children.length; i += 2) {
        const key = node.children[i]!;
        if (key.name !== 'key') throw new Error(`line ${key.line}: expected <key>`);
        result[key.text] = plistValue(node.children[i + 1]!);
      }
      return result;
    }
    default:
      return node.text;
  }
}

/** Plural rules: one entry per form, `variationPath = plural.<variable>.<form>`. */
export function parseStringsDictionary(table: string, text: string, language: string | null): LocalizationFacts {
  const warnings: LocalizationWarning[] = [];
  const entries: LocalizationEntry[] = [];
  let document: XmlNode;
  try {
    document = parseXml(text);
  } catch (error) {
    warnings.push({ kind: 'parse_error', line: null, detail: error instanceof Error ? error.message : String(error) });
    return { version: LOCALIZATION_FACTS_VERSION, table, sourceLanguage: null, entries, warnings };
  }
  const dict = document.children.find((node) => node.name === 'plist')?.children.find((node) => node.name === 'dict');
  if (!dict) {
    warnings.push({ kind: 'parse_error', line: null, detail: 'missing <plist><dict>' });
    return { version: LOCALIZATION_FACTS_VERSION, table, sourceLanguage: null, entries, warnings };
  }
  for (let i = 0; i + 1 < dict.children.length; i += 2) {
    const keyNode = dict.children[i]!;
    const valueNode = dict.children[i + 1]!;
    const value = plistValue(valueNode);
    if (typeof value !== 'object' || Array.isArray(value)) continue;
    const format = value['NSStringLocalizedFormatKey'];
    entries.push(entry(keyNode.text, language, typeof format === 'string' ? format : null, keyNode.line));
    for (const [variable, rule] of Object.entries(value)) {
      if (typeof rule !== 'object' || Array.isArray(rule)) continue;
      for (const [form, text] of Object.entries(rule)) {
        if (form.startsWith('NSString') || typeof text !== 'string') continue;
        entries.push(entry(keyNode.text, language, text, keyNode.line, { variationPath: `plural.${variable}.${form}` }));
      }
    }
  }
  return { version: LOCALIZATION_FACTS_VERSION, table, sourceLanguage: null, entries, warnings };
}

// --- .xcstrings (String Catalog) ------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseStringCatalog(table: string, text: string): LocalizationFacts {
  const warnings: LocalizationWarning[] = [];
  const entries: LocalizationEntry[] = [];
  let document: Json;
  try {
    document = JSON.parse(text) as Json;
  } catch (error) {
    warnings.push({ kind: 'parse_error', line: null, detail: error instanceof Error ? error.message : String(error) });
    return { version: LOCALIZATION_FACTS_VERSION, table, sourceLanguage: null, entries, warnings };
  }
  if (!isObject(document) || !isObject(document['strings'])) {
    warnings.push({ kind: 'parse_error', line: null, detail: 'expected an object with "strings"' });
    return { version: LOCALIZATION_FACTS_VERSION, table, sourceLanguage: null, entries, warnings };
  }
  const sourceLanguage = typeof document['sourceLanguage'] === 'string' ? document['sourceLanguage'] : null;

  for (const [key, item] of Object.entries(document['strings'])) {
    if (!isObject(item)) {
      warnings.push({ kind: 'parse_error', line: null, detail: `"${key}" is not an object` });
      continue;
    }
    const base: Partial<LocalizationEntry> = {
      comment: typeof item['comment'] === 'string' ? item['comment'] : null,
      extractionState: typeof item['extractionState'] === 'string' ? item['extractionState'] : null,
      shouldTranslate: item['shouldTranslate'] !== false,
    };
    const localizations = isObject(item['localizations']) ? item['localizations'] : {};
    const before = entries.length;
    for (const [language, localization] of Object.entries(localizations)) {
      if (!isObject(localization)) continue;
      collectUnits(localization, '', (path, value, state) => {
        entries.push(entry(key, language, value, null, { ...base, variationPath: path, state }));
      });
    }
    // A key with no translation yet: its text is the key itself in the source language.
    if (entries.length === before) entries.push(entry(key, null, null, null, base));
  }
  return { version: LOCALIZATION_FACTS_VERSION, table, sourceLanguage, entries, warnings };
}

/** Flattens `stringUnit`, `variations` and `substitutions` into variation paths. */
function collectUnits(
  node: { [key: string]: Json },
  path: string,
  emit: (path: string, value: string | null, state: string | null) => void,
): void {
  const unit = node['stringUnit'];
  if (isObject(unit)) {
    emit(path, typeof unit['value'] === 'string' ? unit['value'] : null, typeof unit['state'] === 'string' ? unit['state'] : null);
  }
  const variations = node['variations'];
  if (isObject(variations)) {
    for (const [kind, cases] of Object.entries(variations)) {
      if (!isObject(cases)) continue;
      for (const [name, child] of Object.entries(cases)) {
        if (isObject(child)) collectUnits(child, join(path, `${kind}.${name}`), emit);
      }
    }
  }
  const substitutions = node['substitutions'];
  if (isObject(substitutions)) {
    for (const [name, child] of Object.entries(substitutions)) {
      if (isObject(child)) collectUnits(child, join(path, `sub.${name}`), emit);
    }
  }
}

function join(path: string, part: string): string {
  return path === '' ? part : `${path}|${part}`;
}

// --- Format specifiers ----------------------------------------------------------------

// `%#@name@` (stringsdict variable) first, so `#` is not read as a printf flag.
const FORMAT_SPECIFIER = /%#@[A-Za-z_]\w*@|%(?:\d+\$)?[-+ #0']*\d*(?:\.\d+)?(?:hh|h|ll|l|q|L|z|t|j)?[@dDiuUxXoOfFeEgGcCsSpaA]/g;

/** Format specifiers of a value, positional arguments in order (`%%` is not one). */
export function formatArguments(value: string): string[] {
  return (value.replaceAll('%%', '').match(FORMAT_SPECIFIER) ?? []).map((specifier) => specifier.replace(/^%\d+\$/, '%'));
}
