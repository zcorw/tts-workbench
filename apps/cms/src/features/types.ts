import type { components } from '@workbench/api/schema';

type Schema = components['schemas'];
export type Taxon = Schema['CmsTaxonomy'];
export type Category = Schema['CmsCategory'];
export type CategoryInput = Required<Schema['CmsCategoryInput']>;
export type Taxonomy = Schema['CmsTaxonomyPage'];
export type CmsMetadata = Schema['CmsMetadata'];
export type CmsArticle = Schema['CmsArticleDetail'];
export type CmsSummary = Schema['CmsArticleSummary'];
export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}
export interface CmsDraft {
  title: string;
  text: string;
  slug: string;
  summary: string;
  categoryId: string | null;
  tagIds: string[];
}
export type CmsRelease = Schema['CmsRelease'];
export type ReadCategory = Schema['CmsReadCategory'];
export type ReadCategoryPage = Schema['CmsReadCategoryPage'];
export type ReadPage = Schema['CmsReadPage'];
export type ImportItem = Schema['CmsImportItem'];
export type ImportPreviewItem = Schema['CmsImportResultItem'];
export type ImportInput = Schema['CmsImportPreviewInput'];
export type ImportResult = Schema['CmsImportResult'];
export interface NavigationGuard {
  dirty: boolean;
  saving: boolean;
  save: () => Promise<boolean>;
  discard: () => void;
}
export const emptyDraft = (): CmsDraft => ({
  title: '新文章',
  text: '',
  slug: '',
  summary: '',
  categoryId: null,
  tagIds: [],
});
export const draftOf = (a: CmsArticle): CmsDraft => ({
  title: a.title,
  text: a.text,
  slug: a.cms.slug,
  summary: a.cms.summary,
  categoryId: a.cms.categoryId,
  tagIds: [...a.cms.tagIds],
});
export const sameDraft = (a: CmsDraft, b: CmsDraft) => JSON.stringify(a) === JSON.stringify(b);
