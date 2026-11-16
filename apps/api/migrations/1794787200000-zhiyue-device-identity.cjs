exports.up = (pgm) => pgm.sql(`
  ALTER TABLE wb_zhiyue_device_requests ADD COLUMN device_id uuid;
  ALTER TABLE wb_zhiyue_bindings ADD COLUMN device_id uuid;
  CREATE UNIQUE INDEX wb_zhiyue_binding_device ON wb_zhiyue_bindings(account_id,device_id)
    WHERE device_id IS NOT NULL;
`);
exports.down = (pgm) => pgm.sql(`
  DROP INDEX wb_zhiyue_binding_device;
  ALTER TABLE wb_zhiyue_bindings DROP COLUMN device_id;
  ALTER TABLE wb_zhiyue_device_requests DROP COLUMN device_id;
`);
