import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { VocabularyService } from "../dist/vocabulary.js";
import { migrate } from "../dist/migrate.js";
const url = process.env.TEST_DATABASE_URL;
test(
  "Real PostgreSQL personal rules: normalization, uniqueness, revision race, snapshot and delete",
  { skip: !url },
  async () => {
    await migrate(url);
    const pool = new Pool({ connectionString: url });
    const a = randomUUID(),
      b = randomUUID();
    const service = new VocabularyService(pool);
    try {
      for (const id of [a, b])
        await pool.query(
          "INSERT INTO ac_accounts(id,login,display_name,password_hash,status) VALUES($1::uuid,$1::text,'test','test','active')",
          [id],
        );
      const saved = await service.create(a, {
        text: "日本",
        reading: "にほん",
      });
      assert.equal(saved.internalVersion, 1);
      await assert.rejects(
        service.create(a, { text: "日本", reading: "にっぽん" }),
        { status: 409 },
      );
      await assert.rejects(service.get(b, saved.entry.id), { status: 404 });
      const results = await Promise.allSettled(
        ["にっぽん", "にほん"].map((reading) =>
          service.update(a, saved.entry.id, {
            text: "日本",
            reading,
            expectedRevision: 1,
          }),
        ),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        results.find((r) => r.status === "rejected").reason.code,
        "REVISION_CONFLICT",
      );
      const snapshot = await service.list(a, { limit: 500 });
      assert.equal(snapshot.internalVersion, 2);
      assert.equal(snapshot.total, 1);
      assert.equal((await service.list(b, { limit: 500 })).total, 0);
      await assert.rejects(service.remove(a, saved.entry.id, 1), {
        status: 409,
      });
      assert.equal(
        (await service.remove(a, saved.entry.id, 2)).internalVersion,
        3,
      );
      assert.equal((await service.list(a, { limit: 500 })).total, 0);
      const normalized = await service.create(a, {
        text: "か\u3099",
        reading: "が",
      });
      assert.equal(normalized.entry.text, "が");
      await assert.rejects(service.create(a, { text: " ", reading: "x" }));
    } finally {
      await pool.query("DELETE FROM ac_accounts WHERE id=ANY($1::uuid[])", [
        [a, b],
      ]);
      await pool.end();
    }
  },
);
