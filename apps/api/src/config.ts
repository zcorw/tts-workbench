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
  return config;
}
