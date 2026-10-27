-- Moves the fact blobs out of `files`. SQLite reads a row's overflow pages to
-- reach columns stored after a large blob, so every scan of `files` (hash,
-- mtime and size checks on each build) used to read all facts from disk. For
-- the same reason the small `declarations` summary comes before `facts`.

CREATE TABLE file_facts (
  file_id      INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  declarations BLOB,
  facts        BLOB NOT NULL
);

INSERT INTO file_facts (file_id, declarations, facts)
SELECT id, declarations, facts FROM files WHERE facts IS NOT NULL;

ALTER TABLE files DROP COLUMN facts;
ALTER TABLE files DROP COLUMN declarations;
