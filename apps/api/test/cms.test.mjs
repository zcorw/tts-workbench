import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createApplication } from "../dist/app.js";
import { readConfig } from "../dist/config.js";
import { migrate } from "../dist/migrate.js";

const url = process.env.TEST_DATABASE_URL;
const tone = await readFile(new URL("../../web/qa/tone.mp3", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const env = {
  SESSION_SECRET: "cms-isolated-test-only-session-secret-20261027",
  PUBLIC_ORIGIN: "http://127.0.0.1:4381",
  NODE_ENV: "test",
  REGISTRATION_ENABLED: "true",
  TTS_AZURE_SPEECH_KEY: "fixture-only",
  TTS_AZURE_JA_VOICE_ID: "fixture-ja-voice",
};

test("CMS read credential provisioning defaults to disabled", () => {
  assert.equal(
    readConfig({ ...env, DATABASE_URL: "postgresql://fixture:fixture@localhost/cms_test" })
      .CMS_READ_TOKENS_ENABLED,
    false,
  );
});

test("CMS: real PG atomic editing, imports, fixed releases and scoped read-only access", { skip: !url }, async (t) => {
  await migrate(url);
  await migrate(url);
  const nativeFetch = globalThis.fetch;
  let providerFail = false;
  let providerBytes = tone;
  let providerCalls = 0;
  globalThis.fetch = async (target) => {
    if (!String(target).startsWith("https://japaneast.tts.speech.microsoft.com/"))
      throw new Error("Unexpected external request; CMS test does not allow network TTS");
    providerCalls++;
    return providerFail
      ? new Response("Explicit fixture failure", { status: 400 })
      : new Response(providerBytes, { headers: { "Content-Type": "audio/mpeg" } });
  };
  const config = readConfig({ ...env, DATABASE_URL: url, CMS_READ_TOKENS_ENABLED: "true" });
  let runtime = await createApplication(config);
  let base;
  const owners = [];
  const start = async () => {
    await runtime.app.listen(0, "127.0.0.1");
    base = await runtime.app.getUrl();
  };
  async function request(path, { method = "GET", body, cookie = "", csrf = "", bearer, validCsrf = true } = {}) {
    const response = await nativeFetch(base + path, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(method === "GET" ? {} : {
          Origin: config.PUBLIC_ORIGIN,
          "Content-Type": "application/json",
          "X-CSRF-Token": validCsrf ? csrf : "invalid-csrf",
        }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const mime = response.headers.get("Content-Type") || "";
    const data = response.status === 204 ? null
      : mime.startsWith("audio/") ? Buffer.from(await response.arrayBuffer())
      : mime.includes("json") ? await response.json() : await response.text();
    return { status: response.status, data, headers: response.headers };
  }
  async function browser() {
    let cookie = "", csrf = "";
    const call = async (path, method = "GET", body, validCsrf = true) => {
      const response = await request(path, { method, body, cookie, csrf, validCsrf });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) cookie = cookies.map((c) => c.split(";")[0]).join("; ");
      if (response.data?.csrfToken) csrf = response.data.csrfToken;
      return response;
    };
    await call("/v1/auth/csrf");
    const login = `cms-${randomUUID()}`, password = "Fixture8!";
    const account = await call("/v1/auth/register", "POST", { login, password, displayName: "CMS test only" });
    assert.equal(account.status, 201);
    owners.push(account.data.id);
    assert.equal((await call("/v1/auth/login", "POST", { login, password })).status, 200);
    await call("/v1/auth/csrf");
    return { call, owner: account.data.id };
  }
  const cmsInput = (article, changes = {}, metadata = {}) => ({
    title: article.title,
    text: article.text,
    expectedRevision: article.revision,
    ...changes,
    cms: {
      expectedRevision: article.cms.revision,
      slug: article.cms.slug,
      summary: article.cms.summary,
      categoryId: article.cms.categoryId,
      tagIds: article.cms.tagIds,
      ...metadata,
    },
  });
  try {
    await start();
    const a = await browser(), b = await browser();
    const suffix = randomUUID().slice(0, 8);
    let category, secondCategory, tag, article, firstRelease, originalAudio;
    await t.test("Private taxonomy and article creation retain exact Japanese text", async () => {
      assert.equal((await request("/v1/cms/articles")).status, 401);
      assert.equal((await request("/v1/cms/read/articles")).status, 401);
      const createCategory = await a.call("/v1/cms/categories", "POST", { name: "日本語", slug: `japanese-${suffix}` });
      assert.equal(createCategory.status, 201);
      category = createCategory.data;
      secondCategory = (await a.call("/v1/cms/categories", "POST", { name: "随筆", slug: `essays-${suffix}` })).data;
      tag = (await a.call("/v1/cms/tags", "POST", { name: "朝", slug: `morning-${suffix}` })).data;
      assert.equal((await a.call("/v1/cms/categories", "POST", { name: "CSRF", slug: `csrf-${suffix}` }, false)).status, 403);
      assert.equal((await b.call("/v1/cms/taxonomy")).data.categories.length, 0);
      const text = "日本橋の朝。\nか\u3099😀\t原文 & <script>text</script> ]]>\n\n";
      const created = await a.call("/v1/cms/articles", "POST", {
        title: "日文の朝",
        text,
        cms: { slug: `morning-story-${suffix}`, summary: "私有文章", categoryId: category.id, tagIds: [tag.id] },
      });
      assert.equal(created.status, 201);
      article = created.data;
      assert.equal(article.text, text);
      assert.equal(article.revision, 1);
      assert.equal(article.cms.categoryId, category.id);
      assert.deepEqual(article.cms.tagIds, [tag.id]);
      assert.equal((await a.call(`/v1/articles/${article.id}`)).data.text, text);
      assert.equal((await b.call(`/v1/cms/articles/${article.id}`)).status, 404);
      assert.equal((await b.call("/v1/cms/articles", "POST", {
        title: "不可", text: "越権", cms: { slug: `forbidden-${suffix}`, summary: "", categoryId: category.id, tagIds: [] },
      })).status, 400);
      assert.equal((await a.call(`/v1/cms/categories/${category.id}?expectedRevision=${category.revision}`, "DELETE")).status, 409);
      const filtered = await a.call(`/v1/cms/articles?category=${category.id}&tag=${tag.id}&q=${encodeURIComponent("原文")}`);
      assert.equal(filtered.status, 200);
      assert.equal(filtered.data.total, 1);
      assert.equal(filtered.data.items[0].id, article.id);
    });
    await t.test("Platform and CMS concurrent saves are conditional and aggregate writes are atomic", async () => {
      const revisions = article;
      const [platform, cms] = await Promise.all([
        a.call(`/v1/articles/${article.id}`, "PATCH", { title: "旧工作台の変更", text: article.text, expectedRevision: revisions.revision }),
        a.call(`/v1/cms/articles/${article.id}`, "PATCH", cmsInput(revisions, { title: "CMSの変更" }, { summary: "CMS atomic change" })),
      ]);
      assert.deepEqual([platform.status, cms.status].sort(), [200, 409]);
      const current = (await a.call(`/v1/cms/articles/${article.id}`)).data;
      assert.equal(current.title, platform.status === 200 ? "旧工作台の変更" : "CMSの変更");
      assert.equal(current.cms.summary, cms.status === 200 ? "CMS atomic change" : revisions.cms.summary);
      const rejected = await a.call(`/v1/cms/articles/${article.id}`, "PATCH", cmsInput(current, { title: "must not commit" }, {
        expectedRevision: current.cms.revision + 9, summary: "must not commit",
      }));
      assert.equal(rejected.status, 409);
      const retained = (await a.call(`/v1/cms/articles/${article.id}`)).data;
      assert.equal(retained.title, current.title);
      assert.equal(retained.cms.summary, current.cms.summary);
      article = retained;
    });
    await t.test("JSON import previews errors, deduplicates stable identities and refuses stale updates", async () => {
      const source = `fixture-${suffix}`;
      const item = { externalId: "story-001", title: "輸入記事", text: "手入力と並列の入口。\nか\u3099", slug: `import-${suffix}`, categoryId: category.id, tagIds: [tag.id] };
      const preview = await a.call("/v1/cms/import/preview", "POST", { source, items: [item, { ...item, externalId: "invalid", text: "\u0000" }] });
      assert.equal(preview.status, 200);
      assert.equal(preview.data.items[0].status, "create");
      assert.equal(preview.data.items[1].status, "error");
      const initial = { ...item, articleId: null, expectedRevision: 0, expectedCmsRevision: 0 };
      const committed = await a.call("/v1/cms/import", "POST", { source, items: [initial] });
      assert.equal(committed.status, 200);
      assert.equal(committed.data.items[0].status, "created");
      const importedId = committed.data.items[0].articleId;
      const same = await a.call("/v1/cms/import/preview", "POST", { source, items: [item] });
      assert.equal(same.data.items[0].status, "unchanged");
      const token = same.data.items[0];
      const unchanged = await a.call("/v1/cms/import", "POST", { source, items: [{ ...item, articleId: importedId, expectedRevision: token.expectedRevision, expectedCmsRevision: token.expectedCmsRevision }] });
      assert.equal(unchanged.data.items[0].status, "unchanged");
      const updateItem = { ...item, text: "インポート予定の更新。" };
      const updatePreview = (await a.call("/v1/cms/import/preview", "POST", { source, items: [updateItem] })).data.items[0];
      assert.equal(updatePreview.status, "update");
      const before = (await a.call(`/v1/articles/${importedId}`)).data;
      assert.equal((await a.call(`/v1/articles/${importedId}`, "PATCH", { title: before.title, text: "別の窓が保存した内容。", expectedRevision: before.revision })).status, 200);
      const conflict = await a.call("/v1/cms/import", "POST", { source, items: [{ ...updateItem, articleId: importedId, expectedRevision: updatePreview.expectedRevision, expectedCmsRevision: updatePreview.expectedCmsRevision }] });
      assert.equal(conflict.data.items[0].status, "error");
      assert.equal((await a.call(`/v1/articles/${importedId}`)).data.text, "別の窓が保存した内容。");
      const concurrent = { ...item, externalId: "concurrent", slug: `import-race-${suffix}`, articleId: null, expectedRevision: 0, expectedCmsRevision: 0 };
      const both = await Promise.all([a.call("/v1/cms/import", "POST", { source, items: [concurrent] }), a.call("/v1/cms/import", "POST", { source, items: [concurrent] })]);
      assert.equal(both.flatMap((x) => x.data.items).filter((x) => x.status === "created").length, 1);
      assert.equal((await a.call(`/v1/cms/articles?q=${encodeURIComponent("輸入記事")}`)).data.total, 2);
      const beforeTts = providerCalls;
      assert.equal((await a.call("/v1/cms/import/preview", "POST", { source, items: Array.from({ length: 21 }, (_, i) => ({ ...item, externalId: `too-many-${i}` })) })).status, 400);
      assert.equal(providerCalls, beforeTts, "Imports never trigger paid generation");
    });
    const generate = async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return runtime.state.articles.generate(a.owner, article.id, { expectedRevision: article.revision, voice: "ja-jp-primary", speed: 1.15 }, runtime.state.speech, new AbortController().signal, randomUUID());
    };
    await t.test("Published text, taxonomy and audio remain fixed during draft edits and regeneration", async () => {
      originalAudio = (await generate()).audio;
      article = (await a.call(`/v1/cms/articles/${article.id}`)).data;
      const pub = await a.call(`/v1/cms/articles/${article.id}/releases`, "POST", { expectedRevision: article.revision, expectedCmsRevision: article.cms.revision, expectedAudioId: originalAudio.audioId });
      assert.equal(pub.status, 201);
      firstRelease = pub.data;
      assert.equal(firstRelease.text, article.text);
      assert.equal(firstRelease.cms.category.id, category.id);
      assert.equal(firstRelease.audio.audioId, originalAudio.audioId);
      const bytes = await a.call(`/v1/cms/articles/${article.id}/releases/${firstRelease.id}/audio`);
      assert.equal(bytes.status, 200);
      assert(bytes.headers.get("Content-Disposition").includes(firstRelease.audio.filename));
      assert.equal(hash(bytes.data), hash(tone));
      article = (await a.call(`/v1/cms/articles/${article.id}`)).data;
      const metaOnly = await a.call(`/v1/cms/articles/${article.id}`, "PATCH", cmsInput(article, {}, { categoryId: secondCategory.id, summary: "新しい分類" }));
      assert.equal(metaOnly.status, 200);
      article = metaOnly.data;
      assert.equal(article.audioStale, false, "Taxonomy edits do not invalidate narration");
      assert.equal(article.contentRevision, firstRelease.contentRevision);
      const edited = await a.call(`/v1/cms/articles/${article.id}`, "PATCH", cmsInput(article, { text: "新しい草稿だけの内容。" }));
      assert.equal(edited.status, 200);
      article = edited.data;
      assert.equal(article.audioStale, true);
      providerBytes = Buffer.concat([tone, Buffer.from([0])]);
      const generated = await generate();
      article = (await a.call(`/v1/cms/articles/${article.id}`)).data;
      assert.notEqual(generated.audio.audioId, originalAudio.audioId);
      assert.equal((await a.call(`/v1/articles/${article.id}/audio?audioId=${originalAudio.audioId}`)).status, 404);
      const read = await a.call(`/v1/cms/read/articles/${article.id}`);
      assert.equal(read.status, 200);
      assert.equal(read.data.id, firstRelease.id);
      assert.equal(read.data.text, firstRelease.text);
      assert.equal(read.data.cms.category.id, category.id);
      const preserved = await a.call(`/v1/cms/read/releases/${firstRelease.id}/audio`);
      assert.equal(preserved.status, 200);
      assert(preserved.headers.get("Content-Disposition").includes(firstRelease.audio.filename));
      assert.equal(hash(preserved.data), hash(tone));
      assert.equal((await b.call(`/v1/cms/read/articles/${article.id}`)).status, 404);
      assert.equal((await a.call(`/v1/articles/${article.id}?expectedRevision=${article.revision}`, "DELETE")).status, 409);
      assert.equal((await a.call(`/v1/cms/articles/${article.id}/releases/${firstRelease.id}?expectedCmsRevision=${article.cms.revision}`, "DELETE")).status, 409);
    });
    await t.test("TTS failure keeps latest audio and published bytes; rule changes do not rewrite releases", async () => {
      const audioBefore = article.audio.audioId;
      providerFail = true;
      try { await assert.rejects(generate()); } finally { providerFail = false; }
      article = (await a.call(`/v1/cms/articles/${article.id}`)).data;
      assert.equal(article.audio.audioId, audioBefore);
      assert.equal(hash((await a.call(`/v1/cms/read/releases/${firstRelease.id}/audio`)).data), hash(tone));
      await runtime.state.vocabulary.create(a.owner, { text: "内容", reading: "ないよう" });
      article = (await a.call(`/v1/cms/articles/${article.id}`)).data;
      assert.equal(article.audioStale, true);
      assert.equal((await a.call(`/v1/cms/articles/${article.id}/releases`, "POST", { expectedRevision: article.revision, expectedCmsRevision: article.cms.revision, expectedAudioId: article.audio.audioId })).status, 409);
      await generate();
      article = (await a.call(`/v1/cms/articles/${article.id}`)).data;
      assert.equal(article.audioStale, false);
      assert.equal((await a.call(`/v1/cms/read/articles/${article.id}`)).data.text, firstRelease.text);
    });
    let token;
    await t.test("Scoped credentials read current releases/RSS but cannot edit or generate", async () => {
      const created = await a.call("/v1/cms/read-tokens", "POST", { label: "isolated test identity", expiresInSeconds: 60, categoryIds: [category.id] });
      assert.equal(created.status, 201);
      token = created.data;
      assert.equal(typeof token.token, "string");
      const read = await request("/v1/cms/read/articles", { bearer: token.token });
      assert.equal(read.status, 200);
      assert.equal(read.data.items.length, 1);
      assert.equal(read.data.items[0].id, firstRelease.id);
      assert.equal((await request(`/v1/cms/read/articles/${article.id}`, { bearer: token.token })).data.text, firstRelease.text);
      const rss = await request("/v1/cms/read/rss", { bearer: token.token });
      assert.equal(rss.status, 200);
      assert.match(rss.headers.get("Content-Type"), /xml|rss/);
      assert.match(rss.data, /<rss\b/);
      assert.equal((rss.data.match(/<item>/g) || []).length, 1);
      assert(!rss.data.includes("新しい草稿だけの内容。"));
      assert.equal((await request("/v1/cms/read/rss")).status, 401);
      assert.equal((await request("/v1/cms/articles", { bearer: token.token })).status, 403);
      assert.equal((await request(`/v1/articles/${article.id}`, { method: "PATCH", bearer: token.token, body: { title: "forbidden", text: "forbidden", expectedRevision: article.revision } })).status, 403);
      assert.equal((await request(`/v1/articles/${article.id}/audio`, { method: "POST", bearer: token.token, body: { expectedRevision: article.revision, voice: "ja-jp-primary" } })).status, 403);
      const listed = await a.call("/v1/cms/read-tokens");
      assert(!JSON.stringify(listed.data).includes(token.token), "Token plaintext is only returned once");
      assert.equal((await b.call(`/v1/cms/read-tokens/${token.id}`, "DELETE")).status, 404);
      const expiring = (await a.call("/v1/cms/read-tokens", "POST", { label: "expiry fixture only", expiresInSeconds: 60, categoryIds: [] })).data;
      await runtime.pool.query("UPDATE wb_cms_read_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1 AND account_id=$2", [expiring.id, a.owner]);
      assert.equal((await request("/v1/cms/read/articles", { bearer: expiring.token })).status, 401);
    });
    await t.test("Republish switches the release pointer while retained history remains readable", async () => {
      const pub = await a.call(`/v1/cms/articles/${article.id}/releases`, "POST", { expectedRevision: article.revision, expectedCmsRevision: article.cms.revision, expectedAudioId: article.audio.audioId });
      assert.equal(pub.status, 201);
      assert.notEqual(pub.data.id, firstRelease.id);
      const read = await a.call(`/v1/cms/read/articles/${article.id}`);
      assert.equal(read.data.id, pub.data.id);
      assert.equal(read.data.text, article.text);
      assert.equal((await request("/v1/cms/read/articles", { bearer: token.token })).data.items.length, 0, "New category snapshot is outside this token's scope");
      assert.equal((await request(`/v1/cms/read/articles/${article.id}`, { bearer: token.token })).status, 404);
      assert.equal(hash((await a.call(`/v1/cms/articles/${article.id}/releases/${firstRelease.id}/audio`)).data), hash(tone));
      assert.equal((await a.call(`/v1/cms/articles/${article.id}/releases`)).data.items.length, 2);
      article = (await a.call(`/v1/cms/articles/${article.id}`)).data;
    });
    await t.test("Restart retains publication and audio; withdrawal revokes read access and credential revocation is immediate", async () => {
      const current = (await a.call(`/v1/cms/read/articles/${article.id}`)).data;
      await runtime.close();
      runtime = await createApplication(config);
      await start();
      const restored = (await a.call(`/v1/cms/read/articles/${article.id}`)).data;
      assert.equal(restored.id, current.id);
      assert.equal(hash((await a.call(`/v1/cms/read/releases/${current.id}/audio`)).data), hash(providerBytes));
      const unpub = await a.call(`/v1/cms/articles/${article.id}/unpublish`, "POST", { expectedRevision: article.revision, expectedCmsRevision: article.cms.revision });
      assert.equal(unpub.status, 200);
      article = unpub.data;
      assert.equal(article.cms.publishedReleaseId, null);
      assert.equal((await a.call(`/v1/cms/read/articles/${article.id}`)).status, 404);
      assert.equal((await a.call(`/v1/cms/read/releases/${current.id}/audio`)).status, 404);
      assert.equal((await a.call("/v1/cms/read/articles")).data.items.length, 0);
      assert.equal((await a.call(`/v1/cms/read-tokens/${token.id}`, "DELETE")).status, 204);
      assert.equal((await request("/v1/cms/read/articles", { bearer: token.token })).status, 401);
      assert.equal((await request("/v1/cms/read/articles", { bearer: "not-a-credential" })).status, 401);
      assert.equal((await a.call(`/v1/cms/articles/${article.id}/releases/${firstRelease.id}?expectedCmsRevision=${article.cms.revision}`, "DELETE")).status, 204);
    });
    await t.test("Default runtime refuses real read-token provisioning", async () => {
      await runtime.close();
      runtime = await createApplication(readConfig({ ...env, DATABASE_URL: url }));
      await start();
      assert.equal((await a.call("/v1/cms/read-tokens", "POST", { label: "must stay disabled", expiresInSeconds: 60, categoryIds: [] })).status, 404);
    });
    await t.test("Explicit release history is bounded and stale publication attempts cannot move the pointer", async () => {
      let limited = (await a.call("/v1/cms/articles", "POST", { title: "履歴の上限", text: "音声なしで公開可能。", cms: { slug: `history-${suffix}`, summary: "", categoryId: null, tagIds: [] } })).data;
      let first;
      for (let i = 0; i < 10; i++) {
        const release = await a.call(`/v1/cms/articles/${limited.id}/releases`, "POST", { expectedRevision: limited.revision, expectedCmsRevision: limited.cms.revision, expectedAudioId: null });
        assert.equal(release.status, 201);
        first ||= release.data;
        const previous = limited;
        limited = (await a.call(`/v1/cms/articles/${limited.id}`)).data;
        assert.equal((await a.call(`/v1/cms/articles/${limited.id}/releases`, "POST", { expectedRevision: previous.revision, expectedCmsRevision: previous.cms.revision, expectedAudioId: null })).status, 409);
      }
      const over = await a.call(`/v1/cms/articles/${limited.id}/releases`, "POST", { expectedRevision: limited.revision, expectedCmsRevision: limited.cms.revision, expectedAudioId: null });
      assert.equal(over.status, 409);
      assert.equal(over.data.code, "RELEASE_LIMIT");
      assert.equal((await a.call(`/v1/cms/articles/${limited.id}/releases`)).data.items.length, 10);
      assert.equal((await a.call(`/v1/cms/articles/${limited.id}/releases/${first.id}?expectedCmsRevision=${limited.cms.revision}`, "DELETE")).status, 204);
      assert.equal((await a.call(`/v1/cms/articles/${limited.id}/releases`)).data.items.length, 9);
    });
  } finally {
    globalThis.fetch = nativeFetch;
    try {
      await runtime.pool.query("DELETE FROM ac_accounts WHERE id=ANY($1::uuid[])", [owners]);
    } finally {
      await runtime.close();
    }
  }
});
