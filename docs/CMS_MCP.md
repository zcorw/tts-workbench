# 知声 MCP 第一版

知声是 `apps/cms` 独立 CMS 的产品名称；原语音工作台保留原名。两站共享账户、数据库和文章服务。本增量为 ChatGPT 会话提供私有草稿创建，不自动发布或调用收费 TTS，不增加数据库或常驻容器。

## 工具与连接

`/mcp` 使用官方 `@modelcontextprotocol/sdk` 1.32.2 的无状态 Streamable HTTP。逐请求建立服务器实例并验证独立 Bearer，避免账户身份混用。稳定 SDK 协商协议至 `2025-11-25`，也支持较早 Streamable HTTP 版本；尚未实现最新 `2026-07-28` 的无初始化模式，仅支持该模式且不做向下兼容的客户端不能连接。GET/DELETE 返回 405，不提供旧 HTTP+SSE 或后台推送。

| 工具 | 权限 | 用途 |
| --- | --- | --- |
| `list_categories` | `cms:read` | 本人栏目树和标签 |
| `get_article` | `cms:read` | 本人一篇当前工作草稿及元数据 |
| `create_article_drafts` | `cms:drafts:create` | 每批 1–20 篇草稿、按项收据和编辑链接 |
| `get_draft_batch` | `cms:drafts:create` | 查询已登记批次的结果，不返回正文 |

`cms:read` 可读取本人全部工作草稿和分类，第一版没有栏目级授权。授权页逐项说明范围，由本人明确允许；只需创建的客户端可仅申请创建权限。工具不能更新旧文、发布、删除或生成音频；账户隔离和作用域在服务端执行，描述和注解不提供权限。

双端口模式仅 CMS 入口提供机器端点及 OAuth 发现，工作台端口返回 404。Cookie、旧 CMS 读取令牌和管理员密钥均不能授权 MCP；MCP 令牌也不能授权现有 REST API。浏览器同意和撤销继续使用 Session/Origin/CSRF。存在 Origin 时只接受配置 CMS origin；服务器间请求可不带 Origin，不开放通配 CORS。

## 批量与重试

```json
{
  "batchId": "interview-20261105-01",
  "items": [{
    "requestId": "interview-answer-01",
    "title": "自己紹介",
    "text": "日本語の原文をそのまま保存します。",
    "categoryId": null,
    "tagIds": []
  }]
}
```

ID 限 1–100 位 ASCII 字母、数字及 `._:-`，首位为字母或数字。requestId 在**本人账户内跨批次唯一**，不同账户可用相同 ID。batchId 绑定完整不可变输入：对象键序不影响摘要，数组顺序、缺省/显式字段、空白和正文变化均算不同输入。

整体格式、数量、重复 ID、大小先校验；缺失或非法 requestId 会整批拒绝。随后逐篇验证并复用原文章/CMS 事务业务函数，单篇错误不影响其他合法项，失败不保留半篇文章。slug 自动生成，不接受客户端 owner、slug、publish 或音频参数。

- `created`：返回创建时 articleId、slug、版本和编辑链接。同 ID、同输入返回原收据，保留后来手工修改。汇总 `created` 包含重放成功项，不等于本次新增数。
- `error`、`retryable:false`：校验、分类、容量或 ID 冲突等终态错误。修正项须用新 batchId、新 requestId；新批次带原成功项时，保留其原 requestId 和完整输入。
- `pending`、`retryable:true`：尚未处理、取消或结果不明。先查 `get_draft_batch`；仍 pending 时，用**完整不变的原批次和原 ID**重试。

同 batchId 改输入整批拒绝；同 requestId 改输入按项返回 `IDEMPOTENCY_CONFLICT`，均不覆盖文章。批次只存摘要/ID，文章、CMS 元数据和逐篇结果在同一事务提交。提交后响应丢失可查原结果；提交前失败回滚该项并允许原请求继续。收据不存正文，文章删除后仍保留，重试不会重新创建已删除文章。

收据保留至账户删除，不能清空后继续承诺旧请求幂等。每账户最多登记 1000 批次（`MCP_BATCH_LIMIT`）；原 MAX_ARTICLES 继续有效。终态失败不会在后来腾出容量时自动重做。

整包 JSON 最多 1 MiB，工具输入另限 1,040,000 UTF-8 字节，为 JSON-RPC 外壳预留空间。单篇标题最多 120 Unicode 码点，正文最多 10000 码点且 49152 字节；不自动切分。摘要最多 1000 UTF-16 单元，标签最多 50 个且不能重复。每批串行；每进程同时最多两批、同账户一批，跨进程由现有账户行锁保证原子写入。超限 `MCP_BUSY` 可重试；每 IP 每分钟最多 120 个机器端点请求，此限制不是集群全局限流。

取消停止后续项，已提交项保留。没有后台任务，重启后需原请求继续；批次查询中的 pending 不是承诺任务正在后台运行。

## OAuth 与实际启用

**默认 `CMS_MCP_ENABLED=false`。本次交付不改真实配置、不签发真实凭据；新增迁移仅在隔离库验证。** 生产备份/迁移、实际启用、访问范围及公网/Tunnel 暴露须经维护者另行批准。

采用预注册**公共 OAuth 客户端**，client_id 为公开标识，无客户端秘密，不提供开放 DCR 或任意 CIMD 抓取。不要把账户密码、SESSION_SECRET、旧令牌或长期管理员凭据放进 ChatGPT。

经批准后配置如下；回调示意路径必须替换为目标 ChatGPT 连接管理页给出的实际值：

```dotenv
CMS_MCP_ENABLED=true
CMS_PUBLIC_ORIGIN=https://cms.example.com
CMS_MCP_CLIENT_ID=zhisheng-chatgpt
CMS_MCP_REDIRECT_URIS=https://chatgpt.com/replace-with-actual-callback
```

允许最多 10 个逗号分隔的精确 HTTPS 回调，不接受通配符、凭据或片段。需客户端支持预注册公共客户端和 token 认证方法 `none`。若目标账户/工作区 UI 要求客户端秘密且不支持公共客户端，应停止接入并核实能力，不能改为匿名或用管理员密钥绕过。

发现地址：`/.well-known/oauth-protected-resource/mcp`（根路径亦有别名）和 `/.well-known/oauth-authorization-server`。401 返回发现 challenge。授权码 5 分钟，强制 PKCE S256，精确绑定 client_id、redirect_uri、resource；访问令牌最多 15 分钟，授权绝对期限 7 天。刷新令牌轮换且不延长期限；已用授权码/刷新令牌重放会撤销整个授权。每授权最多 1000 个令牌记录，每账户最多 50 个活动授权。

数据库只存令牌 SHA-256 摘要。网站退出不撤销连接，可在“ChatGPT 连接”页撤销或使用 OAuth revocation endpoint。撤销阻止之后调用，进行中的调用可能完成工作；已读取数据无法追溯收回。

禁止应用、反代、APM 保存 Authorization、Cookie、OAuth 正文/响应、授权码回调查询、MCP 正文或完整文章。本应用不记录这些数据，实际反代/APM 需部署时核查。不要用完整请求转储做生产排错。

## ChatGPT 操作顺序

1. 经批准后备份、迁移并配置服务，沿原同容器双端口流程更新。Nginx 模板仅将 CMS `/mcp` 和原导入设置为 1 MiB，其余普通 API 保持 64 KiB；OAuth 应用层限 8 KiB。没有修改真实反代/防火墙。
2. 提供 HTTPS MCP 地址，或目标工作区支持的 Secure MCP Tunnel；本增量不安装隧道或创建公网转发。
3. 在 ChatGPT Plugins 添加自定义 MCP，URL 为 `https://你的知声域名/mcp`，OAuth 选择预注册公共客户端，填公开 client ID 和精确回调配置。界面不支持该模式时停止并核实。
4. 在知声登录本人账户，核对权限后允许连接；回调完成后安装连接并在会话中选用。变更工具定义后刷新元数据。
5. 用虚构文章验证部分失败，再用原 ID 重试检查没有副本。真实内容接入需另行验收。

现有 Vite 只代理 `/v1`、`/health`，其页面端口不是远程 MCP 入口。正式和本次页面测试使用 Node 静态 CMS 入口；只运行开发 API 时须另行保证配置 origin 和授权 UI 的可达性。

## 验收与限制

MCP 测试要求显式 TEST_DATABASE_URL：全新 `zhisheng_mcp_test_20261105*` 库、loopback 或专用 `mcp-qa-db` 主机；也兼容仓库已有 CI 专用 `cms_reading_test_20261027` 库名，以便原 `npm test` 同时运行全部用例。原测试的固定库名保护没有改动。本次在**新建独立 PG 容器**另建同名空库运行，没有连接旧 QA 容器/卷或生产数据。不要对任何已有业务库运行测试。证据见 [MCP 验收记录](CMS_MCP_VALIDATION.md)。

未执行真实 ChatGPT 连接/回调、公开 HTTPS/TLS、Tunnel、VPS、生产迁移或真实供应商调用。本地官方 SDK 互操作不代表目标 ChatGPT 工作区能力已经验收，目前没有已部署的可用连接。

依据（2026-11-05）：[OpenAI 身份验证](https://developers.openai.com/plugins/build/auth)、[连接与测试](https://developers.openai.com/plugins/deploy/connect-chatgpt)、[MCP 授权](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)、[当前 HTTP 与兼容](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)、[官方 SDK](https://github.com/modelcontextprotocol/typescript-sdk)。
