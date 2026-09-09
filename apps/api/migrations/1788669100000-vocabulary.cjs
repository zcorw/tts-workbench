exports.up = (pgm) => {
  pgm.createTable("wb_rule_sets", {
    account_id: {
      type: "uuid",
      primaryKey: true,
      references: "ac_accounts(id)",
      onDelete: "CASCADE",
    },
    version: { type: "integer", notNull: true, default: 0 },
  });
  pgm.createTable("wb_vocabulary", {
    id: { type: "uuid", primaryKey: true },
    account_id: {
      type: "uuid",
      notNull: true,
      references: "wb_rule_sets(account_id)",
      onDelete: "CASCADE",
    },
    text: { type: "text", notNull: true },
    reading: { type: "text", notNull: true },
    revision: { type: "integer", notNull: true, default: 1 },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
  pgm.addConstraint("wb_vocabulary", "wb_vocabulary_owner_text_unique", {
    unique: ["account_id", "text"],
  });
  pgm.createIndex("wb_vocabulary", ["account_id", "created_at", "id"]);
};
exports.down = (pgm) => {
  pgm.dropTable("wb_vocabulary");
  pgm.dropTable("wb_rule_sets");
};
