exports.up = (pgm) =>
  pgm.sql(`
  CREATE TABLE wb_cms_taxonomy (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES ac_accounts(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('category','tag')),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    slug text NOT NULL CHECK (char_length(slug) BETWEEN 1 AND 120),
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    UNIQUE(account_id,kind,slug)
  );
  CREATE INDEX wb_cms_taxonomy_owner ON wb_cms_taxonomy(account_id,kind);
  CREATE TABLE wb_cms_articles (
    article_id uuid PRIMARY KEY REFERENCES wb_articles(id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES ac_accounts(id) ON DELETE CASCADE,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    slug text NOT NULL CHECK (char_length(slug) BETWEEN 1 AND 120),
    summary text NOT NULL DEFAULT '',
    category_id uuid REFERENCES wb_cms_taxonomy(id) DEFERRABLE INITIALLY DEFERRED,
    published_release_id uuid,
    UNIQUE(account_id,slug)
  );
  CREATE INDEX wb_cms_articles_owner_category ON wb_cms_articles(account_id,category_id);
  CREATE TABLE wb_cms_article_tags (
    article_id uuid NOT NULL REFERENCES wb_cms_articles(article_id) ON DELETE CASCADE,
    taxonomy_id uuid NOT NULL REFERENCES wb_cms_taxonomy(id) DEFERRABLE INITIALLY DEFERRED,
    PRIMARY KEY(article_id,taxonomy_id)
  );
  CREATE INDEX wb_cms_tags_taxonomy ON wb_cms_article_tags(taxonomy_id);
  CREATE TABLE wb_cms_import_sources (
    account_id uuid NOT NULL REFERENCES ac_accounts(id) ON DELETE CASCADE,
    source text NOT NULL,
    external_id text NOT NULL,
    article_id uuid NOT NULL UNIQUE REFERENCES wb_articles(id) ON DELETE CASCADE,
    PRIMARY KEY(account_id,source,external_id)
  );
  CREATE TABLE wb_cms_media (
    audio_id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES ac_accounts(id) ON DELETE CASCADE,
    metadata jsonb NOT NULL,
    data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 8388608),
    CHECK ((metadata->>'byteLength')::integer=octet_length(data))
  );
  CREATE TABLE wb_cms_releases (
    id uuid PRIMARY KEY,
    article_id uuid NOT NULL REFERENCES wb_articles(id) DEFERRABLE INITIALLY DEFERRED,
    account_id uuid NOT NULL REFERENCES ac_accounts(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    audio_id uuid REFERENCES wb_cms_media(audio_id) DEFERRABLE INITIALLY DEFERRED,
    snapshot jsonb NOT NULL
  );
  CREATE INDEX wb_cms_releases_owner_article ON wb_cms_releases(account_id,article_id,created_at DESC);
  ALTER TABLE wb_cms_articles ADD CONSTRAINT wb_cms_current_release
    FOREIGN KEY(published_release_id) REFERENCES wb_cms_releases(id) DEFERRABLE INITIALLY DEFERRED;
  CREATE TABLE wb_cms_read_tokens (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES ac_accounts(id) ON DELETE CASCADE,
    label text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    category_ids uuid[] NOT NULL DEFAULT '{}',
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX wb_cms_read_tokens_owner ON wb_cms_read_tokens(account_id,created_at DESC);
`);
exports.down = (pgm) =>
  pgm.sql(`
  DROP TABLE wb_cms_read_tokens;
  ALTER TABLE wb_cms_articles DROP CONSTRAINT wb_cms_current_release;
  DROP TABLE wb_cms_releases;
  DROP TABLE wb_cms_media;
  DROP TABLE wb_cms_import_sources;
  DROP TABLE wb_cms_article_tags;
  DROP TABLE wb_cms_articles;
  DROP TABLE wb_cms_taxonomy;
`);
