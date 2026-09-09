import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";
import { migrateAccounts } from "@tts-workbench/account-postgres";
export async function migrate(url: string) {
  await migrateAccounts(url);
  await runner({
    databaseUrl: url,
    dir: fileURLToPath(new URL("../migrations/", import.meta.url)),
    direction: "up",
    migrationsTable: "wb_migrations",
    log: () => {},
  });
}
