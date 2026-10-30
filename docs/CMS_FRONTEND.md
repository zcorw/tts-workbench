# CMS 独立前端站点

> 2026-10-29 更新：生产镜像现包含独立 CMS，复用同一 app 容器并增加默认回环 8081→3001 入口。两个站点的外部 origin、迁移升级和 Nginx 示例见 [同容器双入口](CMS_CONTAINER.md)。下文原“唯一宿主端口”描述属于此前工作台部署；工作台 8080→3000 入口保持。未填写 CMS_PUBLIC_ORIGIN 时 CMS API 返回503，原工作台仍可用。

阅读库入口为`/read`，提供发布分类、三行正文和卡片内按需互斥播放；本轮阅读版使用本地任务qa/START_READING_PREVIEW.ps1与新虚构库cms_reading_preview_20261027，保留原分类验收库。功能与快照边界见 [阅读库说明](CMS_READING.md)。

分类管理仍位于独立 CMS 站点的 `/taxonomy`，文章页提供层级导航、未分类和批量移动。分类版隔离预览使用本地任务 `qa/START_CATEGORIES_PREVIEW.ps1`，原 `cms_v1_test3` 测试库保留，新库为 `cms_categories_preview_20261027`；运行时仍为两个前端复用一个后端。详见 [分类管理](CMS_CATEGORIES.md)。

用户已明确要求 CMS 是独立站点。本轮将此前工作台内嵌的 CMS 拆成独立前端；代码仍在同一仓库，后端、正文、发布版本、音频和数据库继续共享。没有创建第二套 CMS 后端或数据库。

## 工程与构建边界

| 工程 | 责任 | 入口与产物 |
|---|---|---|
| apps/web | 原语音工作台、精细读法编辑、文章管理 | 自己的 index.html / src/main.tsx / Vite；Hash 路由；apps/web/dist |
| apps/cms | 内容站点首页、列表/阅读/普通编辑、JSON 导入、栏目标签、发布管理、账户与只读接口说明 | 自己的 package.json / package-lock.json / index.html / tsconfig / Vite / main；BrowserRouter；apps/cms/dist |
| apps/api | 唯一平台 API、账户、正文、TTS、发布媒体与权限 | 继续使用既有 Nest/Express 应用和 PostgreSQL |

CMS 的业务组件由旧 apps/web/src/cms 迁往 apps/cms/src/features。工作台 App 不再 import 或渲染 CMS；原导航保留，只提供“独立打开”的跨站链接。CMS 有自己的首页、布局、导航和登录页，未复用工作台导航壳。

两个前端通过仓库内部共享组件、验证规则、类型和 HTTP 客户端复用能力；CMS 的 @workbench alias 只指向公共前端源码。共享源码不要求运行或构建工作台网站；CMS 构建使用自己的依赖目录，Vite 对共享运行库做 dedupe。运行时 CMS 只需要自己的静态 dist 和获准的平台 API 入口。

在仓库根分别执行：

```powershell
npm.cmd --prefix apps/web run build
npm.cmd --prefix apps/cms run build
```

常规首次安装按各包自己的锁文件运行 npm ci。两包沿用相同已锁定依赖版本，没有引入新第三方库；本轮隔离构建复用缓存依赖，不改变现有宿主锁文件或 node_modules。

开发和静态预览也各自独立：

```powershell
npm.cmd --prefix apps/web run dev
npm.cmd --prefix apps/cms run dev
# CMS 自己的构建产物
npm.cmd --prefix apps/cms run preview
```

## 本机双站点预览

- 工作台：http://127.0.0.1:4382/ （原 Hash 路由仍可用，例如 /#/articles）
- CMS：http://127.0.0.1:4384/ （根地址是独立内容站点，登录后是概览首页）
- CMS 内站路由：/articles、/articles/:id、/read、/read/:id、/import、/taxonomy、/interfaces、/account、/login、/register。

跨站链接默认新标签页打开，正文编辑跳转保留相同 articleId。生产同容器双入口通过公开 `/site-config.json` 取得 `PUBLIC_ORIGIN` / `CMS_PUBLIC_ORIGIN` 的站点地址；CMS 未配置时不把本机默认地址用于生产跳转。CMS 的 VITE_WORKBENCH_SITE_URL 和工作台的 VITE_CMS_SITE_URL 保留本地独立 Vite 用法的兼容配置，只放公共地址，不放凭证，也不提供 API 授权。

双站点使用本任务隔离数据库和模拟 TTS。重复启动说明与脚本位于本地任务目录：

```powershell
& '<本地评估任务目录>\qa\START_CMS_PREVIEW.ps1'
```

加 -Build 可从当前源码重建双前端测试镜像。详细资源名、虚构账号、备份恢复和清理说明见该目录 START_PREVIEW.md；本轮证据在 qa/standalone。旧 qa/cms-static-browser 等报告属于此前内嵌阶段，不代表新站点边界验收。

测试 PG 为 tmpfs，不能把容器停止后仍保留数据当作保证；可重新初始化虚构样例，或仅向本任务空隔离库恢复 cms-preview.dump。没有连接现有真实数据或创建真实 AI 凭证。

## 本地代理与权限

两站都请求自身同源 /v1 和 /health。工作台预览与既有隔离后端同一入口；CMS 的 Vite dev/preview 仅代理这两个固定路径前缀到明确配置的后端。

CMS 代理在转发前精确检查固定 CMS_SITE_ORIGIN：外站 Origin 拒绝，写请求缺 Origin 拒绝，跨站 fetch metadata 拒绝；非规范 API 路径拒绝。校验通过后，只在发往固定目标的请求上将 Origin 设为 API_CANONICAL_ORIGIN。Cookie、CSRF、Authorization 和 Set-Cookie 沿用原边界，代理不增加身份或读取权限。开发文件服务只开放 CMS 和明确共享的前端源码/样式/工具依赖，不开放整个仓库、API、runtime 或 vendor。

本机测试参数：

```powershell
$env:CMS_SITE_ORIGIN='http://127.0.0.1:4384'
$env:API_PROXY_TARGET='http://127.0.0.1:4382'
$env:API_CANONICAL_ORIGIN='http://127.0.0.1:4382'
npm.cmd --prefix apps/cms run dev
```

API_PROXY_TARGET 是实际可达的测试 API 地址；API_CANONICAL_ORIGIN 必须匹配该后端已经配置的 PUBLIC_ORIGIN。如果使用原常规开发 API 3000、工作台4181，应明确设置相应 target/canonical，而不是修改后端安全策略来迁就站点。Docker 双站预览使用专用网络内的固定测试服务名，宿主只发布 loopback 端口。

这是本地调试桥接。没有改动生产 PUBLIC_ORIGIN、CORS、DNS、Nginx、认证凭证或真实 API token。两个独立域名正式接入仍需确认入口/认证方案并单独批准；本轮不部署。CMS 静态宿主需要将内站非 API 路由回退 index.html，才能支持直接打开与刷新；不在本轮写入生产 Nginx 配置。

## 登录、草稿与保留的功能

独立站点不等于匿名开放，私有权限保持。未登录访问 CMS 内页会到本站登录并在成功后返回；退出保持在本站。只有明确的链接会打开工作台。

本地两个端口使用同一 host，浏览器 Cookie 不按端口隔离，所以两站共用同一账户会话；一边登录/退出可能使另一边刷新认证状态或 CSRF。未保存草稿保存在页面内存，服务端版本仍原子校验；不会把会话变化解释为允许另一账户读取草稿。未做跨域 SSO 或创建新的持久凭证。

普通日文编辑、手工与 JSON 导入、栏目/标签/检索、跨站同文章冲突、20 秒可见检查与隐藏停止、明确差异整理、固定发布正文/音频、RSS/AI 只读接口均保留。数据模型及导入样例见 [CMS_V1.md](CMS_V1.md)。本轮没有正文或发布数据迁移。

## 验收结果（2026-10-27）

本轮要求已完成，无剩余功能阻塞。Node22.23.4/Vite8.3.5双构建通过；CMS拥有自己的真实依赖目录，在移走web/node_modules后仍独立tsc与Vite成功。两前端类型/格式检查、共享契约指纹及diff检查通过。

独立双站浏览器21组、preview安全20项、dev边界9项通过；原工作台React/文章/音频22/22/13组通过，页面异常为0。覆盖根首页、直接刷新、前进后退、认证回跳/退出、未保存保护、跨站同文冲突、日文/JSON/栏目检索、固定发布及模拟MP3实际播放；320/390手机视口通过。只使用隔离真实HTTP/PostgreSQL与模拟TTS，未调用真实供应商。

启动脚本已实际重复启动两站并幂等初始化样例。最新隔离数据备份为任务qa/standalone/cms-preview.dump（393238字节），已恢复至新空测试库，12虚构账户/13文章/5发布/4媒体计数及发布快照/媒体哈希一致；旧阶段备份仍保留。

最终证据与截图见本地任务qa/standalone/QA_FINAL.md。此前内嵌阶段报告不替代本轮独立站点验收。手机为浏览器视口，可见性通过浏览器事件/时钟模拟；未实测物理设备或内存。构建的大于500kB chunk提示为建议性提示，不代表内存改善。没有改动生产安全策略、迁移真实数据、创建真实AI凭证、提交、推送或部署。
