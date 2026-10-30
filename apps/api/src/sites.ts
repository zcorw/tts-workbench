import { accessSync, constants } from "node:fs";
import { resolve, extname, sep } from "node:path";
import { createServer, type Server, type IncomingMessage } from "node:http";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import type { Config } from "./config.js";
import { ApiError } from "./errors.js";

// The marker is set only by the CMS listener. Host and forwarded headers cannot
// change which static site or Origin policy a request is allowed to use.
export function createSites(config: Config) {
  const cmsRequests = new WeakSet<IncomingMessage>();
  const cmsRoot = config.CMS_DIST ? resolve(config.CMS_DIST) : undefined;
  if (cmsRoot) accessSync(resolve(cmsRoot, "index.html"), constants.R_OK);
  const workbenchRoot = config.WEB_DIST ? resolve(config.WEB_DIST) : undefined;
  const origin = (req: IncomingMessage) =>
    cmsRequests.has(req) ? config.CMS_PUBLIC_ORIGIN : config.PUBLIC_ORIGIN;
  const isCms = (req: IncomingMessage) => cmsRequests.has(req);
  const staticOptions = {
    index: "index.html",
    dotfiles: "deny" as const,
    setHeaders: (res: Response, path: string) => {
      const hashedAsset =
        /[\/]assets[\/][^\/]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|jpe?g|svg|webp|ico)$/.test(
          path.split(sep).join("/"),
        );
      res.setHeader(
        "Cache-Control",
        hashedAsset ? "public, max-age=31536000, immutable" : "no-store",
      );
    },
  };
  const cmsStatic = cmsRoot
    ? express.static(cmsRoot, staticOptions)
    : undefined;
  const webStatic = workbenchRoot
    ? express.static(workbenchRoot, staticOptions)
    : undefined;
  const frontend = (req: Request, res: Response, next: NextFunction) => {
    if (
      req.path === "/site-config.json" &&
      ["GET", "HEAD"].includes(req.method)
    ) {
      res.set("Cache-Control", "no-store").json({
        workbenchUrl: config.PUBLIC_ORIGIN,
        cmsUrl: config.CMS_PUBLIC_ORIGIN ?? null,
      });
      return;
    }
    // Static hosting must never absorb API/health errors, missing assets or maps.
    if (/^\/(?:v1|health)(?:\/|$)/i.test(req.path)) return next();
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(req.path);
    } catch {
      return next(new ApiError(404, "NOT_FOUND"));
    }
    if (/\.map$/i.test(decodedPath))
      return next(new ApiError(404, "NOT_FOUND"));
    const serve = isCms(req) ? cmsStatic : webStatic;
    if (!serve) return next();
    serve(req, res, (error?: unknown) => {
      if (error) return next(new ApiError(404, "NOT_FOUND"));
      if (
        !isCms(req) ||
        !cmsRoot ||
        !["GET", "HEAD"].includes(req.method) ||
        !req.accepts("html") ||
        extname(req.path) ||
        /^\/(?:assets|v1|health)(?:\/|$)/i.test(req.path) ||
        /(?:^|\/)\.[^/]*|%2e|%2f|%5c|\\/i.test(req.path)
      )
        return next();
      res
        .set("Cache-Control", "no-store")
        .sendFile(resolve(cmsRoot, "index.html"), (sendError) => {
          if (sendError) next(new ApiError(404, "NOT_FOUND"));
        });
    });
  };
  const cmsServer = (
    handler: (
      req: IncomingMessage,
      res: import("node:http").ServerResponse,
    ) => void,
  ): Server | undefined =>
    cmsRoot
      ? createServer((req, res) => {
          cmsRequests.add(req);
          handler(req, res);
        })
      : undefined;
  return { origin, isCms, frontend, cmsServer };
}

export function listenHttp(server: Server, port: number, host: string) {
  return new Promise<void>((resolveListen, reject) => {
    const failed = (error: Error) => {
      server.off("listening", listening);
      reject(error);
    };
    const listening = () => {
      server.off("error", failed);
      resolveListen();
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen(port, host);
  });
}
export function closeHttp(server?: Server): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((done, reject) => {
    // Finish normal in-flight requests, then terminate a stalled client so a
    // shutdown cannot hold the process and database pool indefinitely.
    const timeout = setTimeout(() => server.closeAllConnections(), 10000);
    timeout.unref();
    server.close((error) => {
      clearTimeout(timeout);
      error ? reject(error) : done();
    });
  });
}
