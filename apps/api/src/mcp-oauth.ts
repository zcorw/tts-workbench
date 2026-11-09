import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import type { ArticleService } from "./articles.js";
import type { Config } from "./config.js";
import { ApiError } from "./errors.js";

export const MCP_SCOPES = ["cms:read", "cms:drafts:create"];
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const authorizationSchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string().max(200),
  redirect_uri: z.string().max(2048),
  resource: z.string().max(2048),
  scope: z.string().min(1).max(200),
  state: z.string().max(512).optional(),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal("S256"),
});
export interface McpIdentity {
  owner: string;
  scopes: string[];
  grantId: string;
}

export class McpOAuthService {
  readonly origin: string;
  readonly resource: string;
  constructor(
    private pool: Pool,
    private articles: ArticleService,
    private config: Config,
  ) {
    this.origin = config.CMS_PUBLIC_ORIGIN ?? config.PUBLIC_ORIGIN;
    this.resource = `${this.origin}/mcp`;
  }
  authorization(input: unknown) {
    const dto = authorizationSchema.parse(input);
    const scopes = [...new Set(dto.scope.split(" ").filter(Boolean))].sort();
    if (
      dto.client_id !== this.config.CMS_MCP_CLIENT_ID ||
      !this.config.CMS_MCP_REDIRECT_URIS?.split(",").includes(
        dto.redirect_uri,
      ) ||
      dto.resource !== this.resource ||
      !scopes.length ||
      scopes.some((s) => !MCP_SCOPES.includes(s))
    )
      throw new ApiError(400, "INVALID_OAUTH_REQUEST");
    return { ...dto, scopes };
  }
  private redirect(
    dto: ReturnType<McpOAuthService["authorization"]>,
    params: Record<string, string>,
  ) {
    const target = new URL(dto.redirect_uri);
    for (const [key, value] of Object.entries({ ...params, iss: this.origin }))
      target.searchParams.set(key, value);
    if (dto.state !== undefined) target.searchParams.set("state", dto.state);
    return target.href;
  }
  async authorize(owner: string, input: unknown, approve: boolean) {
    const dto = this.authorization(input);
    if (!approve)
      return { redirectUrl: this.redirect(dto, { error: "access_denied" }) };
    return this.articles.transaction(owner, async (c) => {
      const count = Number(
        (
          await c.query(
            "SELECT count(*) FROM wb_cms_mcp_grants WHERE account_id=$1 AND revoked_at IS NULL AND expires_at>now()",
            [owner],
          )
        ).rows[0].count,
      );
      if (count >= 50) throw new ApiError(409, "MCP_GRANT_LIMIT");
      const id = randomUUID(),
        code = secret();
      await c.query(
        `INSERT INTO wb_cms_mcp_grants(id,account_id,client_id,resource,redirect_uri,scopes,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,now()+interval '7 days')`,
        [id, owner, dto.client_id, dto.resource, dto.redirect_uri, dto.scopes],
      );
      await c.query(
        "INSERT INTO wb_cms_mcp_tokens(token_hash,grant_id,kind,challenge,expires_at) VALUES($1,$2,'code',$3,now()+interval '5 minutes')",
        [hash(code), id, dto.code_challenge],
      );
      return { redirectUrl: this.redirect(dto, { code }) };
    });
  }
  private async issue(
    c: PoolClient,
    grant: { id: string; expires_at: Date; scopes: string[] },
  ) {
    const access = secret(),
      refresh = secret();
    await c.query(
      `INSERT INTO wb_cms_mcp_tokens(token_hash,grant_id,kind,expires_at)
      VALUES($1,$3,'access',LEAST(now()+interval '15 minutes',$4::timestamptz)),($2,$3,'refresh',$4)`,
      [hash(access), hash(refresh), grant.id, grant.expires_at],
    );
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: Math.max(
        0,
        Math.min(
          900,
          Math.floor(
            (new Date(grant.expires_at).getTime() - Date.now()) / 1000,
          ),
        ),
      ),
      scope: grant.scopes.join(" "),
    };
  }
  async exchange(input: unknown) {
    const dto = z
      .object({
        grant_type: z.enum(["authorization_code", "refresh_token"]),
        client_id: z.string().max(200),
        resource: z.string().max(2048),
        code: z.string().max(128).optional(),
        redirect_uri: z.string().max(2048).optional(),
        code_verifier: z
          .string()
          .regex(/^[A-Za-z0-9._~-]{43,128}$/)
          .optional(),
        refresh_token: z.string().max(128).optional(),
      })
      .parse(input);
    if (
      dto.client_id !== this.config.CMS_MCP_CLIENT_ID ||
      dto.resource !== this.resource
    )
      throw new ApiError(400, "invalid_grant");
    const kind = dto.grant_type === "authorization_code" ? "code" : "refresh";
    const value = kind === "code" ? dto.code : dto.refresh_token;
    if (!value) throw new ApiError(400, "invalid_grant");
    const c = await this.pool.connect();
    let completed = false;
    try {
      await c.query("BEGIN");
      const row = (
        await c.query(
          `SELECT g.*,t.kind,t.challenge,t.used_at,t.expires_at AS token_expires,a.status
        FROM wb_cms_mcp_tokens t JOIN wb_cms_mcp_grants g ON g.id=t.grant_id
        JOIN ac_accounts a ON a.id=g.account_id WHERE t.token_hash=$1 FOR UPDATE OF g,t`,
          [hash(value)],
        )
      ).rows[0];
      if (
        !row ||
        row.kind !== kind ||
        row.client_id !== dto.client_id ||
        row.resource !== dto.resource ||
        row.status !== "active" ||
        row.revoked_at ||
        new Date(row.expires_at).getTime() <= Date.now() ||
        new Date(row.token_expires).getTime() <= Date.now() ||
        (kind === "code" &&
          (dto.redirect_uri !== row.redirect_uri ||
            !dto.code_verifier ||
            !equal(
              createHash("sha256")
                .update(dto.code_verifier)
                .digest("base64url"),
              row.challenge,
            )))
      ) {
        throw new ApiError(400, "invalid_grant");
      }
      // Replay invalidates the whole grant, including access tokens. Commit the
      // revocation before reporting invalid_grant; don't undo it in a catch.
      const count = Number(
        (
          await c.query(
            "SELECT count(*) FROM wb_cms_mcp_tokens WHERE grant_id=$1",
            [row.id],
          )
        ).rows[0].count,
      );
      if (row.used_at || count + 2 > 1000) {
        await c.query(
          "UPDATE wb_cms_mcp_grants SET revoked_at=now() WHERE id=$1",
          [row.id],
        );
        await c.query("COMMIT");
        completed = true;
        throw new ApiError(400, "invalid_grant");
      }
      await c.query(
        "UPDATE wb_cms_mcp_tokens SET used_at=now() WHERE token_hash=$1",
        [hash(value)],
      );
      const tokens = await this.issue(c, row);
      await c.query("COMMIT");
      completed = true;
      return tokens;
    } catch (error) {
      if (!completed) await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  }
  async identity(authorization: string | undefined): Promise<McpIdentity> {
    if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization))
      throw new ApiError(401, "invalid_token");
    const row = (
      await this.pool.query(
        `SELECT g.account_id,g.scopes,g.id
      FROM wb_cms_mcp_tokens t JOIN wb_cms_mcp_grants g ON g.id=t.grant_id
      JOIN ac_accounts a ON a.id=g.account_id
      WHERE t.token_hash=$1 AND t.kind='access' AND t.expires_at>now()
      AND g.expires_at>now() AND g.revoked_at IS NULL AND a.status='active'
      AND g.resource=$2 AND g.client_id=$3`,
        [
          hash(authorization.slice(7)),
          this.resource,
          this.config.CMS_MCP_CLIENT_ID,
        ],
      )
    ).rows[0];
    if (!row) throw new ApiError(401, "invalid_token");
    return { owner: row.account_id, scopes: row.scopes, grantId: row.id };
  }
  async revokeToken(input: unknown) {
    const dto = z
      .object({ token: z.string().max(128), client_id: z.string().max(200) })
      .parse(input);
    if (dto.client_id !== this.config.CMS_MCP_CLIENT_ID)
      throw new ApiError(400, "invalid_client");
    await this.pool.query(
      `UPDATE wb_cms_mcp_grants SET revoked_at=now() WHERE client_id=$1 AND resource=$2
      AND id IN (SELECT grant_id FROM wb_cms_mcp_tokens WHERE token_hash=$3)`,
      [dto.client_id, this.resource, hash(dto.token)],
    );
  }
  async grants(owner: string) {
    return {
      items: (
        await this.pool.query(
          `SELECT id,client_id AS "clientId",scopes,created_at AS "createdAt",expires_at AS "expiresAt",revoked_at AS "revokedAt"
      FROM wb_cms_mcp_grants WHERE account_id=$1 AND expires_at>now() ORDER BY created_at DESC LIMIT 100`,
          [owner],
        )
      ).rows,
    };
  }
  async revoke(owner: string, id: string) {
    z.uuid().parse(id);
    const result = await this.pool.query(
      "UPDATE wb_cms_mcp_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND account_id=$2",
      [id, owner],
    );
    if (!result.rowCount) throw new ApiError(404, "NOT_FOUND");
  }
}
