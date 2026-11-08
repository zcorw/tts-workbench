exports.up = (pgm) => pgm.sql(`
  CREATE TABLE wb_cms_mcp_batches (
    account_id uuid NOT NULL REFERENCES ac_accounts(id) ON DELETE CASCADE,
    batch_id text NOT NULL CHECK (length(batch_id) BETWEEN 1 AND 100),
    input_hash text NOT NULL,
    item_ids jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(account_id,batch_id)
  );
  -- Receipts intentionally survive article deletion: retry must never recreate
  -- a deleted draft. They contain hashes and minimal results, never body text.
  CREATE TABLE wb_cms_mcp_items (
    account_id uuid NOT NULL REFERENCES ac_accounts(id) ON DELETE CASCADE,
    request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 100),
    input_hash text NOT NULL,
    result jsonb NOT NULL,
    PRIMARY KEY(account_id,request_id)
  );
  CREATE TABLE wb_cms_mcp_grants (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES ac_accounts(id) ON DELETE CASCADE,
    client_id text NOT NULL,
    resource text NOT NULL,
    redirect_uri text NOT NULL,
    scopes text[] NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
  );
  CREATE INDEX wb_cms_mcp_grants_owner ON wb_cms_mcp_grants(account_id);
  CREATE TABLE wb_cms_mcp_tokens (
    token_hash text PRIMARY KEY,
    grant_id uuid NOT NULL REFERENCES wb_cms_mcp_grants(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('code','access','refresh')),
    challenge text,
    expires_at timestamptz NOT NULL,
    used_at timestamptz
  );
  CREATE INDEX wb_cms_mcp_tokens_grant ON wb_cms_mcp_tokens(grant_id);
`);
exports.down = (pgm) => pgm.sql(`
  DROP TABLE wb_cms_mcp_tokens;
  DROP TABLE wb_cms_mcp_grants;
  DROP TABLE wb_cms_mcp_items;
  DROP TABLE wb_cms_mcp_batches;
`);
