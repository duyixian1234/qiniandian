// 确定性截图门禁：headless 本机 MS Edge（channel 'msedge'）、固定视口、固定机位。
//
// 用法：
//   node scripts/capture.mjs <baseUrl> <outDir> <w> <h> [cam[:detail][:fault] ...] [--assert]
//
// 为什么这是门禁而不是"截图工具"：它以**进程退出码**判定成败（0/1），
// 断言来自页面自报的场景统计。截图"看起来不错"不构成通过。
//
// 已实测的环境事实（见 ../.probe/FACTS.md）：
//   - headless Edge 无需任何特殊标志即走真实 GPU 渲染 WebGL2
//   - 打包 chromium 不可用（需 rev 1248，本机缓存仅 1193/1234）⇒ msedge channel 是唯一免下载路径
//   - 故障注入（fault=gap/404/warn/env）用于"测试这个测试"：证明门禁真的会失败
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const doAssert = argv.includes('--assert');
const [baseUrl, outDir, wArg, hArg, ...rest] = argv.filter((a) => a !== '--assert');
const width = parseInt(wArg, 10);
const height = parseInt(hArg, 10);
const shots = rest.length ? rest : ['hero:2', 'front:2', 'low:2', 'top:2'];
mkdirSync(outDir, { recursive: true });

const results = [];
const failures = [];
const browser = await chromium.launch({ channel: 'msedge', headless: true });

try {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  const failedResponses = [];
  page.on('response', (r) => { if (r.status() >= 400) failedResponses.push(`${r.status()} ${r.url()}`); });
  const failedRequests = [];
  page.on('requestfailed', (r) => failedRequests.push(`${r.failure()?.errorText} ${r.url()}`));

  for (const token of shots) {
    // token: "cam[:detail][:fault]|key=value,key=value"
    const [spec, extra = ''] = token.split('|');
    const [cam, detailPart = '2', fault = ''] = spec.split(':');
    // 门禁一律：固定尺寸（w/h）+ 不创建相机控件 + 隐藏 HUD。
    // 三者都是**截图基线可复现**的前提：
    //   - w/h 让画布尺寸与运行者窗口无关
    //   - controls=0 让相机不因控件构造而被 lookAt(target) 改写（OrbitControls 构造函数
    //     自己会 update() 一次，且 update() 无 enabled 检查，故"根本别构造"才是可靠做法）
    //   - hud=0 让左上角那行 ~1100 字符的 JSON 不进入画面（它会污染剪影量测）
    const q = new URLSearchParams({
      cam, detail: detailPart, w: String(width), h: String(height),
      controls: '0', hud: '0',
    });

    // 可选 "expect=param~value;param~value"：声明必须被页面自报的参数值。
    // 用途是抓"参数被接受但静默无效"——这类 bug 不报错、不变更，只有回读才能发现。
    let expectParams = null;
    for (const kv of extra.split(',').filter(Boolean)) {
      const [k, ...vparts] = kv.split('=');
      const v = vparts.join('=');
      if (k === 'expect') {
        expectParams = {};
        for (const pair of v.split(';').filter(Boolean)) {
          const [pk, pv] = pair.split('~');
          if (pk) expectParams[pk] = pv;
        }
      } else {
        q.set(k, v);
      }
    }
    if (fault) q.set('fault', fault);

    const url = `${baseUrl}?${q.toString()}`;
    const tag = `${cam}-d${detailPart}${extra ? '-' + extra.replace(/[=,;~|]/g, '') : ''}${fault ? '-' + fault : ''}`;

    consoleErrors.length = 0;
    failedResponses.length = 0;
    failedRequests.length = 0;

    const resp = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.__SCENE__ !== undefined, null, { timeout: 30000 });
    // 确定性沉降：等两帧后再截
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const scene = await page.evaluate(() => window.__SCENE__);

    const path = join(outDir, `${tag}-${width}x${height}.png`);
    // **canvas-only** 截图，而不是整页截图。
    // 理由不是洁癖：S9/S9b 从剪影图里做宽度峰值检测以量测三角形出挑比，
    // 任何 DOM 浮层（HUD、控件面板、ViewHelper）都会伪造出假峰值，让那条断言失效。
    // 用 locator('canvas') 让形制量测与 UI 彻底解耦。
    await page.locator('canvas').screenshot({ path, animations: 'disabled' });

    const checks = [];
    const a = scene?.assertions ?? {};
    // 只有请求了 IBL 才要求它加载成功；否则不误伤 env=0 的对照。
    const envRequested = scene?.env?.requested === true;
    // §4.4：总高 36.8 ± 0.15
    checks.push(['totalHeightOk', a.totalHeightOk === true]);
    checks.push(['segmentsClosedOk', a.segmentsClosedOk === true]);
    checks.push(['segmentGapMarginal', Math.abs(a.segmentGap ?? 0) <= 1e-3]);
    // §4.5 考据计数：**应然**（SOURCED）与**实然**（built）都要对。
    // 只查其一是不够的：只看 SOURCED 是回读常量（回归也能通过），只看 built 则不知目标。
    checks.push(['columnsIs28', scene?.columns === 28]);
    checks.push(['panelsPerTierIs108', scene?.panelsPerTier === 108]);
    checks.push(['stairwaysPerTierIs8', scene?.stairwaysPerTier === 8]);
    checks.push(['eaveTiersIs3', scene?.eaveTiers === 3]);
    checks.push(['sourcedCountsAllOk', Array.isArray(scene?.counts) && scene.counts.every((c) => c.ok)]);
    checks.push(['builtColumnsIs24', scene?.built?.columns === 24]);        // 外观范围：12 金 + 12 檐
    checks.push(['builtPanelsIs324', scene?.built?.panels === 324]);        // 108 × 3 层
    checks.push(['builtStairFlightsIs24', scene?.built?.stairFlights === 24]); // 8 处 × 3 层
    checks.push(['builtEavesIs3', scene?.built?.eaves === 3]);
    if (envRequested) checks.push(['envLoadedOk', a.envLoadedOk === true]);
    // 门禁基线前置条件：必须确认"不创建控件"与"隐藏 HUD"**真的生效**，
    // 而不是被接受后静默无效（本项目已踩过一次这类 bug）。
    checks.push(['controlsDisabled', scene?.controls === false]);
    checks.push(['hudHidden', scene?.hudVisible === false]);
    checks.push(['hudElementAbsent', await page.evaluate(() => {
      const el = document.getElementById('sceneinfo');
      return el === null || el.hidden === true;
    })]);
    checks.push(['canvasFillsViewport', await page.evaluate(() => {
      const c = document.querySelector('canvas');
      const r = c.getBoundingClientRect();
      return Math.abs(r.width - innerWidth) <= 1 && Math.abs(r.height - innerHeight) <= 1;
    })]);
    // 忽略浏览器隐式的 /favicon.ico 探测：它缺失不是场景缺陷
    const realFailures = failedResponses.filter((s) => !/\/favicon\.ico$/.test(s));
    checks.push(['noPageErrors', consoleErrors.filter((s) => s.startsWith('pageerror:')).length === 0]);
    // 资源完整性必须同时看 response>=400 与 requestfailed（后者是网络层失败，状态码可能缺失）。
    // 早先只检查 failedResponses，导致 failedRequests 收集了却从不参与判定。
    checks.push(['noFailedResources', realFailures.length === 0 && failedRequests.length === 0]);
    if (expectParams) {
      for (const [k, want] of Object.entries(expectParams)) {
        const got = scene?.[k];
        const ok = got === undefined ? false
          : (typeof got === 'number' ? Math.abs(got - Number(want)) < 1e-9 : String(got) === String(want));
        checks.push([`param_${k}_honoured`, ok]);
      }
    }
    for (const [name, ok] of checks) if (!ok) failures.push(`${tag} -> ${name}`);

    results.push({
      tag, cam, detail: detailPart, status: resp ? resp.status() : null, path, scene,
      consoleErrors: [...consoleErrors], failedResponses: [...failedResponses],
      failedRequests: [...failedRequests], checks,
    });
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ renderer: 'msedge-headless', width, height, assertMode: doAssert, failures, results }, null, 2));
if (doAssert && failures.length) {
  console.error(`\nASSERTIONS FAILED (${failures.length}):\n  ` + failures.join('\n  '));
  process.exit(1);
}
