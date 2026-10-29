import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createApplication } from "../dist/app.js";
import { readConfig } from "../dist/config.js";
import { migrate } from "../dist/migrate.js";

// This file must never migrate, seed, or clean up any other database.
const url = process.env.TEST_DATABASE_URL;
if (
  url &&
  !["/cms_categories_test_20261027", "/cms_reading_test_20261027"].includes(
    new URL(url).pathname,
  )
) {
  throw new Error(
    "CMS category tests require an explicitly named isolated category/reading test database",
  );
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const env = {
  SESSION_SECRET: "cms-categories-isolated-fixture-secret-20261027",
  PUBLIC_ORIGIN: "http://127.0.0.1:4381",
  NODE_ENV: "test",
  REGISTRATION_ENABLED: "true",
  CMS_READ_TOKENS_ENABLED: "true",
};

test(
  "CMS categories: isolated hierarchy, atomic moves and exact published scopes",
  { skip: !url },
  async (t) => {
    await migrate(url);
    await migrate(url); // A second up must be harmless on the dedicated test database.
    const nativeFetch = globalThis.fetch;
    let providerCalls = 0;
    globalThis.fetch = async () => {
      providerCalls++;
      throw new Error("Category tests forbid external fetch and paid TTS");
    };
    const owners = [];
    let runtime;
    try {
      const config = readConfig({ ...env, DATABASE_URL: url });
      runtime = await createApplication(config);
      await runtime.app.listen(0, "127.0.0.1");
      const base = await runtime.app.getUrl();
      async function request(
        path,
        {
          method = "GET",
          body,
          cookie = "",
          csrf = "",
          bearer,
          validCsrf = true,
        } = {},
      ) {
        const response = await nativeFetch(base + path, {
          method,
          headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
            ...(method === "GET"
              ? {}
              : {
                  Origin: config.PUBLIC_ORIGIN,
                  "Content-Type": "application/json",
                  "X-CSRF-Token": validCsrf ? csrf : "invalid-csrf",
                }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const mime = response.headers.get("Content-Type") || "";
        const data =
          response.status === 204
            ? null
            : mime.startsWith("audio/")
              ? Buffer.from(await response.arrayBuffer())
              : mime.includes("json")
                ? await response.json()
                : await response.text();
        return { status: response.status, data, headers: response.headers };
      }
      const ok = (response, status = 200) => {
        assert.equal(response.status, status, JSON.stringify(response.data));
        return response.data;
      };
      const error = (response, status, code) => {
        assert.equal(response.status, status, JSON.stringify(response.data));
        assert.equal(response.data.code, code);
      };
      async function browser() {
        let cookie = "",
          csrf = "";
        const call = async (path, method = "GET", body, validCsrf = true) => {
          const response = await request(path, {
            method,
            body,
            cookie,
            csrf,
            validCsrf,
          });
          const cookies = response.headers.getSetCookie();
          if (cookies.length)
            cookie = cookies.map((c) => c.split(";")[0]).join("; ");
          if (response.data?.csrfToken) csrf = response.data.csrfToken;
          return response;
        };
        ok(await call("/v1/auth/csrf"));
        const login = `cms-${randomUUID()}`,
          password = "Fixture8!";
        const account = ok(
          await call("/v1/auth/register", "POST", {
            login,
            password,
            displayName: "Synthetic categories fixture",
          }),
          201,
        );
        owners.push(account.id);
        ok(await call("/v1/auth/login", "POST", { login, password }));
        ok(await call("/v1/auth/csrf"));
        return { call, owner: account.id };
      }
      await t.test(
        "the new migration down/up restores columns and index inside a rolled-back transaction",
        async () => {
          const migration = (
            await import("../migrations/1793059200000-cms-categories.cjs")
          ).default;
          const sqlFor = (direction) => {
            const statements = [];
            migration[direction]({ sql: (sql) => statements.push(sql) });
            assert(statements.length > 0);
            return statements;
          };
          const c = await runtime.pool.connect();
          const columns = () =>
            c.query(`SELECT column_name,data_type,is_nullable,column_default
        FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='wb_cms_taxonomy'
        AND column_name IN ('parent_id','sort_order') ORDER BY column_name`);
          const records = () =>
            c.query(
              "SELECT to_jsonb(m) AS record FROM wb_migrations m ORDER BY name",
            );
          try {
            const originalColumns = (await columns()).rows;
            const originalRecords = (await records()).rows;
            await c.query("BEGIN");
            try {
              for (const sql of sqlFor("down")) await c.query(sql);
              assert.deepEqual((await columns()).rows, []);
              assert.equal(
                (
                  await c.query(
                    "SELECT to_regclass('wb_cms_category_tree') AS name",
                  )
                ).rows[0].name,
                null,
              );
              assert.deepEqual((await records()).rows, originalRecords);
              for (const sql of sqlFor("up")) await c.query(sql);
              assert.deepEqual((await columns()).rows, [
                {
                  column_name: "parent_id",
                  data_type: "uuid",
                  is_nullable: "YES",
                  column_default: null,
                },
                {
                  column_name: "sort_order",
                  data_type: "integer",
                  is_nullable: "NO",
                  column_default: "0",
                },
              ]);
              const index = (
                await c.query(
                  "SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='wb_cms_category_tree'",
                )
              ).rows[0];
              assert.match(
                index.indexdef,
                /\(account_id, parent_id, sort_order, id\)/,
              );
              assert.match(index.indexdef, /WHERE.*kind.*category/);
              assert.equal(
                Number(
                  (
                    await c.query(
                      "SELECT count(*) FROM wb_cms_taxonomy WHERE parent_id IS NOT NULL OR sort_order<>0",
                    )
                  ).rows[0].count,
                ),
                0,
                "re-added fields receive legacy-safe defaults",
              );
              assert.deepEqual((await records()).rows, originalRecords);
            } finally {
              await c.query("ROLLBACK");
            }
            assert.deepEqual((await columns()).rows, originalColumns);
            assert.deepEqual(
              (await records()).rows,
              originalRecords,
              "manual down/up never changes migration tracking",
            );
          } finally {
            c.release();
          }
        },
      );

      const a = await browser(),
        b = await browser();
      const createCategory = async (browser, name, extra = {}) =>
        ok(
          await browser.call("/v1/cms/categories", "POST", {
            name,
            slug: `category-${randomUUID()}`,
            ...extra,
          }),
          201,
        );
      const createTag = async (browser, name = "Fixture tag") =>
        ok(
          await browser.call("/v1/cms/tags", "POST", {
            name,
            slug: `tag-${randomUUID()}`,
          }),
          201,
        );
      const patchCategory = (browser, category, extra = {}) =>
        browser.call(`/v1/cms/categories/${category.id}`, "PATCH", {
          name: category.name,
          slug: category.slug,
          expectedRevision: category.revision,
          ...extra,
        });
      const createArticle = async (browser, categoryId = null, extraCms = {}) =>
        ok(
          await browser.call("/v1/cms/articles", "POST", {
            title: `Fixture ${randomUUID()}`,
            text: "分類テストの本文です。\nか\u3099 & <text>\n",
            cms: {
              slug: `story-${randomUUID()}`,
              summary: "Fixture summary",
              categoryId,
              tagIds: [],
              ...extraCms,
            },
          }),
          201,
        );
      const legacyArticle = async (browser) => {
        const article = ok(
          await browser.call("/v1/articles", "POST", {
            title: `Legacy ${randomUUID()}`,
            text: "Workbench only fixture",
          }),
          201,
        );
        return ok(await browser.call(`/v1/cms/articles/${article.id}`));
      };
      const detail = async (browser, id) =>
        ok(await browser.call(`/v1/cms/articles/${id}`));
      const item = (article) => ({
        articleId: article.id,
        expectedRevision: article.revision,
        expectedCmsRevision: article.cms.revision,
      });
      const move = (browser, categoryId, articles) =>
        browser.call("/v1/cms/articles/move-category", "POST", {
          categoryId,
          items: articles.map(item),
        });
      const taxonomy = async (browser) =>
        ok(await browser.call("/v1/cms/taxonomy"));
      // JSONB snapshots retain every WB/CMS field, bytes, import identity and release.
      // Queries and cleanup are restricted to the synthetic account IDs created above.
      async function persisted(browser, ids) {
        return (
          await runtime.pool.query(
            `
        SELECT to_jsonb(a) AS article,
          (SELECT to_jsonb(m) FROM wb_cms_articles m WHERE m.article_id=a.id) AS cms,
          COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.taxonomy_id) FROM wb_cms_article_tags t WHERE t.article_id=a.id),'[]'::jsonb) AS tags,
          COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.source,s.external_id) FROM wb_cms_import_sources s WHERE s.account_id=a.account_id AND s.article_id=a.id),'[]'::jsonb) AS sources,
          (SELECT jsonb_build_object('metadata',au.metadata,'generationSeq',au.generation_seq,'data',encode(au.data,'hex')) FROM wb_article_audio au WHERE au.article_id=a.id) AS audio,
          COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM wb_cms_releases r WHERE r.account_id=a.account_id AND r.article_id=a.id),'[]'::jsonb) AS releases,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('audioId',m.audio_id,'metadata',m.metadata,'data',encode(m.data,'hex')) ORDER BY m.audio_id)
            FROM wb_cms_media m WHERE m.account_id=a.account_id AND m.audio_id IN (SELECT r.audio_id FROM wb_cms_releases r WHERE r.article_id=a.id)),'[]'::jsonb) AS media
        FROM wb_articles a WHERE a.account_id=$1 AND a.id=ANY($2::uuid[]) ORDER BY a.id`,
            [browser.owner, ids],
          )
        ).rows;
      }
      async function seedAudio(browser, article) {
        const tone = await readFile(
          new URL("../../web/qa/tone.mp3", import.meta.url),
        );
        const audio = {
          audioId: randomUUID(),
          contentRevision: article.contentRevision,
          ruleVersion: article.currentRuleVersion,
          voice: "synthetic-fixture-only",
          speed: 1.15,
          language: "ja-JP",
          format: "mp3",
          mimeType: "audio/mpeg",
          byteLength: tone.length,
          characterCount: [...article.text].length,
          filename: `article-${article.id}.mp3`,
          createdAt: "2026-10-27T00:00:00.000Z",
        };
        assert.equal(
          (
            await runtime.pool.query(
              "UPDATE wb_articles SET generation_seq=1 WHERE account_id=$1 AND id=$2",
              [browser.owner, article.id],
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (
            await runtime.pool.query(
              `INSERT INTO wb_article_audio(article_id,generation_seq,metadata,data)
        SELECT id,1,$3,$4 FROM wb_articles WHERE account_id=$1 AND id=$2`,
              [browser.owner, article.id, audio, tone],
            )
          ).rowCount,
          1,
        );
        return { audio, tone };
      }
      async function publish(browser, article, audioId = null) {
        return ok(
          await browser.call(
            `/v1/cms/articles/${article.id}/releases`,
            "POST",
            {
              expectedRevision: article.revision,
              expectedCmsRevision: article.cms.revision,
              expectedAudioId: audioId,
            },
          ),
          201,
        );
      }

      await t.test(
        "hierarchy order and direct counts include uncategorized legacy WB articles",
        async () => {
          error(await request("/v1/cms/taxonomy"), 401, "UNAUTHENTICATED");
          const root = await createCategory(a, "Root Z", { sortOrder: 4 });
          const alpha = await createCategory(a, "Alpha", { sortOrder: 4 });
          const twin1 = await createCategory(a, "Twin", { sortOrder: 4 });
          const twin2 = await createCategory(a, "Twin", { sortOrder: 4 });
          const child = await createCategory(a, "Child", {
            parentId: root.id,
            sortOrder: 3,
          });
          const grand = await createCategory(a, "Grand", {
            parentId: child.id,
            sortOrder: 2,
          });
          const defaults = await createCategory(a, "Default");
          assert.equal(defaults.parentId, null);
          assert.equal(defaults.sortOrder, 0);
          const rootArticle = await createArticle(a, root.id);
          const childArticle = await createArticle(a, child.id);
          await createArticle(a, grand.id);
          const unassigned = await createArticle(a);
          const legacy = await legacyArticle(a);
          assert.equal(legacy.cms.revision, 0);
          const tree = await taxonomy(a);
          assert.deepEqual(
            tree.categories.map((x) => x.id),
            [
              defaults.id,
              grand.id,
              child.id,
              alpha.id,
              root.id,
              ...[twin1.id, twin2.id].sort(),
            ],
          );
          assert.equal(tree.totalArticles, 5);
          assert.equal(tree.uncategorizedCount, 2);
          for (const [category, articles, children] of [
            [root, 1, 1],
            [child, 1, 1],
            [grand, 1, 0],
            [defaults, 0, 0],
          ]) {
            const found = tree.categories.find((x) => x.id === category.id);
            assert.equal(found.articleCount, articles);
            assert.equal(found.childrenCount, children);
            assert.deepEqual(
              Object.keys(found).sort(),
              [
                "id",
                "name",
                "slug",
                "revision",
                "parentId",
                "sortOrder",
                "articleCount",
                "childrenCount",
              ].sort(),
            );
          }
          const uncategorized = ok(
            await a.call("/v1/cms/articles?category=uncategorized&limit=100"),
          );
          assert.equal(uncategorized.total, 2);
          assert.deepEqual(
            uncategorized.items.map((x) => x.id).sort(),
            [unassigned.id, legacy.id].sort(),
          );
          assert.deepEqual(
            ok(await a.call(`/v1/cms/articles?category=${root.id}`)).items.map(
              (x) => x.id,
            ),
            [rootArticle.id],
          );
          assert.deepEqual(
            ok(await a.call(`/v1/cms/articles?category=${child.id}`)).items.map(
              (x) => x.id,
            ),
            [childArticle.id],
          );
          assert.deepEqual(await taxonomy(b), {
            categories: [],
            tags: [],
            totalArticles: 0,
            uncategorizedCount: 0,
          });
        },
      );

      await t.test(
        "parents, integer sort bounds, self cycles and longer cycles are rejected atomically",
        async () => {
          const root = await createCategory(a, "Validation root", {
            sortOrder: 2147483647,
          });
          const child = await createCategory(a, "Validation child", {
            parentId: root.id,
            sortOrder: 7,
          });
          const leaf = await createCategory(a, "Validation leaf", {
            parentId: child.id,
          });
          const foreign = await createCategory(b, "Foreign parent");
          const tag = await createTag(a);
          const before = await taxonomy(a);
          for (const parentId of [
            randomUUID(),
            foreign.id,
            tag.id,
            "not-a-uuid",
          ]) {
            error(
              await a.call("/v1/cms/categories", "POST", {
                name: "Invalid parent",
                slug: `bad-${randomUUID()}`,
                parentId,
              }),
              400,
              "INVALID_REQUEST",
            );
            error(
              await patchCategory(a, child, { parentId }),
              400,
              "INVALID_REQUEST",
            );
          }
          for (const sortOrder of [-1, 2147483648, 1.5, "1", null]) {
            error(
              await a.call("/v1/cms/categories", "POST", {
                name: "Invalid order",
                slug: `bad-${randomUUID()}`,
                sortOrder,
              }),
              400,
              "INVALID_REQUEST",
            );
            error(
              await patchCategory(a, child, { sortOrder }),
              400,
              "INVALID_REQUEST",
            );
          }
          error(
            await patchCategory(a, child, { parentId: child.id }),
            409,
            "CATEGORY_CYCLE",
          );
          error(
            await patchCategory(a, root, { parentId: leaf.id }),
            409,
            "CATEGORY_CYCLE",
          );
          assert.deepEqual(await taxonomy(a), before);
          const renamed = ok(
            await patchCategory(a, child, { name: "Renamed child" }),
          );
          assert.equal(renamed.parentId, root.id);
          assert.equal(renamed.sortOrder, 7);
          assert.equal(renamed.revision, child.revision + 1);
          assert.equal(
            ok(await patchCategory(a, renamed)).revision,
            renamed.revision,
            "same-value rename is a no-op",
          );
          const detached = ok(
            await patchCategory(a, renamed, { parentId: null, sortOrder: 0 }),
          );
          assert.equal(detached.parentId, null);
          assert.equal(detached.sortOrder, 0);
          error(
            await patchCategory(a, detached, {
              expectedRevision: renamed.revision,
            }),
            409,
            "REVISION_CONFLICT",
          );
        },
      );

      await t.test(
        "concurrent opposite reparenting serializes to one success and one cycle conflict",
        async () => {
          const left = await createCategory(a, "Concurrent left"),
            right = await createCategory(a, "Concurrent right");
          const responses = await Promise.all([
            patchCategory(a, left, { parentId: right.id }),
            patchCategory(a, right, { parentId: left.id }),
          ]);
          assert.deepEqual(responses.map((x) => x.status).sort(), [200, 409]);
          error(
            responses.find((x) => x.status === 409),
            409,
            "CATEGORY_CYCLE",
          );
          const rows = (await taxonomy(a)).categories;
          const l = rows.find((x) => x.id === left.id),
            r = rows.find((x) => x.id === right.id);
          assert.equal(
            Number(l.parentId === right.id) + Number(r.parentId === left.id),
            1,
          );
          const winner = responses.find((x) => x.status === 200).data;
          assert.equal(winner.revision, 2);
          assert.equal((winner.id === left.id ? r : l).revision, 1);
        },
      );

      await t.test(
        "tag schemas stay compatible; deletion protects children/articles and hides foreign entities",
        async () => {
          let tag = await createTag(a, "Compatible tag");
          const tagKeys = ["id", "name", "slug", "revision"].sort();
          assert.deepEqual(Object.keys(tag).sort(), tagKeys);
          tag = ok(
            await a.call(`/v1/cms/tags/${tag.id}`, "PATCH", {
              name: "Renamed tag",
              slug: tag.slug,
              expectedRevision: tag.revision,
            }),
          );
          assert.deepEqual(Object.keys(tag).sort(), tagKeys);
          assert.deepEqual(
            Object.keys(
              (await taxonomy(a)).tags.find((x) => x.id === tag.id),
            ).sort(),
            tagKeys,
          );
          for (const extra of [{ parentId: null }, { sortOrder: 0 }]) {
            error(
              await a.call("/v1/cms/tags", "POST", {
                name: "Invalid tree tag",
                slug: `bad-${randomUUID()}`,
                ...extra,
              }),
              400,
              "INVALID_REQUEST",
            );
            error(
              await a.call(`/v1/cms/tags/${tag.id}`, "PATCH", {
                name: tag.name,
                slug: tag.slug,
                expectedRevision: tag.revision,
                ...extra,
              }),
              400,
              "INVALID_REQUEST",
            );
          }
          const parent = await createCategory(a, "Delete parent");
          const child = await createCategory(a, "Delete child", {
            parentId: parent.id,
          });
          const used = await createCategory(a, "Delete used");
          await createArticle(a, used.id, { tagIds: [tag.id] });
          for (const category of [parent, used]) {
            error(
              await a.call(
                `/v1/cms/categories/${category.id}?expectedRevision=${category.revision}`,
                "DELETE",
              ),
              409,
              "TAXONOMY_IN_USE",
            );
          }
          error(
            await a.call(
              `/v1/cms/tags/${tag.id}?expectedRevision=${tag.revision}`,
              "DELETE",
            ),
            409,
            "TAXONOMY_IN_USE",
          );
          for (const id of [parent.id, randomUUID()]) {
            error(await patchCategory(b, { ...parent, id }), 404, "NOT_FOUND");
            error(
              await b.call(
                `/v1/cms/categories/${id}?expectedRevision=1`,
                "DELETE",
              ),
              404,
              "NOT_FOUND",
            );
          }
          error(
            await a.call(
              `/v1/cms/categories/${child.id}?expectedRevision=99`,
              "DELETE",
            ),
            409,
            "REVISION_CONFLICT",
          );
          ok(
            await a.call(
              `/v1/cms/categories/${child.id}?expectedRevision=${child.revision}`,
              "DELETE",
            ),
            204,
          );
          ok(
            await a.call(
              `/v1/cms/categories/${parent.id}?expectedRevision=${parent.revision}`,
              "DELETE",
            ),
            204,
          );
          error(
            await a.call(
              "/v1/cms/articles/move-category",
              "POST",
              { categoryId: null, items: [] },
              false,
            ),
            403,
            "CSRF_INVALID",
          );
        },
      );

      await t.test(
        "bulk category moves preserve WB, narration, import identity, and frozen publication",
        async () => {
          const source = await createCategory(a, "Bulk source"),
            target = await createCategory(a, "Bulk target");
          const tag = await createTag(a, "Bulk tag");
          let first = await createArticle(a, source.id, {
            tagIds: [tag.id],
            summary: "Preserve summary",
          });
          const second = await createArticle(a, target.id);
          const third = await createArticle(a, source.id);
          await runtime.pool.query(
            "INSERT INTO wb_cms_import_sources(account_id,source,external_id,article_id) VALUES($1,$2,$3,$4)",
            [a.owner, "synthetic-category-fixture", randomUUID(), first.id],
          );
          const { audio, tone } = await seedAudio(a, first);
          first = await detail(a, first.id);
          assert.equal(first.audioStale, false);
          const release = await publish(a, first, audio.audioId);
          first = await detail(a, first.id);
          const articles = [third, first, second];
          const before = await persisted(
            a,
            articles.map((x) => x.id),
          );
          const moved = ok(await move(a, target.id, articles));
          assert.deepEqual(
            moved.items.map((x) => x.id),
            articles.map((x) => x.id),
          );
          const expected = structuredClone(before);
          for (const row of expected) {
            if (row.cms.category_id !== target.id) {
              row.cms.category_id = target.id;
              row.cms.revision++;
            }
          }
          assert.deepEqual(
            await persisted(
              a,
              articles.map((x) => x.id),
            ),
            expected,
          );
          for (const summary of moved.items) {
            assert.equal(Object.hasOwn(summary, "text"), false);
            const { text: _text, ...current } = await detail(a, summary.id);
            assert.deepEqual(summary, current);
          }
          assert.equal(
            moved.items[2].cms.revision,
            second.cms.revision,
            "already-in-target metadata stays unchanged",
          );
          const current = await detail(a, first.id);
          assert.equal(current.audioStale, false);
          assert.equal(current.cms.publishedReleaseId, release.id);
          assert.deepEqual(
            ok(await a.call(`/v1/cms/read/articles/${first.id}`)),
            release,
          );
          assert.equal(release.cms.category.id, source.id);
          const draftAudio = ok(
            await a.call(
              `/v1/articles/${first.id}/audio?audioId=${audio.audioId}`,
            ),
          );
          const releasedAudio = ok(
            await a.call(`/v1/cms/read/releases/${release.id}/audio`),
          );
          assert.equal(digest(draftAudio), digest(tone));
          assert.equal(digest(releasedAudio), digest(tone));
          const noOpBefore = await persisted(
            a,
            articles.map((x) => x.id),
          );
          ok(await move(a, target.id, moved.items));
          assert.deepEqual(
            await persisted(
              a,
              articles.map((x) => x.id),
            ),
            noOpBefore,
          );
          const cleared = ok(await move(a, null, moved.items));
          assert(cleared.items.every((x) => x.cms.categoryId === null));
          const clearedExpected = structuredClone(noOpBefore);
          for (const row of clearedExpected) {
            row.cms.category_id = null;
            row.cms.revision++;
          }
          assert.deepEqual(
            await persisted(
              a,
              articles.map((x) => x.id),
            ),
            clearedExpected,
          );
        },
      );

      await t.test(
        "bulk validation and a stale or foreign final item leave the entire batch untouched",
        async () => {
          const source = await createCategory(a, "Atomic source"),
            target = await createCategory(a, "Atomic target");
          const foreignTarget = await createCategory(b, "Foreign bulk target"),
            tag = await createTag(a);
          const first = await createArticle(a, source.id),
            last = await createArticle(a, source.id);
          const foreign = await createArticle(b);
          const ids = [first.id, last.id];
          const before = await persisted(a, ids),
            foreignBefore = await persisted(b, [foreign.id]);
          const invalidBodies = [
            { categoryId: target.id, items: [] },
            { categoryId: target.id, items: [item(first), item(first)] },
            {
              categoryId: target.id,
              items: Array.from({ length: 101 }, () => ({
                articleId: randomUUID(),
                expectedRevision: 1,
                expectedCmsRevision: 0,
              })),
            },
            { categoryId: "uncategorized", items: [item(first)] },
            {
              categoryId: target.id,
              items: [{ ...item(first), expectedRevision: 0 }],
            },
            {
              categoryId: target.id,
              items: [{ ...item(first), expectedCmsRevision: -1 }],
            },
            {
              categoryId: target.id,
              items: [
                { articleId: first.id, expectedRevision: first.revision },
              ],
            },
            {
              categoryId: target.id,
              items: [item(first)],
              includeDescendants: true,
            },
            ...[randomUUID(), foreignTarget.id, tag.id].map((categoryId) => ({
              categoryId,
              items: [item(first), item(last)],
            })),
          ];
          for (const body of invalidBodies) {
            error(
              await a.call("/v1/cms/articles/move-category", "POST", body),
              400,
              "INVALID_REQUEST",
            );
            assert.deepEqual(await persisted(a, ids), before);
          }
          for (const [badItem, status, code] of [
            [
              { ...item(last), expectedRevision: last.revision + 1 },
              409,
              "REVISION_CONFLICT",
            ],
            [
              { ...item(last), expectedCmsRevision: last.cms.revision + 1 },
              409,
              "CMS_REVISION_CONFLICT",
            ],
            [item(foreign), 404, "NOT_FOUND"],
            [
              {
                articleId: randomUUID(),
                expectedRevision: 1,
                expectedCmsRevision: 0,
              },
              404,
              "NOT_FOUND",
            ],
          ]) {
            error(
              await a.call("/v1/cms/articles/move-category", "POST", {
                categoryId: target.id,
                items: [item(first), badItem],
              }),
              status,
              code,
            );
            assert.deepEqual(
              await persisted(a, ids),
              before,
              "the valid first item must roll back",
            );
            assert.deepEqual(await persisted(b, [foreign.id]), foreignBefore);
          }
        },
      );

      await t.test(
        "revision-zero moves are lazy, null is a no-op, and occupied fallback slugs stay safe",
        async () => {
          const target = await createCategory(a, "Legacy target");
          const empty = await legacyArticle(a),
            normal = await legacyArticle(a),
            collision = await legacyArticle(a);
          const occupied = await createArticle(a, null, {
            slug: `article-${collision.id}`,
          });
          const before = await persisted(a, [
            empty.id,
            normal.id,
            collision.id,
            occupied.id,
          ]);
          const noOp = ok(await move(a, null, [empty, normal, collision]));
          assert(
            noOp.items.every((x) => x.cms.revision === 0 && x.cms.slug === ""),
          );
          assert.deepEqual(
            await persisted(a, [
              empty.id,
              normal.id,
              collision.id,
              occupied.id,
            ]),
            before,
          );
          const moved = ok(await move(a, target.id, [normal, collision]));
          assert.equal(moved.items[0].cms.slug, `article-${normal.id}`);
          assert.match(
            moved.items[1].cms.slug,
            new RegExp(
              `^article-${collision.id}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
            ),
          );
          for (const article of moved.items) {
            assert.equal(article.cms.revision, 1);
            assert.equal(article.cms.categoryId, target.id);
            assert.equal(article.cms.summary, "");
            assert.deepEqual(article.cms.tagIds, []);
            assert.equal(article.cms.publishedReleaseId, null);
            const oldRow = before.find((x) => x.article.id === article.id);
            const [newRow] = await persisted(a, [article.id]);
            assert.deepEqual({ ...newRow, cms: null }, oldRow);
          }
          assert.deepEqual(
            await persisted(a, [occupied.id]),
            before.filter((x) => x.article.id === occupied.id),
          );
          assert.deepEqual(
            await persisted(a, [empty.id]),
            before.filter((x) => x.article.id === empty.id),
          );
          const repeat = await persisted(a, [normal.id, collision.id]);
          ok(await move(a, target.id, moved.items));
          assert.deepEqual(
            await persisted(a, [normal.id, collision.id]),
            repeat,
          );
        },
      );

      await t.test(
        "published category filters and bearer scopes remain exact when the draft tree changes",
        async () => {
          const root = await createCategory(a, "Read root"),
            other = await createCategory(a, "Read other");
          let child = await createCategory(a, "Read child", {
            parentId: other.id,
          });
          const rootArticle = await createArticle(a, root.id),
            childArticle = await createArticle(a, child.id);
          const rootRelease = await publish(a, rootArticle),
            childRelease = await publish(a, childArticle);
          const token = ok(
            await a.call("/v1/cms/read-tokens", "POST", {
              label: "Synthetic root scope",
              expiresInSeconds: 300,
              categoryIds: [root.id],
            }),
            201,
          );
          const read = (path) => request(path, { bearer: token.token });
          assert.deepEqual(
            ok(await read("/v1/cms/read/articles?limit=100")).items.map(
              (x) => x.id,
            ),
            [rootRelease.id],
          );
          error(
            await read(`/v1/cms/read/articles/${childArticle.id}`),
            404,
            "NOT_FOUND",
          );
          child = ok(await patchCategory(a, child, { parentId: root.id }));
          assert.equal(child.parentId, root.id);
          assert.deepEqual(
            ok(await read("/v1/cms/read/articles?limit=100")).items.map(
              (x) => x.id,
            ),
            [rootRelease.id],
          );
          assert.deepEqual(
            ok(
              await read(`/v1/cms/read/articles?category=${root.id}`),
            ).items.map((x) => x.id),
            [rootRelease.id],
          );
          assert.equal(
            ok(await read(`/v1/cms/read/articles?category=${child.id}`)).total,
            0,
          );
          error(
            await read(`/v1/cms/read/articles/${childArticle.id}`),
            404,
            "NOT_FOUND",
          );
          assert.deepEqual(
            ok(
              await a.call(`/v1/cms/read/articles?category=${root.id}`),
            ).items.map((x) => x.id),
            [rootRelease.id],
          );
          assert.deepEqual(
            ok(
              await a.call(`/v1/cms/read/articles?category=${child.id}`),
            ).items.map((x) => x.id),
            [childRelease.id],
          );
          assert.equal(
            ok(await a.call("/v1/cms/read/articles?category=uncategorized"))
              .total,
            0,
          );
          assert.equal(
            ok(await read("/v1/cms/read/articles?category=uncategorized"))
              .total,
            0,
          );
          error(
            await read(
              `/v1/cms/read/articles?category=${root.id}&includeDescendants=true`,
            ),
            400,
            "INVALID_REQUEST",
          );
          error(
            await a.call(
              `/v1/cms/articles?category=${root.id}&includeDescendants=true`,
            ),
            400,
            "INVALID_REQUEST",
          );
          error(
            await b.call(`/v1/cms/read/articles/${rootArticle.id}`),
            404,
            "NOT_FOUND",
          );
          ok(await a.call(`/v1/cms/read-tokens/${token.id}`, "DELETE"), 204);
          error(await read("/v1/cms/read/articles"), 401, "UNAUTHENTICATED");
        },
      );
      assert.equal(
        providerCalls,
        0,
        "hierarchy edits and moves must not invoke TTS or any external fetch",
      );
    } finally {
      globalThis.fetch = nativeFetch;
      if (runtime) {
        try {
          // Never truncate shared tables: delete only accounts registered by this run.
          await runtime.pool.query(
            "DELETE FROM ac_accounts WHERE id=ANY($1::uuid[])",
            [owners],
          );
        } finally {
          await runtime.close();
        }
      }
    }
  },
);
