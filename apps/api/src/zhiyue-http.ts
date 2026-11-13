import express, { Router, type Request, type Response, type NextFunction } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { CmsService } from "./cms.js";
import { ApiError } from "./errors.js";
import { ZhiyueDeviceService, ZhiyueGrantError } from "./zhiyue-device.js";

const uuid = z.string().uuid();
const opaque = z.string().regex(/^[a-zA-Z0-9_-]{32,128}$/);
const userCode = z.string().max(24).transform((value) =>
  value.toUpperCase().replace(/[\s-]/g, ""),
).pipe(z.string().regex(/^[A-Z0-9]{8}$/));
const jsonInput = express.json({ limit: 1024, strict: true });

function route(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve().then(() => fn(req, res)).catch((error) => {
      if (error instanceof ZhiyueGrantError) {
        res.status(error.status).json({ error: error.error });
      } else {
        next(error);
      }
    });
  };
}

function limit(max: number) {
  return rateLimit({
    windowMs: 60_000,
    limit: max,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => res.set("Retry-After", "60").status(429).json({
      error: "slow_down", code: "RATE_LIMITED", message: "RATE_LIMITED",
    }),
  });
}

function bearer(req: Request) {
  const match = /^Bearer ([a-zA-Z0-9_-]{32,128})$/i.exec(req.get("Authorization") ?? "");
  if (!match) throw new ApiError(401, "UNAUTHENTICATED");
  return match[1];
}

type Release = { articleId: string; id: string; title: string; createdAt: string; text: string; audio: unknown };
function listItem(release: Release) {
  return {
    id: release.articleId,
    title: release.title,
    publishedAt: release.createdAt,
    hasAudio: Boolean(release.audio),
  };
}

export function byteRange(value: string, length: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || length <= 0) return null;
  const first = match[1] === "" ? null : Number(match[1]);
  const last = match[2] === "" ? null : Number(match[2]);
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  if (first === null) return last ? { start: Math.max(0, length - last), end: length - 1 } : null;
  if (first >= length || (last !== null && last < first)) return null;
  return { start: first, end: Math.min(last ?? length - 1, length - 1) };
}

export function createZhiyueDeviceRouter(
  devices: ZhiyueDeviceService, cms: CmsService, origin: string,
  isCms: (req: Request) => boolean,
) {
  const router = Router();
  const identify = (req: Request) => devices.identify(bearer(req));
  const requireJson = (req: Request, _res: Response, next: NextFunction) => {
    if (!req.is("application/json")) return next(new ApiError(415, "UNSUPPORTED_MEDIA_TYPE"));
    return jsonInput(req, _res, next);
  };

  // 设备端路由完全使用设备凭据，不能从浏览器 Cookie 获得授权。
  router.use((req, res, next) => {
    if (!/^\/(?:device|read|media)(?:\/|$)/i.test(req.path)) return next("router");
    if (!isCms(req)) return next(new ApiError(404, "NOT_FOUND"));
    res.set("Referrer-Policy", "no-referrer");
    next();
  });
  router.post("/device/authorize", limit(12), requireJson, route(async (req, res) => {
    z.strictObject({}).parse(req.body);
    res.status(201).json({ ...await devices.start(), verification_uri: `${origin}/connections/zhiyue` });
  }));
  router.post("/device/token", limit(60), requireJson, route(async (req, res) => {
    const { device_code } = z.strictObject({ device_code: opaque }).parse(req.body);
    res.json(await devices.claim(device_code));
  }));
  router.post("/device/confirm", limit(60), requireJson, route(async (req, res) => {
    const { refresh_token } = z.strictObject({ refresh_token: opaque }).parse(req.body);
    await devices.confirm(refresh_token);
    res.status(204).end();
  }));
  router.post("/device/refresh", limit(60), requireJson, route(async (req, res) => {
    const { refresh_token } = z.strictObject({ refresh_token: opaque }).parse(req.body);
    res.json(await devices.renew(refresh_token));
  }));
  router.post("/device/upgrade", limit(60), requireJson, route(async (req, res) => {
    z.strictObject({}).parse(req.body);
    res.json(await devices.renew(bearer(req), true));
  }));
  router.delete("/device/binding", limit(20), route(async (req, res) => {
    const binding = await devices.identify(bearer(req), true);
    await devices.revoke(binding.accountId, binding.id);
    res.status(204).end();
  }));
  router.get("/read/articles", limit(120), route(async (req, res) => {
    const binding = await identify(req);
    const query = z.strictObject({
      limit: z.string().regex(/^\d{1,2}$/).transform(Number).pipe(z.number().int().min(1).max(20)).optional(),
      offset: z.string().regex(/^\d{1,7}$/).transform(Number).optional(),
    }).parse(req.query);
    const page = await cms.readArticles({ owner: binding.accountId, categoryIds: [] }, {
      limit: query.limit ?? 12, offset: query.offset ?? 0,
    });
    res.json({ items: page.items.map(listItem), total: page.total, limit: page.limit, offset: page.offset });
  }));
  router.get("/read/articles/:id", limit(120), route(async (req, res) => {
    const binding = await identify(req);
    const release: Release = await cms.readArticle({ owner: binding.accountId, categoryIds: [] }, uuid.parse(req.params.id));
    res.json({ ...listItem(release), releaseId: release.id, text: release.text });
  }));
  router.post("/read/releases/:id/audio-ticket", limit(20), requireJson, route(async (req, res) => {
    z.strictObject({}).parse(req.body);
    const binding = await identify(req);
    const releaseId = uuid.parse(req.params.id);
    await cms.assertReadAudio({ owner: binding.accountId, categoryIds: [] }, releaseId);
    const { ticket, expires_in } = await devices.issueMedia(binding.id, releaseId);
    res.json({ url: `${origin}/v1/zhiyue/media/${ticket}`, expires_in });
  }));
  router.get("/media/:ticket", limit(60), route(async (req, res) => {
    const { accountId, releaseId } = await devices.identifyMedia(opaque.parse(req.params.ticket));
    const identity = { owner: accountId, categoryIds: [] };
    const rangeHeader = req.get("Range");
    res.set({ "Content-Type": "audio/mpeg", "Accept-Ranges": "bytes" });
    if (rangeHeader || req.method === "HEAD") {
      const length = await cms.readAudioLength(identity, releaseId);
      const range = rangeHeader ? byteRange(rangeHeader, length) : null;
      if (rangeHeader && !range) {
        res.set("Content-Range", `bytes */${length}`).status(416).end();
        return;
      }
      if (range) {
        res.set("Content-Range", `bytes ${range.start}-${range.end}/${length}`).status(206);
      }
      if (req.method === "HEAD") {
        res.set("Content-Length", String(range ? range.end - range.start + 1 : length)).end();
        return;
      }
      if (range) res.send(await cms.readAudioSlice(identity, releaseId, range));
      return;
    }
    res.send((await cms.readAudio(identity, releaseId)).data);
  }));
  return router;
}

export function createZhiyueAccountRouter(
  devices: ZhiyueDeviceService, sessionAccountId: (req: Request) => string,
  isCms: (req: Request) => boolean,
) {
  const router = Router();
  const account = (req: Request, expected: unknown) => {
    if (!isCms(req)) throw new ApiError(404, "NOT_FOUND");
    const id = sessionAccountId(req);
    if (uuid.parse(expected) !== id) throw new ApiError(409, "ACCOUNT_CHANGED");
    return id;
  };
  router.get("/bindings", limit(60), route(async (req, res) => {
    res.json(await devices.list(account(req, req.query.expected_account_id)));
  }));
  router.post("/approve", limit(12), route(async (req, res) => {
    const input = z.strictObject({ user_code: userCode, expected_account_id: uuid }).parse(req.body);
    try {
      await devices.approve(account(req, input.expected_account_id), input.user_code);
    } catch (error) {
      if (error instanceof ZhiyueGrantError) {
        throw new ApiError(error.status, error.error === "invalid_grant" ? "INVALID_OR_EXPIRED_CODE" : error.error.toUpperCase());
      }
      throw error;
    }
    res.status(204).end();
  }));
  router.delete("/bindings/:id", limit(20), route(async (req, res) => {
    await devices.revoke(account(req, req.query.expected_account_id), uuid.parse(req.params.id));
    res.status(204).end();
  }));
  return router;
}
