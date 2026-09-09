FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY vendor ./vendor
COPY apps/api/package*.json ./apps/api/
RUN cd apps/api && npm ci
COPY apps/web/package*.json ./apps/web/
RUN cd apps/web && npm ci
COPY apps/api ./apps/api
COPY apps/web ./apps/web
RUN cd apps/api && npm run build && npm prune --omit=dev
RUN cd apps/web && npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 WEB_DIST=/app/apps/web/dist
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/migrations ./apps/api/migrations
COPY --from=build --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 CMD node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","apps/api/dist/main.js"]
