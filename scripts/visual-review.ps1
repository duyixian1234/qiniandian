<#
visual-review.ps1 — 视觉评审（playwright-cli 轨道）

用法：
    # 1) 先起本地服务（另开一个终端）
    pwsh -File D:\lab\qiniandian\run.ps1 -SkipInstall     # 会自动起停，不适合本条
    # 或长期起一个：
    pwsh -Command "node D:\lab\qiniandian\node_modules\vite\bin\vite.js preview --port 5390 --strictPort --host 127.0.0.1"

    # 2) 用 playwright-cli 打开页面做人工评审
    pwsh -File D:\lab\qiniandian\scripts\visual-review.ps1

为什么这条**不并入** run.ps1 的自动门禁：
  playwright-cli（agent CLI）是**有状态、交互式**的 —— 它维持一个浏览器会话（daemon），
  配合 `--headed` 时会**弹出真实窗口**。把它塞进以"退出码判定"为核心的自动化门禁里，
  会破坏确定性（两次连跑不再字节一致），也会在无人值守时留下悬挂窗口。
  因此本项目采用**双轨**（SPEC Q23）：
    - 自动断言轨：scripts\capture.mjs —— headless、无状态、退出码判定（并入 run.ps1）
    - 视觉评审轨：本脚本 —— 人工查看、可交互、不参与判定

已实测事实（见 ../.probe/FACTS.md）：
  - agent CLI 默认即 headless，`--headed` 才切有头
  - `--browser=msedge` 对 `cli open` 有效（内置 `screenshot` 子命令则须用 `--channel msedge`）
  - 它**屏蔽 file: 协议**，因此必须先起 HTTP 服务
  - `npx playwright` 在 pnpm 项目里可能报 EBADDEVENGINES，故这里直接调本地 cli.js
#>
param(
    [string]$Url = 'http://127.0.0.1:5390/?interactive=1',
    [switch]$Headed,
    [switch]$CloseAll
)

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot | Split-Path -Parent
$Cli = Join-Path $Root 'node_modules\playwright\cli.js'

if (-not (Test-Path $Cli)) {
    Write-Host "找不到 playwright cli.js：$Cli" -ForegroundColor Red
    Write-Host "请先运行：pnpm install" -ForegroundColor Yellow
    exit 1
}

if ($CloseAll) {
    Write-Host '关闭全部 playwright-cli 会话…'
    & node $Cli cli close-all 2>&1 | ForEach-Object { Write-Host "  $_" }
    & node $Cli cli kill-all 2>&1 | ForEach-Object { Write-Host "  $_" }
    exit 0
}

# 先确认服务可达：agent CLI 屏蔽 file:，且服务未起时报错信息不直观
$code = [string]((& curl.exe -sS -m 10 -o NUL -w '%{http_code}' ($Url -split '\?')[0] 2>&1) -join '')
if ($code -ne '200') {
    Write-Host "本地服务不可达（HTTP $code）：$Url" -ForegroundColor Red
    Write-Host '请先起服务，例如：' -ForegroundColor Yellow
    Write-Host "  node `"$Root\node_modules\vite\bin\vite.js`" preview --port 5390 --strictPort --host 127.0.0.1" -ForegroundColor Yellow
    exit 1
}

Write-Host "playwright-cli 视觉评审轨道" -ForegroundColor Cyan
Write-Host "  目标：$Url"
Write-Host "  模式：$(if ($Headed) { '有头（可见窗口）' } else { '默认（headless）' })"
Write-Host ''

# open 会在独立会话中启动浏览器；后续命令作用于同一会话
$openArgs = @('cli', 'open', $Url, '--browser=msedge')
if ($Headed) { $openArgs += '--headed' }
Write-Host ('> node cli.js ' + ($openArgs -join ' '))
& node $Cli @openArgs 2>&1 | ForEach-Object { Write-Host "  $_" }

Write-Host ''
Write-Host '会话已打开。常用命令（均可直接复制）：' -ForegroundColor Cyan
Write-Host "  resize 1600 900                      # 设定视口"
Write-Host "  --raw eval `"JSON.stringify(window.__SCENE__)`"   # 读取场景断言值"
Write-Host "  screenshot --filename=`"$Root\shots\review.png`"  # 截图到固定路径"
Write-Host '  console                              # 查看页面报错'
Write-Host '  close                                # 关闭会话'
Write-Host ''
Write-Host '若只想要干净的成片（不含左上角 JSON 面板），用 ?hud=0，例如：' -ForegroundColor Yellow
Write-Host "  <base>?cam=hero&interactive=1&hud=0" -ForegroundColor Yellow
Write-Host ''
Write-Host '结束评审后建议执行：pwsh -File scripts\visual-review.ps1 -CloseAll' -ForegroundColor Yellow
