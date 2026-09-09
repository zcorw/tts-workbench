import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import {
  createTtsRuntime,
  createDefaultTtsConfig,
  type DictionaryReader,
  type DictionarySnapshot,
  type TtsRuntime,
  type ActorContext,
} from "tts-gateway";
import { ApiError } from "./errors.js";
import { VocabularyService, term } from "./vocabulary.js";
import type { Config } from "./config.js";
const speed = z
  .number()
  .min(0.5)
  .max(2)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8)
  .default(1);
const speechSchema = z.strictObject({
  input: z
    .string()
    .refine(
      (s) =>
        s.trim().length > 0 &&
        [...s].length <= 10000 &&
        Buffer.byteLength(s) <= 49152 &&
        !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(s),
    ),
  voice: z.string().min(1),
  speed,
  language: z.literal("ja-JP").default("ja-JP"),
  inputType: z.literal("text").default("text"),
  format: z.literal("mp3").default("mp3"),
});
const previewSchema = z.strictObject({
  text: term,
  reading: term,
  voice: z.string().min(1),
  speed,
});
export class SpeechService {
  private context = new AsyncLocalStorage<{
    owner: string;
    snapshot: DictionarySnapshot;
  }>();
  private runtime?: TtsRuntime;
  constructor(private vocabulary: VocabularyService) {}
  async initialize(config: Config) {
    if (!config.TTS_AZURE_SPEECH_KEY && !config.TTS_AZURE_JA_VOICE_ID) return;
    if (!config.TTS_AZURE_SPEECH_KEY || !config.TTS_AZURE_JA_VOICE_ID)
      throw new Error("Both Japanese Azure voice and key must be configured");
    const defaults = createDefaultTtsConfig(config.NODE_ENV);
    const options = {
      id: "azure-ja-basic/v1",
      version: 1,
      type: "object",
      additionalProperties: false,
      maxProperties: 0,
      properties: {},
    };
    const runtimeConfig = {
      ...defaults,
      productionApproved: config.TTS_PRODUCTION_APPROVED,
      dataPolicyApprovalRef: config.TTS_DATA_POLICY_REF ?? null,
      providers: [
        {
          ...defaults.providers[0],
          enabled: true,
          enabledIn: [config.NODE_ENV],
        },
      ],
      voices: [
        {
          alias: "ja-jp-primary",
          adapterId: "azure-speech" as const,
          providerVoiceId: config.TTS_AZURE_JA_VOICE_ID,
          publicLanguage: "ja-JP" as const,
          optionSchemaId: options.id,
        },
      ],
      providerLexicons: [],
      optionSchemas: { [options.id]: options },
    };
    const reader: DictionaryReader = {
      readAuthorizedSnapshots: async (actor, ids, signal) => {
        const value = this.context.getStore();
        if (signal.aborted) throw new ApiError(400, "INVALID_REQUEST");
        if (
          !value ||
          actor.actorId !== value.owner ||
          actor.tenantId !== value.owner ||
          ids.length !== 1 ||
          ids[0] !== value.owner
        )
          return { ok: false, reason: "forbidden" };
        return { ok: true, snapshots: [value.snapshot] };
      },
    };
    this.runtime = await createTtsRuntime(
      runtimeConfig,
      { TTS_AZURE_SPEECH_KEY: config.TTS_AZURE_SPEECH_KEY },
      undefined,
      { dictionaries: reader, ownsObservability: false },
    );
    if (this.runtime.health.readiness().status !== "ok") {
      await this.runtime.close();
      this.runtime = undefined;
      throw new Error("TTS configuration is not ready");
    }
  }
  actor(owner: string): ActorContext {
    return {
      actorId: owner,
      tenantId: owner,
      permissions: [
        "tts:synthesize",
        "tts:dictionary:use",
        "tts:voices:read",
        "tts:voice:use:ja-jp-primary",
      ],
    };
  }
  voices(owner: string) {
    return {
      items: this.runtime
        ? this.runtime.catalog
            .list(this.actor(owner))
            .map((v) => ({
              id: v.alias,
              name: "日本語",
              language: "ja-JP" as const,
              provider: "azure-speech" as const,
            }))
        : [],
    };
  }
  ready() {
    return !this.runtime || this.runtime.health.readiness().status === "ok";
  }
  async synthesize(
    owner: string,
    input: unknown,
    preview: boolean,
    signal: AbortSignal,
    requestId: string,
  ) {
    const draft = preview ? previewSchema.parse(input) : undefined;
    const dto = speechSchema.parse(
      draft
        ? { input: draft.text, voice: draft.voice, speed: draft.speed }
        : input,
    );
    if (!this.runtime) throw new ApiError(503, "TTS_UNAVAILABLE");
    if (!this.voices(owner).items.some((v) => v.id === dto.voice))
      throw new ApiError(400, "INVALID_REQUEST");
    const page = await this.vocabulary.list(owner, { limit: 500 });
    const entries = draft
      ? [{ id: "preview", text: draft.text, reading: draft.reading }]
      : page.items;
    const snapshot: DictionarySnapshot = Object.freeze({
      schemaVersion: "tts.dictionary.snapshot/v1",
      dictionaryId: owner,
      version: page.internalVersion,
      language: "ja-JP",
      rules: Object.freeze(
        entries.map((e) =>
          Object.freeze({
            ruleId: e.id,
            match: e.text,
            matchMode: "literal" as const,
            caseSensitive: true,
            type: "alias" as const,
            alias: e.reading,
          }),
        ),
      ),
    });
    return this.context.run({ owner, snapshot }, async () => {
      const result = await this.runtime!.synthesis.synthesize(
        { ...dto, dictionaryIds: [owner] },
        this.actor(owner),
        { signal, requestId },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      if (result.data instanceof Uint8Array) {
        chunks.push(Buffer.from(result.data));
        size = result.data.byteLength;
      } else
        for await (const chunk of result.data) {
          const data = Buffer.from(chunk);
          size += data.length;
          if (size > 8388608) {
            result.data.destroy();
            throw new ApiError(502, "TTS_PROVIDER_ERROR");
          }
          chunks.push(data);
        }
      if (
        !size ||
        size > 8388608 ||
        (result.contentLength !== undefined && result.contentLength !== size)
      )
        throw new ApiError(502, "TTS_PROVIDER_ERROR");
      const actual = result.dictionaryVersions?.find(
        (v) => v.dictionaryId === owner,
      )?.version;
      if (actual === undefined)
        throw new ApiError(503, "DEPENDENCY_UNAVAILABLE");
      return { audio: Buffer.concat(chunks), internalVersion: actual };
    });
  }
  async close() {
    await this.runtime?.close();
  }
}
