# VPS 部署指南：Docker 直接部署与 GitHub Actions

更新：2026-09-10。适用于当前 **tts-workbench 应用仓库**：React + NestJS + PostgreSQL 17，包含文章增删改查及每篇最后成功音频。账户包和 Gateway 包已包含在 `vendor/` 中，部署应用不需要克隆另外两个工程。

本文提供两条部署路径，并共用账号初始化、HTTPS、备份和故障处理步骤。命令以 **Ubuntu 24.04 LTS、Linux amd64、Bash** 为示例；这是本文选择的执行环境。当前 Actions 在 amd64 runner 构建，没有配置多架构产物；ARM VPS 需另行验证。

本地已验证应用、持久化、Compose 结构和备份恢复；本文命令已对照仓库实现核对。**编写本文没有连接真实 VPS、推送镜像或运行远程工作流。**

快速跳转：[VPS准备](#2-vps-共同准备) · [Nginx与HTTPS](#3-宿主-nginx-与-https) · [Docker直接部署](#4-路径-adocker-直接部署) · [GitHub Actions](#5-路径-bgithub-actions-部署) · [账号与验收](#7-创建账号与验收) · [更新回滚](#8-更新修改配置与回滚) · [备份排查](#9-备份恢复与排查)

## 1. 选择部署路径

| 对比 | A：Docker 直接部署 | B：GitHub Actions 部署 |
|---|---|---|
| 构建位置 | VPS 上构建，或直接拉取已有版本镜像 | GitHub runner 构建并推送 GHCR |
| 是否需要 GitHub | 不需要，可上传 Git 源码归档 | 需要应用仓库、Actions 和 GHCR 权限 |
| 发布方式 | 在 VPS 执行第 4 节命令 | 在 GitHub 点击 Run workflow |
| 版本记录 | 每个 Git SHA 一个本地镜像标签和 release 目录 | 每个 Git SHA 一个 release，镜像按 digest 部署 |
| 更新与数据 | 替换 app，复用 PostgreSQL 卷 | 备份、迁移、更新 app，复用同一卷 |
| 适合场景 | 首次部署、独立 VPS、暂不接 CI | 日常版本发布和可追踪的自动部署 |

阅读顺序：**第 2、3 节共同准备 → 第 4 或 5 节部署 → 第 6、7 节登录验收 → 第 8、9 节日常运维**。

部署拓扑固定为：

~~~text
浏览器 HTTPS :443
        ↓
VPS 宿主机 Nginx（域名与 TLS）
        ↓
127.0.0.1:8080（唯一 Docker 宿主映射，可改端口）
        ↓
app:3000（React 静态文件 + /v1 API + 音频）
        ↓
db:5432（仅 Compose 内网，PostgreSQL 持久卷）
~~~

不要另开前端 4181、API 3000 或数据库 5432 的公网入口。生产页面、接口和音频共用同一 HTTPS 域名。

## 2. VPS 共同准备

### 2.1 安装组件与配置部署用户

准备域名，例如 `tts.example.com`，将 DNS A 记录指向 VPS。下文 Nginx 示例使用 IPv4；只有同时配置好宿主 Nginx 的 IPv6 监听和连通性时，才添加 AAAA 记录。云安全组/宿主防火墙允许 SSH、HTTP 80、HTTPS 443；8080 和数据库端口不需要对公网放行。

Docker Engine、Buildx 与 Compose 插件按 [Docker 官方 Ubuntu 安装步骤](https://docs.docker.com/engine/install/ubuntu/)安装，使用官方 apt 仓库。已有 Docker 的机器先核对版本及兼容性，不要直接执行卸载旧环境的命令。

在 VPS 管理员终端安装其余工具：

~~~bash
sudo apt-get update
sudo apt-get install -y git nginx openssl jq certbot util-linux
sudo systemctl enable --now docker nginx
docker --version
docker compose version
docker buildx version
~~~

以下以专用用户 `deploy` 为例。已存在时跳过创建，不要重复建立用户：

~~~bash
sudo adduser --disabled-password --gecos '' deploy
sudo usermod -aG docker deploy
sudo install -d -m 750 -o deploy -g deploy /opt/tts-workbench
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
sudoedit /home/deploy/.ssh/authorized_keys
# 在编辑器中追加你的登录公钥并保存，然后设置属主和权限。
sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys
sudo chmod 600 /home/deploy/.ssh/authorized_keys
~~~

为该用户配置自己的 SSH 公钥后，重新通过 SSH 登录为 `deploy`，执行 `docker ps`，确认不需要 sudo 或交互式密码。Actions 使用的用户也必须具备这一能力。Docker 组具有接近 root 的主机权限，部署凭据应交给受信任的维护者。[Docker 用户权限说明](https://docs.docker.com/engine/install/linux-postinstall/)

本指南固定 Compose 项目名 `tts-workbench`，与仓库发布脚本一致；通常对应 `tts-workbench_postgres_data` 卷。**已有实例必须保留原项目与卷关系**，改项目名不会自动迁移数据。不要把生产步骤用到已有开发项目的数据库上。

### 2.2 目录布局

两条路径都使用：

~~~text
/opt/tts-workbench/
├── .env.production          # 服务器配置，不上传 GitHub
├── current -> releases/...  # 最近一次成功发布
├── releases/<完整Git-SHA>/
│   ├── compose.yaml
│   └── release.env          # APP_IMAGE、RUNTIME_ENV_FILE
├── backups/                 # 数据库备份
├── deploy.lock
└── sources/<完整Git-SHA>/    # 仅路径 A 需要源码
~~~

更改部署目录时，要同步本文的 `/opt/tts-workbench` 和 GitHub 的 `DEPLOY_DIR`。现有脚本只接受由字母、数字、`/`、`_`、`-` 组成的非根绝对路径。

### 2.3 创建生产配置

以下在 **VPS 的 deploy 用户 Bash** 执行，仅用于首次创建。将域名改成真实域名，不含路径和末尾斜杠。数据库密码自动使用十六进制随机值，避免 URL 编码错误；命令不会输出秘密值。

~~~bash
(
  set -euo pipefail
  umask 077
  root=/opt/tts-workbench
  domain=tts.example.com
  test ! -e "$root/.env.production" || {
    printf '配置已存在，请编辑原文件，不要重新生成数据库密码。\n' >&2
    exit 1
  }
  db_password=$(openssl rand -hex 24)
  session_secret=$(openssl rand -hex 48)
  cat > "$root/.env.production" <<EOF
POSTGRES_USER=workbench
POSTGRES_DB=workbench
POSTGRES_PASSWORD=$db_password
DATABASE_URL=postgresql://workbench:$db_password@db:5432/workbench
SESSION_SECRET=$session_secret
PUBLIC_ORIGIN=https://$domain
REGISTRATION_ENABLED=false
MAX_ARTICLES=100
APP_HOST_PORT=8080
TRUST_PROXY=loopback
EOF
  chmod 600 "$root/.env.production"
)
~~~

| 配置 | 作用与填写规则 |
|---|---|
| `POSTGRES_USER / POSTGRES_DB / POSTGRES_PASSWORD` | PostgreSQL 初始化配置。已有数据库卷不会因修改这些值自动修改用户密码或创建新库。 |
| `DATABASE_URL` | app 使用的连接串；主机必须为 `db`，端口5432，并与数据库实际凭据一致。自选含特殊字符的密码需对 URL 中的密码部分编码。 |
| `SESSION_SECRET` | 至少32字符；保持稳定。更换后已有会话可能失效。 |
| `PUBLIC_ORIGIN` | 真实 HTTPS origin，例如 `https://tts.example.com`；不是容器地址或带路径的 URL。生产模式拒绝 HTTP。 |
| `TRUST_PROXY` | 初始 `loopback` 仅用于启动；**首次发布后必须按第 6 节核实并填写 Docker 网关地址**，否则 HTTPS 登录可能不设置 Cookie。 |
| `REGISTRATION_ENABLED` | 默认 false。通过第 7 节 CLI 开通账号，无需开放公共注册。 |
| `MAX_ARTICLES` | 每账户文章上限，默认100。 |
| `APP_HOST_PORT` | 宿主回环端口，默认8080；修改时同步 Nginx 的上游端口。 |

`APP_IMAGE` 和 `RUNTIME_ENV_FILE` 写入每个 release 的 `release.env`，不手工混进服务器长期配置。两份 env 文件用途不同：Compose 的 `--env-file` 负责变量替换，`RUNTIME_ENV_FILE` 指向的文件通过服务 `env_file` 注入容器。使用后文完整命令，不要仅在任意目录执行 `docker compose up`。[Compose 环境变量说明](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)

### 2.4 配置日文语音供应商

编辑 `/opt/tts-workbench/.env.production`，成对加入真实值：

~~~dotenv
TTS_AZURE_SPEECH_KEY='替换为真实Speech资源Key'
TTS_AZURE_JA_VOICE_ID=ja-JP-NanamiNeural
~~~

当前应用只接入 Azure 日文，区域固定 `japaneast`；示例音色需在该区域核实可用。没有可用的 `TTS_AZURE_REGION` 覆盖字段。AWS Key 当前不会启用工作台的日文 Polly。

两项都不填时，文章和账号功能可用，但音色目录为空、合成返回503；只填一项会启动失败。已有音频的读取不依赖当前供应商可用性。详细资源与音色设置见[供应商配置说明](operations.md#azure-与-aws-tts-配置)。不要将真实配置写入源码、前端 `VITE_*` 或 GitHub 仓库。

## 3. 宿主 Nginx 与 HTTPS

以下由有 sudo 权限的管理员执行。已有域名证书和 Nginx 时，可直接合并对应站点配置，保留其他站点。

### 3.1 首次申请证书

创建 ACME 验证目录：

~~~bash
sudo install -d -m 755 /var/www/letsencrypt/.well-known/acme-challenge
sudoedit /etc/nginx/sites-available/tts-workbench
~~~

先写入临时 HTTP 站点，将域名替换为实际值：

~~~nginx
server {
    listen 80;
    server_name tts.example.com;
    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }
    location / {
        return 503;
    }
}
~~~

启用站点、验证配置并申请证书；域名 DNS 和80端口此时必须已生效：

~~~bash
sudo ln -sfn /etc/nginx/sites-available/tts-workbench /etc/nginx/sites-enabled/tts-workbench
sudo nginx -t
sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/letsencrypt \
  -d tts.example.com --email you@example.com --agree-tos
~~~

本文使用 Certbot webroot 验证，后续80端口需继续允许 ACME 验证。[Certbot webroot 与证书更新说明](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot)

### 3.2 切换为正式反向代理

证书申请成功后，用以下内容替换该站点文件。将所有域名和证书目录替换为实际值；若 Certbot 分配了带后缀的证书目录，用 `sudo certbot certificates` 核对。

~~~nginx
server {
    listen 80;
    server_name tts.example.com;
    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name tts.example.com;
    ssl_certificate /etc/letsencrypt/live/tts.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tts.example.com/privkey.pem;
    client_max_body_size 64k;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Connection "";
        proxy_read_timeout 75s;
        proxy_send_timeout 75s;
        proxy_buffering off;
        proxy_cache off;
    }
}
~~~

配置与仓库 [nginx.conf.example](../deploy/nginx.conf.example)的 HTTPS 代理段一致。Nginx 覆盖转发头，并把页面、API、音频传到同一入口；不要另外给 `/v1` 配置前端兜底或把错误改写成 HTML。[Nginx 代理头文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header)

~~~bash
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
systemctl status certbot.timer
~~~

为续期配置 Nginx reload 钩子；这是 VPS 管理员执行的配置步骤，本文不会自动创建服务器定时任务：

~~~bash
sudo install -d /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\n/usr/sbin/nginx -t && /bin/systemctl reload nginx\n' \
  | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh >/dev/null
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
~~~

核对机器上的 Certbot 安装方式确实安排了自动续期；没有 timer 时按该安装方式配置。app 尚未发布时，HTTPS 暂时返回502属于预期，继续下一节。

## 4. 路径 A：Docker 直接部署

### 4.1 上传已提交的源码

可上传 Git 归档，无需先创建 GitHub 仓库。以下在 **本地 Windows PowerShell** 执行，替换 VPS 地址；使用应用仓库，不是 TTS-gateway 仓库：

~~~powershell
Set-Location D:\Workspace\github\tts-workbench
git status --short
$revision = git rev-parse HEAD
git archive --format=tar --output="$env:TEMP\tts-workbench-source.tar" HEAD
scp "$env:TEMP\tts-workbench-source.tar" deploy@VPS_HOST:/opt/tts-workbench/source.tar
$revision
~~~

记录最后输出的完整40位 Git SHA。归档仅包含已提交文件，未提交的修改不会部署；真实 `.env`、`node_modules` 和数据库数据不应加入归档。也可在 VPS 克隆应用仓库并检出指定提交，再把后文 `source_dir` 指向该目录。

以下回到 **VPS deploy 用户 Bash**。把占位 SHA 替换为刚才的完整值：

~~~bash
(
  set -euo pipefail
  root=/opt/tts-workbench
  revision='替换为完整40位Git提交SHA'
  [[ "$revision" =~ ^[a-f0-9]{40}$ ]]
  source_dir="$root/sources/$revision"
  test ! -e "$source_dir"
  mkdir -p "$source_dir"
  tar --no-same-owner -xf "$root/source.tar" -C "$source_dir"
  test -f "$source_dir/Dockerfile"
  test -f "$source_dir/compose.yaml"
  test -f "$source_dir/vendor/tts-gateway-0.1.1.tgz"
)
~~~

同一提交已经解压过时，核对原目录即可，不重复覆盖。未来依赖版本升级后，以上版本包检查应与 `apps/api/package.json` 保持一致。

### 4.2 构建、备份、迁移并启动

替换 `revision` 后执行完整代码块。它与 Actions 使用相同的项目名、配置布局和数据库卷；但本路径从本机镜像启动，不调用要求 GHCR digest 的 `deploy.sh`。

~~~bash
(
  set -euo pipefail
  umask 077
  root=/opt/tts-workbench
  revision='替换为完整40位Git提交SHA'
  [[ "$revision" =~ ^[a-f0-9]{40}$ ]]
  source_dir="$root/sources/$revision"
  release="$root/releases/$revision"
  tag="tts-workbench:$revision"
  test -f "$root/.env.production"
  test -f "$source_dir/Dockerfile"
  mkdir -p "$release" "$root/backups"
  exec 9>"$root/deploy.lock"
  flock -n 9 || { printf '另一个发布正在运行。\n' >&2; exit 1; }

  # 已构建的提交标签不覆盖；新源码使用新提交。
  if ! docker image inspect "$tag" >/dev/null 2>&1; then
    docker build --pull -t "$tag" "$source_dir"
  fi
  docker image inspect --format '{{.Id}}' "$tag" > "$release/image.id"
  cp "$source_dir/compose.yaml" "$release/compose.yaml"
  printf 'APP_IMAGE=%s\nRUNTIME_ENV_FILE=%s/.env.production\n' \
    "$tag" "$root" > "$release/release.env"
  compose() {
    docker compose --project-name tts-workbench \
      --env-file "$root/.env.production" --env-file "$release/release.env" \
      -f "$release/compose.yaml" "$@" < /dev/null
  }
  compose config --quiet
  previous=''
  if test -L "$root/current"; then previous=$(readlink -f "$root/current"); fi
  compose up -d --wait --wait-timeout 90 db
  backup="$root/backups/before-$revision-$(date -u +%Y%m%dT%H%M%SZ).dump"
  compose exec -T --interactive=false db sh -c \
    'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup"
  test -s "$backup"
  compose run --rm -T --interactive=false --no-deps --pull never app node apps/api/dist/operations.js migrate
  if compose up -d --no-deps --pull never --wait --wait-timeout 90 app; then
    ln -sfn "$release" "$root/current"
    compose ps
    printf '发布完成：%s\n' "$revision"
  else
    if test -n "$previous" && test "$previous" != "$release"; then
      docker compose --project-name tts-workbench \
        --env-file "$root/.env.production" --env-file "$previous/release.env" \
        -f "$previous/compose.yaml" up -d --no-deps --pull never \
        --wait --wait-timeout 90 app
    fi
    exit 1
  fi
)
~~~

镜像标签按本指南约定不覆盖，`image.id` 记录实际镜像ID；本地标签不是 registry digest。保留回滚所需镜像，不能在发布前清理旧镜像。`--wait` 等待健康状态，不表示外部域名、账号或日文发音都已通过验证。[Compose up 文档](https://docs.docker.com/reference/cli/docker/compose/up/)

迁移包含账户、个人规则、文章和唯一音频。当前 CLI 的成功日志仍叫 `Account and vocabulary migrations applied`，文字没有列全表名，但实际执行完整迁移。首次部署也会先备份新建数据库。

继续第 6、7 节完成代理信任和账号验收。后续更新仍按 4.1、4.2 上传新提交并发布，**不执行 `docker compose down -v`**。

### 4.3 已有镜像时：手动拉取部署

如果已经有对应版本的 registry 镜像，可跳过 VPS 源码构建，直接手动使用现有发布脚本。先用 SCP 等方式，把**镜像对应提交**的 `compose.yaml` 放到 `/opt/tts-workbench/releases/<完整Git-SHA>/compose.yaml`，把 `deploy/scripts/deploy.sh` 上传到 `/opt/tts-workbench/deploy.sh`。私有镜像需先以 deploy 用户登录 registry，GHCR 方法见 5.3 节。

在 VPS 执行，替换两个占位值：

~~~bash
bash /opt/tts-workbench/deploy.sh \
  /opt/tts-workbench \
  'ghcr.io/your-owner/tts-workbench@sha256:替换为实际64位镜像digest' \
  '替换为镜像对应的完整40位Git提交SHA'
~~~

该脚本会拉取镜像、备份、迁移并启动，不需要触发 GitHub Actions。镜像参数必须是 `仓库地址@sha256:digest`，不能传 `latest` 或本机 `sha256:镜像ID`；当前脚本的地址校验不接受带自定义端口的 registry 地址。release目录须提前创建，脚本不会从Git自动获取文件。

## 5. 路径 B：GitHub Actions 部署

### 5.1 准备应用仓库

将整个 `tts-workbench` 应用仓库推送到你自己的 GitHub 仓库，包含：

- `.github/workflows/deploy.yml`、`Dockerfile`、`compose.yaml`。
- `deploy/scripts/deploy.sh` 与 `backup.sh`。
- `apps/api`、`apps/web`、`vendor/*.tgz` 及全部对应 lock 文件。

当前本地工程尚未配置远程地址。可在 GitHub 创建空仓库，再按其指引关联和推送；已有 remote 时直接使用既有地址。不要把生产 `.env.production` 推上去。账户/Gateway 无需另外发布 npm 包，CI 会校验随仓库携带的版本包与锁文件完整性。

工作流名称为 **Validate, build and deploy VPS**，只配置了 `workflow_dispatch`：**push 不会自动部署**。工作流文件必须先存在于仓库默认分支，才能从 Actions 页面手动触发；触发时可以选择具备该文件的目标分支，且须符合环境分支规则。[GitHub 手动运行说明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)

### 5.2 配置 SSH 与 production 环境

当前工作流使用 **SSH 22端口**，`VPS_HOST` 支持 DNS 名称或 IPv4，不支持带端口的值和 IPv6 字面量。非22端口需要先修改工作流中的 ssh/scp 参数，不能只新增一个未被读取的 Secret。

准备专门的 Ed25519 部署密钥：公钥追加到 VPS 的 `/home/deploy/.ssh/authorized_keys`，权限600、属主deploy；私钥保存到 GitHub Secret。现有工作流没有私钥口令解密步骤，自动化专用私钥不要设置需要交互输入的口令。

主机公钥从 VPS 控制台等可信渠道取得，并核对指纹：

~~~bash
# 在 VPS 管理员控制台运行；这是主机公钥，不是用户部署私钥。
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
sudo cat /etc/ssh/ssh_host_ed25519_key.pub
~~~

`VPS_KNOWN_HOSTS` 内容采用如下完整行，主机字段必须与 `VPS_HOST` 相同，密钥内容替换为刚核实的公钥：

~~~text
vps.example.com ssh-ed25519 AAAA...实际主机公钥...
~~~

在应用仓库 **Settings → Environments** 创建 `production`。设置允许发布的分支和需要的审核策略；再配置下表。若使用环境级 Secrets，名称必须正好为 `production`，与 workflow 对应。

| 类型 | 名称 | 内容 |
|---|---|---|
| Secret | `VPS_HOST` | VPS DNS 名或 IPv4，不含 `https://` 和端口 |
| Secret | `VPS_USER` | 示例 `deploy`，有部署目录写权限和非交互 Docker 权限 |
| Secret | `VPS_SSH_KEY` | 完整多行私钥，包含 BEGIN/END 行 |
| Secret | `VPS_KNOWN_HOSTS` | 经可信渠道核实的完整 known_hosts 行 |
| Variable | `DEPLOY_DIR` | 可选，默认 `/opt/tts-workbench`；必须与 VPS 目录相同 |

工作流已声明 `contents: read`、`packages: write`，使用 GitHub 自动提供的 `GITHUB_TOKEN` 推送镜像，不要另建同名 Secret。若组织策略限制 Actions 或包写入，需允许该仓库使用这些权限。实际数据库密码、Session秘密和 Azure Key 留在 VPS 的 `.env.production`。

### 5.3 让 VPS 能拉取私有 GHCR 镜像

镜像位置由仓库路径生成：`ghcr.io/<小写owner>/<小写仓库名>`。首次推送的包通常是私有包。**Actions 的 registry 登录不会传递给 VPS**；VPS 需要自己的拉取权限。

由有该包读取权限的 GitHub 身份创建 PAT classic，权限至少 `read:packages`；组织要求 SSO 时授权对应组织。公开包可匿名拉取。[GHCR 权限与认证说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

以 **与 VPS_USER 相同的用户** 登录 VPS 后执行：

~~~bash
(
  set +x
  set -e
  umask 077
  trap 'unset ghcr_token' EXIT
  read -r -p 'GitHub 用户名：' ghcr_user
  read -r -s -p 'GHCR 只读 PAT：' ghcr_token
  printf '\n'
  printf '%s' "$ghcr_token" | docker login ghcr.io \
    --username "$ghcr_user" --password-stdin
  unset ghcr_token
)
~~~

不要只在 root 用户下 `sudo docker login`，再让 deploy 用户执行拉取；两者使用不同凭据配置。首次镜像还不存在时，可以先完成 registry 登录，再由第一次 workflow 创建包。若镜像已由其他方式创建，检查包是否正确关联本仓库并授予 Actions 访问权。

### 5.4 执行第一次发布

确认 VPS 已完成第 2、3 节，`.env.production` 存在且部署用户可读；SSH 和 Docker 均可非交互使用。

在 GitHub **Actions → Validate, build and deploy VPS → Run workflow** 选择目标分支并运行。当前流程依次执行：

1. 校验 OpenAPI、版本包、Compose 和 workflow 结构。
2. 启动隔离 PostgreSQL，执行后端真实数据库测试；检查前端契约并构建。当前 CI **不运行** 全套 Playwright 浏览器回归。
3. 在 runner 构建镜像，使用 Git SHA 标签推送 GHCR，并取得镜像 digest。
4. 通过严格主机身份检查的 SSH/SCP 上传该提交的 `compose.yaml`。
5. 在 VPS 执行 `deploy.sh`：获取发布锁、拉取镜像、启动数据库、备份、迁移、启动 app 并等待最多90秒健康检查。
6. 成功后让 `current` 指向该 release；app 健康失败时尝试恢复此前成功 release 的应用。

VPS 不需要 Node.js、npm 或应用源码。**app 镜像在 GitHub runner 构建，VPS 拉取并启动镜像，因此 VPS 不会出现 app 的本地构建过程，但成功后必须有运行中的 app 容器。** runner 的测试数据库临时映射5432是 CI 服务配置，不是 VPS 生产 Compose 新增了数据库公网端口。

`Remote Compose deployment` 日志应依次包含 `Backing up database`、`Running database migrations`、`Starting app and waiting for readiness`，最后出现 `Deployed ghcr.io/...@sha256:...`。最后一行只有在 app 就绪且 `current` 切换后才会输出；不能只凭工作流绿色判断应用已经启动。

发布成功后，在 VPS 检查：

~~~bash
docker ps -a --filter label=com.docker.compose.project=tts-workbench \
  --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
readlink -f /opt/tts-workbench/current
cat /opt/tts-workbench/current/release.env
curl --fail --silent --show-error http://127.0.0.1:8080/health/ready
~~~

`release.env` 只含镜像引用和配置路径，可以读取；不要改成输出生产 env 文件。完成第 6、7 节后才算用户可登录使用。后续发布新提交时再次手动 Run workflow；当前配置不会因普通 push 自动发布。

### 5.5 工作流成功，但只有 db 容器

旧版部署脚本存在标准输入被提前读走的问题：工作流通过 `ssh ... bash -s < deploy/scripts/deploy.sh` 传入脚本，而 `docker compose exec -T` 只关闭 TTY，仍默认连接标准输入。备份进程可能读走后续脚本文本，使远程 Bash 在备份后直接到达输入末尾，以退出码0结束；迁移、启动 app 和切换 `current` 均未执行。一次性迁移的 `compose run` 也有同类风险。[Docker exec 说明](https://docs.docker.com/reference/cli/docker/compose/exec/)、[Docker run 说明](https://docs.docker.com/reference/cli/docker/compose/run/)

修复后的 `deploy.sh` 将所有 Compose 调用的输入重定向到 `/dev/null`，并为备份和迁移显式设置 `-T --interactive=false`。CI 会模拟命令读取输入，检查通过标准输入和脚本文件执行时均完成迁移、app 启动和 current 切换；拉取、备份、迁移、就绪失败必须返回非零状态。

先将修复提交推送到准备发布的分支，再用 **Run workflow** 发起该分支的新运行。直接重跑旧运行仍使用旧提交，不能取得脚本修复。更新后按5.4节检查最终 `Deployed ...`、app容器和就绪接口。[GitHub 重跑说明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)

如果需要立即恢复已拉取的版本，可在 VPS 上以原部署用户执行以下代码块。把 `revision` 替换成该次 Actions 的完整40位提交SHA，部署目录不同则修改 `root`。命令直接使用该 release 的配置，不依赖尚未创建的 `current`。它会加锁、新建带时间戳的数据库备份、执行迁移并启动app；任何一步失败都停止，只有就绪后才切换 `current`。

~~~bash
bash <<'BASH'
set -euo pipefail
umask 077
root=/opt/tts-workbench
revision='替换为该次Actions的完整40位Git提交SHA'
[[ "$root" =~ ^/[A-Za-z0-9/_-]+$ && "$root" != / && "$revision" =~ ^[a-f0-9]{40}$ ]]
release="$root/releases/$revision"
test -f "$root/.env.production"
test -f "$release/compose.yaml"
test -f "$release/release.env"
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Another deployment is running'; exit 1; }
compose() {
  docker compose --project-name tts-workbench \
    --env-file "$root/.env.production" --env-file "$release/release.env" \
    -f "$release/compose.yaml" "$@" < /dev/null
}
compose config --quiet
compose up -d --wait db
mkdir -p "$root/backups"
backup=$(mktemp "$root/backups/recovery-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX.dump")
compose exec -T --interactive=false db sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup"
compose run --rm -T --interactive=false --no-deps app node apps/api/dist/operations.js migrate
compose up -d --wait --wait-timeout 90 app
ln -sfn "$release" "$root/current"
compose ps -a
printf 'Recovered %s; backup: %s\n' "$revision" "$backup"
BASH
~~~

如果 app 已存在但退出或不健康，先检查 `docker ps -a` 和该容器的日志；这与备份后脚本提前结束是不同故障，不能仅凭“只看到 db”判断。上面的恢复命令失败时不会自动回退应用；保留其错误输出，再按第8节处理。

## 6. 首次发布后：核对代理信任

以下两条路径通用，全部在 VPS 执行。先准备指向当前成功 release 的命令函数；以后新开终端进行运维，也先执行此段：

~~~bash
root=/opt/tts-workbench
release=$(readlink -f "$root/current")
test -f "$release/compose.yaml"
test -f "$release/release.env"
compose() {
  docker compose --project-name tts-workbench \
    --env-file "$root/.env.production" --env-file "$release/release.env" \
    -f "$release/compose.yaml" "$@"
}
compose ps
~~~

找出 app 所在 Docker 网络的网关：

~~~bash
app_id=$(compose ps -q app)
docker inspect --format \
  '{{range .NetworkSettings.Networks}}{{println .NetworkID .Gateway}}{{end}}' "$app_id"
~~~

当前单网络拓扑通常看到一条网关，例如 `172.18.0.1`。它是宿主 Nginx 经 Docker 转发后 app 看到的代理来源候选地址；在目标 VPS 的网络实现上核实，并用下面的登录验收确认。将 `.env.production` 的 `TRUST_PROXY` 改为实际 IPv4 网关的 `/32`，例如 `TRUST_PROXY=172.18.0.1/32`。不要直接照抄示例地址，也不要设置无条件信任所有代理。

生产会话使用 Secure Cookie，需要 Nginx 的 `X-Forwarded-Proto=https` 和正确的 `TRUST_PROXY` 配合。更改配置后用第 8.1 节方法重建 app；普通 `restart` 不会载入新的容器环境。

验证：

~~~bash
curl --fail --silent --show-error http://127.0.0.1:8080/health/ready
curl --fail --silent --show-error https://tts.example.com/health/ready
compose ps
app_id=$(compose ps -q app)
docker port "$app_id"
~~~

预期只有 `3000/tcp -> 127.0.0.1:8080`；db没有宿主端口。直接访问 `http://VPS公网IP:8080` 不应成功。

## 7. 创建账号与验收

### 7.1 创建第一个账号

项目**没有默认账号、默认密码或超级管理员角色**。保持公共注册关闭，在 VPS 通过 CLI 创建个人账户：

~~~bash
(
  set +x
  set -e
  root=/opt/tts-workbench
  release=$(readlink -f "$root/current")
  compose() {
    docker compose --project-name tts-workbench \
      --env-file "$root/.env.production" --env-file "$release/release.env" \
      -f "$release/compose.yaml" "$@"
  }
  trap 'unset ACCOUNT_PASSWORD' EXIT
  read -r -s -p '初始密码（8–128字符）：' ACCOUNT_PASSWORD
  printf '\n'
  export ACCOUNT_PASSWORD
  compose exec -T -e ACCOUNT_PASSWORD app \
    node apps/api/dist/operations.js create admin "我的账户"
  unset ACCOUNT_PASSWORD
)
~~~

`admin` 是可替换的登录名，没有额外权限。登录名3–120字符，允许字母、数字和 `@._+-`；显示名称1–40字符。命令成功返回 `id/login`。密码只传入此次 CLI 进程，不写入长期 env，也不需要为创建账号重建容器。

### 7.2 用户可用性验收

1. 浏览器打开 `https://tts.example.com/#/login`，用刚创建的账号登录。
2. 在“我的文章”新建文章、保存标题正文，刷新和重新登录后仍能恢复；再验证搜索、编辑和删除。
3. 有真实 Azure 配置时，用短日文 `こんにちは。` 生成一次。该步骤会调用供应商并可能计费，须由维护者主动执行。主流程应先保存文章，然后 `POST /v1/articles/{id}/audio` 返回 JSON，再 `GET /v1/articles/{id}/audio?audioId=...` 取得 MP3。
4. 播放、下载、刷新重新打开；确认仍是最后一次成功音频。修改正文或个人读法后旧音频提示重新生成。
5. 删除测试文章，确认文章和对应音频均不可再读取；个人读法仍保留。

`/health/ready` 返回200只证明当前内部依赖就绪，不会向 Azure 发起付费合成，也不能证明密钥、音色或真实日文发音效果正确。没有 TTS 配置时该健康检查也可以成功。

## 8. 更新、修改配置与回滚

### 8.1 只修改运行配置

编辑 `/opt/tts-workbench/.env.production` 后，用当前成功 release 重建 app；示例适用于 Azure Key、注册开关、文章上限、代理信任等。数据库密码不能仅靠改文件完成轮换。

~~~bash
(
  set -euo pipefail
  root=/opt/tts-workbench
  exec 9>"$root/deploy.lock"
  flock -n 9
  release=$(readlink -f "$root/current")
  docker compose --project-name tts-workbench \
    --env-file "$root/.env.production" --env-file "$release/release.env" \
    -f "$release/compose.yaml" up -d --no-deps --force-recreate \
    --wait --wait-timeout 180 app
)
~~~

修改端口或域名时同步 Nginx 和 `PUBLIC_ORIGIN`，再运行 `nginx -t`、reload 和浏览器登录检查。改动前单独保管旧配置，`current` 不保存生产 env 的历史。

### 8.2 发布失败的实际行为

| 失败位置 | 当前行为与处理 |
|---|---|
| CI测试或镜像构建失败 | 不进入远程发布，先处理失败步骤。 |
| SSH/镜像拉取失败 | 不切换 current；检查主机身份、权限和 VPS 的 GHCR 登录。 |
| 备份失败 | 脚本中止，不继续迁移；检查磁盘空间和数据库状态。 |
| 迁移失败 | 脚本中止，current不推进；检查迁移与兼容性，不反复盲目重试。 |
| 新 app 健康失败 | 已有不同成功 release 时尝试恢复旧应用；首次发布没有旧版本可恢复。 |
| 应用健康但浏览器不能登录 | 检查域名、Secure Cookie、TRUST_PROXY 和转发头，不能仅以容器 healthy 作为验收。 |

应用回滚不回滚数据库。迁移须与旧应用兼容；新的文章/音频表使用新增迁移。两条路径均存在短暂停机可能，当前实现没有零停机保证。

当前 Actions 以 Git SHA 命名 release；**同一 SHA 重跑会重写该 release.env 和 before-SHA.dump**。回滚依赖保留的不同成功 release；发布前保留重要备份，不能把“同SHA再跑一次”当成生成了一份独立历史版本。共享 `.env.production` 也不会随 current 回滚。

### 8.3 手动恢复旧应用

选择已有、确认可兼容当前数据库的 release，替换 `target_revision`。这是切换应用版本，不是恢复数据库：

~~~bash
(
  set -euo pipefail
  root=/opt/tts-workbench
  target_revision='替换为旧成功版本完整40位SHA'
  [[ "$target_revision" =~ ^[a-f0-9]{40}$ ]]
  target="$root/releases/$target_revision"
  test -f "$target/compose.yaml"
  test -f "$target/release.env"
  exec 9>"$root/deploy.lock"
  flock -n 9
  docker compose --project-name tts-workbench \
    --env-file "$root/.env.production" --env-file "$target/release.env" \
    -f "$target/compose.yaml" up -d --no-deps --wait --wait-timeout 90 app
  ln -sfn "$target" "$root/current"
)
~~~

路径 A 的目标镜像必须仍在 VPS 上；路径 B 的 digest 必须仍可从 GHCR 获取。配置也改变过时，先人工恢复与旧版本匹配的配置。不要用 `down -v`、删除卷或数据库降级来代替应用回滚。

两条路径之间可以切换，但要保留相同部署目录、Compose项目名、数据库凭据和卷，并使用新的发布提交，避免覆盖 current 正指向的同SHA release记录。

## 9. 备份、恢复与排查

### 9.1 备份数据

账户、个人读法、最新文章内容和唯一音频全部在 PostgreSQL 卷中。默认100篇/账户、单音频最多8MiB，仅当前音频理论上可占约800MiB/账户；还需为数据库、WAL、镜像和备份留空间。

使用第 6 节的 `compose` 函数，手动生成备份：

~~~bash
(
  set -euo pipefail
  umask 077
  root=/opt/tts-workbench
  release=$(readlink -f "$root/current")
  mkdir -p "$root/backups"
  backup="$root/backups/manual-$(date -u +%Y%m%dT%H%M%SZ).dump"
  docker compose --project-name tts-workbench \
    --env-file "$root/.env.production" --env-file "$release/release.env" \
    -f "$release/compose.yaml" exec -T db sh -c \
    'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup"
  test -s "$backup"
  printf '备份已写入：%s\n' "$backup"
)
~~~

仓库另有 [backup.sh](../deploy/scripts/backup.sh)，可放入 VPS 的现有定时备份机制。它仅清理 `daily-*.dump` 中超过7天的文件，部署前及手动备份不自动清理；**Actions 只上传 compose.yaml，不会自动安装 backup.sh 或定时任务**。复制脚本到服务器后需自行配置运行频率、日志和异地备份。

数据库备份不包含 `.env.production`、SSH凭据或镜像。单独保护这些配置，并将数据库备份复制到其他主机或备份存储。文章“只保留最新”是业务记录规则，历史字节仍可能存在于旧备份中。

### 9.2 先恢复到独立数据库

选择真实备份文件，先执行第 6 节定义 `compose`，再在 **同一 Bash 会话**执行：

~~~bash
(
  set -euo pipefail
  backup=/opt/tts-workbench/backups/替换为实际文件名.dump
  test -s "$backup"
  restore_db="workbench_restore_$(date -u +%Y%m%d%H%M%S)"
  compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" "$1"' sh "$restore_db"
  compose exec -T db sh -c \
    'pg_restore --exit-on-error --no-owner -U "$POSTGRES_USER" -d "$1"' \
    sh "$restore_db" < "$backup"
  compose exec -T db sh -c \
    'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1"' sh "$restore_db" <<'SQL'
SELECT count(*) AS accounts FROM ac_accounts;
SELECT count(*) AS rules FROM wb_vocabulary;
SELECT count(*) AS articles FROM wb_articles;
SELECT count(*) AS audio_files FROM wb_article_audio;
SELECT count(*) AS invalid_audio_lengths FROM wb_article_audio
WHERE octet_length(data) IS DISTINCT FROM (metadata->>'byteLength')::integer;
SQL
  printf '已恢复到独立数据库：%s\n' "$restore_db"
)
~~~

这些命令不覆盖当前库。除数量外，还需核对预期文章和音频、应用版本及迁移状态；只有通过后才安排维护窗口切换。

若在同一个数据库容器中切换到恢复库，停止 app 后统一调整 `DATABASE_URL` 的库名和 `POSTGRES_DB`，保留实际用户/密码；重建 db 使其环境与备份脚本一致，再运行所选应用迁移并启动 app。仅改 app 的连接串会导致备份脚本仍备份旧库。已有卷上的 `POSTGRES_DB` 变化不会自动创建数据库，以上恢复步骤已显式创建目标库。保留原库直到确认恢复成功。

### 9.3 常用排查命令

先执行第 6 节的当前 release / compose 函数：

~~~bash
compose ps
compose logs --tail=100 app
compose logs --tail=100 db
curl --fail --silent --show-error http://127.0.0.1:8080/health/ready
curl --fail --silent --show-error https://tts.example.com/health/ready
df -h
docker system df
~~~

| 问题 | 优先检查 |
|---|---|
| GitHub 没有 Run workflow | workflow是否已进入默认分支、Actions是否启用、是否有运行权限。 |
| Actions 等待不动 | production环境审批/分支限制，或已有发布在同一并发组运行。 |
| Actions绿色但只有db | 核对远程步骤末尾是否有`Deployed ...`，查看`docker ps -a`；旧脚本标准输入问题及恢复方法见5.5节。 |
| SSH Permission denied | 用户公钥、Secret私钥、文件权限、是否使用22端口及正确用户。 |
| Host key verification failed | 从可信控制台重新核对主机公钥；不要关闭 StrictHostKeyChecking。 |
| GHCR denied / unauthorized | VPS_USER本人是否docker login、PAT是否有read:packages和包访问权、组织SSO是否授权。 |
| APP_IMAGE / env文件缺失 | 是否使用current对应release.env，以及两份--env-file。 |
| 数据库密码错误 | 已有卷实际密码与配置是否一致；改POSTGRES_PASSWORD不会自动改旧数据库密码。 |
| 找不到旧文章 | 是否误换了Compose项目、卷或DATABASE_URL；不要因此新建空库覆盖原数据。 |
| HTTPS 502 | app是否启动、Nginx上游端口是否一致、宿主curl是否成功。 |
| 登录成功后立即回登录页 | Secure Cookie是否设置、TRUST_PROXY是否为实际网关、转发Proto是否为https。 |
| 403 FORBIDDEN / CSRF_INVALID | PUBLIC_ORIGIN、浏览器地址、Cookie与代理配置；登录状态变化后刷新页面。 |
| 空音色 / TTS_UNAVAILABLE | Azure两项配置是否齐全且已重建app，是否使用Japan East资源。 |
| 文章能保存但音频失败 | 查询请求ID和错误类别，检查供应商、网络、音色与8MiB上限；旧成功音频仍保留。 |

排查时不要打印完整生产 env、认证头或 `docker inspect` 的全部环境字段。本指南只使用定向的网络/镜像检查。

## 10. 仓库文件与验证范围

| 文件 | 用途 |
|---|---|
| [Dockerfile](../Dockerfile) | 一次构建前端/API，运行单一app镜像 |
| [compose.yaml](../compose.yaml) | app + db，单宿主loopback入口与持久卷 |
| [runtime.env.example](../deploy/runtime.env.example) | 生产配置字段参考 |
| [deploy.yml](../.github/workflows/deploy.yml) | CI验证、GHCR构建发布、SSH远程执行 |
| [deploy.sh](../deploy/scripts/deploy.sh) | release锁、拉取、备份、迁移、健康检查和应用回退 |
| [backup.sh](../deploy/scripts/backup.sh) | 日常数据库备份与daily文件保留 |
| [operations.md](operations.md) | 本地运行、供应商配置、历史验证与详细运维 |
| [ARTICLE_MANAGEMENT.md](ARTICLE_MANAGEMENT.md) | 文章与最后成功音频的数据规则 |

本指南交付范围为部署文档和命令核对。目标 VPS 的 Docker安装、DNS、TLS、SSH、GHCR访问、外部连通性和真实日文语音仍需由部署者按本文执行并验证；没有将本地测试结果表述成已完成远程部署。

本次文档校验：23个Bash代码块语法通过；本文及关联入口的38个本地文件链接存在；使用占位配置解析两份env文件的Compose命令通过，核对生产模式、容器数据库URL及唯一loopback端口；现有部署结构检查和版本包完整性检查通过。另在隔离的真实PostgreSQL容器中复现旧命令“备份后提前结束且退出码0”，验证关闭标准输入后继续执行；部署脚本的12项模拟回归覆盖标准输入/文件执行以及成功、拉取失败、备份失败、迁移失败、首次就绪失败和恢复旧应用。未连接真实VPS，未执行文档中的账号创建、镜像构建发布或数据库恢复命令。
