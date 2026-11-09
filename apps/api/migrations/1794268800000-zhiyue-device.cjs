exports.up = (pgm) => pgm.sql(`
  CREATE TABLE wb_zhiyue_device_requests (
    device_hash text PRIMARY KEY,
    user_hash text NOT NULL UNIQUE,
    account_id uuid REFERENCES ac_accounts(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    next_poll_at timestamptz
  );
  CREATE INDEX wb_zhiyue_device_requests_expiry ON wb_zhiyue_device_requests(expires_at);

  CREATE TABLE wb_zhiyue_bindings (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES ac_accounts(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > created_at)
  );
  CREATE INDEX wb_zhiyue_bindings_owner ON wb_zhiyue_bindings(account_id,expires_at);
  CREATE INDEX wb_zhiyue_bindings_expiry ON wb_zhiyue_bindings(expires_at);

  CREATE TABLE wb_zhiyue_media_tickets (
    token_hash text PRIMARY KEY,
    binding_id uuid NOT NULL REFERENCES wb_zhiyue_bindings(id) ON DELETE CASCADE,
    release_id uuid NOT NULL,
    expires_at timestamptz NOT NULL
  );
  CREATE INDEX wb_zhiyue_media_tickets_binding ON wb_zhiyue_media_tickets(binding_id,expires_at);
  CREATE INDEX wb_zhiyue_media_tickets_expiry ON wb_zhiyue_media_tickets(expires_at);
`);

exports.down = (pgm) => pgm.sql(`
  DROP TABLE wb_zhiyue_media_tickets;
  DROP TABLE wb_zhiyue_bindings;
  DROP TABLE wb_zhiyue_device_requests;
`);
