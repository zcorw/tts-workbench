# YOMI React 前端

当前正式入口是 **React + TypeScript + Vite**，按已冻结 OpenAPI 调用真实同源 HTTP 服务。登录、个人读法和语音均不再使用 localStorage / speechSynthesis 兜底。原 HTML 模板与历史截图保存在 [reference](reference/README.md)，原项目 `prototype` 未修改。

## 运行

Node.js **22.12+**，从 `apps/web` 执行：

```powershell
npm ci
npm run dev
```

打开 **http://127.0.0.1:4181/**。Vite 将 `/v1` 和 `/health` 代理到 `http://127.0.0.1:3000`；可通过 `API_PROXY_TARGET` 调整目标。后端开发 `PUBLIC_ORIGIN` 必须为 `http://127.0.0.1:4181`。页面默认读取服务端注册配置，没有预置默认账号或密码；本地隔离联调环境开启注册时，可在创建账户页设置自己的账号。

正式密码要求为 **8–128 位**；账户名称为 3–120 个字符，仅支持 ASCII 字母、数字及 `@ . _ + -`。显示名称为 1–40 个字符。注册成功不会自动登录。

```powershell
npm run typecheck
npm run check:api
npm run build
npm run preview
```

构建产物 `dist/` 使用根路径资源；生产预览为 `http://127.0.0.1:4182`。生产预览仅检查静态资源和路由，不将后端允许的开发 Origin 改为预览端口。正式部署由统一 Nginx 入口提供 `dist`、API 和音频，前端不直连供应商、不硬编码公网域名；同源 Cookie/CSRF 经统一入口使用。createHashRouter 的 `#/articles`、`#/articles/new`、`#/articles/{id}` 等地址可直接刷新，URL hash 不发送服务端。Compose/根配置由后端维护，本目录没有发布第二个生产宿主端口。

## 页面与组件

| 页面/交互 | React 组件 | 状态 |
|---|---|---|
| 登录、注册与注册关闭 | `AuthPage` | RHF/Zod校验、错误凭据、提交中、注册后登录、会话失效、服务不可用与重连 |
| 应用导航与当前账户 | `Layout` | React Router导航、受保护页面、桌面侧栏与窄屏导航 |
| 我的文章 | `ArticlesPage` | 服务端标题搜索与20条分页、空集合/加载失败、新建打开、条件删除与末页回退 |
| 日文工作台 | `Workspace` | 正文、音色目录/失败/为空、语速、字符与字节限制、生成中、错误恢复 |
| 正文直接选词 | `ArticleEditor` | 多行/emoji/IME、纯文本粘贴、键盘选区、固定和浮动入口、个人规则标记与chip |
| 个人读法 | `RulesPage` | 全量投影与20条/页列表、查询、空集合/无结果、CRUD、加载失败与重试 |
| 读法编辑与删除 | `RuleDialog` / `DeleteRuleDialog` | Radix焦点/键盘约束、未保存候选试听、成功确认后更新、409保留输入并刷新规则 |
| 音频 | `AudioPlayer` / `useArticleAudio` | 真MP3 Blob、播放/暂停/停止、真实时长和进度、下载、旧音频过期、媒体失败 |
| 账户资料 | `AccountPage` | 当前账号、显示名称修改、个人规则数量、退出 |
| 文章保存及导航保护 | `useArticleDocument` / `Workspace` | 显式保存、409草稿保留/确认重载、保存中继续编辑、返回/前进/链接阻塞、刷新提示、同账户失效恢复 |
| 使用指引 | `HelpDialog` | 正文选词和个人读法说明 |

首版同词只有一个个人默认读法。正文弹层和列表调用同一规则接口，保存后作用于当前及以后文章，原字不变。没有“仅此处”、释义/词性、计费后台、云文章历史、密码恢复或架构说明页面。

## 成熟工具与自写边界

| 职责 | 实际依赖 | 选择理由 |
|---|---|---|
| 组件/构建/类型 | React 19.2.8、Vite 8.2.2、TypeScript 5.9.3 | React为用户指定；TS5符合openapi-typescript peer要求；Vite提供开发代理和生产打包 |
| 无障碍弹层 | Radix Dialog 1.1.23 | 成熟焦点约束、Escape、可访问结构；用已有主题保持视觉，不自建焦点陷阱 |
| 表单/校验 | React Hook Form 7.87.0、Zod 4.5.4、resolvers 5.9.1 | 统一字段状态、schema校验与错误；已删除原通用手写校验 |
| 路由 | React Router 7.18.3 | createHashRouter兼容静态统一入口，useBlocker与useBeforeUnload提供成熟导航保护 |
| API状态 | TanStack Query 5.102.8 | 查询缓存、session刷新、请求去重、mutation状态；查询和mutation均明确关闭自动重试 |
| 契约类型 | openapi-typescript 7.13.0 | 从唯一YAML生成请求/响应类型，检查指纹和生成一致性 |
| 交互测试/格式 | Playwright 1.62.1、Prettier 3.9.6 | 真浏览器媒体/DOM验证、可审查格式 |

原生按钮、input、select、range及Audio已足够，不另外叠加重复UI系统。HTTP使用浏览器fetch；小型边界适配器只处理契约特有的CSRF、错误、规则字段及MP3完整性。自写业务代码限于日文正文选区、结构化换行、IME、原字标记、最左最长单轮匹配和提交结果版本关联。

官方依据：[Vite运行要求](https://vite.dev/guide/)、[React DOM内容编辑边界](https://react.dev/reference/react-dom/components/common)、[Radix Dialog](https://www.radix-ui.com/primitives/docs/components/dialog)、[React Hook Form](https://react-hook-form.com/get-started)、[RHF Zod resolver](https://github.com/react-hook-form/resolvers#zod)、[React Router useBlocker](https://reactrouter.com/api/hooks/useBlocker)、[TanStack Query](https://tanstack.com/query/latest/docs/framework/react/reference/index)。已通过本机Node22.12安装、类型检查、构建及运行验证，精确版本以package-lock为准。

## 唯一接口契约

- 文件：`../../docs/openapi.yaml`，OpenAPI 3.0.3 / API **1.1.0**，24个操作（包含五个文章CRUD操作及两个持久音频操作）。
- 当前 SHA256：`16c6c783c77bd55b18cd26de64e261186c971a699ba37bff73b5bd3c075ffa31`。
- 类型：`src/api/schema.d.ts`；来源与指纹：`src/api/contract.json`。
- `npm run generate:api`生成类型；`npm run check:api`同时检查签署指纹及生成文件一致性。契约变更必须通知产品/后端再更新指纹，不自行漂移。

`src/api/http.ts`是正式运行唯一服务实现，`src/types.ts`是UI模型。UI中的`word/version/registrationOpen`在边界明确映射为契约`text/internalVersion/registrationEnabled`，不要求后端复制前端模型。

1. `GET config`取得注册开关和正文码点/UTF-8字节上限；账号只取最小资料。
2. `credentials: same-origin`使用HttpOnly会话；每次写请求携带CSRF token，由浏览器发送同源Origin。登录/退出成功后重新获取token。CSRF失败不会自动重放写操作，下次用户重试重新获取；刷新token失败不把已成功登录/退出伪报成失败。
3. `GET vocabulary?limit=500&offset=0`无搜索条件取得完整投影，校验items与total一致；列表查询/20条分页使用该完整集合。服务端NFC保存规则，文章不normalize；匹配规则保持字面、区分大小写、最左最长、单轮非递归。
4. 保存和删除携带expectedRevision；仅用服务端成功响应更新确认缓存并重新验证列表，失败保留旧状态。409使列表重新读取，仍保留未保存表单，用户关闭重开后基于最新revision修改。
5. 正文合成仅发文章ID、expectedRevision及voice/speed，服务端载入原文；不发owner/tenant/dictionaryIds或预替换读法文本。草稿单词试听走`/v1/audio/preview`且不保存；列表已保存规则试听走临时speech。
6. 音频严格检查audio/mpeg、完整Content-Length（最多8MiB）、MP3头、X-Pronunciation-Version及文件名。完整Blob读取成功后才显示播放器，释放被替换的Object URL；JSON错误不能当音频。下载使用实际Blob及安全MP3文件名。结果使用实际规则版本，正文/语速/音色/规则变化后标为旧音频，在途请求不被新表单状态冒充。
7. 401清除过期CSRF、账户缓存与音频，保留当前正文供同账户重新登录；正常退出和切换其他账户清理正文。其他账户不共享缓存。禁止自动重放计费请求。

## 文章保存与最新音频

文章只保留最后一次显式保存的标题和正文；空正文可以保存，标题trim后1–120 Unicode码点，正文仍受10000码点及49152字节限制。配置返回账户文章上限（默认100），满额错误保留草稿。

内部链接、菜单及浏览器返回/前进都会阻塞未保存导航，可保存并离开、放弃更改或继续编辑；刷新关闭使用浏览器原生提示。保存中继续输入不会被旧响应覆盖；409保留草稿并提供确认后重新载入最新文章。重新打开等待本次GET，不能以旧缓存覆盖服务器新内容。会话失效保留当前文章ID及草稿，同账户重登恢复；其他账户清理草稿及缓存。

主工作区使用`POST /v1/articles/{id}/audio`，只提交expectedRevision/voice/speed，由服务器合成已保存原文；收到JSON记录后以audioId读取完整MP3。生成前先保存，保存失败或期间再编辑则不生成。每篇保留最后成功音频，失败保留原结果。重新打开或刷新恢复音频及实际音色/语速；当前音色不可用仍能播放下载旧音频，生成前须选择可用音色。

正文草稿/已保存正文版本、实际规则版本和所选参数变化时提示过期；仅标题变化不误报。账户/文章/正文编辑代次及请求序号隔离迟到响应。GET核对ID、正文版本、规则版本、长度、MIME、文件名和MP3头；audioId404只重新读取文章记录并最多补取一次音频，不自动合成。首次恢复时的404换ID会同步最新参数，用户途中改过参数则保留其选择；手动“重新载入已保存音频”始终保留当前选择。POST响应丢失可通过此只读按钮恢复已成功保存的音频。

单词候选试听走preview，已保存个人词汇试听走临时speech；都不替换文章音频，候选试听不保存规则。

## 测试与当前边界

```powershell
# 一次性安装测试浏览器（如环境尚无对应Chromium）
npx playwright install chromium
# 启动Vite；契约测试通过Playwright网络拦截提供测试响应，不改正式代码
npm run test:contract
# 文章CRUD、失败/冲突、导航和账户隔离专项（HTTP测试响应）
npm run test:articles
# 持久音频边界/404重取/参数恢复/迟到响应（HTTP测试响应）
npm run test:audio
# 启动真实API3000和隔离PG，开启本地注册后运行
npm run test:integration
# 真实文章CRUD和会话恢复浏览器联调
npm run test:articles:integration
# 启动npm run preview后检查生产资源与刷新
node qa/production-check.cjs
```

独立可控音频联调由后端提供API3002/Origin4182；在另一终端设置`API_PROXY_TARGET=http://127.0.0.1:3002`，运行`node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4182 --strictPort`后执行`npm run test:audio:integration`。此脚本仅用于该隔离环境，会切换`../../runtime/f2-provider-control.json`模拟失败/超限/延迟，finally恢复`{}`并清理测试文章；无需供应商凭据，不调用外部服务。该测试前端占用4182时不能同时启动同端口生产预览。

详细记录与截图见 [QA报告](qa/REPORT.md)。真实联调脚本创建唯一随机测试账号，不读取已有私人账户、不输出或持久记录密码；成功运行后会删除所创建的文章与个人规则，测试账号留在隔离测试数据库。不要对未经授权的生产环境运行注册测试。

已完成React页面、契约接入、真实本地API/PG认证及词汇联调。当前服务没有配置可用日文供应商，音色目录真实为空，生成禁用；直接合成请求返回JSON503。契约测试的真实MP3音调仅用于播放器和二进制协议验收，**不代表真实日文读音、供应商质量或生产部署已验收**。真实移动系统输入法和供应商日文声音仍需具备设备/凭据时补充验证。后端/Gateway任务状态由其维护者核定，前端未修改根TODO或部署文件。
