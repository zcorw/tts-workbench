# 前端验收记录

日期：2026-09-06。自动化脚本：[check.cjs](check.cjs)。完整通过项：[artifacts/results.json](artifacts/results.json)。

26 项交互检查通过，无未捕获页面异常。覆盖未登录路由、账户创建及错误密码、无音色禁用、正文真实选区、原字保留、同词与新文章复用、刷新持久化、真实 localStorage 写入失败、删除失败及重试、列表查询/CRUD、跨标签 revision 冲突、换行/emoji、IME 合成事件、空/长正文、账户设置、会话失效、账户切换隔离、关闭注册、320px/390px 布局及 dialog 焦点。

播放状态验证使用测试脚本路由注入的真实 PCM WAV 和原生 Audio 播放事件：检查读法应用后的提交快照、暂停/继续/停止、旧音频标记、失败保持、重生成、参数变更及下载禁用。**这段测试音不是日文语音，未验证 Gateway 或真实日文读法效果。** 应用代码没有测试开关，正常运行无法选择这段音频。

发现并已修复：原型沿用的 innerText 读取对浏览器生成的空 DIV 多读一个换行；改为结构化 DOM 序列化。另修复无音色 option 文案、外部刷新时选区保护、音色加载失败后的禁用状态、手机页脚与窄屏溢出。

## 代表性截图

| 页面 | 桌面 | 手机 |
|---|---|---|
| 登录 | [登录](artifacts/login.png) | [登录](artifacts/mobile-login.png) |
| 创建账户 | [注册](artifacts/register.png) | [注册](artifacts/mobile-register.png) |
| 工作台 | [工作台](artifacts/workbench.png) | [工作台](artifacts/mobile-workbench.png) |
| 就地读法 | [读法弹层](artifacts/reading-editor.png) | [读法弹层](artifacts/mobile-reading.png) |
| 个人读法 | [规则](artifacts/rules.png) | [规则](artifacts/mobile-rules.png) |
| 账户设置 | [账户](artifacts/account.png) | [账户](artifacts/mobile-account.png) |

异常状态：[保存失败](artifacts/save-error.png)、[会话失效](artifacts/session-expired.png)、[注册关闭](artifacts/registration-closed.png)。原设计对照：[reference.png](artifacts/reference.png)。

人工图像复核：已查看桌面登录、工作台、账户，以及手机工作台、规则、读法弹层。最终截图保留真实无日文音色状态，未给正常产品截图注入虚构音色或虚构成功音频。

## 仍需真实服务验收

本机账户不是生产认证；服务端独立账户模块、会话撤销、数据库授权、Gateway 日文音色/读法/MP3 均未接通。IME 自动检查覆盖 composition 生命周期，不能替代真实设备输入法验收。生产后端任务保持未完成。

## 有界产品复核

产品经理已只读核对页面、源文件、9 张代表截图与当时的 24 项自动检查，结论通过，无必须修复项。确认同词唯一默认读法、正文直接入口、无需求说明/位置例外 UI、页面完整，以及本机能力表达准确。之后补充了 320px 最窄布局和真实键盘选词浮动入口检查，最终 26 项通过。
