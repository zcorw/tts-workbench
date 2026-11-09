import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { automaticArticleSlug, CmsService } from "../dist/cms.js";
import { createApplication } from "../dist/app.js";
import { readConfig } from "../dist/config.js";
import { migrate } from "../dist/migrate.js";

test("Automatic article slugs are opaque, deterministic, collision-safe and bounded", () => {
  const id = "12345678-1234-4123-8123-000000000001";
  const base = automaticArticleSlug(id, new Set());
  assert.equal(base, "article-123456781234");
  assert.equal(automaticArticleSlug(id.toUpperCase(), new Set()), base);
  assert.equal(
    automaticArticleSlug(id, new Set([base, base + "-2"])),
    base + "-3",
  );
  const occupied = new Set(
    Array.from({ length: 128 }, (_, index) =>
      index ? `${base}-${index + 1}` : base,
    ),
  );
  assert.throws(() => automaticArticleSlug(id, occupied), {
    status: 409,
    code: "SLUG_ALLOCATION_FAILED",
  });
});

test("Article automatic slug input does not relax custom, import or taxonomy validation", async (t) => {
  const cms = new CmsService({}, {}),
    owner = randomUUID();
  for (const value of [
    "日本語",
    "MixedCase",
    "two words",
    "with_under_score",
    null,
    " ".repeat(121),
  ]) {
    await t.test(
      "reject custom value " + JSON.stringify(value).slice(0, 25),
      async () => {
        await assert.rejects(
          cms.create(owner, {
            title: "日文",
            text: "本文",
            cms: { slug: value },
          }),
          { name: "ZodError" },
        );
      },
    );
  }
  await assert.rejects(
    cms.create(owner, {
      requestId: "invalid",
      title: "日文",
      text: "本文",
      cms: {},
    }),
    { name: "ZodError" },
  );
  const preview = await cms.import(
    owner,
    {
      source: "strict-import",
      items: [{ externalId: "one", title: "日文", text: "本文" }],
    },
    true,
  );
  assert.equal(preview.items[0].status, "error");
  assert.deepEqual(preview.items[0].errors, ["INVALID_REQUEST"]);
  await assert.rejects(
    cms.createTaxonomy(owner, "category", { name: "分類" }),
    { name: "ZodError" },
  );
});

const databaseUrl = process.env.TEST_DATABASE_URL;
if (
  databaseUrl &&
  new URL(databaseUrl).pathname !== "/cms_reading_test_20261027"
)
  throw new Error(
    "Slug tests only accept the explicit disposable CMS test database",
  );

test(
  "CMS article slugs: real HTTP/PG create recovery, collisions, first-save and frozen releases",
  { skip: !databaseUrl, timeout: 60000 },
  async (t) => {
    await migrate(databaseUrl);
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("External transport is disabled in slug fixtures");
    };
    const config = readConfig({
      DATABASE_URL: databaseUrl,
      SESSION_SECRET:
        "slug-test-only-session-secret-not-a-production-credential",
      PUBLIC_ORIGIN: "http://127.0.0.1:4181",
      NODE_ENV: "test",
      REGISTRATION_ENABLED: "true",
    });
    const runtime = await createApplication(config);
    const owners = [];
    await runtime.app.listen(0, "127.0.0.1");
    const base = await runtime.app.getUrl();
    async function browser() {
      let cookie = "",
        csrf = "";
      const call = async (path, method = "GET", body, validCsrf = true) => {
        const response = await nativeFetch(base + path, {
          method,
          signal: AbortSignal.timeout(5000),
          headers: {
            Cookie: cookie,
            ...(method === "GET"
              ? {}
              : {
                  Origin: config.PUBLIC_ORIGIN,
                  "Content-Type": "application/json",
                  "X-CSRF-Token": validCsrf ? csrf : "invalid",
                }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (response.headers.getSetCookie().length)
          cookie = response.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; ");
        const mime = response.headers.get("Content-Type") ?? "";
        const data =
          response.status === 204
            ? null
            : mime.startsWith("audio/")
              ? Buffer.from(await response.arrayBuffer())
              : mime.includes("json")
                ? await response.json()
                : await response.text();
        if (data?.csrfToken) csrf = data.csrfToken;
        return { status: response.status, data };
      };
      await call("/v1/auth/csrf");
      const login = "slug-" + randomUUID(),
        password = "Fixture8!";
      const account = await call("/v1/auth/register", "POST", {
        login,
        password,
        displayName: "Synthetic slug owner",
      });
      assert.equal(account.status, 201);
      owners.push(account.data.id);
      assert.equal(
        (await call("/v1/auth/login", "POST", { login, password })).status,
        200,
      );
      await call("/v1/auth/csrf");
      return { call, owner: account.data.id };
    }
    const input = (requestId = randomUUID(), extra = {}) => ({
      requestId,
      title: "日本語の記事",
      text: "中文与日本語の本文。",
      cms: {},
      ...extra,
    });
    const patch = (article, extra = {}, metadata = {}) => ({
      title: article.title,
      text: article.text,
      expectedRevision: article.revision,
      ...extra,
      cms: {
        summary: article.cms.summary,
        categoryId: article.cms.categoryId,
        tagIds: article.cms.tagIds,
        expectedRevision: article.cms.revision,
        ...metadata,
      },
    });
    const count = async (owner, id) =>
      Number(
        (
          await runtime.pool.query(
            "SELECT count(*) FROM wb_articles WHERE account_id=$1 AND ($2::uuid IS NULL OR id=$2)",
            [owner, id ?? null],
          )
        ).rows[0].count,
      );
    try {
      const a = await browser(),
        b = await browser();
      await t.test(
        "same create UUID and normalized full payload recover exactly one article",
        async () => {
          const requestId = randomUUID(),
            payload = input(requestId, { title: "  日本語の記事  " });
          const before = await count(a.owner);
          assert.equal(
            (await a.call("/v1/cms/articles", "POST", payload, false)).status,
            403,
          );
          const responses = await Promise.all([
            a.call("/v1/cms/articles", "POST", payload),
            a.call("/v1/cms/articles", "POST", payload),
          ]);
          assert(responses.every((response) => response.status === 201));
          assert.equal(responses[0].data.id, requestId);
          assert.equal(responses[1].data.id, requestId);
          assert.equal(responses[0].data.cms.slug, responses[1].data.cms.slug);
          assert.equal(await count(a.owner), before + 1);
          const normalized = {
            ...payload,
            title: payload.title.trim(),
            cms: { slug: "  ", summary: "", categoryId: null, tagIds: [] },
          };
          assert.equal(
            (await a.call("/v1/cms/articles", "POST", normalized)).data.id,
            requestId,
          );
          const changed = await a.call("/v1/cms/articles", "POST", {
            ...payload,
            text: "不同的本文",
          });
          assert.equal(changed.status, 409);
          assert.equal(changed.data.code, "CREATE_REQUEST_CONFLICT");
          const foreign = await b.call("/v1/cms/articles", "POST", payload);
          assert.equal(foreign.status, 409);
          assert.equal(foreign.data.code, "CREATE_REQUEST_CONFLICT");
          assert.equal("title" in foreign.data, false);
          assert.equal(await count(a.owner), before + 1);
          assert.equal(await count(b.owner, requestId), 0);
          const old = responses[0].data;
          const updated = await a.call(
            "/v1/cms/articles/" + old.id,
            "PATCH",
            patch(old, { title: "改名後の記事" }),
          );
          assert.equal(updated.status, 200);
          assert.equal(updated.data.cms.slug, old.cms.slug);
          assert.equal(
            (await a.call("/v1/cms/articles", "POST", payload)).data.code,
            "CREATE_REQUEST_CONFLICT",
          );
          assert.equal(
            (await a.call("/v1/cms/articles/" + old.id)).data.title,
            "改名後の記事",
          );
          const metaPayload = input();
          const original = (
            await a.call("/v1/cms/articles", "POST", metaPayload)
          ).data;
          const metaChanged = await a.call(
            "/v1/cms/articles/" + original.id,
            "PATCH",
            patch(original, {}, { slug: "only-metadata-" + randomUUID() }),
          );
          assert.equal(metaChanged.status, 200);
          assert.equal(metaChanged.data.revision, 1);
          assert.equal(metaChanged.data.cms.revision, 2);
          const oldCreate = await a.call(
            "/v1/cms/articles",
            "POST",
            metaPayload,
          );
          assert.equal(oldCreate.status, 409);
          assert.equal(oldCreate.data.code, "CREATE_REQUEST_CONFLICT");
          assert.equal(await count(a.owner, original.id), 1);
        },
      );
      await t.test(
        "different UUIDs sharing a slug prefix allocate distinct stable suffixes under concurrency",
        async () => {
          const seed = await a.call(
            "/v1/cms/articles",
            "POST",
            input(randomUUID(), { cms: { slug: "article-234567891234" } }),
          );
          assert.equal(seed.status, 201);
          const ids = [
            "23456789-1234-4123-8123-000000000001",
            "23456789-1234-4123-8123-000000000002",
          ];
          const results = await Promise.all(
            ids.map((id) => a.call("/v1/cms/articles", "POST", input(id))),
          );
          assert(results.every((result) => result.status === 201));
          assert.deepEqual(
            new Set(results.map((result) => result.data.cms.slug)),
            new Set(["article-234567891234-2", "article-234567891234-3"]),
          );
          for (let index = 0; index < ids.length; index++) {
            const retry = await a.call(
              "/v1/cms/articles",
              "POST",
              input(ids[index]),
            );
            assert.equal(retry.data.cms.slug, results[index].data.cms.slug);
          }
          const sharedId = randomUUID();
          const race = await Promise.all([
            a.call("/v1/cms/articles", "POST", input(sharedId)),
            b.call("/v1/cms/articles", "POST", input(sharedId)),
          ]);
          assert.deepEqual(
            race.map((result) => result.status).sort(),
            [201, 409],
          );
          assert.equal(
            race.find((result) => result.status === 409).data.code,
            "CREATE_REQUEST_CONFLICT",
          );
          assert.equal(
            (await count(a.owner, sharedId)) + (await count(b.owner, sharedId)),
            1,
          );
        },
      );
      await t.test(
        "invalid or duplicate custom slug rolls back creation; a corrected retry reuses its UUID",
        async () => {
          const occupied = "custom-" + randomUUID();
          assert.equal(
            (
              await a.call(
                "/v1/cms/articles",
                "POST",
                input(randomUUID(), { cms: { slug: occupied } }),
              )
            ).status,
            201,
          );
          const requestId = randomUUID(),
            before = await count(a.owner);
          const duplicate = await a.call(
            "/v1/cms/articles",
            "POST",
            input(requestId, { cms: { slug: occupied } }),
          );
          assert.equal(duplicate.status, 409);
          assert.equal(duplicate.data.code, "SLUG_CONFLICT");
          assert.equal(await count(a.owner, requestId), 0);
          assert.equal(await count(a.owner), before);
          const invalid = await a.call(
            "/v1/cms/articles",
            "POST",
            input(requestId, { cms: { slug: "日本語" } }),
          );
          assert.equal(invalid.status, 400);
          assert.equal(await count(a.owner, requestId), 0);
          const invalidReference = await a.call(
            "/v1/cms/articles",
            "POST",
            input(requestId, { cms: { categoryId: randomUUID() } }),
          );
          assert.equal(invalidReference.status, 400);
          assert.equal(await count(a.owner, requestId), 0);
          const corrected = await a.call(
            "/v1/cms/articles",
            "POST",
            input(requestId, { cms: { slug: "  custom-restored  " } }),
          );
          assert.equal(corrected.status, 201);
          assert.equal(corrected.data.id, requestId);
          assert.equal(corrected.data.cms.slug, "custom-restored");
          assert.equal(await count(a.owner), before + 1);
        },
      );
      await t.test(
        "blank updates preserve custom slugs and first CMS save initializes old workbench metadata once",
        async () => {
          const legacy = await a.call("/v1/articles", "POST", {
            title: "旧工作台文章",
            text: "日本語の本文",
          });
          assert.equal(legacy.status, 201);
          const missing = (await a.call("/v1/cms/articles/" + legacy.data.id))
            .data;
          assert.equal(missing.cms.revision, 0);
          const saved = await a.call(
            "/v1/cms/articles/" + missing.id,
            "PATCH",
            patch(missing, {}, { slug: "   " }),
          );
          assert.equal(saved.status, 200);
          assert.match(
            saved.data.cms.slug,
            /^article-[0-9a-f]{12}(?:-[0-9]+)?$/,
          );
          assert.equal(saved.data.cms.revision, 1);
          assert.equal(saved.data.revision, missing.revision);
          const again = await a.call(
            "/v1/cms/articles/" + missing.id,
            "PATCH",
            patch(saved.data, {}, { slug: "" }),
          );
          assert.equal(again.data.cms.slug, saved.data.cms.slug);
          assert.equal(again.data.cms.revision, saved.data.cms.revision);
          const custom = await a.call(
            "/v1/cms/articles",
            "POST",
            input(randomUUID(), { cms: { slug: "legacy-path" } }),
          );
          const changed = await a.call(
            "/v1/cms/articles/" + custom.data.id,
            "PATCH",
            patch(custom.data, { title: "修改标题" }, { slug: "\t  " }),
          );
          assert.equal(changed.status, 200);
          assert.equal(changed.data.cms.slug, "legacy-path");
          assert.equal(changed.data.cms.revision, custom.data.cms.revision);
          const collision = await a.call(
            "/v1/cms/articles/" + saved.data.id,
            "PATCH",
            patch(saved.data, { title: "应回滚标题" }, { slug: "legacy-path" }),
          );
          assert.equal(collision.status, 409);
          assert.equal(collision.data.code, "SLUG_CONFLICT");
          assert.equal(
            (await a.call("/v1/cms/articles/" + saved.data.id)).data.title,
            saved.data.title,
          );
          const stale = await a.call(
            "/v1/cms/articles/" + custom.data.id,
            "PATCH",
            patch(custom.data, { title: "过时版本" }),
          );
          assert.equal(stale.status, 409);
          assert.equal(stale.data.code, "REVISION_CONFLICT");
        },
      );
      await t.test(
        "draft slug and title edits leave published snapshot, RSS and synthetic audio unchanged",
        async () => {
          const article = (await a.call("/v1/cms/articles", "POST", input()))
            .data;
          const tone = await readFile(
            new URL("../../web/qa/tone.mp3", import.meta.url),
          );
          const generated = await runtime.state.articles.generate(
            a.owner,
            article.id,
            {
              expectedRevision: article.revision,
              voice: "fixture-only",
              speed: 1,
            },
            {
              synthesize: async () => ({
                audio: tone,
                internalVersion: article.currentRuleVersion,
              }),
            },
            new AbortController().signal,
            randomUUID(),
          );
          const release = await a.call(
            "/v1/cms/articles/" + article.id + "/releases",
            "POST",
            {
              expectedRevision: article.revision,
              expectedCmsRevision: article.cms.revision,
              expectedAudioId: generated.audio.audioId,
            },
          );
          assert.equal(release.status, 201);
          const before = (await a.call("/v1/cms/read/articles/" + article.id))
            .data;
          const beforeRss = (await a.call("/v1/cms/read/rss")).data;
          const draft = (await a.call("/v1/cms/articles/" + article.id)).data;
          const changed = await a.call(
            "/v1/cms/articles/" + article.id,
            "PATCH",
            patch(
              draft,
              { title: "仅编辑稿新标题", text: "新的编辑稿本文。" },
              { slug: "explicit-draft-path" },
            ),
          );
          assert.equal(changed.status, 200);
          assert.deepEqual(
            (await a.call("/v1/cms/read/articles/" + article.id)).data,
            before,
          );
          assert.equal((await a.call("/v1/cms/read/rss")).data, beforeRss);
          const audio = await a.call(
            "/v1/cms/read/releases/" + release.data.id + "/audio",
          );
          assert.equal(audio.status, 200);
          assert.deepEqual(audio.data, tone);
        },
      );
      await t.test(
        "structured import still requires explicit slug and keeps external-ID conflict semantics",
        async () => {
          const source = "slug-import-" + randomUUID();
          const item = {
            externalId: "stable-one",
            title: "导入原文",
            text: "日本語本文",
            slug: "fixed-import-" + randomUUID(),
          };
          const invalid = await a.call("/v1/cms/import/preview", "POST", {
            source,
            items: [{ ...item, slug: "" }],
          });
          assert.deepEqual(invalid.data.items[0].errors, ["INVALID_REQUEST"]);
          const preview = (
            await a.call("/v1/cms/import/preview", "POST", {
              source,
              items: [item],
            })
          ).data.items[0];
          const commit = {
            ...item,
            articleId: preview.articleId,
            expectedRevision: preview.expectedRevision,
            expectedCmsRevision: preview.expectedCmsRevision,
          };
          const imported = (
            await a.call("/v1/cms/import", "POST", { source, items: [commit] })
          ).data.items[0];
          assert.equal(imported.status, "created");
          const before = await count(a.owner);
          const repeated = (
            await a.call("/v1/cms/import", "POST", { source, items: [commit] })
          ).data.items[0];
          assert.deepEqual(repeated.errors, ["IMPORT_CONFLICT"]);
          assert.equal(await count(a.owner), before);
          assert.equal(
            (await a.call("/v1/cms/articles/" + imported.articleId)).data.cms
              .slug,
            item.slug,
          );
          const refreshed = (
            await a.call("/v1/cms/import/preview", "POST", {
              source,
              items: [item],
            })
          ).data.items[0];
          assert.equal(refreshed.status, "unchanged");
        },
      );
    } finally {
      await runtime.close();
      globalThis.fetch = nativeFetch;
      const { Pool } = await import("pg");
      const cleanup = new Pool({ connectionString: databaseUrl });
      try {
        await cleanup.query(
          "DELETE FROM ac_accounts WHERE id=ANY($1::uuid[])",
          [owners],
        );
      } finally {
        await cleanup.end();
      }
    }
  },
);
