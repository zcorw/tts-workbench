exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE wb_articles (
      id uuid PRIMARY KEY,
      account_id uuid NOT NULL REFERENCES ac_accounts(id) ON DELETE CASCADE,
      title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
      text text NOT NULL CHECK (char_length(text) <= 10000 AND octet_length(text) <= 49152),
      revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
      content_revision integer NOT NULL DEFAULT 1 CHECK (content_revision >= 1),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX wb_articles_owner_updated ON wb_articles(account_id, updated_at DESC, id DESC);
  `);
};
exports.down = (pgm) => pgm.dropTable("wb_articles");
