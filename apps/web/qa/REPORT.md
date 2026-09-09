# F2 最新成功音频验收记录（2026-09-10）

本节是当前结果；以下F1和更早记录为历史。API仍固定1.1.0/24操作，指纹未变。主工作区已接入文章持久音频POST JSON + GET MP3，个人词汇试听仍用独立临时接口。

## 本轮验证（计数直接读取结果JSON）

| 命令 | 组数 | 结果文件 |
|---|---:|---|
| test:audio | 13 | audio-artifacts/results.json |
| test:audio:integration | 8 | audio-integration-artifacts/results.json |
| test:articles | 22 | articles-artifacts/results.json |
| test:contract | 22 | react-artifacts/results.json |
| test:articles:integration | 10 | articles-integration-artifacts/results.json |
| test:integration | 13 | integration-artifacts/full-results.json |

六套全部通过，浏览器errors=[]。build（含typecheck）、check:api、format:check通过。主bundle约536kB/gzip168kB，Vite体积提示不影响构建成功。契约校验临时文件增加进程ID，避免并行套件互相覆盖或删除检查文件。

音频专项覆盖：刷新恢复而不重复POST、标题/正文/实际规则版本及参数过期、失败保留、GET错误ID/正文版本/规则版本/长度/MIME/文件名拒绝、404换ID最多补取一次、连续404停止、用户设置不被迟到恢复覆盖、正文编辑代次和跨文章隔离、丢失POST响应只读恢复、不可用音色仍可播放下载、移动布局。首次404恢复特意使用旧0.85/old-voice→新1.23/qa-ja，验证确实更新参数；手动重载保留当前选择。

真实联调在4182→API3002/PostgreSQL执行，未拦截浏览器HTTP；后端使用进程内可控transport，完整MP3为40585字节，与qa/tone.mp3 SHA256一致。已验证合法1.15语速（产品修复Gateway0.1.1之后）、真实解码播放/下载、刷新恢复、唯一替换后的旧audioId404、transport失败及超8MiB保留旧音频、延迟成功不覆盖正在编辑草稿、只读恢复及文章/音频删除。测试文章已清理，随机账户仍在隔离数据库，控制文件runtime/f2-provider-control.json已在finally恢复{}；没有写入或展示凭据，没有外部供应商或付费请求。

已视觉核对`audio-integration-artifacts/restored-desktop.png`、`audio-integration-artifacts/stale-mobile.png`及协议测试的`audio-artifacts/restored-desktop.png`/`restored-mobile.png`。截图从页首捕获，保存状态、播放器、参数与过期提示清楚，无横向溢出。

本轮apps/web新增useArticleAudio、音频协议/真实联调及共享测试响应文件；更新API边界、文档状态读取、工作区/播放器/列表音频状态、既有测试适配和README。本轮未更改冻结契约、后端或Git；唯一额外写入为后端明确授权的忽略目录测试控制文件。日文供应商发音质量与远程部署仍未验收。

---

# F1 文章管理验收记录（2026-09-10）

本节为本轮结果；下方早期记录保留作历史。API固定1.1.0，指纹16c6c783c77bd55b18cd26de64e261186c971a699ba37bff73b5bd3c075ffa31。前端仅接入五个文章CRUD操作，未接入F2持久音频。

- `npm run test:articles`：22组通过，`articles-artifacts/results.json`，errors=[]。覆盖空列表/搜索/分页/创建与容量、保存失败及409恢复、保存中再编辑、保存中再编辑停止合成、新文章一次点击先保存再临时生成、按钮/链接/浏览器前进返回阻塞、真实beforeunload取消、重新打开取新服务端内容、401同账户草稿恢复、跨文章迟到读取与换账户隔离、删除503/409及末页回退、390/320布局。
- `npm run test:articles:integration`：10组真实浏览器HTTP/PostgreSQL通过，`articles-integration-artifacts/results.json`，errors=[]。没有网络拦截，验证空草稿、原字符/组合字符/emoji和刷新恢复、120码点标题、真实409、外部修改重开、真实会话失效和重登恢复、搜索、删除404、退出。成功运行创建的文章已清理，随机测试账户留在隔离数据库；调试失败的两次运行可能留下各一篇隔离测试文章。脚本不记录账号密码。
- `npm run test:contract`：适配文章路由后的既有React回归22组通过，`react-artifacts/results.json`，errors=[]。保留登录/密码、规则CRUD/全量投影/分页、IME/多行、草稿读法试听不保存、MP3播放/暂停/停止/下载、过期/失败与无自动重试、账户隔离及布局焦点等检查。
- `npm run test:integration`：既有真实账号/个人读法联调13组通过，`integration-artifacts/full-results.json`，errors=[]；测试生成的文章和规则已清理。
- `npm run test:password`：实际4181页面登录及注册7位拒绝/8位放行通过。
- `npm run build`（含typecheck）、`npm run check:api`通过。Vite提示主bundle约523kB（gzip约165kB）的体积警告；构建成功，未为此改变功能阶段。

交互实现使用React Router createHashRouter/useBlocker/useBeforeUnload、TanStack Query、现有Radix弹窗与Zod验证。正文顶部仅展示真实保存状态，移除原“未保存的文章”固定标签，标题输入与正文展示ID互不重复。401读请求会丢弃旧CSRF缓存，以便同账户重登取得匿名会话token；不自动重放写请求。

已查看截图：`articles-integration-artifacts/articles-desktop.png`（真实搜索列表）、`articles-integration-artifacts/article-mobile.png`（真实390px编辑）、`articles-artifacts/unsaved-navigation.png`（离开保护）、`articles-artifacts/save-conflict.png`（草稿冲突）。列表与编辑无横向溢出，保存状态与临时音频说明清楚。

运行服务保留：前端4181，后端隔离API3000（后端维护）。音色供应商未配置；临时MP3音调仅为自动化播放器验证，不代表日文供应商语音或部署验收。F2音频持久恢复、唯一成功音频替换及相应并发验证等待产品下一阶段放行。本轮前端未执行Git操作。

---

# React + OpenAPI 前端验收

日期：2026-09-06。当前前端为React正式HTTP入口，旧原生模板证据已归档到`../reference/qa`，不混为本阶段结果。

## 通过记录

- `npm run typecheck`：strict及未使用变量/参数检查通过。
- `npm run build`：Vite生产构建通过，CSS约26.4kB、JS约456kB（gzip约144kB）。
- `npm run check:api`：已签署OpenAPI1.0.0指纹与生成TS类型一致。
- [22项契约交互检查](react-artifacts/results.json)：React Router保护、RHF/Zod字段限制、CSRF轮换、正文原字与同词投影、持久复用、503失败保留、409冲突、草稿试听、完整真实MP3播放/暂停/停止/下载、旧音频/错误MIME/不自动重试、在途快照、CRUD、20条分页与完整投影、多行emoji/IME、长文/空正文、账户资料、1440/390/320布局、Radix焦点/Escape、会话/账户隔离、注册关闭、正式入口不写本机数据。
- [真实API与PG联调](integration-artifacts/full-results.json)：无HTTP替身；注册201、登录与Cookie、显示名称PATCH及刷新、登录/退出CSRF轮换、退出后me401；正文规则POST和当前两处命中、新文章及刷新复用、外部真实PATCH后UI实际409、删除204集合版本、无效CSRF403、未配置语音503 JSON。没有伪造音频成功。
- [生产资源检查](integration-artifacts/production-preview.json)：生产JS/CSS返回200或有效缓存304，全部hash路由直达/刷新保持未登录保护，无页面异常。

## 代表截图

优先查看真实API结果：[账户](integration-artifacts/account.png)、[个人读法](integration-artifacts/rules.png)、[正文读法弹层](integration-artifacts/reading.png)、[手机工作台](integration-artifacts/mobile-workbench.png)。

契约测试布局：[登录](react-artifacts/login.png)、[无音色工作台](react-artifacts/workbench-no-voice.png)、[桌面规则](react-artifacts/rules-1440.png)、[手机规则](react-artifacts/rules-390.png)、[320px读法弹层](react-artifacts/reading-320.png)。其中有音色的契约测试截图使用明确标注的QA音色；该目录不是生产供应商效果证据。

## 修复与验证范围

React迁移保留了已验收视觉和交互。正文读取继续使用结构化DOM序列化，防止原型innerText空行膨胀；React不在IME期间重写编辑DOM。已有手写通用表单/路由/请求状态已由RHF/Zod、React Router、TanStack Query替代；Radix负责弹层和键盘约束。补充了跨账户缓存/正文清理、响应实际规则版本、MP3完整性、错误MIME拒绝和资源释放。

契约音频夹具`tone.mp3`由ffmpeg对5秒440Hz正弦波编码，包含真实可解码MP3字节。它只在Playwright HTTP拦截中使用，不被应用导入，不是日文声音。应用构建不包含QA夹具或reference旧版。

真实后端环境仍未配置日文供应商凭据；目前音色为空、合成503是正确状态。真实日文读法效果、不同系统输入法/设备以及生产Nginx/VPS上线不由本次前端测试假定完成。

## 产品有界复核

产品经理于本阶段只读核对源码、截图、22项契约检查及13项真实API/PG检查，结论通过，无必须修复项；并独立只读确认后端live/ready/config为200、语言ja-JP、未登录me401、前端4181为200。确认正文直接修音、同词唯一默认、成熟库实际使用、失败/409保留、实际快照版本及无本地账户/假音色兜底。该结论不覆盖真实供应商日文听音、部署/恢复或独立Nest消费者验收。

## 密码原生属性回归修复（2026-09-06）

API1.0.1及Zod已为8–128，但AuthPage密码input曾残留minLength=12，dist也保留该属性。修复前实际4181页面中8位密码的validity.tooShort=true；因为表单noValidate，旧契约测试仍可发出请求，因此仅断言请求提交漏掉了原生属性不一致。

现将密码上下限集中为forms.ts的passwordPolicy，Zod校验、input minLength/maxLength及placeholder共用。重新构建后源码和dist均无12位密码限制。新增`npm run test:password`，在实际服务页面上验证登录和注册的原生属性、7位无请求、8位checkValidity=true并提交；测试只拦截认证响应，不创建账户或读取私人数据。

开发服务4181与新dist预览4182均通过，结果分别见[开发页](password-artifacts/4181-results.json)、[生产构建页](password-artifacts/4182-results.json)。build（含typecheck）、format:check及API1.0.1指纹/生成类型检查通过。开发服务通过Vite加载新代码，无需重启；已有标签页可Ctrl+F5刷新。
