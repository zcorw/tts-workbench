import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ApiError } from "./errors.js";

export const articleStatus = z.enum(["published", "draft", "all"]);
export type ArticleStatus = z.infer<typeof articleStatus>;
const querySchema = z.strictObject({
  status: articleStatus.default("published"), q: z.string().max(120).refine((value) => !value.includes("\0")).default(""),
  category: z.union([z.uuid(), z.literal("uncategorized")]).optional(),
  limit: z.number().int().min(1).max(20).default(12), offset: z.number().int().min(0).default(0),
});
// 专用于账号本人批准的设备授权；不扩展普通 CMS 发布阅读令牌的权限。
export class ZhiyueContentService {
  constructor(private pool: Pool) {}
  private visible(status: ArticleStatus) {
    const published = `SELECT r.article_id AS id,r.snapshot->>'title' AS title,r.snapshot->>'text' AS text,
      r.snapshot->'cms'->>'summary' AS summary,r.snapshot->'cms'->'category' AS category,
      r.created_at AS sort_at,r.created_at AS published_at,r.created_at AS updated_at,
      'published'::text AS status,r.id::text AS release_id,r.id::text AS content_version,
      (r.snapshot->'audio' IS NOT NULL AND r.snapshot->'audio'<>'null'::jsonb) AS has_audio
      FROM wb_cms_releases r JOIN wb_cms_articles m ON m.article_id=r.article_id
      WHERE r.account_id=$1 AND m.account_id=$1 AND m.published_release_id=r.id`;
    const draft = `SELECT a.id,a.title,a.text,m.summary,
      CASE WHEN t.id IS NULL THEN NULL ELSE jsonb_build_object('id',t.id,'name',t.name,'slug',t.slug,'revision',t.revision) END,
      a.updated_at,NULL::timestamptz,a.updated_at,'draft'::text,
      COALESCE(au.metadata->>'audioId','draft:'||a.id::text||':'||a.revision::text),
      'draft:'||a.id::text||':'||a.revision::text,au.article_id IS NOT NULL
      FROM wb_articles a LEFT JOIN wb_cms_articles m ON m.article_id=a.id AND m.account_id=$1
      LEFT JOIN wb_cms_taxonomy t ON t.id=m.category_id AND t.account_id=$1 AND t.kind='category'
      LEFT JOIN wb_article_audio au ON au.article_id=a.id
      WHERE a.account_id=$1 AND m.published_release_id IS NULL`;
    return status === "published" ? published : status === "draft" ? draft : published + " UNION ALL " + draft;
  }
  private async read<T>(fn: (c: PoolClient) => Promise<T>) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const value = await fn(c); await c.query("COMMIT"); return value;
    } catch (error) { await c.query("ROLLBACK"); throw error; }
    finally { c.release(); }
  }
  async list(owner: string, query: unknown) {
    const q = querySchema.parse(query);
    return this.read(async (c) => {
      const prefix = `WITH visible(id,title,text,summary,category,sort_at,published_at,updated_at,status,release_id,content_version,has_audio) AS (${this.visible(q.status)}), matched AS (
        SELECT * FROM visible WHERE strpos(lower(concat_ws(' ',title,text,summary)),lower($2))>0)`;
      const values: unknown[] = [owner, q.q];
      let where = "";
      if (q.category === "uncategorized") where = " WHERE category->>'id' IS NULL";
      else if (q.category) { values.push(q.category); where = " WHERE category->>'id'=$3"; }
      const total = Number((await c.query(prefix + " SELECT count(*) FROM matched" + where, values)).rows[0].count);
      values.push(q.limit, q.offset);
      const items = (await c.query(prefix + ` SELECT id,title,published_at AS "publishedAt",updated_at AS "updatedAt",
        status,has_audio AS "hasAudio",category FROM matched${where}
        ORDER BY sort_at DESC,id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values)).rows;
      const navigationRows = (await c.query(prefix + ` SELECT category->>'id' AS id,
        (array_agg(category->>'name' ORDER BY sort_at DESC,id DESC))[1] AS name,
        (array_agg(category->>'slug' ORDER BY sort_at DESC,id DESC))[1] AS slug,
        array_agg(DISTINCT category->>'name') AS names,count(*)::integer AS "articleCount"
        FROM matched GROUP BY category->>'id' ORDER BY name,id`, [owner, q.q])).rows;
      const navigation = { categories: navigationRows.filter((row) => row.id !== null),
        uncategorizedCount: navigationRows.find((row) => row.id === null)?.articleCount ?? 0,
        totalArticles: navigationRows.reduce((sum, row) => sum + row.articleCount, 0) };
      return { items, total, limit: q.limit, offset: q.offset, navigation };
    });
  }
  async categories(owner: string, status: ArticleStatus) {
    return (await this.list(owner, { status, limit: 1 })).navigation;
  }
  async article(owner: string, id: string, status: ArticleStatus) {
    z.uuid().parse(id);
    const row = (await this.pool.query(`WITH visible(id,title,text,summary,category,sort_at,published_at,updated_at,status,release_id,content_version,has_audio) AS (${this.visible(status)})
      SELECT id,title,text,published_at AS "publishedAt",updated_at AS "updatedAt",status,
        has_audio AS "hasAudio",category,release_id AS "releaseId",content_version AS "contentVersion"
      FROM visible WHERE id=$2`, [owner, id])).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND");
    return row;
  }
  async draftAudio(owner: string, articleId: string, audioId?: string, mode: "id" | "length" | "all" | { start: number; end: number } = "id") {
    z.uuid().parse(articleId);
    if (audioId !== undefined) z.uuid().parse(audioId);
    const values: unknown[] = [owner, articleId];
    let projection = mode === "id" ? `au.metadata->>'audioId' AS "audioId"` : mode === "length" ? "octet_length(au.data) AS length" : "au.data";
    if (typeof mode === "object") {
      values.push(mode.start + 1, mode.end - mode.start + 1);
      projection = "substring(au.data FROM $3::integer FOR $4::integer) AS data";
    }
    let match = "";
    if (audioId !== undefined) { values.push(audioId); match = ` AND au.metadata->>'audioId'=$${values.length}`; }
    const row = (await this.pool.query(`SELECT ${projection} FROM wb_articles a
      LEFT JOIN wb_cms_articles m ON m.article_id=a.id
      JOIN wb_article_audio au ON au.article_id=a.id
      WHERE a.account_id=$1 AND a.id=$2 AND m.published_release_id IS NULL${match}`, values)).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND");
    return row;
  }
}
