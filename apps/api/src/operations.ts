import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { AccountService, argon2Passwords } from "@tts-workbench/account-core";
import { PostgresAccountRepository } from "@tts-workbench/account-postgres";
import { migrate } from "./migrate.js";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const [command, login, displayName] = process.argv.slice(2);
if (command === "migrate") {
  await migrate(url);
  console.log("Account and vocabulary migrations applied");
} else {
  const pool = new Pool({ connectionString: url });
  try {
    const service = new AccountService({
      repository: new PostgresAccountRepository(pool),
      passwords: argon2Passwords,
      randomId: randomUUID,
    });
    if (command === "create") {
      const password = process.env.ACCOUNT_PASSWORD;
      delete process.env.ACCOUNT_PASSWORD;
      const result = await service.createAccount({
        login,
        displayName,
        password,
      });
      console.log(JSON.stringify({ id: result.id, login: result.login }));
    } else if (command === "disable") {
      const account = await new PostgresAccountRepository(pool).findByLogin(
        login?.trim().toLowerCase() ?? "",
      );
      if (!account) throw new Error("Account not found");
      await service.disableAccount(account.id);
      console.log("Account disabled");
    } else if (command === "cleanup") {
      const result = await pool.query('DELETE FROM ac_sessions WHERE expire < now()');
      console.log(`Expired sessions removed: ${result.rowCount}`);
    } else
      throw new Error(
        "Usage: operations migrate | create <login> <displayName> (ACCOUNT_PASSWORD env) | disable <login> | cleanup",
      );
  } finally {
    await pool.end();
  }
}
