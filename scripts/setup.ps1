# ============================================================
#  relic-setup.ps1 - Windows 一键安装（纯 PowerShell）
#  流程：环境检查 -> winget 补装 Node/Git -> clone 引擎 -> npm install -> 向导
#  由同目录的 relic-setup.cmd 双击调用；失败时暂停，窗口不闪退。
# ============================================================
$ErrorActionPreference = 'Stop'

function Exit-WithPause([int]$code) {
    Write-Host ''
    Read-Host '按 Enter 退出'
    exit $code
}

function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Get-NodeVersion {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $null }
    try { return ((& node --version) -replace '^v', '').Trim() } catch { return $null }
}

function Get-GitVersion {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $null }
    try { return ((& git --version) -replace '^git version ', '').Trim() } catch { return $null }
}

Write-Host ''
Write-Host '  ================================================' -ForegroundColor Cyan
Write-Host '   relic SETUP - AI Agent Governance System' -ForegroundColor Cyan
Write-Host '  ================================================' -ForegroundColor Cyan
Write-Host ''

# ---- 1/4 Node.js ----
Write-Host '  [1/4] Checking Node.js...'
$nodeVersion = Get-NodeVersion
if (-not $nodeVersion) {
    Write-Host '  [1/4] Node.js missing. Installing via winget...' -ForegroundColor Yellow
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
        Update-SessionPath
    } else {
        Write-Host '  winget 不可用，请手动安装 Node.js LTS。' -ForegroundColor Red
        Start-Process 'https://nodejs.org/en/download'
        Read-Host '  安装完成后按 Enter 继续'
        Update-SessionPath
    }
}
$nodeVersion = Get-NodeVersion
if (-not $nodeVersion) {
    Write-Host '  [ERROR] Node.js 仍不可用。' -ForegroundColor Red
    Exit-WithPause 1
}
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 20) {
    Write-Host "  [ERROR] Node.js 版本过低（需要 20 以上，当前 $nodeVersion）。" -ForegroundColor Red
    Exit-WithPause 1
}
Write-Host "  [1/4] Node.js OK ($nodeVersion)" -ForegroundColor Green

# ---- 2/4 Git ----
Write-Host '  [2/4] Checking Git...'
$gitVersion = Get-GitVersion
if (-not $gitVersion) {
    Write-Host '  [2/4] Git missing. Installing via winget...' -ForegroundColor Yellow
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install Git.Git --accept-package-agreements --accept-source-agreements --silent
        Update-SessionPath
    } else {
        Write-Host '  winget 不可用，请手动安装 Git。' -ForegroundColor Red
        Start-Process 'https://git-scm.com/download/win'
        Read-Host '  安装完成后按 Enter 继续'
        Update-SessionPath
    }
}
$gitVersion = Get-GitVersion
if (-not $gitVersion) {
    Write-Host '  [ERROR] Git 仍不可用。' -ForegroundColor Red
    Exit-WithPause 1
}
Write-Host "  [2/4] Git OK ($gitVersion)" -ForegroundColor Green

# ---- 3/4 下载引擎 ----
Write-Host '  [3/4] Downloading relic...'
$root = Join-Path $env:USERPROFILE '.relic'
$dest = Join-Path $root 'engine'
if (-not (Test-Path $root)) { New-Item -ItemType Directory -Path $root -Force | Out-Null }
if (Test-Path (Join-Path $dest 'package.json')) {
    Write-Host '  [3/4] 已存在，跳过下载' -ForegroundColor Green
} else {
    & git clone https://github.com/STHgs/relic.git $dest
    if ($LASTEXITCODE -ne 0) {
        Write-Host '  [ERROR] GitHub clone 失败。请检查网络或代理后重试。' -ForegroundColor Red
        Exit-WithPause 1
    }
}
Write-Host '  [3/4] relic ready' -ForegroundColor Green

# ---- 3.5/4 旧布局自动迁移（~/.config/relic-sync 等 → ~/.relic；旧引擎归档）----
Write-Host '  [3.5/4] Migrating legacy layout...'
& node (Join-Path $dest 'scripts\migrate.mjs') --apply
if ($LASTEXITCODE -ne 0) {
    Write-Host '  [ERROR] 目录迁移失败（备份保留在 %USERPROFILE%\.relic\state）。' -ForegroundColor Red
    Exit-WithPause 1
}

# ---- 4/4 依赖 + 向导 ----
Write-Host ''
Write-Host '  [4/4] Launching wizard...' -ForegroundColor Cyan
Set-Location $dest
if (-not (Test-Path (Join-Path $dest 'node_modules'))) {
    & npm install --silent
    if ($LASTEXITCODE -ne 0) {
        Write-Host '  [ERROR] npm install 失败。' -ForegroundColor Red
        Exit-WithPause 1
    }
}
& node scripts/wizard.mjs
if ($LASTEXITCODE -ne 0) {
    Write-Host '  [ERROR] 向导异常退出。' -ForegroundColor Red
    Exit-WithPause 1
}
Write-Host '  向导已结束。以后启动用开始菜单的「relic 控制台」。' -ForegroundColor Green
