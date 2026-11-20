# PR #12 冲突整合 · 2026-11-15

在现有 feat/cms-content-platform 分支将 origin/main 的 110a542 合入；未合并 PR 到 main，也未部署。保留原语音检索提交 676efe6 的功能及主线设备授权更新。

## 冲突与处理

- scripts/write-contract.mjs：保留主线 1.8.0 版本与新版设备确认、刷新和升级契约，同时保留 addZhiyueSearchContract 调用。
- apps/web/src/api/contract.json：从整合后重新生成的 OpenAPI 计算 SHA-256，保留 1.8.0；不沿用任何一侧旧指纹。
- 重新生成 docs/openapi.yaml 和 apps/web/src/api/schema.d.ts，包含82个接口。自动合并的应用生命周期、设备路由、迁移和联调测试也已核对。
- 主线 PR 检查保留，并将语音检索专项加入同一隔离数据库检查命令。

## 本地验证

- OpenAPI 校验、生成类型与指纹一致性通过。
- API TypeScript 编译、工作台与 CMS 类型检查通过。
- 一次性 PostgreSQL 17 内，设备授权、CI锁定的 ee5d319 客户端真实HTTP和语音检索专项共13项通过，0跳过。
- 原有部署、SSH及运维文件的未提交内容按 SHA-256 核验保留，不纳入整合提交。
- 不涉及真实账号、生产数据库、真实 OpenAI 调用、AIX或真机。远端PR可合并状态和CI在推送后另行核对。
