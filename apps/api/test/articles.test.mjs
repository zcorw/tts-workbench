import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApplication } from "../dist/app.js";
import { readConfig } from "../dist/config.js";
import { migrate } from "../dist/migrate.js";

const url = process.env.TEST_DATABASE_URL;
test("Article deployment capacity defaults and validation", () => {
  const env = {
    DATABASE_URL: "postgresql://test:test@localhost/test",
    SESSION_SECRET: "s".repeat(32),
    PUBLIC_ORIGIN: "http://localhost:4181",
  };
  assert.equal(readConfig(env).MAX_ARTICLES, 100);
  assert.equal(readConfig({ ...env, MAX_ARTICLES: "3" }).MAX_ARTICLES, 3);
  for (const value of ["0", "-1", "1.5", "invalid", ""])
    assert.throws(() => readConfig({ ...env, MAX_ARTICLES: value }));
});

test(
  "Articles: real HTTP/PG ownership, revisions, quota races, Unicode and restart persistence",
  { skip: !url },
  async () => {
    await migrate(url);
    await migrate(url); // Additive migration is safely repeatable.
    const config = readConfig({
      DATABASE_URL: url,
      SESSION_SECRET: "article-test-secret-at-least-32-characters",
      PUBLIC_ORIGIN: "http://127.0.0.1:4181",
      NODE_ENV: "test",
      REGISTRATION_ENABLED: "true",
      MAX_ARTICLES: "3",
    });
    let runtime = await createApplication(config);
    let base;
    const logins = [];
    async function start() {
      await runtime.app.listen(0, "127.0.0.1");
      base = await runtime.app.getUrl();
    }
    function browser() {
      let cookie = "",
        csrf = "";
      return {
        async request(
          path,
          method = "GET",
          body,
          withCsrf = true,
          origin = config.PUBLIC_ORIGIN,
        ) {
          const response = await fetch(base + path, {
            method,
            headers: {
              ...(cookie ? { cookie } : {}),
              ...(method === "GET"
                ? {}
                : {
                    Origin: origin,
                    "Content-Type": "application/json",
                    ...(withCsrf ? { "X-CSRF-Token": csrf } : {}),
                  }),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          });
          const cookies = response.headers.getSetCookie();
          if (cookies.length)
            cookie = cookies.map((c) => c.split(";")[0]).join("; ");
          const data = response.status === 204 ? null : await response.json();
          if (path === "/v1/auth/csrf" && data.csrfToken) csrf = data.csrfToken;
          return { status: response.status, data, headers: response.headers };
        },
        async signIn() {
          const login = `article-${randomUUID()}`;
          logins.push(login);
          await this.request("/v1/auth/csrf");
          assert.equal(
            (
              await this.request("/v1/auth/register", "POST", {
                login,
                password: "Eight123",
                displayName: "Article test",
              })
            ).status,
            201,
          );
          assert.equal(
            (
              await this.request("/v1/auth/login", "POST", {
                login,
                password: "Eight123",
              })
            ).status,
            200,
          );
          await this.request("/v1/auth/csrf");
        },
      };
    }
    const a = browser(),
      b = browser(),
      anon = browser();
    try {
      await start();
      assert.equal((await anon.request("/v1/config")).data.maxArticles, 3);
      assert.equal((await anon.request("/v1/articles")).status, 401);
      await a.signIn();
      await b.signIn();
      assert.equal(
        (
          await a.request(
            "/v1/articles",
            "POST",
            { title: "draft", text: "" },
            false,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await a.request(
            "/v1/articles",
            "POST",
            { title: "draft", text: "" },
            true,
            "https://other.invalid",
          )
        ).status,
        403,
      );
      for (const body of [
        { title: " ", text: "" },
        { title: "😀".repeat(121), text: "" },
        { title: "valid", text: "a".repeat(10001) },
        { title: "valid", text: "日".repeat(17000) },
        { title: "valid", text: "bad\u000b" },
        { title: "valid", text: "bad\u007f" },
        { title: "valid", text: "\ud800" },
        { title: "valid", text: "", owner: randomUUID() },
      ]) {
        assert.equal(
          (await a.request("/v1/articles", "POST", body)).status,
          400,
        );
      }
      const created = await a.request("/v1/articles", "POST", {
        title: "  Hello 100%_  ",
        text: "",
      });
      assert.equal(created.status, 201);
      let article = created.data;
      assert.equal(article.title, "Hello 100%_");
      assert.equal(article.text, "");
      assert.equal(article.revision, 1);
      assert.equal(article.contentRevision, 1);
      assert.equal(article.audio, null);
      assert.equal(article.audioStale, false);
      assert.equal(article.currentRuleVersion, 0);
      assert.equal(created.headers.get("cache-control"), "no-store");
      assert(created.headers.get("x-request-id"));
      const path = `/v1/articles/${article.id}`;
      for (const [method, target, body] of [
        ["GET", path],
        ["PATCH", path, { title: "stolen", text: "", expectedRevision: 1 }],
        ["DELETE", path + "?expectedRevision=1"],
      ]) {
        const r = await b.request(target, method, body);
        assert.equal(r.status, 404);
        assert.equal(r.data.code, "NOT_FOUND");
      }
      assert.equal((await b.request("/v1/articles")).data.total, 0);
      assert.equal(
        (await a.request(`/v1/articles/${randomUUID()}`)).status,
        404,
      );
      assert.equal(
        (await a.request(path, "PATCH", { title: "x", text: "" })).status,
        400,
      );
      assert.equal((await a.request(path, "DELETE")).status, 400);
      const noOp = await a.request(path, "PATCH", {
        title: " Hello 100%_ ",
        text: "",
        expectedRevision: 1,
      });
      assert.equal(noOp.data.updatedAt, article.updatedAt);
      assert.equal(noOp.data.revision, 1);
      article = (
        await a.request(path, "PATCH", {
          title: "Renamed",
          text: "",
          expectedRevision: 1,
        })
      ).data;
      assert.equal(article.revision, 2);
      assert.equal(article.contentRevision, 1);
      const original = "か\u3099\n\t😀";
      article = (
        await a.request(path, "PATCH", {
          title: "Renamed",
          text: original,
          expectedRevision: 2,
        })
      ).data;
      assert.equal(article.text, original);
      assert.equal(article.revision, 3);
      assert.equal(article.contentRevision, 2);
      const conflict = await a.request(path, "PATCH", {
        title: "old",
        text: "old",
        expectedRevision: 2,
      });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.data.code, "REVISION_CONFLICT");
      const race = await Promise.all(
        ["one", "two"].map((title) =>
          a.request(path, "PATCH", {
            title,
            text: original,
            expectedRevision: 3,
          }),
        ),
      );
      assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
      article = (await a.request(path)).data;
      assert.equal(article.revision, 4);
      assert.equal(article.contentRevision, 2);
      assert.equal(
        (await a.request(path + "?expectedRevision=3", "DELETE")).status,
        409,
      );
      const boundary = await a.request("/v1/articles", "POST", {
        title: "😀".repeat(120),
        text: "😀".repeat(10000),
      });
      assert.equal(boundary.status, 201);
      assert.equal([...boundary.data.text].length, 10000);
      const capacity = await Promise.all(
        [1, 2, 3].map((n) =>
          a.request("/v1/articles", "POST", {
            title: `Quota ${n} %_`,
            text: "",
          }),
        ),
      );
      assert.equal(capacity.filter((r) => r.status === 201).length, 1);
      assert(
        capacity
          .filter((r) => r.status !== 201)
          .every((r) => r.status === 409 && r.data.code === "ARTICLE_LIMIT"),
      );
      const page = (await a.request("/v1/articles?limit=1&offset=1")).data;
      assert.equal(page.total, 3);
      assert.equal(page.items.length, 1);
      assert.equal(page.offset, 1);
      assert(!Object.hasOwn(page.items[0], "text"));
      assert.equal((await a.request("/v1/articles?q=quota")).data.total, 1);
      assert.equal((await a.request("/v1/articles?q=%25_")).data.total, 1);
      assert.equal((await a.request("/v1/articles?limit=101")).status, 400);
      await a.request("/v1/vocabulary", "POST", {
        text: "日本",
        reading: "にほん",
      });
      assert.equal((await a.request(path)).data.currentRuleVersion, 1);
      const removal = await Promise.all(
        [1, 2].map(() =>
          a.request(
            `/v1/articles/${boundary.data.id}?expectedRevision=1`,
            "DELETE",
          ),
        ),
      );
      assert.deepEqual(removal.map((r) => r.status).sort(), [204, 404]);
      assert.equal(
        (
          await a.request("/v1/articles", "POST", {
            title: "freed slot",
            text: "",
          })
        ).status,
        201,
      );
      assert.equal((await a.request("/v1/vocabulary")).data.total, 1);
      // A second application instance reconnects to the same DB and persisted sessions.
      await runtime.close();
      runtime = await createApplication(config);
      await start();
      const persisted = await a.request(path);
      assert.equal(persisted.status, 200);
      assert.equal(persisted.data.text, original);
      assert.equal(persisted.data.revision, 4);
      assert.equal(persisted.data.contentRevision, 2);
      assert.equal((await a.request("/v1/articles")).data.total, 3);
      assert.equal((await b.request(path)).status, 404);
      // F2 routes must not claim persistence in F1.
      assert.equal(
        (await a.request(path + "/audio?audioId=" + randomUUID())).status,
        404,
      );
    } finally {
      await runtime.pool.query(
        "DELETE FROM ac_accounts WHERE login = ANY($1::text[])",
        [logins],
      );
      await runtime.close();
    }
  },
);
