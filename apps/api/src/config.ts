import { z } from "zod";
const siteOrigin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  }, "Site URLs must be plain HTTP(S) origins without credentials")
  .transform((value) => new URL(value).origin);
const optionalOrigin = z.preprocess(
  (value) => (value === "" ? undefined : value),
  siteOrigin.optional(),
);
export const configSchema = z.object({
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32),
  PUBLIC_ORIGIN: siteOrigin,
  CMS_PUBLIC_ORIGIN: optionalOrigin,
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("127.0.0.1"),
  REGISTRATION_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  TRUST_PROXY: z.string().default("loopback"),
  WEB_DIST: z.string().optional(),
  CMS_DIST: z.string().optional(),
  CMS_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  MAX_ARTICLES: z.coerce.number().int().min(1).default(100),
  CMS_READ_TOKENS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  CMS_ZHIYUE_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  CMS_MCP_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  CMS_MCP_CLIENT_ID: z.string().min(1).max(200).optional(),
  CMS_MCP_REDIRECT_URIS: z.string().max(10000).optional(),
  TTS_AZURE_SPEECH_KEY: z.string().optional(),
  TTS_AZURE_JA_VOICE_ID: z.string().optional(),
  TTS_PRODUCTION_APPROVED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  TTS_DATA_POLICY_REF: z.string().optional(),
});
export type Config = z.infer<typeof configSchema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = configSchema.parse(env);
  if (
    config.NODE_ENV === "production" &&
    !config.PUBLIC_ORIGIN.startsWith("https://")
  )
    throw new Error("Production PUBLIC_ORIGIN requires HTTPS");
  if (
    config.NODE_ENV === "production" &&
    config.CMS_PUBLIC_ORIGIN &&
    !config.CMS_PUBLIC_ORIGIN.startsWith("https://")
  )
    throw new Error("Production CMS_PUBLIC_ORIGIN requires HTTPS");
  if (config.CMS_DIST && config.CMS_PORT === config.PORT)
    throw new Error("CMS_PORT and PORT must be different");
  if (config.CMS_ZHIYUE_ENABLED && (!config.CMS_DIST || !config.CMS_PUBLIC_ORIGIN?.startsWith("https://")))
    throw new Error("Zhiyue device binding requires a separate HTTPS CMS site");
  if (config.CMS_MCP_ENABLED) {
    if (
      !config.CMS_PUBLIC_ORIGIN ||
      !config.CMS_MCP_CLIENT_ID ||
      !config.CMS_MCP_REDIRECT_URIS
    )
      throw new Error(
        "MCP requires CMS_PUBLIC_ORIGIN, a predefined public client ID and exact redirect URI allowlist",
      );
    const redirects = config.CMS_MCP_REDIRECT_URIS.split(",");
    if (
      redirects.length > 10 ||
      redirects.some((uri) => {
        try {
          const parsed = new URL(uri);
          return (
            parsed.protocol !== "https:" ||
            !!parsed.username ||
            !!parsed.password ||
            !!parsed.hash ||
            uri.includes("*") ||
            parsed.href !== uri
          );
        } catch {
          return true;
        }
      })
    )
      throw new Error(
        "MCP redirect URIs must be exact HTTPS URLs without credentials, fragments or wildcards",
      );
  }
  return config;
}
