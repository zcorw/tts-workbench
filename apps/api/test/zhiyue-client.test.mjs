import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";
import { createApplication } from "../dist/app.js";
import { readConfig } from "../dist/config.js";
import { migrate } from "../dist/migrate.js";

const db = process.env.ZHIYUE_TEST_DATABASE_URL;
const origin = "https://zhiyue-cms.test";
const route = "/v1/zhiyue";

test("Pinned Zhiyue client over real HTTP", { skip: !db || !process.env.ZHIYUE_CLIENT_SOURCE }, async (t) => {
  const database = new URL(db);
  assert.equal(database.pathname, "/zhiyue_integration_test");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(database.hostname));
  await migrate(db);
  const cmsDist = await mkdtemp(join(tmpdir(), "zhiyue-cms-"));
  const index = join(cmsDist, "index.html");
  await writeFile(index, "<!doctype html><title>Isolated client integration</title>");
  const ids = [];
  let runtime;
  t.after(async () => {
    try {
      if (runtime && ids.length) await runtime.pool.query("DELETE FROM ac_accounts WHERE id=ANY($1::uuid[])", [ids]);
    } finally {
      await runtime?.close();
      await unlink(index);
      await rmdir(cmsDist);
    }
  });
  runtime = await createApplication(readConfig({
    DATABASE_URL: db, SESSION_SECRET: "zhiyue-isolated-test-fixture-secret-20261109",
    NODE_ENV: "test", REGISTRATION_ENABLED: "true", CMS_ZHIYUE_ENABLED: "true",
    CMS_PUBLIC_ORIGIN: origin, CMS_DIST: cmsDist, PUBLIC_ORIGIN: "http://127.0.0.1:3000",
  }));
  runtime.cmsServer.listen(0, "127.0.0.1");
  await once(runtime.cmsServer, "listening");
  const base = `http://127.0.0.1:${runtime.cmsServer.address().port}`;
  async function call(path, { method = "GET", body, headers = {} } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const contentType = response.headers.get("Content-Type") ?? "";
    const data = contentType.includes("application/json") ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { response, data };
  }
  function ok(result, status = 200) {
    assert.equal(result.response.status, status, JSON.stringify(result.data));
    return result.data;
  }
  async function browser(displayName) {
    let cookie = "", csrf = "";
    const request = async (path, method = "GET", body, extra = {}) => {
      const result = await call(path, { method, body, headers: { Origin: origin, Cookie: cookie, "X-CSRF-Token": csrf, ...extra } });
      if (result.response.headers.getSetCookie().length)
        cookie = result.response.headers.getSetCookie().map((part) => part.split(";")[0]).join("; ");
      if (result.data.csrfToken) csrf = result.data.csrfToken;
      return result;
    };
    ok(await request("/v1/auth/csrf"));
    const login = `zhiyue-${randomUUID()}`;
    const password = "Synthetic8!";
    const account = ok(await request("/v1/auth/register", "POST", { login, password, displayName }), 201);
    ids.push(account.id);
    ok(await request("/v1/auth/login", "POST", { login, password }));
    ok(await request("/v1/auth/csrf"));
    return { account, request };
  }
  const { createContext, SourceTextModule, SyntheticModule } = await import("node:vm");
  const timers = new Map();
  let nextTimer = 0;
  const context = createContext({ URL, AbortController, AbortSignal, Date, crypto: webcrypto,
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, setTimeout(() => { timers.delete(id); fn(); }, delay)); return id; },
    clearTimeout(id) { clearTimeout(timers.get(id)); timers.delete(id); },
  });
  t.after(() => { for (const timer of timers.values()) clearTimeout(timer); });
  const modules = new Map();
  async function load(identifier) {
    if (modules.has(identifier)) return modules.get(identifier);
    let loaded;
    if (identifier === "wx") loaded = new SyntheticModule(["default"], function () { this.setExport("default", {}); }, { context });
    else if (identifier.endsWith("/data/zhisheng-config.js")) loaded = new SyntheticModule(["zhishengEnabled", "zhishengOrigin"], function () {
      this.setExport("zhishengEnabled", false); this.setExport("zhishengOrigin", "");
    }, { context });
    else loaded = new SourceTextModule(await readFile(fileURLToPath(identifier), "utf8"), { context, identifier });
    modules.set(identifier, loaded);
    return loaded;
  }
  const module = await load(pathToFileURL(process.env.ZHIYUE_CLIENT_SOURCE).href);
  await module.link((specifier, importer) => load(specifier.startsWith(".") ? new URL(specifier, importer.identifier).href : specifier));
  await module.evaluate();
  const owner = await browser("Synthetic real client");
  const storage = new Map();
  let dropConfirmation = true;
  let confirmationCalls = 0;
  let refreshCalls = 0;
  const client = module.namespace.createZhishengClient({
    origin,
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    // Adapt only the transport origin. All payloads/status codes come from the real server.
    request: async (url, options) => {
      const target = new URL(url);
      assert.equal(target.origin, origin);
      const response = await fetch(base + target.pathname + target.search, options);
      // Preserve the logical HTTPS URL while routing only to isolated loopback HTTP.
      Object.defineProperty(response, "url", { value: url });
      if (target.pathname.endsWith("/device/refresh")) refreshCalls++;
      if (target.pathname.endsWith("/device/confirm")) {
        confirmationCalls++;
        if (dropConfirmation) {
          dropConfirmation = false;
          await response.arrayBuffer();
          throw new Error("Synthetic lost confirmation response after server commit");
        }
      }
      return response;
    },
  });
  const pairing = await client.beginPairing();
  ok(await owner.request(`${route}/account/approve`, "POST", { user_code: pairing.userCode, expected_account_id: owner.account.id }), 204);
  const pending = await client.exchangeDeviceCode(pairing.deviceCode);
  assert.equal(pending.confirmationRequired ?? pending.pendingConfirmation, true);
  client.saveBinding(pending);
  await assert.rejects(client.ensureBinding());
  assert.equal(client.getBinding().confirmationRequired ?? client.getBinding().pendingConfirmation, true);
  const confirmed = await client.ensureBinding();
  assert.equal(confirmed.confirmationRequired ?? confirmed.pendingConfirmation, false);
  assert.equal(confirmationCalls, 2);
  assert.equal((await client.listArticles(0)).total, 0);
  // The pinned client must read saved drafts explicitly while default reads stay publication-only.
  const draftId = randomUUID();
  await runtime.pool.query("INSERT INTO wb_articles(id,account_id,title,text) VALUES($1,$2,'Synthetic draft','Saved draft text')", [draftId, owner.account.id]);
  assert.equal((await client.listArticles(0)).total, 0);
  const draftPage = await client.listArticles(0, undefined, { status: "draft" });
  assert.equal(draftPage.total, 1);
  assert.equal(draftPage.items[0].status, "draft");
  assert.equal((await client.listArticles(0, undefined, { status: "all" })).total, 1);
  const draft = await client.getArticle(draftId, undefined, "draft");
  assert.equal(draft.publishedAt, null);
  assert.equal(draft.paragraphs[0], "Saved draft text");
  await assert.rejects(client.getArticle(draftId), { code: "not_found" });
  await runtime.pool.query("DELETE FROM wb_articles WHERE account_id=$1 AND id=$2", [owner.account.id, draftId]);
  // Concurrent reads share a single renewal; successive cycles retain one binding.
  for (let cycle = 0; cycle < 3; cycle++) {
    const current = client.getBinding();
    const key = [...storage.keys()].find((key) => key.startsWith("zhiyue.binding."));
    storage.set(key, JSON.stringify({ ...current, expiresAt: Date.now() - 1000 }));
    const before = refreshCalls;
    await Promise.all([client.listArticles(0), client.listArticles(0)]);
    assert.equal(refreshCalls, before + 1);
    assert.equal(client.getBinding().bindingId, confirmed.bindingId);
  }
  ok(await owner.request("/v1/auth/logout", "POST"), 204);
  await client.ensureBinding(true);
  assert.equal((await client.listArticles(0)).total, 0);
  await runtime.pool.query("UPDATE ac_accounts SET password_hash=password_hash || '-changed' WHERE id=$1", [owner.account.id]);
  await assert.rejects(client.listArticles(0), (error) => error.code === "auth_required");
  assert.equal(client.getBinding(), null);
});
