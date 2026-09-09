import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import type { SpeechService } from "./speech.js";
import { ApiError } from "./errors.js";

const validUnicode = (s: string) =>
  Buffer.from(s, "utf8").toString("utf8") === s;
const title = z
  .string()
  .trim()
  .refine(
    (s) =>
      [...s].length >= 1 &&
      [...s].length <= 120 &&
      validUnicode(s) &&
      !s.includes("\0"),
  );
const text = z
  .string()
  .refine(
    (s) =>
      [...s].length <= 10000 &&
      Buffer.byteLength(s, "utf8") <= 49152 &&
      validUnicode(s) &&
      !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(s),
  );
const inputSchema = z.strictObject({ title, text });
const patchSchema = inputSchema.extend({
  expectedRevision: z.number().int().min(1),
});
const columns = `a.id,a.title,a.revision,a.content_revision AS "contentRevision",
  a.created_at AS "createdAt",a.updated_at AS "updatedAt",
  COALESCE(r.version,0) AS "currentRuleVersion", au.metadata AS audio`;
const join =
  "FROM wb_articles a LEFT JOIN wb_rule_sets r ON r.account_id=a.account_id LEFT JOIN wb_article_audio au ON au.article_id=a.id";
const projection = (row: Record<string, unknown>): Record<string, unknown> => ({
  ...row,
  audio: row.audio ?? null,
  audioStale:
    !!row.audio &&
    ((row.audio as { contentRevision: number }).contentRevision !==
      row.contentRevision ||
      (row.audio as { ruleVersion: number }).ruleVersion !==
        row.currentRuleVersion),
});

export class ArticleService {
  constructor(
    private pool: Pool,
    readonly maxArticles = 100,
  ) {}

  async list(owner: string, query: unknown = {}) {
    const q = z
      .strictObject({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).default(0),
        q: z
          .string()
          .trim()
          .refine(
            (s) => [...s].length <= 120 && validUnicode(s) && !s.includes("\0"),
          )
          .default(""),
      })
      .parse(query);
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const where = "a.account_id=$1 AND strpos(lower(a.title),lower($2))>0";
      const total = Number(
        (
          await c.query(`SELECT count(*) FROM wb_articles a WHERE ${where}`, [
            owner,
            q.q,
          ])
        ).rows[0].count,
      );
      const items = (
        await c.query(
          `SELECT ${columns} ${join} WHERE ${where} ORDER BY a.updated_at DESC,a.id DESC LIMIT $3 OFFSET $4`,
          [owner, q.q, q.limit, q.offset],
        )
      ).rows.map(projection);
      await c.query("COMMIT");
      return { items, total, offset: q.offset, limit: q.limit };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }

  private async detail(
    c: Pick<PoolClient, "query">,
    owner: string,
    id: string,
  ) {
    const row = (
      await c.query(
        `SELECT ${columns},a.text ${join} WHERE a.account_id=$1 AND a.id=$2`,
        [owner, id],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND");
    return projection(row);
  }

  async get(owner: string, id: string) {
    z.uuid().parse(id);
    return this.detail(this.pool, owner, id);
  }

  private async mutate<T>(
    owner: string,
    action: (c: PoolClient) => Promise<T>,
  ) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      // All article writes for this account share a lock. Concurrent creates
      // cannot both consume the final slot; deletes release it at commit.
      const account = (
        await c.query("SELECT status FROM ac_accounts WHERE id=$1 FOR UPDATE", [
          owner,
        ])
      ).rows[0];
      if (!account || account.status !== "active")
        throw new ApiError(401, "UNAUTHENTICATED");
      const result = await action(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }

  async create(owner: string, input: unknown) {
    const value = inputSchema.parse(input);
    return this.mutate(owner, async (c) => {
      const count = Number(
        (
          await c.query(
            "SELECT count(*) FROM wb_articles WHERE account_id=$1",
            [owner],
          )
        ).rows[0].count,
      );
      if (count >= this.maxArticles) throw new ApiError(409, "ARTICLE_LIMIT");
      const id = randomUUID();
      await c.query(
        "INSERT INTO wb_articles(id,account_id,title,text) VALUES($1,$2,$3,$4)",
        [id, owner, value.title, value.text],
      );
      return this.detail(c, owner, id);
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
        "SELECT revision FROM wb_articles WHERE account_id=$1 AND id=$2 FOR UPDATE",
        [owner, id],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND");
    if (row.revision !== expected) throw new ApiError(409, "REVISION_CONFLICT");
  }

  async update(owner: string, id: string, input: unknown) {
    z.uuid().parse(id);
    const value = patchSchema.parse(input);
    return this.mutate(owner, async (c) => {
      await this.check(c, owner, id, value.expectedRevision);
      await c.query(
        `UPDATE wb_articles SET title=$3,text=$4,revision=revision+1,
        content_revision=content_revision+CASE WHEN text IS DISTINCT FROM $4 THEN 1 ELSE 0 END,
        updated_at=clock_timestamp() WHERE account_id=$1 AND id=$2 AND (title IS DISTINCT FROM $3 OR text IS DISTINCT FROM $4)`,
        [owner, id, value.title, value.text],
      );
      return this.detail(c, owner, id);
    });
  }

  async generate(
    owner: string,
    id: string,
    input: unknown,
    speech: SpeechService,
    signal: AbortSignal,
    requestId: string,
  ) {
    z.uuid().parse(id);
    const dto = z
      .strictObject({
        expectedRevision: z.number().int().min(1),
        voice: z.string().min(1),
        speed: z
          .number()
          .min(0.5)
          .max(2)
          .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8)
          .default(1),
      })
      .parse(input);
    const active = () => {
      if (signal.aborted) throw new ApiError(400, "INVALID_REQUEST");
    };
    const saved = await this.mutate(owner, async (c) => {
      active();
      await this.check(c, owner, id, dto.expectedRevision);
      const row = (
        await c.query(
          "SELECT text,content_revision FROM wb_articles WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!row.text.trim()) throw new ApiError(400, "INVALID_REQUEST");
      const seq = (
        await c.query(
          "UPDATE wb_articles SET generation_seq=generation_seq+1 WHERE id=$1 RETURNING generation_seq",
          [id],
        )
      ).rows[0].generation_seq;
      return { ...row, seq };
    });
    active();
    const result = await speech.synthesize(
      owner,
      { input: saved.text, voice: dto.voice, speed: dto.speed },
      false,
      signal,
      requestId,
    );
    active();
    return this.mutate(owner, async (c) => {
      // The account lock may have waited after synthesis. Never commit canceled work.
      active();
      const row = (
        await c.query(
          "SELECT content_revision FROM wb_articles WHERE account_id=$1 AND id=$2 FOR UPDATE",
          [owner, id],
        )
      ).rows[0];
      active();
      if (!row) throw new ApiError(404, "NOT_FOUND");
      if (row.content_revision !== saved.content_revision)
        throw new ApiError(409, "ARTICLE_CONTENT_CHANGED");
      const previous = (
        await c.query(
          "SELECT generation_seq FROM wb_article_audio WHERE article_id=$1",
          [id],
        )
      ).rows[0];
      if (previous && BigInt(previous.generation_seq) > BigInt(saved.seq))
        throw new ApiError(409, "AUDIO_SUPERSEDED");
      const audioId = randomUUID();
      const metadata = {
        audioId,
        contentRevision: saved.content_revision,
        ruleVersion: result.internalVersion,
        voice: dto.voice,
        speed: dto.speed,
        language: "ja-JP",
        format: "mp3",
        mimeType: "audio/mpeg",
        byteLength: result.audio.length,
        characterCount: [...saved.text].length,
        filename: `article-${id}.mp3`,
        createdAt: new Date().toISOString(),
      };
      await c.query(
        `INSERT INTO wb_article_audio(article_id,generation_seq,metadata,data) VALUES($1,$2,$3,$4)
        ON CONFLICT(article_id) DO UPDATE SET generation_seq=EXCLUDED.generation_seq,metadata=EXCLUDED.metadata,data=EXCLUDED.data`,
        [id, saved.seq, metadata, result.audio],
      );
      const detail = await this.detail(c, owner, id);
      active();
      return {
        articleId: id,
        revision: detail.revision,
        contentRevision: detail.contentRevision,
        currentRuleVersion: detail.currentRuleVersion,
        audio: detail.audio,
        audioStale: detail.audioStale,
      };
    });
  }

  async audio(owner: string, id: string, query: unknown) {
    z.uuid().parse(id);
    const { audioId } = z.strictObject({ audioId: z.uuid() }).parse(query);
    const row = (
      await this.pool.query(
        `SELECT au.metadata,au.data FROM wb_articles a
      JOIN wb_article_audio au ON au.article_id=a.id WHERE a.account_id=$1 AND a.id=$2 AND au.metadata->>'audioId'=$3`,
        [owner, id, audioId],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND");
    return row;
  }

  async remove(owner: string, id: string, expectedRevision: unknown) {
    z.uuid().parse(id);
    const expected = z.coerce.number().int().min(1).parse(expectedRevision);
    return this.mutate(owner, async (c) => {
      await this.check(c, owner, id, expected);
      await c.query("DELETE FROM wb_articles WHERE account_id=$1 AND id=$2", [
        owner,
        id,
      ]);
    });
  }
}
