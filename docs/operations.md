# 运行、验证与部署

当前应用为React + NestJS + PostgreSQL；账户0.1.1与Gateway0.1.0版本包已置于vendor，应用无需兄弟源码即可构建。生产仅一个应用入口同时提供React静态资源及/v1，HashRouter使用/#/workbench。无供应商配置时音色列表为空、合成503；不会以测试声音兜底。

## 本地运行

### Windows 一键重建 Docker Compose

启动 Docker Desktop，在根目录准备好 `.env`（可复制 `.env.example`，填写实际 `DATABASE_URL` 和 `SESSION_SECRET`），然后双击 `rebuild.cmd`，或执行：

```powershell
.\rebuild.cmd
# 可选：不使用镜像构建缓存
.\rebuild.cmd --no-cache
```

cmd 中直接执行 `rebuild.cmd`。入口会自动定位工程根目录，检查 Docker/Compose、构建 `tts-workbench:local`、启动数据库、运行迁移、重建应用并等待健康检查。失败返回非零退出码，窗口提示具体失败阶段；失败窗口按任意键关闭。自动化调用可直接用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/rebuild-local.ps1`，避免等待按键。

访问端口读取 `.env` 的 `APP_HOST_PORT`，缺省为 `8080`；当前终端的同名环境变量优先。成功后输出实际 `http://127.0.0.1:<端口>/`，Compose 栈仅发布这一个回环端口。脚本仅在运行时把 `PUBLIC_ORIGIN` 对齐此地址，把 `DATABASE_URL` 转为内部 `db:5432`（用户名、密码及数据库名来自原 URL）；本地数据库使用默认非 TLS 连接，不沿用外部数据库的 URL 查询参数。原 `.env` 不改写，供应商等其他配置继续沿用。若另行填写 `POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB`，必须与 URL 一致。

Compose 项目名默认 `tts-workbench`，可在 `.env` 或终端设置 `COMPOSE_PROJECT_NAME`。**已有数据属于另一个 Compose 项目时，必须填写原项目名及匹配的数据库凭据**；不同项目使用独立数据卷，不会自动迁移或复用旧测试项目的数据。已有数据库容器使用 `--no-recreate`，只对应用使用 `--force-recreate`；不执行 `down`、不删除卷。数据库初始化后修改 `.env` 密码不会自动修改已有数据库密码，凭据不一致时需先修正配置。

此入口仅用于 Windows 本地 Compose 开发，临时覆盖 `NODE_ENV=development` 以支持本机 HTTP 和 Cookie；VPS 的生产模式及 HTTPS 要求保持，仍使用下述 Actions 发布流程。

2026-09-09 实测：Windows PowerShell 5.1 语法解析、错误参数非零退出、默认缓存重建、从工程外目录调用 `rebuild.cmd --no-cache`、8081 端口覆盖及恢复8080均通过；页面和 `/health/ready` 返回200。重复重建时数据库容器 ID、卷名、数据库 system identifier 及两张迁移表记录数保持不变。新本地项目仅有一个 `127.0.0.1` 映射，db 无宿主映射；原 `tts-workbench-verify` 测试项目保持运行、未改动。

Node 22.12+及PostgreSQL17。应用根执行npm ci，分别在apps/api和apps/web执行npm ci。复制.env.example为.env，填入数据库URL和随机Session秘密；PUBLIC_ORIGIN开发默认http://127.0.0.1:4181。

```sh
npm --prefix apps/api run build
cd apps/api
node --env-file=../../.env dist/operations.js migrate
cd ../..
npm --prefix apps/api start
# 另一终端
npm --prefix apps/web run dev
```

打开http://127.0.0.1:4181/。API为http://127.0.0.1:3000，Vite代理/v1和/health。开发现场使用独立Docker容器tts-workbench-dev-pg，数据库仅发布127.0.0.1:55432（这是开发数据库，不属于生产Compose配置）。本地隔离.env已启用注册供联调，示例与生产默认关闭。

Compose 部署后的账号开通请使用下面的独立章节。宿主机直接运行 Node 的方式只适用于明确使用宿主开发数据库的场景，不能用来初始化另一套 Compose 数据库。CLI 另支持 `disable <login>`（禁用并撤销会话）及 `cleanup`（清理过期会话）；个人规则长期保留，文章与音频不落库。

## 首次部署后的账号初始化

### 前置条件与字段

首次 Docker Compose 部署已经成功，应用与数据库健康，迁移已完成。Windows `rebuild.cmd` 和 VPS `deploy.sh` 都会执行迁移，日志中的 `Account and vocabulary migrations applied` 表示该步骤成功。**项目没有默认账号、默认密码或超级管理员角色**；公开注册默认关闭，使用 CLI 开通账户无需开启公开注册。

`login` 是登录名：3–120字符，允许英文字母、数字和 `@._+-`，去除首尾空白并统一小写，同库唯一。`displayName` 是界面显示名称：去除首尾空白后1–40字符，可以使用中文，含空格时加引号。密码为8–128字符。下例 `admin` / `我的账户` 仅是可替换的登录名和显示名称，`admin` 不附带任何额外权限。

### Windows 本地 Compose：临时写入根 .env

在工程根目录操作。先确认将要使用的项目和端口：`COMPOSE_PROJECT_NAME` 优先读取当前终端变量，再读取根 `.env`，缺省为 `tts-workbench`；`APP_HOST_PORT` 同样依次读取，缺省为8080。若已经指定4183等端口，保持原值，不要为创建账号更换项目名。

1. 用编辑器在根 `.env` 临时加入以下一行，将引号内占位文字替换为你的实际初始密码。这里采用 dotenv 单引号，避免 `$` 被变量插值；若密码含单引号，按 dotenv 规则转义。不要把该明文提交到仓库。

   ```dotenv
   ACCOUNT_PASSWORD='替换为你自己的8至128字符密码'
   ```

2. 在 PowerShell 执行以下命令，等到输出“重建完成”。只编辑 `.env` 或执行容器 `restart` 不会更新已有容器环境，必须重新创建应用容器。

   ```powershell
   .\rebuild.cmd
   if ($LASTEXITCODE -ne 0) { throw '重建失败，请先解决上面的错误' }
   ```

3. 按重建输出中的“本地项目”填写 `$project`，定位其正在运行的 `app`。下例为默认项目；端口不是容器筛选条件。以下代码均可在同一个 PowerShell 窗口中执行：

   ```powershell
   $project = 'tts-workbench' # 若重建输出不同，替换为该实际项目名
   $app = @(docker ps --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=app' --format '{{.ID}}')
   if ($LASTEXITCODE -ne 0 -or $app.Count -ne 1) { throw '没有找到唯一的运行中 app，请核对项目名' }
   docker exec $app[0] node apps/api/dist/operations.js create admin "我的账户"
   if ($LASTEXITCODE -ne 0) { throw '创建失败，请按下方错误说明处理，并完成密码清理' }
   ```

   cmd 用户在默认项目中可执行 `rebuild.cmd`，成功后执行 `docker exec tts-workbench-app-1 node apps/api/dist/operations.js create admin "我的账户"`；自定义项目按重建输出确认容器名，或使用上面的 PowerShell 标签筛选。

   成功输出形式为 `{"id":"生成的账户ID","login":"admin"}`，退出码为0。创建成功后仍需在网页登录；重复执行同一登录名会报 `ALREADY_EXISTS`，不会重置原密码或覆盖账户。

   该命令在运行中的应用容器执行，继承应用实际的 `DATABASE_URL`，写入当前应用连接的 Compose 数据库。**不要在宿主机执行 `node --env-file=.env apps/api/dist/operations.js create ...` 来代替此步骤**：根 `.env` 可能仍指向 `127.0.0.1:55432` 的旧开发库；重建脚本是在容器配置中将地址转换为 `db:5432` 的。

4. 创建成功后删除根 `.env` 的整行 `ACCOUNT_PASSWORD`；失败并暂不重试时也应执行此清理。再次运行 `.\rebuild.cmd`，等待成功。CLI 内部删除变量只影响该次 CLI 子进程，不能清除已经写入应用容器配置的明文，必须重新创建应用容器。重新定位容器并验证变量不存在（不打印密码）：

   ```powershell
   .\rebuild.cmd
   if ($LASTEXITCODE -ne 0) { throw '清理重建失败，旧容器可能仍持有临时变量，请修复后重试' }
   $app = @(docker ps --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=app' --format '{{.ID}}')
   if ($LASTEXITCODE -ne 0 -or $app.Count -ne 1) { throw '没有找到唯一的运行中 app' }
   docker exec $app[0] node -e 'process.exit(process.env.ACCOUNT_PASSWORD === undefined ? 0 : 1)'
   if ($LASTEXITCODE -ne 0) { throw 'ACCOUNT_PASSWORD 尚未移除，请检查配置并重建' }
   Write-Host '临时密码变量已移除'
   ```

   cmd 用户删除该行后再次运行 `rebuild.cmd` 即可；上述只检查变量是否存在的验证可在 PowerShell 执行。数据库卷保持，已创建账户不会因重建消失。

### VPS / GitHub Actions：向单次 CLI 进程传入临时密码

先完成一次成功发布，确认部署目录的 `current` 指向成功版本，且存在 `current/compose.yaml` 和 `current/release.env`。以下命令在 VPS 的 Bash 中执行，默认目录为 `/opt/tts-workbench`；若部署设置了其他 `DEPLOY_DIR`，替换此目录。在执行期间避免并发发布，以确保选择同一应用版本。不要在 GitHub Actions 日志或生产 `.env.production` 中长期保存 `ACCOUNT_PASSWORD`。

```bash
(
  set +x
  set -e
  cd /opt/tts-workbench
  release=$(readlink -f current)
  test -f "$release/compose.yaml"
  test -f "$release/release.env"
  compose() {
    docker compose --project-name tts-workbench \
      --env-file /opt/tts-workbench/.env.production \
      --env-file "$release/release.env" \
      -f "$release/compose.yaml" "$@"
  }
  compose ps app db
  trap 'unset ACCOUNT_PASSWORD' EXIT
  read -r -s -p '初始密码（8–128字符，输入不回显）：' ACCOUNT_PASSWORD
  printf '\n'
  export ACCOUNT_PASSWORD
  compose exec -T -e ACCOUNT_PASSWORD app node apps/api/dist/operations.js create admin "我的账户"
  unset ACCOUNT_PASSWORD
)
```

若采用其他部署目录，上述 `cd` 与 `.env.production` 的绝对路径都要同步替换。命令使用 `release.env` 中的 `APP_IMAGE` / `RUNTIME_ENV_FILE` 和部署脚本相同的 `tts-workbench` 项目，`exec` 在当前运行的 app 中执行，继承其实际数据库连接。`-e ACCOUNT_PASSWORD` 只向此次进程传递已导出的变量，不把明文写入命令参数或容器持久配置；成功后 `unset`，失败时 EXIT trap 也会清理，整个子 shell 结束后变量不保留。无需因此重建生产应用。

成功同样输出 `id` / `login` JSON。该过程不增加端口、不改变 Compose 网络或 Nginx：容器仍只向宿主 `127.0.0.1` 发布一个端口；浏览器使用宿主 Nginx 配置的 HTTPS 域名登录。

### 登录验证与常见错误

在 Windows 重建输出的地址（例如 `http://127.0.0.1:8080/#/login`，实际端口以配置为准）或 VPS 的 HTTPS 域名打开登录页，输入创建时的 `login` 和密码，进入工作台并核对显示名称。CLI 创建不自动建立浏览器会话。不要用创建命令尝试“登录验证”，否则会触发重名错误。

| 现象 | 处理 |
|---|---|
| `INVALID_ACCOUNT` | 核对 login 格式/3–120字符、displayName 的1–40字符和密码8–128字符；确认两个位置参数均已提供，临时变量实际进入容器。Windows 只改 `.env` 未重建时，变量不会自动出现。 |
| `ALREADY_EXISTS` | 该数据库已有规范化后相同的 login；命令不会修改它。使用已有账户密码登录，或选择另一个登录名，不反复重建或重复创建来重置密码。 |
| `ECONNREFUSED`、认证失败或表不存在 | 核对数据库健康、迁移结果及 app 实际连接的项目。修正连接/迁移后重试，不通过换项目名或删除数据卷解决。 |
| 创建成功但网页无法登录 | 确认网页端口/域名指向刚才执行 CLI 的 app。`tts-workbench`、`tts-workbench-dev-pg` 和 `tts-workbench-verify` 是不同数据库；旧开发库中的账号不会自动出现在新 Compose 库。再核对登录名、密码和账户是否已禁用。 |
| 删除 `.env` 行后变量仍存在 | 需要重新创建应用容器，普通 restart 不够；确认重建成功并在新容器执行上述存在性检查。 |

文档校验范围：以上命令对照现有 CLI、Compose、Windows 重建及 VPS 发布脚本核对，并做语法/只读检查；编写文档时不执行真实账号创建或服务重建。

## Azure 与 AWS TTS 配置

**当前 tts-workbench 仅初始化 Azure 日文运行时。已安装 Gateway 的 Polly adapter 仍声明旧 `zh-CN` 能力；只填写 AWS Key 不会在工作台启用日文 Polly。** 下述 Azure 配置可由当前代码读取；AWS 部分是凭据准备与后续实施说明，不代表已接入。

### Azure：资源、区域和日文音色

在 Azure Portal 中创建 Speech 资源：选择订阅、资源组、资源名称、区域和适合自己的定价层，完成部署后进入资源的“Keys and Endpoint（密钥和终结点）”页取得 Key，并核对资源 Region。本工程固定使用 **Japan East / `japaneast`**；应使用该区域资源的 Key。其他区域目前需要修改并验证 Gateway，不能靠新增 `.env` 字段切换。创建资源和获取凭据的官方流程见[Speech 快速入门](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/get-started-text-to-speech)与[Speech REST 授权说明](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech)。

从官方音色表选择 `ja-JP` 音色，例如 `ja-JP-NanamiNeural` 或 `ja-JP-KeitaNeural`，并在所选区域的音色列表中确认其可用性。使用音色的完整 ShortName，不是显示名称或资源名；先验证普通 MP3 与 `<sub alias>` 读法，不把其他 HD/自定义音色能力当成已支持。以上是官方列出的候选值，不是本项目已完成付费试听的结论。参见[Azure 日文音色表](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts)和[区域音色列表 API](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech#get-a-list-of-voices)。

在本地根 `.env`，或 VPS 部署目录的 `.env.production` 中填写以下**准确变量名**，将 Key 占位符换成真实值；示例 voice 也需经过上面的区域核对：

```dotenv
TTS_AZURE_SPEECH_KEY='REPLACE_WITH_YOUR_RESOURCE_KEY'
TTS_AZURE_JA_VOICE_ID=ja-JP-NanamiNeural
```

| 配置/行为 | 当前实现 |
|---|---|
| `TTS_AZURE_SPEECH_KEY` | 服务器订阅 Key，传给 Gateway 的同名 secret reference；空白 Key 不能通过 adapter 初始化。 |
| `TTS_AZURE_JA_VOICE_ID` | 传给 Azure 的 provider voice ID；前端不直接使用它，公开别名固定为 `ja-jp-primary`，provider 为 `azure-speech`。 |
| 两项都未配置 | 不初始化 TTS；登录后的 `/v1/voices` 返回空 `items`，合成返回503 `TTS_UNAVAILABLE`。账户和规则功能可继续使用。 |
| 只配置其中一项 | 应用启动失败，提示 `Both Japanese Azure voice and key must be configured`；两项要一起填写或一起删除。 |
| 区域与 endpoint | 当前 Gateway defaults/factory 固定 `japaneast`；没有可用的 `TTS_AZURE_REGION`、`AZURE_REGION` 或 endpoint 覆盖字段。官方示例中的 `SPEECH_KEY` 等名称不能代替本工程变量。 |
| `TTS_PRODUCTION_APPROVED` | 当前 config.ts 接受 `true`/`false`，默认false，传入 Gateway 配置；不是供应商凭据或付费开关。 |
| `TTS_DATA_POLICY_REF` | 当上项为true，Gateway 校验要求非空的实际审批记录引用。不要为了启动填写虚假记录；当前代码不将false本身作为生产合成禁用条件。 |

`PUBLIC_ORIGIN` 是用户访问网站的 origin，用于同源/会话安全，与 Azure Key、区域、endpoint 或 AWS 凭据无关。VPS 应为宿主 Nginx 的 HTTPS 域名；生产模式要求 HTTPS。本地重建脚本会将其临时对齐实际 `127.0.0.1` 发布端口，并采用开发运行模式。

### 让供应商配置生效

Windows 本地：编辑根 `.env` 后在根目录执行 `.\rebuild.cmd`，等待健康完成。脚本以根 `.env` 作为 `RUNTIME_ENV_FILE`，把环境注入 app，再强制重建 app；数据库容器和数据卷保留。普通 `docker restart` 不会重新读取修改后的 env_file。若使用宿主 Node 开发模式，则退出并重新运行原 `node --env-file=...` 启动命令。

VPS：修改实际运行配置文件（默认 `/opt/tts-workbench/.env.production`）后，使用当前成功 release 的相同参数重新创建 app。默认目录的完整 Bash 命令如下；自定义部署目录修改 `root`，并避免与发布并发：

```bash
(
  set -e
  root=/opt/tts-workbench
  release=$(readlink -f "$root/current")
  test -f "$release/compose.yaml"
  test -f "$release/release.env"
  docker compose --project-name tts-workbench \
    --env-file "$root/.env.production" \
    --env-file "$release/release.env" \
    -f "$release/compose.yaml" \
    up -d --no-deps --force-recreate --wait --wait-timeout 180 app
)
```

该命令通过 `release.env` 选择已发布镜像及 `RUNTIME_ENV_FILE`，不会重新构建镜像或重建数据库；如果曾自定义运行文件路径，应修改该路径指向的文件。只修改 env_file 后执行 `restart` 不够。端口映射仍由既有 Compose 配置控制，保持单一宿主 `127.0.0.1` 端口和宿主 Nginx 代理。

### 音色目录与最短合成验证

1. 使用已创建的账户登录工作台，查看音色选择器；也可在同一登录浏览器打开同源 `/v1/voices`，应看到 `id=ja-jp-primary`、`language=ja-JP`、`provider=azure-speech`。未登录会返回401。该目录来自本地配置，不会向 Azure 查询或验证 Key/voice。
2. `/health/ready` 是非计费健康检查。即使返回200或目录有音色，也不证明 Key 有效、音色在区域可用或网络可达；无 TTS 配置时健康仍可正常。
3. 用户准备好承担云端合成费用后，在工作台输入最短日文，例如 `こんにちは。`，选择“日本語”，语速1，点击合成一次。页面负责登录 Cookie、Origin 和 CSRF，检查 `/v1/audio/speech` 返回200及可播放的 MP3，并实际听取结果。随后可用一个词的指定读法验证 alias；这也是一次真实合成，不自动重试。
4. 若启动失败，先核对变量是否成对、是否已重建、审批引用是否与开关一致；若合成失败，核对区域/Key/voice/配额和网络，查看已脱敏的错误类别，勿粘贴请求认证头或完整环境。只有真实试听通过后才记录云端可听验收，不能用测试音调替代。

### AWS Polly：凭据与最小权限准备（当前未接入工作台）

AWS 标准 SDK 凭据字段为 `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`；**只有临时凭据还需要配套的 `AWS_SESSION_TOKEN`**，长期 Key 不填该 token。不要将 token 与另一组 Key 混用。字段定义见[AWS 凭据环境变量](https://docs.aws.amazon.com/sdkref/latest/guide/feature-static-credentials.html)。

优先让 AWS 托管运行环境通过容器任务角色或 EC2 实例角色提供临时凭据，由 SDK 默认凭据链取得；一般 VPS 并不会因为装了 Docker 就自动拥有 AWS 角色。确需环境变量时只通过受保护的服务端运行配置传入，避免长期 access key；现有 Gateway Polly 使用默认凭据链，但工作台当前并未初始化它。参见[AWS SDK for JavaScript 默认凭据链](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)。

针对列出音色与同步文本合成的最小操作集合，可给专用 IAM 身份附加以下策略；这里不授予词典管理、异步任务、S3 或其他 Polly 操作。`Resource: "*"` 用于此不指定 lexicon 的基础调用，参考[Polly API 权限表](https://docs.aws.amazon.com/polly/latest/dg/api-permissions-reference.html)：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["polly:DescribeVoices", "polly:SynthesizeSpeech"],
      "Resource": "*"
    }
  ]
}
```

此 IAM 准备不表示工作台已支持 AWS。**不要期待添加 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 后出现日文音色，也不要把尚未实现的 Polly 配置名当成可用 `.env` 接口。** 已安装 Gateway 的默认 Polly 区域是 `ap-northeast-1`，由 factory 固定；其 adapter capability 与旧 voice 配置仍为 `zh-CN`，当前工作台也没有 AWS 区域/engine/日文 voice 的配置读取路径。

真正启用日文 Polly还需要完成：

- 设计并实现工作台配置字段及校验，接入 AWS 区域、凭据链、engine/voice 选择，而不是仅传递未使用的环境变量。
- 初始化 Polly provider，建立日文 provider voice ID 与公开 alias 的映射，同步目录 provider 类型、账户音色权限和 OpenAPI/前端类型。
- 完成 Gateway 的 `ja-JP` capability、SSML序列化、词汇 alias/速度与 MP3 支持，验证所选区域/engine/voice 的组合；不能只改语言标签。官方区域音色查询接口见[DescribeVoices](https://docs.aws.amazon.com/cli/latest/reference/polly/describe-voices.html)。
- 更新版本包及宿主依赖，覆盖路由、语言约束、权限、错误和配置缺失测试，再用真实凭据进行最短计费试听和日文读法验收。

供应商密钥不得提交 Git、写入 README、输出日志或放到 `VITE_*` 等前端变量；不要通过打印完整 `.env`、`docker inspect` 环境或未脱敏 Compose 配置来排错。本次只补文档，未读取真实密钥、修改运行配置或调用付费合成。

### 当前日文规则与验收边界

用户可用1–100字符普通文本指定读法；alias效果需真实供应商试听确认，不承诺精确重音。正文不normalize，保存的规则NFC-normalize，以原文字面、区分大小写、最左最长、稳定顺序、单轮非递归匹配。上限仍受Gateway/provider资源限制，输入长不等于保证成功。音频完整缓冲、最多8MiB，超时/错误不自动重试计费请求。

## 验证命令与当前证据

```sh
npm run contract:validate
node scripts/verify-deployment.mjs
# TEST_DATABASE_URL必须指向隔离PG库；未给出时DB测试明确skip
npm test
npm --prefix apps/web run check:api
npm --prefix apps/web run build
```

Gateway独立目录：build、typecheck、lint、224项单测、16项HTTP回归通过。账户独立目录：3项真实PG测试与只安装tgz的独立Nest消费者通过。应用3项集成测试含真实HTTP/PG、CSRF/会话、版本冲突、账户隔离和Gateway日文供应商transport夹具；前端22项契约检查、13项真实页面/API/PG检查及产品有界评审通过。详见[前端报告](../apps/web/qa/REPORT.md)、[API评审](API_REVIEW.md)。真实可听音频未计为通过。

## VPS准备与Actions发布

VPS安装Docker Engine/Compose v2、宿主Nginx，准备域名/TLS。初始支持linux/amd64；其他架构需按VPS构建目标验证。将deploy/runtime.env.example复制到VPS部署目录（默认/opt/tts-workbench）的.env.production，权限600，填入密码及秘密。DATABASE_URL主机为Compose服务名db，密码需URL编码。VPS预先用只读镜像凭据登录对应GHCR私有镜像。

GitHub配置production环境：Secrets为VPS_HOST、VPS_USER、VPS_SSH_KEY、VPS_KNOWN_HOSTS（预先可信渠道核实主机公钥，不在流程中盲目ssh-keyscan）；变量DEPLOY_DIR可覆盖默认。环境限制可部署分支及所需审核由仓库管理者设置。workflow_dispatch手动启动工作流，检查契约/真实PG测试/前端构建后，以commit标签推镜像、取得digest，经校验SSH部署；生产并发串行。这里只交付配置，未连接真实VPS、未运行GitHub远程工作流。

deploy.sh记录每次release的Compose配置及镜像digest，拉取失败不切换；先启动DB并备份、执行显式迁移，再更新应用并等待非计费readiness。健康失败恢复previous release镜像；数据库迁移必须保持前版本兼容，回滚应用不等于回滚数据库。首次部署失败无旧应用可恢复，需修正配置重新发布，数据卷保留。没有零停机承诺。

## 唯一宿主入口与代理

compose.yaml唯一ports映射显式host_ip=127.0.0.1，默认8080可配置；db无ports。容器应用内部监听0.0.0.0:3000。宿主Nginx使用deploy/nginx.conf.example，负责公网TLS并反代该回环端口，不新增容器TLS/IPv6公网映射。PUBLIC_ORIGIN必须与外部地址完全匹配。

TRUST_PROXY只填写应用实际看到的宿主代理来源地址/CIDR（Docker bridge gateway，需在VPS核实），不要无条件信任所有代理。Nginx覆盖X-Forwarded-For/Proto，不沿用客户端自报；应用由此正确判断HTTPS并写Secure Cookie。静态文件、API错误和音频类型/长度/版本头分别保持，代理超时75秒且无缓存，不把API错误重写成前端页面。

本地Compose实际验证：单127.0.0.1:4183映射、数据库无host端口、页面/ready200、重复启动、模拟健康失败与恢复正常配置后数据保留。未执行真实VPS部署和外部公网直连探测。本地宿主Nginx启动验证命令被自动审批以“blocked by policy”拒绝，未计代理/TLS实测通过；示例配置仍需目标宿主nginx -t及代理验收。

## 备份与恢复

deploy/scripts/backup.sh使用pg_dump自定义格式，输出权限受umask077保护，每日备份保留7天；部署前备份单独保留，运维按容量管理。脚本可纳入宿主现有定时机制，本次未创建系统定时任务。

恢复先导入独立数据库并核查账户数、规则内容/版本，再在维护窗口切换DATABASE_URL。示意：`createdb -U <owner> restore_check`，`pg_restore -U <owner> -d restore_check --no-owner <backup.dump>`。不要对当前库自动drop或用Compose down -v。已在隔离Compose库中实际备份并恢复账户及“日本→にほん”规则，验证数据与迁移表存在；健康失败恢复后原数据库规则保留。
