import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { ArticleService } from "./articles.js";
import { CmsService } from "./cms.js";
import { requestIdSchema } from "./mcp-batch.js";
import { ApiError } from "./errors.js";

const categoryInput = z.strictObject({
  requestId: requestIdSchema,
  name: z.string().min(1).max(500),
  parentId: z.uuid().nullable().default(null),
  sortOrder: z.number().int().min(0).max(2147483647).default(0),
});
const updateInput = z
  .strictObject({
    requestId: requestIdSchema,
    articleId: z.uuid(),
    expectedRevision: z.number().int().min(1),
    expectedCmsRevision: z.number().int().min(0),
    title: z.string().optional(),
    text: z.string().optional(),
    summary: z.string().optional(),
    categoryId: z.uuid().nullable().optional(),
    tagIds: z.array(z.uuid()).max(50).optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.text !== undefined ||
      v.summary !== undefined ||
      v.categoryId !== undefined ||
      v.tagIds !== undefined,
  );

// Canonicalize object key order. Store only the digest and minimal result,
// never article bodies. The original request ID remains reserved after deletion.
function canonical(input: unknown): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
  const object = input as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}
const digest = (input: unknown) =>
  createHash("sha256").update(canonical(input)).digest("hex");

export class McpWriteService {
  constructor(
    private articles: ArticleService,
    private cms: CmsService,
  ) {}

  private async apply<T extends Record<string, unknown>>(
    owner: string,
    operation: "create_category" | "update_article",
    requestId: string,
    input: unknown,
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const inputHash = digest(input);
    return this.articles.transaction(owner, async (client) => {
      const receipt = (
        await client.query(
          "SELECT operation,input_hash,result FROM wb_cms_mcp_writes WHERE account_id=$1 AND request_id=$2",
          [owner, requestId],
        )
      ).rows[0];
      if (receipt) {
        if (receipt.operation !== operation || receipt.input_hash !== inputHash)
          throw new ApiError(409, "IDEMPOTENCY_CONFLICT");
        return receipt.result as T;
      }
      const value = await action(client);
      await client.query(
        "INSERT INTO wb_cms_mcp_writes(account_id,request_id,operation,input_hash,result) VALUES($1,$2,$3,$4,$5)",
        [owner, requestId, operation, inputHash, JSON.stringify(value)],
      );
      return value;
    });
  }

  async createCategory(owner: string, input: unknown) {
    const dto = categoryInput.parse(input);
    return this.apply(owner, "create_category", dto.requestId, dto, async (c) => {
      const { created, ...category } = await this.cms.createMcpCategoryInTransaction(
        c, owner,
        { name: dto.name, parentId: dto.parentId, sortOrder: dto.sortOrder },
      );
      return {
        requestId: dto.requestId,
        status: created ? "created" : "existing",
        categoryId: category.id,
        revision: category.revision,
        slug: category.slug,
      };
    });
  }

  async updateArticle(owner: string, input: unknown) {
    const dto = updateInput.parse(input);
    return this.apply(owner, "update_article", dto.requestId, dto, async (c) => {
      const article = await this.cms.updateMcpArticleInTransaction(c, owner, dto);
      return {
        requestId: dto.requestId,
        status: "updated",
        articleId: article.id as string,
        revision: article.revision as number,
        cmsRevision: article.cms.revision,
        contentRevision: article.contentRevision as number,
      };
    });
  }
}
