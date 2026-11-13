import { createHmac, createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

const requestTtl = 5 * 60;
const confirmationTtl = 5 * 60;
const pollInterval = 5;
const bindingTtl = 24 * 60 * 60;
const mediaTtl = 150;
const requestLimit = 512;
const bindingLimit = 8;
const mediaLimit = 24;
const alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const userCodePattern = new RegExp(`^[${alphabet}]{4}-?[${alphabet}]{4}$`);
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

export class ZhiyueGrantError extends Error {
  readonly error: string;
  readonly status: number;

  constructor(error: string, status: number) {
    super(error);
    this.name = "ZhiyueGrantError";
    this.error = error;
    this.status = status;
  }
}

export class ZhiyueDeviceService {
  private readonly pool: Pool;
  private cleanupTimer?: ReturnType<typeof setTimeout>;
  private cleanupRun?: Promise<void>;
  private cleanupStopped = true;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  private async transaction<T>(action: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  async cleanupExpired() {
    await this.pool.query(`DELETE FROM wb_zhiyue_device_requests r WHERE expires_at<=clock_timestamp()
      OR (binding_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM wb_zhiyue_bindings b WHERE b.id=r.binding_id))`);
    await this.pool.query(`UPDATE wb_zhiyue_bindings SET upgrade_token_hash=NULL,upgrade_nonce=NULL,upgrade_until=NULL
      WHERE upgrade_until<=clock_timestamp()`);
    // Authorization checks reject at the exact deadline even if the worker is delayed.
    await this.pool.query(`DELETE FROM wb_zhiyue_bindings
      WHERE (confirmed_at IS NULL AND confirm_by<=clock_timestamp())
         OR (refresh_hash IS NULL AND expires_at<=clock_timestamp())`);
  }

  startCleanup(intervalMs = 5000) {
    if (!this.cleanupStopped) return;
    this.cleanupStopped = false;
    const tick = () => {
      this.cleanupRun = this.cleanupExpired().catch(() => {
        // Never include query parameters or credentials in cleanup logs.
        console.error("Zhiyue pending-binding cleanup failed; retrying");
      }).finally(() => {
        if (!this.cleanupStopped) {
          this.cleanupTimer = setTimeout(tick, intervalMs);
          this.cleanupTimer.unref();
        }
      });
    };
    tick();
  }

  async close() {
    this.cleanupStopped = true;
    clearTimeout(this.cleanupTimer);
    await this.cleanupRun;
  }

  async start() {
    await this.cleanupExpired();
    const result = await this.transaction(async (client) => {
      // 序列化所有实例的申请配额检查，锁随事务释放。
      await client.query("SELECT pg_advisory_xact_lock(2053465193, 1)");
      await client.query("DELETE FROM wb_zhiyue_device_requests WHERE expires_at<=now()");
      await client.query("DELETE FROM wb_zhiyue_media_tickets WHERE expires_at<=now()");
      const { rows } = await client.query<{ total: number }>(
        "SELECT count(*)::integer AS total FROM wb_zhiyue_device_requests",
      );
      if (rows[0].total >= requestLimit) return null;

      for (let attempt = 0; attempt < 4; attempt++) {
        const deviceCode = secret();
        const userCode = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join("");
        const { rowCount } = await client.query(
          `INSERT INTO wb_zhiyue_device_requests(device_hash,user_hash,expires_at)
           VALUES($1,$2,statement_timestamp()+$3*interval '1 second')
           ON CONFLICT DO NOTHING`,
          [hash(deviceCode), hash(userCode), requestTtl],
        );
        if (rowCount) {
          return {
            device_code: deviceCode,
            user_code: `${userCode.slice(0, 4)}-${userCode.slice(4)}`,
            expires_in: requestTtl,
            interval: pollInterval,
          };
        }
      }
      return null;
    });
    if (!result) throw new ZhiyueGrantError("temporarily_unavailable", 429);
    return result;
  }

  async approve(accountId: string, userCode: string) {
    const code = userCode.trim().toUpperCase();
    if (!userCodePattern.test(code)) throw new ZhiyueGrantError("invalid_grant", 400);
    const { rowCount } = await this.pool.query(
      `UPDATE wb_zhiyue_device_requests r SET account_id=$2
       FROM ac_accounts a
       WHERE r.user_hash=$1 AND (r.account_id IS NULL OR r.account_id=$2)
         AND r.expires_at>clock_timestamp() AND a.id=$2 AND a.status='active'`,
      [hash(code.replace("-", "")), accountId],
    );
    if (!rowCount) throw new ZhiyueGrantError("invalid_grant", 400);
  }

  async claim(deviceCode: string) {
    if (!tokenPattern.test(deviceCode)) throw new ZhiyueGrantError("invalid_grant", 400);
    await this.cleanupExpired();
    const digest = hash(deviceCode);
    const result = await this.transaction(async (client) => {
      const { rows: [observed] } = await client.query<{ account_id: string | null }>(
        "SELECT account_id FROM wb_zhiyue_device_requests WHERE device_hash=$1", [digest],
      );
      if (!observed) throw new ZhiyueGrantError("invalid_grant", 400);
      // Account -> request -> binding lock order matches account revocation.
      const { rows: [account] } = observed.account_id ? await client.query<{ id: string; displayName: string }>(
        `SELECT id,display_name AS "displayName" FROM ac_accounts
         WHERE id=$1 AND status='active' FOR NO KEY UPDATE`, [observed.account_id],
      ) : { rows: [] };
      if (observed.account_id && !account) throw new ZhiyueGrantError("invalid_grant", 400);
      const { rows: [request] } = await client.query<{ binding_id: string | null; claim_nonce: string | null }>(
        `UPDATE wb_zhiyue_device_requests SET next_poll_at=clock_timestamp()+$2*interval '1 second'
         WHERE device_hash=$1 AND expires_at>clock_timestamp()
           AND (next_poll_at IS NULL OR next_poll_at<=clock_timestamp()) RETURNING binding_id,claim_nonce`,
        [digest, pollInterval],
      );
      if (!request) {
        const { rows: [state] } = await client.query<{ expired: boolean }>(
          "SELECT expires_at<=clock_timestamp() AS expired FROM wb_zhiyue_device_requests WHERE device_hash=$1", [digest],
        );
        if (!state) throw new ZhiyueGrantError("invalid_grant", 400);
        if (state.expired) throw new ZhiyueGrantError("expired_token", 400);
        throw new ZhiyueGrantError("slow_down", 400);
      }
      if (!account) return null;
      // A private recovery nonce makes claim retries stable without promoting the
      // short-lived device code itself into an offline-derivable permanent credential.
      if (request.binding_id && !request.claim_nonce) throw new ZhiyueGrantError("invalid_grant", 400);
      const nonce = request.claim_nonce ?? secret();
      const accessToken = createHmac("sha256", nonce).update("zhiyue-claim-access-v1:" + deviceCode).digest("base64url");
      const refreshToken = createHmac("sha256", nonce).update("zhiyue-claim-refresh-v1:" + deviceCode).digest("base64url");
      let bindingId = request.binding_id;
      if (!bindingId) {
        const { rows: [count] } = await client.query<{ total: number }>(
          `SELECT count(*)::integer AS total FROM wb_zhiyue_bindings WHERE account_id=$1
           AND ((confirmed_at IS NOT NULL AND (expires_at>clock_timestamp() OR refresh_hash IS NOT NULL))
             OR (confirmed_at IS NULL AND confirm_by>clock_timestamp()))`, [account.id],
        );
        if (count.total >= bindingLimit) throw new ZhiyueGrantError("temporarily_unavailable", 429);
        bindingId = randomUUID();
        await client.query(
          `INSERT INTO wb_zhiyue_bindings(id,account_id,token_hash,refresh_hash,created_at,expires_at,confirm_by)
           VALUES($1,$2,$3,$4,clock_timestamp(),clock_timestamp()+$5*interval '1 second',clock_timestamp()+$6*interval '1 second')`,
          [bindingId, account.id, hash(accessToken), hash(refreshToken), bindingTtl, confirmationTtl],
        );
        await client.query(
          `UPDATE wb_zhiyue_device_requests SET binding_id=$2,claim_nonce=$3,expires_at=(SELECT confirm_by FROM wb_zhiyue_bindings WHERE id=$2)
           WHERE device_hash=$1`, [digest, bindingId, nonce],
        );
      }
      const { rows: [binding] } = await client.query<{ expires_in: number }>(
        `SELECT FLOOR(EXTRACT(EPOCH FROM expires_at-clock_timestamp()))::integer AS expires_in
         FROM wb_zhiyue_bindings WHERE id=$1 AND account_id=$2 AND confirmed_at IS NULL
           AND confirm_by>clock_timestamp() FOR UPDATE`, [bindingId, account.id],
      );
      if (!binding) throw new ZhiyueGrantError("invalid_grant", 400);
      return { access_token: accessToken, refresh_token: refreshToken, expires_in: binding.expires_in,
        account, binding_id: bindingId, confirmation_required: true };
    });
    if (!result) throw new ZhiyueGrantError("authorization_pending", 400);
    return result;
  }

  async confirm(refreshToken: string) {
    if (!tokenPattern.test(refreshToken)) throw new ZhiyueGrantError("invalid_grant", 400);
    await this.cleanupExpired();
    await this.transaction(async (client) => {
      const { rows: [owner] } = await client.query<{ account_id: string }>(
        "SELECT account_id FROM wb_zhiyue_bindings WHERE refresh_hash=$1", [hash(refreshToken)],
      );
      if (!owner) throw new ZhiyueGrantError("invalid_grant", 400);
      const { rowCount: active } = await client.query(
        "SELECT id FROM ac_accounts WHERE id=$1 AND status='active' FOR NO KEY UPDATE", [owner.account_id],
      );
      if (!active) throw new ZhiyueGrantError("invalid_grant", 400);
      const { rows: [confirmed] } = await client.query<{ id: string }>(
        `UPDATE wb_zhiyue_bindings SET confirmed_at=COALESCE(confirmed_at,clock_timestamp()),confirm_by=NULL
         WHERE refresh_hash=$1 AND account_id=$2 AND (confirmed_at IS NOT NULL OR confirm_by>clock_timestamp()) RETURNING id`,
        [hash(refreshToken), owner.account_id],
      );
      if (!confirmed) throw new ZhiyueGrantError("invalid_grant", 400);
      await client.query("UPDATE wb_zhiyue_device_requests SET claim_nonce=NULL WHERE binding_id=$1", [confirmed.id]);
    });
  }

  async renew(credential: string, upgrade = false) {
    if (!tokenPattern.test(credential)) throw new ZhiyueGrantError("invalid_grant", 400);
    await this.cleanupExpired();
    return this.transaction(async (client) => {
      // Lock the account before the binding, matching password-change and claim ordering.
      const { rows: [owner] } = await client.query<{ account_id: string }>(
        `SELECT account_id FROM wb_zhiyue_bindings WHERE ${upgrade ? "(token_hash=$1 OR upgrade_token_hash=$1)" : "refresh_hash=$1"}`,
        [hash(credential)],
      );
      if (!owner) throw new ZhiyueGrantError("invalid_grant", 400);
      const { rows: [account] } = await client.query<{ id: string; displayName: string }>(
        `SELECT id,display_name AS "displayName" FROM ac_accounts
         WHERE id=$1 AND status='active' FOR NO KEY UPDATE`, [owner.account_id],
      );
      if (!account) throw new ZhiyueGrantError("invalid_grant", 400);
      const { rows: [binding] } = await client.query<{ id: string; expires_in: number; refresh_hash: string | null; upgrade_token_hash: string | null; upgrade_nonce: string | null; upgrade_until: Date | null }>(
        `SELECT id,refresh_hash,upgrade_token_hash,upgrade_nonce,upgrade_until,CEIL(EXTRACT(EPOCH FROM expires_at-clock_timestamp()))::integer AS expires_in
         FROM wb_zhiyue_bindings WHERE account_id=$2 AND ${upgrade ? "(token_hash=$1 OR upgrade_token_hash=$1)" : "refresh_hash=$1"}
         AND confirmed_at IS NOT NULL
         ${upgrade ? "AND ((refresh_hash IS NULL AND expires_at>clock_timestamp()) OR (upgrade_token_hash=$1 AND upgrade_until>clock_timestamp()))" : ""} FOR UPDATE`,
        [hash(credential), account.id],
      );
      if (!binding) throw new ZhiyueGrantError("invalid_grant", 400);
      // A private recovery nonce prevents a leaked legacy bearer from computing the
      // long-lived refresh credential after its bounded upgrade-recovery window.
      const nonce = upgrade ? (binding.upgrade_nonce ?? secret()) : null;
      const refreshToken = upgrade ? createHmac("sha256", nonce!).update(credential).digest("base64url") : credential;
      if (upgrade && binding.refresh_hash && binding.refresh_hash !== hash(refreshToken))
        throw new ZhiyueGrantError("invalid_grant", 400);
      const accessToken = secret();
      await client.query(
        upgrade
          ? `UPDATE wb_zhiyue_bindings SET refresh_hash=$2,upgrade_token_hash=$3,upgrade_nonce=$4,
             upgrade_until=COALESCE(upgrade_until,clock_timestamp()+interval '5 minutes'),
             token_hash=$5,expires_at=clock_timestamp()+$6*interval '1 second' WHERE id=$1`
          : `UPDATE wb_zhiyue_bindings SET token_hash=$2,upgrade_token_hash=NULL,upgrade_nonce=NULL,upgrade_until=NULL,
             expires_at=clock_timestamp()+$3*interval '1 second' WHERE id=$1`,
        upgrade ? [binding.id, hash(refreshToken), hash(credential), nonce, hash(accessToken), bindingTtl]
          : [binding.id, hash(accessToken), bindingTtl],
      );
      return { access_token: accessToken, refresh_token: refreshToken,
        expires_in: bindingTtl, account, binding_id: binding.id, confirmation_required: false };
    });
  }

  async identify(accessToken: string, allowPending = false) {
    await this.cleanupExpired();
    if (!tokenPattern.test(accessToken)) throw new ZhiyueGrantError("invalid_token", 401);
    const { rows: [binding] } = await this.pool.query<{ id: string; accountId: string }>(
      `SELECT b.id,b.account_id AS "accountId"
       FROM wb_zhiyue_bindings b JOIN ac_accounts a ON a.id=b.account_id
       WHERE b.token_hash=$1 AND b.expires_at>now() AND a.status='active'
         AND (b.confirmed_at IS NOT NULL OR ($2 AND b.confirm_by>clock_timestamp()))`,
      [hash(accessToken), allowPending],
    );
    if (!binding) throw new ZhiyueGrantError("invalid_token", 401);
    return binding;
  }

  async list(accountId: string) {
    await this.cleanupExpired();
    const { rows } = await this.pool.query<{ id: string; created_at: Date; expires_at: Date }>(
      `SELECT b.id,b.created_at,b.expires_at FROM wb_zhiyue_bindings b
       JOIN ac_accounts a ON a.id=b.account_id
       WHERE b.account_id=$1 AND (b.expires_at>now() OR b.refresh_hash IS NOT NULL) AND a.status='active'
       ORDER BY b.created_at DESC,b.id DESC`,
      [accountId],
    );
    return {
      items: rows.map(({ id, created_at, expires_at }) => ({
        id,
        createdAt: created_at.toISOString(),
        expiresAt: expires_at.toISOString(),
      })),
    };
  }

  async revoke(accountId: string, bindingId: string) {
    if (!uuidPattern.test(bindingId)) throw new ZhiyueGrantError("invalid_request", 400);
    await this.pool.query("DELETE FROM wb_zhiyue_bindings WHERE id=$1 AND account_id=$2", [bindingId, accountId]);
  }

  async issueMedia(bindingId: string, releaseId: string) {
    if (!uuidPattern.test(bindingId) || !uuidPattern.test(releaseId))
      throw new ZhiyueGrantError("invalid_request", 400);
    return this.transaction(async (client) => {
      // 锁住绑定，确保同一绑定的并发签发共享配额，并和撤销互斥。
      const { rowCount } = await client.query(
        `SELECT b.id FROM wb_zhiyue_bindings b JOIN ac_accounts a ON a.id=b.account_id
         WHERE b.id=$1 AND b.expires_at>clock_timestamp() AND a.status='active' AND b.confirmed_at IS NOT NULL FOR UPDATE OF b`,
        [bindingId],
      );
      if (!rowCount) throw new ZhiyueGrantError("invalid_token", 401);
      await client.query(
        "DELETE FROM wb_zhiyue_media_tickets WHERE binding_id=$1 AND expires_at<=clock_timestamp()",
        [bindingId],
      );
      const { rows: [count] } = await client.query<{ total: number }>(
        "SELECT count(*)::integer AS total FROM wb_zhiyue_media_tickets WHERE binding_id=$1",
        [bindingId],
      );
      if (count.total >= mediaLimit) throw new ZhiyueGrantError("temporarily_unavailable", 429);

      const ticket = secret();
      const { rows: [issued] } = await client.query<{ expires_in: number }>(
        `INSERT INTO wb_zhiyue_media_tickets(token_hash,binding_id,release_id,expires_at)
         SELECT $1,b.id,$3,LEAST(b.expires_at,statement_timestamp()+$4*interval '1 second')
         FROM wb_zhiyue_bindings b JOIN ac_accounts a ON a.id=b.account_id
         WHERE b.id=$2 AND b.expires_at>statement_timestamp() AND a.status='active' AND b.confirmed_at IS NOT NULL
         RETURNING CEIL(EXTRACT(EPOCH FROM expires_at-statement_timestamp()))::integer AS expires_in`,
        [hash(ticket), bindingId, releaseId, mediaTtl],
      );
      if (!issued) throw new ZhiyueGrantError("invalid_token", 401);
      return { ticket, expires_in: issued.expires_in };
    });
  }

  async identifyMedia(ticket: string) {
    if (!tokenPattern.test(ticket)) throw new ZhiyueGrantError("invalid_token", 401);
    const { rows: [media] } = await this.pool.query<{ accountId: string; releaseId: string }>(
      `SELECT b.account_id AS "accountId",t.release_id AS "releaseId"
       FROM wb_zhiyue_media_tickets t JOIN wb_zhiyue_bindings b ON b.id=t.binding_id
       JOIN ac_accounts a ON a.id=b.account_id
       WHERE t.token_hash=$1 AND t.expires_at>now() AND b.expires_at>now() AND a.status='active' AND b.confirmed_at IS NOT NULL`,
      [hash(ticket)],
    );
    if (!media) throw new ZhiyueGrantError("invalid_token", 401);
    return media;
  }
}
