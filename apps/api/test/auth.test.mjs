import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApplication } from "../dist/app.js";
import { migrateAccounts } from "@tts-workbench/account-postgres";
const url = process.env.TEST_DATABASE_URL;
test(
  "Real HTTP cookie, CSRF, auth, settings and logout",
  { skip: !url },
  async () => {
    await migrateAccounts(url);
    const origin = "http://127.0.0.1:4181";
    const runtime = await createApplication({
      DATABASE_URL: url,
      SESSION_SECRET: "test-only-secret-at-least-32-characters",
      PUBLIC_ORIGIN: origin,
      NODE_ENV: "test",
      REGISTRATION_ENABLED: true,
      TRUST_PROXY: "loopback",
    });
    await runtime.app.listen(0, "127.0.0.1");
    const base = await runtime.app.getUrl();
    let cookie = "",
      csrf = "";
    async function request(path, method = "GET", body, withCsrf = true) {
      const r = await fetch(base + path, {
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
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const set = r.headers.getSetCookie();
      if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
      return r;
    }
    const login = `http-${randomUUID()}`,
      password = "Eight123";
    try {
      assert.equal((await request("/v1/auth/me")).status, 401);
      csrf = (await (await request("/v1/auth/csrf")).json()).csrfToken;
      assert.ok(cookie.startsWith("wb_session="));
      assert.equal(
        (
          await request(
            "/v1/auth/register",
            "POST",
            { login, password, displayName: "テスト" },
            false,
          )
        ).status,
        403,
      );
      runtime.state.config.REGISTRATION_ENABLED = false;
      assert.equal(
        (
          await request("/v1/auth/register", "POST", {
            login,
            password,
            displayName: "テスト",
          })
        ).status,
        403,
      );
      runtime.state.config.REGISTRATION_ENABLED = true;
      for (const length of [7, 129]) {
        assert.equal(
          (await request('/v1/auth/register', 'POST', {
            login, password: 'p'.repeat(length), displayName: 'テスト',
          })).status,
          400,
        );
      }
      assert.equal(
        (
          await request("/v1/audio/speech", "POST", {
            input: "日本",
            voice: "missing",
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await request("/v1/auth/register", "POST", {
            login,
            password,
            displayName: "テスト",
          })
        ).status,
        201,
      );
      assert.equal((await request("/v1/auth/me")).status, 401);
      const prelogin = cookie;
      assert.equal(
        (await request("/v1/auth/login", "POST", { login, password })).status,
        200,
      );
      assert.notEqual(cookie, prelogin);
      assert.equal(
        (await request("/v1/auth/me", "PATCH", { displayName: "更新" })).status,
        403,
      );
      csrf = (await (await request("/v1/auth/csrf")).json()).csrfToken;
      assert.equal(
        (await request("/v1/auth/me", "PATCH", { displayName: "更新" })).status,
        200,
      );
      assert.equal(
        (await (await request("/v1/auth/me")).json()).displayName,
        "更新",
      );
      assert.deepEqual(await (await request("/v1/voices")).json(), {
        items: [],
      });
      assert.equal(
        (
          await request("/v1/audio/speech", "POST", {
            input: "日本語",
            voice: "missing",
          })
        ).status,
        503,
      );
      assert.equal(
        (
          await fetch(base + "/v1/auth/me", {
            method: "PATCH",
            headers: {
              cookie,
              Origin: "https://untrusted.invalid",
              "Content-Type": "application/json",
              "X-CSRF-Token": csrf,
            },
            body: JSON.stringify({ displayName: "bad" }),
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await request("/v1/audio/speech", "POST", {
            input: "x".repeat(70000),
            voice: "missing",
          })
        ).status,
        413,
      );
      const revoked = cookie;
      assert.equal((await request("/v1/auth/logout", "POST")).status, 204);
      assert.equal((await request("/v1/auth/me")).status, 401);
      cookie = revoked;
      assert.equal((await request("/v1/auth/me")).status, 401);
      csrf = (await (await request("/v1/auth/csrf")).json()).csrfToken;
      await request("/v1/auth/login", "POST", { login, password });
      await runtime.pool.query(
        "UPDATE ac_accounts SET status='disabled' WHERE login=$1",
        [login],
      );
      assert.equal((await request("/v1/auth/me")).status, 401);
      assert.equal((await request("/v1/auth/csrf")).status, 200);
    } finally {
      await runtime.pool.query("DELETE FROM ac_accounts WHERE login=$1", [
        login,
      ]);
      await runtime.close();
    }
  },
);
