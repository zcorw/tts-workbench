// Isolated development/test server: explicit database, synthetic identity and audio only.
// Do not use this fixture with an existing workbench database or provider credentials.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createApplication } from "../../dist/app.js";
import { readConfig } from "../../dist/config.js";
import { migrate } from "../../dist/migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const database = new URL(databaseUrl);
if (!/^(?:127\.0\.0\.1|localhost|cms-test-pg)$/.test(database.hostname) ||
    (!/^\/cms_v1_test[0-9]*$/.test(database.pathname) &&
      database.pathname !== "/cms_categories_preview_20261027" && database.pathname !== "/cms_reading_preview_20261027"))
  throw new Error("CMS fixture only accepts this task's explicit isolated databases");
if (!process.env.FIXTURE_CONTROL_FILE)
  throw new Error("FIXTURE_CONTROL_FILE must explicitly point to the task's test directory");
const host = process.env.FIXTURE_HOST || "127.0.0.1";
if (!["127.0.0.1", "0.0.0.0"].includes(host)) throw new Error("Invalid fixture host");
const tone = await readFile(new URL("../../../web/qa/tone.mp3", import.meta.url));
const controlPath = resolve(process.env.FIXTURE_CONTROL_FILE);
globalThis.fetch = async (target, options = {}) => {
  if (!String(target).startsWith("https://japaneast.tts.speech.microsoft.com/"))
    throw new Error("External network disabled by CMS fixture");
  let control = {};
  try { control = JSON.parse(await readFile(controlPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (control.delayMs) await new Promise((resolveDelay, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error("Fixture request canceled")); };
    const timer = setTimeout(() => { options.signal?.removeEventListener("abort", abort); resolveDelay(); }, Math.min(20000, Math.max(0, control.delayMs)));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
  });
  if (control.fail) return new Response("Fixture-only provider failure", { status: 400 });
  const bytes = control.oversize ? new Uint8Array(8388609)
    : control.variant ? Buffer.concat([tone, Buffer.from([Number(control.variant) & 255])]) : tone;
  return new Response(bytes, { headers: { "Content-Type": "audio/mpeg" } });
};
const config = readConfig({
  DATABASE_URL: databaseUrl,
  SESSION_SECRET: "isolated-cms-v1-fixture-session-secret-only",
  PUBLIC_ORIGIN: process.env.FIXTURE_ORIGIN || "http://127.0.0.1:4381",
  NODE_ENV: "test",
  REGISTRATION_ENABLED: "true",
  CMS_READ_TOKENS_ENABLED: process.env.FIXTURE_READ_TOKENS_ENABLED || "false",
  WEB_DIST: process.env.FIXTURE_WEB_DIST,
  TTS_AZURE_SPEECH_KEY: process.env.FIXTURE_TTS_DISABLED === "true" ? undefined : "fixture-only",
  TTS_AZURE_JA_VOICE_ID: process.env.FIXTURE_TTS_DISABLED === "true" ? undefined : "fixture-ja-voice",
});
await migrate(config.DATABASE_URL);
const runtime = await createApplication(config);
await runtime.app.listen(Number(process.env.FIXTURE_PORT || 3302), host);
console.log(`CMS isolated fixture ready; origin ${config.PUBLIC_ORIGIN}; playable synthetic tone only`);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => {
  await runtime.close();
  process.exit(0);
});
