// Explicit local-only provider transport fixture. Never load production .env.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createApplication } from "../../dist/app.js";
import { readConfig } from "../../dist/config.js";
import { migrate } from "../../dist/migrate.js";
if (!process.env.TEST_DATABASE_URL)
  throw new Error("TEST_DATABASE_URL required");
const tone = await readFile(
  new URL("../../../web/qa/tone.mp3", import.meta.url),
);
const controlPath = resolve(
  process.env.FIXTURE_CONTROL_FILE || "runtime/f2-provider-control.json",
);
globalThis.fetch = async (target, options) => {
  if (!String(target).startsWith("https://japaneast.tts.speech.microsoft.com/"))
    throw new Error("External network disabled by fixture");
  let control = {};
  try {
    control = JSON.parse(await readFile(controlPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (control.delayMs)
    await new Promise((ok, no) => {
      const abort = () => {
        clearTimeout(timer);
        no(new Error("Fixture request canceled"));
      };
      const timer = setTimeout(
        () => {
          options.signal?.removeEventListener("abort", abort);
          ok();
        },
        Math.min(20000, Math.max(0, control.delayMs)),
      );
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });
  if (control.fail) return new Response("Fixture failure", { status: 400 });
  return new Response(control.oversize ? new Uint8Array(8388609) : tone, {
    headers: { "Content-Type": "audio/mpeg" },
  });
};
const config = readConfig({
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  SESSION_SECRET: "isolated-f2-fixture-session-secret-only",
  PUBLIC_ORIGIN: process.env.FIXTURE_ORIGIN || "http://127.0.0.1:4182",
  NODE_ENV: "test",
  REGISTRATION_ENABLED: "true",
  TTS_AZURE_SPEECH_KEY: "fixture-only",
  TTS_AZURE_JA_VOICE_ID: "fixture-ja-voice",
});
await migrate(config.DATABASE_URL);
const runtime = await createApplication(config);
await runtime.app.listen(Number(process.env.FIXTURE_PORT || 3002), "127.0.0.1");
console.log(
  `F2 fixture API ready: ${await runtime.app.getUrl()}; origin ${config.PUBLIC_ORIGIN}; voice ja-jp-primary; playable tone only; control ${controlPath}`,
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await runtime.close();
    process.exit(0);
  });
