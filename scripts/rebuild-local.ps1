param([switch]$NoCache, [Parameter(ValueFromRemainingArguments = $true)][string[]]$ExtraArgs)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$savedEnvironment = @{}
$overrideFile = $null
$stage = '检查参数'
function Set-LocalEnvironment([string]$Name, [string]$Value) {
    if (-not $savedEnvironment.ContainsKey($Name)) {
        $savedEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
    }
    [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}
function Invoke-Docker([string[]]$Arguments) {
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Docker 命令失败，退出码 $LASTEXITCODE。" }
}
Push-Location $root
try {
    foreach ($argument in $ExtraArgs) {
        if ($argument -eq '--no-cache') { $NoCache = $true }
        else { throw "未知参数：$argument。支持 --no-cache。" }
    }
    if (-not (Test-Path -LiteralPath '.env' -PathType Leaf)) {
        throw '缺少 .env；请复制 .env.example 并填写数据库凭据及 SESSION_SECRET。'
    }
    $stage = '检查 Docker Desktop 和 Compose'
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw '未找到 Docker CLI，请安装并启动 Docker Desktop。' }
    & docker info --format '{{.ServerVersion}}' *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Docker daemon 不可用，请启动 Docker Desktop 并等待引擎就绪。' }
    Invoke-Docker @('compose', 'version')

    # Let Compose parse dotenv syntax, quoting and interpolation; never print its secret-bearing JSON.
    $stage = '读取本地配置'
    $probe = "services:`n  app:`n    image: local-config-probe`n    env_file:`n      - .env`n"
    $raw = $probe | & docker compose --project-directory $root --env-file .env -f - config --format json 2>$null
    if ($LASTEXITCODE -ne 0) { throw '.env 解析失败，请检查变量引用和引号格式。' }
    $settings = ($raw -join "`n" | ConvertFrom-Json).services.app.environment
    $databaseUri = $null
    if (-not [Uri]::TryCreate($settings.DATABASE_URL, [UriKind]::Absolute, [ref]$databaseUri) -or $databaseUri.Scheme -notin @('postgres', 'postgresql')) {
        throw '.env 中 DATABASE_URL 必须是有效的 PostgreSQL URL。'
    }
    $credentials = $databaseUri.UserInfo -split ':', 2
    if ($credentials.Count -ne 2) { throw 'DATABASE_URL 必须包含用户名和密码。' }
    $dbUser = [Uri]::UnescapeDataString($credentials[0])
    $dbPassword = [Uri]::UnescapeDataString($credentials[1])
    $dbName = [Uri]::UnescapeDataString($databaseUri.AbsolutePath.TrimStart('/'))
    if (-not $dbUser -or -not $dbPassword -or -not $dbName) { throw 'DATABASE_URL 的用户名、密码和数据库名不能为空。' }
    foreach ($pair in @(@('POSTGRES_USER', $dbUser), @('POSTGRES_PASSWORD', $dbPassword), @('POSTGRES_DB', $dbName))) {
        $configured = $settings.($pair[0])
        if ($configured -and $configured -cne $pair[1]) { throw "$($pair[0]) 与 DATABASE_URL 不一致，请修正配置；不会重置现有数据库。" }
        Set-LocalEnvironment $pair[0] $pair[1]
    }
    $portText = if ($env:APP_HOST_PORT) { $env:APP_HOST_PORT } elseif ($settings.APP_HOST_PORT) { $settings.APP_HOST_PORT } else { '8080' }
    $port = 0
    if (-not [int]::TryParse($portText, [ref]$port) -or $port -lt 1 -or $port -gt 65535) { throw 'APP_HOST_PORT 必须为 1–65535 的端口。' }
    $address = "http://127.0.0.1:$port"
    $project = if ($env:COMPOSE_PROJECT_NAME) { $env:COMPOSE_PROJECT_NAME } elseif ($settings.COMPOSE_PROJECT_NAME) { $settings.COMPOSE_PROJECT_NAME } else { 'tts-workbench' }
    if ($project -cnotmatch '^[a-z0-9][a-z0-9_-]*$') { throw 'COMPOSE_PROJECT_NAME 只能包含小写字母、数字、下划线和连字符。' }
    Set-LocalEnvironment 'APP_IMAGE' "tts-workbench:local"
    Set-LocalEnvironment 'APP_HOST_PORT' "$port"
    Set-LocalEnvironment 'RUNTIME_ENV_FILE' (Join-Path $root '.env')
    Set-LocalEnvironment 'LOCAL_DATABASE_URL' ("postgresql://{0}:{1}@db:5432/{2}" -f [Uri]::EscapeDataString($dbUser), [Uri]::EscapeDataString($dbPassword), [Uri]::EscapeDataString($dbName))
    Set-LocalEnvironment 'LOCAL_PUBLIC_ORIGIN' $address
    # This temporary override contains references only, never credentials.
    $overrideFile = Join-Path ([IO.Path]::GetTempPath()) ("tts-rebuild-{0}.yaml" -f [Guid]::NewGuid())
    [IO.File]::WriteAllText($overrideFile, "services:`n  app:`n    environment:`n      NODE_ENV: development`n      DATABASE_URL: `${LOCAL_DATABASE_URL}`n      PUBLIC_ORIGIN: `${LOCAL_PUBLIC_ORIGIN}`n")
    $compose = @('compose', '--project-directory', $root, '--project-name', $project, '--env-file', '.env', '-f', 'compose.yaml', '-f', $overrideFile)
    $stage = '校验 Compose'
    Invoke-Docker ($compose + @('config', '--quiet'))
    Write-Host "本地项目：$project；端口：$port。保留现有数据库容器和数据卷。"
    $stage = '构建本地镜像'
    $build = @('build', '--tag', $env:APP_IMAGE)
    if ($NoCache) { $build += '--no-cache' }
    Invoke-Docker ($build + '.')
    $stage = '启动数据库（不重建已有容器）'
    Invoke-Docker ($compose + @('up', '-d', '--no-recreate', '--wait', '--wait-timeout', '120', 'db'))
    $stage = '执行数据库迁移'
    Invoke-Docker ($compose + @('run', '--rm', '--no-deps', 'app', 'node', 'apps/api/dist/operations.js', 'migrate'))
    $stage = '重建应用并等待健康状态'
    Invoke-Docker ($compose + @('up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '180', 'app'))
    $stage = '检查宿主入口'
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$address/health/ready" -TimeoutSec 15
    if ($response.StatusCode -ne 200) { throw '健康接口未返回 HTTP 200。' }
    Write-Host "重建完成，访问：$address/" -ForegroundColor Green
} catch {
    [Console]::Error.WriteLine("重建失败（$stage）：$($_.Exception.Message)")
    [Console]::Error.WriteLine('数据卷未删除。请修正上述错误后重新运行 rebuild.cmd。')
    exit 1
} finally {
    if ($overrideFile -and (Test-Path -LiteralPath $overrideFile)) { Remove-Item -LiteralPath $overrideFile }
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
    Pop-Location
}
