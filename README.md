# TTS Workbench

[English](README.md) · [简体中文](README.zh-CN.md)

The standalone CMS is named **Zhisheng (知声)**. [Zhisheng MCP](docs/CMS_MCP.md) supports batch draft creation, category creation and edits to article text, categories and tags, with OAuth/PKCE; category creation and full article updates use durable write receipts. The separate `update_article_body` tool requires `cms:drafts:update` and an article revision, granting access to body-only edits; see [body updates](docs/CMS_MCP.md#修改正文). Existing connections must authorize each new scope. After deployment, refresh client tool metadata and reconnect as needed. MCP is disabled by default; code delivery does not establish production activation or real-client acceptance.

A Japanese speech workbench built with React, NestJS and PostgreSQL. Selecting text to change its pronunciation saves a personal rule for the current and future articles. The original text is preserved; there is no “this occurrence only” flow.

Accounts, Session/CSRF, display names, personal pronunciation CRUD, revision conflicts and Gateway Japanese synthesis are implemented. “My articles” supports search, pagination, creation, opening, editing, saving and deletion. Each article retains its latest title/body and last successful audio, available after refresh or login. See [article management](docs/ARTICLE_MANAGEMENT.md). Without provider configuration, voices are empty and synthesis returns 503. Local protocol tests do not validate real Japanese pronunciation.

Create or open an article in “My articles”, edit it and select “Save article”. “Generate speech” first saves changes and then synthesizes the saved body. Success replaces the previous audio; failure preserves it. Changes to the body, pronunciation rules or speech settings prompt regeneration. Deleting an article also deletes its audio, while personal rules remain. Article and audio history are unavailable.

## VPS deployment

The [VPS deployment guide](docs/VPS_DEPLOYMENT.md) covers uploading source for Docker Compose and building images with GitHub Actions for SSH deployment. It includes environment configuration, Nginx/TLS, the first account, updates/rollback, article/audio backup and recovery, and troubleshooting.

## Create the first login account

**There is no default account or password.** After the first Compose deployment and successful migrations, initialize from Windows with a password of **8–128 characters**:

1. Temporarily add `ACCOUNT_PASSWORD='your initial password'` to the root `.env`, replacing the placeholder.
2. Run `.\rebuild.cmd` so the app container receives it. Note the reported project name and URL.
3. For the default project, run `docker exec tts-workbench-app-1 node apps/api/dist/operations.js create admin "My account"`. `admin` is a replaceable login name, not an administrator role. For a custom project, locate its container using the [full instructions](docs/operations.md#首次部署后的账号初始化).
4. JSON containing `id` and `login` with exit code 0 indicates success. Remove `ACCOUNT_PASSWORD` from `.env`, run `.\rebuild.cmd` again to remove the plaintext environment value, then log in with the account you created.

Create accounts inside the application container. Running the host's `node --env-file=.env ... create` may connect to an old development database. See [account initialization](docs/operations.md#首次部署后的账号初始化) for VPS/GitHub Actions password handling, cleanup checks and common errors.

Runtime baseline: Node.js 22.23.4 and NestJS 12.2.0. See [operations](docs/operations.md#安全版本与依赖覆盖) for dependency overrides and upgrade validation.

## Local entry points

For a Windows Docker Compose rebuild, prepare `.env`, start Docker Desktop and run `.\rebuild.cmd` or double-click `rebuild.cmd`. Use `--no-cache` for an uncached build. Database volumes are retained; the port comes from `APP_HOST_PORT` (default 8080). The script reports the actual URL. See [operations](docs/operations.md#windows-一键重建-docker-compose) for configuration and existing project data.

The documented development page is [the workbench](http://127.0.0.1:4181/), with API at 127.0.0.1:3000; both include articles and latest audio. Vite proxies `/v1` and `/health`. The isolated development environment allows test registration and has no provider configuration. The existing 8080 instance was not rebuilt; a code commit does not update that instance.

```sh
npm ci
npm --prefix apps/api ci
npm --prefix apps/web ci
# Copy .env.example to .env and configure the database, session secret and PUBLIC_ORIGIN.
npm --prefix apps/api run build
# From apps/api: node --env-file=../../.env dist/operations.js migrate
npm --prefix apps/api start
# In another terminal:
npm --prefix apps/web run dev
```

See [operations](docs/operations.md) for running, provisioning accounts, providers and tests. The old HTML prototype and `apps/web/reference` are reference material; port 4180 and browser/local accounts are no longer the supported entry points.

## Azure and AWS TTS

**The workbench currently integrates Azure Japanese voices only. Adding AWS keys does not enable Japanese Polly.** Azure uses `TTS_AZURE_SPEECH_KEY` and `TTS_AZURE_JA_VOICE_ID`, with region fixed to `japaneast`. After editing the root `.env` locally, run `.\rebuild.cmd`; after editing `.env.production` on a VPS, recreate the app container.

See [Azure/AWS configuration](docs/operations.md#azure-与-aws-tts-配置) for resources, voices, applying configuration, a short listening check, AWS credentials/minimal IAM, and outstanding Polly integration. Keep keys in server configuration, outside documents, Git, logs and frontend variables. `PUBLIC_ORIGIN` is the site address and is unrelated to provider credentials.

## Engineering and contracts

- `apps/web`: React, Radix Dialog, React Hook Form/Zod, React Router and TanStack Query.
- `apps/api`: NestJS, Zod, express-session, csrf-sync, PostgreSQL/pg and node-pg-migrate.
- Separate account project: adjacent `nest-account`, providing `account-core`/`account-postgres` 0.1.1 and an optional session adapter.
- Separate Gateway: adjacent `TTS-gateway`, providing library 0.1.1, host injection and ja-JP rules; it fixes floating-point validation of valid two-decimal speeds such as 1.15.
- The application consumes versioned archives in `vendor` and lockfiles, without importing sibling repository source.

The [OpenAPI 1.9.0 contract](docs/openapi.yaml) has 82 operations covering batch audio, Zhisheng MCP and Zhiyue device pairing/read-only endpoints. See [voice search](docs/ZHIYUE_VOICE_SEARCH.md) for category/article voice queries and optional OpenAI text semantics configuration, [reading library](docs/CMS_READING.md) and [article delivery](docs/ARTICLE_MANAGEMENT.md). Interface changes must update the contract and generated frontend types together.

## Deployment

The [Dockerfile](Dockerfile) builds both frontends, the API and versioned packages into one application image. [Compose](compose.yaml) binds published application ports explicitly to loopback (8080 by default, configurable); the database has no published host port. Host Nginx proxies pages/API/audio and terminates TLS.

[GitHub Actions](.github/workflows/deploy.yml) supports manually triggered validation, image publishing and SSH updates with host identity verification. Image digests are traceable; deployments are serialized, backed up and migrated compatibly. Failed health checks restore the old application. Database volumes are not automatically deleted.

Local validation covered image builds, Compose ports/pages/health, repeated startup, recovery after failed health checks with data retention, and backup/restore. No real VPS connection or remote workflow was executed. Nginx/TLS and real Japanese audio retain outstanding acceptance work; see [operations](docs/operations.md).

## Validation and documentation

Recorded article/audio delivery checks passed six real HTTP/PostgreSQL tests and backup/restore. The Gateway speed fix passed 17 targeted tests plus build/type checks. Independent article CRUD acceptance, seven audio API groups and five browser groups covered actual decoding/playback/download, failure retention, replacement and refresh recovery. See the [frontend report](apps/web/qa/REPORT.md) for interaction, regression and build records. A test tone does not establish real Japanese pronunciation quality.

[Tasks](TODO.md) · [Articles](docs/ARTICLE_MANAGEMENT.md) · [Architecture](docs/ARCHITECTURE.md) · [Product](docs/PRODUCT_SPEC.md) · [Decisions](docs/DECISIONS.md) · [Frontend report](apps/web/qa/REPORT.md). Local Git delivery is organized by completed features; these historical delivery records do not imply a push or remote deployment.

## Standalone CMS

The CMS frontend in `apps/cms` has its own homepage, layout, navigation, login and build output; `apps/web` retains its own entry point. Both share the platform API, article bodies, publications and audio, without a second backend or database. See [CMS frontend](docs/CMS_FRONTEND.md) for independent build/preview and security boundaries, and [CMS features](docs/CMS_V1.md) for the model and JSON import examples.

Documented isolated previews: workbench at http://127.0.0.1:4382/ and CMS at http://127.0.0.1:4384/. Real data, paid TTS, AI credentials and production deployment are not connected in these previews.

Category management offers parent/child trees, ordering, direct article counts, uncategorized articles and revision-checked bulk categorization. See [categories](docs/CMS_CATEGORIES.md).

The reading library browses published category snapshots, shows three-line body previews and plays audio on demand inside cards, with matching counts and pagination. Historical category edits do not rewrite old releases. See [reading library](docs/CMS_READING.md).

CMS article management combines publication-state and missing-audio filters with search and categories. The draft filter applies to the CMS website; Zhiyue devices continue to read published articles only. See [article status filtering](docs/ZHIYUE_ARTICLE_STATUS.md).
