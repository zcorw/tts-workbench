# 同一 app 容器内的独立 CMS 入口

## 运行结构

`app` 镜像同时包含 `apps/web/dist`、`apps/cms/dist` 与 API。一个 Node 进程复用同一账户、数据库连接池、正文服务和 TTS；工作台与 CMS 各有 HTTP 监听入口和导航，不运行生产 Vite，也不增加 CMS、Redis 或 Gateway 容器。

| 入口       | 容器监听              | 默认宿主映射     | 外部地址配置                                |
| ---------- | --------------------- | ---------------- | ------------------------------------------- |
| 原工作台   | `0.0.0.0:3000`        | `127.0.0.1:8080` | `PUBLIC_ORIGIN=https://tts.example.com`     |
| 独立 CMS   | `0.0.0.0:3001`        | `127.0.0.1:8081` | `CMS_PUBLIC_ORIGIN=https://cms.example.com` |
| PostgreSQL | `db:5432`，无宿主映射 | 无               | 保留原 `DATABASE_URL` 与 `postgres_data`    |

`APP_HOST_PORT`、`CMS_HOST_PORT` 只改变宿主回环端口，不能使用相同端口。Compose 固定两个容器内端口；直接运行 Node 时可用 `PORT`、`CMS_PORT` 更改。`CMS_DIST` 启用 CMS 入口；Docker 默认设为 `/app/apps/cms/dist`。没有 `CMS_DIST` 的原宿主 API 用法保持单入口。

`PUBLIC_ORIGIN` 保持工作台地址。两个 origin 必须是无用户名、密码、路径、查询和片段的 HTTP(S) origin，生产要求 HTTPS。`CMS_PUBLIC_ORIGIN` 没有默认真实域名；已有配置未填写它时工作台继续运行，CMS 页面可加载、健康检查可用，但 CMS `/v1` 请求明确返回 `503 CMS_ORIGIN_UNCONFIGURED`。它不会借用工作台 origin 或匿名读取文章。

两站通过各自同源 `/v1` 调用共用后端。监听器使用服务端入口身份校验对应 origin，不依赖客户端 Host 选择权限；认证、所有权、CSRF 继续执行。CMS Origin 不能用于工作台端口上的写请求，反之亦然。不同域名需分别登录，没有新增跨域 SSO；同一主机不同端口的 Cookie 由浏览器共享，退出会影响该主机上的会话。

## 构建与启动

生产 Dockerfile 使用各包自己的锁文件安装、构建三个包，将两个前端 dist 复制到同一个 runtime 镜像。手工本地构建（不发布）：

```sh
docker build -t tts-workbench:cms-dual-port .
```

需要已安装 Docker/Compose、可获取锁定依赖、至少 Node 22.23.4 对应镜像。镜像不含真实 `.env`、数据库数据或测试夹具。生产前端使用公开的 `/site-config.json` 获取两个外部 URL，因此更换域名后重新创建 app 即可，无需把凭据写入前端或重构建 JS。原 `VITE_WORKBENCH_SITE_URL` / `VITE_CMS_SITE_URL` 只作为本地独立 Vite 用法的兼容配置，不提供 API 授权。

已经运行工作台的 VPS，后续经授权升级时：

1. 保留现有 `.env.production`、数据库用户/密码、`SESSION_SECRET`、`DATABASE_URL`、Compose 项目名与数据库卷。只增加经确认的 `CMS_PUBLIC_ORIGIN` 和可选 `CMS_HOST_PORT`，不要重新生成账号、密码或数据库。
2. 确认新宿主回环端口空闲。发布新的同容器镜像及当前 `compose.yaml`；默认仍只有 `app` 和 `db` 两个常驻服务。
3. 沿用 [VPS 部署指南](VPS_DEPLOYMENT.md) 的备份、显式迁移、app 更新和健康等待流程。部署脚本会保留原卷，并同时检查两个入口；本功能本身不新增业务数据库迁移。
4. 经确认 DNS 和证书后，按 [Nginx 示例](../deploy/nginx.conf.example) 分别代理两个 HTTPS 域名：工作台到原回环端口，CMS 到新回环端口。不要对公网开放 8080/8081，原样转发 Origin，不重写或伪造，不修改 CORS 为通配符。
5. 在目标 VPS 运行 `nginx -t` 后再按既有流程加载配置。验证两个站点的登录、退出、编辑/冲突、导入、直接打开与刷新、受保护音频播放。容器健康通过不能替代域名/TLS/供应商验证。

模板域名均为示例，不会替换任何现有站点。GitHub Actions 仍仅手工触发，增加 CMS 构建校验后使用同一 Dockerfile 发布一个应用镜像；本文没有运行工作流或更新 VPS。

## 静态资源、导入、音频与运维

CMS 的页面路由由 Node 回退本站 `index.html`。`/v1`、`/health`、缺失 JS/CSS/图片等资源不会被改写为 HTML；页面和公开 URL 配置不缓存，带内容哈希的资源可长期缓存。API 和鉴权音频继续使用 `no-store`，Nginx 示例关闭代理缓存及缓冲。API 错误保持 JSON，不使用 Nginx `error_page` 将其重写成页面。

普通 JSON 限制仍为 64 KiB；仅 POST `/v1/cms/import` 和 `/v1/cms/import/preview` 接受 1 MiB。Nginx 示例对这两个路径单独设置 1 MiB，其余入口保持 64 KiB。不要为全部接口提高正文限制或公开媒体目录。

Docker 健康检查访问工作台及已启用 CMS 的 `/health/ready`；Node 退出会关闭两个监听器并释放共享资源。CMS 端口被占用或入口启动失败不能留下一个伪健康的半启动服务。

文章与音频仍在现有 PostgreSQL 持久卷，备份仍使用全库 `pg_dump`。不要删除卷、改用 CI 的 `cms_reading_test_20261027`、把 QA tmpfs 库或模拟 TTS 配置接入生产。真实供应商凭据只保留在受保护的服务端配置中。

## 本次授权边界

开发验收阶段仅修改源码、构建/部署示例和测试，并在隔离虚构数据库与合成音频中验证；未合并、触发工作流、连接 VPS、配置真实域名/证书、迁移真实数据、创建真实凭据或调用收费 TTS。提交与推送须由用户另行授权，不能视为已经部署。实际本地验收结果以交付报告为准，本文不宣称生产已经支持访问。
