import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApplication } from "../dist/app.js";
import { readConfig } from "../dist/config.js";
import { migrate } from "../dist/migrate.js";
import { byteRange } from "../dist/zhiyue-http.js";

const db = process.env.ZHIYUE_TEST_DATABASE_URL;
const origin = "https://zhiyue-cms.test";
const route = "/v1/zhiyue";
const digest = (value) => createHash("sha256").update(value).digest("hex");

test("音频票只接受有效的单段字节范围", () => {
  assert.deepEqual(byteRange("bytes=2-5", 10), { start: 2, end: 5 });
  assert.deepEqual(byteRange("bytes=6-", 10), { start: 6, end: 9 });
  assert.deepEqual(byteRange("bytes=-50", 10), { start: 0, end: 9 });
  for (const invalid of ["bytes=10-", "bytes=3-2", "bytes=-0", "bytes=1-2,4-5", "bytes=9007199254740992-"])
    assert.equal(byteRange(invalid, 10), null);
});

test("手机授权、单次领取、两账户隔离及音频撤销", { skip: !db }, async (t) => {
  const database = new URL(db);
  assert.equal(database.pathname, "/zhiyue_integration_test");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(database.hostname));
  await migrate(db);
  const cmsDist = await mkdtemp(join(tmpdir(), "zhiyue-cms-"));
  const index = join(cmsDist, "index.html");
  await writeFile(index, "<!doctype html><title>知阅配对测试</title>");
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
  const a = await browser("测试账户甲"), b = await browser("测试账户乙");
  const tone = await readFile(new URL("../../web/qa/tone.mp3", import.meta.url));
  async function article(owner, title, publish, audio = false) {
    const text = "本文为虚构的中文与日文テスト。";
    const created = ok(await owner.request("/v1/cms/articles", "POST", {
      title, text, cms: { slug: `fixture-${randomUUID()}`, summary: "", categoryId: null, tagIds: [] },
    }), 201);
    if (!publish) return created;
    const detail = ok(await owner.request(`/v1/cms/articles/${created.id}`));
    let audioId = null;
    if (audio) {
      audioId = randomUUID();
      const metadata = {
        audioId, contentRevision: detail.contentRevision, ruleVersion: detail.currentRuleVersion,
        voice: "synthetic-fixture", speed: 1, language: "ja-JP", format: "mp3", mimeType: "audio/mpeg",
        byteLength: tone.length, characterCount: [...text].length, filename: `article-${created.id}.mp3`,
        createdAt: new Date().toISOString(),
      };
      await runtime.pool.query(`WITH seq AS (
        UPDATE wb_articles SET generation_seq=generation_seq+1 WHERE account_id=$1 AND id=$2 RETURNING id,generation_seq
      ) INSERT INTO wb_article_audio(article_id,generation_seq,metadata,data)
        SELECT id,generation_seq,$3,$4 FROM seq`, [owner.account.id, created.id, metadata, tone]);
    }
    return ok(await owner.request(`/v1/cms/articles/${created.id}/releases`, "POST", {
      expectedRevision: detail.revision, expectedCmsRevision: detail.cms.revision, expectedAudioId: audioId,
    }), 201);
  }
  const articleA = await article(a, "甲的发布", true, true);
  const articleB = await article(b, "乙的发布", true);
  await article(a, "甲的草稿", false);
  const start = async () => ok(await call(`${route}/device/authorize`, { method: "POST", body: {} }), 201);
  const token = (device_code) => call(`${route}/device/token`, { method: "POST", body: { device_code } });
  const approve = (owner, pending, expected = owner.account.id, headers = {}) => owner.request(
    `${route}/account/approve`, "POST", { user_code: pending.user_code, expected_account_id: expected }, headers,
  );
  const pending = await start();
  assert.equal(pending.verification_uri, `${origin}/connections/zhiyue`);
  assert.equal((await token(pending.device_code)).data.error, "authorization_pending");
  assert.equal((await token(pending.device_code)).data.error, "slow_down");
  assert.equal((await approve(a, pending, b.account.id)).response.status, 409);
  assert.equal((await approve(a, pending, a.account.id, { "X-CSRF-Token": "" })).response.status, 403);
  ok(await approve(a, pending), 204);
  assert.equal((await approve(b, pending)).response.status, 400);
  await runtime.pool.query("UPDATE wb_zhiyue_device_requests SET next_poll_at=now() WHERE device_hash=$1", [digest(pending.device_code)]);
  const redeemed = await Promise.all([token(pending.device_code), token(pending.device_code)]);
  assert.deepEqual(redeemed.map((result) => result.response.status).sort(), [200, 400]);
  const grantA = redeemed.find((result) => result.response.ok).data;
  const pendingB = await start();
  ok(await approve(b, pendingB), 204);
  const grantB = ok(await token(pendingB.device_code));
  const device = (grant, path, method = "GET", body) => call(path, {
    method, body, headers: { Authorization: `Bearer ${grant.access_token}` },
  });
  assert.equal(grantA.account.id, a.account.id);
  assert.equal(grantB.account.id, b.account.id);
  assert.deepEqual(ok(await device(grantA, `${route}/read/articles`)).items.map((item) => item.id), [articleA.articleId]);
  assert.deepEqual(ok(await device(grantB, `${route}/read/articles`)).items.map((item) => item.id), [articleB.articleId]);
  assert.equal(ok(await device(grantA, `${route}/read/articles/${articleA.articleId}`)).text, articleA.text);
  assert.equal((await device(grantB, `${route}/read/articles/${articleA.articleId}`)).response.status, 404);
  assert.equal((await device(grantB, `${route}/read/releases/${articleA.id}/audio-ticket`, "POST", {})).response.status, 404);
  assert.equal((await device(grantA, "/v1/cms/articles")).response.status, 403);
  const ticket = ok(await device(grantA, `${route}/read/releases/${articleA.id}/audio-ticket`, "POST", {}));
  const mediaPath = new URL(ticket.url).pathname;
  const audio = await call(mediaPath, { headers: { Range: "bytes=0-15" } });
  assert.equal(audio.response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(ok(audio, 206), tone.subarray(0, 16));
  ok(await b.request(`${route}/account/bindings/${grantA.binding_id}?expected_account_id=${b.account.id}`, "DELETE"), 204);
  ok(await device(grantA, `${route}/read/articles`));
  ok(await a.request(`${route}/account/bindings/${grantA.binding_id}?expected_account_id=${a.account.id}`, "DELETE"), 204);
  assert.equal((await device(grantA, `${route}/read/articles`)).response.status, 401);
  assert.equal((await call(mediaPath)).response.status, 401);
  ok(await device(grantB, `${route}/read/articles`));
});
