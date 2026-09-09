# 开发任务清单

状态：v0.9，实现与本地联调已交付。30项任务中26项完成、T023部署外部验收待续、T024真实日文音频受供应商条件阻塞，T025/T027两项P2本轮不执行。无Git提交、推送或真实VPS部署。

## Project Summary

独立NestJS账户工程（拟D:/Workspace/github/nest-account，名称暂定）与Gateway、tts-workbench平级，各自仓库边界独立。应用通过明确版本构建包组合账户和Gateway，实现日文语音合成。核心闭环为输入文章→生成并听→正文选词编辑指定读法→标记与保存→重新合成验证；原文保持不变。词汇→指定读法的增删改查、试听、整段文本自动应用仍为MVP，独立词汇页仅辅助。保存即生效，无人工发布。释义/例句/词性/查词等完整字典非目标；alias为团队最小实现建议，IPA/复杂规则后续。

## Source Documents Reviewed

- [README](README.md)：工程职责与最新轻量读法定位。
- [PRODUCT_SPEC](docs/PRODUCT_SPEC.md)：用户确认、19个功能ID、Q-08/Q-09已关闭及原剩余决策。
- [DECISIONS](docs/DECISIONS.md)：实际双向交流和新确认取代中间普通试听基线。
- [ARCHITECTURE](docs/ARCHITECTURE.md)：读法模型、请求时内部快照、自动应用、真实限制。
- Gateway只读源码及HEAD见架构第2节；固定not_found reader必须接入，本清单不把普通无规则分支当满足需求。
- 继续遵循docs-to-dev-todolist技能及references/todolist-output.md；无不可读材料。TODO按最新产品反馈收敛，精确版本在实施时验证。

## 已确认部署方式

Docker Compose部署组合应用，GitHub Actions远程部署到VPS；整个栈仅发布一个显式绑定127.0.0.1的宿主端口，由宿主Nginx统一代理页面/API/音频并负责外部TLS，内部服务无额外host ports。复用T023，不新增重复任务。端口值/VPS/域名/镜像仓库/触发策略等是实施参数，不再重新选择部署平台。本轮允许编写部署配置，但不执行远程部署。

## Key Requirements

- EDIT-01/02：正文直接选词、读法表单、可见标注、查看改删；文本变动锚点维护与旧音频提示。
- 正文标记是个人规则匹配投影；保存默认写个人规则，影响当前同词各处及以后文章；不额外生成局部标注。
- 默认复用全局alias合成；位置sub/prosody编译降为可选T027，无用户SSML、自动错音识别或音文同步。

- 账户开通、登录认证、退出、独立包在第二Nest宿主复用。
- 词汇与指定读法CRUD，保存后试听和整段合成自动使用本人规则。
- 一账户一份内部集合，保存事务递增internalVersion，请求一致读取后生成不可变快照；无用户发布。
- 身份/集合/记录所有权隔离；音色权限、CSRF、资源和错误边界。
- JPN-01：ja-JP音色/配置/路由/SSML/个人快照执行链为MVP；现有zh-CN硬编码必须迁移，不能改标签冒充支持或以中文完成验收。
- 保存词汇读法属于持久业务数据，临时整段输入/音频默认不持久化。

## Questions / Assumptions

| 入口 | 状态与范围 | 受影响任务 |
|---|---|---|
| Q-01a/b | **已关闭**：需要设置词汇读法，并用于整段文本；不再作为实施待确认项 | DICT-01～03均为MVP，T013/T014/T016/T019/T024 |
| Q-02 | 登录标识/人群/注册；建议受控开通、公众注册默认关闭 | T005、T007、T008、T017、T023 |
| Q-03 | 客户端/共享登录；建议同源浏览器 | T006、T008、T011、T017～T019、T023 |
| Q-04 | DB/ORM/成熟认证库；建议PostgreSQL+opaque Session | T002～T008、T013、T016 |
| Q-05 | 仓库边界已确认：账户独立工程，与Gateway/应用平级；账户名称/包scope/分发及前端仍待选，应用内部可workspace | T002、T009、T010、T017～T020、T023 |
| Q-06 | 是否存合成历史；默认不存，仍持久化词汇读法 | T018、T021、T023 |
| Q-07 | 数据保留/备份、Session时长、规模与成本阈值 | T006、T021～T024 |
| Q-08 | **已关闭**：正文修改默认保存个人规则，应用当前及以后文章 | T026/T028/T029默认个人写入与跨文章验收；T027仅可选“此处”扩展 |
| Q-09 | **已关闭**：日文语音合成为整个项目当前主要目标 | JPN-01、T030/T031及日文端到端MVP，具体voice/adapter为实施选型 |

alias/literal/区分大小写与500条为简洁建议，日文原词/读法实际能力必须验证；不强制假名、拼音、IPA或音高表示。中文硬编码是MVP待迁移缺口；非日文语言可后续，日文不是后续。

## 修订与取消记录

| ID | 当前处理 |
|---|---|
| T013/T014/T019 | 保留ID，改为词汇+读法、保存即生效和自动应用界面，无旧草稿/发布模型 |
| T015 | **取消，不执行**：原子用户发布、幂等发布、发布指针和版本选择不属于需求 |
| T016 | 保留P0并简化为请求时内部快照和本人整段应用；最新确认后不再是条件P2 |
| T009/T010 | 保留正式库出口/reader注入及必要空match安全回归、宿主边界 |
| T021/T022/T024 | 包含读法生效、修改删除、在途快照及隔离，不仅普通朗读 |

T015取消不勾成已完成，内部快照不意味着重新启用该任务。

## 本次增量重审

T026保留正文选区、个人规则派生标记及音频实际版本；T028默认先写个人规则成功再生成；T029验证当前/以后文章与失败行为。T027位置编译API降P2可选，T028/T029不再依赖它。默认不生成局部标注，也不调用/editor/speech。T015继续取消。此前默认保存确认继续有效；本次新增T030/T031日文P0前置，T012依T030、T016依T031，真实日文smoke不可省略。产品v0.6已读后收敛。

## 本次仓库边界修订

账户工程独立根、工具链、构建测试文档与包版本为确定要求。T002/T003～T006/T020修改原任务落点，不新增重复任务；T007/T008仍属宿主应用HTTP/运维。`D:/Workspace/github/nest-account`只是建议路径，本轮已创建并按0.1.0打包；账户内保留core/adapter多包，但不得依赖应用工作区。应用安装明确版本tgz或私有registry产物，不使用跨仓src/path aliases/workspace:*作为正式依赖，不强制公开npm。未来可推Git不是本轮init/remote/commit/push授权。

## Development TodoList

- [x] T001 [P0] 冻结已确认闭环与运行决策
  - 功能来源：PRODUCT_SPEC ACC-01、ACC-02、DICT-01、DICT-02、DICT-03、DATA-01、OPS-01；ARCHITECTURE及DECISIONS最新用户确认。
  - Goal / 实施要点：词汇设置读法并用于整段合成已确认，Q-01a/b关闭；记录alias最小方案和Q-02～07实施选型/参数，不再把整段应用列可选。
  - 拟涉及路径：docs/PRODUCT_SPEC.md、docs/DECISIONS.md、docs/ARCHITECTURE.md。
  - Depends on: None.
  - 验收与 Verify：确认范围映射为词汇→指定读法→整段生效，无手动发布；其余选型有可执行决定与数值。

- [x] T002 [P0] 建立账户独立工程与应用自身工具链
  - 功能来源：PRODUCT_SPEC INT-01、INT-02、OPS-01；ARCHITECTURE第1～4节及DECISIONS v0.7。
  - Goal / 实施要点：未来实施时账户在独立nest-account根自有package/锁文件/tsconfig/CI/build/test/docs/打包检查；内部core/adapter多包可保留。tts-workbench仅组织自己的api/web。验证ESM/Node/Nest兼容，不把账户绑应用workspace。
  - 拟涉及路径：D:/Workspace/github/nest-account/{package.json,tsconfig*.json,docs,CI配置,packages/*/package.json}；D:/Workspace/github/tts-workbench/{package.json,apps/*/package.json,CI配置}。
  - Depends on: T001.
  - 验收与 Verify：仅签出账户目录即可安装构建测试打包；自有public exports/types，发布清单无应用/秘密；应用消费版本包而非兄弟src/workspace:*；账户工程已创建；不执行Git提交或推送。

- [x] T003 [P0] 定义账户公共契约与可注入模块
  - 功能来源：PRODUCT_SPEC ACC-01、ACC-02、ACC-03、ACC-04、INT-01；ARCHITECTURE 对应设计，DECISIONS 待决选择。
  - Goal / 实施要点：实现 AccountModule.registerAsync、服务/主体/显式错误，以及账户、Session、事务、密码、时钟、随机数端口；无 TTS 依赖和导入副作用。
  - 拟涉及路径：D:/Workspace/github/nest-account/packages/account-core/src/{domain,application,ports,nest,index.ts}。
  - Depends on: T002.
  - 验收与 Verify：仅用内存端口编译并注入服务；没有 Express、TTS、数据库或隐式全局 Guard 依赖。

- [x] T004 [P0] 实现账户和会话持久化适配
  - 功能来源：PRODUCT_SPEC ACC-01、ACC-02、ACC-03、INT-01；ARCHITECTURE 对应设计，DECISIONS 待决选择。
  - Goal / 实施要点：按选定 PostgreSQL 方案实现 accounts/sessions 唯一约束、事务、会话摘要、过期索引及显式迁移；若选型变化先修订设计。
  - 拟涉及路径：D:/Workspace/github/nest-account/packages/account-postgres/src/、D:/Workspace/github/nest-account/packages/account-postgres/migrations/。
  - Depends on: T003.
  - 验收与 Verify：临时数据库迁移可重复执行；并发重复 login 仅一条成功；撤销与禁用原子；库 import 不自动迁移。

- [x] T005 [P0] 实现账户创建与凭据验证
  - 功能来源：PRODUCT_SPEC ACC-01、ACC-02、SEC-01；ARCHITECTURE 对应设计，DECISIONS 待决选择。
  - Goal / 实施要点：统一规范化登录标识、密码策略和成熟哈希库；创建/验证用例返回最小资料，错误不泄露凭据；参数按选定环境基准确定。
  - 拟涉及路径：D:/Workspace/github/nest-account/packages/account-core/src/application/、D:/Workspace/github/nest-account/packages/account-postgres/src/。
  - Depends on: T004.
  - 验收与 Verify：正确/错误密码、并发唯一冲突和异常输入均按契约；DB与日志无原始密码。

- [x] T006 [P0] 实现 Session 生命周期与账户禁用
  - 功能来源：PRODUCT_SPEC ACC-02、ACC-03、ACC-04、SEC-01；ARCHITECTURE 对应设计，DECISIONS 待决选择。
  - Goal / 实施要点：登录创建随机 opaque Session，仅存摘要；解析校验账户状态/空闲及绝对过期；退出撤销当前会话，禁用撤销全部会话；返回当前账户。
  - 拟涉及路径：D:/Workspace/github/nest-account/packages/account-core/src/application/、D:/Workspace/github/nest-account/packages/account-postgres/src/。
  - Depends on: T005.
  - 验收与 Verify：可控时钟验证双过期；已退出/禁用 token 的下一次受保护请求失败；并发登录/禁用不留下可用会话。

- [x] T007 [P0] 提供受控账户开通及禁用命令
  - 功能来源：PRODUCT_SPEC ACC-01、ACC-03、OPS-01；ARCHITECTURE 对应设计，DECISIONS 待决选择。
  - Goal / 实施要点：由应用安全运维 CLI 调用独立账户包公共用例，默认关闭公众注册；无管理后台或公开禁用路由；密码交互输入并记录脱敏审计。
  - 拟涉及路径：D:/Workspace/github/tts-workbench/apps/api/src/operations/、D:/Workspace/github/tts-workbench/docs/operations.md。
  - Depends on: T006.
  - 验收与 Verify：部署运维环境可创建/禁用账户，CLI退出码明确；命令历史/输出无密码；普通 Web 用户无法执行运维能力。

- [x] T008 [P0] 实现账户 HTTP 与 Cookie/CSRF
  - 功能来源：PRODUCT_SPEC ACC-01、ACC-02、ACC-03、ACC-04、SEC-01；ARCHITECTURE 对应设计，DECISIONS 待决选择。
  - Goal / 实施要点：宿主消费独立账户包并实现 /v1/auth/csrf、register、login、logout、me；默认关闭register；Cookie安全属性、登录轮换、Origin与CSRF、限流及统一账户错误。
  - 拟涉及路径：D:/Workspace/github/tts-workbench/apps/api/src/auth/、D:/Workspace/github/tts-workbench/apps/api/src/bootstrap/。
  - Depends on: T006.
  - 验收与 Verify：浏览器登录/me/退出闭环通过；跨站登录、缺CSRF、伪造/过期Cookie被拒绝；重放退出cookie失败；注册关闭403，开启后合法创建→登录通过且重复标识并发仅一条成功。

- [x] T009 [P0] 在 Gateway 仓库建立正式库入口
  - 功能来源：PRODUCT_SPEC INT-02；ARCHITECTURE及DECISIONS最新用户确认。
  - Goal / 实施要点：未来另行授权公开合成/目录/健康、Actor和DictionaryReader/Snapshot、exports/types/files及配置入口，保留独立宿主。
  - 拟涉及路径：D:/Workspace/github/TTS-gateway/package.json、该仓库src/index.ts及src/modules/tts/tts.module.ts。
  - Depends on: T002.
  - 验收与 Verify：消费者只用打包产物即可导入/注入公共契约，无源深路径或测试overrideProvider依赖。

- [x] T010 [P0] 完成 Gateway reader注入与宿主边界
  - 功能来源：PRODUCT_SPEC INT-02、INT-03；ARCHITECTURE及DECISIONS最新用户确认。
  - Goal / 实施要点：未来授权后替换固定not_found reader、异步配置、可选HTTP或公开映射适配；缩小filter/parser作用域和资源所有权；恢复必要规则引擎空match防护。
  - 拟涉及路径：D:/Workspace/github/TTS-gateway/src/modules/tts/tts-runtime.factory.ts、该仓库api/http-boundary.ts及tts.module.ts。
  - Depends on: T009.
  - 验收与 Verify：真实reader可进入非空dictionaryIds合成；空match立即拒绝且不循环；账户/词汇错误不被改写，共享观测不提前关闭，初始化失败清理有效。

- [x] T011 [P0] 接通宿主身份到 TTS 权限
  - 功能来源：PRODUCT_SPEC TTS-01、TTS-02、INT-03、SEC-01；ARCHITECTURE 对应设计，DECISIONS 待决选择。
  - Goal / 实施要点：异步认证后写入可信 request.actor；个人 tenant 服务端生成，权限按已授权音色精确映射；保留同步 Guard，显式注册DI顺序。
  - 拟涉及路径：apps/api/src/auth/、apps/api/src/tts/、apps/api/src/bootstrap/。
  - Depends on: T008.
  - 验收与 Verify：未登录401；伪造body/header actor无效；无合成/指定音色权限拒绝；真实数据库会话认证在Guard之前完成。

- [x] T012 [P0] 接入日文正文与词汇共用合成边界
  - 功能来源：PRODUCT_SPEC TTS-01、TTS-02、DICT-02、DICT-03、JPN-01、INT-02、INT-03；ARCHITECTURE第11节及DECISIONS v0.6。
  - Goal / 实施要点：安装完成日文适配的Gateway包；应用显式ja-JP与授权日文音色，绑定本人集合；语言/voice冲突拒绝，不信客户端dictionaryIds，保留MP3/取消。
  - 拟涉及路径：apps/api/src/tts/、apps/api/src/bootstrap/、apps/api/package.json。
  - Depends on: T010, T011, T030.
  - 验收与 Verify：日文短句返回MP3；目录与真实日文能力一致，无中文fallback；未授权音色/伪造集合拒绝；完整日文读法应用由T016验证。

- [x] T013 [P0] 建立词汇读法与内部集合模型（替代草稿版本表）
  - 功能来源：PRODUCT_SPEC DICT-01、DICT-03、DATA-01；ARCHITECTURE及DECISIONS最新用户确认。
  - Goal / 实施要点：建每账户唯一pronunciation_sets(id、owner、tenant、language=ja-JP、internalVersion)和vocabulary_entries(id、setId、text、reading、时间)；同set规范化text唯一，记录带内部revision；无历史版本/发布指针。
  - 拟涉及路径：apps/api/migrations/、apps/api/src/vocabulary/{domain,storage}/。
  - Depends on: T004.
  - 验收与 Verify：迁移/唯一约束有效，账户核心无反向依赖；内部version非用户版本；未创建draft或dictionary_versions。

- [x] T014 [P0] 实现词汇→读法 CRUD，保存即生效
  - 功能来源：PRODUCT_SPEC DICT-01、SEC-01；ARCHITECTURE及DECISIONS最新用户确认。
  - Goal / 实施要点：/v1/vocabulary分页CRUD与所有者过滤；事务锁集合，PATCH/DELETE按expectedRevision条件写，成功递增记录revision与集合internalVersion；text/reading非空NFC≤100 code points并禁尖括号/控制字符，最多500条建议。
  - 拟涉及路径：apps/api/src/vocabulary/{application,api}/。
  - Depends on: T008, T013.
  - 验收与 Verify：两账户交叉读写404；陈旧revision或重复text409、空值/不安全/超限失败；保存即进入下一次快照，无发布；删除移出集合，并发更新版本与行一致。

- [x] T016 [P0] 接入ja-JP内部快照与整段自动应用
  - 功能来源：PRODUCT_SPEC DICT-02、DICT-03、JPN-01、INT-02、SEC-01；ARCHITECTURE第11节及DECISIONS v0.6。
  - Goal / 实施要点：一致读取本人ja-JP集合version和有效规则，生成冻结ja-JP snapshot；宿主自动补set.id，reader验owner/tenant和语言；迁移后的applier真正处理日文，不静默跳过。
  - 拟涉及路径：apps/api/src/vocabulary/integration/、apps/api/src/tts/。
  - Depends on: T012, T014, T031.
  - 验收与 Verify：日文文章目标词alias实际进入供应商payload；保存后新读取更新、在途固定、删除后不替换；日文语言一致/越权/最左最长非递归回归，不能用中文夹具代替。

- [x] T017 [P1] 实现账户页面与导航
  - 功能来源：PRODUCT_SPEC ACC-01、ACC-02、ACC-03、ACC-04；ARCHITECTURE 对应设计，DECISIONS 待决选择。
  - Goal / 实施要点：按最终前端选择构建登录/开通状态、当前账户、退出；注册关闭时不给可提交注册入口；认证过期不重放付费请求。
  - 拟涉及路径：apps/web/src/auth/、apps/web/src/navigation/。
  - Depends on: T008.
  - 验收与 Verify：浏览器完成登录/退出；加载与错误可读；Cookie不被脚本读取；键盘及窄屏可操作。

- [x] T018 [P1] 实现语音工作台与 MP3 播放下载
  - 功能来源：PRODUCT_SPEC TTS-01、TTS-02、TTS-03；ARCHITECTURE 对应设计，DECISIONS 待决选择。
  - Goal / 实施要点：目录/音色/文本/语速表单，防重复提交、请求ID错误、成功Blob播放暂停下载、替换释放URL；截断/非音频结果不当成功。
  - 拟涉及路径：apps/web/src/speech/、apps/web/src/api/。
  - Depends on: T012, T017.
  - 验收与 Verify：正常MP3可听可下载；空目录、越界语速、输入超限、401/429/超时/流中断均有明确状态，无自动重试付费。

- [x] T019 [P1] 实现读法管理、试听和整段自动生效界面
  - 功能来源：PRODUCT_SPEC DICT-01、DICT-02、DICT-03、TTS-03；ARCHITECTURE及DECISIONS最新用户确认。
  - Goal / 实施要点：词汇+指定读法列表/新增/编辑/删除；保存后以原词text调用同一自动应用链路试听；工作台自动采用本人读法，无发布、版本、规则排序或集合选择器。
  - 拟涉及路径：apps/web/src/vocabulary/、apps/web/src/speech/。
  - Depends on: T016, T018.
  - 验收与 Verify：创建词汇→指定读法→保存→试听→整段输入按读法发音→修改/删除生效；支持范围与在途边界说明清楚，失败不静默忽略规则。

- [x] T020 [P1] 从独立账户仓库产物验证第二Nest宿主
  - 功能来源：PRODUCT_SPEC INT-01；ARCHITECTURE第1～4节及DECISIONS v0.7。
  - Goal / 实施要点：账户独立构建版本化tgz，在隔离最小Nest消费者安装core/adapter完成生命周期；与应用组合消费分别验收。分发可tgz或私有registry，不要求公开npm；文档说明迁移与peer版本。
  - 拟涉及路径：D:/Workspace/github/nest-account/tests/consumer/；D:/Workspace/github/nest-account/packages/account-core/README.md；D:/Workspace/github/nest-account/packages/account-postgres/README.md；D:/Workspace/github/tts-workbench/tests/consumer/。
  - Depends on: T006.
  - 验收与 Verify：测试环境没有tts-workbench或Gateway源码仍完成创建/登录/认证/撤销；无跨repo源码/path alias/源目录file依赖；按真实打包文件测试，应用安装同版本产物，迁移由宿主显式调用。

- [x] T021 [P1] 完成数据保留与安全观测流程
  - 功能来源：PRODUCT_SPEC DATA-01、OPS-01、SEC-01；ARCHITECTURE及DECISIONS最新用户确认。
  - Goal / 实施要点：安全审计、过期Session清理、词汇读法删除/备份过期；主动保存词汇读法持久化，临时整段输入音频不存；不实现发布历史清理。
  - 拟涉及路径：apps/api/src/operations/、apps/api/src/bootstrap/、docs/operations.md。
  - Depends on: T007, T016.
  - 验收与 Verify：删除后新快照不含记录；备份恢复集合版本/所有者一致；Q-07策略可执行，日志无正文/读法或认证材料。

- [x] T022 [P1] 完成权限、快照生效与错误验收
  - 功能来源：PRODUCT_SPEC SEC-01、ACC-03、DICT-01、DICT-02、DICT-03、INT-03、TTS-03；ARCHITECTURE及DECISIONS最新用户确认。
  - Goal / 实施要点：真实DB与供应商替身验证CSRF/伪造主体/集合越权、Session撤销、保存提交与请求读取并发、删除、parser/filter及关闭隔离。
  - 拟涉及路径：tests/e2e/、apps/api/test/。
  - Depends on: T016, T019, T020.
  - 验收与 Verify：新快照采用新读法，在途固定原版本；不支持组合拒绝而非忽略；越权无数据泄露；同进程共享观测仅由宿主关闭。

- [~] T023 [P1] 实现 Docker Compose 与 GitHub Actions 远程VPS部署
  - 功能来源：PRODUCT_SPEC OPS-01、SEC-01、INT-03；用户明确部署方式，ARCHITECTURE第12节及DECISIONS v0.8。
  - Goal / 实施要点：应用镜像锁定账户/Gateway版本包，Compose管理应用/同源入口/数据库持久化与健康；仅入口发布一个127.0.0.1宿主端口，其他服务无host映射，容器内可监听0.0.0.0；宿主Nginx负责外部TLS及页面/API/音频代理，正确配置路由、音频响应和可信转发头。Actions检查构建推镜像，再校验SSH主机连接VPS，按digest拉取、兼容迁移、更新Compose、检查readiness；串行部署并保留回滚版本，秘密不入源码/日志。
  - 拟涉及路径：D:/Workspace/github/tts-workbench/{Dockerfile,compose.yaml,compose.production.yaml,.github/workflows/deploy.yml,deploy/scripts,docs/operations.md}；apps/api/src/bootstrap/。
  - Depends on: T021, T022, T029.
  - 验收与 Verify：首次和重复远程部署可复现、镜像digest可追踪；实测整个栈仅一个127.0.0.1宿主映射，其他服务无host映射，无额外IPv6映射，外部不能直连发布端口；宿主Nginx可代理页面/API/真实音频响应且转发头可信。SSH/拉取/迁移失败不错误切换，健康失败能按兼容策略恢复前版本；数据库卷数据保留、备份可恢复；缺配置失败、秘密无泄露、部署健康检查不产生付费合成。

- [!] T024 [P1] 执行真实日文正文修音完整 MVP 验收
  - 功能来源：PRODUCT_SPEC ACC-01、ACC-02、ACC-03、ACC-04、TTS-01、TTS-02、TTS-03、DICT-01、DICT-02、DICT-03、EDIT-01、EDIT-02、JPN-01、INT-01、INT-02、INT-03、SEC-01、DATA-01、OPS-01；ARCHITECTURE第11节及DECISIONS v0.6。
  - Goal / 实施要点：在授权凭证下至少一条真实日文voice/adapter链验证日文文章→听→正文选词→个人读法写成功→再合成及以后日文文章沿用；测试具体读法期望经选定音色确认。
  - 拟涉及路径：tests/e2e/、docs/acceptance.md、docs/operations.md。
  - Depends on: T023.
  - 验收与 Verify：19功能覆盖；真实日文MP3与指定读法可听，汉字原文不变；专名/多读音词/假名/长促浊音/混合数字字母/语速样本通过；中文测试或仅ja-JP标签不算日文完成。

- [ ] T025 [P2] 评估日文MVP以外高级能力
  - 功能来源：PRODUCT_SPEC DICT-03、TTS-02、ACC-02；ARCHITECTURE第11节及DECISIONS v0.6。
  - Goal / 实施要点：仅新确认后评估非日文语言、IPA/高级重音、复杂匹配、共享导入或账户恢复；日文基础合成/词汇读法/正文保存已是MVP，不得放入后续。
  - 拟涉及路径：docs/PRODUCT_SPEC.md、docs/DECISIONS.md、TODO.md。
  - Depends on: T024.
  - 验收与 Verify：增强有来源及独立验收；不前置多语言平台或全供应商迁移，不把日文作为可选增强。

- [x] T026 [P0] 实现正文选区、规则投影与音频版本契约
  - 功能来源：PRODUCT_SPEC EDIT-01、EDIT-02、DATA-01、INT-02；ARCHITECTURE第9～10节与DECISIONS v0.5。
  - Goal / 实施要点：正文textRevision+临时选区UTF16范围/原词验证，原文变更重算个人规则标记；不为每次保存创建局部annotation。补个人CRUD/version响应与Gateway实际应用dictionaryVersions元数据供音频绑定。
  - 拟涉及路径：apps/web/src/editor/model/、apps/api/src/vocabulary/、apps/api/src/tts/、Gateway公开结果类型。
  - Depends on: T014, T016.
  - 验收与 Verify：日文汉字/平片假名/组合字符/emoji/换行与陈旧选区校验；匹配投影与Gateway最左最长/非递归一致；音频version来自实际快照，非另查DB；正文复制无读法/标记内容。

- [ ] T027 [P2] 可选位置覆盖编译与API（已降级）
  - 功能来源：PRODUCT_SPEC EDIT-01、EDIT-02、DICT-03；ARCHITECTURE第9～10节与DECISIONS v0.5。
  - Goal / 实施要点：仅明确选择“仅此处”扩展后实现局部annotation和/editor/speech：安全sub/prosody、位置校验、局部优先及速度映射。默认个人模式不调用该API、不制造局部标注。
  - 拟涉及路径：apps/api/src/editor/、apps/web/src/editor/local-override/、apps/api/src/tts/。
  - Depends on: T016, T026.
  - 验收与 Verify：扩展启用后验证单次位置、重叠/失效、XML转义、能力和资源限制；删除局部仅回落个人规则；MVP不依赖本项，global alias本身不能冒充位置能力。

- [x] T028 [P1] 实现正文默认个人读法编辑与再合成
  - 功能来源：PRODUCT_SPEC EDIT-01、EDIT-02、DICT-01、DICT-02；ARCHITECTURE第9～10节与DECISIONS v0.5。
  - Goal / 实施要点：正文选词显示原词/reading/影响当前及以后文章；默认POST/PATCH个人规则成功后刷新投影与version，再通过普通speech生成。取消仅保存前有效，无假撤销；可选仅此处入口不在MVP必需。
  - 拟涉及路径：apps/web/src/editor/、apps/web/src/speech/、apps/web/src/api/。
  - Depends on: T018, T026.
  - 验收与 Verify：不离开正文完成输入→听→改→个人保存→再生成；保存/删除失败保留旧状态及表单且不标生效，409刷新提示并发读法冲突；删除个人规则明确影响所有文章，旧音频和旧回包状态正确。

- [x] T029 [P1] 验证正文个人写入、跨文章与失败一致性
  - 功能来源：PRODUCT_SPEC EDIT-01、EDIT-02、DICT-01、DICT-03、SEC-01、TTS-03；ARCHITECTURE第9～10节与DECISIONS v0.5。
  - Goal / 实施要点：真实DB/供应商替身验证默认只写个人规则、不附带局部annotation，写成功后生成并用于新文章；验证失败/冲突保留草稿、原文不变、标记重新投影、旧音频版本和账户隔离。
  - 拟涉及路径：tests/e2e/editor/、apps/api/test/editor/。
  - Depends on: T022, T028.
  - 验收与 Verify：当前同词多处和未来文章遵循规则；保存未成功不假称生效；保存前取消不写DB，保存后通过真实修改/删除纠正；不以删本地标记撤销服务器规则。

- [x] T030 [P0] 贯通日文音色、配置、路由及adapter能力
  - 功能来源：PRODUCT_SPEC JPN-01、TTS-01、TTS-02、INT-02；ARCHITECTURE第11节及DECISIONS v0.6。
  - Goal / 实施要点：未来授权在Gateway与宿主配置中选择至少一条经官方资料及实测确认的日文voice/region/engine；迁移publicLanguage/default voice、adapter.languages、Azure fallback、wrapTextNodes默认、voice特定能力/语言校验，移除中文绑定options误用。
  - 拟涉及路径：D:/Workspace/github/TTS-gateway/src/modules/tts/{config,routing,providers,application,domain/provider-options}/、apps/api/src/tts/。
  - Depends on: T010.
  - 验收与 Verify：公开目录呈现ja-JP，voice/request/xml:lang一致，所选音色sub/prosody/MP3能力准确，错误语言上游前拒绝；记录确切voice/区域/engine验证证据，不臆造ID或假设两家都完成。

- [x] T031 [P0] 迁移ja-JP快照类型及实际规则执行
  - 功能来源：PRODUCT_SPEC JPN-01、DICT-03、INT-02、SEC-01；ARCHITECTURE第11节及DECISIONS v0.6。
  - Goal / 实施要点：未来授权扩展DictionarySnapshot语言契约、applier校验/继承/文本节点处理，ja-JP文本和SSML均应用alias；同步应用集合language及测试夹具，记录旧zh-CN兼容，不重标旧数据。
  - 拟涉及路径：D:/Workspace/github/TTS-gateway/src/modules/tts/domain/models/dictionary-snapshot.ts、该仓库dictionary/dictionary-applier.ts、相关测试及apps/api/src/vocabulary/。
  - Depends on: T030.
  - 验收与 Verify：ja-JP快照不被拒绝或静默跳过；日文文字替换/语言不匹配/空match/越权回归；NFC组合字符不改原文，半全角不擅自合并，不依赖ASCII词边界或新分词器。

## Acceptance Criteria

1. T020验证独立账户仓库构建产物，无兄弟源码依赖仍可在第二宿主使用；默认正文个人规则与作用域不变，保存成功才生成。
2. T030/T031完成ja-JP配置/voice/adapter/SSML/快照实际执行；T012/T016消费该能力，不能只替换标签。
3. T026/T028/T029完成日文正文→听→选词→持久保存→当前及以后文章应用，原文字面不改、失败/过期状态准确。
4. T024真实日文可听结果覆盖19功能，至少一条已验证供应商链；中文fixture不能替代。
5. Q-08/Q-09已关闭；T015取消，T027仅可选局部。所有代码任务未开发。

## Suggested Execution Order

1. 基础账户T001→T002→T003→T004→T005→T006，再T007/T008。
2. Gateway T009→T010→日文能力T030→日文规则T031；身份T011；T012在T030后、T016在T031后。
3. 规则模型T013→T014；服务T016；界面T017→T018→T019、正文T026→T028；独立宿主T020。
4. 数据T021/安全T022→日文正文回归T029→部署T023→真实日文MVP T024。
5. T025高级能力和T027局部扩展P2；T015不执行。

编号不等于拓扑顺序，按Depends on执行。30活动任务依赖无环；28项P0/P1为MVP，2项P2后续。日文不是可选分支，不要求先建立通用多语言平台。







## 执行验证记录

- T001 / 契约阶段：OpenAPI 1.0.0，17操作通过 npm run contract:validate，PM已在API_REVIEW签通过；架构第3节已记录运行选型与数值。


- T002：账户/API独立 npm install + npm run build 成功，版本包入口和声明配置齐备；产物消费将在T020验证。
- T003：core公共账户/Repository/PasswordHasher端口、AccountModule.registerAsync编译通过；无HTTP/TTS/数据库导入。


- T004/T005：真实PostgreSQL17测试通过，迁移重入、并发唯一冲突、Argon2id正确/错误密码、账号规范化及禁用拒绝均验证。


- T006：成熟express-session/connect-pg-simple适配，真实DB验证摘要存储、撤销、过期及绝对期限；HTTP并发边界在T008/T022继续覆盖。


- T007/T008：运营migrate命令执行成功；真实HTTP+PG测试验证CSRF、注册不登录、Session轮换、设置持久化和退出。create/disable复用已测试账户用例，联调本地注册仅开发启用。


- T009/T010/T030/T031：Gateway224测试全部通过、typecheck/build通过；新增ja-JP供应商payload/空match/语言冲突与library DI验收，中文兼容保留。
- T011/T012/T013/T014/T016/T026：应用消费Gateway产物，真实HTTP→PG→Gateway→供应商transport fixture测试通过；实际快照版本、在途修改不变、跨文章更新、preview不写库、删除回落与拒绝客户端dictionaryIds均验证。真实外部音频仍待T024。


- T017/T018/T019/T028/T029：前端React构建、22项契约检查、13项真实API/PG交互检查及PM有界评审通过（apps/web/qa/REPORT.md）。
- T020：版本包复制到独立runtime/account-consumer后npm ci+严格类型+第二Nest宿主测试通过，无兄弟源码。
- T021/T022：真实认证/隔离/并发冲突/正文原文与快照测试通过；包含账户及日文规则的PG备份恢复到独立库成功，清理命令/保留策略已提供。
- T023：Docker镜像实际构建、单127.0.0.1映射/db无host端口、页面/ready、重复启动、健康失败检测与恢复数据保留均通过；Actions/脚本结构和bash语法通过。未执行远程VPS/workflow，宿主Nginx启动验证被自动审批blocked by policy拒绝，代理TLS实测未计通过，故保留进行中。
- T024：阻塞于真实供应商凭据及已核实日本语音色；未使用测试transport夹具冒充可听日文。
- T025与T027本轮不执行；用户明确暂不做仅此处。当前26项完成、1项部署外部验收待续、1项真实音频受外部条件阻塞、2项P2未执行。



- 密码下限增量（2026-09-06）：账户core/postgres 0.1.1版本包已打包并被API消费；真实PG账户4项、HTTP/API3项及独立Nest消费测试通过。8字符注册201/登录200，7及129字符注册400；schema接受8和128、拒绝7和129。OpenAPI1.0.1的17操作、前端指纹/生成类型、构建、22项契约UI测试及格式检查通过。无需数据迁移，未新增改密接口。

## 文章管理增量计划（2026-09-09，API 1.1.0）

以下为新增授权范围的计划，不改变既有任务历史验收。产品独占Git提交；P0完成并提交、明确授权后才开始F1，F1验收commit后再授权F2。

- [ ] P0：三方规划与唯一契约API1.1.0（24操作）、前端生成类型/指纹、产品语义核对；本项暂不表示运行实现可用。
- [ ] F1：账户隔离文章CRUD完整垂直闭环：迁移、title/text验证、revision/contentRevision、MAX_ARTICLES默认100及原子容量、GET config、列表分页/详情/新建/保存/删除、409保留草稿、未保存离开保护。验收后产品commit。
- [ ] F1验证：真实PG/HTTP测试跨账户404、标题trim/码点/正文字节边界、空草稿、并发保存/删除409、并发创建不超额和删除释放名额；前端切换与保存失败保留、重启后最新正文仍在。
- [ ] F2：唯一成功音频完整垂直闭环：<=8MiB bytea原子替换、POST metadata/GET audioId二进制、恢复播放下载、实际规则快照及过期、last-success generationSeq、删除级联/在途不复活、同池计费限流/CSRF/取消。验收后产品commit。
- [ ] F2验证：真实PG+可控供应商transport覆盖新请求先成功/新请求失败旧请求成功、正文变更与仅标题变更、规则在途改变、删除中途完成、失败保留、超8MiB、metadata到GET间替换404、跨账户不可下载及服务重启恢复。前端验证先保存且新编辑不误合成旧快照、404最多重取一次、原有规则和试听回归。
- [ ] 综合验证与文档：备份恢复包含最新文章/唯一音频；Compose单loopback端口保持。付费真实试听只在明确授权下执行，不把夹具当可听验收；本增量不远程发布。
