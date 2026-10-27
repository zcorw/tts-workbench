import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { rateLimit } from "express-rate-limit";
import { ApiError } from "./errors.js";
import { CmsService, type ReadIdentity } from "./cms.js";

interface CmsRequest extends Request {
  account?: { id: string };
}
export function createCmsRouter(cms: CmsService, origin: string) {
  const router = Router();
  const owner = (req: CmsRequest) => {
    if (!req.account) throw new ApiError(401, "UNAUTHENTICATED");
    return req.account.id;
  };
  const readIdentity = (req: CmsRequest): Promise<ReadIdentity> =>
    cms.readIdentity(req.account?.id, req.get("Authorization"));
  type Handler = (req: CmsRequest, res: Response) => Promise<unknown>;
  const route =
    (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve()
        .then(() => fn(req, res))
        .catch(next);
    };
  const json = (fn: (req: CmsRequest) => Promise<unknown>, status = 200) =>
    route(async (req, res) => {
      res.status(status).json(await fn(req));
    });
  const empty = (fn: (req: CmsRequest) => Promise<unknown>) =>
    route(async (req, res) => {
      await fn(req);
      res.status(204).end();
    });
  const param = (req: CmsRequest, name: string) => String(req.params[name]);
  const audio = (
    res: Response,
    result: { metadata: Record<string, unknown>; data: Buffer },
  ) => {
    const filename = result.metadata.filename;
    if (
      typeof filename !== "string" ||
      !/^article-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp3$/i.test(
        filename,
      )
    )
      throw new ApiError(503, "DEPENDENCY_UNAVAILABLE");
    return res
      .set({
        "Content-Type": "audio/mpeg",
        "Content-Length": String(result.data.length),
        "Content-Disposition": `inline; filename="${filename}"`,
        "X-Audio-Id": String(result.metadata.audioId),
        "X-Pronunciation-Version": String(result.metadata.ruleVersion),
        "X-Article-Content-Revision": String(result.metadata.contentRevision),
      })
      .status(200)
      .send(result.data);
  };

  router.use(
    "/read",
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_req, _res, next) => next(new ApiError(429, "RATE_LIMITED")),
    }),
  );
  router.get(
    "/read/articles",
    json(async (req) => cms.readArticles(await readIdentity(req), req.query)),
  );
  router.get(
    "/read/categories",
    json(async (req) => cms.readCategories(await readIdentity(req))),
  );
  router.get(
    "/read/articles/:articleId",
    json(async (req) =>
      cms.readArticle(await readIdentity(req), param(req, "articleId")),
    ),
  );
  router.get(
    "/read/releases/:releaseId/audio",
    route(async (req, res) => {
      audio(
        res,
        await cms.readAudio(await readIdentity(req), param(req, "releaseId")),
      );
    }),
  );
  router.get(
    "/read/rss",
    route(async (req, res) => {
      res
        .type("application/rss+xml")
        .send(await cms.rss(await readIdentity(req), origin));
    }),
  );

  router.get(
    "/taxonomy",
    json((req) => cms.taxonomy(owner(req))),
  );
  for (const [path, kind] of [
    ["categories", "category"],
    ["tags", "tag"],
  ] as const) {
    router.post(
      "/" + path,
      json((req) => cms.createTaxonomy(owner(req), kind, req.body), 201),
    );
    router.patch(
      "/" + path + "/:id",
      json((req) =>
        cms.updateTaxonomy(owner(req), kind, param(req, "id"), req.body),
      ),
    );
    router.delete(
      "/" + path + "/:id",
      empty((req) =>
        cms.removeTaxonomy(
          owner(req),
          kind,
          param(req, "id"),
          req.query.expectedRevision,
        ),
      ),
    );
  }
  router.get(
    "/articles",
    json((req) => cms.list(owner(req), req.query)),
  );
  router.post(
    "/articles",
    json((req) => cms.create(owner(req), req.body), 201),
  );
  router.post(
    "/articles/move-category",
    json((req) => cms.moveCategory(owner(req), req.body)),
  );
  router.get(
    "/articles/:id",
    json((req) => cms.get(owner(req), param(req, "id"))),
  );
  router.patch(
    "/articles/:id",
    json((req) => cms.update(owner(req), param(req, "id"), req.body)),
  );
  router.post(
    "/import/preview",
    json((req) => cms.import(owner(req), req.body, true)),
  );
  router.post(
    "/import",
    json((req) => cms.import(owner(req), req.body, false)),
  );
  router.get(
    "/articles/:id/releases",
    json((req) => cms.releases(owner(req), param(req, "id"))),
  );
  router.post(
    "/articles/:id/releases",
    json((req) => cms.publish(owner(req), param(req, "id"), req.body), 201),
  );
  router.get(
    "/articles/:id/releases/:releaseId",
    json((req) =>
      cms.release(owner(req), param(req, "id"), param(req, "releaseId")),
    ),
  );
  router.get(
    "/articles/:id/releases/:releaseId/audio",
    route(async (req, res) => {
      audio(
        res,
        await cms.releaseAudio(
          owner(req),
          param(req, "id"),
          param(req, "releaseId"),
        ),
      );
    }),
  );
  router.delete(
    "/articles/:id/releases/:releaseId",
    empty((req) =>
      cms.removeRelease(
        owner(req),
        param(req, "id"),
        param(req, "releaseId"),
        req.query.expectedCmsRevision,
      ),
    ),
  );
  router.post(
    "/articles/:id/unpublish",
    json((req) => cms.unpublish(owner(req), param(req, "id"), req.body)),
  );
  router.get(
    "/read-tokens",
    json((req) => cms.tokens(owner(req))),
  );
  router.post(
    "/read-tokens",
    json((req) => cms.createToken(owner(req), req.body), 201),
  );
  router.delete(
    "/read-tokens/:id",
    empty((req) => cms.revokeToken(owner(req), param(req, "id"))),
  );
  return router;
}
