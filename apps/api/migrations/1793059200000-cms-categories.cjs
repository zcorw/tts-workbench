exports.up = (pgm) =>
  pgm.sql(`
  ALTER TABLE wb_cms_taxonomy
    ADD COLUMN parent_id uuid,
    ADD COLUMN sort_order integer NOT NULL DEFAULT 0,
    ADD CONSTRAINT wb_cms_taxonomy_id_owner UNIQUE(id,account_id),
    ADD CONSTRAINT wb_cms_category_sort_nonnegative CHECK(sort_order >= 0),
    ADD CONSTRAINT wb_cms_category_not_self CHECK(parent_id IS NULL OR parent_id <> id),
    ADD CONSTRAINT wb_cms_tag_no_tree CHECK(kind='category' OR (parent_id IS NULL AND sort_order=0)),
    ADD CONSTRAINT wb_cms_category_parent_owner FOREIGN KEY(parent_id,account_id)
      REFERENCES wb_cms_taxonomy(id,account_id) DEFERRABLE INITIALLY DEFERRED;
  CREATE INDEX wb_cms_category_tree ON wb_cms_taxonomy(account_id,parent_id,sort_order,id) WHERE kind='category';
`);
exports.down = (pgm) =>
  pgm.sql(`
  DROP INDEX wb_cms_category_tree;
  ALTER TABLE wb_cms_taxonomy
    DROP CONSTRAINT wb_cms_category_parent_owner,
    DROP CONSTRAINT wb_cms_tag_no_tree,
    DROP CONSTRAINT wb_cms_category_not_self,
    DROP CONSTRAINT wb_cms_category_sort_nonnegative,
    DROP CONSTRAINT wb_cms_taxonomy_id_owner,
    DROP COLUMN sort_order,
    DROP COLUMN parent_id;
`);
