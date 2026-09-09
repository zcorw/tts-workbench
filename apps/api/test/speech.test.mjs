import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApplication } from "../dist/app.js";
import { migrate } from "../dist/migrate.js";
const url = process.env.TEST_DATABASE_URL;
test(
  "Real HTTP + PostgreSQL + Gateway Japanese pipeline (provider transport fixture only)",
  { skip: !url },
  async () => {
    await migrate(url);
    const nativeFetch = globalThis.fetch;
    let payload = "",
      onProvider;
    globalThis.fetch = async (target, options) => {
      if (
        String(target).startsWith("https://japaneast.tts.speech.microsoft.com/")
      ) {
        payload = String(options.body);
        if (onProvider) {
          const callback = onProvider;
          onProvider = undefined;
          await callback();
        }
        return new Response(new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]), {
          headers: { "Content-Type": "audio/mpeg" },
        });
      }
      return nativeFetch(target, options);
    };
    const origin = "http://127.0.0.1:4181";
    let runtime;
    try {
      runtime = await createApplication({
        DATABASE_URL: url,
        SESSION_SECRET: "test-only-secret-at-least-32-characters",
        PUBLIC_ORIGIN: origin,
        NODE_ENV: "test",
        REGISTRATION_ENABLED: true,
        TRUST_PROXY: "loopback",
        TTS_AZURE_SPEECH_KEY: "test-only",
        TTS_AZURE_JA_VOICE_ID: "test-ja-voice",
        TTS_PRODUCTION_APPROVED: false,
      });
      await runtime.app.listen(0, "127.0.0.1");
      const base = await runtime.app.getUrl();
      let cookie = "",
        csrf = "";
      async function call(path, method = "GET", body) {
        const r = await nativeFetch(base + path, {
          method,
          headers: {
            cookie,
            ...(method === "GET"
              ? {}
              : {
                  Origin: origin,
                  "Content-Type": "application/json",
                  "X-CSRF-Token": csrf,
                }),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const cookies = r.headers.getSetCookie();
        if (cookies.length)
          cookie = cookies.map((c) => c.split(";")[0]).join("; ");
        return r;
      }
      csrf = (await (await call("/v1/auth/csrf")).json()).csrfToken;
      const login = `speech-${randomUUID()}`,
        password = "Correct-password-42";
      const account = await (
        await call("/v1/auth/register", "POST", {
          login,
          password,
          displayName: "音声テスト",
        })
      ).json();
      await call("/v1/auth/login", "POST", { login, password });
      csrf = (await (await call("/v1/auth/csrf")).json()).csrfToken;
      const saved = await (
        await call("/v1/vocabulary", "POST", {
          text: "日本",
          reading: "にほん",
        })
      ).json();
      assert.equal(saved.internalVersion, 1);
      onProvider = () =>
        runtime.state.vocabulary.update(account.id, saved.entry.id, {
          text: "日本",
          reading: "にっぽん",
          expectedRevision: 1,
        });
      const speech = await call("/v1/audio/speech", "POST", {
        input: "日本と日本",
        voice: "ja-jp-primary",
      });
      assert.equal(speech.status, 200, await speech.clone().text());
      assert.equal(speech.headers.get("X-Pronunciation-Version"), "1");
      assert.equal(
        (await speech.arrayBuffer()).byteLength,
        Number(speech.headers.get("Content-Length")),
      );
      assert.match(payload, /xml:lang="ja-JP"/);
      assert.equal((payload.match(/alias="にほん"/g) ?? []).length, 2);
      const next = await call("/v1/audio/speech", "POST", {
        input: "日本",
        voice: "ja-jp-primary",
      });
      assert.equal(next.headers.get("X-Pronunciation-Version"), "2");
      await next.arrayBuffer();
      assert.match(payload, /alias="にっぽん"/);
      const preview = await call("/v1/audio/preview", "POST", {
        text: "日本",
        reading: "ニホン",
        voice: "ja-jp-primary",
      });
      assert.equal(preview.status, 200);
      await preview.arrayBuffer();
      assert.match(payload, /alias="ニホン"/);
      assert.equal(
        (await runtime.state.vocabulary.list(account.id, { limit: 500 }))
          .internalVersion,
        2,
      );
      assert.equal(
        (
          await call("/v1/audio/speech", "POST", {
            input: "日本",
            voice: "ja-jp-primary",
            dictionaryIds: ["other"],
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await call("/v1/audio/speech", "POST", {
            input: "   ",
            voice: "ja-jp-primary",
          })
        ).status,
        400,
      );
      await call(
        `/v1/vocabulary/${saved.entry.id}?expectedRevision=2`,
        "DELETE",
      );
      const after = await call("/v1/audio/speech", "POST", {
        input: "日本",
        voice: "ja-jp-primary",
      });
      assert.equal(after.headers.get("X-Pronunciation-Version"), "3");
      await after.arrayBuffer();
      assert.doesNotMatch(payload, /<sub/);
      await runtime.pool.query("DELETE FROM ac_accounts WHERE id=$1", [
        account.id,
      ]);
    } finally {
      globalThis.fetch = nativeFetch;
      await runtime?.close();
    }
  },
);
