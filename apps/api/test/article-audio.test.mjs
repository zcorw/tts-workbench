import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createApplication } from "../dist/app.js";
import { readConfig } from "../dist/config.js";
import { migrate } from "../dist/migrate.js";
const url = process.env.TEST_DATABASE_URL;
const tone = await readFile(new URL("../../web/qa/tone.mp3", import.meta.url));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
test(
  "Article audio: real PG/Gateway transport races, cancellation, HTTP contract and restart",
  { skip: !url },
  async () => {
    await migrate(url);
    await migrate(url);
    const nativeFetch = globalThis.fetch;
    const pending = [];
    let nextHook;
    globalThis.fetch = async (target, options) => {
      if (
        String(target).startsWith("https://japaneast.tts.speech.microsoft.com/")
      ) {
        const hook = nextHook;
        nextHook = undefined;
        if (hook) return hook(options);
        return new Response(tone, {
          headers: { "Content-Type": "audio/mpeg" },
        });
      }
      throw new Error("Unexpected external request in fixture");
    };
    const config = readConfig({
      DATABASE_URL: url,
      SESSION_SECRET: "article-audio-test-only-secret-long-enough",
      PUBLIC_ORIGIN: "http://127.0.0.1:4181",
      NODE_ENV: "test",
      REGISTRATION_ENABLED: "true",
      TTS_AZURE_SPEECH_KEY: "fixture-only",
      TTS_AZURE_JA_VOICE_ID: "fixture-ja-voice",
    });
    let runtime = await createApplication(config),
      base;
    const owners = [];
    const start = async () => {
      await runtime.app.listen(0, "127.0.0.1");
      base = await runtime.app.getUrl();
    };
    async function browser() {
      let cookie = "",
        csrf = "";
      const call = async (path, method = "GET", body, validCsrf = true) => {
        const r = await nativeFetch(base + path, {
          method,
          headers: {
            cookie,
            ...(method === "GET"
              ? {}
              : {
                  Origin: config.PUBLIC_ORIGIN,
                  "Content-Type": "application/json",
                  "X-CSRF-Token": validCsrf ? csrf : "wrong",
                }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (r.headers.getSetCookie().length)
          cookie = r.headers
            .getSetCookie()
            .map((x) => x.split(";")[0])
            .join("; ");
        const data =
          r.status === 204
            ? null
            : r.headers.get("content-type")?.startsWith("audio/")
              ? Buffer.from(await r.arrayBuffer())
              : await r.json();
        if (data?.csrfToken) csrf = data.csrfToken;
        return { status: r.status, data, headers: r.headers };
      };
      await call("/v1/auth/csrf");
      const login = "audio-" + randomUUID(),
        password = "Eight123";
      const account = await call("/v1/auth/register", "POST", {
        login,
        password,
        displayName: "Audio fixture",
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
    try {
      await start();
      const a = await browser(),
        b = await browser();
      const service = () => runtime.state.articles;
      const article = await service().create(a.owner, {
        title: "音声",
        text: "日本か\u3099\n😀",
      });
      const id = article.id,
        path = "/v1/articles/" + id;
      const dto = { expectedRevision: 1, voice: "ja-jp-primary", speed: 1.15 };
      const generate = async (signal = new AbortController().signal) => {
        await new Promise((r) => setTimeout(r, 350));
        return service().generate(
          a.owner,
          id,
          dto,
          runtime.state.speech,
          signal,
          randomUUID(),
        );
      };
      const initial = await generate();
      assert.equal(initial.audioStale, false);
      assert.equal(initial.audio.byteLength, tone.length);
      assert.equal(initial.audio.speed, 1.15);
      assert.equal(initial.audio.characterCount, 6);
      const read = () =>
        a.call(path + "/audio?audioId=" + initial.audio.audioId);
      const bytes = await read();
      assert.equal(bytes.status, 200);
      assert.deepEqual(bytes.data, tone);
      assert.equal(bytes.headers.get("x-audio-id"), initial.audio.audioId);
      assert.equal(bytes.headers.get("x-article-content-revision"), "1");
      assert.equal(bytes.headers.get("x-pronunciation-version"), "0");
      assert.equal(bytes.headers.get("cache-control"), "no-store");
      assert.equal(
        (await b.call(path + "/audio?audioId=" + initial.audio.audioId)).status,
        404,
      );
      assert.equal((await a.call(path + "/audio")).status, 400);
      assert.equal(
        (await a.call(path + "/audio", "POST", dto, false)).status,
        403,
      );
      const hold = () => {
        const entered = deferred(),
          release = deferred();
        nextHook = async () => {
          entered.resolve();
          return release.promise;
        };
        return {
          entered: entered.promise,
          release: () =>
            release.resolve(
              new Response(tone, { headers: { "Content-Type": "audio/mpeg" } }),
            ),
        };
      };
      let h = hold(),
        old = generate();
      pending.push(old.catch(() => {}));
      await h.entered;
      const newer = await generate();
      h.release();
      await assert.rejects(old, (e) => e.code === "AUDIO_SUPERSEDED");
      assert.equal(
        (await service().get(a.owner, id)).audio.audioId,
        newer.audio.audioId,
      );
      assert.equal((await read()).status, 404);
      h = hold();
      old = generate();
      pending.push(old.catch(() => {}));
      await h.entered;
      nextHook = async () =>
        new Response(new Uint8Array(8388609), {
          headers: { "Content-Type": "audio/mpeg" },
        });
      await assert.rejects(generate());
      assert.equal(
        (await service().get(a.owner, id)).audio.audioId,
        newer.audio.audioId,
      );
      h.release();
      const laterOld = await old;
      assert.notEqual(laterOld.audio.audioId, newer.audio.audioId);
      h = hold();
      old = generate();
      pending.push(old.catch(() => {}));
      await h.entered;
      await service().update(a.owner, id, {
        title: "改題",
        text: article.text,
        expectedRevision: 1,
      });
      dto.expectedRevision = 2;
      h.release();
      assert.equal((await old).audioStale, false);
      h = hold();
      old = generate();
      pending.push(old.catch(() => {}));
      await h.entered;
      const rule = await runtime.state.vocabulary.create(a.owner, {
        text: "日本",
        reading: "にほん",
      });
      h.release();
      assert.equal((await old).audioStale, true);
      const fresh = await generate();
      assert.equal(fresh.audio.ruleVersion, rule.internalVersion);
      assert.equal(fresh.audioStale, false);
      h = hold();
      old = generate();
      pending.push(old.catch(() => {}));
      await h.entered;
      await service().update(a.owner, id, {
        title: "改題",
        text: "changed",
        expectedRevision: 2,
      });
      await service().update(a.owner, id, {
        title: "改題",
        text: article.text,
        expectedRevision: 3,
      });
      dto.expectedRevision = 4;
      h.release();
      await assert.rejects(old, (e) => e.code === "ARTICLE_CONTENT_CHANGED");
      assert.equal(
        (await service().get(a.owner, id)).audio.audioId,
        fresh.audio.audioId,
      );
      assert.equal((await service().get(a.owner, id)).audioStale, true);
      const beforeCancel = await generate();
      h = hold();
      const abort = new AbortController();
      old = generate(abort.signal);
      pending.push(old.catch(() => {}));
      await h.entered;
      const lock = await runtime.pool.connect();
      await lock.query("BEGIN");
      await lock.query("SELECT id FROM ac_accounts WHERE id=$1 FOR UPDATE", [
        a.owner,
      ]);
      h.release();
      try {
        for (let i = 0; i < 100; i++) {
          const waiting = await runtime.pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT status FROM ac_accounts%'",
          );
          if (waiting.rowCount) break;
          if (i === 99)
            throw new Error("completion never waited for account lock");
          await new Promise((r) => setTimeout(r, 10));
        }
        abort.abort();
        await lock.query("COMMIT");
        await assert.rejects(old, (e) => e.code === "INVALID_REQUEST");
      } finally {
        await lock.query("ROLLBACK");
        lock.release();
      }
      assert.equal(
        (await service().get(a.owner, id)).audio.audioId,
        beforeCancel.audio.audioId,
      );
      // Every POST uses one shared pool; persisted GETs do not spend it.
      for (let i = 0; i < 12; i++)
        assert.equal(
          (await a.call(path + "/audio?audioId=" + beforeCancel.audio.audioId))
            .status,
          200,
        );
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 350));
        const route =
          i % 3 === 0
            ? path + "/AuDiO/"
            : i % 3 === 1
              ? "/v1/Audio/Speech/"
              : "/v1/audio/preview/";
        const body =
          i % 3 === 0
            ? dto
            : i % 3 === 1
              ? { input: "日本", voice: dto.voice }
              : { text: "日本", reading: "にほん", voice: dto.voice };
        assert.equal((await a.call(route, "POST", body)).status, 200);
      }
      for (const route of [
        "/v1/audio/preview",
        "/v1/Audio/Speech/",
        path + "/AuDiO/",
      ])
        assert.equal((await a.call(route, "POST", dto)).status, 429);
      assert.equal(
        (
          await a.call(
            path +
              "/audio?audioId=" +
              (await service().get(a.owner, id)).audio.audioId,
          )
        ).status,
        200,
      );
      for (const origin of [undefined, "http://wrong.invalid"]) {
        const response = await nativeFetch(
          base + "/V1/ARTICLES/" + id + "/AUDIO",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(origin ? { Origin: origin } : {}),
            },
            body: JSON.stringify(dto),
          },
        );
        assert.equal(response.status, 403);
        assert.equal((await response.json()).code, "FORBIDDEN");
      }
      const persisted = await service().get(a.owner, id);
      await runtime.close();
      runtime = await createApplication(config);
      await start();
      const restored = await a.call(
        path + "/audio?audioId=" + persisted.audio.audioId,
      );
      assert.equal(restored.status, 200);
      assert.deepEqual(restored.data, tone);
      assert.equal(
        (await service().get(a.owner, id)).audio.audioId,
        persisted.audio.audioId,
      );
      h = hold();
      old = generate();
      pending.push(old.catch(() => {}));
      await h.entered;
      await service().remove(a.owner, id, 4);
      h.release();
      await assert.rejects(old, (e) => e.code === "NOT_FOUND");
      assert.equal(
        (
          await runtime.pool.query(
            "SELECT 1 FROM wb_article_audio WHERE article_id=$1",
            [id],
          )
        ).rowCount,
        0,
      );
    } finally {
      globalThis.fetch = nativeFetch;
      await runtime.pool.query(
        "DELETE FROM ac_accounts WHERE id=ANY($1::uuid[])",
        [owners],
      );
      await runtime.close();
    }
  },
);
