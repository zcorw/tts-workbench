import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { AccountService } from "@tts-workbench/account-core";
import { createApplication } from "../../dist/app.js";
import { readConfig } from "../../dist/config.js";
if (!process.env.TEST_DATABASE_URL || !process.env.TEST_PG_CONTAINER)
  throw new Error("Explicit isolated test DB/container required");
const config = readConfig({
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  SESSION_SECRET: "backup-fixture-only-session-secret-long",
  PUBLIC_ORIGIN: "http://127.0.0.1:4182",
  NODE_ENV: "test",
});
const runtime = await createApplication(config);
const suffix = randomUUID().replaceAll("-", "");
const restoreName = "f2_restore_" + suffix,
  dump = "/tmp/" + restoreName + ".dump";
const docker = (...args) =>
  execFileSync("docker", ["exec", process.env.TEST_PG_CONTAINER, ...args], {
    encoding: "utf8",
  });
let account,
  restored,
  created = false;
try {
  account = await runtime.app.get(AccountService).createAccount({
    login: "backup-" + suffix,
    password: "Eight123",
    displayName: "Backup fixture",
  });
  const article = await runtime.state.articles.create(account.id, {
    title: "復元",
    text: "日本か\u3099\n😀",
  });
  const tone = await readFile(
    new URL("../../../web/qa/tone.mp3", import.meta.url),
  );
  const result = await runtime.state.articles.generate(
    account.id,
    article.id,
    { expectedRevision: 1, voice: "fixture-backup" },
    { synthesize: async () => ({ audio: tone, internalVersion: 0 }) },
    new AbortController().signal,
    randomUUID(),
  );
  docker("pg_dump", "-U", "workbench", "-d", "workbench", "-Fc", "-f", dump);
  docker("createdb", "-U", "workbench", restoreName);
  created = true;
  docker(
    "pg_restore",
    "-U",
    "workbench",
    "-d",
    restoreName,
    "--no-owner",
    dump,
  );
  const restoreUrl = new URL(config.DATABASE_URL);
  restoreUrl.pathname = "/" + restoreName;
  restored = new Pool({ connectionString: restoreUrl.toString() });
  const row = (
    await restored.query(
      "SELECT a.text,a.revision,a.content_revision,au.metadata,au.data FROM wb_articles a JOIN wb_article_audio au ON au.article_id=a.id WHERE a.id=$1",
      [article.id],
    )
  ).rows[0];
  assert.equal(row.text, article.text);
  assert.equal(row.revision, 1);
  assert.equal(row.content_revision, 1);
  assert.deepEqual(row.metadata, result.audio);
  assert.deepEqual(row.data, tone);
  console.log(
    JSON.stringify({
      result: "PASS",
      textExact: true,
      metadataExact: true,
      audioBytes: row.data.length,
      audioSHA256: createHash("sha256").update(row.data).digest("hex"),
      migrationCount: (
        await restored.query("SELECT count(*) FROM wb_migrations")
      ).rows[0].count,
    }),
  );
} finally {
  await restored?.end();
  if (created) docker("dropdb", "-U", "workbench", restoreName);
  if (account)
    await runtime.pool.query("DELETE FROM ac_accounts WHERE id=$1", [
      account.id,
    ]);
  await runtime.close();
}
