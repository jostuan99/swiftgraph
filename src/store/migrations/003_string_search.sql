-- Search over localization keys, comments and translated values, with the
-- string and language each row belongs to (docs/03-localization.md).
DROP TABLE string_fts;
CREATE VIRTUAL TABLE string_fts USING fts5(
  key, comment, value,
  string_id UNINDEXED, language UNINDEXED
);
CREATE INDEX localization_issues_node ON localization_issues(node_id);
