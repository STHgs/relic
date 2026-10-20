@echo off
rem ============================================================
rem  relic-setup.cmd - one-click setup (launcher only)
rem  Downloads: env check + clone + wizard. PS logic in temp .ps1
rem ============================================================

setlocal
title relic SETUP
color 0b

rem -- write the PowerShell payload to a temp file, then run it --
set "PSTMP=%TEMP%\relic-setup.ps1"

> "%PSTMP%" (
echo $ErrorActionPreference = 'Stop'
echo Write-Host ''
echo Write-Host '  ================================================' -ForegroundColor Cyan
echo Write-Host '   relic SETUP - AI Agent Governance System' -ForegroundColor Cyan
echo Write-Host '  ================================================' -ForegroundColor Cyan
echo Write-Host ''
echo.
echo function Refresh-Path ^{
echo     $env:Path = [System.Environment]::GetEnvironmentVariable^('Path','Machine'^) + ';' + [System.Environment]::GetEnvironmentVariable^('Path','User'^)
echo ^}
echo.
echo Write-Host '  [1/4] Checking Node.js...'
echo $node = Get-Command node -ErrorAction SilentlyContinue
echo if ^(-not $node^) ^{
echo     Write-Host '  [1/4] Node.js missing. Installing via winget...' -ForegroundColor Yellow
echo     $wg = Get-Command winget -ErrorAction SilentlyContinue
echo     if ^($wg^) ^{
echo         winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
echo     ^} else ^{
echo         Write-Host '  winget unavailable. Please install Node.js manually.' -ForegroundColor Red
echo         Start-Process 'https://nodejs.org/en/download'
echo         Read-Host '  Press Enter after installing Node.js'
echo     ^}
echo     Refresh-Path
echo ^}
echo $node = Get-Command node -ErrorAction SilentlyContinue
echo if ^(-not $node^) ^{ Write-Host '  [ERROR] Node.js still unavailable.' -ForegroundColor Red; exit 1 ^}
echo Write-Host '  [1/4] Node.js OK' -ForegroundColor Green
echo.
echo Write-Host '  [2/4] Checking Git...'
echo $git = Get-Command git -ErrorAction SilentlyContinue
echo if ^(-not $git^) ^{
echo     Write-Host '  [2/4] Git missing. Installing via winget...' -ForegroundColor Yellow
echo     $wg = Get-Command winget -ErrorAction SilentlyContinue
echo     if ^($wg^) ^{
echo         winget install Git.Git --accept-package-agreements --accept-source-agreements --silent
echo     ^} else ^{
echo         Write-Host '  winget unavailable. Please install Git manually.' -ForegroundColor Red
echo         Start-Process 'https://git-scm.com/download/win'
echo         Read-Host '  Press Enter after installing Git'
echo     ^}
echo     Refresh-Path
echo ^}
echo $git = Get-Command git -ErrorAction SilentlyContinue
echo if ^(-not $git^) ^{ Write-Host '  [ERROR] Git still unavailable.' -ForegroundColor Red; exit 1 ^}
echo Write-Host '  [2/4] Git OK' -ForegroundColor Green
echo.
echo Write-Host '  [3/4] Downloading relic-source...'
echo $dest = Join-Path $env:USERPROFILE 'relic-source'
echo if ^(Test-Path ^(Join-Path $dest 'package.json'^)^) ^{
echo     Write-Host '  [3/4] Already exists, skip download' -ForegroundColor Green
echo ^} else ^{
echo     git clone https://gitee.com/sthgs/relic-source.git $dest 2^>$null
echo     if ^($LASTEXITCODE -ne 0^) ^{
echo         Write-Host '  Gitee failed, trying GitHub...' -ForegroundColor Yellow
echo         git clone https://github.com/STHgs/relic-source.git $dest
echo     ^}
echo     if ^($LASTEXITCODE -ne 0^) ^{ Write-Host '  [ERROR] Download failed. Check network.' -ForegroundColor Red; exit 1 ^}
echo ^}
echo Write-Host '  [3/4] relic-source ready' -ForegroundColor Green
echo.
echo Write-Host '  [4/4] Launching wizard...' -ForegroundColor Cyan
echo Set-Location $dest
echo npm install --silent 2^>$null
echo node scripts/wizard.mjs
)

rem -- run the payload with the right PowerShell --
where pwsh >nul 2>&1
if %errorlevel% equ 0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%PSTMP%"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%PSTMP%"
)

set "RC=%errorlevel%"
del "%PSTMP%" >nul 2>&1

if %RC% neq 0 (
    echo.
    echo  [ERROR] Setup failed ^(exit %RC%^). Check logs above.
    pause
)

endlocal
