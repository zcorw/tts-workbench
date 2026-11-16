# 知阅语音检索配套接口 · 2026-11-15

2026-11-16 已增加文章 status 筛选；草稿/全部的分类映射与分页沿用显式状态，默认已发布。下文仅发布范围为原版本，当前行为及上线迁移见[文章状态筛选](ZHIYUE_ARTICLE_STATUS.md)。

用户已授权本轮修改知声设备只读接口。改动只涉及文章分类/关键词筛选和识别文本检索；不部署、不签发密钥，不改变设备授权协议或网页安全配置。2026-11-15 为解决 PR #12 冲突，已将主线 110a542 整合到当前功能分支，保留确认/续期协议与语音检索；未合并 PR 到 main 或部署。

## 接口

- GET /v1/zhiyue/read/articles 保留 limit/offset，新增 q（最多120字符）和 category（精确发布分类 UUID 或 uncategorized）。列表及详情新增冻结 category，列表返回 navigation。复用 CmsService 当前账号发布范围及直接归属语义，不读草稿分类，不扩大到子分类。
- POST /v1/zhiyue/read/search 接收 JSON { "text": "查看科技分类" }，text 为去除两端空白后1至200字符，正文限制1024字节。要求当前有效设备 Bearer；每 IP 每分钟12次。
- 返回首个分页（limit12、offset0）及 kind、filters、label、noMatch、resolvedBy。filters 用于后续普通 GET 分页；不重复调用语义模型。唯一文章是否跳转由知阅客户端负责。
- 语义等待结束后再次验证设备授权。未知或重名分类返回空结果，不用空 category 扩大到全部文章。

## OpenAI

可选设置 ZHIYUE_OPENAI_API_KEY 与 ZHIYUE_OPENAI_MODEL，二者都存在才启用。模型须支持 Responses 严格 JSON Schema，按实际账号模型权限和预算配置，不在源码中固定模型。无密钥时基础解析可用。超时、错误、拒答或无效结构回退基础解析，resolvedBy 标记 fallback；无密钥标记 local。

固定请求目的地为 https://api.openai.com/v1/responses，禁止重定向，store=false，6秒独立截止时间覆盖响应体。只发送用户已授权的 Rokid 识别文本和通用解析指令；分类目录、文章正文、音频、账号及设备凭据不外发。模型只生成 kind/q/categoryName，服务端在当前授权发布分类及历史名称中映射；模型不能授予额外访问权限。应用代码不记录识别文本，不承诺第三方零保留。

首次拟把分类名称表作为上下文的写入被自动审批拒绝，原因是该元数据外发未获明确授权；已改为上述仅识别文本的路线。没有配置真实凭据或付费调用。

## 验证与后续

2026-11-15 主线整合后 TypeScript 构建、工作台/CMS 类型检查、OpenAPI 1.8.0 的82个接口及生成类型/指纹校验通过。一次性 PostgreSQL 中设备确认/续期、迁移、CI固定客户端真实HTTP联调和语音检索专项合计13项通过、0跳过。全部为虚构测试数据，OpenAI 使用模拟响应。真机、真实 OpenAI、PR合并与部署仍另行验收。知阅操作和验证记录位于 D:/Workspace/github/zhiyue/docs/stage-08-voice-search.md。
