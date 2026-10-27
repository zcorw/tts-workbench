// Kept beside the existing contract builder so all API types have one source.
export function addCmsContract({ schema, paths, op, ref, str, int, obj, uuid, time, json, errors }) {
  schema.ArticleAudio.description = 'Working article APIs retain the latest successful audio only. CMS releases separately retain selected immutable bytes, using the same actual content/rule/voice/speed metadata.';
  paths['/v1/articles/{id}'].delete.description += ' CMS1: 409 ARTICLE_HAS_RELEASES while any retained CMS release references the article. Withdraw/delete releases explicitly before deleting the original; no publication is silently destroyed.';
  const array = (items, extra = {}) => ({ type: 'array', items, ...extra });
  const maybe = (value) => ({ ...value, nullable: true });
  const slug = str({ minLength: 1, maxLength: 120, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' });
  const versions = { expectedRevision: int(1), expectedCmsRevision: int(1) };
  const id = { name: 'id', in: 'path', required: true, schema: uuid };
  const releaseId = { ...id, name: 'releaseId' };
  const articleId = { ...id, name: 'articleId' };
  const query = (name, value, required = false) => ({ name, in: 'query', schema: value, required });
  const meta = { slug, summary: str({ maxLength: 1000, default: '' }), categoryId: maybe(uuid), tagIds: array(uuid, { maxItems: 50, uniqueItems: true, default: [] }) };
  schema.CmsTaxonomy = obj({ id: uuid, name: str({ minLength: 1, maxLength: 80 }), slug, revision: int(1) });
  schema.CmsTaxonomyInput = obj({ name: schema.CmsTaxonomy.properties.name, slug });
  schema.CmsTaxonomyPatch = obj({ ...schema.CmsTaxonomyInput.properties, expectedRevision: int(1) });
  const categoryTree = { parentId: maybe(uuid), sortOrder: { ...int(), maximum: 2147483647 } };
  schema.CmsCategory = obj({ ...schema.CmsTaxonomy.properties, ...categoryTree, articleCount: int(), childrenCount: int() });
  schema.CmsCategory.description = 'Owned working category. Counts include direct members/children only, not descendants. Hierarchy changes never rewrite frozen publication membership or broaden read-token scopes.';
  schema.CmsCategoryInput = obj({ ...schema.CmsTaxonomyInput.properties, parentId: { ...categoryTree.parentId, default: null }, sortOrder: { ...categoryTree.sortOrder, default: 0 } }, ['name','slug']);
  schema.CmsCategoryPatch = obj({ ...schema.CmsTaxonomyInput.properties, ...categoryTree, expectedRevision: int(1) }, ['name','slug','expectedRevision']);
  schema.CmsCategoryPatch.description = 'Conditional category update. Omitted parentId/sortOrder retain current values; explicit null makes a root. Parent must be an owned category. Self/ancestor cycles return CATEGORY_CYCLE. Same-owner writes serialize, including concurrent reparenting.';
  schema.CmsTaxonomyPage = obj({ categories: array(ref('CmsCategory')), tags: array(ref('CmsTaxonomy')), uncategorizedCount: int(), totalArticles: int() });
  schema.CmsTaxonomyPage.description = 'One read snapshot of category tree, direct category counts and totals. Uncategorized includes all owned workbench articles with no CMS metadata or null category.';
  schema.CmsMetadataInput = obj(meta, ['slug']);
  schema.CmsMetadata = obj({ ...meta, slug: str({ maxLength: 120 }), revision: int(0), publishedReleaseId: maybe(uuid), source: obj({ source: str(), externalId: str() }) }, ['slug', 'summary', 'categoryId', 'tagIds', 'revision', 'publishedReleaseId']);
  schema.CmsArticleInput = obj({ ...schema.ArticleInput.properties, cms: ref('CmsMetadataInput') });
  schema.CmsArticlePatch = obj({ ...schema.ArticlePatch.properties, cms: obj({ ...meta, expectedRevision: int(0) }, ['slug', 'expectedRevision']) });
  schema.CmsArticleSummary = obj({ ...schema.ArticleSummary.properties, cms: ref('CmsMetadata') });
  schema.CmsArticleDetail = obj({ ...schema.ArticleDetail.properties, cms: ref('CmsMetadata') });
  schema.CmsArticlePage = obj({ items: array(ref('CmsArticleSummary')), total: int(), offset: int(), limit: int(1) });
  schema.CmsMoveCategoryItem = obj({ articleId: uuid, expectedRevision: int(1), expectedCmsRevision: int() });
  schema.CmsMoveCategoryInput = obj({ categoryId: maybe(uuid), items: array(ref('CmsMoveCategoryItem'), { minItems: 1, maxItems: 100, description: 'articleId must be unique within the batch.' }) });
  schema.CmsMoveCategoryResult = obj({ items: array(ref('CmsArticleSummary'), { maxItems: 100 }) });
  schema.CmsPublishedMetadata = obj({ slug, summary: str(), category: maybe(schema.CmsTaxonomy), tags: array(ref('CmsTaxonomy')) });
  schema.CmsRelease = obj({ id: uuid, articleId: uuid, createdAt: time, articleRevision: int(1), contentRevision: int(1), cmsRevision: int(1), title: schema.ArticleInput.properties.title, text: schema.ArticleInput.properties.text, cms: ref('CmsPublishedMetadata'), audio: maybe(schema.ArticleAudio) });
  schema.CmsReleasePage = obj({ items: array(ref('CmsRelease')) });
  schema.CmsReadCategory = obj({ id: uuid, name: schema.CmsTaxonomy.properties.name, slug, names: array(schema.CmsTaxonomy.properties.name, { minItems: 1, uniqueItems: true }), articleCount: int(1) });
  schema.CmsReadCategory.description = 'Direct frozen category membership among current authorized publications only. name/slug come from the newest current release by createdAt/id; names lists distinct current snapshot names newest first. No draft taxonomy, hierarchy or empty management category is exposed.';
  schema.CmsReadCategoryPage = obj({ categories: array(ref('CmsReadCategory')), uncategorizedCount: int(), totalArticles: int() });
  schema.CmsReadCategoryPage.description = 'Counts sum to totalArticles within the same current-publication/read-credential scope. An uncategorized publication has a null frozen category. Nonempty leaf credential scopes never include uncategorized or descendants.';
  schema.CmsReadPage = obj({ items: array(ref('CmsRelease')), total: int(), offset: int(), limit: int(1), navigation: ref('CmsReadCategoryPage') });
  schema.CmsReadPage.description = 'Items, filtered total and navigation are read in one REPEATABLE READ transaction. Navigation applies the same q/tag and authorization scope, but ignores category and pagination. A selected direct category count therefore matches total; navigation is stable across pages of the same snapshot.';
  schema.CmsPublish = obj({ ...versions, expectedAudioId: maybe(uuid) });
  schema.CmsUnpublish = obj(versions);
  const imported = { ...schema.ArticleInput.properties, ...meta, externalId: str({ minLength: 1, maxLength: 200 }) };
  schema.CmsImportItem = obj(imported, ['externalId', 'title', 'text', 'slug']);
  schema.CmsImportCommitItem = obj({ ...imported, articleId: maybe(uuid), expectedRevision: int(), expectedCmsRevision: int() }, ['externalId', 'title', 'text', 'slug', 'articleId', 'expectedRevision', 'expectedCmsRevision']);
  schema.CmsImportPreviewInput = obj({ source: str({ minLength: 1, maxLength: 100 }), items: array(ref('CmsImportItem'), { minItems: 1, maxItems: 20 }) });
  schema.CmsImportCommitInput = obj({ source: schema.CmsImportPreviewInput.properties.source, items: array(ref('CmsImportCommitItem'), { minItems: 1, maxItems: 20 }) });
  schema.CmsImportResultItem = obj({ externalId: str(), status: str({ enum: ['create', 'update', 'created', 'updated', 'unchanged', 'error'] }), articleId: maybe(uuid), expectedRevision: int(), expectedCmsRevision: int(), revision: int(1), cmsRevision: int(1), errors: array(str()) }, ['externalId', 'status']);
  schema.CmsImportResult = obj({ items: array(ref('CmsImportResultItem')) });
  schema.CmsReadTokenInput = obj({ label: str({ minLength: 1, maxLength: 80 }), expiresInSeconds: { ...int(60), maximum: 86400 }, categoryIds: array(uuid, { maxItems: 50, uniqueItems: true, default: [] }) }, ['label', 'expiresInSeconds']);
  schema.CmsReadToken = obj({ id: uuid, label: str(), categoryIds: array(uuid), expiresAt: time, revokedAt: maybe(time), createdAt: time });
  schema.CmsReadTokenCreated = obj({ id: uuid, label: str(), categoryIds: array(uuid), expiresAt: time, token: str({ description: 'Shown once. Short-lived read-only bearer; never accepted by draft/edit/TTS APIs. Store a SHA-256 digest only.' }) });
  schema.CmsReadTokenPage = obj({ items: array(ref('CmsReadToken')) });
  const common = { extra: { '404': errors['404'], '409': errors['409'] } };
  const empty = { description: 'Completed', headers: { 'Cache-Control': { schema: str({ enum: ['no-store'] }) } } };
  const filters = [query('q', str({ maxLength: 120 })), query('category', uuid), query('tag', uuid), query('limit', { ...int(1), maximum: 100, default: 20 }), query('offset', { ...int(), default: 0 })];
  const managementFilters = filters.map(filter => filter.name === 'category' ? { ...filter, schema: { oneOf: [uuid, str({ enum: ['uncategorized'] })] }, description: 'Exact direct category ID, or uncategorized including articles without CMS metadata. Does not include descendants.' } : filter);
  const readingFilters = filters.map(filter => filter.name === 'category' ? { ...filter, schema: { oneOf: [uuid, str({ enum: ['uncategorized'] })] }, description: 'Exact frozen direct category ID, or uncategorized. No latest draft/tree lookup and no descendant expansion. Unknown/empty category IDs return an empty list.' } : filter);
  op('/v1/cms/taxonomy', 'get', 'cmsTaxonomy', 'Owned categories and tags', json('CmsTaxonomyPage'));
  for (const kind of ['categories', 'tags']) {
    const path = '/v1/cms/' + kind;
    const category = kind === 'categories';
    op(path, 'post', 'cmsCreate' + kind, 'Create owned ' + kind, json(category ? 'CmsCategory' : 'CmsTaxonomy'), { ...common, input: category ? 'CmsCategoryInput' : 'CmsTaxonomyInput', write: true, status: '201', description: category ? 'Parent defaults to null and sortOrder to 0. Parent must be an owned category; no tag/cross-account reference. CATEGORY_CYCLE rejects cycles.' : '' });
    op(path + '/{id}', 'patch', 'cmsUpdate' + kind, 'Conditionally update ' + kind, json(category ? 'CmsCategory' : 'CmsTaxonomy'), { ...common, input: category ? 'CmsCategoryPatch' : 'CmsTaxonomyPatch', write: true, parameters: [id], description: category ? 'expectedRevision prevents lost updates; omitted parentId/sortOrder retain current values. Self/ancestor cycle returns409 CATEGORY_CYCLE, including concurrent reciprocal reparenting.' : '' });
    op(path + '/{id}', 'delete', 'cmsDelete' + kind, 'Delete unused ' + kind, empty, { ...common, write: true, status: '204', parameters: [id, query('expectedRevision', int(1), true)], description: '409 TAXONOMY_IN_USE while referenced by a draft or, for categories, any direct child category. No cascading category/article deletion. Published snapshots retain their frozen names and membership.' });
  }
  op('/v1/cms/articles', 'get', 'cmsArticles', 'Search owned platform articles with CMS metadata', json('CmsArticlePage'), { parameters: [...managementFilters, query('status', str({ enum: ['draft', 'published'] }))], description: 'Search title, original text and summary. category is exact direct membership or uncategorized; no descendant expansion. List excludes original text and audio bytes. No metadata gives cms.revision=0. Publishing does not make content anonymous.' });
  op('/v1/cms/articles', 'post', 'cmsCreateArticle', 'Create article and CMS metadata atomically', json('CmsArticleDetail'), { ...common, input: 'CmsArticleInput', write: true, status: '201' });
  op('/v1/cms/articles/move-category', 'post', 'cmsMoveArticleCategory', 'Move owned articles to one category atomically', json('CmsMoveCategoryResult'), { ...common, input: 'CmsMoveCategoryInput', write: true, description: '1–100 unique owned article IDs. Validate target category and every article expectedRevision/CMS expectedCmsRevision before any update. Any missing/not-owned/stale item rolls back the entire batch (404 NOT_FOUND, 409 REVISION_CONFLICT/CMS_REVISION_CONFLICT); invalid target is400 INVALID_REQUEST. Changes only working CMS category and increments CMS revision only when needed. Preserves original revision/contentRevision/updatedAt, text, audio metadata/bytes, tags, summary, slug and publication pointer/snapshot. No TTS. Same-category moves are no-op. A metadata-less article moved to null remains revision0; moving it into a category creates safe unique CMS slug/empty summary/tags at revision1 without rewriting original content. Read-token/frozen release scopes do not change.' });
  op('/v1/cms/articles/{id}', 'get', 'cmsGetArticle', 'Owned working article', json('CmsArticleDetail'), { ...common, parameters: [id] });
  op('/v1/cms/articles/{id}', 'patch', 'cmsUpdateArticle', 'Atomically save original text and CMS metadata', json('CmsArticleDetail'), { ...common, input: 'CmsArticlePatch', write: true, parameters: [id], description: 'Both expectedRevision and cms.expectedRevision must match in one transaction. Any conflict rolls back both changes. Taxonomy-only saves do not change contentRevision or stale audio. Keep draft on 409; never automatically fetch a new revision and retry a write.' });
  for (const preview of [true, false]) {
    op('/v1/cms/import' + (preview ? '/preview' : ''), 'post', preview ? 'cmsPreviewImport' : 'cmsCommitImport', preview ? 'Validate JSON import without writes' : 'Commit explicitly reviewed import items', json('CmsImportResult'), { input: preview ? 'CmsImportPreviewInput' : 'CmsImportCommitInput', write: true, description: 'At most 20 items and 1MiB JSON. source/externalId identifies one owned platform article. Per-item errors and partial success are explicit. Preview supplies articleId and both expected revisions (null/0/0 for create). Commit rechecks all three; concurrent changes return per-item IMPORT_CONFLICT without overwriting. Duplicate externalId within a batch is an error. Never publishes or calls TTS.' });
  }
  op('/v1/cms/articles/{id}/releases', 'get', 'cmsReleases', 'Owned immutable release history', json('CmsReleasePage'), { ...common, parameters: [id] });
  op('/v1/cms/articles/{id}/releases', 'post', 'cmsPublish', 'Publish fixed content to the private reading library', json('CmsRelease'), { ...common, input: 'CmsPublish', write: true, status: '201', parameters: [id], description: 'Checks original revision, CMS revision and exact current audio ID. A non-null audio must match current content/rules; null explicitly publishes text only. Freezes text, title, category/tag names and membership, plus selected audio bytes. Does not call TTS. Maximum 10 explicit releases per article; publishing increments CMS revision, not original revision. Next working audio replacement cannot destroy release bytes.' });
  op('/v1/cms/articles/{id}/unpublish', 'post', 'cmsUnpublish', 'Withdraw current private release', json('CmsArticleDetail'), { ...common, input: 'CmsUnpublish', write: true, parameters: [id], description: 'Current read API/RSS/media stop exposing the article. Owned history remains until explicitly deleted.' });
  op('/v1/cms/articles/{id}/releases/{releaseId}', 'get', 'cmsRelease', 'Read owned historical release', json('CmsRelease'), { ...common, parameters: [id, releaseId] });
  op('/v1/cms/articles/{id}/releases/{releaseId}', 'delete', 'cmsDeleteRelease', 'Delete a noncurrent release and unreferenced media', empty, { ...common, write: true, status: '204', parameters: [id, releaseId, query('expectedCmsRevision', int(1), true)], description: 'Current release must first be withdrawn. Ordinary platform article deletion is blocked while releases exist.' });
  const media = { description: 'Fixed complete MP3; no provider request. Cache-Control no-store. Content-Disposition filename matches the immutable audio metadata filename.', content: { 'audio/mpeg': { schema: str({ format: 'binary' }) } } };
  op('/v1/cms/articles/{id}/releases/{releaseId}/audio', 'get', 'cmsReleaseAudio', 'Read owned historical audio bytes', media, { ...common, parameters: [id, releaseId] });
  op('/v1/cms/read/articles', 'get', 'cmsReadArticles', 'Read only current published releases', json('CmsReadPage'), { parameters: readingFilters, description: 'Returns one consistent read snapshot of items/count and navigation. Navigation groups exact frozen leaf IDs across matching q/tag publications, ignoring the selected category and page. category=uncategorized selects null frozen membership; empty/unknown UUID categories return total0. Uses original release text/audio without truncation or mutation.' });
  op('/v1/cms/read/categories', 'get', 'cmsReadCategories', 'Current publication category navigation', json('CmsReadCategoryPage'), { description: 'Complete unfiltered current-publication navigation for the authorized owner/leaf scope. Names and slugs come only from frozen current releases, latest by createdAt/id; distinct names support rename aliases. Deleted or renamed draft categories do not remove or rewrite published membership. Does not read draft-only or empty management categories and does not invent a parent tree.' });
  op('/v1/cms/read/articles/{articleId}', 'get', 'cmsReadArticle', 'Read current fixed published article', json('CmsRelease'), { ...common, parameters: [articleId] });
  op('/v1/cms/read/releases/{releaseId}/audio', 'get', 'cmsReadAudio', 'Read current published fixed audio', media, { ...common, parameters: [releaseId] });
  op('/v1/cms/read/rss', 'get', 'cmsRss', 'Authenticated Japanese publication RSS', { description: 'Up to 100 current owned/scoped releases; escaped RSS 2.0, no draft text, no credentials in URLs.', content: { 'application/rss+xml': { schema: str() } } });
  for (const path of Object.keys(paths).filter(p => p.startsWith('/v1/cms/read/'))) {
    paths[path].get.security = [{ sessionCookie: [] }, { cmsReadBearer: [] }];
    paths[path].get.description += ' Requires a current owner session or an unexpired/unrevoked CMS read bearer. Category scope is applied against frozen release membership. No anonymous access; bearer never grants draft or TTS access. Withdrawn/superseded releases are not available through this current-publication API; owners retain separate history access.';
  }
  op('/v1/cms/read-tokens', 'get', 'cmsReadTokens', 'List own read credential metadata', json('CmsReadTokenPage'), { extra: { '404': errors['404'] }, description: 'Disabled with 404 unless CMS_READ_TOKENS_ENABLED is explicitly enabled. This setting and real credential provisioning require operator approval. Never returns token hashes or bearer values.' });
  op('/v1/cms/read-tokens', 'post', 'cmsCreateReadToken', 'Create an explicitly approved short-lived read credential', json('CmsReadTokenCreated'), { ...common, input: 'CmsReadTokenInput', write: true, status: '201', description: 'Default disabled with 404. Session/CSRF required, never allowed by read bearer. Maximum 24h, no refresh credential. Empty categoryIds allows all current publications of this owner, otherwise only specified owned categories. Real provisioning is outside unapproved local development.' });
  op('/v1/cms/read-tokens/{id}', 'delete', 'cmsRevokeReadToken', 'Revoke an owned read credential', empty, { ...common, write: true, status: '204', parameters: [id] });
}
