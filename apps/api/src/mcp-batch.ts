import { createHash, randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import type { Pool } from "pg";
import { ArticleService, articleInputSchema } from "./articles.js";
import { CmsService } from "./cms.js";
import { ApiError } from "./errors.js";

export const requestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
export const draftSchema = articleInputSchema.extend({
  requestId: requestIdSchema,
  summary: z.string().max(1000).default(""),
  categoryId: z.uuid().nullable().default(null),
  tagIds: z.array(z.uuid()).max(50).default([]),
});
export const batchSchema = z.strictObject({
  batchId: requestIdSchema,
  // Validate article fields per item so one bad article doesn't discard others.
  items: z.array(z.unknown()).min(1).max(20),
});
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(object[k])}`)
    .join(",")}}`;
}
const digest = (input: unknown) =>
  createHash("sha256").update(canonical(input)).digest("hex");
export type ItemResult = {
  requestId: string;
  status: "created" | "error" | "pending";
  articleId?: string;
  slug?: string;
  revision?: number;
  cmsRevision?: number;
  code?: string;
  retryable?: boolean;
};

export class McpBatchService {
  // Admission happens before acquiring a pool connection. One batch at a time
  // per account, at most two per process; cross-process races use the DB lock.
  private active = new Set<string>();
  constructor(
    private pool: Pool,
    private articles: ArticleService,
    private cms: CmsService,
  ) {}

  private summary(batchId: string, items: ItemResult[]) {
    return {
      batchId,
      items,
      created: items.filter((x) => x.status === "created").length,
      failed: items.filter((x) => x.status === "error").length,
      pending: items.filter((x) => x.status === "pending").length,
    };
  }

  async status(owner: string, batchId: string) {
    requestIdSchema.parse(batchId);
    const batch = (
      await this.pool.query(
        "SELECT item_ids FROM wb_cms_mcp_batches WHERE account_id=$1 AND batch_id=$2",
        [owner, batchId],
      )
    ).rows[0];
    if (!batch) throw new ApiError(404, "NOT_FOUND");
    const results = (
      await this.pool.query(
        "SELECT request_id,input_hash,result FROM wb_cms_mcp_items WHERE account_id=$1 AND request_id=ANY($2::text[])",
        [owner, batch.item_ids.map((i: { requestId: string }) => i.requestId)],
      )
    ).rows;
    const byId = new Map(results.map((r) => [r.request_id, r]));
    return this.summary(
      batchId,
      batch.item_ids.map((i: { requestId: string; inputHash: string }) => {
        const row = byId.get(i.requestId);
        if (row && row.input_hash !== i.inputHash)
          return {
            requestId: i.requestId,
            status: "error",
            code: "IDEMPOTENCY_CONFLICT",
            retryable: false,
          };
        return (
          row?.result ?? {
            requestId: i.requestId,
            status: "pending",
            retryable: true,
          }
        );
      }),
    );
  }

  async create(owner: string, input: unknown, cancelled = () => false) {
    const dto = batchSchema.parse(input);
    if (Buffer.byteLength(JSON.stringify(dto)) > 1040000)
      throw new ApiError(413, "PAYLOAD_TOO_LARGE");
    const itemIds = dto.items.map((item) => {
      const { requestId } = z
        .object({ requestId: requestIdSchema })
        .parse(item);
      return { requestId, inputHash: digest(item) };
    });
    if (new Set(itemIds.map((x) => x.requestId)).size !== itemIds.length)
      throw new ApiError(400, "DUPLICATE_REQUEST_ID");
    if (this.active.has(owner) || this.active.size >= 2)
      throw new ApiError(429, "MCP_BUSY");
    this.active.add(owner);
    try {
      await this.articles.transaction(owner, async (c) => {
        const old = (
          await c.query(
            "SELECT input_hash FROM wb_cms_mcp_batches WHERE account_id=$1 AND batch_id=$2",
            [owner, dto.batchId],
          )
        ).rows[0];
        if (old) {
          if (old.input_hash !== digest(dto))
            throw new ApiError(409, "IDEMPOTENCY_CONFLICT");
          return;
        }
        const count = Number(
          (
            await c.query(
              "SELECT count(*) FROM wb_cms_mcp_batches WHERE account_id=$1",
              [owner],
            )
          ).rows[0].count,
        );
        if (count >= 1000) throw new ApiError(409, "MCP_BATCH_LIMIT");
        await c.query(
          "INSERT INTO wb_cms_mcp_batches(account_id,batch_id,input_hash,item_ids) VALUES($1,$2,$3,$4)",
          [owner, dto.batchId, digest(dto), JSON.stringify(itemIds)],
        );
      });
      const results: ItemResult[] = [];
      for (const [index, raw] of dto.items.entries()) {
        const { requestId, inputHash } = itemIds[index];
        if (cancelled()) {
          results.push({ requestId, status: "pending", retryable: true });
          continue;
        }
        try {
          results.push(
            await this.articles.transaction(owner, async (c) => {
              const old = (
                await c.query(
                  "SELECT input_hash,result FROM wb_cms_mcp_items WHERE account_id=$1 AND request_id=$2",
                  [owner, requestId],
                )
              ).rows[0];
              if (old) {
                if (old.input_hash !== inputHash)
                  return {
                    requestId,
                    status: "error",
                    code: "IDEMPOTENCY_CONFLICT",
                    retryable: false,
                  } as ItemResult;
                return old.result as ItemResult;
              }
              let result: ItemResult;
              await c.query("SAVEPOINT article_item");
              try {
                const item = draftSchema.parse(raw);
                const article = await this.cms.createInTransaction(c, owner, {
                  title: item.title,
                  text: item.text,
                  cms: {
                    slug: `article-${randomUUID()}`,
                    summary: item.summary,
                    categoryId: item.categoryId,
                    tagIds: item.tagIds,
                  },
                });
                result = {
                  requestId,
                  status: "created",
                  articleId: article.id as string,
                  slug: article.cms.slug,
                  revision: article.revision as number,
                  cmsRevision: article.cms.revision,
                };
              } catch (error) {
                await c.query("ROLLBACK TO SAVEPOINT article_item");
                // Unexpected/transport/commit failures are not persisted as success
                // or terminal failure. Retry the same IDs to discover the outcome.
                if (
                  !(error instanceof ZodError) &&
                  !(error instanceof ApiError && error.status < 500)
                )
                  throw error;
                result = {
                  requestId,
                  status: "error",
                  code:
                    error instanceof ApiError ? error.code : "INVALID_REQUEST",
                  retryable: false,
                };
              }
              await c.query(
                "INSERT INTO wb_cms_mcp_items(account_id,request_id,input_hash,result) VALUES($1,$2,$3,$4)",
                [owner, requestId, inputHash, JSON.stringify(result)],
              );
              return result;
            }),
          );
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) throw error;
          results.push({
            requestId,
            status: "pending",
            code: "OUTCOME_UNKNOWN",
            retryable: true,
          });
        }
      }
      return this.summary(dto.batchId, results);
    } finally {
      this.active.delete(owner);
    }
  }
}
