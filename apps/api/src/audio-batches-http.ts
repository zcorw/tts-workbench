import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { rateLimit } from "express-rate-limit";
import { ApiError } from "./errors.js";
import type { AudioBatchService } from "./audio-batches.js";

export function createAudioBatchRouter(batches: AudioBatchService) {
  const router = Router();
  const owner = (req: Request) => {
    const account = (req as Request & { account?: { id: string } }).account;
    if (!account) throw new ApiError(401, "UNAUTHENTICATED");
    return account.id;
  };
  const json =
    (fn: (req: Request) => Promise<unknown>, status = 200) =>
    (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve()
        .then(() => fn(req))
        .then((body) => res.status(status).json(body))
        .catch(next);
    };
  router.use(
    rateLimit({
      skip: (req) => req.method !== "POST",
      windowMs: 60000,
      limit: 20,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: (req) => owner(req),
      handler: (_req, _res, next) => next(new ApiError(429, "RATE_LIMITED")),
    }),
  );
  router.post(
    "/",
    json((req) => batches.create(owner(req), req.body), 202),
  );
  router.get(
    "/",
    json((req) => batches.list(owner(req))),
  );
  router.get(
    "/:id",
    json((req) => batches.get(owner(req), String(req.params.id))),
  );
  router.post(
    "/:id/cancel",
    json((req) => batches.cancel(owner(req), String(req.params.id), req.body)),
  );
  return router;
}
