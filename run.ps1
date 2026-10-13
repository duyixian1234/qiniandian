<#
run.ps1 — 祈年殿 一键复跑（形制优先 · 渲染写实 · 运行时离线自包含）

用法：
    pwsh -File D:\lab\qiniandian\run.ps1
    pwsh -File D:\lab\qiniandian\run.ps1 -SkipInstall

纪律（沿用 D:\lab 既有约定，见 D:\lab\run-repro.ps1 与 reports\*）：
  1. 每步 stdout/stderr 落盘到 logs\<步骤>.log
  2. 判定只以「日志内容 + 退出码」为准
  3. 每步打印 SENTINEL 行，便于按日志 grep 判定
  4. 收尾清理**仅自己启动**的服务与浏览器进程（按端口/精确标识，绝不模糊匹配命令行）
  5. 退出码 0 = 全通过；1 = 有步骤失败；**不得有静默跳过**

步骤：
  S0 预检（工具链 + HDRI 必须是真 Radiance HDR）
  S1 pnpm install
  S2 tsc --noEmit
  S3 vitest run（形制单元测试）
  S4 vite build（并校验 HDRI 进入 dist）
  S5 启动 preview 并确认 HTTP 200 + HDRI 可达
  S6 截图门禁（四机位，--assert）
  S7 门禁自证（注入故障必须全部失败）
  S8 参数生效守卫
  S9 形制比值（出挑比 vs 参考读值）
  S10 确定性（连跑两次截图 SHA256 一致）
#>
param([switch]$SkipInstall, [int]$Port = 5390)

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$LogDir = Join-Path $Root 'logs'
$ShotRoot = Join-Path $Root 'shots'
$Hdri = Join-Path $Root 'public\hdri\kloofendal_43d_clear_puresky_2k.hdr'
# 参考读值容差（绝对差）。参考值本身由 scripts/measure-eave-ratios.mjs 内以字面量给出，
# 并在 S9b 用注入几何故障证明该量测真的会失败 —— 故这里不再重复一份 $RefRatio（曾为死变量）。
$RatioTol = 0.05

New-Item -ItemType Directory -Force -Path $LogDir, $ShotRoot | Out-Null
$Results = [System.Collections.Generic.List[object]]::new()
$ServerPid = $null

function Say([string]$m) { Write-Host $m }
function Record([string]$n, [bool]$ok, [string]$detail) {
    $Results.Add([pscustomobject]@{ Step = $n; Ok = $ok; Detail = $detail })
    Say ("SENTINEL $n " + $(if ($ok) { 'PASS' } else { 'FAIL' }) + " :: $detail")
}
function Logged([string]$name, [scriptblock]$action) {
    $out = Join-Path $LogDir "$name.log"
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & $action *>&1 | Out-File $out -Encoding utf8
    $sw.Stop()
    $text = Get-Content $out -Raw -ErrorAction SilentlyContinue
    return @{ Text = $text; Ms = $sw.ElapsedMilliseconds; Exit = $LASTEXITCODE }
}
function Stop-MyServer {
    if ($null -ne $script:ServerPid) {
        try { Stop-Process -Id $script:ServerPid -Force -ErrorAction SilentlyContinue } catch {}
        $script:ServerPid = $null
    }
}

# ============================================================ S0 预检
Say '===== S0 预检 ====='
$pre = [System.Collections.Generic.List[string]]::new()
$ok0 = $true
$nodeV = (& node --version 2>&1 | Out-String).Trim()
$pnpmV = (& pnpm --version 2>&1 | Out-String).Trim()
$pre.Add("node=$nodeV pnpm=$pnpmV")
if (-not $nodeV -or -not $pnpmV) { $ok0 = $false; $pre.Add('MISSING node/pnpm') }

foreach ($f in @('package.json', 'SPEC.md', 'CREDITS.md', 'vite.config.ts', 'vitest.config.ts',
                 'index.html', 'src\massing.ts', 'src\scene.ts', 'src\main.ts',
                 'src\facadeTextures.ts', 'scripts\capture.mjs', 'scripts\measure-eave-ratios.mjs',
                 'scripts\measure-glaze.mjs', 'scripts\verify-offline.mjs',
                 'scripts\visual-review.ps1', 'public\favicon.svg',
                 'tests\massing.test.ts')) {
    $p = Join-Path $Root $f
    $e = Test-Path $p
    if (-not $e) { $ok0 = $false }
    $pre.Add(("  {0} {1}" -f $(if ($e) { 'OK  ' } else { 'MISS' }), $f))
}
# HDRI 必须是真 Radiance HDR，而不是空文件或错误格式
if (Test-Path $Hdri) {
    $b = [System.IO.File]::ReadAllBytes($Hdri)
    $head = [System.Text.Encoding]::ASCII.GetString($b[0..127])
    $isHdr = $head.StartsWith('#?RADIANCE') -or $head.StartsWith('#?RGBE')
    $res = [regex]::Match($head, 'Y\s+(\d+)\s+X\s+(\d+)')
    $pre.Add("  HDRI radiance=$isHdr res=$(if ($res.Success) { $res.Groups[2].Value + 'x' + $res.Groups[1].Value } else { '?' }) bytes=$($b.Length)")
    if (-not $isHdr) { $ok0 = $false }
} else { $ok0 = $false; $pre.Add('  HDRI MISSING') }
$pre | ForEach-Object { Say $_ }
($pre -join "`n") | Out-File (Join-Path $LogDir 'S0-precheck.log') -Encoding utf8
Record 'S0-precheck' $ok0 "node=$nodeV pnpm=$pnpmV"

# ============================================================ S1 install
# -SkipInstall 时 S1 必须**记为显式跳过**，而不是"不记录"。
# 早先的写法在 -SkipInstall 下少记录一步，使 $total 恰好等于守卫下限，
# 于是"不得有静默跳过"这条承诺被自己破坏了（自审发现）。
if (-not $SkipInstall) {
    Say "`n===== S1 pnpm install ====="
    Push-Location $Root
    $r = Logged 'S1-install' { & pnpm install --reporter=append-only }
    Pop-Location
    $ok = Test-Path (Join-Path $Root 'node_modules\vite\bin\vite.js')
    Record 'S1-install' $ok "vite bin present=$ok ($($r.Ms) ms)"
} else {
    Say "`n===== S1 pnpm install（-SkipInstall，显式跳过）====="
    Record 'S1-install' $true 'EXPLICIT-SKIP: -SkipInstall requested by the caller'
}

# ============================================================ S2 typecheck
Say "`n===== S2 tsc --noEmit ====="
Push-Location $Root
$r = Logged 'S2-typecheck' { & pnpm exec tsc --noEmit }
Pop-Location
$tsc = $r.Exit -eq 0
Record 'S2-typecheck' $tsc "clean=$tsc ($($r.Ms) ms)"

# ============================================================ S3 unit tests
Say "`n===== S3 vitest run ====="
Push-Location $Root
$r = Logged 'S3-vitest' { & pnpm exec vitest run --reporter=basic }
Pop-Location
$vt = $r.Exit -eq 0
$vtLine = ([regex]::Match($r.Text, 'Tests\s+(\d+ passed[^\n]*)')).Groups[1].Value
Record 'S3-vitest' $vt "exit=$($r.Exit) $vtLine"

# ============================================================ S4 build
Say "`n===== S4 vite build ====="
Push-Location $Root
$r = Logged 'S4-build' { & pnpm exec vite build }
Pop-Location
$built = $r.Text -match 'built in'
$hdriInDist = Test-Path (Join-Path $Root 'dist\hdri\kloofendal_43d_clear_puresky_2k.hdr')
$bundle = ([regex]::Match($r.Text, 'dist/assets/index-[\w-]+\.js\s+([\d.]+) kB')).Groups[1].Value
Record 'S4-build' ($built -and $hdriInDist) "built=$built hdri_in_dist=$hdriInDist bundle=$bundle kB"

# ============================================================ S5 preview server
$ServerUp = $false
if ($built) {
    Say "`n===== S5 启动 preview (port $Port) ====="
    # 必须显式 -WorkingDirectory：vite preview 以 CWD 为基准找 dist，
    # 沿用调用方 CWD 会报 "The directory dist does not exist"（已实测）。
    $srv = Start-Process -FilePath 'node' `
        -ArgumentList (Join-Path $Root 'node_modules\vite\bin\vite.js'), 'preview',
                      '--port', "$Port", '--strictPort', '--host', '127.0.0.1' `
        -WorkingDirectory $Root -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogDir 'S5-server.out.log') `
        -RedirectStandardError (Join-Path $LogDir 'S5-server.err.log')
    $script:ServerPid = $srv.Id
    Start-Sleep -Seconds 8
    $code = [string]((& curl.exe -sS -m 15 -o NUL -w '%{http_code}' "http://127.0.0.1:$Port/" 2>&1) -join '')
    $hdriCode = [string]((& curl.exe -sS -m 15 -o NUL -w '%{http_code}' "http://127.0.0.1:$Port/hdri/kloofendal_43d_clear_puresky_2k.hdr" 2>&1) -join '')
    $ServerUp = ($code -eq '200')
    Say "  GET / -> $code   HDRI -> $hdriCode   pid=$($srv.Id)"
    ("GET / -> $code`nHDRI -> $hdriCode`n" + (Get-Content (Join-Path $LogDir 'S5-server.err.log') -Raw -ErrorAction SilentlyContinue)) |
        Out-File (Join-Path $LogDir 'S5-server.log') -Encoding utf8
    Record 'S5-server' ($ServerUp -and $hdriCode -eq '200') "http=$code hdri=$hdriCode port=$Port"
} else {
    Record 'S5-server' $false 'skipped: no build'
}
$Base = "http://127.0.0.1:$Port/"

# 服务未起来时，后续步骤必须显式记 FAIL —— 绝不静默跳过（否则脚本会"绿色退出"但没做检查）
if (-not $ServerUp) {
    foreach ($n in 'S6-gate', 'S7-selftest', 'S8-paramguard', 'S9-ratios', 'S9b-ratio-selftest',
                    'S11-glaze', 'S12-offline', 'S13-layout', 'S14-touch', 'S10-determinism') {
        Record $n $false 'skipped: preview server did not start'
    }
    Say "`n[!] 预览服务未启动，S6–S14 全部记为 FAIL（不静默跳过）"
}

# ============================================================ S6 截图门禁
if ($ServerUp) {
    Say "`n===== S6 截图门禁（四机位，应 exit 0）====="
    Remove-Item (Join-Path $ShotRoot 'gate') -Recurse -Force -ErrorAction SilentlyContinue
    Push-Location $Root
    $r = Logged 'S6-gate' {
        & node (Join-Path $Root 'scripts\capture.mjs') $Base (Join-Path $ShotRoot 'gate') 1280 720 `
            'hero:2' 'front:2' 'low:2' 'top:2' --assert
    }
    Pop-Location
    $g = $r.Exit -eq 0
    $fails = ([regex]::Match($r.Text, '"failures":\s*\[(.*?)\]', 'Singleline')).Groups[1].Value.Trim()
    Record 'S6-gate' $g "exit=$($r.Exit) failures=[$fails]"
}

# ============================================================ S7 门禁自证
if ($ServerUp) {
    Say "`n===== S7 门禁自证（注入故障必须全部 exit 1）====="
    $cases = @(
        @{ n = 'env';  tok = 'hero:2:env' },      # 缺失 HDRI
        @{ n = 'warn'; tok = 'hero:2:warn' },     # 页面错误
        @{ n = 'gap';  tok = 'hero:2:gap' }       # 形制断口
    )
    $all = $true
    $det = [System.Collections.Generic.List[string]]::new()
    foreach ($c in $cases) {
        Push-Location $Root
        $rr = Logged "S7-$($c.n)" {
            & node (Join-Path $Root 'scripts\capture.mjs') $Base (Join-Path $ShotRoot "st-$($c.n)") 1280 720 `
                "$($c.tok)|env=1" --assert
        }
        Pop-Location
        $bit = $rr.Exit -eq 1
        if (-not $bit) { $all = $false }
        $f = ([regex]::Match($rr.Text, '"failures":\s*\[(.*?)\]', 'Singleline')).Groups[1].Value.Trim()
        $det.Add("  $($c.n): exit=$($rr.Exit) (want 1) failures=[$f]")
    }
    $det | ForEach-Object { Say $_ }
    ($det -join "`n") | Out-File (Join-Path $LogDir 'S7-selftest.log') -Encoding utf8
    Record 'S7-selftest' $all 'all injected faults produced exit 1'
}

# ============================================================ S8 参数生效守卫
if ($ServerUp) {
    Say "`n===== S8 参数生效守卫 ====="
    $cases = @(
        @{ n = 'match';    tok = 'hero:2|env=1,envint=0.25,expect=envint~0.25'; want = 0 },
        @{ n = 'mismatch'; tok = 'hero:2|env=1,envint=0.25,expect=envint~0.9';  want = 1 },
        @{ n = 'unknown';  tok = 'hero:2|env=1,expect=noSuchParam~1';           want = 1 }
    )
    $all = $true
    $det = [System.Collections.Generic.List[string]]::new()
    foreach ($c in $cases) {
        Push-Location $Root
        $rr = Logged "S8-$($c.n)" {
            & node (Join-Path $Root 'scripts\capture.mjs') $Base (Join-Path $ShotRoot "pg-$($c.n)") 1280 720 `
                $c.tok --assert
        }
        Pop-Location
        $okCase = $rr.Exit -eq $c.want
        if (-not $okCase) { $all = $false }
        $f = ([regex]::Match($rr.Text, '"failures":\s*\[(.*?)\]', 'Singleline')).Groups[1].Value.Trim()
        $det.Add("  $($c.n): exit=$($rr.Exit) (want $($c.want)) failures=[$f]")
    }
    $det | ForEach-Object { Say $_ }
    ($det -join "`n") | Out-File (Join-Path $LogDir 'S8-paramguard.log') -Encoding utf8
    Record 'S8-paramguard' $all 'accepted-but-ineffective params are detected'
}

# ============================================================ S9 形制比值（实测渲染）
if ($ServerUp) {
    Say "`n===== S9 三重檐出挑比 vs 参考读值（量测渲染剪影）====="
    # 关键：必须量测**渲染结果**，不能回读建模常量。把用于建模的常量再和参考值比较是同义反复，
    # 永远相等、永远发现不了几何错误（第一版就是如此，worst 恒为 0）。
    $silDir = Join-Path $ShotRoot 'silhouette'
    Remove-Item $silDir -Recurse -Force -ErrorAction SilentlyContinue
    Push-Location $Root
    $rr = Logged 'S9-render' {
        & node (Join-Path $Root 'scripts\capture.mjs') $Base $silDir 1280 720 `
            'elev:2|silhouette=1,projection=ortho' --assert
    }
    Pop-Location
    $silFile = Get-ChildItem $silDir -Filter *.png -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($silFile) {
        $m = Logged 'S9-measure' { & node (Join-Path $Root 'scripts\measure-eave-ratios.mjs') $silFile.FullName }
        $measured = $null
        try { $measured = ($m.Text | ConvertFrom-Json) } catch { $measured = $null }
        if ($measured -and $measured.ok) {
            # 参考值由 measure-eave-ratios.mjs 以字面量给出；这里**再独立核对一次**，
            # 防止参考值本身被改动后不被发现（曾发现 $RefRatio 为死变量，参考值可静默漂移）。
            $expectRef = @(0.64, 0.86, 1.0)
            $refOk = ($measured.reference.Count -eq 3) -and
                     (@(0..2 | Where-Object { [Math]::Abs([double]$measured.reference[$_] - $expectRef[$_]) -gt 1e-9 }).Count -eq 0)
            if (-not $refOk) {
                Record 'S9-ratios' $false ("reference drifted: got [" + ($measured.reference -join ':') + "] expected [" + ($expectRef -join ':') + "]")
            } else {
                $ok = [double]$measured.worst -le $RatioTol
                Record 'S9-ratios' $ok ("measured=" + ($measured.ratios -join ':') +
                    " ref=" + ($measured.reference -join ':') +
                    " worst=$($measured.worst) tol=$RatioTol (from rendered silhouette)")
            }
        } else {
            Record 'S9-ratios' $false ("measurement failed: " + $(if ($measured) { $measured.reason } else { 'unparsable output' }))
        }
    } else {
        Record 'S9-ratios' $false 'silhouette render produced no PNG'
    }

    # S9b：证明 S9 **不是同义反复**。fault=ratio 只改渲染几何、不改 massing 常量，
    # 因此"回读常量"式的检查仍会通过，而"量测渲染"式的检查必须失败。
    # 若注入故障后仍 PASS，说明 S9 在自欺，必须视为失败。
    Say "`n----- S9b 出挑比量测自证（注入几何故障必须被发现）-----"
    $silFault = Join-Path $ShotRoot 'silhouette-fault'
    Remove-Item $silFault -Recurse -Force -ErrorAction SilentlyContinue
    Push-Location $Root
    $null = Logged 'S9b-render' {
        & node (Join-Path $Root 'scripts\capture.mjs') $Base $silFault 1280 720 `
            'elev:2:ratio|silhouette=1,projection=ortho' --assert
    }
    Pop-Location
    $ff = Get-ChildItem $silFault -Filter *.png -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($ff) {
        $mf = Logged 'S9b-measure' { & node (Join-Path $Root 'scripts\measure-eave-ratios.mjs') $ff.FullName }
        $fm = $null
        try { $fm = ($mf.Text | ConvertFrom-Json) } catch { $fm = $null }
        $bit = ($fm -and $fm.ok -and [double]$fm.worst -gt $RatioTol)
        Record 'S9b-ratio-selftest' $bit ("injected worst=" + $(if ($fm) { $fm.worst } else { 'n/a' }) +
            " > tol=$RatioTol => $bit (proves the ratio check measures rendered geometry)")
    } else {
        Record 'S9b-ratio-selftest' $false 'faulted silhouette produced no PNG'
    }
}

# ============================================================ S11 蓝釉色 vs 故宫基准
if ($ServerUp) {
    Say "`n===== S11 蓝釉 Lab vs 故宫实测容差（量测渲染像素）====="
    # §4.7：必须从**渲染像素**量测，不能回读材质常量（那样永远相等）。
    # 基准：故宫博物院 天坛蓝釉标准样品 Lab(28.26, 5.87, −18.99)，
    #       容差 L*[24,34] a*[1.87,8.77] b*[−25.36,−12.71]
    $glDir = Join-Path $ShotRoot 'glaze'
    Remove-Item $glDir -Recurse -Force -ErrorAction SilentlyContinue
    Push-Location $Root
    $null = Logged 'S11-render' {
        & node (Join-Path $Root 'scripts\capture.mjs') $Base $glDir 1280 720 'hero:2' --assert
    }
    Pop-Location
    $gf = Get-ChildItem $glDir -Filter *.png -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($gf) {
        $gm = Logged 'S11-measure' { & node (Join-Path $Root 'scripts\measure-glaze.mjs') $gf.FullName }
        $gj = $null
        try { $gj = ($gm.Text | ConvertFrom-Json) } catch { $gj = $null }
        if ($gj -and $gj.ok) {
            Record 'S11-glaze' ([bool]$gj.allInTolerance) (
                "Lab=($($gj.meanLab -join ', ')) palace=(28.26, 5.87, -18.99) " +
                "dE=$($gj.deltaE) inTol=$($gj.allInTolerance) pixels=$($gj.glazePixels)")
        } else {
            Record 'S11-glaze' $false ("measurement failed: " + $(if ($gj) { $gj.reason } else { 'unparsable' }))
        }
    } else {
        Record 'S11-glaze' $false 'glaze render produced no PNG'
    }
}

# ============================================================ S12 离线自包含（实测）
if ($ServerUp) {
    Say "`n===== S12 离线自包含实测（阻断一切非本地请求）====="
    # 目标要求"运行时完全离线自包含"。只"看代码里没有 http"不构成证明，
    # 故实测：拦截并阻断所有非 127.0.0.1/localhost 的请求，然后确认场景仍正常渲染。
    Push-Location $Root
    $r = Logged 'S12-offline' {
        & node (Join-Path $Root 'scripts\verify-offline.mjs') $Base
    }
    Pop-Location
    # 输出形如：{ ...json... }\n\nOFFLINE_SELF_CONTAINED=true  (external requests = 0)\nRENDER_OK...
    # 直接 ConvertFrom-Json 会因尾部诊断行而失败，故只取第一个完整的 JSON 对象。
    $oj = $null
    $ojOk = $false
    $m = [regex]::Match($r.Text, '\{.*\}', 'Singleline')
    if ($m.Success) {
        try { $oj = $m.Value | ConvertFrom-Json; $ojOk = $true } catch { $ojOk = $false }
    }
    $offlineOk = ($r.Exit -eq 0) -and $ojOk -and ($oj.externalRequests -eq 0) -and
                 ($oj.envLoaded -eq $true) -and ($oj.hasEnvironment -eq $true)
    Record 'S12-offline' $offlineOk (
        "exit=$($r.Exit) jsonParsed=$ojOk externalRequests=$(if ($ojOk) { $oj.externalRequests } else { '?' }) " +
        "envLoaded=$(if ($ojOk) { $oj.envLoaded } else { '?' }) hasEnvironment=$(if ($ojOk) { $oj.hasEnvironment } else { '?' }) " +
        "pageErrors=$(if ($ojOk) { $oj.pageErrors.Count } else { '?' })")
}

# ============================================================ S13 响应式布局
if ($ServerUp) {
    Say "`n===== S13 响应式布局（3 视口 × 两条 Q30 约束）====="
    # 断言的是渲染出来的真实 DOM/相机数值，不是回读源码常量。
    # 两个模式都跑：viewport（人看，无 w/h）与 fixed（门禁，w/h 钉死尺寸）。
    $okAll = $true
    $det = [System.Collections.Generic.List[string]]::new()
    foreach ($mode in @('viewport', 'fixed')) {
        Push-Location $Root
        if ($mode -eq 'fixed') {
            $r = Logged "S13-layout-$mode" { & node (Join-Path $Root 'scripts\verify-layout.mjs') $Base '--fixed' }
        } else {
            $r = Logged "S13-layout-$mode" { & node (Join-Path $Root 'scripts\verify-layout.mjs') $Base }
        }
        Pop-Location
        $j = $null; $parsed = $false
        $m = [regex]::Match($r.Text, '\{.*\}', 'Singleline')
        if ($m.Success) { try { $j = $m.Value | ConvertFrom-Json; $parsed = $true } catch { $parsed = $false } }
        if (-not $parsed) { $okAll = $false; $det.Add("  $mode : output unparsable (exit=$($r.Exit))"); continue }
        if ($r.Exit -ne 0) { $okAll = $false }
        foreach ($res in $j.results) {
            $fr = $res.framing
            $det.Add(("  {0,-8} {1,-22} rect={2}x{3} pxRatio={4} hf={5} vw={6} {7}" -f `
                $mode, $res.viewport, [math]::Round($res.rect.w), [math]::Round($res.rect.h), `
                $res.pixelRatio, $fr.heightFraction, $fr.visibleWidth, $fr.mode))
        }
        if ($j.failures.Count) { $det.Add("  $mode FAILURES: " + ($j.failures -join '; ')) }
    }
    $det | ForEach-Object { Say $_ }
    ($det -join "`n") | Out-File (Join-Path $LogDir 'S13-layout.log') -Encoding utf8
    Record 'S13-layout' $okAll 'canvas fills viewport; Q30 framing holds in 3 viewports x 2 modes'
}

# ============================================================ S14 移动端基线 + 触摸
if ($ServerUp) {
    Say "`n===== S14 移动端基线（竖屏触摸手势）====="
    Push-Location $Root
    $r = Logged 'S14-touch' { & node (Join-Path $Root 'scripts\verify-touch.mjs') $Base }
    Pop-Location
    $tj = $null; $tParsed = $false
    $m2 = [regex]::Match($r.Text, '\{.*\}', 'Singleline')
    if ($m2.Success) { try { $tj = $m2.Value | ConvertFrom-Json; $tParsed = $true } catch { $tParsed = $false } }
    $touchOk = ($r.Exit -eq 0) -and $tParsed
    $det2 = [System.Collections.Generic.List[string]]::new()
    if ($tParsed) {
        foreach ($c in $tj.results) {
            $extra = ''
            if ($null -ne $c.dPos) { $extra += " dPos=$($c.dPos)" }
            if ($null -ne $c.dDistAway) { $extra += " dAway=$($c.dDistAway) dTogether=$($c.dDistTogether)" }
            if ($null -ne $c.touchAction) { $extra += " touchAction=$($c.touchAction)" }
            $det2.Add(("  {0,-46} ok={1}{2}" -f $c.check, $c.ok, $extra))
        }
        if ($tj.failures.Count) { $det2.Add("  FAILURES: " + ($tj.failures -join '; ')) }
    } else { $det2.Add("  output unparsable (exit=$($r.Exit))") }
    $det2 | ForEach-Object { Say $_ }
    ($det2 -join "`n") | Out-File (Join-Path $LogDir 'S14-touch.log') -Encoding utf8
    Record 'S14-touch' $touchOk 'drag rotates, pinch dollies reversibly, disabled control stays put'
}

# ============================================================ S10 确定性
if ($ServerUp) {
    Say "`n===== S10 确定性（连跑两次截图必须字节一致）====="
    $dirA = Join-Path $ShotRoot 'det-a'; $dirB = Join-Path $ShotRoot 'det-b'
    Remove-Item $dirA, $dirB -Recurse -Force -ErrorAction SilentlyContinue
    Push-Location $Root
    $null = Logged 'S10-run-a' {
        & node (Join-Path $Root 'scripts\capture.mjs') $Base $dirA 1280 720 'hero:2' 'front:2'
    }
    Start-Sleep -Seconds 2
    $null = Logged 'S10-run-b' {
        & node (Join-Path $Root 'scripts\capture.mjs') $Base $dirB 1280 720 'hero:2' 'front:2'
    }
    Pop-Location
    $ha = @(Get-ChildItem $dirA -Filter *.png -ErrorAction SilentlyContinue | Sort-Object Name |
        ForEach-Object { (Get-FileHash $_.FullName -Algorithm SHA256).Hash })
    $hb = @(Get-ChildItem $dirB -Filter *.png -ErrorAction SilentlyContinue | Sort-Object Name |
        ForEach-Object { (Get-FileHash $_.FullName -Algorithm SHA256).Hash })
    $same = ($ha.Count -gt 0) -and ($ha.Count -eq $hb.Count) -and
            (@(0..($ha.Count - 1) | Where-Object { $ha[$_] -ne $hb[$_] }).Count -eq 0)
    Record 'S10-determinism' $same "shots=$($ha.Count) identical=$same"
}

# ============================================================ 汇总与清理
Say "`n===== 清理 ====="
Stop-MyServer
Say '  已停止本次启动的预览服务（若有）'
# 仅按精确标识清理 playwright 探针浏览器；绝不模糊匹配命令行（会杀掉自己的 job runner）
$stray = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'playwright_chromiumdev_profile' })
foreach ($p in $stray) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
Say "  清理 playwright 探针浏览器：$($stray.Count) 个"

$pass = @($Results | Where-Object { $_.Ok }).Count
$total = @($Results).Count
# "静默跳过"= 因依赖未满足而没跑（Detail 以 'skipped:' 开头）。
# 调用方**显式要求**跳过（-SkipInstall）记为 EXPLICIT-SKIP 且计 PASS，两者不同。
$skipped = @($Results | Where-Object { -not $_.Ok -and $_.Detail -like 'skipped:*' }).Count
$explicitSkips = @($Results | Where-Object { $_.Detail -like 'EXPLICIT-SKIP:*' }).Count
$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add("祈年殿 run.ps1 汇总  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
$lines.Add("node=$nodeV pnpm=$pnpmV")
$lines.Add('')
foreach ($r in $Results) {
    $lines.Add(("{0} {1,-20} {2}" -f $(if ($r.Ok) { 'PASS' } else { 'FAIL' }), $r.Step, $r.Detail))
}
$lines.Add('')
$lines.Add("TOTAL $pass/$total PASS  (silentSkips=$skipped explicitSkips=$explicitSkips)")
# 覆盖率守卫：步骤齐备且无**静默**跳过，防止"绿色但没跑关键检查"的假阳性。
# 下限 16 = S0..S14（含 S9b、S11、S12、S13、S14），使"少记录一步"这类问题无法绕开守卫。
$expectedSteps = 16
$guard = ($total -ge $expectedSteps -and $skipped -eq 0)
if ($total -lt $expectedSteps) { $lines.Add("GUARD FAIL: only $total steps recorded, expected >= $expectedSteps") }
if ($skipped -gt 0) { $lines.Add("GUARD FAIL: $skipped step(s) were silently skipped") }
($lines -join "`n") | Out-File (Join-Path $LogDir 'SUMMARY.log') -Encoding utf8

Say "`n===== 汇总 ====="
$lines | ForEach-Object { Say $_ }
Say "SUMMARY $pass/$total PASS :: logs=$LogDir"
if ($pass -eq $total -and $guard) { exit 0 } else { exit 1 }
