// 在既有知阅设备协议上增加只读语音检索，不改变凭据协议。
export function addZhiyueSearchContract(api) {
  const schema = api.components.schemas;
  const ref = (name) => ({ $ref: "#/components/schemas/" + name });
  const str = (extra = {}) => ({ type: "string", ...extra });
  const obj = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
  const category = str({ description: "Exact published category UUID, uncategorized, or empty string for no category filter." });
  const filters = obj({ q: str({ maxLength: 120 }), category });
  const page = schema.ZhiyueArticlePage;
  schema.ZhiyueArticleItem.properties.category = schema.CmsPublishedMetadata.properties.category;
  schema.ZhiyueArticle.properties.category = schema.CmsPublishedMetadata.properties.category;
  page.properties.navigation = ref("CmsReadCategoryPage");
  schema.ZhiyueSearchRequest = obj({ text: str({ minLength: 1, maxLength: 200 }) });
  schema.ZhiyueSearchResult = obj({
    items: page.properties.items, total: page.properties.total, limit: { type: "integer", enum: [12] }, offset: { type: "integer", enum: [0] },
    filters, label: str(), kind: str({ enum: ["article", "category", "all"] }), noMatch: { type: "boolean" },
    resolvedBy: str({ enum: ["openai", "local", "fallback"] }),
  });
  schema.ZhiyueSearchResult.properties.categoryQuery = str({ maxLength: 120, description: "Extracted category name for repeatable candidate selection. Present for category results." });
  schema.ZhiyueSearchResult.properties.categoryCandidates = { type: "array", minItems: 2,
    description: "Authorized published-category matches, exact matches first. Present only when selection is required; article items and filters are empty.",
    items: obj({ id: category, name: str(), articleCount: { type: "integer", minimum: 1 } }) };
  const list = api.paths["/v1/zhiyue/read/articles"].get;
  list.description = (list.description ?? "") + " For Zhiyue only, q matches published titles by case-insensitive NFKC substring, with exact titles ranked first and stable publication/id tie breaks. Body and summary are not searched. " ;
  list.parameters.push(
    { name: "q", in: "query", schema: str({ maxLength: 120 }) },
    { name: "category", in: "query", schema: str({ description: "Exact frozen category UUID or uncategorized." }) },
  );
  const json = (name) => ({ description: "Success", content: { "application/json": { schema: ref(name) } } });
  api.paths["/v1/zhiyue/read/search"] = { post: {
    operationId: "zhiyueSearchArticles", summary: "Search owned publications using recognized speech text",
    description: "Dedicated device Bearer required. Only recognized text is sent to optional OpenAI Responses; no audio, category catalog, article body, account or device credential is sent. Category names map locally to current authorized frozen publication categories and aliases. Rechecks authorization after semantic resolution. Six-second semantic deadline falls back to local parsing. Category names and historical aliases support normalized substrings. Multiple categories return categoryCandidates with exact matches first, empty article items and filters, noMatch=false; the client must choose an exact category ID. Unknown categories return noMatch and zero results; the client can show all authorized categories. Category results include categoryQuery. Article q matches title substrings only, exact titles first. First page has limit12; reuse filters for subsequent GET pages without another model call. Requires ZHIYUE_OPENAI_API_KEY and ZHIYUE_OPENAI_MODEL to enable semantics. IP limit12/minute. Feature remains gated by CMS_ZHIYUE_ENABLED.",
    security: list.security, requestBody: { required: true, content: { "application/json": { schema: ref("ZhiyueSearchRequest") } } },
    responses: { ...list.responses, "200": json("ZhiyueSearchResult"),
      "413": { description: "Request body exceeds 1024 bytes." }, "415": { description: "Expected application/json." } },
  } };
}
