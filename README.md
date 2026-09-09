# TTS Workbench

React + NestJS + PostgreSQL 日文语音工作台。正文选词修改读法默认保存为本人规则，适用于当前及以后文章；原文保持不变，没有“仅此处”分支。

真实账户、Session/CSRF、显示名称设置、个人读法CRUD、版本冲突及Gateway日文合成链路已实现。“我的文章”支持搜索分页、新建、打开、编辑保存与删除。每篇只保存最新标题正文和最后成功音频；刷新或重新登录后可继续编辑、播放与下载。详见[文章管理增量](docs/ARTICLE_MANAGEMENT.md)。无供应商配置时，音色目录为空、合成返回503；本地协议测试不代表真实日文发音效果验收。

在“我的文章”新建或打开文章，编辑后点击“保存文章”。点击“生成语音”会先保存当前修改，再使用已保存正文生成；成功后替换上一次音频，失败保留旧音频。正文、个人读法或朗读设置变化后会提示重新生成。删除文章会一并删除音频，个人读法仍保留；不提供文章或音频历史版本。

## 首次部署后：先创建登录账号

**没有默认账号或默认密码。** 首次 Compose 部署及迁移成功后，Windows 本地按以下步骤初始化（密码 **8–128 字符**）：

1. 在根 `.env` 临时添加 `ACCOUNT_PASSWORD='你设置的初始密码'`，将引号内文字替换为实际密码。
2. 执行 `.\rebuild.cmd`，让应用容器读取新增变量；记下输出的项目名和访问地址。
3. 默认项目运行 `docker exec tts-workbench-app-1 node apps/api/dist/operations.js create admin "我的账户"`。`admin` 只是可替换的登录名，不代表管理员角色。自定义项目请使用[完整步骤](docs/operations.md#首次部署后的账号初始化)定位对应容器。
4. 输出包含 `id` 和 `login` 的 JSON 且退出码为0表示成功。删除根 `.env` 的 `ACCOUNT_PASSWORD` 行，再执行 `.\rebuild.cmd`，移除应用容器持有的明文；之后在输出地址使用刚才的登录名和密码登录。

务必在应用容器内创建，避免宿主机 `node --env-file=.env ... create` 连到旧开发库。VPS / GitHub Actions 部署后的临时密码传递、清理验证和常见错误，见[首次部署后的账号初始化](docs/operations.md#首次部署后的账号初始化)。

## 本地入口

Windows Docker Compose 一键重建：准备 `.env` 并启动 Docker Desktop 后，双击根目录 `rebuild.cmd` 或执行 `.\rebuild.cmd`；无缓存用 `.\rebuild.cmd --no-cache`。保留数据库卷，端口读取 `APP_HOST_PORT`（默认8080），完成后显示实际访问地址。配置与已有项目数据说明见[运维说明](docs/operations.md#windows-一键重建-docker-compose)。

当前运行的开发页面：[打开工作台](http://127.0.0.1:4181/)，API为127.0.0.1:3000，两者已接入文章及最新音频功能。前端通过Vite代理/v1和/health；当前隔离开发环境允许注册测试账户，尚未配置供应商。现有8080实例没有重建，代码提交不等于已经更新该实例。

```sh
npm ci
npm --prefix apps/api ci
npm --prefix apps/web ci
# 复制.env.example为.env，配置数据库、Session秘密及PUBLIC_ORIGIN
npm --prefix apps/api run build
# 在apps/api目录执行：node --env-file=../../.env dist/operations.js migrate
npm --prefix apps/api start
# 另一终端
npm --prefix apps/web run dev
```

运行、账户开通、供应商配置与测试详见[运维说明](docs/operations.md)。旧HTML原型与apps/web/reference仅作参考，4180与本机账户/浏览器语音不再是正式入口。

## Azure 与 AWS TTS 配置

**当前工作台只接入 Azure 日文；填写 AWS Key 不会启用日文 Polly。** Azure 使用 `TTS_AZURE_SPEECH_KEY` 和 `TTS_AZURE_JA_VOICE_ID`，区域固定 `japaneast`。本地修改根 `.env` 后运行 `.\rebuild.cmd`；VPS 修改 `.env.production` 后需重新创建 app 容器。

资源创建、音色选择、配置生效、最短试听、AWS 凭据与最小 IAM 权限，以及尚未实现的 Polly 接入项，见[Azure 与 AWS TTS 配置说明](docs/operations.md#azure-与-aws-tts-配置)。密钥只放服务端配置，不放文档、Git、日志或前端变量；`PUBLIC_ORIGIN` 是网站访问地址，与供应商凭据无关。

## 工程与契约

- apps/web：React、Radix Dialog、React Hook Form/Zod、React Router、TanStack Query。
- apps/api：Nest、Zod、express-session、csrf-sync、PostgreSQL/pg、node-pg-migrate。
- 独立账户工程：相邻nest-account，提供account-core/account-postgres两个0.1.1包及可选session适配入口。
- 独立Gateway：相邻TTS-gateway，提供0.1.1库入口、宿主注入和ja-JP规则执行，修复1.15等合法两位小数语速的浮点校验。
- 应用仅消费vendor里的版本化tgz及锁文件，不引用兄弟仓库src。

唯一[OpenAPI 1.1.0](docs/openapi.yaml)含24个操作，规范校验、前端生成类型和[产品契约评审](docs/API_REVIEW.md)通过。新增文章7操作的运行交付状态见[增量计划](docs/ARTICLE_MANAGEMENT.md)，接口修改须同步契约和前端生成类型。

## 部署

[Dockerfile](Dockerfile)将前端/API及版本包构建为同一应用镜像。[Compose](compose.yaml)整个栈只发布一个显式绑定127.0.0.1的宿主端口（默认8080可配置），数据库不发布宿主端口；由宿主Nginx统一代理页面/API/音频并负责TLS。

[GitHub Actions](.github/workflows/deploy.yml)支持手动触发验证、推送镜像并通过校验主机身份的SSH远程更新VPS。镜像digest可追踪、部署串行、先备份及兼容迁移，健康失败恢复旧应用；不自动删除数据库卷。

本地已验证镜像构建、Compose单端口/页面/健康、重复启动、健康失败后的配置恢复和数据保留、备份恢复。未连接真实VPS或执行远程workflow；宿主Nginx代理/TLS及真实日文音频仍有明确未验收项，见[运维说明](docs/operations.md)。

## 验证与文档

本次增量：应用完整6项真实HTTP/PG测试、文章与音频备份恢复通过；Gateway语速修复17项定向测试及构建/类型检查通过。产品独立执行文章CRUD接口与浏览器验收、最新音频7组接口与5组浏览器检查，验证真实解码播放下载、失败保留、替换及刷新恢复。前端各组交互、回归与构建记录见[前端报告](apps/web/qa/REPORT.md)。测试音调不代表真实日文发音效果通过。

[开发任务](TODO.md) · [文章管理](docs/ARTICLE_MANAGEMENT.md) · [架构](docs/ARCHITECTURE.md) · [产品说明](docs/PRODUCT_SPEC.md) · [决策](docs/DECISIONS.md) · [前端报告](apps/web/qa/REPORT.md)。本地Git由产品按完成的功能点提交；尚未推送或远程部署。
