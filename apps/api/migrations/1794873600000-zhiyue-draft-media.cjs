exports.up = (pgm) => pgm.sql(`
  ALTER TABLE wb_zhiyue_media_tickets ADD COLUMN draft_article_id uuid REFERENCES wb_articles(id) ON DELETE CASCADE;
`);
exports.down = (pgm) => pgm.sql(`
  DELETE FROM wb_zhiyue_media_tickets WHERE draft_article_id IS NOT NULL;
  ALTER TABLE wb_zhiyue_media_tickets DROP COLUMN draft_article_id;
`);
