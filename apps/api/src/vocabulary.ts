import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { ApiError } from "./errors.js";
export const term = z
  .string()
  .normalize("NFC")
  .refine(
    (s) =>
      s.trim().length > 0 &&
      [...s].length <= 100 &&
      !/[<>\u0000-\u001f\u007f-\u009f]/u.test(s),
    "Invalid reading term",
  );
const inputSchema = z.strictObject({ text: term, reading: term });
const patchSchema = inputSchema.extend({
  expectedRevision: z.number().int().min(1),
});
export interface Entry {
  id: string;
  text: string;
  reading: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
const columns =
  'id,text,reading,revision,created_at AS "createdAt",updated_at AS "updatedAt"';
export class VocabularyService {
  constructor(private pool: Pool) {}
  private async ensure(accountId: string) {
    await this.pool.query(
      "INSERT INTO wb_rule_sets(account_id) VALUES($1) ON CONFLICT DO NOTHING",
      [accountId],
    );
  }
  async list(accountId: string, query: unknown = {}) {
    const q = z
      .strictObject({
        limit: z.coerce.number().int().min(1).max(500).default(50),
        offset: z.coerce.number().int().min(0).default(0),
        q: z.string().max(100).normalize("NFC").default(""),
      })
      .parse(query);
    await this.ensure(accountId);
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const version = (
        await c.query("SELECT version FROM wb_rule_sets WHERE account_id=$1", [
          accountId,
        ])
      ).rows[0].version;
      const where =
        "account_id=$1 AND (strpos(text,$2)>0 OR strpos(reading,$2)>0)";
      const total = Number(
        (
          await c.query(`SELECT count(*) FROM wb_vocabulary WHERE ${where}`, [
            accountId,
            q.q,
          ])
        ).rows[0].count,
      );
      const items = (
        await c.query(
          `SELECT ${columns} FROM wb_vocabulary WHERE ${where} ORDER BY created_at,id LIMIT $3 OFFSET $4`,
          [accountId, q.q, q.limit, q.offset],
        )
      ).rows as Entry[];
      await c.query("COMMIT");
      return {
        items,
        total,
        limit: q.limit,
        offset: q.offset,
        internalVersion: version as number,
      };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async get(accountId: string, id: string) {
    z.uuid().parse(id);
    const all = await this.list(accountId, { limit: 500 });
    const entry = all.items.find((e) => e.id === id);
    if (!entry) throw new ApiError(404, "NOT_FOUND");
    return { entry, internalVersion: all.internalVersion };
  }
  private async mutate<T>(
    accountId: string,
    fn: (c: PoolClient) => Promise<T>,
  ) {
    await this.ensure(accountId);
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "SELECT version FROM wb_rule_sets WHERE account_id=$1 FOR UPDATE",
        [accountId],
      );
      const entry = await fn(c);
      const internalVersion = (
        await c.query(
          "UPDATE wb_rule_sets SET version=version+1 WHERE account_id=$1 RETURNING version",
          [accountId],
        )
      ).rows[0].version as number;
      await c.query("COMMIT");
      return { entry, internalVersion };
    } catch (e) {
      await c.query("ROLLBACK");
      if ((e as any)?.code === "23505")
        throw new ApiError(409, "ALREADY_EXISTS");
      throw e;
    } finally {
      c.release();
    }
  }
  async create(accountId: string, input: unknown) {
    const value = inputSchema.parse(input);
    return this.mutate(accountId, async (c) => {
      if (
        Number(
          (
            await c.query(
              "SELECT count(*) FROM wb_vocabulary WHERE account_id=$1",
              [accountId],
            )
          ).rows[0].count,
        ) >= 500
      )
        throw new ApiError(409, "VOCABULARY_LIMIT");
      return (
        await c.query(
          `INSERT INTO wb_vocabulary(id,account_id,text,reading) VALUES($1,$2,$3,$4) RETURNING ${columns}`,
          [randomUUID(), accountId, value.text, value.reading],
        )
      ).rows[0] as Entry;
    });
  }
  async update(accountId: string, id: string, input: unknown) {
    z.uuid().parse(id);
    const value = patchSchema.parse(input);
    return this.mutate(accountId, async (c) => {
      await this.check(c, accountId, id, value.expectedRevision);
      return (
        await c.query(
          `UPDATE wb_vocabulary SET text=$3,reading=$4,revision=revision+1,updated_at=now() WHERE account_id=$1 AND id=$2 RETURNING ${columns}`,
          [accountId, id, value.text, value.reading],
        )
      ).rows[0] as Entry;
    });
  }
  async remove(accountId: string, id: string, revision: unknown) {
    z.uuid().parse(id);
    const expected = z.coerce.number().int().min(1).parse(revision);
    return this.mutate(accountId, async (c) => {
      await this.check(c, accountId, id, expected);
      await c.query("DELETE FROM wb_vocabulary WHERE account_id=$1 AND id=$2", [
        accountId,
        id,
      ]);
      return undefined;
    });
  }
  private async check(
    c: PoolClient,
    owner: string,
    id: string,
    expected: number,
  ) {
    const row = (
      await c.query(
        "SELECT revision FROM wb_vocabulary WHERE account_id=$1 AND id=$2",
        [owner, id],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND");
    if (row.revision !== expected) throw new ApiError(409, "REVISION_CONFLICT");
  }
}
