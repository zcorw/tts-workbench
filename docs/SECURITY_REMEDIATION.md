# 依赖安全修复候选（2026-10-30）

基线为已发布的 `8596865`。本次采用工作树已有的依赖升级与定向 overrides，不重复生成或覆盖用户的锁文件；新增有界安全回归，验证同一最终候选。本说明记录本地开发验收；代码发布与生产部署分别需要授权，推送代码不会自动更新VPS。

## 修复版本与范围

| 范围                | 已发布版本      | 修复候选        | 用途及注意                                                         |
| ------------------- | --------------- | --------------- | ------------------------------------------------------------------ |
| API body-parser     | 2.3.0           | 2.4.0           | Express JSON 请求解析；压缩流结束/错误处理，优先运行时修复         |
| API proxy-addr      | 2.0.7           | 2.0.8           | 代理信任/IP判断；不修改真实 TRUST_PROXY，检查修复后的映射网段判断  |
| API/Web Zod         | 4.5.4           | 4.6.7           | 修复版本至少4.6.6；统一账户包传递副本，保留数组/正文大小和鉴权限制 |
| API Multer          | 2.2.0           | 2.5.0           | Nest传递依赖；当前没有multipart上传入口，修复版本仍入锁            |
| API gRPC            | 1.14.4          | 1.14.6          | Gateway/OTel传递依赖；当前不是gRPC认证服务器                       |
| API brace-expansion | 5.0.9           | 5.0.12          | 迁移CLI依赖，不将文章当glob处理                                    |
| Web brace-expansion | 2.1.4           | 2.1.7           | 开发/类型生成工具链                                                |
| Web js-yaml         | 4.3.1           | 4.3.2           | Redocly/OpenAPI工具链                                              |
| Web source-map-js   | 1.2.1           | 1.2.2           | PostCSS构建工具链                                                  |
| Web Vite            | 8.2.2           | 8.3.5           | 修复Windows编辑器调用及其他公告；生产不运行Vite                    |
| API ip-address / qs | 10.7.0 / 6.16.0 | 10.7.5 / 6.16.1 | 覆盖审计中的中危项                                                 |
| 根工具 fast-uri     | 3.1.7           | 3.1.9           | OpenAPI校验工具链                                                  |

API顶层Nest 12.0.1→12.2.0、Express 5.2.1→5.3.0、Zod 4.5.4→4.6.7，以及Web Vite都在原主版本线内。但Express带入的content-type 1→2、content-disposition 1→2是传递主版本变化，不能称所有依赖都只有patch/minor；HTTP正文/内容类型、音频下载和静态资源回归需覆盖。

Gateway版本包仍声明旧Nest，账户包仍精确声明旧Zod；应用overrides统一已安装版本，另外固定Multer2.5.0/body-parser2.4.0。没有通过隐藏公告、关闭审计、删除必要功能或放松TLS/Origin/CSRF/数据库隔离得到审计零项。

## 审计与验证

旧锁只读审计：API 1 critical、9 high、2 moderate；Web 6 high；根工具1 moderate；CMS 0。计数包含依赖传播节点，高危/严重去重为9个底层包、13条公告。API `--omit=dev`仍包含迁移CLI和Gateway传递依赖，因此不能把production标记直接等同于公网可达。

最终候选审计与运行证据在本地评估任务 `security-remediation-20261030/`。本说明的版本是候选清单，只有最终记录为通过的结果才计作本轮验收；审计不涵盖VPS配置、镜像OS包或未知漏洞，也不代表已经生产上线。

新增 `apps/api/test/security-regression.test.mjs` 使用修复版本前置检查和小体积合成数据，覆盖压缩JSON/异常后继续服务、代理子网判断、受限数组校验等。测试数据库只能为显式隔离的 `cms_reading_test_20261027`，不得指向真实数据。宿主旧node_modules不会用来执行这些请求；以锁文件在隔离Docker内安装后的最终依赖为准。

原API全套继续覆盖双端口认证/CSRF、文章并发版本冲突、JSON导入、发布快照、音频失败保留与重试；原前端功能与导航保持。真实语音供应商、生产迁移和VPS检查不属于本轮。

## 公告来源

- [body-parser / CVE-2026-111181](https://github.com/advisories/GHSA-27r3-jxmh-p828)
- [proxy-addr / CVE-2026-90711](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)
- [Zod / CVE-2023-54404](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
- Multer：[字段名](https://github.com/advisories/GHSA-wc9g-mqfw-jrwm)、[中止资源泄漏](https://github.com/advisories/GHSA-qfvm-cv95-jqjf)、[数组索引](https://github.com/advisories/GHSA-535w-7cp7-47q4)、[异步fileFilter](https://github.com/advisories/GHSA-q7qp-rjg7-q26m)
- brace-expansion：[嵌套递归](https://github.com/advisories/GHSA-qhr7-859c-m2p7)、[逗号解析](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p)
- [gRPC](https://github.com/advisories/GHSA-m9gg-hp2v-232j)、[js-yaml](https://github.com/advisories/GHSA-2883-xcg3-v3hh)、[source-map-js](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)、[Vite/launch-editor](https://github.com/advisories/GHSA-587h-7wmj-h5pm)

## 本地验收结果

- 最终四包完整审计及API生产依赖审计均为0（root/API/Web/CMS/API omit=dev）。错误映射修补前后四份锁文件哈希一致，审计证据对应同一最终依赖集合。
- 新增安全回归8/8、完整API54/54且0跳过；契约/生成类型/部署结构、Linux部署脚本12场景、双前端构建/类型/格式均通过。
- 首轮测试发现已修复的解析器拒绝异常压缩请求后，应用将客户端错误误报503；现仅将明确的Error实例/expose/status/statusCode/code或type白名单映射400/415。未知内部错误仍503，原始message/body不会回显；没有关闭压缩、放松认证或大小限制。
- 最终生产镜像实际双端口登录、Origin/CSRF、SPA/缺失资源、受保护模拟音频及未配CMS Origin时关闭API通过；255个实际生产包均匹配锁文件，开发依赖和包管理器已移除。
- 浏览器21组、0页面错误，涵盖双编辑器版本冲突、可见/隐藏刷新、手工/JSON导入去重、固定发布音频、模拟失败重试、真实音调播放、登录/导航与320/390视口。按认证限流正常窗口等待，未调整或重置限制。
- 开发验收阶段未调用真实收费供应商、连接VPS、迁移真实数据库或创建真实凭据；没有提交/推送/部署。结论仅为本地候选的已知npm公告和列明回归，不等于VPS现场安全验证，也没有测量内存。
