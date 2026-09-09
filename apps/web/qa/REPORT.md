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
