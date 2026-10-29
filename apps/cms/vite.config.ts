import { defineConfig, type Plugin, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Local development/preview bridge only. Production origins/auth remain a host concern.
const site = new URL(process.env.CMS_SITE_ORIGIN || 'http://127.0.0.1:4384');
const target = new URL(process.env.API_PROXY_TARGET || 'http://127.0.0.1:4382');
const canonical = new URL(process.env.API_CANONICAL_ORIGIN || 'http://127.0.0.1:4382');
for (const url of [site, target, canonical]) {
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Frontend proxy settings must be plain HTTP(S) origins without credentials.');
}
const proxyPattern = '^/(?:v1|health)(?:/|\\?|$)';
const apiPath = new RegExp(proxyPattern);
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
function guard(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const rawUrl = req.url || '/';
  // Match the same raw URL as Vite's proxy, before any URL normalization.
  if (!apiPath.test(rawUrl)) return next();
  const origin = req.headers.origin;
  const allowed =
    (!origin || origin === site.origin) &&
    (safeMethods.has(req.method || '') || origin === site.origin) &&
    req.headers['sec-fetch-site'] !== 'cross-site';
  if (!allowed) {
    res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        code: 'FORBIDDEN',
        message: 'Request origin does not match this local frontend.',
      }),
    );
    return;
  }
  const pathname = new URL(rawUrl, site).pathname;
  const rawPath = rawUrl.split('?')[0];
  if (
    !/^\/(?:v1|health)(?:\/|$)/.test(pathname) ||
    /(?:^|\/)\.{1,2}(?:\/|$)|%2e|%2f|%5c|\\/i.test(rawPath)
  ) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ code: 'INVALID_REQUEST', message: 'Noncanonical API path.' }));
    return;
  }
  next();
}
function originBoundary(): Plugin {
  return {
    name: 'cms-local-api-boundary',
    configureServer(server) {
      server.middlewares.use(guard);
    },
    configurePreviewServer(server) {
      server.middlewares.use(guard);
    },
  };
}
const proxy: Record<string, ProxyOptions> = {
  [proxyPattern]: {
    target: target.origin,
    changeOrigin: false,
    ws: false,
    configure(server) {
      server.on('proxyReq', (outgoing, incoming) => {
        // Validation above precedes forwarding. Never mutate the incoming request.
        if (incoming.headers.origin) outgoing.setHeader('Origin', canonical.origin);
      });
    },
  },
};
export default defineConfig({
  plugins: [originBoundary(), react()],
  resolve: {
    alias: { '@workbench': fileURLToPath(new URL('../web/src', import.meta.url)) },
    dedupe: [
      'react',
      'react-dom',
      'react-router-dom',
      '@tanstack/react-query',
      '@radix-ui/react-dialog',
      'zod',
      'react-hook-form',
      '@hookform/resolvers',
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 4384,
    strictPort: true,
    fs: {
      allow: [
        fileURLToPath(new URL('.', import.meta.url)),
        fileURLToPath(new URL('../web/src', import.meta.url)),
        fileURLToPath(new URL('../web/styles.css', import.meta.url)),
        fileURLToPath(new URL('../web/node_modules', import.meta.url)),
      ],
    },
    proxy,
  },
  preview: { host: '127.0.0.1', port: 4384, strictPort: true, proxy },
  build: { outDir: 'dist', sourcemap: true },
});
