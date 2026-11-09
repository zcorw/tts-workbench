import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

const requestTtl = 5 * 60;
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

  async start() {
    const result = await this.transaction(async (client) => {
      // 序列化所有实例的申请配额检查，锁随事务释放。
      await client.query("SELECT pg_advisory_xact_lock(2053465193, 1)");
      await client.query("DELETE FROM wb_zhiyue_device_requests WHERE expires_at<=now()");
      await client.query("DELETE FROM wb_zhiyue_bindings WHERE expires_at<=now()");
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
    const digest = hash(deviceCode);
    const result = await this.transaction(async (client) => {
      // UPDATE 锁住申请行，并记录一次允许的轮询。并发兑换只能消耗一次申请。
      const { rows: [request] } = await client.query<{ account_id: string | null }>(
        `UPDATE wb_zhiyue_device_requests
         SET next_poll_at=clock_timestamp()+$2*interval '1 second'
         WHERE device_hash=$1 AND expires_at>clock_timestamp()
           AND (next_poll_at IS NULL OR next_poll_at<=clock_timestamp())
         RETURNING account_id`,
        [digest, pollInterval],
      );
      if (!request) {
        const { rows: [state] } = await client.query<{ expired: boolean }>(
          `SELECT expires_at<=clock_timestamp() AS expired
           FROM wb_zhiyue_device_requests WHERE device_hash=$1`,
          [digest],
        );
        if (!state) throw new ZhiyueGrantError("invalid_grant", 400);
        if (state.expired) throw new ZhiyueGrantError("expired_token", 400);
        throw new ZhiyueGrantError("slow_down", 400);
      }
      // 提交轮询时间以后才返回等待，错误响应不会回滚节流记录。
      if (!request.account_id) return null;

      // 同一账户的配额检查与新绑定串行执行。
      const { rows: [account] } = await client.query<{ id: string; displayName: string }>(
        `SELECT id,display_name AS "displayName" FROM ac_accounts
         WHERE id=$1 AND status='active' FOR NO KEY UPDATE`,
        [request.account_id],
      );
      if (!account) throw new ZhiyueGrantError("invalid_grant", 400);
      const { rows: [count] } = await client.query<{ total: number }>(
        `SELECT count(*)::integer AS total FROM wb_zhiyue_bindings
         WHERE account_id=$1 AND expires_at>clock_timestamp()`,
        [account.id],
      );
      if (count.total >= bindingLimit) throw new ZhiyueGrantError("temporarily_unavailable", 429);

      const bindingId = randomUUID();
      const accessToken = secret();
      const { rowCount } = await client.query(
        `INSERT INTO wb_zhiyue_bindings(id,account_id,token_hash,created_at,expires_at)
         SELECT $1,$2,$3,statement_timestamp(),statement_timestamp()+$4*interval '1 second'
         FROM wb_zhiyue_device_requests WHERE device_hash=$5 AND expires_at>statement_timestamp()`,
        [bindingId, account.id, hash(accessToken), bindingTtl, digest],
      );
      if (!rowCount) throw new ZhiyueGrantError("expired_token", 400);
      await client.query("DELETE FROM wb_zhiyue_device_requests WHERE device_hash=$1", [digest]);
      return { access_token: accessToken, expires_in: bindingTtl, account, binding_id: bindingId };
    });
    if (!result) throw new ZhiyueGrantError("authorization_pending", 400);
    return result;
  }

  async identify(accessToken: string) {
    if (!tokenPattern.test(accessToken)) throw new ZhiyueGrantError("invalid_token", 401);
    const { rows: [binding] } = await this.pool.query<{ id: string; accountId: string }>(
      `SELECT b.id,b.account_id AS "accountId"
       FROM wb_zhiyue_bindings b JOIN ac_accounts a ON a.id=b.account_id
       WHERE b.token_hash=$1 AND b.expires_at>now() AND a.status='active'`,
      [hash(accessToken)],
    );
    if (!binding) throw new ZhiyueGrantError("invalid_token", 401);
    return binding;
  }

  async list(accountId: string) {
    const { rows } = await this.pool.query<{ id: string; created_at: Date; expires_at: Date }>(
      `SELECT b.id,b.created_at,b.expires_at FROM wb_zhiyue_bindings b
       JOIN ac_accounts a ON a.id=b.account_id
       WHERE b.account_id=$1 AND b.expires_at>now() AND a.status='active'
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
         WHERE b.id=$1 AND b.expires_at>clock_timestamp() AND a.status='active' FOR UPDATE OF b`,
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
         WHERE b.id=$2 AND b.expires_at>statement_timestamp() AND a.status='active'
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
       WHERE t.token_hash=$1 AND t.expires_at>now() AND b.expires_at>now() AND a.status='active'`,
      [hash(ticket)],
    );
    if (!media) throw new ZhiyueGrantError("invalid_token", 401);
    return media;
  }
}
