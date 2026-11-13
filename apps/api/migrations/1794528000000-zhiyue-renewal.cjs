exports.up = (pgm) => pgm.sql(`
  ALTER TABLE wb_zhiyue_bindings
    ADD COLUMN refresh_hash text UNIQUE,
    ADD COLUMN upgrade_token_hash text UNIQUE,
    ADD COLUMN upgrade_nonce text,
    ADD COLUMN upgrade_until timestamptz,
    ADD COLUMN confirmed_at timestamptz,
    ADD COLUMN confirm_by timestamptz;
  -- Existing grants were already paired by the old protocol; do not expire them in five minutes.
  UPDATE wb_zhiyue_bindings SET confirmed_at=created_at;
  ALTER TABLE wb_zhiyue_bindings ADD CONSTRAINT zhiyue_confirmation_state CHECK (
    (confirmed_at IS NOT NULL AND confirm_by IS NULL) OR
    (confirmed_at IS NULL AND confirm_by IS NOT NULL AND confirm_by>created_at)
  );
  CREATE INDEX wb_zhiyue_pending_confirmation ON wb_zhiyue_bindings(confirm_by)
    WHERE confirmed_at IS NULL;
  -- Keep the consumed request as a short-lived tombstone/retry link. Deliberately no
  -- cascading foreign key: a revoked binding must never turn back into an unclaimed request.
  ALTER TABLE wb_zhiyue_device_requests ADD COLUMN binding_id uuid, ADD COLUMN claim_nonce text;
  CREATE FUNCTION revoke_zhiyue_after_password_change() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.status <> 'active' THEN
      DELETE FROM wb_zhiyue_bindings WHERE account_id=NEW.id;
      DELETE FROM wb_zhiyue_device_requests WHERE account_id=NEW.id;
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER zhiyue_password_change AFTER UPDATE ON ac_accounts
    FOR EACH ROW EXECUTE FUNCTION revoke_zhiyue_after_password_change();
`);
exports.down = (pgm) => pgm.sql(`
  DROP TRIGGER zhiyue_password_change ON ac_accounts;
  DROP FUNCTION revoke_zhiyue_after_password_change();
  -- Unconfirmed grants must never become authorized legacy grants on rollback.
  DELETE FROM wb_zhiyue_bindings WHERE confirmed_at IS NULL;
  DELETE FROM wb_zhiyue_device_requests WHERE binding_id IS NOT NULL;
  ALTER TABLE wb_zhiyue_device_requests DROP COLUMN binding_id, DROP COLUMN claim_nonce;
  ALTER TABLE wb_zhiyue_bindings DROP CONSTRAINT zhiyue_confirmation_state,
    DROP COLUMN upgrade_token_hash, DROP COLUMN upgrade_nonce, DROP COLUMN upgrade_until, DROP COLUMN refresh_hash,
    DROP COLUMN confirm_by, DROP COLUMN confirmed_at;
`);
