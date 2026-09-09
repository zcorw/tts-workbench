# 技术架构与集成设计

当前实施状态（v1.0）：账户独立包、Nest API、React前端、文章CRUD与最新音频存储、Gateway日文规则链路已落地，应用通过vendor内账户0.1.1/Gateway0.1.1 tgz消费独立工程；当前OpenAPI1.1.0，密码范围8–128。下文保留设计沿革，实际运行与验收以[运维说明](operations.md)和[TODO](../TODO.md)为准；旧“仅文档/拟建”叙述不代表当前未实现。

实际成熟工具：账户核心使用Zod和@node-rs/argon2，HTTP Session适配使用express-session+connect-pg-simple，CSRF按有状态会话模式使用csrf-sync；不再自写签名token协议。匿名CSRF借助HttpOnly wb_session绑定，登录regenerate、退出destroy后重新获取，服务器记录1小时有效期；数据库只存Session ID标准SHA256摘要。PostgreSQL通过pg参数化SQL实现账户/规则业务事务，node-pg-migrate负责迁移锁与版本。账户核心无Express/TTS，HTTP可选适配放account-postgres/session子入口。

本地真实PG、页面/API联调及独立Nest包消费者已通过；Docker构建、单回环端口、健康失败恢复与数据备份恢复已验证。真实VPS部署、宿主Nginx代理/TLS和真实日文供应商音频未全部验收，不以本地替身或结构校验替代。

状态：v0.8，Docker Compose部署及GitHub Actions远程部署VPS已确认；账户独立工程/未来独立仓库已确认；整个项目优先日文语音合成（ja-JP），正文选词编辑默认保存个人规则并用于以后文章；Q-08已关闭。读法管理与整段应用均为MVP确定需求；实现已启动，完成情况以TODO和验证记录为准。见 [产品说明书](PRODUCT_SPEC.md)、[决策记录](DECISIONS.md)、[开发任务](../TODO.md)、[入口](../README.md)。用户已授权进入OpenAPI契约→后端实现及React联调阶段；本轮可写必要代码和测试，不提交、推送或实际远程部署。

## 1. 独立工程、仓库与产品闭环

账户独立工程/未来独立Git仓库是用户已确认要求，不再把账户放在应用workspace中，也不是未来再抽取。拟目录D:/Workspace/github/nest-account，名称暂定；和TTS-gateway、tts-workbench平级。当前仅改规划文档，没有创建nest-account、初始化Git、创建远端、提交或推送。

```text
D:/Workspace/github/
├─ nest-account/                        # 拟建独立工程，未来独立Git；名称暂定
│  ├─ package.json                     # 自有构建/测试/打包检查入口
│  ├─ tsconfig*.json、依赖锁文件、CI配置
│  ├─ README.md、docs/                 # 接入、迁移、版本与分发说明
│  ├─ packages/                        # 允许账户工程内部管理两个库包
│  │  ├─ account-core/
│  │  │  ├─ package.json               # public exports/types/files与独立版本
│  │  │  └─ src/{domain,application,ports,nest,index.ts}
│  │  └─ account-postgres/
│  │     ├─ package.json               # 适配器公开入口与兼容核心版本
│  │     ├─ src/
│  │     └─ migrations/
│  └─ tests/consumer/                  # 仅从打包产物安装的最小Nest宿主
├─ TTS-gateway/                         # 已有独立仓库，未来库化/版本包
└─ tts-workbench/                       # 独立应用工程，当前仅规划文档
   ├─ README.md、TODO.md
   ├─ docs/{PRODUCT_SPEC,DECISIONS,ARCHITECTURE}.md
   ├─ package.json、apps/               # 应用内部api/web可继续workspace
   │  ├─ api/src/
   │  │  ├─ auth/                      # 宿主HTTP、Session桥接；消费账户包
   │  │  ├─ vocabulary/                # 日文个人读法及内部集合
   │  │  ├─ editor/                    # 正文取词及规则投影
   │  │  ├─ tts/                       # 消费Gateway包
   │  │  ├─ operations/                # 宿主受控开通/禁用命令
   │  │  └─ bootstrap/                 # 宿主配置及生命周期
   │  ├─ api/migrations/               # 应用读法表，不放账户库迁移
   │  └─ web/src/{auth,vocabulary,speech,editor}/
   ├─ tests/{consumer,e2e}/             # 应用消费/日文组合验收
   └─ deploy/
```

图中除本次已有文档及Gateway外均为未来路径。账户根可用内部workspace组织core/adapter，根工具链与配置完全自有；对外库包各有package.json、exports、build/test和版本契约。应用不通过workspace:*、兄弟src路径、tsconfig跨仓path alias或源目录file:依赖消费账户；账户也不依赖应用的私有配置、脚本、模块或TTS包。单独签出账户仓库应能构建、测试、打包并生成消费文档。

依赖方向：tts-workbench/api→明确版本account-core/account-postgres包与Gateway包；account-postgres→兼容版本account-core端口；web→api HTTP。宿主提供数据库连接配置/迁移调用、Cookie、路由、业务权限和个人读法；账户仅管理通用账户/会话，Gateway只接ActorContext/DictionaryReader。新Nest项目仅装账户构建包也能使用。

联调建议在各独立仓库构建并打版本化tarball，再由应用安装该tgz并锁定包版本/完整性；生产可选私有registry，不强制公开npm。不能只用跨仓源码链接通过测试就宣称独立可用。账户根分发检查应校验包内容无应用或secret、exports/types可加载、依赖/peer版本有效、迁移文档可由宿主执行、消费者无需兄弟仓库。独立仓库组织已定；具体名称、包scope、分发渠道和公开性仍可后续决定。

产品主线保持日文正文输入→合成听音→正文选词指定读法→个人规则持久保存→当前及以后日文文章应用；原文不改，正文标记是规则投影，局部位置T027仍可选。账户仓库拆分不改变产品功能或重新进行技术选型。

## 2. 已有能力与必要缺口

只读核实Gateway基线HEAD：bd19795f98e7d27f87f180cfe78d3486f9d1fc2f；当次工作树干净。下列路径相对D:/Workspace/github/TTS-gateway。

| 位置 | 已有事实 | 待接入/开发 |
|---|---|---|
| package.json、src/modules/tts/tts.module.ts | private，无exports；模块仅导出TTS_HEALTH；Nest12.0.1，Node声明>=22.12.0 <23 | 正式包入口、合成/目录公开契约、动态依赖注入与兼容验证 |
| src/auth/host-authenticator.ts、api/tts-authorization.guard.ts | 默认undefined；authenticate同步；Guard优先request.actor | 宿主异步Session认证先写可信actor |
| api/tts.controller.ts、voices.controller.ts | POST /v1/audio/speech、GET /v1/voices | 宿主自动选择本人内部规则集合，词汇试听和整段共用合成 |
| tts-runtime.factory.ts | DictionaryReader固定not_found | 必须替换为真实可注入reader，否则非空dictionaryIds不能工作 |
| domain/models/dictionary-snapshot.ts、dictionary/dictionary-applier.ts | alias/IPA快照；zh-CN；最多3本/每本500/总1000 | MVP用一份私人alias集合；版本/快照仅内部技术契约，不是发布产品 |
| api/http-boundary.ts、gateway-error.filter.ts、src/main.ts | 自定义parser，全局JSON和APP_FILTER | 明确路径作用域，防止覆盖账户/词汇错误 |
| tts-runtime.factory.ts、api/audio-response.mapper.ts | runtime关闭adapters及观测；MP3，marks特例multipart | 共享资源归宿主；首版纯文本MP3 |

request-validator.ts无dictionaryIds时走空快照，但此分支不能替代已确认的读法应用需求。必须实现有规则时的真实reader与整段应用；旧ADR不证明当前可直接用。

## 3. 技术选型建议与发布契约

### 本轮实施选择

用户已授权连续执行：唯一OpenAPI契约经产品语义评审和机器校验后，直接实施后端并供React接入。采用Node 22.12+、Nest 12、PostgreSQL及pg参数化SQL；账户包采用@tts-workbench/account-core和@tts-workbench/account-postgres，独立nest-account工程产出版本化tgz，应用vendor目录保存产物供可重复安装，不引用兄弟源码。前端独立apps/web工具链，应用根锁由后端维护，前端锁仅由前端维护。

登录标识为3–120字符ASCII账号（允许邮箱形式），trim并转小写，displayName为1–40字符；密码8–128字符，使用Argon2id；公开注册默认关闭、运营CLI可开通。Session空闲24小时、绝对7天，数据库仅存token摘要；禁用撤销全部会话。CSRF采用浏览器HttpOnly绑定cookie与签名token，1小时有效；所有写操作及试听/合成需同源Origin和header，登录/退出清旧绑定后重新获取。默认不存文章、音频及历史；账户词汇最多500条。

开发API计划127.0.0.1:3000，React Vite代理/v1和/health；PUBLIC_ORIGIN必须匹配浏览器实际入口。生产入口保持宿主Nginx→单一loopback发布端口。运维默认每天备份、保留7天；过期Session每日清理。真实供应商未配置时音色列表为空、合成503，不安装运行时fake。所有精确HTTP约束以[OpenAPI](openapi.yaml)为准。

建议 PostgreSQL：账户唯一约束、会话撤销和读法/内部集合更新需要事务；会话先存同一数据库，暂不增加 Redis。ORM/驱动、迁移工具及精确版本在实施前选择并验证，不在规划中虚构兼容。前端建议 React、同源部署，框架仍待选择；账户独立仓库组织已由用户确认。采用服务端 opaque Session，优点是禁用和退出可即时阻止后续请求；每次认证需数据库读取。若改 JWT，需要重新设计撤销/刷新与跨宿主隔离，不能仅替换一个 token 字段。

独立nest-account工程拟产出 `@<scope>/account-core` 与 `@<scope>/account-postgres`，scope/注册表/开源与否待定。公共入口包括 AccountModule.registerAsync、AccountService、AccountPrincipal、存储/密码/时钟/随机数端口及显式错误类型。所有端口签名支持必要异步操作；领域对象不携带 Express Request。输入配置经宿主显式注入，不在库加载时读取 process.env、连接数据库或注册全局 Guard。Nest 动态模块支持可配置依赖模式，具体 API 是本项目拟设计契约。[Nest 官方动态模块](https://docs.nestjs.com/fundamentals/dynamic-modules)

账户包显式声明 exports/types/files；仅分发编译产物、类型、迁移与文档。Nest 核心使用 peerDependencies，支持范围必须经独立消费者验证；先验证与现有 ESM 宿主组合，其他 Nest 主版本/CJS 不先行宣称支持。Node exports 可明确公开入口并限制内部子路径，不能用跨仓库 src 深路径当正式接口。[Node 官方包入口](https://nodejs.org/api/packages.html)

## 4. 账户模块与 Session

拟定公共操作：createAccount({login,password}, context)、authenticateCredentials、createSession、resolveSession、revokeSession、disableAccount、getAccount。AccountPrincipal 仅含 accountId/status；租户和 TTS 权限由宿主映射。AccountRepository、SessionRepository、UnitOfWork、PasswordHasher、Clock、TokenGenerator 为端口；应用事务覆盖创建唯一性及禁用+撤销。密码哈希算法/参数通过实施时安全评审和基准选定，禁止明文密码与可逆存储；随机 Session 只向浏览器返回一次，数据库保存摘要。

推荐内测默认关闭自助注册；受控 CLI 调用同一创建用例。开放注册是配置与决策入口，需验证限流和防滥用。CLI 无公共 HTTP 管理路由，限定部署运维执行环境，密码安全交互输入、不写命令行参数/日志。

Cookie 配置 HttpOnly、Secure（生产 HTTPS）、SameSite=Lax、Path=/；同源 CSRF token 与 Origin 检查保护登录、退出及所有状态修改/计费合成。登录成功轮换 Session，设置绝对和空闲过期；具体时长在决策中配置。退出撤销当前 Session 并清 Cookie；禁用撤销全部 Session，resolveSession 每次校验账户状态，不依赖长期缓存。凭证错误统一响应，认证与合成均有限流；个人 tenantId 由服务端固定映射，不从客户端采信。[OWASP Session 指引](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)



## 5. 读法数据和自动快照

建议每个账户一份内部规则集合，用户只看到词汇与读法列表，无“字典本”或发布操作。

| 模型 | 字段/约束 |
|---|---|
| pronunciation_sets | id；ownerAccountId唯一；tenantId；language=ja-JP；internalVersion；updatedAt；应用内部管理 |
| vocabulary_entries | id；setId；text（词汇）；reading（指定读法）；revision；createdAt/updatedAt；同set规范化text唯一 |
| accounts/sessions | 沿用账户适配器；无反向词汇依赖 |

每次CRUD在事务内锁定本人集合、校验并保存记录、递增internalVersion。PATCH/DELETE携带expectedRevision并条件比较记录revision，冲突409要求刷新；成功更新递增记录revision。这是防丢更新的内部并发令牌，不是用户版本管理或发布。删除直接从在线集合移除，保留/备份政策见Q-07。不建dictionary_versions历史表、草稿表、发布指针或publish API；版本仅用于快照一致性和脱敏排错，不暴露为用户管理功能。账户创建可懒建内部集合，不向账户核心引入产品耦合。

推荐**请求时内部生成快照**：DictionaryReader在一次一致数据库读取中校验集合owner/tenant并读取version与全部词汇，以固定排序生成冻结的DictionarySnapshot。可用单条聚合查询；若多条查询必须用一致事务快照，避免版本和行来自不同提交。无需每次编辑复制整份历史规则表。PostgreSQL默认READ COMMITTED每条语句可见不同快照，读取边界须在实现中保证。[PostgreSQL事务隔离](https://www.postgresql.org/docs/current/transaction-iso.html)

映射：ruleId=entry.id，match=text，type=alias，alias=reading，matchMode=literal，caseSensitive=true；snapshot.schemaVersion=tts.dictionary.snapshot/v1、dictionaryId=set.id、version=internalVersion、language=ja-JP（须完成T031迁移，非现有已支持）。快照按稳定记录ID排序，唯一text避免同词冲突；部分重叠沿用Gateway最长匹配优先，单轮非递归（A→B不继续变成B的读法），不增设排序UI。MVP建议同账户最多500条，为现有单快照容量边界。

词汇text和reading采用NFC、非空、最多100 Unicode code points，拒绝尖括号/控制字符；reading上限来自现有alias契约，text同限是新增轻量安全建议。保存时后端校验，Gateway也补空match拒绝回归以防非前进循环。字段以普通文本处理，不接受用户SSML/IPA。重复词汇返回409并提示编辑现有读法。

生效边界：保存成功提交后，之后读取快照的合成使用新读法。请求先完成认证和参数校验，再在调用供应商之前一次读取本人规则快照；该时间点决定本次内容。已读取快照的在途请求继续原读法；修改/删除不撤回已发送供应商的工作。请求已到达但尚未读取快照时可能读取刚提交的变化，不宣称以客户端点击或HTTP到达时刻严格划线。UI可说明“保存后后续读取规则的合成生效，已读取规则的在途结果不变”。

## 6. 合成接入与HTTP

宿主为每次词汇试听和整段文本合成自动选取本人内部set.id，以dictionaryIds=[set.id]调用Gateway；没有规则也可返回本人空rules快照。前端不传集合ID或owner，不能选择他人集合。reader再次校验actor、tenant、owner；集合不存在/无权读取整体失败，不静默跳过读法。基础TTS权限加tts:dictionary:use，由宿主授予并由Guard/validator检查；精确音色权限仍需独立检查。

词汇试听：服务端授权读取当前记录→页面以text作为普通合成input→同一自动规则接入→返回MP3；整段工作台走完全相同的自动应用路径。不能用reading直接朗读替代整段规则回归，否则无法证明目标词在原文本中真正生效。

| 方法与路径 | 输入/响应 | 授权 |
|---|---|---|
| GET /v1/auth/csrf | 浏览器绑定token，no-store | 匿名可用 |
| POST /v1/auth/register | login/password；201账户；默认关闭403 | 开关、CSRF、限流 |
| POST /v1/auth/login | login/password；200账户、Set-Cookie | CSRF、限流 |
| POST /v1/auth/logout | 204，撤销会话清Cookie | CSRF |
| GET /v1/auth/me | 最小账户资料 | Session |
| GET /v1/vocabulary | 本人词汇/读法分页列表 | Session、所有者 |
| POST /v1/vocabulary | text、reading；201记录 | 所有者、CSRF |
| GET /v1/vocabulary/:id | 本人记录，不可见404 | 所有者 |
| PATCH /v1/vocabulary/:id | text、reading、expectedRevision；200记录及新revision | 所有者、CSRF |
| DELETE /v1/vocabulary/:id | expectedRevision；204，移出本人在线规则集合 | 所有者、CSRF |
| GET /v1/voices | 既有授权音色目录，展示可用于当前读法模式的能力 | tts:voices:read |
| POST /v1/audio/speech | input、inputType=text、voice、format=mp3、speed、可选language；服务端补本人dictionaryIds；200 audio/mpeg | 合成、精确音色、读法使用权限、CSRF |

用户已确认日文是整个项目主要目标，**MVP必须完成ja-JP音色、请求语言、个人规则快照及正文整段合成**。当前zh-CN硬编码是需要迁移的技术缺口，不能作为中文先上线或日文后续的理由。应用显式language=ja-JP，目录只展示已配置并验证的日本语音色；不兼容组合报错，不回落中文或忽略读法。具体providerVoiceId、engine、区域和日文alias效果待T030及真实smoke验证，不在文档臆造可用ID。个人规则集合明确language=ja-JP；已有其他语言数据不能直接改标签冒充日文。

账户/词汇错误建议{code,message,requestId,details?}：400字段、401身份、403权限/CSRF、404不可见、409重复词汇、429限流、503依赖；TTS保留原错误，不用JSON包装音频。MVP不提供SSML/providerOptions UI，dictionaryIds只服务端生成。流开始后失败中断响应，客户端不将截断音频当成功；不自动重放付费请求。

现有输入上限为10000 code points及49152字节，另有speechUnits/供应商限制；speed=0.5..2且最多两位小数；HTTP body65536字节、音频8388608字节。不得承诺任意上限长度均可成功。前端提示并以服务端校验为准。

## 7. 包化、身份与宿主生命周期

未来公开TtsModule.registerAsync、SYNTHESIZE_SPEECH、VOICE_CATALOG、TTS_HEALTH、ActorContext、DictionaryReader/Snapshot等稳定契约，名称为拟设计而非现有承诺。配置、reader和认证桥接通过显式imports/inject/useFactory提供，不能靠父模块同名provider或测试overrideProvider替换子模块本地依赖。

建议应用的薄HTTP适配层复用公开合成/目录与音频响应映射契约，在合成前服务端补本人集合并执行支持范围/权限校验；避免重复注册Gateway同名controllers。若复用改造后的Gateway HTTP适配器，则需显式产品请求转换扩展点，在Guard/validator之前安全补内部ID。T010/T012实施时选定一种并验证同一路由只有一个控制器，不同时注册两套。两种方式都必须保留权限、AbortSignal、上下文与错误映射。

宿主异步验证Cookie/Session后生成冻结request.actor；原同步Guard可读取actor，不能传Promise。个人tenant服务端映射，客户端JSON actor不可信。TTS路径级解析器/媒体类型/大小/期限和上下文先配置，账户词汇parser独立，认证/CSRF/Guard顺序用真实集成测试证明。

Gateway filter只作用TTS；账户/词汇错误由宿主处理。观测由宿主持有，Gateway只关闭自身adapters；停止接流量后等待/取消在途、关闭Gateway/DB/观测一次，初始化失败也清理；取消传到reader及供应商。

## 8. 最小验收与运维

必要回归：账户包第二Nest宿主独立复用；两账户读法CRUD和集合越权拒绝；保存日文词汇读法→包含词汇的日文整段输入→实际alias生效；修改后新请求读新版本而在途快照不变；删除后新请求不替换；空match/重复/超限失败；不支持语言/音色明确拒绝；文本/音频错误及会话撤销，parser/filter/关闭互不污染。先用供应商替身核对SSML，再在授权凭证下做少量真实可听验证，不增加无关测试。

主动保存的词汇与读法持久化，临时整段输入/音频默认不保存；日志无词汇正文、读法、密码、token。备份过期、Session/审计清理和账户数据处理由应用运维负责，Q-07明确数值。部署同源HTTPS、密钥注入、DB/Gateway readiness不计费、登录/合成限流、成本阈值和恢复步骤。IPA、可选匹配模式、规则共享/导入等后续另行确认，不能阻碍已确认alias轻量闭环。




## 9. 正文默认编辑个人规则（已确认）

用户确认Q-08：正文修改读法默认保存为个人规则，应用于以后文章。主流程为正文输入→生成并听→正文选中词汇→显示原词、当前个人读法和“影响当前及以后文章”提示→修改→个人规则持久化成功→刷新标记并标旧音频→重新合成验证。取消仅在保存前关闭表单；保存成功后通过明确修改/删除个人规则纠正，不提供假撤销按钮或只删除本地标记的伪回滚。独立词汇页不是必经步骤。

原文与规则分离：当前页面保存text、textRevision、个人规则列表及internalVersion；正文上的发音标记是按个人规则在当前原文匹配得到的派生范围，不是每次保存都新增的annotation。相同词汇的各处出现及以后文章按同一规则生效；标记预览须遵循Gateway字面/大小写/最左最长/单轮非递归语义，用契约用例核对，不能显示与实际合成不同的匹配。原文编辑后重新计算投影，不把旧范围永久套用；原文复制/导出不包含读法或SSML。

选区编辑草稿采用{textRevision,start,end,selectedText,reading}，范围为UTF-16 code-unit半开区间，不拆Unicode代理对；打开/提交时验证当前text.slice(start,end)===selectedText。正文在表单打开期间变化，选区可可靠平移则更新并复核，交叠修改或不能可靠映射则使选区草稿失效并要求重新选词，不按同词全局搜索猜位置。持久化的是selectedText→reading，而非start/end；提交个人规则沿用NFC/非空/长度/字符校验和同词唯一约束。

API复用：正文查询本人词汇，已存在则PATCH /v1/vocabulary/:id，首次则POST /v1/vocabulary，收到成功响应后刷新本人规则及version；再用POST /v1/audio/speech生成。个人规则响应或同一刷新结果需提供服务器实际internalVersion用于音频过期判断。保存成功前禁用会误示新读法已生效的“再生成”；保存失败保留表单内容、标记未保存并允许重试，不自动付费合成或伪装成功。两次创建竞争遇409时刷新现有规则并提示冲突；不悄悄覆盖别人/其他窗口刚写入的不同读法。后端规则写入与version递增同事务，不需用户发布。

删除失败保留原有规则状态并显示可重试错误；删除默认编辑的个人规则必须明确提示影响当前所有匹配处与以后文章，成功后刷新投影并标音频过期；删除某个派生标记不是单次位置删除。若以后实现局部覆盖，删除局部只移除该覆盖，不删除个人规则；仍匹配个人规则时提示恢复个人读法。已成功写入个人规则的“撤销”若未来增加，必须调用真实服务器恢复/删除并处理并发，不能只改前端，本MVP不提供该额外按钮。

音频与提交的textRevision、voice/speed等参数、实际个人集合version绑定。文本、参数、已知规则变化后旧音频仍可听但标明需重新生成；请求返回时若编辑态已变化，不能把旧响应标成当前结果。跨设备规则变化在规则刷新/版本查询获知后标旧，不宣称实时监听。建议Gateway公开实际采用dictionaryVersions的安全元数据，由宿主以X-Pronunciation-Version与X-Request-Id映射，不能另查DB冒充该次快照；此为T026所需集成补充。正文可保持页面会话内存，刷新/离开提示可能丢失；个人规则已持久化，不提示其随页面丢失。

主线无需新的位置合成API，也无需把plain原文转SSML；沿用现有全局alias+真实reader自动应用个人规则即可，但正文选区、表单、派生标记和音频一致性是明确待开发能力。用户不写SSML/IPA，不新增自动错音识别、音文同步或强制富文本框架。默认作用域不再待定。

## 10. 可选“仅此处”位置覆盖（非MVP前置）

“仅此处”是AI建议的例外，用户没有要求默认此范围。若未来启用，必须明确切换作用域才产生独立annotations，不能在默认个人保存时额外制造局部标注。局部优先于个人规则，局部彼此重叠拒绝；删除局部后回落个人规则，删除个人规则另需明确操作。T027降为P2可选，所有MVP不依赖它。

源码事实仍有效：DictionarySnapshot只有match，没有offset，不能单独覆盖同词第2次。SSML政策支持sub(alias)与prosody(rate 50..200%)，dictionary-applier不会进入sub；因此未来可新增安全编译器，校验原文/版本/范围/原词后结构化构造speak、prosody、sub，安全转义文本和属性，内部inputType=ssml。禁止客户端SSML/任意XML，禁止生成mark/phoneme；仍输出普通MP3。ssml请求移除顶层speed并映射prosody百分比，按目标音色能力与编译后资源限制验证。

可选POST /v1/editor/speech才接原文、版本及局部annotations；默认个人模式继续/v1/audio/speech。局部模型含id、start/end、selectedText、reading、textRevision，版本/quote不符返回409、重叠或非法范围400；编辑前移位可复核，交叠编辑失效阻止局部分支生成。局部sub不被个人规则覆盖，全局匹配不跨其边界，不做递归替换。局部sub本身按音色能力验证，叠加个人规则使用MVP已迁移并验证的ja-JP快照路径，不支持组合不得静默去掉规则。

若启用，音频绑定额外annotationRevision；所有元数据来自实际采用输入/快照。仅文章局部状态不保存为个人规则，不能默认跨文章生效。此可选工作只在T027实施，核心验收使用默认个人写成功→当前及新文章均生效，不为保留位置方案扩大默认范围。



## 11. 日文优先：源码缺口、迁移和验证（MVP）

日文是用户已确认目标，不新增“是否日文优先”的待决项。账户可复用及正文默认个人规则不变，所有主流程示例和验收改用日文。读法仍以可理解的指定读法文本提供；alias只是建议实现，不强制假名、拼音或IPA，也不承诺重音/精确音素控制。需在真实日本语音色上确认替代文本是否达到期望。

| 已核实源码 | 当前缺口 | 必需改造 |
|---|---|---|
| config/tts-config.types.ts与defaults.ts | publicLanguage类型仅zh-CN，默认中文providerVoiceId/alias | 配置可表达ja-JP，应用提供已验证日文音色和公开alias，不仅改界面标签 |
| providers/azure-speech与amazon-polly adapter | capability.languages目前均仅zh-CN，Azure序列化fallback为zh-CN | 至少一条生产候选adapter/voice/engine链真实支持ja-JP，移除该路径中文隐式fallback，能力声明与实际音色绑定 |
| domain/provider-options/provider-option-schemas.ts及validator | schema ID和可用style/role与中文alias绑定 | 日文音色使用其真实可用选项，不沿用中文style/role；首版可只启用基础选项 |
| tts-runtime.factory.ts、routing/voice-registry.ts | runtime把adapter级能力给voice，registry只验证能力交集 | 将具体voice支持语言和sub/prosody能力准确映射，不能凭adapter泛化支持假称所有voice都可日文 |
| routing/voice-router.ts、application/request-validator.ts | Router按alias返回；语言提示是字符串，现有SSML能力检查主要为标签/属性 | 建立request language、选定voice、快照language与SSML xml:lang一致契约；错误语言在调用供应商前拒绝 |
| domain/models/dictionary-snapshot.ts | language字面量仅zh-CN | 扩展公开快照契约至少含ja-JP并记录包版本兼容政策，应用写ja-JP |
| dictionary/dictionary-applier.ts | validateSnapshots拒绝非zh-CN；applyElement只处理zh-CN文本且默认继承zh-CN | 按已支持目标语言应用快照，ja-JP纯文本和SSML均实际替换，不通过放宽类型却仍跳过执行 |
| application/resource-calculator.ts wrapTextNodes | 默认xml:lang为zh-CN | 由明确请求/voice语言生成ja-JP根节点，日文路径不得默默中文 |
| ssml/validators/language-validator.ts | Intl语言标签语法校验可表达ja-JP | 语法合法不等于voice/adapter可用，需补语义/实际能力测试 |
| providers/fake及现有测试夹具 | 大量能力声明和样例是zh-CN | 新增日文夹具覆盖完整流程，保留兼容回归但不能只跑中文证明日文完成 |

T030完成音色/配置/路由/adapter/默认语言能力；T031完成快照与替换引擎迁移；二者是P0前置。选择一条可验证的现有供应商路径形成日文MVP即可，不要求为此新建供应商SDK或同时迁移所有提供者。旧Gateway独立宿主的兼容处理在包版本说明中记录，不静默重标已有中文规则或变更未迁移数据。

公开资料仅用于选择候选，不能代替本项目测试：[Azure语言与音色官方目录](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts)、[Azure SSML发音官方说明](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-pronunciation)、[Polly可用音色官方目录](https://docs.aws.amazon.com/polly/latest/dg/available-voices.html)。实施时核对供应商区域、engine、日文voice实际支持的sub/速度/MP3；文档不指定未经验证的voice ID。

日文验收至少包含：日文短句及文章MP3、选定音色目录显示ja-JP、正文选中词保存读法后当前和下一篇日文文章生效；汉字/平假名/片假名/标点及混合字母样本，NFC组合字符/代理对选区不破坏原文。替身测试检查送出payload的ja-JP、voice和alias，真实供应商少量试听验证实际读法。非日文voice或冲突language不能静默接受；日文未通过时不得以中文回归通过宣布MVP完成。精确文本长度/计费仍服从供应商限制，不以字符集变化推定支持长文章。




## 12. Docker Compose与GitHub Actions远程部署（已确认）

最终组合应用使用Docker Compose在VPS部署，并支持由GitHub Actions远程完成发布，这是用户明确要求。当前只记录规划，不创建Dockerfile/Compose/workflow、不连接VPS或配置密钥、不执行发布。账户和Gateway继续独立库仓库；它们的明确版本包被应用镜像构建消费，不因Compose而自动拆成账户/TTS微服务。

拟由tts-workbench拥有Dockerfile、compose.yaml、生产覆盖配置、.github/workflows/deploy.yml及deploy/scripts、docs/operations.md。默认建议由应用入口同时提供前端静态文件和API，以最少服务形成同源入口；若前端运行时需要独立服务，则经内部网关合流，仍只保留一个宿主入口。生产代码来自构建镜像，不挂载兄弟源码；数据库使用持久卷或明确的外部数据库，不在更新/回滚时删除数据卷。健康检查、重启策略、网络和秘密注入由部署配置声明。[Docker生产Compose说明](https://docs.docker.com/compose/how-tos/production/)

用户进一步确认：整个Compose栈只发布一个宿主端口，显式绑定127.0.0.1，由宿主机Nginx统一反向代理前端/API/音频，并负责外部域名及TLS。发布形式规划为127.0.0.1:${APP_HOST_PORT}:${APP_CONTAINER_PORT}（示意，端口值可配置）；禁止省略宿主IP、绑定0.0.0.0或新增IPv6/容器TLS宿主映射。数据库、缓存及其他内部服务仅使用Compose网络，无额外host ports。容器内服务可监听0.0.0.0以便端口转发和内部互通，这与宿主仅绑定127.0.0.1不同，不能要求容器服务只监听自身loopback。

宿主Nginx配置纳入运维文档：静态资源/前端路由与API路径正确分流，API错误不得落入SPA页面；保留音频Content-Type及实际响应所需头，代理超时/缓冲与真实合成响应方式匹配，请求体上限与应用限制一致，不缓存鉴权接口或个人音频。Nginx覆盖转发头，应用仅信任明确代理来源并正确识别外部HTTPS，以支持Secure Cookie和同源校验；不能无条件信任客户端自报X-Forwarded-*。无需新增容器TLS端口。

建议流水线：检出应用版本→安装锁定账户/Gateway包→执行必要构建/检查→构建版本化镜像并推送选定镜像仓库→记录镜像digest及Compose版本→通过受控SSH连接VPS→拉取指定digest→显式执行兼容迁移→更新Compose服务→等待readiness并运行非计费冒烟→记录部署结果。VPS不依赖临时开发目录或现场拉取兄弟仓库src构建。镜像仓库可私有，不强制公开；GitHub Actions触发方式（手动、标签或分支）和具体仓库权限在实施时选定。

部署只接受受信工作流/版本；SSH主机身份需校验，部署凭据与镜像拉取凭据限制用途，不写入源码、镜像层或日志。GitHub仓库/环境Secrets用于工作流所需秘密，VPS运行时秘密由服务器受控配置提供；Actions第三方步骤需固定审阅版本，生产并发部署按目标串行，避免两个版本交错更新。[GitHub Actions Secrets说明](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)

失败策略：构建/推送/拉取/迁移前置检查失败不切换服务；健康失败保留错误日志和上一个镜像digest，按兼容性回滚应用服务。数据库变更采用向后兼容迁移并验证备份恢复，不假定回滚镜像能回滚数据库；禁止自动删除数据卷。单VPS Compose更新可能短暂中断，不把支持CI/CD等同零停机承诺。需要首次部署、重复部署、失败回滚及数据库数据保留的可重复验收。

部署验收另须检查实际发布端口：整个栈只有一个127.0.0.1宿主映射，其他服务无host映射，无IPv4/IPv6公网直连入口；宿主Nginx能访问页面/API并正确代理真实音频响应，外部无法绕过Nginx直连发布端口。真实音频验证使用受控夹具或T024已授权结果，不能让readiness自动调用付费供应商。

待实施参数只有VPS地址/系统与CPU架构、SSH部署身份和主机指纹、宿主入口端口、域名/TLS、镜像仓库、触发策略和部署目录等；Docker Compose、GitHub Actions、远程VPS及单loopback端口加宿主Nginx入口不再作为平台待选项。日文真实音色验收仍由T024在具备授权凭据时完成，部署健康检查不自动触发付费TTS。

## 13. 文章管理与最后成功音频（API 1.1.0，F2已通过验收）

本节为2026-09-09三方定稿的新方向，覆盖旧章节“正文/音频不持久化”的产品范围；P0契约已完成；F1账户隔离文章CRUD及前端闭环已实现，已由产品提交2dd6d47。F2音频持久化已实现，前后端及产品统一验收均通过；无成功音频时audio=null、audioStale=false。仅保留每篇最新已保存title/text和一份最后成功音频，不提供正文或音频历史。账户、密码8–128、ja-JP和同词唯一默认规则保持。详见[文章方案](ARTICLE_MANAGEMENT.md)与[唯一契约](openapi.yaml)。

wb_articles保存account_id、title、text、revision、content_revision、generation_seq及时间；wb_article_audio以article_id为唯一主键/外键ON DELETE CASCADE，保存<=8388608字节的bytea及audioId、contentRevision、实际ruleVersion、voice/speed、格式、字节数/字符数、文件名、生成时间和成功generation序号。列表只读metadata，不取正文/音频字节。PG事务原子替换音频，不新增文件存储服务。备份/WAL/MVCC仍按数据库运维策略保留，不将“业务无历史”承诺为物理即时擦除。

F1已新增部署参数MAX_ARTICLES，正整数，默认100（团队工程默认而非用户原话），GET /v1/config返回maxArticles。账户锁或等效事务边界下原子校验容量并创建，超限409 ARTICLE_LIMIT，删除释放名额。每篇单份8MiB音频意味着默认当前音频逻辑总量最多800MiB/账户，不包括数据库开销、旧MVCC版本及备份；本轮不增加独立总配额系统。

revision从1开始，只在title/text实际改变时递增并更新updatedAt；contentRevision从1开始，仅正文精确变化时递增，改标题不使音频过期。title trim后1–120码点；正文原样0–10000码点且<=49152UTF8字节，沿用控制字符限制，空白草稿可存不可合成。PATCH/DELETE以及生成准入使用expectedRevision，409保留前端输入；无变化保存不递增。

合成只读取已保存正文。准入短事务校验账户/版本并分配generationSeq，网络调用在事务外复用现有SpeechService/不可变规则快照。完成时短事务锁文章，复核仍存在/所属账户有效、contentRevision未变，并比较最后成功序号。后发已成功则先发晚到返回409 AUDIO_SUPERSEDED；后发失败/尚未成功时先发仍可成功。正文在途变动返回409 ARTICLE_CONTENT_CHANGED且不替换音频，改回原字也不能消除版本变化；仅标题变动可提交。规则在途变动允许保存实际快照结果但标过期。任何失败保留旧成功音频。删除级联并禁止在途结果重建已删文章。

POST文章audio返回持久化JSON metadata；GET文章audio必须带audioId，单次一致读取校验所有权/ID并取字节，旧ID/缺失/无权统一404。已读到旧快照后并发替换允许完整交付该快照，不混配头和字节。前端404只刷新metadata并最多重取一次，不自动重合成。生成共用现有speech/preview的计费限流池、CSRF、Origin和取消处理；客户端断开不撤销已提交结果，响应丢失后GET恢复。原无持久speech/preview继续兼容单词试听。

实施分期：P0规划契约提交后，F1文章CRUD垂直闭环（后端迁移/API、前端列表/新建/详情/保存/删除、冲突与离开保护）；验收后由产品commit，再授权F2最后成功音频垂直闭环（存储/恢复/播放下载/过期/并发/删除在途/限流）。后端和前端不stage/commit；不提前标完成、不改账户/Gateway、不执行远程部署。

F1实现记录（2026-09-10）：wb_articles迁移已实现正文、双版本和所有权外键；generation_seq及wb_article_audio留待F2。ArticleService使用账户行锁串行化写入并原子检查容量，列表计数及分页使用同一可重复读快照。真实HTTP/PostgreSQL测试覆盖跨账户404、并发容量/版本、原文保留与应用重启持久化；后端全套5项通过，0跳过。产品独立HTTP验收7组通过。F1前端浏览器验收及产品独立真实浏览器CRUD、源码与截图回读均通过，F1整体已通过验收并提交2dd6d47；以下F2记录为当前状态。

F2后端实现记录（2026-09-10）：迁移1789056000000-article-audio.cjs新增bigint准入序号及唯一wb_article_audio行；metadata JSONB和bytea在同事务upsert，外键级联删除。序号只比较最后成功行，准入序号不改变文章revision或updatedAt。供应商调用复用SpeechService返回的实际规则版本；完成事务在账户锁、文章锁取得后及提交前再次检查取消。GET以所有权、articleId和audioId单次查询获取一致metadata/字节，列表不读取bytea。三个生成POST共享10次/分钟/账户的入口限流，大小写与尾斜杠变体一致；已存音频GET不占池。Origin检查与框架大小写语义一致。真实PG/Gateway transport并发、取消、HTTP、重启及全库备份恢复通过；仅使用可播放测试音调，无付费调用；F2前端和产品验收均通过。

F2依赖修正（2026-09-10）：产品在Gateway提交c86b5e2修复合法0.01语速步进的浮点误拒；应用已消费vendor/tts-gateway-0.1.1.tgz并更新API package/锁，移除旧0.1.0包。更新后完整后端6项再次通过、0跳过，真实HTTP文章合成覆盖speed=1.15且metadata保持1.15；隔离3002/3003已重启，生产8080未改。

F2产品独立验收（2026-09-10）：3003真实HTTP7组PASS，覆盖metadata/40585字节及响应头、跨账户404/缺audioId400、标题与正文过期差异、失败保留/成功替换旧ID404、规则版本过期、重登参数恢复和删除后404。4183真实浏览器5组PASS：一次点击保存并以1.15生成、实际解码播放暂停下载、刷新恢复、标题/正文/供应商失败保留旧音频、1.25再次生成替换及390宽布局。下载SHA256与备份恢复记录一致，浏览器errors=[]，产品已回看截图。后端必要检查已完成，文件冻结；F2前端最终报告已通过产品核对，整体通过验收并由产品统一提交。
