exports.up = (pgm) =>
  pgm.sql(`
  CREATE TABLE wb_audio_batches (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES ac_accounts(id) ON DELETE CASCADE,
    request_id uuid NOT NULL,
    request_hash text NOT NULL CHECK (length(request_hash)=64),
    status text NOT NULL CHECK (status IN ('queued','running','completed')),
    items jsonb NOT NULL CHECK (jsonb_typeof(items)='array' AND jsonb_array_length(items)<=20),
    archived boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(account_id,request_id),
    CHECK (archived OR jsonb_array_length(items)>0),
    CHECK (NOT archived OR (status='completed' AND jsonb_array_length(items)=0))
  );
  CREATE UNIQUE INDEX wb_audio_batches_one_active ON wb_audio_batches(account_id)
    WHERE status IN ('queued','running');
  CREATE INDEX wb_audio_batches_owner_history ON wb_audio_batches(account_id,created_at DESC)
    WHERE NOT archived;
  CREATE TABLE wb_tts_admission (
    account_id uuid PRIMARY KEY REFERENCES ac_accounts(id) ON DELETE CASCADE,
    window_started_at timestamptz NOT NULL,
    used integer NOT NULL CHECK (used BETWEEN 1 AND 10)
  );
`);
exports.down = (pgm) =>
  pgm.sql(`DROP TABLE wb_tts_admission; DROP TABLE wb_audio_batches;`);
