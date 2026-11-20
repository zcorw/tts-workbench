exports.up = (pgm) => pgm.sql(`
  -- Write receipts are committed atomically with taxonomy/article changes.
  -- Store only hashes and minimal IDs/revisions, never content or titles.
  CREATE TABLE wb_cms_mcp_writes (
    account_id uuid NOT NULL REFERENCES ac_accounts(id) ON DELETE CASCADE,
    request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 100),
    operation text NOT NULL CHECK (operation IN ('create_category','update_article')),
    input_hash text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(account_id,request_id)
  );
`);
exports.down = (pgm) => pgm.sql("DROP TABLE wb_cms_mcp_writes;");
