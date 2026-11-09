import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { GatewayError } from "tts-gateway";
import { ApiError } from "./errors.js";
import type { ArticleService } from "./articles.js";
import type { SpeechService } from "./speech.js";
import type { GenerationAdmission } from "./generation-admission.js";

const itemSchema = z.strictObject({
  articleId: z.uuid(),
  expectedRevision: z.number().int().min(1),
  expectedAudioId: z.uuid().nullable(),
  expectedRuleVersion: z.number().int().min(0),
  voice: z.string().min(1).max(200),
  speed: z
    .number()
    .min(0.5)
    .max(2)
    .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8),
});
const inputSchema = z.strictObject({
  requestId: z.uuid(),
  existingAudio: z.enum(["skip", "replace"]),
  items: z
    .array(itemSchema)
    .min(1)
    .max(20)
    .refine(
      (items) => new Set(items.map((i) => i.articleId)).size === items.length,
    ),
});
export type AudioBatchItem = z.infer<typeof itemSchema> & {
  title: string;
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "skipped"
    | "cancelled"
    | "uncertain";
  errorCode?: string;
  audioId?: string;
};
export interface AudioBatch {
  id: string;
  requestId: string;
  status: "queued" | "running" | "completed";
  createdAt: string;
  updatedAt: string;
  items: AudioBatchItem[];
}
interface Row {
  id: string;
  account_id: string;
  request_id: string;
  request_hash: string;
  status: AudioBatch["status"];
  created_at: Date;
  updated_at: Date;
  archived: boolean;
  items: AudioBatchItem[];
}
const publicBatch = (row: Row): AudioBatch => ({
  id: row.id,
  requestId: row.request_id,
  status: row.status,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  items: row.items,
});
const pending = (item: AudioBatchItem) =>
  item.status === "queued" || item.status === "running";
const knownFailure = (error: unknown): string | undefined => {
  if (error instanceof ApiError) return error.code;
  if (error instanceof z.ZodError) return "INVALID_REQUEST";
  if (error instanceof GatewayError) {
    if (error.category === "PROVIDER_TIMEOUT") return "TTS_TIMEOUT";
    if (
      ["RESOURCE_EXHAUSTED", "PROVIDER_RATE_LIMITED"].includes(error.category)
    )
      return "RATE_LIMITED";
    if (
      ["PROVIDER_UNAVAILABLE", "PROVIDER_AUTH_FAILED"].includes(error.category)
    )
      return "TTS_UNAVAILABLE";
    if (error.category === "CLIENT_FORBIDDEN") return "FORBIDDEN";
    return "TTS_PROVIDER_ERROR";
  }
  // Unknown database/transport failures can follow a charged provider call.
  return undefined;
};

export class AudioBatchService {
  private timer?: ReturnType<typeof setTimeout>;
  private processing?: Promise<void>;
  private leader?: PoolClient;
  private broken = false;
  private stopping = false;
  private controller?: AbortController;
  private readonly pollMs: number;
  private readonly leaderError = () => {
    this.broken = true;
    this.controller?.abort("database connection lost");
  };

  constructor(
    private pool: Pool,
    private articles: ArticleService,
    private speech: SpeechService,
    private admission: GenerationAdmission,
    options: { pollMs?: number } = {},
  ) {
    // Dependency-injected timing is for bounded local tests, never an env switch.
    this.pollMs = Math.max(5, options.pollMs ?? 1000);
  }

  private async archive(c: Pick<PoolClient, "query">, owner: string) {
    // Retain only five complete content records. Old idempotency tombstones keep
    // request IDs/hashes, never article titles, so a late retry cannot charge again.
    await c.query(
      `UPDATE wb_audio_batches SET archived=true,items='[]'::jsonb
       WHERE account_id=$1 AND status='completed' AND NOT archived AND id NOT IN
       (SELECT id FROM wb_audio_batches WHERE account_id=$1 AND status='completed' AND NOT archived
        ORDER BY created_at DESC,id DESC LIMIT 5)`,
      [owner],
    );
  }

  async create(owner: string, input: unknown): Promise<AudioBatch> {
    const dto = inputSchema.parse(input);
    const hash = createHash("sha256").update(JSON.stringify(dto)).digest("hex");
    const result = await this.articles.transaction(owner, async (c) => {
      const previous = (
        await c.query(
          "SELECT * FROM wb_audio_batches WHERE account_id=$1 AND request_id=$2",
          [owner, dto.requestId],
        )
      ).rows[0] as Row | undefined;
      if (previous) {
        if (previous.request_hash !== hash)
          throw new ApiError(409, "AUDIO_BATCH_REQUEST_CONFLICT");
        if (previous.archived) throw new ApiError(409, "AUDIO_BATCH_EXPIRED");
        return publicBatch(previous);
      }
      if (
        (
          await c.query(
            "SELECT 1 FROM wb_audio_batches WHERE account_id=$1 AND status IN ('queued','running')",
            [owner],
          )
        ).rowCount
      )
        throw new ApiError(409, "AUDIO_BATCH_ACTIVE");
      const voices = this.speech.voices(owner).items;
      const items: AudioBatchItem[] = [];
      for (const item of dto.items) {
        const article = await this.articles.detailInTransaction(
          c,
          owner,
          item.articleId,
        );
        if (article.revision !== item.expectedRevision)
          throw new ApiError(409, "REVISION_CONFLICT");
        const audio = article.audio as { audioId: string } | null;
        if ((audio?.audioId ?? null) !== item.expectedAudioId)
          throw new ApiError(409, "AUDIO_CHANGED");
        if (article.currentRuleVersion !== item.expectedRuleVersion)
          throw new ApiError(409, "PRONUNCIATION_CHANGED");
        const skip = !!audio && dto.existingAudio === "skip";
        if (!skip && !voices.some((voice) => voice.id === item.voice))
          throw new ApiError(
            voices.length ? 400 : 503,
            voices.length ? "INVALID_REQUEST" : "TTS_UNAVAILABLE",
          );
        if (!skip && !String(article.text).trim())
          throw new ApiError(400, "INVALID_REQUEST");
        items.push({
          ...item,
          title: String(article.title),
          status: skip ? "skipped" : "queued",
        });
      }
      const row = (
        await c.query(
          `INSERT INTO wb_audio_batches(id,account_id,request_id,request_hash,status,items)
         VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
          [
            randomUUID(),
            owner,
            dto.requestId,
            hash,
            items.some(pending) ? "queued" : "completed",
            JSON.stringify(items),
          ],
        )
      ).rows[0] as Row;
      await this.archive(c, owner);
      return publicBatch(row);
    });
    this.wake();
    return result;
  }

  async list(owner: string) {
    const rows = (
      await this.pool.query(
        `SELECT * FROM wb_audio_batches WHERE account_id=$1 AND NOT archived
       ORDER BY (status<>'completed') DESC,created_at DESC,id DESC LIMIT 5`,
        [owner],
      )
    ).rows as Row[];
    return { items: rows.map(publicBatch) };
  }

  async get(owner: string, id: string): Promise<AudioBatch> {
    z.uuid().parse(id);
    const row = (
      await this.pool.query(
        "SELECT * FROM wb_audio_batches WHERE account_id=$1 AND id=$2 AND NOT archived",
        [owner, id],
      )
    ).rows[0] as Row | undefined;
    if (!row) throw new ApiError(404, "NOT_FOUND");
    return publicBatch(row);
  }

  async cancel(owner: string, id: string, input: unknown): Promise<AudioBatch> {
    z.uuid().parse(id);
    z.strictObject({}).parse(input);
    return this.articles.transaction(owner, async (c) => {
      const row = (
        await c.query(
          "SELECT * FROM wb_audio_batches WHERE account_id=$1 AND id=$2 AND NOT archived FOR UPDATE",
          [owner, id],
        )
      ).rows[0] as Row | undefined;
      if (!row) throw new ApiError(404, "NOT_FOUND");
      const items = row.items.map((item): AudioBatchItem =>
        item.status === "queued"
          ? {
              ...item,
              status: "cancelled",
              errorCode: "CANCELLED_BEFORE_START",
            }
          : item,
      );
      const updated = (
        await c.query(
          "UPDATE wb_audio_batches SET items=$2::jsonb,status=$3,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
          [
            id,
            JSON.stringify(items),
            items.some(pending) ? row.status : "completed",
          ],
        )
      ).rows[0] as Row;
      await this.archive(c, owner);
      return publicBatch(updated);
    });
  }

  start() {
    this.wake();
  }
  wake(delay = 0) {
    if (this.stopping || this.processing) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.processing = this.tick()
        .catch(async () => {
          // Losing storage makes the outcome uncertain. Release leadership so the
          // next leader recovers only still-running items, never replays them.
          await this.releaseLeader();
        })
        .finally(() => {
          this.processing = undefined;
          this.wake(this.pollMs);
        });
    }, delay);
    this.timer.unref();
  }

  private async becomeLeader() {
    if (this.leader && !this.broken) return true;
    await this.releaseLeader();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        "SELECT pg_try_advisory_lock(1789142400,271828) AS acquired",
      );
      if (!result.rows[0].acquired) {
        client.release();
        return false;
      }
      this.leader = client;
      this.broken = false;
      client.on("error", this.leaderError);
      // A previous process can have called a paid provider before it stopped.
      // Its running items need human review, never automatic resubmission.
      await client.query(
        `UPDATE wb_audio_batches b SET
          items=(SELECT jsonb_agg(CASE WHEN i->>'status'='running'
            THEN i||'{"status":"uncertain","errorCode":"WORKER_INTERRUPTED"}'::jsonb ELSE i END ORDER BY n)
            FROM jsonb_array_elements(b.items) WITH ORDINALITY AS t(i,n)),
          status=CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(b.items) i WHERE i->>'status'='queued')
            THEN 'queued' ELSE 'completed' END,
          updated_at=clock_timestamp()
         WHERE b.status IN ('queued','running') AND EXISTS
           (SELECT 1 FROM jsonb_array_elements(b.items) i WHERE i->>'status'='running')`,
      );
      return true;
    } catch (error) {
      if (this.leader === client) await this.releaseLeader();
      else client.release(true);
      throw error;
    }
  }

  private async releaseLeader() {
    const client = this.leader;
    this.leader = undefined;
    if (!client) return;
    client.off("error", this.leaderError);
    try {
      await client.query("SELECT pg_advisory_unlock(1789142400,271828)");
    } catch {
      /* A disconnected session has already released its lock. */
    }
    client.release(true);
    this.broken = false;
  }

  private async setItem(
    c: PoolClient,
    id: string,
    index: number,
    patch: Partial<AudioBatchItem>,
  ) {
    const row = (
      await c.query("SELECT * FROM wb_audio_batches WHERE id=$1 FOR UPDATE", [
        id,
      ])
    ).rows[0] as Row;
    if (!row || row.items[index]?.status !== "running") {
      if (patch.status === "succeeded")
        throw new ApiError(409, "AUDIO_BATCH_STATE_CHANGED");
      return;
    }
    if (
      patch.status === "succeeded" &&
      (this.broken || this.stopping || !this.leader)
    )
      throw new ApiError(503, "WORKER_INTERRUPTED");
    row.items[index] = { ...row.items[index], ...patch };
    await c.query(
      "UPDATE wb_audio_batches SET items=$2::jsonb,status=$3,updated_at=clock_timestamp() WHERE id=$1",
      [
        id,
        JSON.stringify(row.items),
        row.items.some(pending) ? "running" : "completed",
      ],
    );
    if (!row.items.some(pending)) await this.archive(c, row.account_id);
  }

  private async tick() {
    if (this.stopping || !(await this.becomeLeader())) return;
    const row = (
      await this.pool.query(
        `SELECT * FROM wb_audio_batches WHERE status IN ('queued','running') AND EXISTS
       (SELECT 1 FROM jsonb_array_elements(items) i WHERE i->>'status'='queued')
       ORDER BY created_at,id LIMIT 1`,
      )
    ).rows[0] as Row | undefined;
    if (!row) return;
    const budget = await this.admission.acquire(row.account_id);
    if (!budget.allowed) return; // Remains honestly queued until the shared budget permits a start.
    const client = await this.pool.connect();
    let index = -1;
    let item: AudioBatchItem | undefined;
    try {
      await client.query("BEGIN");
      const latest = (
        await client.query(
          "SELECT * FROM wb_audio_batches WHERE id=$1 FOR UPDATE",
          [row.id],
        )
      ).rows[0] as Row;
      index = latest.items.findIndex((value) => value.status === "queued");
      if (index >= 0 && !this.stopping && !this.broken) {
        item = { ...latest.items[index], status: "running" };
        latest.items[index] = item;
        await client.query(
          "UPDATE wb_audio_batches SET items=$2::jsonb,status='running',updated_at=clock_timestamp() WHERE id=$1",
          [row.id, JSON.stringify(latest.items)],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (!item) return;
    this.controller = new AbortController();
    if (this.broken || this.stopping || !this.leader)
      this.controller.abort("worker no longer owns the job");
    try {
      await this.articles.generate(
        row.account_id,
        item.articleId,
        {
          expectedRevision: item.expectedRevision,
          expectedAudioId: item.expectedAudioId,
          expectedRuleVersion: item.expectedRuleVersion,
          voice: item.voice,
          speed: item.speed,
        },
        this.speech,
        this.controller.signal,
        row.id,
        {
          completed: async (c, result) => {
            const audio = result.audio as { audioId: string };
            await this.setItem(c, row.id, index, {
              status: "succeeded",
              audioId: audio.audioId,
            });
          },
        },
      );
    } catch (error) {
      const code =
        this.stopping || this.broken ? undefined : knownFailure(error);
      const c = await this.pool.connect();
      try {
        await c.query("BEGIN");
        await this.setItem(
          c,
          row.id,
          index,
          code
            ? { status: "failed", errorCode: code }
            : { status: "uncertain", errorCode: "WORKER_INTERRUPTED" },
        );
        if (code === "UNAUTHENTICATED" || code === "FORBIDDEN")
          await c.query(
            `UPDATE wb_audio_batches b SET items=(SELECT jsonb_agg(CASE WHEN i->>'status'='queued'
               THEN i||jsonb_build_object('status','cancelled','errorCode',$2::text) ELSE i END ORDER BY n)
               FROM jsonb_array_elements(b.items) WITH ORDINALITY AS t(i,n)),status='completed',updated_at=clock_timestamp()
             WHERE b.id=$1`,
            [row.id, code],
          );
        await c.query("COMMIT");
      } catch (failure) {
        await c.query("ROLLBACK");
        throw failure;
      } finally {
        c.release();
      }
    } finally {
      this.controller = undefined;
    }
  }

  async close() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort("shutdown");
    await this.processing;
    await this.releaseLeader();
  }
}
