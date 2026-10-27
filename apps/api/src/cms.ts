import { randomUUID, randomBytes, createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { ArticleService, articleInputSchema } from "./articles.js";
import { ApiError } from "./errors.js";

const clean = (max: number) =>
  z
    .string()
    .refine(
      (s) =>
        [...s].length <= max &&
        Buffer.from(s).toString("utf8") === s &&
        !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(s),
    );
const name = clean(80)
  .transform((s) => s.trim())
  .refine((s) => s.length > 0);
const slug = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const revision = z.number().int().min(1);
const uuid = z.uuid();
const ids = z
  .array(uuid)
  .max(50)
  .refine((v) => new Set(v).size === v.length)
  .transform((v) => [...v].sort());
const metaSchema = z.strictObject({
  slug,
  summary: clean(1000).default(""),
  categoryId: uuid.nullable().default(null),
  tagIds: ids.default([]),
});
const createSchema = articleInputSchema.extend({ cms: metaSchema });
const updateSchema = articleInputSchema.extend({
  expectedRevision: revision,
  cms: metaSchema.extend({ expectedRevision: z.number().int().min(0) }),
});
const taxonomySchema = z.strictObject({ name, slug });
const sortOrder = z.number().int().min(0).max(2147483647);
const categorySchema = taxonomySchema.extend({
  parentId: uuid.nullable().default(null),
  sortOrder: sortOrder.default(0),
});
const categoryPatchSchema = taxonomySchema.extend({
  expectedRevision: revision,
  parentId: uuid.nullable().optional(),
  sortOrder: sortOrder.optional(),
});
const listSchema = z.strictObject({
  q: clean(120).default(""),
  category: z.union([uuid, z.literal("uncategorized")]).optional(),
  tag: uuid.optional(),
  status: z.enum(["draft", "published"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
// Reading uses direct frozen category membership, without consulting the draft tree.
const readListSchema = listSchema.omit({ status: true }).extend({
  category: z.union([uuid, z.literal("uncategorized")]).optional(),
});
const moveCategorySchema = z.strictObject({
  categoryId: uuid.nullable(),
  items: z
    .array(
      z.strictObject({
        articleId: uuid,
        expectedRevision: revision,
        expectedCmsRevision: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(100)
    .refine(
      (items) =>
        new Set(items.map((item) => item.articleId)).size === items.length,
    ),
});
const importItem = articleInputSchema.extend({
  externalId: clean(200).refine((s) => s.trim().length > 0),
  ...metaSchema.shape,
});
const importCommitItem = importItem.extend({
  articleId: uuid.nullable(),
  expectedRevision: z.number().int().min(0),
  expectedCmsRevision: z.number().int().min(0),
});
const importEnvelope = z.strictObject({
  source: clean(100).refine((s) => s.trim().length > 0),
  items: z.array(z.unknown()).min(1).max(20),
});
type Meta = z.infer<typeof metaSchema>;
type Db = Pick<PoolClient, "query">;
export interface ReadIdentity {
  owner: string;
  categoryIds: string[];
}
export interface CmsMetadata extends Meta {
  revision: number;
  publishedReleaseId: string | null;
  source?: { source: string; externalId: string };
}
type ImportResult = {
  externalId: string;
  status: string;
  articleId?: string | null;
  expectedRevision?: number;
  expectedCmsRevision?: number;
  revision?: number;
  cmsRevision?: number;
  errors?: string[];
};

export class CmsService {
  constructor(
    private pool: Pool,
    private articles: ArticleService,
    readonly tokensEnabled = false,
  ) {}

  private async write<T>(owner: string, action: (c: PoolClient) => Promise<T>) {
    try {
      return await this.articles.transaction(owner, action);
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        throw new ApiError(409, "CMS_CONFLICT");
      if ((e as { code?: string }).code === "23503")
        throw new ApiError(409, "CMS_REFERENCE_CONFLICT");
      throw e;
    }
  }
  private async read<T>(action: (c: PoolClient) => Promise<T>) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const value = await action(c);
      await c.query("COMMIT");
      return value;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  private async metadata(
    c: Db,
    owner: string,
    id: string,
  ): Promise<CmsMetadata> {
    const row = (
      await c.query(
        `SELECT revision,slug,summary,category_id AS "categoryId",published_release_id AS "publishedReleaseId"
      FROM wb_cms_articles WHERE account_id=$1 AND article_id=$2`,
        [owner, id],
      )
    ).rows[0];
    const tags = row
      ? (
          await c.query(
            "SELECT taxonomy_id AS id FROM wb_cms_article_tags WHERE article_id=$1 ORDER BY taxonomy_id",
            [id],
          )
        ).rows.map((r) => r.id as string)
      : [];
    const source = (
      await c.query(
        'SELECT source,external_id AS "externalId" FROM wb_cms_import_sources WHERE account_id=$1 AND article_id=$2',
        [owner, id],
      )
    ).rows[0];
    return {
      ...(row ?? {
        revision: 0,
        slug: "",
        summary: "",
        categoryId: null,
        publishedReleaseId: null,
      }),
      tagIds: tags,
      ...(source ? { source } : {}),
    };
  }
  private async detail(
    c: Db,
    owner: string,
    id: string,
  ): Promise<Record<string, unknown> & { cms: CmsMetadata }> {
    return {
      ...(await this.articles.detailInTransaction(c, owner, id)),
      cms: await this.metadata(c, owner, id),
    };
  }
  async get(owner: string, id: string) {
    uuid.parse(id);
    return this.read((c) => this.detail(c, owner, id));
  }
  async list(owner: string, query: unknown) {
    const q = listSchema.parse(query);
    return this.read(async (c) => {
      const values: unknown[] = [owner, q.q];
      const clauses = [
        "a.account_id=$1",
        "strpos(lower(concat_ws(' ',a.title,a.text,m.summary)),lower($2))>0",
      ];
      if (q.category === "uncategorized") {
        clauses.push("m.category_id IS NULL");
      } else if (q.category) {
        values.push(q.category);
        clauses.push(`m.category_id=$${values.length}`);
      }
      if (q.tag) {
        values.push(q.tag);
        clauses.push(
          `EXISTS(SELECT 1 FROM wb_cms_article_tags t WHERE t.article_id=a.id AND t.taxonomy_id=$${values.length})`,
        );
      }
      if (q.status)
        clauses.push(
          `m.published_release_id IS ${q.status === "draft" ? "" : "NOT "}NULL`,
        );
      const from = `FROM wb_articles a LEFT JOIN wb_cms_articles m ON m.article_id=a.id WHERE ${clauses.join(" AND ")}`;
      const total = Number(
        (await c.query(`SELECT count(*) ${from}`, values)).rows[0].count,
      );
      values.push(q.limit, q.offset);
      const rows = (
        await c.query(
          `SELECT a.id ${from} ORDER BY a.updated_at DESC,a.id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
          values,
        )
      ).rows;
      const items = [];
      for (const row of rows) {
        const { text: _text, ...summary } = await this.detail(c, owner, row.id);
        items.push(summary);
      }
      return { items, total, limit: q.limit, offset: q.offset };
    });
  }
  async taxonomy(owner: string) {
    return this.read(async (c) => {
      const rows = (
        await c.query(
          `SELECT t.id,t.name,t.slug,t.revision,t.kind,t.parent_id AS "parentId",t.sort_order AS "sortOrder",
          (SELECT count(*) FROM wb_cms_articles a WHERE a.account_id=$1 AND a.category_id=t.id) AS "articleCount",
          (SELECT count(*) FROM wb_cms_taxonomy child WHERE child.account_id=$1 AND child.kind='category' AND child.parent_id=t.id) AS "childrenCount"
        FROM wb_cms_taxonomy t WHERE t.account_id=$1 ORDER BY t.sort_order,t.name,t.id`,
          [owner],
        )
      ).rows;
      const totals = (
        await c.query(
          `SELECT count(*) AS total,count(*) FILTER(WHERE m.category_id IS NULL) AS uncategorized
         FROM wb_articles a LEFT JOIN wb_cms_articles m ON m.article_id=a.id WHERE a.account_id=$1`,
          [owner],
        )
      ).rows[0];
      return {
        categories: rows
          .filter((r) => r.kind === "category")
          .map(({ kind: _kind, ...row }) => ({
            ...row,
            articleCount: Number(row.articleCount),
            childrenCount: Number(row.childrenCount),
          })),
        tags: rows
          .filter((r) => r.kind === "tag")
          .map(({ id, name, slug, revision }) => ({
            id,
            name,
            slug,
            revision,
          })),
        uncategorizedCount: Number(totals.uncategorized),
        totalArticles: Number(totals.total),
      };
    });
  }
  private async taxonomyItem(
    c: Db,
    owner: string,
    kind: "category" | "tag",
    id: string,
  ) {
    const row = (
      await c.query(
        `SELECT id,name,slug,revision,parent_id AS "parentId",sort_order AS "sortOrder"
       FROM wb_cms_taxonomy WHERE account_id=$1 AND kind=$2 AND id=$3`,
        [owner, kind, id],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND");
    if (kind === "tag") {
      const { id, name, slug, revision } = row;
      return { id, name, slug, revision };
    }
    const counts = (
      await c.query(
        `SELECT (SELECT count(*) FROM wb_cms_articles WHERE account_id=$1 AND category_id=$2) AS articles,
        (SELECT count(*) FROM wb_cms_taxonomy WHERE account_id=$1 AND kind='category' AND parent_id=$2) AS children`,
        [owner, id],
      )
    ).rows[0];
    return {
      ...row,
      articleCount: Number(counts.articles),
      childrenCount: Number(counts.children),
    };
  }
  private async categoryParent(
    c: Db,
    owner: string,
    id: string,
    parentId: string | null,
  ) {
    if (!parentId) return;
    if (parentId === id) throw new ApiError(409, "CATEGORY_CYCLE");
    if (
      !(
        await c.query(
          "SELECT 1 FROM wb_cms_taxonomy WHERE id=$1 AND account_id=$2 AND kind='category'",
          [parentId, owner],
        )
      ).rowCount
    )
      throw new ApiError(400, "INVALID_REQUEST");
    // All graph mutations run under the same account row lock as article writes.
    // UNION also terminates defensively if an old graph was already malformed.
    const cycle = await c.query(
      `WITH RECURSIVE ancestors AS (
        SELECT id,parent_id FROM wb_cms_taxonomy WHERE id=$1 AND account_id=$2 AND kind='category'
        UNION
        SELECT t.id,t.parent_id FROM wb_cms_taxonomy t JOIN ancestors a ON t.id=a.parent_id
          WHERE t.account_id=$2 AND t.kind='category'
      ) SELECT 1 FROM ancestors WHERE id=$3 LIMIT 1`,
      [parentId, owner, id],
    );
    if (cycle.rowCount) throw new ApiError(409, "CATEGORY_CYCLE");
  }
  async createTaxonomy(
    owner: string,
    kind: "category" | "tag",
    input: unknown,
  ) {
    const dto =
      kind === "category"
        ? categorySchema.parse(input)
        : { ...taxonomySchema.parse(input), parentId: null, sortOrder: 0 };
    return this.write(owner, async (c) => {
      const id = randomUUID();
      if (kind === "category")
        await this.categoryParent(c, owner, id, dto.parentId);
      await c.query(
        "INSERT INTO wb_cms_taxonomy(id,account_id,kind,name,slug,parent_id,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [id, owner, kind, dto.name, dto.slug, dto.parentId, dto.sortOrder],
      );
      return this.taxonomyItem(c, owner, kind, id);
    });
  }
  async updateTaxonomy(
    owner: string,
    kind: "category" | "tag",
    id: string,
    input: unknown,
  ) {
    uuid.parse(id);
    const dto =
      kind === "category"
        ? categoryPatchSchema.parse(input)
        : {
            ...taxonomySchema
              .extend({ expectedRevision: revision })
              .parse(input),
            parentId: undefined,
            sortOrder: undefined,
          };
    return this.write(owner, async (c) => {
      const row = (
        await c.query(
          'SELECT id,name,slug,revision,parent_id AS "parentId",sort_order AS "sortOrder" FROM wb_cms_taxonomy WHERE account_id=$1 AND kind=$2 AND id=$3 FOR UPDATE',
          [owner, kind, id],
        )
      ).rows[0];
      if (!row) throw new ApiError(404, "NOT_FOUND");
      if (row.revision !== dto.expectedRevision)
        throw new ApiError(409, "REVISION_CONFLICT");
      const parentId = dto.parentId === undefined ? row.parentId : dto.parentId;
      const order = dto.sortOrder === undefined ? row.sortOrder : dto.sortOrder;
      if (kind === "category")
        await this.categoryParent(c, owner, id, parentId);
      if (
        row.name !== dto.name ||
        row.slug !== dto.slug ||
        row.parentId !== parentId ||
        row.sortOrder !== order
      )
        await c.query(
          "UPDATE wb_cms_taxonomy SET name=$2,slug=$3,parent_id=$4,sort_order=$5,revision=revision+1 WHERE id=$1",
          [id, dto.name, dto.slug, parentId, order],
        );
      return this.taxonomyItem(c, owner, kind, id);
    });
  }
  async removeTaxonomy(
    owner: string,
    kind: "category" | "tag",
    id: string,
    expected: unknown,
  ) {
    uuid.parse(id);
    const wanted = z.coerce.number().int().min(1).parse(expected);
    return this.write(owner, async (c) => {
      const row = (
        await c.query(
          "SELECT revision FROM wb_cms_taxonomy WHERE account_id=$1 AND kind=$2 AND id=$3 FOR UPDATE",
          [owner, kind, id],
        )
      ).rows[0];
      if (!row) throw new ApiError(404, "NOT_FOUND");
      if (row.revision !== wanted) throw new ApiError(409, "REVISION_CONFLICT");
      const used =
        kind === "category"
          ? await c.query(
              "SELECT 1 FROM wb_cms_articles WHERE category_id=$1 LIMIT 1",
              [id],
            )
          : await c.query(
              "SELECT 1 FROM wb_cms_article_tags WHERE taxonomy_id=$1 LIMIT 1",
              [id],
            );
      if (used.rowCount) throw new ApiError(409, "TAXONOMY_IN_USE");
      if (
        kind === "category" &&
        (
          await c.query(
            "SELECT 1 FROM wb_cms_taxonomy WHERE account_id=$1 AND parent_id=$2 AND kind='category' LIMIT 1",
            [owner, id],
          )
        ).rowCount
      )
        throw new ApiError(409, "TAXONOMY_IN_USE");
      await c.query("DELETE FROM wb_cms_taxonomy WHERE id=$1", [id]);
    });
  }
  private async references(c: Db, owner: string, dto: Meta) {
    if (
      dto.categoryId &&
      !(
        await c.query(
          "SELECT 1 FROM wb_cms_taxonomy WHERE id=$1 AND account_id=$2 AND kind='category'",
          [dto.categoryId, owner],
        )
      ).rowCount
    )
      throw new ApiError(400, "INVALID_REQUEST");
    if (dto.tagIds.length) {
      const rows = await c.query(
        "SELECT id FROM wb_cms_taxonomy WHERE id=ANY($1::uuid[]) AND account_id=$2 AND kind='tag'",
        [dto.tagIds, owner],
      );
      if (rows.rowCount !== dto.tagIds.length)
        throw new ApiError(400, "INVALID_REQUEST");
    }
  }
  private same(meta: CmsMetadata, dto: Meta) {
    return (
      meta.slug === dto.slug &&
      meta.summary === dto.summary &&
      meta.categoryId === dto.categoryId &&
      JSON.stringify(meta.tagIds) === JSON.stringify(dto.tagIds)
    );
  }
  private async saveMeta(
    c: PoolClient,
    owner: string,
    id: string,
    dto: Meta,
    expected: number,
  ) {
    const old = await this.metadata(c, owner, id);
    if (old.revision !== expected)
      throw new ApiError(409, "CMS_REVISION_CONFLICT");
    await this.references(c, owner, dto);
    if (old.revision && this.same(old, dto)) return;
    if (!old.revision)
      await c.query(
        "INSERT INTO wb_cms_articles(article_id,account_id,slug,summary,category_id) VALUES($1,$2,$3,$4,$5)",
        [id, owner, dto.slug, dto.summary, dto.categoryId],
      );
    else
      await c.query(
        "UPDATE wb_cms_articles SET slug=$2,summary=$3,category_id=$4,revision=revision+1 WHERE article_id=$1",
        [id, dto.slug, dto.summary, dto.categoryId],
      );
    await c.query("DELETE FROM wb_cms_article_tags WHERE article_id=$1", [id]);
    if (dto.tagIds.length)
      await c.query(
        "INSERT INTO wb_cms_article_tags(article_id,taxonomy_id) SELECT $1,unnest($2::uuid[])",
        [id, dto.tagIds],
      );
  }
  async create(owner: string, input: unknown) {
    const dto = createSchema.parse(input);
    return this.write(owner, async (c) => {
      const article = await this.articles.createInTransaction(c, owner, {
        title: dto.title,
        text: dto.text,
      });
      const id = article.id as string;
      await this.saveMeta(c, owner, id, dto.cms, 0);
      return this.detail(c, owner, id);
    });
  }
  async update(owner: string, id: string, input: unknown) {
    uuid.parse(id);
    const dto = updateSchema.parse(input);
    return this.write(owner, async (c) => {
      await this.articles.updateInTransaction(c, owner, id, {
        title: dto.title,
        text: dto.text,
        expectedRevision: dto.expectedRevision,
      });
      await this.saveMeta(c, owner, id, dto.cms, dto.cms.expectedRevision);
      return this.detail(c, owner, id);
    });
  }

  async moveCategory(owner: string, input: unknown) {
    const dto = moveCategorySchema.parse(input);
    return this.write(owner, async (c) => {
      if (
        dto.categoryId &&
        !(
          await c.query(
            "SELECT 1 FROM wb_cms_taxonomy WHERE account_id=$1 AND id=$2 AND kind='category'",
            [owner, dto.categoryId],
          )
        ).rowCount
      )
        throw new ApiError(400, "INVALID_REQUEST");
      const current = new Map<string, CmsMetadata>();
      // Validate every precondition before updating any row; the whole owner transaction rolls back on conflict.
      for (const item of dto.items) {
        await this.articles.checkInTransaction(
          c,
          owner,
          item.articleId,
          item.expectedRevision,
        );
        const meta = await this.metadata(c, owner, item.articleId);
        if (meta.revision !== item.expectedCmsRevision)
          throw new ApiError(409, "CMS_REVISION_CONFLICT");
        current.set(item.articleId, meta);
      }
      const items = [];
      for (const item of dto.items) {
        const meta = current.get(item.articleId)!;
        if (!meta.revision && dto.categoryId) {
          let safeSlug = `article-${item.articleId}`;
          for (let attempt = 0; ; attempt++) {
            if (
              !(
                await c.query(
                  "SELECT 1 FROM wb_cms_articles WHERE account_id=$1 AND slug=$2",
                  [owner, safeSlug],
                )
              ).rowCount
            )
              break;
            if (attempt >= 5) throw new ApiError(409, "CMS_CONFLICT");
            safeSlug = `article-${item.articleId}-${randomUUID()}`;
          }
          await c.query(
            "INSERT INTO wb_cms_articles(article_id,account_id,slug,summary,category_id) VALUES($1,$2,$3,'',$4)",
            [item.articleId, owner, safeSlug, dto.categoryId],
          );
        } else if (meta.revision && meta.categoryId !== dto.categoryId) {
          await c.query(
            "UPDATE wb_cms_articles SET category_id=$2,revision=revision+1 WHERE article_id=$1",
            [item.articleId, dto.categoryId],
          );
        }
        const { text: _text, ...summary } = await this.detail(
          c,
          owner,
          item.articleId,
        );
        items.push(summary);
      }
      return { items };
    });
  }

  private importError(value: unknown, e: unknown): ImportResult {
    const externalId =
      typeof (value as { externalId?: unknown })?.externalId === "string"
        ? (value as { externalId: string }).externalId
        : "";
    return {
      externalId,
      status: "error",
      errors: [
        e instanceof ApiError
          ? e.code
          : e instanceof z.ZodError
            ? "INVALID_REQUEST"
            : "DEPENDENCY_UNAVAILABLE",
      ],
    };
  }
  async import(owner: string, input: unknown, preview: boolean) {
    const dto = importEnvelope.parse(input);
    const externalIds = dto.items.map(
      (v) => (v as { externalId?: unknown })?.externalId,
    );
    const results: ImportResult[] = [];
    for (const value of dto.items) {
      try {
        const item = preview
          ? importItem.parse(value)
          : importCommitItem.parse(value);
        if (externalIds.filter((v) => v === item.externalId).length !== 1)
          throw new ApiError(409, "IMPORT_DUPLICATE_EXTERNAL_ID");
        const action = async (c: PoolClient) => {
          await this.references(c, owner, item);
          const mapping = (
            await c.query(
              "SELECT article_id AS id FROM wb_cms_import_sources WHERE account_id=$1 AND source=$2 AND external_id=$3",
              [owner, dto.source, item.externalId],
            )
          ).rows[0];
          const current = mapping
            ? await this.detail(c, owner, mapping.id)
            : undefined;
          const unchanged =
            current &&
            current.title === item.title &&
            current.text === item.text &&
            this.same(current.cms, item);
          const conflictSlug = (
            await c.query(
              "SELECT article_id FROM wb_cms_articles WHERE account_id=$1 AND slug=$2 AND article_id<>COALESCE($3::uuid,'00000000-0000-0000-0000-000000000000'::uuid)",
              [owner, item.slug, mapping?.id ?? null],
            )
          ).rowCount;
          if (conflictSlug) throw new ApiError(409, "CMS_CONFLICT");
          if (preview)
            return {
              externalId: item.externalId,
              status: current ? (unchanged ? "unchanged" : "update") : "create",
              articleId: mapping?.id ?? null,
              expectedRevision: current ? Number(current.revision) : 0,
              expectedCmsRevision: current?.cms.revision ?? 0,
            };
          const commit = item as z.infer<typeof importCommitItem>;
          if (
            (mapping?.id ?? null) !== commit.articleId ||
            (current ? Number(current.revision) : 0) !==
              commit.expectedRevision ||
            (current?.cms.revision ?? 0) !== commit.expectedCmsRevision
          )
            throw new ApiError(409, "IMPORT_CONFLICT");
          if (unchanged)
            return {
              externalId: item.externalId,
              status: "unchanged",
              articleId: mapping.id,
              revision: Number(current!.revision),
              cmsRevision: current!.cms.revision,
            };
          let id: string;
          if (current) {
            id = mapping.id;
            await this.articles.updateInTransaction(c, owner, id, {
              title: item.title,
              text: item.text,
              expectedRevision: commit.expectedRevision,
            });
          } else {
            const article = await this.articles.createInTransaction(c, owner, {
              title: item.title,
              text: item.text,
            });
            id = article.id as string;
            await c.query(
              "INSERT INTO wb_cms_import_sources(account_id,source,external_id,article_id) VALUES($1,$2,$3,$4)",
              [owner, dto.source, item.externalId, id],
            );
          }
          await this.saveMeta(c, owner, id, item, commit.expectedCmsRevision);
          const saved = await this.detail(c, owner, id);
          return {
            externalId: item.externalId,
            status: current ? "updated" : "created",
            articleId: id,
            revision: Number(saved.revision),
            cmsRevision: saved.cms.revision,
          };
        };
        results.push(
          preview ? await this.read(action) : await this.write(owner, action),
        );
      } catch (e) {
        results.push(this.importError(value, e));
      }
    }
    return { items: results };
  }

  async publish(owner: string, id: string, input: unknown) {
    uuid.parse(id);
    const dto = z
      .strictObject({
        expectedRevision: revision,
        expectedCmsRevision: revision,
        expectedAudioId: uuid.nullable(),
      })
      .parse(input);
    return this.write(owner, async (c) => {
      await this.articles.checkInTransaction(
        c,
        owner,
        id,
        dto.expectedRevision,
      );
      const article = await this.detail(c, owner, id);
      if (article.cms.revision !== dto.expectedCmsRevision)
        throw new ApiError(409, "CMS_REVISION_CONFLICT");
      const count = Number(
        (
          await c.query(
            "SELECT count(*) FROM wb_cms_releases WHERE article_id=$1",
            [id],
          )
        ).rows[0].count,
      );
      if (count >= 10) throw new ApiError(409, "RELEASE_LIMIT");
      let audio: Record<string, unknown> | null = null;
      if (dto.expectedAudioId) {
        const stored = (
          await c.query(
            "SELECT metadata,data FROM wb_article_audio WHERE article_id=$1 AND metadata->>'audioId'=$2",
            [id, dto.expectedAudioId],
          )
        ).rows[0];
        if (!stored) throw new ApiError(409, "AUDIO_STALE");
        audio = stored.metadata;
        // Lock the rule-set row to linearize publication against pronunciation edits.
        const rule = (
          await c.query(
            "SELECT version FROM wb_rule_sets WHERE account_id=$1 FOR SHARE",
            [owner],
          )
        ).rows[0];
        if (
          audio!.contentRevision !== article.contentRevision ||
          audio!.ruleVersion !== (rule?.version ?? 0)
        )
          throw new ApiError(409, "AUDIO_STALE");
        await c.query(
          "INSERT INTO wb_cms_media(audio_id,account_id,metadata,data) VALUES($1,$2,$3,$4) ON CONFLICT(audio_id) DO NOTHING",
          [dto.expectedAudioId, owner, audio, stored.data],
        );
      }
      const category = article.cms.categoryId
        ? (
            await c.query(
              "SELECT id,name,slug,revision FROM wb_cms_taxonomy WHERE id=$1 AND account_id=$2",
              [article.cms.categoryId, owner],
            )
          ).rows[0]
        : null;
      const tags = (
        await c.query(
          "SELECT id,name,slug,revision FROM wb_cms_taxonomy WHERE id=ANY($1::uuid[]) AND account_id=$2 ORDER BY id",
          [article.cms.tagIds, owner],
        )
      ).rows;
      const releaseId = randomUUID();
      const snapshot = {
        id: releaseId,
        articleId: id,
        createdAt: new Date().toISOString(),
        articleRevision: article.revision,
        contentRevision: article.contentRevision,
        cmsRevision: article.cms.revision,
        title: article.title,
        text: article.text,
        cms: {
          slug: article.cms.slug,
          summary: article.cms.summary,
          category,
          tags,
        },
        audio,
      };
      await c.query(
        "INSERT INTO wb_cms_releases(id,article_id,account_id,audio_id,snapshot) VALUES($1,$2,$3,$4,$5)",
        [releaseId, id, owner, dto.expectedAudioId, snapshot],
      );
      await c.query(
        "UPDATE wb_cms_articles SET published_release_id=$2,revision=revision+1 WHERE article_id=$1",
        [id, releaseId],
      );
      return snapshot;
    });
  }
  async releases(owner: string, id: string) {
    uuid.parse(id);
    return this.read(async (c) => {
      await this.articles.detailInTransaction(c, owner, id);
      return {
        items: (
          await c.query(
            "SELECT snapshot FROM wb_cms_releases WHERE article_id=$1 AND account_id=$2 ORDER BY created_at DESC,id DESC",
            [id, owner],
          )
        ).rows.map((r) => r.snapshot),
      };
    });
  }
  async release(owner: string, id: string, releaseId: string) {
    uuid.parse(id);
    uuid.parse(releaseId);
    const row = (
      await this.pool.query(
        "SELECT snapshot FROM wb_cms_releases WHERE article_id=$1 AND account_id=$2 AND id=$3",
        [id, owner, releaseId],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND");
    return row.snapshot;
  }
  async unpublish(owner: string, id: string, input: unknown) {
    uuid.parse(id);
    const dto = z
      .strictObject({
        expectedRevision: revision,
        expectedCmsRevision: revision,
      })
      .parse(input);
    return this.write(owner, async (c) => {
      await this.articles.checkInTransaction(
        c,
        owner,
        id,
        dto.expectedRevision,
      );
      const meta = await this.metadata(c, owner, id);
      if (meta.revision !== dto.expectedCmsRevision)
        throw new ApiError(409, "CMS_REVISION_CONFLICT");
      if (meta.publishedReleaseId)
        await c.query(
          "UPDATE wb_cms_articles SET published_release_id=NULL,revision=revision+1 WHERE article_id=$1",
          [id],
        );
      return this.detail(c, owner, id);
    });
  }
  async removeRelease(
    owner: string,
    id: string,
    releaseId: string,
    expected: unknown,
  ) {
    uuid.parse(id);
    uuid.parse(releaseId);
    const wanted = z.coerce.number().int().min(1).parse(expected);
    return this.write(owner, async (c) => {
      await this.articles.detailInTransaction(c, owner, id);
      const meta = await this.metadata(c, owner, id);
      if (meta.revision !== wanted)
        throw new ApiError(409, "CMS_REVISION_CONFLICT");
      if (meta.publishedReleaseId === releaseId)
        throw new ApiError(409, "RELEASE_IS_CURRENT");
      const deleted = (
        await c.query(
          "DELETE FROM wb_cms_releases WHERE id=$1 AND article_id=$2 AND account_id=$3 RETURNING audio_id",
          [releaseId, id, owner],
        )
      ).rows[0];
      if (!deleted) throw new ApiError(404, "NOT_FOUND");
      if (deleted.audio_id)
        await c.query(
          "DELETE FROM wb_cms_media m WHERE audio_id=$1 AND NOT EXISTS(SELECT 1 FROM wb_cms_releases r WHERE r.audio_id=m.audio_id)",
          [deleted.audio_id],
        );
      await c.query(
        "UPDATE wb_cms_articles SET revision=revision+1 WHERE article_id=$1",
        [id],
      );
    });
  }
  async releaseAudio(owner: string, id: string, releaseId: string) {
    uuid.parse(id);
    uuid.parse(releaseId);
    const row = (
      await this.pool.query(
        "SELECT m.metadata,m.data FROM wb_cms_releases r JOIN wb_cms_media m ON m.audio_id=r.audio_id WHERE r.account_id=$1 AND r.article_id=$2 AND r.id=$3",
        [owner, id, releaseId],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND");
    return row;
  }

  async readIdentity(
    sessionOwner: string | undefined,
    authorization: string | undefined,
  ): Promise<ReadIdentity> {
    if (authorization !== undefined) {
      if (!this.tokensEnabled) throw new ApiError(401, "UNAUTHENTICATED");
      const token = /^Bearer (wb_cms_[A-Za-z0-9_-]{43})$/.exec(
        authorization,
      )?.[1];
      if (!token) throw new ApiError(401, "UNAUTHENTICATED");
      const hash = createHash("sha256").update(token).digest("hex");
      const row = (
        await this.pool.query(
          "SELECT t.account_id AS owner,t.category_ids AS \"categoryIds\" FROM wb_cms_read_tokens t JOIN ac_accounts a ON a.id=t.account_id WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND t.expires_at>now() AND a.status='active'",
          [hash],
        )
      ).rows[0];
      if (!row) throw new ApiError(401, "UNAUTHENTICATED");
      return row;
    }
    if (!sessionOwner) throw new ApiError(401, "UNAUTHENTICATED");
    return { owner: sessionOwner, categoryIds: [] };
  }
  private readWhere(identity: ReadIdentity, values: unknown[]) {
    values.push(identity.owner);
    const ownerParam = values.length;
    let clause = `r.account_id=$${ownerParam} AND m.published_release_id=r.id`;
    if (identity.categoryIds.length) {
      values.push(identity.categoryIds);
      clause += ` AND (r.snapshot->'cms'->'category'->>'id')=ANY($${values.length}::text[])`;
    }
    return clause;
  }
  private readFilter(
    identity: ReadIdentity,
    query: { q: string; tag?: string; category?: string },
    includeCategory = true,
  ) {
    const values: unknown[] = [];
    let where = this.readWhere(identity, values);
    values.push(query.q);
    where += ` AND strpos(lower(concat_ws(' ',r.snapshot->>'title',r.snapshot->>'text',r.snapshot->'cms'->>'summary')),lower($${values.length}))>0`;
    if (query.tag) {
      values.push(query.tag);
      where += ` AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.snapshot->'cms'->'tags') t WHERE t->>'id'=$${values.length})`;
    }
    if (includeCategory && query.category === "uncategorized") {
      where += " AND r.snapshot->'cms'->'category'->>'id' IS NULL";
    } else if (includeCategory && query.category) {
      values.push(query.category);
      where += ` AND r.snapshot->'cms'->'category'->>'id'=$${values.length}`;
    }
    return { where, values };
  }
  private async readNavigation(
    c: Db,
    identity: ReadIdentity,
    query: { q: string; tag?: string },
  ) {
    const { where, values } = this.readFilter(identity, query, false);
    const from = `FROM wb_cms_releases r JOIN wb_cms_articles m ON m.article_id=r.article_id WHERE ${where}`;
    const totals = (
      await c.query(
        `SELECT count(*) AS total,count(*) FILTER(WHERE r.snapshot->'cms'->'category'->>'id' IS NULL) AS uncategorized ${from}`,
        values,
      )
    ).rows[0];
    // Aggregate only compact frozen category fields: never load draft taxonomy or audio/text buffers here.
    const categories = (
      await c.query(
        `WITH visible AS (
        SELECT r.id AS release_id,r.created_at,
          r.snapshot->'cms'->'category'->>'id' AS category_id,
          r.snapshot->'cms'->'category'->>'name' AS name,
          r.snapshot->'cms'->'category'->>'slug' AS slug
        ${from} AND r.snapshot->'cms'->'category'->>'id' IS NOT NULL
      ), latest AS (
        SELECT DISTINCT ON(category_id) category_id,name,slug FROM visible
        ORDER BY category_id,created_at DESC,release_id DESC
      ), alias_snapshots AS (
        SELECT DISTINCT ON(category_id,name) category_id,name,created_at,release_id FROM visible
        ORDER BY category_id,name,created_at DESC,release_id DESC
      ), aliases AS (
        SELECT category_id,array_agg(name ORDER BY created_at DESC,release_id DESC) AS names
        FROM alias_snapshots GROUP BY category_id
      ), counts AS (
        SELECT category_id,count(*) AS articles FROM visible GROUP BY category_id
      )
      SELECT latest.category_id AS id,latest.name,latest.slug,aliases.names,counts.articles AS "articleCount"
      FROM latest JOIN aliases USING(category_id) JOIN counts USING(category_id)
      ORDER BY latest.name,latest.category_id`,
        values,
      )
    ).rows.map((row) => ({ ...row, articleCount: Number(row.articleCount) }));
    return {
      categories,
      uncategorizedCount: Number(totals.uncategorized),
      totalArticles: Number(totals.total),
    };
  }
  async readCategories(identity: ReadIdentity) {
    return this.read((c) => this.readNavigation(c, identity, { q: "" }));
  }
  async readArticles(identity: ReadIdentity, query: unknown) {
    const q = readListSchema.parse(query);
    return this.read(async (c) => {
      const { where, values } = this.readFilter(identity, q);
      const from = `FROM wb_cms_releases r JOIN wb_cms_articles m ON m.article_id=r.article_id WHERE ${where}`;
      const total = Number(
        (await c.query(`SELECT count(*) ${from}`, values)).rows[0].count,
      );
      values.push(q.limit, q.offset);
      const items = (
        await c.query(
          `SELECT r.snapshot ${from} ORDER BY r.created_at DESC,r.id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
          values,
        )
      ).rows.map((r) => r.snapshot);
      const navigation = await this.readNavigation(c, identity, q);
      return { items, total, limit: q.limit, offset: q.offset, navigation };
    });
  }
  async readArticle(identity: ReadIdentity, id: string) {
    uuid.parse(id);
    const values: unknown[] = [];
    const where = this.readWhere(identity, values);
    values.push(id);
    const row = (
      await this.pool.query(
        `SELECT r.snapshot FROM wb_cms_releases r JOIN wb_cms_articles m ON m.article_id=r.article_id WHERE ${where} AND r.article_id=$${values.length}`,
        values,
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND");
    return row.snapshot;
  }
  async readAudio(identity: ReadIdentity, releaseId: string) {
    uuid.parse(releaseId);
    const values: unknown[] = [];
    const where = this.readWhere(identity, values);
    values.push(releaseId);
    const row = (
      await this.pool.query(
        `SELECT a.metadata,a.data FROM wb_cms_releases r JOIN wb_cms_articles m ON m.article_id=r.article_id JOIN wb_cms_media a ON a.audio_id=r.audio_id WHERE ${where} AND r.id=$${values.length}`,
        values,
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND");
    return row;
  }
  async rss(identity: ReadIdentity, origin: string) {
    const page = await this.readArticles(identity, { limit: 100 });
    const xml = (value: unknown) =>
      String(value ?? "").replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&apos;",
          })[c]!,
      );
    const items = page.items
      .map(
        (r) =>
          `<item><title>${xml(r.title)}</title><link>${xml(origin + "/v1/cms/read/articles/" + r.articleId)}</link><guid isPermaLink="false">${xml(r.id)}</guid><pubDate>${xml(new Date(r.createdAt).toUTCString())}</pubDate><description>${xml(r.cms.summary || r.text)}</description></item>`,
      )
      .join("");
    return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>TTS Workbench CMS</title><link>${xml(origin)}</link><description>Published Japanese articles</description><language>ja-JP</language>${items}</channel></rss>`;
  }
  private tokensAllowed() {
    if (!this.tokensEnabled) throw new ApiError(404, "NOT_FOUND");
  }
  async createToken(owner: string, input: unknown) {
    this.tokensAllowed();
    const dto = z
      .strictObject({
        label: name,
        expiresInSeconds: z.number().int().min(60).max(86400),
        categoryIds: ids.default([]),
      })
      .parse(input);
    return this.write(owner, async (c) => {
      const count = Number(
        (
          await c.query(
            "SELECT count(*) FROM wb_cms_read_tokens WHERE account_id=$1 AND revoked_at IS NULL AND expires_at>now()",
            [owner],
          )
        ).rows[0].count,
      );
      if (count >= 20) throw new ApiError(409, "TOKEN_LIMIT");
      for (const categoryId of dto.categoryIds)
        await this.references(c, owner, {
          slug: "token",
          summary: "",
          categoryId,
          tagIds: [],
        });
      // Opportunistic bounded cleanup avoids retaining an unlimited token audit history.
      await c.query(
        "DELETE FROM wb_cms_read_tokens WHERE account_id=$1 AND (expires_at<now()-interval '1 day' OR revoked_at<now()-interval '1 day')",
        [owner],
      );
      const token = "wb_cms_" + randomBytes(32).toString("base64url");
      const id = randomUUID(),
        expiresAt = new Date(
          Date.now() + dto.expiresInSeconds * 1000,
        ).toISOString();
      await c.query(
        "INSERT INTO wb_cms_read_tokens(id,account_id,label,token_hash,category_ids,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          owner,
          dto.label,
          createHash("sha256").update(token).digest("hex"),
          dto.categoryIds,
          expiresAt,
        ],
      );
      return {
        id,
        label: dto.label,
        expiresAt,
        categoryIds: dto.categoryIds,
        token,
      };
    });
  }
  async tokens(owner: string) {
    this.tokensAllowed();
    return {
      items: (
        await this.pool.query(
          'SELECT id,label,category_ids AS "categoryIds",expires_at AS "expiresAt",revoked_at AS "revokedAt",created_at AS "createdAt" FROM wb_cms_read_tokens WHERE account_id=$1 ORDER BY created_at DESC LIMIT 100',
          [owner],
        )
      ).rows,
    };
  }
  async revokeToken(owner: string, id: string) {
    this.tokensAllowed();
    uuid.parse(id);
    return this.write(owner, async (c) => {
      if (
        !(
          await c.query(
            "UPDATE wb_cms_read_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE account_id=$1 AND id=$2",
            [owner, id],
          )
        ).rowCount
      )
        throw new ApiError(404, "NOT_FOUND");
    });
  }
}
