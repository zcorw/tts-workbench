import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createApplication } from "../dist/app.js";
import { readConfig } from "../dist/config.js";
import { migrate } from "../dist/migrate.js";

const url = process.env.TEST_DATABASE_URL;
if (url && new URL(url).pathname !== "/cms_reading_test_20261027") {
  throw new Error(
    "CMS reading tests require TEST_DATABASE_URL pathname /cms_reading_test_20261027",
  );
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const env = {
  SESSION_SECRET: "cms-reading-isolated-fixture-secret-20261027",
  PUBLIC_ORIGIN: "http://127.0.0.1:4381",
  NODE_ENV: "test",
  REGISTRATION_ENABLED: "true",
  CMS_READ_TOKENS_ENABLED: "true",
};

test(
  "CMS reading: published category navigation, exact scopes and immutable media",
  { skip: !url },
  async (t) => {
    // Only the explicitly named disposable database may receive existing migrations.
    await migrate(url);
    const nativeFetch = globalThis.fetch;
    let externalCalls = 0;
    globalThis.fetch = async () => {
      externalCalls++;
      throw new Error("Reading tests forbid external fetch and paid TTS");
    };
    const owners = [];
    let runtime;
    try {
      const config = readConfig({ ...env, DATABASE_URL: url });
      runtime = await createApplication(config);
      await runtime.app.listen(0, "127.0.0.1");
      const base = await runtime.app.getUrl();
      const tone = await readFile(
        new URL("../../web/qa/tone.mp3", import.meta.url),
      );
      async function request(
        path,
        { method = "GET", body, cookie = "", csrf = "", bearer } = {},
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
                  "X-CSRF-Token": csrf,
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
        const call = async (path, method = "GET", body) => {
          const response = await request(path, { method, body, cookie, csrf });
          const cookies = response.headers.getSetCookie();
          if (cookies.length)
            cookie = cookies.map((value) => value.split(";")[0]).join("; ");
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
            displayName: "Synthetic reading fixture",
          }),
          201,
        );
        owners.push(account.id);
        ok(await call("/v1/auth/login", "POST", { login, password }));
        ok(await call("/v1/auth/csrf"));
        return { call, owner: account.id };
      }
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
      const patchCategory = async (browser, category, extra) =>
        ok(
          await browser.call(`/v1/cms/categories/${category.id}`, "PATCH", {
            name: category.name,
            slug: category.slug,
            expectedRevision: category.revision,
            ...extra,
          }),
        );
      const createTag = async (browser, name) =>
        ok(
          await browser.call("/v1/cms/tags", "POST", {
            name,
            slug: `tag-${randomUUID()}`,
          }),
          201,
        );
      const createArticle = async (
        browser,
        categoryId,
        {
          title = "Reading fixture",
          text = "一行目\n二行目\n三行目\n四行目\n五行目",
          tagIds = [],
        } = {},
      ) =>
        ok(
          await browser.call("/v1/cms/articles", "POST", {
            title,
            text,
            cms: {
              slug: `story-${randomUUID()}`,
              summary: "Published fixture summary",
              categoryId,
              tagIds,
            },
          }),
          201,
        );
      const detail = async (browser, id) =>
        ok(await browser.call(`/v1/cms/articles/${id}`));
      const moveDrafts = async (browser, categoryId, ids) => {
        const current = await Promise.all(ids.map((id) => detail(browser, id)));
        return ok(
          await browser.call("/v1/cms/articles/move-category", "POST", {
            categoryId,
            items: current.map((article) => ({
              articleId: article.id,
              expectedRevision: article.revision,
              expectedCmsRevision: article.cms.revision,
            })),
          }),
        );
      };
      async function seedAudio(browser, id, marker) {
        const article = await detail(browser, id);
        const bytes = Buffer.concat([tone, Buffer.from(marker)]);
        const audio = {
          audioId: randomUUID(),
          contentRevision: article.contentRevision,
          ruleVersion: article.currentRuleVersion,
          voice: "synthetic-reading-fixture",
          speed: 1,
          language: "ja-JP",
          format: "mp3",
          mimeType: "audio/mpeg",
          byteLength: bytes.length,
          characterCount: [...article.text].length,
          filename: `article-${id}.mp3`,
          createdAt: "2026-10-27T00:00:00.000Z",
        };
        assert.equal(
          (
            await runtime.pool.query(
              `WITH seq AS (
        UPDATE wb_articles SET generation_seq=generation_seq+1 WHERE account_id=$1 AND id=$2 RETURNING id,generation_seq
      ) INSERT INTO wb_article_audio(article_id,generation_seq,metadata,data)
        SELECT id,generation_seq,$3,$4 FROM seq WHERE true ON CONFLICT(article_id) DO UPDATE
        SET generation_seq=EXCLUDED.generation_seq,metadata=EXCLUDED.metadata,data=EXCLUDED.data`,
              [browser.owner, id, audio, bytes],
            )
          ).rowCount,
          1,
        );
        return { audio, bytes };
      }
      async function publish(browser, id) {
        const article = await detail(browser, id);
        return ok(
          await browser.call(`/v1/cms/articles/${id}/releases`, "POST", {
            expectedRevision: article.revision,
            expectedCmsRevision: article.cms.revision,
            expectedAudioId: article.audio?.audioId ?? null,
          }),
          201,
        );
      }
      async function publishedArticle(browser, categoryId, options, marker) {
        const article = await createArticle(browser, categoryId, options);
        const media = await seedAudio(browser, article.id, marker);
        const release = await publish(browser, article.id);
        return { articleId: article.id, release, ...media };
      }
      async function unpublish(browser, id) {
        const article = await detail(browser, id);
        return ok(
          await browser.call(`/v1/cms/articles/${id}/unpublish`, "POST", {
            expectedRevision: article.revision,
            expectedCmsRevision: article.cms.revision,
          }),
        );
      }
      async function token(browser, categoryIds) {
        const credential = ok(
          await browser.call("/v1/cms/read-tokens", "POST", {
            label: "Synthetic isolated reading scope",
            expiresInSeconds: 600,
            categoryIds,
          }),
          201,
        );
        return {
          ...credential,
          call: (path) => request(path, { bearer: credential.token }),
        };
      }
      const group = (category, name, slug, names, articleCount) => ({
        id: category.id,
        name,
        slug,
        names,
        articleCount,
      });
      function directory(actual, categories, uncategorizedCount) {
        assert.deepEqual(
          Object.keys(actual).sort(),
          ["categories", "uncategorizedCount", "totalArticles"].sort(),
        );
        for (const category of actual.categories) {
          assert.deepEqual(
            Object.keys(category).sort(),
            ["id", "name", "slug", "names", "articleCount"].sort(),
          );
          assert.equal(new Set(category.names).size, category.names.length);
          assert.equal(category.names[0], category.name);
        }
        const byId = (left, right) =>
          left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
        assert.deepEqual(
          [...actual.categories].sort(byId),
          [...categories].sort(byId),
        );
        assert.equal(actual.uncategorizedCount, uncategorizedCount);
        assert.equal(
          actual.totalArticles,
          categories.reduce(
            (sum, category) => sum + category.articleCount,
            uncategorizedCount,
          ),
        );
      }
      const readDirectory = async (client, categories, uncategorizedCount) =>
        directory(
          ok(await client.call("/v1/cms/read/categories")),
          categories,
          uncategorizedCount,
        );
      function pageNavigation(page, categories, uncategorizedCount) {
        directory(page.navigation, categories, uncategorizedCount);
        assert.equal(
          page.navigation.totalArticles,
          page.navigation.categories.reduce(
            (sum, category) => sum + category.articleCount,
            page.navigation.uncategorizedCount,
          ),
        );
      }
      async function audioMatches(client, fixture) {
        const response = await client.call(
          `/v1/cms/read/releases/${fixture.release.id}/audio`,
        );
        const bytes = ok(response);
        assert.equal(hash(bytes), hash(fixture.bytes));
        assert.equal(response.headers.get("Content-Type"), "audio/mpeg");
        assert(
          response.headers
            .get("Content-Disposition")
            .includes(fixture.audio.filename),
        );
        assert.equal(response.headers.get("X-Audio-Id"), fixture.audio.audioId);
        assert.equal(
          response.headers.get("X-Article-Content-Revision"),
          String(fixture.audio.contentRevision),
        );
      }
      async function frozen(browser, releaseIds) {
        return (
          await runtime.pool.query(
            `SELECT to_jsonb(r) AS release,
        jsonb_build_object('id',m.audio_id,'metadata',m.metadata,'data',encode(m.data,'hex')) AS media
        FROM wb_cms_releases r JOIN wb_cms_media m ON m.audio_id=r.audio_id
        WHERE r.account_id=$1 AND r.id=ANY($2::uuid[]) ORDER BY r.id`,
            [browser.owner, releaseIds],
          )
        ).rows;
      }

      let emptyCategory, draftCategory;
      await t.test(
        "anonymous reads fail and empty or private-only libraries disclose no categories",
        async () => {
          error(
            await request("/v1/cms/read/categories"),
            401,
            "UNAUTHENTICATED",
          );
          error(await request("/v1/cms/read/articles"), 401, "UNAUTHENTICATED");
          error(
            await request("/v1/cms/read/categories", {
              bearer: "not-a-credential",
            }),
            401,
            "UNAUTHENTICATED",
          );
          await readDirectory(a, [], 0);
          emptyCategory = await createCategory(a, "Private empty category");
          draftCategory = await createCategory(a, "Private draft category");
          await createArticle(a, draftCategory.id, {
            title: "Unpublished secret draft",
          });
          ok(
            await a.call("/v1/articles", "POST", {
              title: "Unpublished WB legacy",
              text: "Private WB content",
            }),
            201,
          );
          await readDirectory(a, [], 0);
          await readDirectory(b, [], 0);
          for (const category of [
            emptyCategory.id,
            randomUUID(),
            "uncategorized",
          ]) {
            const page = ok(
              await a.call(`/v1/cms/read/articles?category=${category}`),
            );
            assert.equal(page.total, 0);
            assert.deepEqual(page.items, []);
            pageNavigation(page, [], 0);
          }
        },
      );

      const blue = await createTag(a, "Blue published tag"),
        red = await createTag(a, "Red published tag");
      let parent = await createCategory(a, "Published parent");
      let leaf = await createCategory(a, "Leaf original", {
        parentId: parent.id,
      });
      const originalLeaf = { ...leaf };
      const one = await publishedArticle(
        a,
        leaf.id,
        {
          title: "First leaf",
          text: "needle-group\n一行目\n二行目\n三行目\n四行目",
          tagIds: [blue.id],
        },
        "leaf-one",
      );
      leaf = await patchCategory(a, leaf, {
        name: "Leaf renamed",
        slug: `renamed-${randomUUID()}`,
      });
      const renamedLeaf = { ...leaf };
      const two = await publishedArticle(
        a,
        leaf.id,
        {
          title: "Second leaf",
          text: "needle-group\nSecond published text",
          tagIds: [red.id],
        },
        "leaf-two",
      );
      leaf = await patchCategory(a, leaf, {
        name: "Leaf original",
        slug: `latest-${randomUUID()}`,
      });
      const latestLeaf = { ...leaf };
      const three = await publishedArticle(
        a,
        leaf.id,
        {
          title: "Third leaf",
          text: "No search marker\nPublished third text",
          tagIds: [blue.id],
        },
        "leaf-three",
      );
      // Set only synthetic fixture timestamps before taking the immutable baseline.
      // Two different names deliberately share a timestamp to exercise the ID tie-break.
      for (const [fixture, createdAt] of [
        [one, "2026-10-27T00:00:01.000Z"],
        [two, "2026-10-27T00:00:02.000Z"],
        [three, "2026-10-27T00:00:02.000Z"],
      ]) {
        assert.equal(
          (
            await runtime.pool.query(
              `UPDATE wb_cms_releases
        SET created_at=$3::text::timestamptz,snapshot=jsonb_set(snapshot,'{createdAt}',to_jsonb($3::text))
        WHERE account_id=$1 AND id=$2`,
              [a.owner, fixture.release.id, createdAt],
            )
          ).rowCount,
          1,
        );
        fixture.release.createdAt = createdAt;
      }
      const parentStory = await publishedArticle(
        a,
        parent.id,
        {
          title: "Parent story",
          text: "needle-group\nParent published text",
          tagIds: [blue.id],
        },
        "parent",
      );
      const unassigned = await publishedArticle(
        a,
        null,
        {
          title: "Uncategorized story",
          text: "needle-group\nUncategorized published text",
          tagIds: [blue.id],
        },
        "uncategorized",
      );
      const foreignCategory = await createCategory(b, "Other owner published");
      const foreignStory = await publishedArticle(
        b,
        foreignCategory.id,
        { title: "Other owner's story" },
        "foreign",
      );
      const rootToken = await token(a, [parent.id]),
        leafToken = await token(a, [leaf.id]),
        allToken = await token(a, []);
      const rootGroup = group(
        parent,
        parent.name,
        parent.slug,
        [parent.name],
        1,
      );
      const orderedLeaf = [one, two, three].sort(
        (left, right) =>
          right.release.createdAt.localeCompare(left.release.createdAt) ||
          right.release.id.localeCompare(left.release.id),
      );
      const latestCategory = orderedLeaf[0].release.cms.category;
      const leafGroup = group(
        leaf,
        latestCategory.name,
        latestCategory.slug,
        [
          ...new Set(
            orderedLeaf.map((fixture) => fixture.release.cms.category.name),
          ),
        ],
        3,
      );
      const mainGroups = [rootGroup, leafGroup];
      const mainFixtures = [one, two, three, parentStory, unassigned];
      const mainReleaseIds = mainFixtures.map((fixture) => fixture.release.id);
      const originalFrozen = await frozen(a, mainReleaseIds);

      await t.test(
        "only current published snapshots provide names, aliases, counts and frozen taxonomy shape",
        async () => {
          assert.equal(two.release.createdAt, three.release.createdAt);
          assert.equal(
            leafGroup.slug,
            two.release.id > three.release.id
              ? renamedLeaf.slug
              : latestLeaf.slug,
          );
          await readDirectory(a, mainGroups, 1);
          await readDirectory(allToken, mainGroups, 1);
          const page = ok(await a.call("/v1/cms/read/articles?limit=100"));
          assert.equal(page.total, 5);
          assert.deepEqual(
            page.items.map((item) => item.id).sort(),
            mainReleaseIds.slice().sort(),
          );
          pageNavigation(page, mainGroups, 1);
          for (const fixture of mainFixtures) {
            assert.deepEqual(
              ok(await a.call(`/v1/cms/read/articles/${fixture.articleId}`)),
              fixture.release,
            );
            if (fixture.release.cms.category) {
              assert.deepEqual(
                Object.keys(fixture.release.cms.category).sort(),
                ["id", "name", "slug", "revision"].sort(),
              );
            }
          }
          assert.equal(
            one.release.text.split("\n").length,
            5,
            "the reading API retains full text for the client preview",
          );
          assert.equal(one.release.cms.category.name, originalLeaf.name);
          assert.equal(two.release.cms.category.name, renamedLeaf.name);
          assert.equal(three.release.cms.category.slug, latestLeaf.slug);
        },
      );

      await t.test(
        "owner and exact leaf scopes apply consistently to categories, uncategorized lists and audio",
        async () => {
          await readDirectory(rootToken, [rootGroup], 0);
          await readDirectory(leafToken, [leafGroup], 0);
          await readDirectory(
            b,
            [
              group(
                foreignCategory,
                foreignCategory.name,
                foreignCategory.slug,
                [foreignCategory.name],
                1,
              ),
            ],
            0,
          );
          const rootPage = ok(
            await rootToken.call(`/v1/cms/read/articles?category=${parent.id}`),
          );
          assert.deepEqual(
            rootPage.items.map((item) => item.id),
            [parentStory.release.id],
          );
          pageNavigation(rootPage, [rootGroup], 0);
          assert.equal(
            ok(
              await rootToken.call(`/v1/cms/read/articles?category=${leaf.id}`),
            ).total,
            0,
            "parent scopes never include descendants",
          );
          for (const client of [a, allToken]) {
            const page = ok(
              await client.call("/v1/cms/read/articles?category=uncategorized"),
            );
            assert.equal(page.total, 1);
            assert.deepEqual(
              page.items.map((item) => item.id),
              [unassigned.release.id],
            );
            pageNavigation(page, mainGroups, 1);
            assert.equal(page.total, page.navigation.uncategorizedCount);
          }
          for (const client of [rootToken, leafToken]) {
            const page = ok(
              await client.call("/v1/cms/read/articles?category=uncategorized"),
            );
            assert.equal(page.total, 0);
            assert.equal(page.navigation.uncategorizedCount, 0);
          }
          for (const category of [emptyCategory.id, randomUUID()]) {
            const page = ok(
              await a.call(`/v1/cms/read/articles?category=${category}`),
            );
            assert.equal(page.total, 0);
            pageNavigation(page, mainGroups, 1);
          }
          await audioMatches(leafToken, one);
          await audioMatches(rootToken, parentStory);
          await audioMatches(allToken, unassigned);
          error(
            await request(`/v1/cms/read/releases/${one.release.id}/audio`),
            401,
            "UNAUTHENTICATED",
          );
          error(
            await rootToken.call(`/v1/cms/read/articles/${one.articleId}`),
            404,
            "NOT_FOUND",
          );
          error(
            await rootToken.call(
              `/v1/cms/read/releases/${one.release.id}/audio`,
            ),
            404,
            "NOT_FOUND",
          );
          error(
            await leafToken.call(
              `/v1/cms/read/releases/${unassigned.release.id}/audio`,
            ),
            404,
            "NOT_FOUND",
          );
          error(
            await b.call(`/v1/cms/read/articles/${one.articleId}`),
            404,
            "NOT_FOUND",
          );
          error(
            await b.call(`/v1/cms/read/releases/${one.release.id}/audio`),
            404,
            "NOT_FOUND",
          );
          error(
            await allToken.call(
              `/v1/cms/read/releases/${foreignStory.release.id}/audio`,
            ),
            404,
            "NOT_FOUND",
          );
        },
      );

      await t.test(
        "list navigation shares q/tag filters, ignores selected category and offset, and matches category totals",
        async () => {
          const q = "q=needle-group";
          const qLeaf = group(
            leaf,
            renamedLeaf.name,
            renamedLeaf.slug,
            [renamedLeaf.name, originalLeaf.name],
            2,
          );
          const blueLeaf = group(
            leaf,
            latestLeaf.name,
            latestLeaf.slug,
            [latestLeaf.name],
            2,
          );
          const firstLeaf = group(
            leaf,
            originalLeaf.name,
            originalLeaf.slug,
            [originalLeaf.name],
            1,
          );
          const query = ok(await a.call(`/v1/cms/read/articles?${q}&limit=1`));
          assert.equal(query.total, 4);
          assert.equal(query.items.length, 1);
          pageNavigation(query, [rootGroup, qLeaf], 1);
          const tag = ok(
            await a.call(`/v1/cms/read/articles?tag=${blue.id}&limit=100`),
          );
          assert.equal(tag.total, 4);
          pageNavigation(tag, [rootGroup, blueLeaf], 1);
          const filtered = ok(
            await a.call(
              `/v1/cms/read/articles?${q}&tag=${blue.id}&category=${leaf.id}&limit=1`,
            ),
          );
          assert.equal(filtered.total, 1);
          assert.deepEqual(
            filtered.items.map((item) => item.id),
            [one.release.id],
          );
          pageNavigation(filtered, [rootGroup, firstLeaf], 1);
          assert.equal(
            filtered.total,
            filtered.navigation.categories.find(
              (category) => category.id === leaf.id,
            ).articleCount,
          );
          const first = ok(
            await a.call(
              `/v1/cms/read/articles?${q}&tag=${blue.id}&limit=1&offset=0`,
            ),
          );
          const second = ok(
            await a.call(
              `/v1/cms/read/articles?${q}&tag=${blue.id}&limit=1&offset=1`,
            ),
          );
          assert.equal(first.total, 3);
          assert.equal(second.total, 3);
          assert.notEqual(first.items[0].id, second.items[0].id);
          assert.deepEqual(first.navigation, second.navigation);
          pageNavigation(second, [rootGroup, firstLeaf], 1);
          const scoped = ok(
            await leafToken.call(
              `/v1/cms/read/articles?${q}&tag=${blue.id}&limit=1`,
            ),
          );
          assert.equal(scoped.total, 1);
          pageNavigation(scoped, [firstLeaf], 0);
          const missing = ok(
            await a.call(`/v1/cms/read/articles?q=absent-${randomUUID()}`),
          );
          assert.equal(missing.total, 0);
          pageNavigation(missing, [], 0);
          await readDirectory(a, mainGroups, 1);
        },
      );

      await t.test(
        "management rename, reparenting, draft text/audio changes and deletion preserve published reads",
        async () => {
          leaf = await patchCategory(a, leaf, {
            name: "DRAFT ONLY SECRET NAME",
            slug: `secret-${randomUUID()}`,
            parentId: emptyCategory.id,
          });
          parent = await patchCategory(a, parent, {
            name: "PRIVATE PARENT RENAME",
            slug: `private-${randomUUID()}`,
          });
          const current = await detail(a, three.articleId);
          ok(
            await a.call(`/v1/cms/articles/${three.articleId}`, "PATCH", {
              title: "PRIVATE DRAFT TITLE",
              text: "PRIVATE DRAFT TEXT\nchanged after publication",
              expectedRevision: current.revision,
              cms: {
                expectedRevision: current.cms.revision,
                slug: current.cms.slug,
                summary: "PRIVATE DRAFT SUMMARY",
                categoryId: current.cms.categoryId,
                tagIds: [],
              },
            }),
          );
          const replacement = await seedAudio(
            a,
            three.articleId,
            "replacement-draft-only",
          );
          assert.notEqual(hash(replacement.bytes), hash(three.bytes));
          await readDirectory(a, mainGroups, 1);
          const privateSearch = ok(
            await a.call("/v1/cms/read/articles?q=PRIVATE%20DRAFT%20TEXT"),
          );
          assert.equal(privateSearch.total, 0);
          pageNavigation(privateSearch, [], 0);
          const publishedTags = ok(
            await a.call(
              `/v1/cms/read/articles?category=${leaf.id}&tag=${blue.id}`,
            ),
          );
          assert.equal(
            publishedTags.total,
            2,
            "draft tag removal does not change the published tag filter",
          );
          pageNavigation(
            publishedTags,
            [
              rootGroup,
              group(
                leaf,
                latestLeaf.name,
                latestLeaf.slug,
                [latestLeaf.name],
                2,
              ),
            ],
            1,
          );
          await moveDrafts(a, emptyCategory.id, [
            one.articleId,
            two.articleId,
            three.articleId,
            parentStory.articleId,
          ]);
          ok(
            await a.call(
              `/v1/cms/categories/${leaf.id}?expectedRevision=${leaf.revision}`,
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
          const management = ok(await a.call("/v1/cms/taxonomy"));
          assert.equal(
            management.categories.some((category) =>
              [leaf.id, parent.id].includes(category.id),
            ),
            false,
          );
          await readDirectory(a, mainGroups, 1);
          await readDirectory(rootToken, [rootGroup], 0);
          await readDirectory(leafToken, [leafGroup], 0);
          for (const fixture of [one, three, parentStory]) {
            assert.deepEqual(
              ok(await a.call(`/v1/cms/read/articles/${fixture.articleId}`)),
              fixture.release,
            );
            await audioMatches(a, fixture);
          }
          await audioMatches(leafToken, three);
          assert.deepEqual(await frozen(a, mainReleaseIds), originalFrozen);
        },
      );

      const pageFixtures = [];
      let pageCategory, pageGroup;
      await t.test(
        "all published articles are available across pages beyond the default twenty",
        async () => {
          pageCategory = await createCategory(a, "Paged published category");
          for (let index = 0; index < 23; index++) {
            pageFixtures.push(
              await publishedArticle(
                a,
                pageCategory.id,
                {
                  title: `Page fixture ${index}`,
                  text: `Page body ${index}\n二行目\n三行目\n四行目`,
                },
                `page-${index}`,
              ),
            );
          }
          pageGroup = group(
            pageCategory,
            pageCategory.name,
            pageCategory.slug,
            [pageCategory.name],
            pageFixtures.length,
          );
          const defaults = ok(
            await a.call(`/v1/cms/read/articles?category=${pageCategory.id}`),
          );
          assert.equal(defaults.total, 23);
          assert.equal(defaults.items.length, 20);
          const all = ok(
            await a.call(
              `/v1/cms/read/articles?category=${pageCategory.id}&limit=100`,
            ),
          );
          const collected = [];
          for (let offset = 0; offset < 23; offset += 7) {
            const page = ok(
              await a.call(
                `/v1/cms/read/articles?category=${pageCategory.id}&limit=7&offset=${offset}`,
              ),
            );
            assert.equal(page.total, 23);
            assert.equal(page.limit, 7);
            assert.equal(page.offset, offset);
            pageNavigation(page, [...mainGroups, pageGroup], 1);
            assert.equal(
              page.total,
              page.navigation.categories.find(
                (category) => category.id === pageCategory.id,
              ).articleCount,
            );
            collected.push(...page.items);
          }
          assert.equal(
            new Set(collected.map((item) => item.articleId)).size,
            23,
          );
          assert.deepEqual(collected, all.items);
          assert.deepEqual(
            collected.map((item) => item.id).sort(),
            pageFixtures.map((fixture) => fixture.release.id).sort(),
          );
          assert(
            collected.every(
              (item) =>
                item.text.split("\n").length === 4 && item.audio?.audioId,
            ),
          );
          const after = ok(
            await a.call(
              `/v1/cms/read/articles?category=${pageCategory.id}&limit=7&offset=23`,
            ),
          );
          assert.equal(after.total, 23);
          assert.deepEqual(after.items, []);
          pageNavigation(after, [...mainGroups, pageGroup], 1);
          await readDirectory(a, [...mainGroups, pageGroup], 1);
        },
      );

      await t.test(
        "publication replacement and withdrawal update categories without counting historical releases",
        async () => {
          const replacement = await publish(a, three.articleId);
          assert.equal(replacement.cms.category.id, emptyCategory.id);
          assert.equal(replacement.title, "PRIVATE DRAFT TITLE");
          assert.notEqual(replacement.audio.audioId, three.audio.audioId);
          const replacementGroup = group(
            emptyCategory,
            emptyCategory.name,
            emptyCategory.slug,
            [emptyCategory.name],
            1,
          );
          const remainingLeaf = group(
            leaf,
            renamedLeaf.name,
            renamedLeaf.slug,
            [renamedLeaf.name, originalLeaf.name],
            2,
          );
          await readDirectory(
            a,
            [rootGroup, remainingLeaf, pageGroup, replacementGroup],
            1,
          );
          await readDirectory(leafToken, [remainingLeaf], 0);
          const changed = ok(
            await a.call(`/v1/cms/read/articles?category=${leaf.id}`),
          );
          assert.equal(changed.total, 2);
          assert.equal(
            changed.total,
            changed.navigation.categories.find(
              (category) => category.id === leaf.id,
            ).articleCount,
          );
          assert.deepEqual(
            ok(await a.call(`/v1/cms/read/articles/${three.articleId}`)),
            replacement,
          );
          error(
            await leafToken.call(`/v1/cms/read/articles/${three.articleId}`),
            404,
            "NOT_FOUND",
          );
          error(
            await leafToken.call(
              `/v1/cms/read/releases/${replacement.id}/audio`,
            ),
            404,
            "NOT_FOUND",
          );
          error(
            await a.call(`/v1/cms/read/releases/${three.release.id}/audio`),
            404,
            "NOT_FOUND",
          );
          error(
            await allToken.call(
              `/v1/cms/read/releases/${three.release.id}/audio`,
            ),
            404,
            "NOT_FOUND",
          );
          const archived = ok(
            await a.call(
              `/v1/cms/articles/${three.articleId}/releases/${three.release.id}/audio`,
            ),
          );
          assert.equal(hash(archived), hash(three.bytes));
          await unpublish(a, two.articleId);
          const firstOnly = group(
            leaf,
            originalLeaf.name,
            originalLeaf.slug,
            [originalLeaf.name],
            1,
          );
          await readDirectory(
            a,
            [rootGroup, firstOnly, pageGroup, replacementGroup],
            1,
          );
          await readDirectory(leafToken, [firstOnly], 0);
          error(
            await leafToken.call(
              `/v1/cms/read/releases/${two.release.id}/audio`,
            ),
            404,
            "NOT_FOUND",
          );
          await unpublish(a, one.articleId);
          await unpublish(a, parentStory.articleId);
          await readDirectory(a, [pageGroup, replacementGroup], 1);
          await readDirectory(leafToken, [], 0);
          await readDirectory(rootToken, [], 0);
          assert.equal(
            ok(await a.call(`/v1/cms/read/articles?category=${leaf.id}`)).total,
            0,
          );
          await unpublish(a, unassigned.articleId);
          await readDirectory(a, [pageGroup, replacementGroup], 0);
          const noUnassigned = ok(
            await allToken.call("/v1/cms/read/articles?category=uncategorized"),
          );
          assert.equal(noUnassigned.total, 0);
          pageNavigation(noUnassigned, [pageGroup, replacementGroup], 0);
          assert.deepEqual(
            await frozen(a, mainReleaseIds),
            originalFrozen,
            "original snapshots and media bytes remain intact after every pointer change",
          );
          ok(
            await a.call(`/v1/cms/read-tokens/${leafToken.id}`, "DELETE"),
            204,
          );
          error(
            await leafToken.call("/v1/cms/read/categories"),
            401,
            "UNAUTHENTICATED",
          );
          error(
            await leafToken.call(
              `/v1/cms/read/releases/${one.release.id}/audio`,
            ),
            401,
            "UNAUTHENTICATED",
          );
        },
      );
      assert.equal(
        externalCalls,
        0,
        "reading, publication and category edits never invoke a remote provider",
      );
    } finally {
      globalThis.fetch = nativeFetch;
      if (runtime) {
        try {
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
