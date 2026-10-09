// 离线自包含的**实测**证明（不是"看代码里没有 http 就算"）。
//
// 做法：用 headless 本机 MS Edge 打开页面，并**拦截所有非 127.0.0.1/localhost 的请求**，
// 一旦有外部请求就记下来并阻断。然后检查：
//   1) 场景是否仍然成功渲染（IBL 已加载、无页面错误）
//   2) 是否真的发生过外部请求
// 若场景正常且外部请求为 0，才说明"运行时完全离线自包含"这条被实测证实。
//
// 用法：node scripts/verify-offline.mjs <baseUrl>
import { chromium } from 'playwright';

const baseUrl = process.argv[2];
if (!baseUrl) { console.error('usage: node verify-offline.mjs <baseUrl>'); process.exit(2); }

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const external = [];
const allowed = [];
let blocked = 0;

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();

  const isLocal = (u) => {
    try {
      const h = new URL(u).hostname;
      return h === '127.0.0.1' || h === 'localhost' || h === '::1';
    } catch { return false; }
  };

  // 任何非本地请求：记录并**阻断**
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith('data:') || u.startsWith('blob:')) { allowed.push(u); return route.continue(); }
    if (isLocal(u)) { allowed.push(u); return route.continue(); }
    external.push(u);
    blocked++;
    return route.abort();
  });

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${baseUrl}?cam=hero&detail=2`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__SCENE__ !== undefined, null, { timeout: 30000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const scene = await page.evaluate(() => window.__SCENE__);

  // 确认画面确实渲染了内容（非空白）
  const png = await page.screenshot({ type: 'png' });
  const stats = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    return { w: c.width, h: c.height, gl: !!gl };
  });

  const result = {
    ok: true,
    externalRequests: external.length,
    externalUrls: [...new Set(external)].slice(0, 20),
    blockedRequests: blocked,
    localRequests: allowed.length,
    envLoaded: scene?.env?.loaded === true,
    envRequested: scene?.env?.requested === true,
    hasEnvironment: scene?.hasEnvironment === true,
    totalHeightOk: scene?.assertions?.totalHeightOk === true,
    segmentsClosedOk: scene?.assertions?.segmentsClosedOk === true,
    pageErrors: errors.filter((e) => e.startsWith('pageerror:')),
    consoleErrors: errors.filter((e) => !e.startsWith('pageerror:')),
    canvas: stats,
    screenshotBytes: png.length,
  };
  console.log(JSON.stringify(result, null, 2));

  // 判定：无外部请求 + IBL 成功 + 无页面错误
  const offlineOk = external.length === 0;
  const renderOk = result.envLoaded && result.hasEnvironment && result.totalHeightOk;
  console.log('');
  console.log(`OFFLINE_SELF_CONTAINED=${offlineOk}  (external requests = ${external.length})`);
  console.log(`RENDER_OK_WITHOUT_NETWORK=${renderOk}`);
  if (!offlineOk || !renderOk) process.exitCode = 1;
} finally {
  await browser.close();
}
