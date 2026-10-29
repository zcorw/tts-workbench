# CMS 第一版

阅读库分类、三行正文和单活动音频已扩展至API1.4.0；具体发布分类语义见 [阅读库说明](CMS_READING.md)。

分类管理自API1.3.0提供父子树、排序、直接计数、未分类及原子批量归类，现行契约为API1.4.0。详见 [分类管理说明](CMS_CATEGORIES.md)，历史发布快照及音频保持原语义。

CMS 现为 apps/cms 独立前端站点，原工作台位于 apps/web；两站复用同一个 Node/Nest 后端、账户与 PostgreSQL，没有新建 CMS 后端或数据库。双站点目录、构建、预览与权限说明见 [CMS_FRONTEND.md](CMS_FRONTEND.md)。

## 入口与使用

- CMS 根入口为 `http://127.0.0.1:4384/`，登录后进入本站首页；内容列表为 `/articles`。手工新建和 JSON 导入是并列入口；旧工作台文章也能在 CMS 中管理。
- CMS 使用普通纯文本编辑器。标题、日文正文、栏目、标签、摘要和 slug 在一次事务中保存。检索涵盖标题、正文和摘要，可按栏目、标签和发布状态筛选。
- 在栏目/标签管理中先创建分类。slug 为小写英文、数字和连字符，账户内文章 slug 唯一；正文不强制做 Unicode 规范化。不要把读法替换后的显示文本当成原文导入。
- 生成语音仍调用原有文章音频接口：先保存，再生成；失败保留上次音频，重试需主动点击。CMS 没有新增可恢复后台作业，关页不承诺继续生成，也不会自动调用收费 TTS。
- “发布到本人阅读库”固定标题、正文、栏目/标签快照和选定音频。下一次修改草稿、词库或生成语音不会改变此版本。可以明确选择仅发布正文。
- 阅读库位于 CMS 站点 `/read`；发布保持私有，未开放匿名公网访问。历史版本仍由本人访问；撤回后从当前阅读库、RSS 和只读接口消失。

## 两个编辑器的冲突保护

编辑页可见时约每 20 秒检查 JSON 版本，切回标签页或窗口获焦立即检查；隐藏页停止定时轮询。不下载音频、不替换输入、不自动保存。没有本地修改时提示可载入更新；有本地输入时提示远端变化并保留草稿。

保存必须原子核对正文 revision，CMS 还核对元数据 revision。409 不丢输入，差异对照提供继续编辑、明确放弃并载入最新、以及用户整理后基于所示最新版本保存。再次发生冲突仍保留整理结果，不自动循环重试。草稿只在页面内存，未写入 localStorage/IndexedDB；离开、刷新或关闭有未保存提示。

## JSON 导入

样例见 [examples/cms-import.json](examples/cms-import.json)。每批最多 20 条、JSON 总计最多 1MiB，单篇沿用原平台上限：标题 120 Unicode 码点，正文 10000 码点且 49152 UTF-8 字节。没有自动长文切分。

1. 将 JSON 粘贴到导入页面并预览；修改输入会使旧预览失效。
2. 逐条查看创建、更新、无变化与错误，确认后提交。错误不会冒充整批成功；允许明确的逐条部分成功。
3. `(账户, source, externalId)` 是稳定标识。同一来源重复导入更新原文章，不另建副本；批内重复 externalId 直接报错。
4. 更新前必须带预览所得 articleId、expectedRevision 和 expectedCmsRevision；任一变化都返回 IMPORT_CONFLICT，需重新预览，不能静默覆盖另一编辑器。
5. categoryId/tagIds 使用本人分类 ID；未知或他人的 ID 拒绝。没有栏目时用 null/空数组。导入只保存草稿，不发布、不生成语音。

通过 API 使用时先 POST `/v1/cms/import/preview` 发送样例结构，再将每条预览的 articleId/expectedRevision/expectedCmsRevision 加回相应输入条目，POST `/v1/cms/import`。新建的预期值为 null/0/0。不得直接把预览响应当正文提交。

## 发布与数据模型

权威工作正文始终是 `wb_articles.title/text`；`wb_cms_articles` 只管理 CMS 元数据和当前发布指针。分类/标签属于 `wb_cms_taxonomy`，关联在 `wb_cms_article_tags`。导入稳定映射在 `wb_cms_import_sources`。

`wb_cms_releases` 保存显式发布快照；`wb_cms_media` 按音频 ID 保留被引用的 MP3 字节，避免旧工作音频被覆盖时丢失发布资产。相同音频被多个 release 引用时不重复存字节。每篇最多保留 10 个显式发布版本，达到上限后先删除不需要的非当前版本；当前版本须先撤回。平台原文在有任何发布记录时禁止删除，避免破坏保留的内容；清理发布历史后可正常删除。

栏目和标签变化不会改变正文 contentRevision，也不要求重新生成。朗读正文、读法规则、音色或语速变化才使工作音频过期；标题变化不使音频过期。发布选音频时核对指定 audioId 和当时正文/规则版本；历史词库全文没有保留，因此历史音频可播放不代表可以精确重合成。

迁移文件 `apps/api/migrations/1789142400000-cms.cjs` 是新增表的增量迁移；本地开发仅在隔离测试库执行。**交付代码不代表已经迁移现有数据库或接入生产服务。** 正式应用前先做备份、演练和用户批准；不要直接运行会加载原 `.env` 的启动/迁移命令进行本次验收。

## RSS 与 AI 只读 API

当前登录用户可访问：

- `GET /v1/cms/read/articles`：分页读取当前发布快照，可按 q/category/tag 筛选。
- `GET /v1/cms/read/articles/:articleId`：读取指定文章的当前固定发布版本。
- `GET /v1/cms/read/releases/:releaseId/audio`：当前发布版本的固定音频。
- `GET /v1/cms/read/rss`：同一发布源的 RSS 2.0，最多最近 100 篇。

没有匿名权限；当前阅读接口不暴露草稿、词库或其他账户内容。重新发布可切换当前版本，旧版本仍保留在本人历史入口；撤回后当前读取权限同步消失，已下载内容无法追溯收回。

机器读取支持限定账户和栏目、可撤销、60 秒至 24 小时有效的 Bearer，数据库仅存 SHA-256 摘要；它只被 `/v1/cms/read/*` 接受，不能编辑、生成、读取私人草稿或管理 token。明文只在创建成功时返回一次，禁止放入 RSS URL、日志、文档或前端持久存储。

**默认 `CMS_READ_TOKENS_ENABLED=false`。** 创建/列出/撤销 token 接口在关闭时返回 404。只有明确批准真实读取范围及凭证启用后，才可修改实际环境配置并由本人 Session/CSRF 调用 `/v1/cms/read-tokens`。本次仅测试身份在隔离库验证，不创建真实 AI 凭证，也没有改变现有环境配置。RSS 客户端若无法带会话或 Authorization header，当前不支持其私有订阅，不能通过 URL 泄露凭证绕过。

## 本地启动和验收

沿用已安装的项目工具，不安装额外依赖。API 静态构建、前端类型与格式检查：

```powershell
npm.cmd --prefix apps/api run build
npm.cmd --prefix apps/web run typecheck
npm.cmd --prefix apps/web run format:check
node scripts/validate-contract.mjs
npm.cmd --prefix apps/web run check:api
```

运行 API 集成测试必须设置明确指向**新建隔离库**的 TEST_DATABASE_URL，再执行 `npm.cmd --prefix apps/api test`。未设置时部分测试会跳过，不能算验收通过。使用项目要求的 Node 22.23.4；本次宿主旧 Node 仅用于静态编译，运行验收使用缓存应用镜像内的正确 Node 与 Linux 依赖。

隔离浏览器 fixture：`apps/api/test/fixtures/serve-cms.mjs` 强制检查新建测试库名和 loopback/专用测试主机，要求明确的 TEST_DATABASE_URL、FIXTURE_CONTROL_FILE；返回合成测试 MP3、拒绝其他外网调用。前端用 API_PROXY_TARGET 指向该 loopback API，再运行 Vite 严格端口，或由同一 Node 进程服务最终静态前端。QA 截图、控制文件和报告写到本任务工作区，不覆盖原 runtime 或旧验收资料。

本机独立 CMS 预览为 `http://127.0.0.1:4384/`，工作台预览为 `http://127.0.0.1:4382/`；两者通过以下双站点脚本重复启动：

```powershell
& '<本地评估任务目录>\qa\START_CMS_PREVIEW.ps1'
```

需要从当前源码重建时加 `-Build`。虚构演示账户见同目录 `preview-account.json`，不是原有系统账户；脚本会幂等初始化示例，不覆盖已编辑文章。具体资源名、恢复与清理说明见当前任务 `qa/START_PREVIEW.md`，测试证据见 `CMS_DEVELOPMENT.md` 和 `qa/`。

测试 PG 使用 tmpfs，只有容器运行期间可以依赖其数据；停止/删除数据库容器或 Docker 重启可能清空。任务目录的 `qa/standalone/cms-preview.dump` 仅备份虚构数据；`-RestoreTestDump` 只允许恢复到本任务空测试库，有表时拒绝覆盖。亦可重新初始化样例。源码和本地记录保存于磁盘，这个预览并非持久生产部署。

尚未实测部署内存；单音频 8MiB 上限不等于内存峰值。未验证真实供应商音质、现有生产数据迁移、正式反代/TLS、公网发布或真实 AI 客户端接入，这些需要另行批准与验收。

## 此前内嵌阶段验收（独立站点结果见 CMS_FRONTEND.md）

Node 22.23.4 / Vite 8.3.5 构建、TypeScript、Prettier、OpenAPI1.2.0共50操作及生成类型一致性通过。隔离真实HTTP/PostgreSQL + 模拟供应商API18/18（0跳过）；CMS桌面/390px手机15组、最后只读播放器2组，以及原React/文章/音频/账户/读法/密码/静态路由回归均通过。虚构数据dump已实际恢复到新空测试库，计数、发布快照和音频哈希一致。

详细报告位于本任务工作区 qa/QA_FINAL.md。可见性检查使用浏览器事件和时钟模拟；手机为Chromium视口验证。未验证物理手机、真实收费供应商音质、真实AI客户端或生产数据迁移。构建有单chunk大于500kB的建议性提示，未实测运行内存，不承诺资源数值。没有commit、push或部署。
