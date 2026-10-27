import { clearCsrfCache, decodeAudio, json, mutation, raw } from '@workbench/api/http';
import { ServiceError, type MediaResult } from '@workbench/types';
import type {
  CmsArticle,
  Category,
  CategoryInput,
  CmsDraft,
  CmsRelease,
  CmsSummary,
  ImportInput,
  ImportPreviewItem,
  ImportResult,
  Page,
  Taxon,
  Taxonomy,
  ReadCategoryPage,
  ReadPage,
} from './types';

const root = '/v1/cms';
const path = (id: string) => `${root}/articles/${encodeURIComponent(id)}`;
const bodyOf = (draft: CmsDraft) => ({
  title: draft.title,
  text: draft.text,
  cms: {
    slug: draft.slug,
    summary: draft.summary,
    categoryId: draft.categoryId,
    tagIds: draft.tagIds,
  },
});
async function write<T>(url: string, method: string, body?: unknown): Promise<T> {
  return (await mutation(url, method, body)).json();
}
// Reading needs caller cancellation; shared raw() owns its own timeout signal.
// Keep this specialized fetch confined to immutable, authenticated reading media.
async function readMedia(release: CmsRelease, signal: AbortSignal): Promise<MediaResult> {
  const timeout = AbortSignal.timeout(120000);
  let response: Response;
  try {
    response = await fetch(`${root}/read/releases/${encodeURIComponent(release.id)}/audio`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.any([signal, timeout]),
    });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new ServiceError(
      timeout.aborted ? '音频载入超时，请重试。' : '无法载入音频，请检查连接后重试。',
    );
  }
  if (!response.ok) {
    if (response.status === 401) clearCsrfCache();
    let body: { code?: string; requestId?: string } = {};
    try {
      const value: unknown = await response.json();
      if (value && typeof value === 'object') {
        const fields = value as Record<string, unknown>;
        body = {
          code: typeof fields.code === 'string' ? fields.code : undefined,
          requestId: typeof fields.requestId === 'string' ? fields.requestId : undefined,
        };
      }
    } catch {}
    const code = body.code || `HTTP_${response.status}`;
    const message =
      response.status === 401
        ? '登录已失效，请重新登录后播放。'
        : response.status === 404
          ? '此音频已撤回或不再是当前发布，请刷新阅读库。'
          : response.status === 429
            ? '载入过于频繁，请稍后重试。'
            : '音频未能载入，请重试。';
    throw new ServiceError(
      message,
      response.status === 401 ? 'SESSION' : code,
      body.requestId || response.headers.get('X-Request-Id') || undefined,
    );
  }
  signal.throwIfAborted();
  const media = await decodeAudio(response, release.audio ?? undefined);
  signal.throwIfAborted();
  return media;
}
export const cmsHttp = {
  taxonomy: () => json<Taxonomy>(`${root}/taxonomy`),
  saveCategory: (input: CategoryInput, previous?: Category) =>
    write<Category>(
      `${root}/categories${previous ? '/' + encodeURIComponent(previous.id) : ''}`,
      previous ? 'PATCH' : 'POST',
      {
        ...input,
        ...(previous ? { expectedRevision: previous.revision } : {}),
      },
    ),
  moveCategory: (categoryId: string | null, articles: CmsSummary[]) =>
    write<{ items: CmsSummary[] }>(`${root}/articles/move-category`, 'POST', {
      categoryId,
      items: articles.map((a) => ({
        articleId: a.id,
        expectedRevision: a.revision,
        expectedCmsRevision: a.cms.revision,
      })),
    }),
  saveTaxon: (
    kind: 'categories' | 'tags',
    input: { name: string; slug: string },
    previous?: Taxon,
  ) =>
    write<Taxon>(
      `${root}/${kind}${previous ? '/' + encodeURIComponent(previous.id) : ''}`,
      previous ? 'PATCH' : 'POST',
      {
        ...input,
        ...(previous ? { expectedRevision: previous.revision } : {}),
      },
    ),
  deleteTaxon: async (kind: 'categories' | 'tags', item: Taxon) => {
    await mutation(
      `${root}/${kind}/${encodeURIComponent(item.id)}?expectedRevision=${item.revision}`,
      'DELETE',
    );
  },
  articles: (query: Record<string, string | number>) =>
    json<Page<CmsSummary>>(
      `${root}/articles?${new URLSearchParams(
        Object.entries(query)
          .filter(([, v]) => v !== '')
          .map(([k, v]) => [k, String(v)]),
      )}`,
    ),
  article: (id: string) => json<CmsArticle>(path(id)),
  create: (draft: CmsDraft) => write<CmsArticle>(`${root}/articles`, 'POST', bodyOf(draft)),
  save: (id: string, draft: CmsDraft, previous: CmsArticle) =>
    write<CmsArticle>(path(id), 'PATCH', {
      ...bodyOf(draft),
      expectedRevision: previous.revision,
      cms: { ...bodyOf(draft).cms, expectedRevision: previous.cms.revision },
    }),
  preview: (input: ImportInput) => write<ImportResult>(`${root}/import/preview`, 'POST', input),
  import: (input: ImportInput, preview: ImportPreviewItem[]) =>
    write<ImportResult>(`${root}/import`, 'POST', {
      source: input.source,
      items: input.items.map((item, i) => ({
        ...item,
        articleId: preview[i].articleId ?? null,
        expectedRevision: preview[i].expectedRevision ?? 0,
        expectedCmsRevision: preview[i].expectedCmsRevision ?? 0,
      })),
    }),
  releases: (id: string) => json<{ items: CmsRelease[] }>(`${path(id)}/releases`),
  release: (id: string, releaseId: string) =>
    json<CmsRelease>(`${path(id)}/releases/${encodeURIComponent(releaseId)}`),
  publish: (article: CmsArticle, audioId: string | null) =>
    write<CmsRelease>(`${path(article.id)}/releases`, 'POST', {
      expectedRevision: article.revision,
      expectedCmsRevision: article.cms.revision,
      expectedAudioId: audioId,
    }),
  unpublish: (article: CmsArticle) =>
    write<CmsArticle>(`${path(article.id)}/unpublish`, 'POST', {
      expectedRevision: article.revision,
      expectedCmsRevision: article.cms.revision,
    }),
  deleteRelease: async (article: CmsArticle, releaseId: string) => {
    await mutation(
      `${path(article.id)}/releases/${encodeURIComponent(releaseId)}?expectedCmsRevision=${article.cms.revision}`,
      'DELETE',
    );
  },
  releaseAudio: (id: string, release: CmsRelease) =>
    raw(`${path(id)}/releases/${encodeURIComponent(release.id)}/audio`).then((r) =>
      decodeAudio(r, release.audio ?? undefined),
    ),
  readArticles: (query: Record<string, string | number>) =>
    json<ReadPage>(
      `${root}/read/articles?${new URLSearchParams(
        Object.entries(query)
          .filter(([, v]) => v !== '')
          .map(([k, v]) => [k, String(v)]),
      )}`,
    ),
  readArticle: (id: string) => json<CmsRelease>(`${root}/read/articles/${encodeURIComponent(id)}`),
  readCategories: () => json<ReadCategoryPage>(`${root}/read/categories`),
  readAudio: (release: CmsRelease, signal?: AbortSignal) =>
    signal
      ? readMedia(release, signal)
      : raw(`${root}/read/releases/${encodeURIComponent(release.id)}/audio`).then((r) =>
          decodeAudio(r, release.audio ?? undefined),
        ),
};
