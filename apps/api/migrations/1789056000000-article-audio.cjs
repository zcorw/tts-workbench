exports.up = (pgm) =>
  pgm.sql(`
  ALTER TABLE wb_articles ADD COLUMN generation_seq bigint NOT NULL DEFAULT 0 CHECK (generation_seq >= 0);
  CREATE TABLE wb_article_audio (
    article_id uuid PRIMARY KEY REFERENCES wb_articles(id) ON DELETE CASCADE,
    generation_seq bigint NOT NULL CHECK (generation_seq > 0),
    metadata jsonb NOT NULL,
    data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 8388608),
    CHECK ((metadata->>'byteLength')::integer = octet_length(data))
  );
`);
exports.down = (pgm) =>
  pgm.sql(
    `DROP TABLE wb_article_audio; ALTER TABLE wb_articles DROP COLUMN generation_seq;`,
  );
