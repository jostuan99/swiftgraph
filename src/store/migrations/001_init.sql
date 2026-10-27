-- Initial schema. See docs/01-design.md (section 7.1) and
-- docs/03-localization.md (sections 3 and 6).

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE modules (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('target', 'external'))
);

CREATE TABLE files (
  id        INTEGER PRIMARY KEY,
  path      TEXT NOT NULL UNIQUE,
  kind      TEXT NOT NULL CHECK (kind IN ('swift', 'strings', 'stringsdict', 'xcstrings')),
  language  TEXT,
  module_id INTEGER REFERENCES modules(id),
  hash      TEXT NOT NULL,
  facts     BLOB,
  has_errors INTEGER NOT NULL DEFAULT 0,
  parsed_at INTEGER NOT NULL
);

CREATE TABLE nodes (
  id             INTEGER PRIMARY KEY,
  symbol_id      TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL,
  name           TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  signature      TEXT,
  access         TEXT,
  modifiers      TEXT,
  file_id        INTEGER REFERENCES files(id) ON DELETE CASCADE,
  start_line INTEGER, start_col INTEGER, end_line INTEGER, end_col INTEGER,
  doc            TEXT,
  conditions     TEXT,
  community      INTEGER,
  fan_in INTEGER, fan_out INTEGER, pagerank REAL
);

CREATE TABLE edges (
  id         INTEGER PRIMARY KEY,
  source_id  INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id  INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('EXTRACTED', 'INFERRED', 'AMBIGUOUS')),
  weight     REAL NOT NULL DEFAULT 1.0,
  count      INTEGER NOT NULL DEFAULT 1,
  -- JSON array of [file_id, line] pairs (at most 20).
  evidence   TEXT,
  UNIQUE (source_id, target_id, kind)
);

CREATE TABLE communities (
  id    INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  size  INTEGER NOT NULL
);

CREATE VIRTUAL TABLE symbol_fts USING fts5(
  name, qualified_name, doc, content='nodes', content_rowid='id'
);

CREATE INDEX edges_source ON edges(source_id, kind);
CREATE INDEX edges_target ON edges(target_id, kind);
CREATE INDEX nodes_file   ON nodes(file_id);

-- Localization.

CREATE TABLE localization_tables (
  node_id         INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  module_id       INTEGER REFERENCES modules(id),
  name            TEXT NOT NULL,
  source_language TEXT,
  UNIQUE (module_id, name)
);

CREATE TABLE localized_strings (
  node_id          INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  table_id         INTEGER NOT NULL REFERENCES localization_tables(node_id) ON DELETE CASCADE,
  key              TEXT NOT NULL,
  comment          TEXT,
  extraction_state TEXT,
  should_translate INTEGER NOT NULL DEFAULT 1,
  UNIQUE (table_id, key)
);

CREATE TABLE translations (
  id             INTEGER PRIMARY KEY,
  string_id      INTEGER NOT NULL REFERENCES localized_strings(node_id) ON DELETE CASCADE,
  language       TEXT NOT NULL,
  variation_path TEXT NOT NULL DEFAULT '',
  value          TEXT,
  value_hash     TEXT NOT NULL,
  state          TEXT,
  format_args    TEXT,
  file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line           INTEGER,
  UNIQUE (string_id, language, variation_path, file_id)
);

CREATE VIRTUAL TABLE string_fts USING fts5(key, comment, value);

CREATE INDEX translations_string ON translations(string_id, language);

CREATE TABLE localization_issues (
  id        INTEGER PRIMARY KEY,
  kind      TEXT NOT NULL,
  string_id INTEGER REFERENCES localized_strings(node_id) ON DELETE CASCADE,
  node_id   INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  language  TEXT,
  file_id   INTEGER REFERENCES files(id) ON DELETE CASCADE,
  line      INTEGER,
  detail    TEXT
);
