import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Req,
  Res,
  Body,
  Inject,
  Module,
  Catch,
  HttpException,
  type ExceptionFilter,
  type ArgumentsHost,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { Pool } from "pg";
import { csrfSync } from "csrf-sync";
import { rateLimit } from "express-rate-limit";
import { ZodError } from "zod";
import {
  AccountService,
  AccountModule,
  AccountError,
  argon2Passwords,
  type Account,
} from "@tts-workbench/account-core";
import { PostgresAccountRepository } from "@tts-workbench/account-postgres";
import {
  createAccountSession,
  resolveAccountSession,
} from "@tts-workbench/account-postgres/session";
import type { Config } from "./config.js";
import { ApiError } from "./errors.js";
import { VocabularyService } from "./vocabulary.js";
import { SpeechService } from "./speech.js";
import { ArticleService } from "./articles.js";
import { GatewayError } from "tts-gateway";
interface ApiRequest extends Request {
  requestId: string;
  account?: Account;
}
export const STATE = Symbol("APP_STATE");
export interface State {
  pool: Pool;
  config: Config;
  csrf: ReturnType<typeof csrfSync>;
  vocabulary: VocabularyService;
  speech: SpeechService;
  articles: ArticleService;
}
export function sendError(error: unknown, req: Request, res: Response) {
  let status = 503,
    code = "DEPENDENCY_UNAVAILABLE";
  if (error instanceof ApiError) {
    status = error.status;
    code = error.code;
  } else if (error instanceof GatewayError) {
    const category = error.category;
    status =
      category === "CLIENT_FORBIDDEN"
        ? 403
        : category === "PROVIDER_TIMEOUT"
          ? 504
          : ["RESOURCE_EXHAUSTED", "PROVIDER_RATE_LIMITED"].includes(category)
            ? 429
            : ["PROVIDER_UNAVAILABLE", "PROVIDER_AUTH_FAILED"].includes(
                  category,
                )
              ? 503
              : ["SYNTHESIS_FAILED", "INTERNAL_ERROR"].includes(category)
                ? 502
                : 400;
    code =
      status === 504
        ? "TTS_TIMEOUT"
        : status === 502
          ? "TTS_PROVIDER_ERROR"
          : status === 503
            ? "TTS_UNAVAILABLE"
            : status === 429
              ? "RATE_LIMITED"
              : status === 403
                ? "FORBIDDEN"
                : "INVALID_REQUEST";
  } else if (error instanceof AccountError) {
    status =
      error.code === "ALREADY_EXISTS"
        ? 409
        : error.code === "INVALID_CREDENTIALS"
          ? 401
          : error.code === "NOT_FOUND"
            ? 404
            : 400;
    code =
      status === 401
        ? "UNAUTHENTICATED"
        : status === 400
          ? "INVALID_REQUEST"
          : error.code;
  } else if (error instanceof HttpException) {
    status = error.getStatus();
    code = status === 404 ? "NOT_FOUND" : "INVALID_REQUEST";
  } else if (error instanceof ZodError) {
    status = 400;
    code = "INVALID_REQUEST";
  } else if ((error as any)?.code === "EBADCSRFTOKEN") {
    status = 403;
    code = "CSRF_INVALID";
  } else if ((error as any)?.type === "entity.too.large") {
    status = 413;
    code = "PAYLOAD_TOO_LARGE";
  } else if (error instanceof SyntaxError) {
    status = 400;
    code = "INVALID_REQUEST";
  }
  if (status === 429) res.set("Retry-After", "60");
  res.status(status).json({
    code,
    message: code,
    requestId: (req as ApiRequest).requestId ?? randomUUID(),
  });
}
@Catch()
class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    sendError(
      error,
      host.switchToHttp().getRequest(),
      host.switchToHttp().getResponse(),
    );
  }
}
export function requireAccount(req: Request): Account {
  const a = (req as ApiRequest).account;
  if (!a) throw new ApiError(401, "UNAUTHENTICATED");
  return a;
}
const save = (req: Request) =>
  new Promise<void>((ok, no) => req.session.save((e) => (e ? no(e) : ok())));
@Controller()
class AuthController {
  constructor(
    @Inject(STATE) private state: State,
    private accounts: AccountService,
  ) {}
  @Get("v1/config") config() {
    return {
      registrationEnabled: this.state.config.REGISTRATION_ENABLED,
      language: "ja-JP",
      maxVocabularyEntries: 500,
      maxInputCodePoints: 10000,
      maxInputBytes: 49152,
      maxArticles: this.state.articles.maxArticles,
    };
  }
  @Get("v1/auth/csrf") async csrf(@Req() req: Request) {
    const csrfToken = this.state.csrf.generateToken(req);
    await save(req);
    return {
      csrfToken,
      expiresAt: new Date(req.session.csrfIssuedAt! + 3600000).toISOString(),
    };
  }
  @Post("v1/auth/register") async register(@Body() body: unknown) {
    if (!this.state.config.REGISTRATION_ENABLED)
      throw new ApiError(403, "REGISTRATION_DISABLED");
    return this.accounts.createAccount(body);
  }
  @Post("v1/auth/login") async login(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ) {
    const account = await this.accounts.authenticateCredentials(body);
    await new Promise<void>((ok, no) =>
      req.session.regenerate((e) => (e ? no(e) : ok())),
    );
    req.session.accountId = account.id;
    req.session.absoluteExpiresAt = Date.now() + 7 * 86400000;
    await save(req);
    res.status(200).json(account);
  }
  @Post("v1/auth/logout") async logout(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await new Promise<void>((ok, no) =>
      req.session.destroy((e) => (e ? no(e) : ok())),
    );
    res.clearCookie("wb_session", { path: "/" }).status(204).end();
  }
  @Get("v1/auth/me") me(@Req() req: Request) {
    return requireAccount(req);
  }
  @Patch("v1/auth/me") update(@Req() req: Request, @Body() body: unknown) {
    return this.accounts.updateDisplayName(requireAccount(req).id, body);
  }
  @Get("v1/vocabulary") list(@Req() req: Request, @Query() query: unknown) {
    return this.state.vocabulary.list(requireAccount(req).id, query);
  }
  @Get("v1/vocabulary/:id") getEntry(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return this.state.vocabulary.get(requireAccount(req).id, id);
  }
  @Post("v1/vocabulary") createEntry(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    return this.state.vocabulary.create(requireAccount(req).id, body);
  }
  @Patch("v1/vocabulary/:id") updateEntry(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.state.vocabulary.update(requireAccount(req).id, id, body);
  }
  @Delete("v1/vocabulary/:id") async removeEntry(
    @Req() req: Request,
    @Res() res: Response,
    @Param("id") id: string,
    @Query("expectedRevision") revision: unknown,
  ) {
    const result = await this.state.vocabulary.remove(
      requireAccount(req).id,
      id,
      revision,
    );
    res
      .set("X-Pronunciation-Version", String(result.internalVersion))
      .status(204)
      .end();
  }
  @Get("v1/articles") listArticles(
    @Req() req: Request,
    @Query() query: unknown,
  ) {
    return this.state.articles.list(requireAccount(req).id, query);
  }
  @Post("v1/articles") createArticle(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    return this.state.articles.create(requireAccount(req).id, body);
  }
  @Get("v1/articles/:id") getArticle(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return this.state.articles.get(requireAccount(req).id, id);
  }
  @Patch("v1/articles/:id") updateArticle(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.state.articles.update(requireAccount(req).id, id, body);
  }
  @Delete("v1/articles/:id") async deleteArticle(
    @Req() req: Request,
    @Param("id") id: string,
    @Query("expectedRevision") revision: unknown,
    @Res() res: Response,
  ) {
    await this.state.articles.remove(requireAccount(req).id, id, revision);
    res.status(204).end();
  }
  @Post("v1/articles/:id/audio") async generateArticleAudio(
    @Req() req: Request,
    @Res() res: Response,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const owner = requireAccount(req).id;
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort("client");
    };
    res.on("close", cancel);
    try {
      const result = await this.state.articles.generate(
        owner,
        id,
        body,
        this.state.speech,
        controller.signal,
        (req as ApiRequest).requestId,
      );
      res.status(200).json(result);
    } finally {
      res.off("close", cancel);
    }
  }
  @Get("v1/articles/:id/audio") async getArticleAudio(
    @Req() req: Request,
    @Res() res: Response,
    @Param("id") id: string,
    @Query() query: unknown,
  ) {
    const result = await this.state.articles.audio(
      requireAccount(req).id,
      id,
      query,
    );
    res
      .set({
        "Content-Type": "audio/mpeg",
        "Content-Length": String(result.data.length),
        "Content-Disposition": `inline; filename="${result.metadata.filename}"`,
        "X-Pronunciation-Version": String(result.metadata.ruleVersion),
        "X-Audio-Id": result.metadata.audioId,
        "X-Article-Content-Revision": String(result.metadata.contentRevision),
      })
      .status(200)
      .send(result.data);
  }
  @Get("v1/voices") voices(@Req() req: Request) {
    return this.state.speech.voices(requireAccount(req).id);
  }
  private async audio(
    req: Request,
    res: Response,
    body: unknown,
    preview: boolean,
  ) {
    const account = requireAccount(req),
      controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort("client");
    };
    res.on("close", cancel);
    try {
      const result = await this.state.speech.synthesize(
        account.id,
        body,
        preview,
        controller.signal,
        (req as ApiRequest).requestId,
      );
      res
        .set({
          "Content-Type": "audio/mpeg",
          "Content-Length": String(result.audio.length),
          "Content-Disposition": 'inline; filename="speech.mp3"',
          "X-Pronunciation-Version": String(result.internalVersion),
        })
        .status(200)
        .send(result.audio);
    } finally {
      res.off("close", cancel);
    }
  }
  @Post("v1/audio/speech") speech(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ) {
    return this.audio(req, res, body, false);
  }
  @Post("v1/audio/preview") preview(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ) {
    return this.audio(req, res, body, true);
  }
  @Get("health/live") live() {
    return { status: "ok" };
  }
  @Get("health/ready") async ready() {
    await this.state.pool.query("SELECT 1");
    if (!this.state.speech.ready())
      throw new ApiError(503, "DEPENDENCY_UNAVAILABLE");
    return { status: "ok" };
  }
}
export async function createApplication(config: Config) {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  const sessions = createAccountSession({
    pool,
    secret: config.SESSION_SECRET,
    secure: config.NODE_ENV === "production",
  });
  const csrf = csrfSync({
    getTokenFromRequest: (req) => req.get("X-CSRF-Token"),
    getTokenFromState: (req) =>
      req.session.csrfIssuedAt &&
      Date.now() - req.session.csrfIssuedAt < 3600000
        ? req.session.csrfToken
        : undefined,
    storeTokenInState: (req, token) => {
      req.session.csrfToken = token ?? undefined;
      req.session.csrfIssuedAt = Date.now();
    },
  });
  const vocabulary = new VocabularyService(pool),
    speech = new SpeechService(vocabulary);
  try {
    await speech.initialize(config);
  } catch (e) {
    sessions.store.close();
    await pool.end();
    throw e;
  }
  const articles = new ArticleService(pool, config.MAX_ARTICLES ?? 100);
  const state: State = { pool, config, csrf, vocabulary, speech, articles };
  @Module({
    imports: [
      AccountModule.registerAsync({
        useFactory: () => ({
          repository: new PostgresAccountRepository(pool),
          passwords: argon2Passwords,
          randomId: randomUUID,
        }),
      }),
    ],
    controllers: [AuthController],
    providers: [{ provide: STATE, useValue: state }],
  })
  class AppModule {}
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: false,
  });
  const server = app.getHttpAdapter().getInstance();
  server.disable("x-powered-by");
  server.set("trust proxy", config.TRUST_PROXY.split(",").filter(Boolean));
  server.use((req: ApiRequest, res: Response, next: NextFunction) => {
    req.requestId = randomUUID();
    res.set({ "X-Request-Id": req.requestId, "Cache-Control": "no-store" });
    next();
  });
  server.use((req: Request, res: Response, next: NextFunction) => {
    if (
      /^\/v1(?:\/|$)/i.test(req.path) &&
      ((req.get("Origin") && req.get("Origin") !== config.PUBLIC_ORIGIN) ||
        (!["GET", "HEAD", "OPTIONS"].includes(req.method) &&
          req.get("Origin") !== config.PUBLIC_ORIGIN))
    )
      return sendError(new ApiError(403, "FORBIDDEN"), req, res);
    if (
      ["POST", "PATCH"].includes(req.method) &&
      req.path !== "/v1/auth/logout" &&
      !req.is("application/json")
    )
      return sendError(new ApiError(415, "UNSUPPORTED_MEDIA_TYPE"), req, res);
    next();
  });
  server.use(
    "/v1/auth",
    rateLimit({
      windowMs: 60000,
      limit: 60,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (req, res) =>
        sendError(new ApiError(429, "RATE_LIMITED"), req, res),
    }),
  );
  if (config.WEB_DIST)
    server.use(
      express.static(config.WEB_DIST, {
        index: "index.html",
        dotfiles: "deny",
      }),
    );
  server.use(express.json({ limit: 65536, strict: true }));
  server.use(sessions.middleware);
  server.use((req: Request, res: Response, next: NextFunction) => {
    resolveAccountSession(req, app.get(AccountService))
      .then((a) => {
        (req as ApiRequest).account = a;
        if (!req.session) return sessions.middleware(req, res, next);
        next();
      })
      .catch((e) => sendError(e, req, res));
  });
  server.use("/v1", csrf.csrfSynchronisedProtection);
  server.use(
    rateLimit({
      skip: (req) =>
        req.method !== "POST" ||
        !/^\/v1\/(?:audio\/(?:speech|preview)|articles\/[^/]+\/audio)\/?$/i.test(
          req.path,
        ),
      windowMs: 60000,
      limit: 10,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: (req) => requireAccount(req).id,
      handler: (req, res) =>
        sendError(new ApiError(429, "RATE_LIMITED"), req, res),
    }),
  );
  server.use(
    (error: unknown, req: Request, res: Response, _next: NextFunction) =>
      sendError(error, req, res),
  );
  app.useGlobalFilters(new ErrorFilter());
  await app.init();
  return {
    app,
    pool,
    state,
    close: async () => {
      await app.close();
      await speech.close();
      sessions.store.close();
      await pool.end();
    },
  };
}
