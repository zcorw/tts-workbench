import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { gzipSync } from "node:zlib";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import proxyaddr from "proxy-addr";
import { z } from "zod";
import { createApplication, sendError } from "../dist/app.js";
import { readConfig } from "../dist/config.js";
import { migrate } from "../dist/migrate.js";
import { listenHttp } from "../dist/sites.js";

const database = process.env.TEST_DATABASE_URL;
if (database && new URL(database).pathname !== "/cms_reading_test_20261027")
  throw new Error(
    "Security regression requires the explicitly isolated cms_reading_test_20261027 database",
  );

// Gate before defining any HTTP fixture: these small malformed-body tests must
// never accidentally run with the old vulnerable host node_modules.
for (const [name, minimum] of [
  ["body-parser", "2.4.0"],
  ["proxy-addr", "2.0.8"],
  ["zod", "4.6.6"],
]) {
  const { version } = JSON.parse(
    await readFile(
      new URL(`../node_modules/${name}/package.json`, import.meta.url),
      "utf8",
    ),
  );
  const actual = version.split(".").map(Number),
    wanted = minimum.split(".").map(Number);
  const comparison = actual.reduce(
    (result, part, i) => result || Math.sign(part - wanted[i]),
    0,
  );
  assert(
    !version.includes("-") && comparison >= 0,
    `${name} ${version} is below the reviewed fix ${minimum}; no malformed request was sent`,
  );
}

const env = {
  DATABASE_URL:
    "postgresql://fixture:fixture@localhost/cms_reading_test_20261027",
  SESSION_SECRET: "synthetic-security-regression-secret-only-20261030",
  PUBLIC_ORIGIN: "http://security-workbench.example.test",
  CMS_PUBLIC_ORIGIN: "http://security-cms.example.test",
  NODE_ENV: "test",
  REGISTRATION_ENABLED: "true",
};

test("Only reviewed parser errors become client responses and internal details stay private", () => {
  function response(error) {
    const result = {};
    const res = {
      status(value) {
        result.status = value;
        return this;
      },
      json(value) {
        result.body = value;
        return this;
      },
      set() {
        return this;
      },
    };
    sendError(error, { requestId: "synthetic-parser-request" }, res);
    assert.equal(result.body.message, result.body.code);
    assert.equal(result.body.requestId, "synthetic-parser-request");
    assert(!JSON.stringify(result).includes("synthetic-internal-detail"));
    return result;
  }
  const error = (fields) =>
    Object.assign(new Error("synthetic-internal-detail"), {
      body: "synthetic-internal-detail",
      ...fields,
    });
  for (const code of ["Z_DATA_ERROR", "Z_BUF_ERROR"])
    assert.equal(
      response(error({ status: 400, statusCode: 400, expose: true, code }))
        .status,
      400,
    );
  for (const type of ["encoding.unsupported", "charset.unsupported"])
    assert.equal(
      response(error({ status: 415, statusCode: 415, expose: true, type }))
        .status,
      415,
    );
  for (const fields of [
    { status: 400, statusCode: 400, expose: true },
    {
      status: 400,
      statusCode: 400,
      expose: true,
      code: "UNKNOWN_INTERNAL_ERROR",
    },
    {
      status: 415,
      statusCode: 415,
      expose: false,
      type: "encoding.unsupported",
    },
    { status: 400, statusCode: 415, expose: true, code: "Z_DATA_ERROR" },
  ]) {
    const result = response(error(fields));
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "DEPENDENCY_UNAVAILABLE");
  }
});

test("Patched proxy trust does not treat unrelated IPv4 clients as mapped IPv6 proxies", () => {
  assert.equal(readConfig(env).TRUST_PROXY, "loopback");
  const loopback = proxyaddr.compile([readConfig(env).TRUST_PROXY]);
  assert.equal(loopback("127.0.0.1", 0), true);
  assert.equal(loopback("203.0.113.8", 0), false);
  const request = (peer, forwarded) => ({
    socket: { remoteAddress: peer },
    headers: { "x-forwarded-for": forwarded },
  });
  for (const subnet of ["::ffff:10.0.0.0/8", "::/1"]) {
    const trust = proxyaddr.compile([subnet]);
    assert.equal(trust("203.0.113.8", 0), false, subnet);
    assert.equal(
      proxyaddr(request("203.0.113.8", "198.51.100.19"), trust),
      "203.0.113.8",
    );
  }
  for (const subnet of ["10.0.0.0/8", "::ffff:10.0.0.0/104"]) {
    const trust = proxyaddr.compile([subnet]);
    assert.equal(trust("10.1.2.3", 0), true);
    assert.equal(trust("::ffff:10.1.2.3", 0), true);
    assert.equal(trust("203.0.113.8", 0), false);
    assert.equal(
      proxyaddr(request("10.1.2.3", "198.51.100.19"), trust),
      "198.51.100.19",
    );
  }
});

test("Patched collection validation rejects a modest oversized array before per-element error growth", () => {
  const schema = z.array(z.string().min(1)).max(8);
  const oversized = schema.safeParse(Array(128).fill(null));
  assert.equal(oversized.success, false);
  assert(oversized.error.issues.some((issue) => issue.code === "too_big"));
  assert(
    oversized.error.issues.length <= 2,
    "Oversized collections must not accumulate an issue for every invalid element",
  );
  assert.equal(schema.safeParse(Array(8).fill("日本語")).success, true);
  assert.equal(
    schema.safeParse([null]).success,
    false,
    "The guard must not skip element validation for allowed-size input",
  );
});

test(
  "Patched HTTP parsing preserves compression, client errors and validation limits on both listeners",
  { skip: !database },
  async (t) => {
    await migrate(database);
    const root = await mkdtemp(join(tmpdir(), "tts-security-regression-"));
    await writeFile(
      join(root, "index.html"),
      "<!doctype html><title>Synthetic security fixture</title>",
    );
    const runtime = await createApplication(
      readConfig({ ...env, DATABASE_URL: database, CMS_DIST: root }),
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
        { method = "GET", body, raw, encoding, authenticated = true } = {},
      ) {
        const bytes =
          raw ??
          (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
        return new Promise((resolve, reject) => {
          const target = new URL(path, base);
          const req = httpRequest(
            target,
            {
              method,
              headers: {
                ...(authenticated && cookie ? { Cookie: cookie } : {}),
                ...(method === "GET"
                  ? {}
                  : {
                      Origin:
                        base === cb ? env.CMS_PUBLIC_ORIGIN : env.PUBLIC_ORIGIN,
                      "Content-Type": "application/json; charset=utf-8",
                      ...(authenticated ? { "X-CSRF-Token": csrf } : {}),
                    }),
                ...(encoding ? { "Content-Encoding": encoding } : {}),
                ...(bytes ? { "Content-Length": bytes.length } : {}),
              },
            },
            (res) => {
              const chunks = [];
              res.on("data", (chunk) => chunks.push(chunk));
              res.on("error", reject);
              res.on("end", () => {
                try {
                  if (authenticated && res.headers["set-cookie"]?.length)
                    cookie = res.headers["set-cookie"]
                      .map((value) => value.split(";")[0])
                      .join("; ");
                  const text = Buffer.concat(chunks).toString("utf8");
                  assert.match(
                    res.headers["content-type"] ?? "",
                    /application\/json/,
                  );
                  const data = JSON.parse(text);
                  if (authenticated && data.csrfToken) csrf = data.csrfToken;
                  resolve({
                    status: res.statusCode,
                    data,
                    headers: res.headers,
                  });
                } catch (error) {
                  reject(error);
                }
              });
            },
          );
          req.on("error", reject);
          req.setTimeout(10000, () =>
            req.destroy(new Error("Bounded local security request timed out")),
          );
          req.end(bytes);
        });
      }
      const expect = (response, status) => {
        assert.equal(response.status, status, JSON.stringify(response.data));
        return response.data;
      };
      const login = `security-${randomUUID()}`,
        password = "Synthetic8!";
      expect(await call(cb, "/v1/auth/csrf"), 200);
      owner = expect(
        await call(cb, "/v1/auth/register", {
          method: "POST",
          body: { login, password, displayName: "Synthetic security test" },
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
      let article;

      await t.test(
        "Valid small gzip UTF-8 JSON remains accepted by both entrypoints",
        async () => {
          for (const base of [wb, cb]) {
            const body = {
              title: "圧縮された日本語",
              text: "合成データだけを保存します。",
              cms: {
                slug: `compressed-${randomUUID()}`,
                summary: "",
                categoryId: null,
                tagIds: [],
              },
            };
            const result = expect(
              await call(base, "/v1/cms/articles", {
                method: "POST",
                raw: gzipSync(Buffer.from(JSON.stringify(body))),
                encoding: "gzip",
              }),
              201,
            );
            assert.equal(result.text, body.text);
            article = result;
          }
        },
      );
      await t.test(
        "Small malformed compressed bodies return client errors and leave both listeners usable",
        async () => {
          const complete = gzipSync(Buffer.from("{}"));
          const malformed = [
            Buffer.concat([complete, Buffer.from([0xde, 0xad, 0xbe, 0xef])]),
            Buffer.from("synthetic invalid gzip"),
          ];
          for (const base of [wb, cb]) {
            for (const raw of malformed) {
              const rejected = await call(base, "/v1/cms/articles", {
                method: "POST",
                raw,
                encoding: "gzip",
                authenticated: false,
              });
              expect(rejected, 400);
              assert.equal(rejected.headers["cache-control"], "no-store");
              assert.equal(typeof rejected.data.requestId, "string");
              // Each response is followed by new requests; a late decoder error must
              // not terminate the process or poison the next parser lifecycle.
              expect(await call(wb, "/health/ready"), 200);
              expect(await call(cb, "/health/ready"), 200);
              assert.equal(
                expect(await call(cb, `/v1/cms/articles/${article.id}`), 200)
                  .text,
                article.text,
              );
            }
            expect(
              await call(base, "/v1/cms/articles", {
                method: "POST",
                raw: Buffer.from("{}"),
                encoding: "synthetic-unsupported",
                authenticated: false,
              }),
              415,
            );
            expect(await call(base, "/health/ready"), 200);
          }
        },
      );
      await t.test(
        "Decompressed size limits remain 64 KiB normally and 1 MiB only for the two import endpoints",
        async () => {
          const ordinary = gzipSync(
            Buffer.from(
              JSON.stringify({ title: "too large", text: "x".repeat(70000) }),
            ),
          );
          assert(ordinary.length < 1024);
          for (const base of [wb, cb])
            expect(
              await call(base, "/v1/articles", {
                method: "POST",
                raw: ordinary,
                encoding: "gzip",
              }),
              413,
            );
          const source = `security-import-${randomUUID()}`;
          const items = Array.from({ length: 5 }, (_, i) => ({
            externalId: `item-${i}`,
            title: "日本語",
            text: "文".repeat(5000),
            slug: `security-import-${randomUUID()}`,
            categoryId: null,
            tagIds: [],
          }));
          const large = Buffer.from(JSON.stringify({ source, items }));
          assert(large.length > 65536 && large.length < 1048576);
          const preview = expect(
            await call(cb, "/v1/cms/import/preview", {
              method: "POST",
              raw: gzipSync(large),
              encoding: "gzip",
            }),
            200,
          );
          assert.equal(preview.items.length, 5);
          const commit = {
            source,
            items: items.map((item) => ({
              ...item,
              articleId: null,
              expectedRevision: 0,
              expectedCmsRevision: 0,
            })),
          };
          const imported = expect(
            await call(cb, "/v1/cms/import", {
              method: "POST",
              raw: gzipSync(Buffer.from(JSON.stringify(commit))),
              encoding: "gzip",
            }),
            200,
          );
          assert.equal(
            imported.items.filter((item) => item.status === "created").length,
            5,
          );
          const oversized = gzipSync(
            Buffer.from(
              JSON.stringify({
                source,
                items: [],
                padding: "x".repeat(1048576),
              }),
            ),
          );
          for (const endpoint of ["/v1/cms/import", "/v1/cms/import/preview"])
            expect(
              await call(cb, endpoint, {
                method: "POST",
                raw: oversized,
                encoding: "gzip",
              }),
              413,
            );
          expect(await call(cb, "/health/ready"), 200);
        },
      );
      await t.test(
        "CMS rejects oversized tag/import collections without changing existing documents",
        async () => {
          const before = expect(
            await call(cb, `/v1/cms/articles/${article.id}`),
            200,
          );
          expect(
            await call(cb, `/v1/cms/articles/${article.id}`, {
              method: "PATCH",
              body: {
                title: before.title,
                text: before.text,
                expectedRevision: before.revision,
                cms: {
                  slug: before.cms.slug,
                  summary: before.cms.summary,
                  categoryId: null,
                  tagIds: Array(128).fill(null),
                  expectedRevision: before.cms.revision,
                },
              },
            }),
            400,
          );
          expect(
            await call(cb, "/v1/cms/import/preview", {
              method: "POST",
              body: {
                source: "synthetic-too-many",
                items: Array(21).fill(null),
              },
            }),
            400,
          );
          const after = expect(
            await call(cb, `/v1/cms/articles/${article.id}`),
            200,
          );
          assert.equal(after.revision, before.revision);
          assert.equal(after.text, before.text);
          const saved = expect(
            await call(wb, `/v1/articles/${article.id}`, {
              method: "PATCH",
              body: {
                title: "検証後も保存可能",
                text: after.text,
                expectedRevision: after.revision,
              },
            }),
            200,
          );
          assert.equal(saved.text, before.text);
        },
      );
    } finally {
      if (owner)
        await runtime.pool.query("DELETE FROM ac_accounts WHERE id=$1", [
          owner,
        ]);
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
