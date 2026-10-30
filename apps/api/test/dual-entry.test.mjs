import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import express from "express";
import { createApplication } from "../dist/app.js";
import { readConfig } from "../dist/config.js";
import { createSites, listenHttp, closeHttp } from "../dist/sites.js";
import { migrate } from "../dist/migrate.js";

const database = process.env.TEST_DATABASE_URL;
if (database && new URL(database).pathname !== "/cms_reading_test_20261027")
  throw new Error(
    "Dual-entry integration requires the explicitly isolated cms_reading_test_20261027 database",
  );
const env = {
  DATABASE_URL:
    "postgresql://fixture:fixture@localhost/cms_reading_test_20261027",
  SESSION_SECRET: "dual-entry-synthetic-fixture-secret-at-least-32",
  PUBLIC_ORIGIN: "http://workbench.example.test",
  CMS_PUBLIC_ORIGIN: "http://cms.example.test",
  NODE_ENV: "test",
  REGISTRATION_ENABLED: "true",
};
async function fixtures() {
  const root = await mkdtemp(join(tmpdir(), "tts-dual-entry-"));
  const web = join(root, "web"),
    cms = join(root, "cms");
  for (const [dir, name] of [
    [web, "WORKBENCH"],
    [cms, "CMS"],
  ]) {
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(
      join(dir, "index.html"),
      `<!doctype html><title>${name}</title><p>${name} fixture</p>`,
    );
    await writeFile(
      join(dir, "assets", "index-a1b2c3d4.js"),
      'console.log("fixture");',
    );
    await writeFile(
      join(dir, "assets", "index-a1b2c3d4.js.map"),
      '{"private":"source map fixture"}',
    );
  }
  return { root, web, cms };
}
test("Dual-entry configuration validates explicit origins and keeps legacy startup", () => {
  assert.equal(readConfig(env).CMS_PORT, 3001);
  assert.equal(
    readConfig({ ...env, CMS_PUBLIC_ORIGIN: "" }).CMS_PUBLIC_ORIGIN,
    undefined,
  );
  assert.throws(
    () => readConfig({ ...env, CMS_DIST: "fixture", CMS_PORT: "3000" }),
    /different/,
  );
  for (const key of ["PUBLIC_ORIGIN", "CMS_PUBLIC_ORIGIN"])
    for (const origin of [
      "https://user:password@example.test",
      "file:///tmp/site",
      "https://example.test/path",
      "https://example.test?x=1",
      "https://example.test/#x",
    ])
      assert.throws(() => readConfig({ ...env, [key]: origin }));
  assert.throws(
    () => readConfig({ ...env, NODE_ENV: "production" }),
    /requires HTTPS/,
  );
  assert.throws(
    () =>
      readConfig({
        ...env,
        NODE_ENV: "production",
        PUBLIC_ORIGIN: "https://workbench.example.test",
      }),
    /CMS_PUBLIC_ORIGIN requires HTTPS/,
  );
  assert.equal(
    readConfig({
      ...env,
      NODE_ENV: "production",
      PUBLIC_ORIGIN: "https://workbench.example.test",
      CMS_PUBLIC_ORIGIN: "",
    }).CMS_PUBLIC_ORIGIN,
    undefined,
  );
});
test("Dual-entry static boundary uses listener identity, SPA routes and asset caches", async () => {
  const dirs = await fixtures();
  const config = readConfig({ ...env, WEB_DIST: dirs.web, CMS_DIST: dirs.cms });
  const sites = createSites(config);
  const handler = express();
  handler.use(sites.frontend);
  handler.use((req, res) =>
    res.status(404).json({ code: "NOT_FOUND", origin: sites.origin(req) }),
  );
  handler.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ code: error.code }),
  );
  const web = createServer(handler),
    cms = sites.cmsServer(handler);
  try {
    await listenHttp(web, 0, "127.0.0.1");
    await listenHttp(cms, 0, "127.0.0.1");
    const wb = `http://127.0.0.1:${web.address().port}`,
      cb = `http://127.0.0.1:${cms.address().port}`;
    assert.match(await (await fetch(wb)).text(), /WORKBENCH/);
    for (const path of ["/", "/read", "/articles/example", "/categories"]) {
      const response = await fetch(cb + path, {
        headers: { Accept: "text/html" },
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /CMS fixture/);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.equal(
      (
        await fetch(cb + "/read", {
          method: "HEAD",
          headers: { Accept: "text/html" },
        })
      ).status,
      200,
    );
    for (const path of [
      "/assets/missing.js",
      "/assets/missing",
      "/missing.png",
      "/v1/nope",
      "/health/nope",
      "/assets/index-a1b2c3d4.js.map",
      "/assets/index-a1b2c3d4.js%2emap",
      "/assets/index-a1b2c3d4.js%2EMAP",
      "/assets/bad%ZZ",
      "/.env",
    ])
      assert.equal(
        (await fetch(cb + path, { headers: { Accept: "text/html" } })).status,
        404,
        path,
      );
    const asset = await fetch(cb + "/assets/index-a1b2c3d4.js");
    assert.equal(asset.status, 200);
    assert.equal(
      asset.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    const siteConfig = await fetch(cb + "/site-config.json");
    assert.equal(siteConfig.headers.get("cache-control"), "no-store");
    assert.deepEqual(await siteConfig.json(), {
      workbenchUrl: config.PUBLIC_ORIGIN,
      cmsUrl: config.CMS_PUBLIC_ORIGIN,
    });
    const spoof = await fetch(cb + "/v1/nope", {
      headers: {
        Host: "workbench.example.test",
        "X-Forwarded-Host": "workbench.example.test",
      },
    });
    assert.equal((await spoof.json()).origin, config.CMS_PUBLIC_ORIGIN);
  } finally {
    await Promise.all([closeHttp(web), closeHttp(cms)]);
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test(
  "Dual-entry HTTP + PostgreSQL share auth, conditional writes, imports and protected audio",
  { skip: !database },
  async (t) => {
    await migrate(database);
    const dirs = await fixtures();
    const runtime = await createApplication(
      readConfig({
        ...env,
        DATABASE_URL: database,
        WEB_DIST: dirs.web,
        CMS_DIST: dirs.cms,
      }),
    );
    let owner;
    try {
      await runtime.app.listen(0, "127.0.0.1");
      await listenHttp(runtime.cmsServer, 0, "127.0.0.1");
      const wb = await runtime.app.getUrl(),
        cb = `http://127.0.0.1:${runtime.cmsServer.address().port}`;
      let cookie = "",
        csrf = "";
      async function call(
        base,
        path,
        {
          method = "GET",
          body,
          origin,
          withCsrf = true,
          authenticated = true,
          headers = {},
        } = {},
      ) {
        const response = await fetch(base + path, {
          method,
          headers: {
            ...(authenticated && cookie ? { Cookie: cookie } : {}),
            ...(method === "GET"
              ? {}
              : {
                  "Content-Type": "application/json",
                  Origin:
                    origin ??
                    (base === cb ? env.CMS_PUBLIC_ORIGIN : env.PUBLIC_ORIGIN),
                  ...(withCsrf ? { "X-CSRF-Token": csrf } : {}),
                }),
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const set = response.headers.getSetCookie();
        if (authenticated && set.length)
          cookie = set.map((value) => value.split(";")[0]).join("; ");
        const mime = response.headers.get("content-type") || "";
        const data =
          response.status === 204
            ? null
            : mime.includes("json")
              ? await response.json()
              : mime.startsWith("audio/")
                ? Buffer.from(await response.arrayBuffer())
                : await response.text();
        if (data?.csrfToken) csrf = data.csrfToken;
        return { status: response.status, data, headers: response.headers };
      }
      const expect = (response, status) => {
        assert.equal(response.status, status, JSON.stringify(response.data));
        return response.data;
      };
      await t.test(
        "Each listener checks its own Origin without trusting forwarded headers",
        async () => {
          for (const [base, wrong] of [
            [cb, env.PUBLIC_ORIGIN],
            [wb, env.CMS_PUBLIC_ORIGIN],
          ]) {
            expect(
              await call(base, "/v1/auth/csrf", {
                headers: {
                  Origin: wrong,
                  Host: "attacker.invalid",
                  "X-Forwarded-Host": "attacker.invalid",
                },
              }),
              403,
            );
            expect(
              await call(base, "/v1/auth/login", {
                method: "POST",
                origin: wrong,
                body: {},
              }),
              403,
            );
            expect(
              await call(base, "/v1/auth/login", {
                method: "POST",
                headers: { Origin: "" },
                body: {},
              }),
              403,
            );
            expect(await call(base, "/health/ready"), 200);
            expect(
              await call(base, "/v1/cms/articles", { authenticated: false }),
              401,
            );
          }
        },
      );
      await t.test(
        "CMS session and CSRF remain required; same account is available through workbench",
        async () => {
          expect(await call(cb, "/v1/auth/csrf"), 200);
          const login = `dual-${randomUUID()}`,
            password = "Synthetic8!";
          owner = expect(
            await call(cb, "/v1/auth/register", {
              method: "POST",
              body: { login, password, displayName: "Dual site fixture" },
            }),
            201,
          ).id;
          expect(
            await call(cb, "/v1/auth/login", {
              method: "POST",
              body: { login, password },
            }),
            200,
          );
          expect(await call(cb, "/v1/auth/csrf"), 200);
          expect(
            await call(cb, "/v1/articles", {
              method: "POST",
              body: { title: "CSRF", text: "fixture" },
              withCsrf: false,
            }),
            403,
          );
          assert.equal(expect(await call(wb, "/v1/auth/me"), 200).id, owner);
        },
      );
      let article;
      await t.test(
        "Two entrypoints use atomic revision writes and keep local conflict input",
        async () => {
          article = expect(
            await call(cb, "/v1/cms/articles", {
              method: "POST",
              body: {
                title: "独立した入口",
                text: "日本語の本文です。",
                cms: {
                  slug: `dual-${randomUUID()}`,
                  summary: "fixture",
                  categoryId: null,
                  tagIds: [],
                },
              },
            }),
            201,
          );
          const old = article;
          expect(
            await call(wb, `/v1/articles/${article.id}`, {
              method: "PATCH",
              body: {
                title: "工作台更新",
                text: old.text,
                expectedRevision: old.revision,
              },
            }),
            200,
          );
          const draft = {
            title: "CMS local draft preserved",
            text: old.text,
            expectedRevision: old.revision,
            cms: {
              expectedRevision: old.cms.revision,
              slug: old.cms.slug,
              summary: old.cms.summary,
              categoryId: null,
              tagIds: [],
            },
          };
          expect(
            await call(cb, `/v1/cms/articles/${article.id}`, {
              method: "PATCH",
              body: draft,
            }),
            409,
          );
          assert.equal(draft.title, "CMS local draft preserved");
          article = expect(
            await call(cb, `/v1/cms/articles/${article.id}`),
            200,
          );
          assert.equal(article.title, "工作台更新");
        },
      );
      await t.test(
        "Only structured import permits more than 64 KiB, with a 1 MiB cap",
        async () => {
          const source = `dual-${randomUUID()}`;
          const items = Array.from({ length: 5 }, (_, i) => ({
            externalId: `item-${i}`,
            title: "日本語",
            text: "文".repeat(5000),
            slug: `dual-import-${i}-${randomUUID()}`,
            categoryId: null,
            tagIds: [],
          }));
          const response = expect(
            await call(cb, "/v1/cms/import/preview", {
              method: "POST",
              body: { source, items },
            }),
            200,
          );
          assert.equal(response.items.length, 5);
          expect(
            await call(cb, "/v1/articles", {
              method: "POST",
              body: { title: "too big", text: "x".repeat(70000) },
            }),
            413,
          );
          expect(
            await call(cb, "/v1/cms/import/preview", {
              method: "POST",
              body: { source, items: [], padding: "x".repeat(1048576) },
            }),
            413,
          );
          expect(
            await call(cb, "/v1/missing", { headers: { Accept: "text/html" } }),
            404,
          );
        },
      );
      await t.test(
        "Synthetic generated and published audio stays private and uses the CMS feed origin",
        async () => {
          const tone = await readFile(
            new URL("../../web/qa/tone.mp3", import.meta.url),
          );
          runtime.state.speech.synthesize = async () => ({
            audio: tone,
            internalVersion: article.currentRuleVersion,
          });
          const generated = expect(
            await call(cb, `/v1/articles/${article.id}/audio`, {
              method: "POST",
              body: {
                expectedRevision: article.revision,
                voice: "ja-jp-primary",
                speed: 1,
              },
            }),
            200,
          );
          const audioPath = `/v1/articles/${article.id}/audio?audioId=${generated.audio.audioId}`;
          expect(await call(cb, audioPath, { authenticated: false }), 401);
          const audio = await call(cb, audioPath);
          assert.equal(audio.status, 200);
          assert.deepEqual(audio.data, tone);
          assert.equal(audio.headers.get("cache-control"), "no-store");
          assert.equal(audio.headers.get("x-content-type-options"), "nosniff");
          article = expect(
            await call(cb, `/v1/cms/articles/${article.id}`),
            200,
          );
          const release = expect(
            await call(cb, `/v1/cms/articles/${article.id}/releases`, {
              method: "POST",
              body: {
                expectedRevision: article.revision,
                expectedCmsRevision: article.cms.revision,
                expectedAudioId: generated.audio.audioId,
              },
            }),
            201,
          );
          expect(
            await call(cb, `/v1/cms/read/releases/${release.id}/audio`),
            200,
          );
          const feed = expect(await call(cb, "/v1/cms/read/rss"), 200);
          assert.ok(feed.includes(env.CMS_PUBLIC_ORIGIN));
          assert.ok(!feed.includes(env.PUBLIC_ORIGIN));
          expect(
            await call(cb, "/v1/auth/logout", { method: "POST", body: {} }),
            204,
          );
          expect(await call(cb, "/v1/auth/me"), 401);
        },
      );
    } finally {
      if (owner)
        await runtime.pool.query("DELETE FROM ac_accounts WHERE id=$1", [
          owner,
        ]);
      await runtime.close();
      assert.equal(runtime.cmsServer.listening, false);
      assert.equal(runtime.app.getHttpServer().listening, false);
      await rm(dirs.root, { recursive: true, force: true });
    }
  },
);
test(
  "CMS missing origin fails closed while workbench and health remain usable",
  { skip: !database },
  async () => {
    const dirs = await fixtures();
    const runtime = await createApplication(
      readConfig({
        ...env,
        DATABASE_URL: database,
        CMS_PUBLIC_ORIGIN: "",
        WEB_DIST: dirs.web,
        CMS_DIST: dirs.cms,
      }),
    );
    try {
      await runtime.app.listen(0, "127.0.0.1");
      await listenHttp(runtime.cmsServer, 0, "127.0.0.1");
      const wb = await runtime.app.getUrl(),
        cb = `http://127.0.0.1:${runtime.cmsServer.address().port}`;
      for (const path of [
        "/v1/config",
        "/v1/auth/csrf",
        "/v1/cms/read/articles",
      ]) {
        const response = await fetch(cb + path);
        assert.equal(response.status, 503);
        assert.equal((await response.json()).code, "CMS_ORIGIN_UNCONFIGURED");
      }
      assert.equal((await fetch(wb + "/v1/config")).status, 200);
      assert.equal((await fetch(cb + "/health/ready")).status, 200);
      assert.match(await (await fetch(cb)).text(), /CMS fixture/);
    } finally {
      await runtime.close();
      await rm(dirs.root, { recursive: true, force: true });
    }
  },
);
test(
  "CMS bind failure closes the first listener and shared runtime",
  { skip: !database },
  async () => {
    const dirs = await fixtures();
    const blocked = createServer((_req, res) => res.end("fixture"));
    await listenHttp(blocked, 0, "127.0.0.1");
    const free = createServer();
    await listenHttp(free, 0, "127.0.0.1");
    const port = free.address().port;
    await closeHttp(free);
    const runtime = await createApplication(
      readConfig({
        ...env,
        DATABASE_URL: database,
        PORT: String(port),
        CMS_PORT: String(blocked.address().port),
        CMS_DIST: dirs.cms,
      }),
    );
    try {
      await assert.rejects(runtime.listen(), { code: "EADDRINUSE" });
      assert.equal(runtime.app.getHttpServer().listening, false);
      assert.equal(runtime.cmsServer.listening, false);
      assert.equal(runtime.pool.ended, true);
      await runtime.close();
    } finally {
      await closeHttp(blocked);
      await rm(dirs.root, { recursive: true, force: true });
    }
  },
);
