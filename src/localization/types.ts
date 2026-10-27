// Facts of a localization file. See docs/03-localization.md.

export interface LocalizationEntry {
  key: string;
  /** Language of the value; null for a key without any translation. */
  language: string | null;
  /** '' or a variation path: `plural.one`, `device.iphone`, `plural.items.other`. */
  variationPath: string;
  /** Null for keys without text, or when values are not stored (--no-string-values). */
  value: string | null;
  /** sha256 of the value, kept even when the value is not stored. */
  valueHash: string;
  /** Format specifiers of the value (`%@`, `%lld`, `%#@items@`). */
  formatArgs: string[];
  /** xcstrings state: translated, needs_review, new, stale; null for .strings. */
  state: string | null;
  comment: string | null;
  extractionState: string | null;
  shouldTranslate: boolean;
  /** Line of the entry (.strings and .stringsdict); null for .xcstrings. */
  line: number | null;
}

export interface LocalizationWarning {
  kind: 'duplicate_key' | 'parse_error';
  line: number | null;
  detail: string;
}

export interface LocalizationFacts {
  version: number;
  /** Table name: the file name without extension (`Localizable`). */
  table: string;
  /** Source language declared by a String Catalog. */
  sourceLanguage: string | null;
  entries: LocalizationEntry[];
  warnings: LocalizationWarning[];
}

/** Bump when the facts of localization files change shape. */
export const LOCALIZATION_FACTS_VERSION = 1;

export interface LocalizationOptions {
  /** Store keys, comments, states and hashes, but no translated text. */
  noValues?: boolean;
  /** Only keep these languages (all when empty or undefined). */
  languages?: string[];
}
