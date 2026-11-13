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

test("Pairing confirmation, renewal, isolation and revocation", { skip: !db }, async (t) => {
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
  const confirm = (grant) => call(`${route}/device/confirm`, { method: "POST", body: { refresh_token: grant.refresh_token } });
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
  assert.equal(grantA.confirmation_required, true);
  assert.equal((await device(grantA, `${route}/read/articles`)).response.status, 401);
  assert.equal((await call(`${route}/device/refresh`, { method: "POST", body: { refresh_token: grantA.refresh_token } })).response.status, 400);
  assert.equal((await device(grantA, `${route}/read/releases/${articleA.id}/audio-ticket`, "POST", {})).response.status, 401);
  const deadline = (await runtime.pool.query("SELECT confirm_by FROM wb_zhiyue_bindings WHERE id=$1", [grantA.binding_id])).rows[0].confirm_by;
  // Model a lost claim response. Retry returns the same credential and fixed deadline.
  await runtime.pool.query("UPDATE wb_zhiyue_device_requests SET next_poll_at=now() WHERE device_hash=$1", [digest(pending.device_code)]);
  const replay = ok(await token(pending.device_code));
  assert.equal(replay.binding_id, grantA.binding_id);
  assert.equal(replay.access_token, grantA.access_token);
  assert.equal(replay.refresh_token, grantA.refresh_token);
  assert.equal((await runtime.pool.query("SELECT confirm_by FROM wb_zhiyue_bindings WHERE id=$1", [grantA.binding_id])).rows[0].confirm_by.toISOString(), deadline.toISOString());
  assert.notEqual(grantA.refresh_token, createHash("sha256").update("zhiyue-claim-refresh-v1:"+pending.device_code).digest("base64url"));
  assert.ok((await runtime.pool.query("SELECT claim_nonce FROM wb_zhiyue_device_requests WHERE binding_id=$1", [grantA.binding_id])).rows[0].claim_nonce);
  const confirmationRace = await Promise.all([confirm(grantA), confirm(grantA)]);
  confirmationRace.forEach((result) => ok(result, 204));
  ok(await confirm(grantA), 204); // A lost confirmation response is safely retried.
  assert.equal((await runtime.pool.query("SELECT claim_nonce FROM wb_zhiyue_device_requests WHERE binding_id=$1", [grantA.binding_id])).rows[0].claim_nonce, null);
  await runtime.pool.query("UPDATE wb_zhiyue_device_requests SET next_poll_at=now() WHERE device_hash=$1", [digest(pending.device_code)]);
  assert.equal((await token(pending.device_code)).response.status, 400);
  ok(await confirm(grantB), 204);
  assert.equal(grantA.account.id, a.account.id);
  assert.equal(grantB.account.id, b.account.id);
  assert.deepEqual(ok(await device(grantA, `${route}/read/articles`)).items.map((item) => item.id), [articleA.articleId]);
  assert.deepEqual(ok(await device(grantB, `${route}/read/articles`)).items.map((item) => item.id), [articleB.articleId]);
  assert.equal(ok(await device(grantA, `${route}/read/articles/${articleA.articleId}`)).text, articleA.text);
  assert.equal((await device(grantB, `${route}/read/articles/${articleA.articleId}`)).response.status, 404);
  assert.equal((await device(grantB, `${route}/read/releases/${articleA.id}/audio-ticket`, "POST", {})).response.status, 404);
  assert.equal((await device(grantA, "/v1/cms/articles")).response.status, 403);
  const refresh = (grant) => call(`${route}/device/refresh`, { method: "POST", body: { refresh_token: grant.refresh_token } });
  assert.match(grantA.refresh_token, /^[A-Za-z0-9_-]{43}$/);
  // A long-idle renewable binding survives access expiration and pairing cleanup.
  await runtime.pool.query("UPDATE wb_zhiyue_bindings SET created_at=now()-interval '400 days',expires_at=now()-interval '300 days' WHERE id=$1", [grantA.binding_id]);
  await start();
  Object.assign(grantA, ok(await refresh(grantA)));
  for (let i = 0; i < 3; i++) Object.assign(grantA, ok(await refresh(grantA)));
  ok(await device(grantA, `${route}/read/articles`));
  const racing = await Promise.all([refresh(grantA), refresh(grantA)]);
  racing.forEach((result) => ok(result));
  Object.assign(grantA, ok(await refresh(grantA)));
  ok(await device(grantA, `${route}/read/articles`));
  assert.equal((await device(grantA, `${route}/device/upgrade`, "POST", {})).response.status, 400);
  const old = await start();
  ok(await approve(a, old), 204);
  const expired = ok(await token(old.device_code));
  await runtime.pool.query("UPDATE wb_zhiyue_bindings SET refresh_hash=NULL,created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1", [expired.binding_id]);
  assert.equal((await device(expired, `${route}/device/upgrade`, "POST", {})).response.status, 400);
  // Simulate a legacy binding, and verify lost upgrade responses are retryable.
  await runtime.pool.query("UPDATE wb_zhiyue_bindings SET refresh_hash=NULL WHERE id=$1", [grantB.binding_id]);
  const upgraded = ok(await device(grantB, `${route}/device/upgrade`, "POST", {}));
  const upgradeDeadline = (await runtime.pool.query("SELECT upgrade_until FROM wb_zhiyue_bindings WHERE id=$1", [grantB.binding_id])).rows[0].upgrade_until;
  await runtime.pool.query("UPDATE wb_zhiyue_bindings SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1", [grantB.binding_id]);
  const recoveredUpgrade = ok(await device(grantB, `${route}/device/upgrade`, "POST", {}));
  assert.equal(recoveredUpgrade.refresh_token, upgraded.refresh_token);
  assert.equal(recoveredUpgrade.binding_id, grantB.binding_id);
  assert.equal((await runtime.pool.query("SELECT upgrade_until FROM wb_zhiyue_bindings WHERE id=$1", [grantB.binding_id])).rows[0].upgrade_until.toISOString(), upgradeDeadline.toISOString());
  const legacyBearer = { ...grantB };
  Object.assign(upgraded, recoveredUpgrade);
  Object.assign(grantB, upgraded);
  ok(await b.request("/v1/auth/logout", "POST"), 204);
  Object.assign(grantB, ok(await refresh(grantB)));
  assert.equal((await device(legacyBearer, `${route}/device/upgrade`, "POST", {})).response.status, 400);
  assert.equal((await runtime.pool.query("SELECT upgrade_nonce FROM wb_zhiyue_bindings WHERE id=$1", [grantB.binding_id])).rows[0].upgrade_nonce, null);
  const approvedBeforePasswordChange = await start();
  // b is logged out, so use a separate pending approval before logging out in future tests.
  await runtime.pool.query("UPDATE wb_zhiyue_device_requests SET account_id=$2 WHERE device_hash=$1", [digest(approvedBeforePasswordChange.device_code), b.account.id]);
  await runtime.pool.query("UPDATE ac_accounts SET password_hash=password_hash || '-changed' WHERE id=$1", [b.account.id]);
  assert.equal((await token(approvedBeforePasswordChange.device_code)).response.status, 400);
  assert.equal((await refresh(grantB)).response.status, 400);
  assert.equal((await device(grantB, `${route}/read/articles`)).response.status, 401);
  const fresh = async () => {
    const request = await start();
    ok(await approve(a, request), 204);
    return { request, grant: ok(await token(request.device_code)) };
  };
  const upgradeTimeout = await fresh();
  ok(await confirm(upgradeTimeout.grant), 204);
  await runtime.pool.query("UPDATE wb_zhiyue_bindings SET refresh_hash=NULL WHERE id=$1", [upgradeTimeout.grant.binding_id]);
  const upgradeSuccess = ok(await device(upgradeTimeout.grant, `${route}/device/upgrade`, "POST", {}));
  await runtime.pool.query("UPDATE wb_zhiyue_bindings SET upgrade_until=now()-interval '1 second' WHERE id=$1", [upgradeTimeout.grant.binding_id]);
  assert.equal((await device(upgradeTimeout.grant, `${route}/device/upgrade`, "POST", {})).response.status, 400);
  Object.assign(upgradeSuccess, ok(await refresh(upgradeSuccess))); // Confirmed binding has no five-minute expiry.
  ok(await device(upgradeSuccess, `${route}/device/binding`, "DELETE"), 204);
  const doomed = await fresh();
  await runtime.pool.query("UPDATE wb_zhiyue_bindings SET created_at=now()-interval '6 minutes',confirm_by=now()-interval '1 minute' WHERE id=$1", [doomed.grant.binding_id]);
  assert.equal((await confirm(doomed.grant)).response.status, 400);
  assert.equal((await runtime.pool.query("SELECT id FROM wb_zhiyue_bindings WHERE id=$1", [doomed.grant.binding_id])).rowCount, 0);
  await runtime.pool.query("UPDATE wb_zhiyue_device_requests SET next_poll_at=now() WHERE device_hash=$1", [digest(doomed.request.device_code)]);
  assert.equal((await token(doomed.request.device_code)).response.status, 400);
  const cancelled = await fresh();
  ok(await device(cancelled.grant, `${route}/device/binding`, "DELETE"), 204);
  assert.equal((await confirm(cancelled.grant)).response.status, 400);
  const competing = await fresh();
  const confirmVsRevoke = await Promise.all([
    confirm(competing.grant),
    a.request(`${route}/account/bindings/${competing.grant.binding_id}?expected_account_id=${a.account.id}`, "DELETE"),
  ]);
  assert.ok([204, 400].includes(confirmVsRevoke[0].response.status));
  ok(confirmVsRevoke[1], 204);
  assert.equal((await confirm(competing.grant)).response.status, 400);
  assert.equal((await device(competing.grant, `${route}/read/articles`)).response.status, 401);
  const orphan = await fresh();
  await runtime.pool.query("UPDATE wb_zhiyue_bindings SET created_at=now()-interval '6 minutes',confirm_by=now()-interval '1 minute' WHERE id=$1", [orphan.grant.binding_id]);
  // No device HTTP call: the server's background worker must physically delete it.
  const end = Date.now() + 6500;
  while (Date.now() < end && (await runtime.pool.query("SELECT id FROM wb_zhiyue_bindings WHERE id=$1", [orphan.grant.binding_id])).rowCount) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await runtime.pool.query("SELECT id FROM wb_zhiyue_bindings WHERE id=$1", [orphan.grant.binding_id])).rowCount, 0);
  const disabledPending = await start();
  ok(await approve(a, disabledPending), 204);
  const disabledGrant = ok(await token(disabledPending.device_code));
  await runtime.pool.query("UPDATE ac_accounts SET status='disabled' WHERE id=$1", [a.account.id]);
  assert.equal((await refresh(disabledGrant)).response.status, 400);
  await runtime.pool.query("UPDATE ac_accounts SET status='active' WHERE id=$1", [a.account.id]);
  assert.equal((await refresh(disabledGrant)).response.status, 400);
  // Re-pair the active account after testing account-wide revocation.
  const replacement = await start();
  ok(await approve(a, replacement), 204);
  Object.assign(grantA, ok(await token(replacement.device_code)));
  ok(await confirm(grantA), 204);
  const ticket = ok(await device(grantA, `${route}/read/releases/${articleA.id}/audio-ticket`, "POST", {}));
  const mediaPath = new URL(ticket.url).pathname;
  const audio = await call(mediaPath, { headers: { Range: "bytes=0-15" } });
  assert.equal(audio.response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(ok(audio, 206), tone.subarray(0, 16));

  ok(await device(grantA, `${route}/read/articles`));
  ok(await a.request(`${route}/account/bindings/${grantA.binding_id}?expected_account_id=${a.account.id}`, "DELETE"), 204);
  assert.equal((await device(grantA, `${route}/read/articles`)).response.status, 401);
  assert.equal((await call(mediaPath)).response.status, 401);
  assert.equal((await refresh(grantA)).response.status, 400);
});

test("Migration preserves existing devices and does not impose the confirmation deadline", { skip: !db }, async () => {
  const { Pool } = await import("pg");
  const { runner } = await import("node-pg-migrate");
  const { fileURLToPath } = await import("node:url");
  const { ZhiyueDeviceService } = await import("../dist/zhiyue-device.js");
  const database = new URL(db);
  assert.equal(database.pathname, "/zhiyue_integration_test");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(database.hostname));
  await migrate(db);
  const pool = new Pool({ connectionString: db });
  const accountId = randomUUID(), legacyId = randomUUID(), expiredId = randomUUID();
  const legacyToken = "L".repeat(43), expiredToken = "E".repeat(43);
  const options = { databaseUrl: db, dir: fileURLToPath(new URL("../migrations/", import.meta.url)), migrationsTable: "wb_migrations", log: () => {} };
  try {
    await runner({ ...options, direction: "down", count: 1 });
    await pool.query("INSERT INTO ac_accounts(id,login,display_name,password_hash,status) VALUES($1,$2,'Synthetic legacy','not-a-real-secret','active')", [accountId, `migration-${accountId}`]);
    await pool.query(`INSERT INTO wb_zhiyue_bindings(id,account_id,token_hash,created_at,expires_at)
      VALUES($1,$2,$3,now()-interval '12 hours',now()+interval '12 hours'),
            ($4,$2,$5,now()-interval '2 days',now()-interval '1 day')`,
      [legacyId, accountId, digest(legacyToken), expiredId, digest(expiredToken)]);
    await migrate(db);
    const existing = (await pool.query("SELECT confirmed_at,confirm_by FROM wb_zhiyue_bindings WHERE id=$1", [legacyId])).rows[0];
    assert.ok(existing.confirmed_at);
    assert.equal(existing.confirm_by, null);
    const devices = new ZhiyueDeviceService(pool);
    assert.equal((await devices.identify(legacyToken)).id, legacyId);
    const upgraded = await devices.renew(legacyToken, true);
    assert.equal(upgraded.binding_id, legacyId);
    assert.equal(upgraded.confirmation_required, false);
    await assert.rejects(devices.renew(expiredToken, true), { error: "invalid_grant" });
    await pool.query("UPDATE wb_zhiyue_bindings SET created_at=now()-interval '400 days',expires_at=now()-interval '300 days' WHERE id=$1", [legacyId]);
    await devices.confirm(upgraded.refresh_token); // No pending deadline for confirmed devices.
    assert.equal((await devices.renew(upgraded.refresh_token)).binding_id, legacyId);
  } finally {
    await pool.query("DELETE FROM ac_accounts WHERE id=$1", [accountId]);
    await pool.end();
  }
});
