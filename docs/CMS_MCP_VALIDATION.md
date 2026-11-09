# 知声 MCP 验收记录 · 2026-11-05

代码完成于 `D:\Workspace\github\tts-workbench` 的 `feat/cms-content-platform` 分支。没有提交、推送、合并、部署、迁移真实数据、创建真实凭据、改变真实安全配置或调用收费 TTS。

## 结果

| 验证 | 结果 |
| --- | --- |
| API TypeScript / Node 22.23.4 | 通过 |
| 原后端 HTTP/PostgreSQL 回归 | 54/54，0 跳过 |
| 新 MCP/官方 SDK/OAuth/批量错误测试 | 21/21，0 跳过 |
| 标准 `npm --prefix apps/api test`（最终源码、同一 CI 专用空库） | 75/75，0 跳过 |
| 知声桌面/390px 浏览器流程 | 7 组通过，0 pageerror |
| 原工作台现有 React 浏览器回归 | 22 组通过，包括 1440/390/320 布局 |
| 工作台、知声构建和类型检查 | 通过 |
| 双前端格式、增量 API 格式 | 通过 |
| OpenAPI 1.5.0 | 64 个操作通过验证，生成类型及摘要一致 |
| vendor 版本包完整性 | 通过 |
| `npm audit --omit=dev --json` | 未执行；自动审批拒绝披露运行时依赖树给 npm 公共审计服务 |

MCP 测试覆盖：默认关闭、错误配置、发现与 Origin、Cookie/旧令牌不能认证、Session/CSRF 同意、精确回调/resource/作用域、PKCE、授权码重放、官方 SDK 初始化和工具元数据、本人分类及跨账户拒绝、按项失败、20 篇边界、文章容量、未知/非法字段、超长/控制字符/超大 JSON、错误方法/协议、原输入重放、手工编辑保留、跨批次去重、跨实例竞争、并发入口上限、提交后结果丢失、提交前回滚、删除后重试、取消恢复、刷新轮换/并发重放、过期/停用账户、本人撤销、摘要存储、双端口隔离及重启恢复。

浏览器使用真实本地 API/PG：登录保留授权回跳、显示完整读取与创建范围、PKCE 同意及虚构回调、批量部分成功/重试/查询/编辑链接、页面撤销令牌失效、非法授权禁止批准、手机无横向溢出。ChatGPT 回调被测试拦截，没有连接真实 ChatGPT 账户。审查了桌面与手机截图。

## 隔离与证据

使用新建内部 Docker 网络和 `mcp-qa-db` 临时 PG 容器，没有宿主数据库端口和持久卷。MCP 数据库为 `zhisheng_mcp_test_20261105`；原回归为适配其固定库名，在该**全新容器**另建 `cms_reading_test_20261027` 空库。没有连接旧同名 QA 数据库。真实供应商调用在测试中由既有夹具替代；MCP 页面 fixture 禁止外部 fetch。

构建/后端为缓存 QA 镜像 Node 22.23.4；宿主 Node 22.12.0 只做静态编译与格式检查，不作为运行验收基线。浏览器控制器为 Playwright 1.62.1，使用缓存 Playwright 1.57 镜像的 Chromium 可执行文件（通过显式路径）；浏览器脚本运行于该镜像 Node 24.11.1，非后端运行时。未验证物理手机。

证据位于本次任务目录 `C:\Users\zhzhw\Documents\Codex\2026-11-05\task-2`：

- `mcp-tests.log`：21 个 MCP 测试最终结果。
- `api-regression.log`：54 个原后端回归最终结果。
- `api-final-all.log`：最终源码以原标准命令执行全部 75 个测试。
- `static-validation.log`：构建、类型、格式、契约及版本包验证。
- `browser-tests.log`、`evidence/mcp-browser.json`：7 组真实页面流程。
- `web-regression.log`、`evidence/react/`：22 组原站浏览器回归。
- `evidence/mcp-consent-desktop.png`、`mcp-consent-mobile.png`、`mcp-connections-mobile.png`、`zhisheng-articles-desktop.png`：虚构数据截图。

首次合并运行时，4 个原测试因其固定测试库名保护拒绝执行；已改为上述全新容器内专用空库运行，未放松原测试保护。新 MCP 测试同时兼容仓库既有 CI 专用库名，标准命令最终 75/75 通过。首次 MCP 测试中的音频表查询写错由测试修正。契约生成和旧站脚本挂载的验收环境问题均已解决；最终结果按表列记录。

## 实测边界与后续

当前没有已部署的真实连接。启用时须备份/演练新增迁移，审批账户读取范围、精确 OAuth 回调、HTTPS 或 Tunnel，并在目标 ChatGPT 账户验证预注册公共客户端/`none` 是否可用。不能把 Cookie、长期管理员密钥或匿名接口当作替代认证。

官方 SDK 1.32.2 支持协商至 MCP `2025-11-25`；未实现 `2026-07-28` 无初始化模式。详见 [连接与限制](CMS_MCP.md)。尚未实测公网 TLS/反代、Tunnel、真实回调、生产迁移、VPS 内存和生产并发。

前端保留原有大于 500 kB 的构建提示。完整运行时依赖审计被自动审批拦下，不能声称依赖树无漏洞。若获准向 npm 公共服务发送包名/版本树，可另行完成审计；本次没有通过间接执行绕过该限制。
