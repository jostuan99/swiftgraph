-- Incremental builds (docs/01-design.md, section 9).
--
-- mtime_ms/size skip unchanged files without reading them. `declarations`
-- holds the imports and declarations of a Swift file (MessagePack) so the
-- symbol tables can be rebuilt without decoding every reference;
-- `declaration_digest` changes only when a change can affect other files.

ALTER TABLE files ADD COLUMN mtime_ms REAL;
ALTER TABLE files ADD COLUMN size INTEGER;
ALTER TABLE files ADD COLUMN declarations BLOB;
ALTER TABLE files ADD COLUMN declaration_digest TEXT;
