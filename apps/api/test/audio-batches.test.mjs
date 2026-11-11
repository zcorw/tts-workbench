import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AudioBatchService } from "../dist/audio-batches.js";
import { GenerationAdmission } from "../dist/generation-admission.js";
import { createApplication } from "../dist/app.js";
import { readConfig } from "../dist/config.js";
import { migrate } from "../dist/migrate.js";

const valid = () => ({
  requestId: randomUUID(),
  existingAudio: "skip",
  items: [
    {
      articleId: randomUUID(),
      expectedRevision: 1,
      expectedAudioId: null,
      expectedRuleVersion: 0,
      voice: "ja-jp-primary",
      speed: 1,
    },
  ],
});
test("Audio batches reject malformed envelopes before any persistence or generation", async (t) => {
  const service = new AudioBatchService({}, {}, {}, {});
  const cases = [
    ["empty selection", { ...valid(), items: [] }],
    [
      "more than twenty",
      { ...valid(), items: Array.from({ length: 21 }, () => valid().items[0]) },
    ],
    [
      "duplicate article IDs",
      (() => {
        const value = valid();
        return { ...value, items: [value.items[0], value.items[0]] };
      })(),
    ],
    ["unknown properties", { ...valid(), publish: true }],
    [
      "noncanonical speed",
      (() => {
        const value = valid();
        value.items[0].speed = 1.111;
        return value;
      })(),
    ],
  ];
  for (const [name, input] of cases)
    await t.test(name, async () =>
      assert.rejects(service.create(randomUUID(), input), { name: "ZodError" }),
    );
});

const url = process.env.TEST_DATABASE_URL;
if (url && new URL(url).pathname !== "/cms_reading_test_20261027")
  throw new Error(
    "Audio-batch tests require the explicit disposable CMS test database",
  );
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function bounded(promise, label, ms = 5000, signal) {
  let timer, onAbort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Fixture timeout: " + label)),
          ms,
        );
        onAbort = () => reject(new Error("Fixture aborted: " + label));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

test(
  "Audio batches: real HTTP/PostgreSQL, shared budget, preserved snapshots, cancellation and restart",
  { skip: !url, timeout: 60000 },
  async (t) => {
    await migrate(url);
    const tone = await readFile(
      new URL("../../web/qa/tone.mp3", import.meta.url),
    );
    const nativeFetch = globalThis.fetch;
    let hook;
    let calls = 0;
    const barriers = [];
    const transportBarrier = () => {
      const finish = deferred(),
        entered = deferred();
      barriers.push(finish);
      const providerHook = async (options) => {
        entered.resolve();
        await bounded(
          finish.promise,
          "provider response gate",
          8000,
          options?.signal,
        );
        return new Response(tone);
      };
      hook = providerHook;
      return {
        finish,
        entered,
        release() {
          finish.resolve();
          if (hook === providerHook) hook = undefined;
        },
      };
    };
    globalThis.fetch = async (target, options) => {
      if (
        !String(target).startsWith(
          "https://japaneast.tts.speech.microsoft.com/",
        )
      )
        throw new Error("External transport disabled in audio-batch fixture");
      calls++;
      const current = hook;
      hook = undefined;
      // Respect the real Gateway's four-starts/second admission policy even
      // when the synthetic provider would otherwise answer immediately.
      await pause(300);
      if (current) return current(options);
      return new Response(tone, { headers: { "Content-Type": "audio/mpeg" } });
    };
    const config = readConfig({
      DATABASE_URL: url,
      SESSION_SECRET: "batch-audio-isolated-test-session-only-long-enough",
      PUBLIC_ORIGIN: "http://127.0.0.1:4181",
      NODE_ENV: "test",
      REGISTRATION_ENABLED: "true",
      TTS_AZURE_SPEECH_KEY: "fixture-only",
      TTS_AZURE_JA_VOICE_ID: "fixture-ja-voice",
    });
    let runtime = await createApplication(config, { batchPollMs: 5 });
    await runtime.app.listen(0, "127.0.0.1");
    let base = await runtime.app.getUrl();
    const owners = [];
    const clients = [];
    async function browser() {
      let cookie = "",
        csrf = "";
      const call = async (path, method = "GET", body, headers = {}) => {
        const response = await nativeFetch(base + path, {
          method,
          signal: AbortSignal.timeout(5000),
          headers: {
            cookie,
            ...(method === "GET"
              ? {}
              : {
                  Origin: config.PUBLIC_ORIGIN,
                  "Content-Type": "application/json",
                  "X-CSRF-Token": csrf,
                }),
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (response.headers.getSetCookie().length)
          cookie = response.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; ");
        const data = response.status === 204 ? null : await response.json();
        if (data?.csrfToken) csrf = data.csrfToken;
        return { status: response.status, data };
      };
      await call("/v1/auth/csrf");
      const login = "batch-" + randomUUID();
      const account = await call("/v1/auth/register", "POST", {
        login,
        password: "Eight123!",
        displayName: "Synthetic batch owner",
      });
      assert.equal(account.status, 201);
      owners.push(account.data.id);
      assert.equal(
        (await call("/v1/auth/login", "POST", { login, password: "Eight123!" }))
          .status,
        200,
      );
      await call("/v1/auth/csrf");
      const client = { owner: account.data.id, call };
      clients.push(client);
      return client;
    }
    const first = await browser(),
      other = await browser();
    const state = () => runtime.state;
    const competitor = new AudioBatchService(
      runtime.pool,
      state().articles,
      state().speech,
      state().generationAdmission,
      { pollMs: 5 },
    );
    competitor.start(); // A second worker must lose the shared PostgreSQL leader lock.
    const createArticle = (title) =>
      state().cms.create(first.owner, {
        title,
        text: "これは合成音声の検証記事です。",
        cms: {
          slug: "batch-" + randomUUID(),
          summary: "",
          categoryId: null,
          tagIds: [],
        },
      });
    const selection = (article) => ({
      articleId: article.id,
      expectedRevision: article.revision,
      expectedAudioId: article.audio?.audioId ?? null,
      expectedRuleVersion: article.currentRuleVersion,
      voice: "ja-jp-primary",
      speed: 1,
    });
    const submit = (items, existingAudio = "replace") =>
      first.call("/v1/cms/audio-batches", "POST", {
        requestId: randomUUID(),
        existingAudio,
        items,
      });
    async function until(id, condition) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const batch = await state().audioBatches.get(first.owner, id);
        if (condition(batch)) return batch;
        await pause(10);
      }
      throw new Error("Timed out waiting for real persisted batch state");
    }
    async function releaseBarrier(barrier, batchId) {
      try {
        if (batchId)
          await state().audioBatches.cancel(first.owner, batchId, {});
      } finally {
        barrier.release();
      }
      if (batchId)
        await until(batchId, (value) => value.status === "completed");
    }
    try {
      await t.test(
        "admission is shared, atomic under concurrent callers and survives a new service",
        async () => {
          const a = new GenerationAdmission(runtime.pool),
            b = new GenerationAdmission(runtime.pool);
          const slots = await Promise.all(
            Array.from({ length: 20 }, (_, i) =>
              (i % 2 ? a : b).acquire(other.owner),
            ),
          );
          assert.equal(slots.filter((value) => value.allowed).length, 10);
          assert.equal(
            (await new GenerationAdmission(runtime.pool).acquire(other.owner))
              .allowed,
            false,
          );
          await runtime.pool.query(
            "UPDATE wb_tts_admission SET window_started_at=clock_timestamp()-interval '61 seconds' WHERE account_id=$1",
            [other.owner],
          );
          assert.equal((await b.acquire(other.owner)).allowed, true);
          await Promise.all(
            Array.from({ length: 9 }, () => a.acquire(other.owner)),
          );
          assert.equal(
            (await other.call("/v1/audio/preview", "POST", {})).status,
            429,
          );
        },
      );
      await t.test(
        "create is idempotent, blocks duplicate batches, enforces owner and CSRF; cancel stops queued only",
        async () => {
          const articles = [
            await createArticle("待機記事一"),
            await createArticle("待機記事二"),
          ];
          const barrier = transportBarrier();
          let batchId;
          try {
            const input = {
              requestId: randomUUID(),
              existingAudio: "skip",
              items: articles.map(selection),
            };
            assert.equal(
              (
                await first.call("/v1/cms/audio-batches", "POST", input, {
                  "X-CSRF-Token": "invalid",
                })
              ).status,
              403,
            );
            assert.equal(
              (
                await first.call("/v1/cms/audio-batches", "POST", input, {
                  Authorization: "Bearer fixture-not-a-write-credential",
                })
              ).status,
              403,
            );
            const created = await first.call(
              "/v1/cms/audio-batches",
              "POST",
              input,
            );
            assert.equal(created.status, 202);
            batchId = created.data.id;
            assert.equal(created.status, 202);
            await until(
              created.data.id,
              (value) => value.items[0].status === "running",
            );
            await bounded(barrier.entered.promise, "provider entered");
            const repeated = await first.call(
              "/v1/cms/audio-batches",
              "POST",
              input,
            );
            assert.equal(repeated.data.id, created.data.id);
            assert.equal(
              (
                await first.call("/v1/cms/audio-batches", "POST", {
                  ...input,
                  existingAudio: "replace",
                })
              ).data.code,
              "AUDIO_BATCH_REQUEST_CONFLICT",
            );
            assert.equal(
              (await submit(input.items)).data.code,
              "AUDIO_BATCH_ACTIVE",
            );
            assert.equal(
              (await other.call("/v1/cms/audio-batches/" + created.data.id))
                .status,
              404,
            );
            assert.equal(
              (
                await first.call(
                  "/v1/cms/audio-batches/" + created.data.id + "/cancel",
                  "POST",
                  { extra: true },
                )
              ).status,
              400,
            );
            const cancelled = await first.call(
              "/v1/cms/audio-batches/" + created.data.id + "/cancel",
              "POST",
              {},
            );
            assert.equal(cancelled.status, 200);
            assert.equal(cancelled.data.items[0].status, "running");
            assert.equal(cancelled.data.items[1].status, "cancelled");
            barrier.finish.resolve();
            const completed = await until(
              created.data.id,
              (value) => value.status === "completed",
            );
            assert.deepEqual(
              completed.items.map((value) => value.status),
              ["succeeded", "cancelled"],
            );
            assert.equal(
              (await state().articles.get(first.owner, articles[1].id)).audio,
              null,
            );
            const saved = await state().articles.get(
              first.owner,
              articles[0].id,
            );
            const before = calls;
            const skipped = await submit([selection(saved)], "skip");
            assert.equal(skipped.data.status, "completed");
            assert.equal(skipped.data.items[0].status, "skipped");
            assert.equal(calls, before);
          } finally {
            await releaseBarrier(barrier, batchId);
          }
        },
      );
      await t.test(
        "failure keeps prior audio and only explicit retry creates another provider call",
        async () => {
          const article = await createArticle("再試行記事");
          const dto = selection(article);
          hook = async () =>
            new Response("synthetic provider failure", { status: 400 });
          const created = await submit([dto]);
          const failed = await until(
            created.data.id,
            (value) => value.status === "completed",
          );
          assert.equal(failed.items[0].status, "failed");
          assert.equal(
            (await state().articles.get(first.owner, article.id)).audio,
            null,
          );
          const previousCalls = calls;
          await pause(30);
          assert.equal(calls, previousCalls);
          const retry = await submit([
            selection(await state().articles.get(first.owner, article.id)),
          ]);
          assert.equal(
            (
              await until(
                retry.data.id,
                (value) => value.status === "completed",
              )
            ).items[0].status,
            "succeeded",
          );
          assert.equal(calls, previousCalls + 1);
        },
      );
      await t.test(
        "concurrent new audio cannot be overwritten and published media stays immutable",
        async () => {
          let article = await createArticle("音声競合記事");
          await state().articles.generate(
            first.owner,
            article.id,
            {
              expectedRevision: article.revision,
              voice: "ja-jp-primary",
              speed: 1,
            },
            state().speech,
            new AbortController().signal,
            randomUUID(),
          );
          article = await state().articles.get(first.owner, article.id);
          const cmsArticle = await state().cms.get(first.owner, article.id);
          const release = await state().cms.publish(first.owner, article.id, {
            expectedRevision: article.revision,
            expectedCmsRevision: cmsArticle.cms.revision,
            expectedAudioId: article.audio.audioId,
          });
          const stored = await state().cms.releaseAudio(
            first.owner,
            article.id,
            release.id,
          );
          const barrier = transportBarrier();
          let batchId;
          try {
            const created = await submit([selection(article)]);
            assert.equal(created.status, 202);
            batchId = created.data.id;
            await until(
              created.data.id,
              (value) => value.items[0].status === "running",
            );
            await bounded(barrier.entered.promise, "provider entered");
            // Simulate a concurrent saved result through the real article transaction,
            // without competing for the deliberately gated Gateway request.
            await state().articles.generate(
              first.owner,
              article.id,
              {
                expectedRevision: article.revision,
                voice: "ja-jp-primary",
                speed: 1,
              },
              {
                synthesize: async () => ({
                  audio: tone,
                  internalVersion: article.currentRuleVersion,
                }),
              },
              new AbortController().signal,
              randomUUID(),
            );
            const replacement = await state().articles.get(
              first.owner,
              article.id,
            );
            barrier.finish.resolve();
            const failed = await until(
              created.data.id,
              (value) => value.status === "completed",
            );
            assert.equal(failed.items[0].errorCode, "AUDIO_CHANGED");
            assert.equal(
              (await state().articles.get(first.owner, article.id)).audio
                .audioId,
              replacement.audio.audioId,
            );
            const after = await state().cms.releaseAudio(
              first.owner,
              article.id,
              release.id,
            );
            assert.deepEqual(after.data, stored.data);
            assert.equal(after.metadata.audioId, stored.metadata.audioId);
          } finally {
            await releaseBarrier(barrier, batchId);
          }
        },
      );
      await t.test(
        "queued rule changes fail before provider and in-flight rule changes retain old result",
        async () => {
          const articles = [
            await createArticle("規則競合一"),
            await createArticle("規則競合二"),
          ];
          const barrier = transportBarrier();
          let batchId;
          try {
            const created = await submit(articles.map(selection));
            assert.equal(created.status, 202);
            batchId = created.data.id;
            await until(
              created.data.id,
              (value) => value.items[0].status === "running",
            );
            await bounded(barrier.entered.promise, "provider entered");
            const before = calls;
            await state().vocabulary.create(first.owner, {
              text: "検証",
              reading: "けんしょう",
            });
            barrier.finish.resolve();
            const failed = await until(
              created.data.id,
              (value) => value.status === "completed",
            );
            assert.deepEqual(
              failed.items.map((value) => value.errorCode),
              ["PRONUNCIATION_CHANGED", "PRONUNCIATION_CHANGED"],
            );
            assert.equal(calls, before);
            assert.equal(
              (await state().articles.get(first.owner, articles[0].id)).audio,
              null,
            );
          } finally {
            await releaseBarrier(barrier, batchId);
          }
        },
      );
      await t.test(
        "restart marks a previously running item uncertain without replaying it",
        async () => {
          const article = await createArticle("再起動確認");
          const id = randomUUID(),
            before = calls;
          await runtime.pool.query(
            `INSERT INTO wb_audio_batches(id,account_id,request_id,request_hash,status,items)
        VALUES($1,$2,$3,$4,'running',$5::jsonb)`,
            [
              id,
              first.owner,
              randomUUID(),
              "0".repeat(64),
              JSON.stringify([
                {
                  ...selection(article),
                  title: article.title,
                  status: "running",
                },
              ]),
            ],
          );
          await competitor.close();
          await runtime.close();
          runtime = await createApplication(config, { batchPollMs: 5 });
          await runtime.app.listen(0, "127.0.0.1");
          base = await runtime.app.getUrl();
          const recovered = await until(
            id,
            (value) => value.status === "completed",
          );
          assert.equal(recovered.items[0].status, "uncertain");
          assert.equal(recovered.items[0].errorCode, "WORKER_INTERRUPTED");
          assert.equal(calls, before);
        },
      );
    } finally {
      hook = undefined;
      for (const barrier of barriers) barrier.resolve();
      await competitor.close();
      await runtime.close();
      globalThis.fetch = nativeFetch;
      const { Pool } = await import("pg");
      const cleanup = new Pool({ connectionString: url });
      try {
        await cleanup.query(
          "DELETE FROM ac_accounts WHERE id=ANY($1::uuid[])",
          [owners],
        );
      } finally {
        await cleanup.end();
      }
    }
  },
);
