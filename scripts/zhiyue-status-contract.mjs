export function addZhiyueStatusContract(api) {
  const schemas = api.components.schemas;
  const state = { type: 'string', enum: ['published', 'draft', 'all'], default: 'published' };
  const parameter = { name: 'status', in: 'query', schema: state };
  for (const name of ['ZhiyueArticleItem', 'ZhiyueArticle']) {
    schemas[name].properties.status = { type: 'string', enum: ['published', 'draft'] };
    schemas[name].properties.publishedAt.nullable = true;
    schemas[name].properties.publishedAt.description = 'Publication time; null for drafts.';
    schemas[name].properties.updatedAt = { type: 'string', format: 'date-time', description: 'Draft save time or publication snapshot time.' };
    schemas[name].required.push('status', 'updatedAt');
  }
  schemas.ZhiyueArticle.properties.releaseId = { type: 'string', description: 'Publication ID, or draft audioId when present, otherwise a draft revision handle.' };
  schemas.ZhiyueArticle.properties.contentVersion = { type: 'string', description: 'Optional content revision handle for restoring reading position.' };
  schemas.ZhiyueArticle.properties.text.description = 'Exact saved draft or current publication text; at most 49152 UTF-8 bytes.';
  schemas.ZhiyueSearchRequest.properties.status = state;
  schemas.ZhiyueSearchResult.properties.filters.properties.status = state;
  schemas.ZhiyueSearchResult.properties.filters.required.push('status');
  const list = api.paths['/v1/zhiyue/read/articles'].get;
  list.parameters.push(parameter);
  list.summary = 'List owned articles by publication status';
  list.description = 'Default published preserves frozen releases. draft means no current published release, including withdrawn articles; reads latest saved draft and live draft category. all combines each current publication and unpublished draft once. Never exposes an unpublished edit of an already-published article. Default published retains publication-time/release-ID order. draft/all sort by publication time or draft save time DESC then article ID DESC. q/category, totals, page and category navigation use the same selected status and one database snapshot. Lists omit body and audio bytes. Owner comes only from the valid device binding.';
  api.paths['/v1/zhiyue/read/articles/{id}'].get.parameters.push(parameter);
  api.paths['/v1/zhiyue/read/articles/{id}'].get.description = list.description;
  const search = api.paths['/v1/zhiyue/read/search'].post;
  search.summary = 'Search owned articles within selected publication status';
  search.description += ' Optional status defaults to published; server maps categories only within that status. Returned filters include status for subsequent pages. Status is explicit and is not decided by the semantic model.';
  api.paths['/v1/zhiyue/read/articles/{id}'].get.summary = 'Read an owned article by publication status';
  api.paths['/v1/zhiyue/media/{ticket}'].get.summary = 'Play version-scoped article MP3';
  schemas.ZhiyueAudioTicket.properties.url.description = 'Private short-lived URL scoped to one device and content version. Never persist or log it.';
  schemas.ZhiyueReadCategory = structuredClone(schemas.CmsReadCategory);
  schemas.ZhiyueReadCategory.description = 'Direct category membership within the selected device status and account. Publication aliases are frozen names; drafts use current saved categories. name/slug use the newest visible item.';
  schemas.ZhiyueReadCategoryPage = structuredClone(schemas.CmsReadCategoryPage);
  schemas.ZhiyueReadCategoryPage.description = 'Category counts and totals use the same selected article status and keyword filter. Category selection does not remove other navigation choices.';
  schemas.ZhiyueReadCategoryPage.properties.categories.items = { $ref: '#/components/schemas/ZhiyueReadCategory' };
  schemas.ZhiyueArticlePage.properties.navigation = { $ref: '#/components/schemas/ZhiyueReadCategoryPage' };
  const source = api.paths['/v1/zhiyue/read/releases/{id}/audio-ticket'].post;
  api.paths['/v1/zhiyue/read/drafts/{id}/audio-ticket'] = { post: {
    ...structuredClone(source), operationId: 'zhiyueIssueDraftAudioTicket', summary: 'Issue a version-scoped ticket for owned draft audio',
    description: 'Dedicated device Bearer; id is the owned unpublished article ID. JSON audioId must match its current last successful saved audio. No generation. Returns404 on absent/replaced audio, another owner, or a currently-published article. Ticket remains bound to this device, article and audioId; every media read rechecks them. Drafts may have stale audio as in CMS; no paid regeneration. Same byte ranges and size limits as publication media.',
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false,
      required: ['audioId'], properties: { audioId: { type: 'string', format: 'uuid' } } } } } },
  } };
  api.paths['/v1/zhiyue/media/{ticket}'].get.description += ' Draft tickets also require the source article to remain unpublished and its current saved audioId to match. Replaced/deleted/published drafts return404. Revoked binding returns401.';
  api.components.securitySchemes.zhiyueDeviceBearer.description = 'Revocable device access credential for its account: publication and explicit draft reads, version-scoped media tickets and self-revocation. No writes or synthesis. Independent of CMS publication-only read tokens.';
}
