// 验证**线上**部署真的可用 —— 部署返回 URL 不等于应用能跑。
//
// 覆盖三件只在真实 CDN 上才会暴露的事：
//   1) 页面能否在无本地服务的情况下完成渲染（模块加载、IBL 拉取 4.4MB HDRI、WebGL 上下文）
//   2) 生产 URL 与本次部署的 preview URL 是否都正常
//   3) 缓存头是否正确（HDRI 是不可变大文件，应可长缓存）—— 决定二次访问体验
//
// 用法：node scripts/verify-deployed.mjs <url> [<url2> ...]
import { chromium } from 'playwright';

const urls = process.argv.slice(2);
if (!urls.length) { console.error('usage: node verify-deployed.mjs <url> [...]'); process.exit(2); }

const failures = [];
const results = [];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const url of urls) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errs = [];
    const failed = [];
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
    page.on('requestfailed', (r) => failed.push(`${r.failure()?.errorText} ${r.url()}`));

    const rec = { url, ok: false };
    try {
      const t0 = Date.now();
      const resp = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      rec.status = resp ? resp.status() : null;
      // 等场景就绪：这一步同时证明 JS 加载、HDRI 拉取、WebGL 初始化都成功
      await page.waitForFunction(() => window.__SCENE__ !== undefined, null, { timeout: 60000 });
      rec.loadMs = Date.now() - t0;
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const s = await page.evaluate(() => window.__SCENE__);
      rec.envLoaded = s.env?.loaded === true;
      rec.hasEnvironment = s.hasEnvironment === true;
      rec.totalHeightOk = s.assertions?.totalHeightOk === true;
      rec.segmentsClosedOk = s.assertions?.segmentsClosedOk === true;
      rec.controls = s.controls;              // 线上应默认开启（用户要求 3）
      rec.quality = s.quality;
      rec.framing = s.framing ?? null;

      // 画布确实铺满视口，且真的画出了东西（非纯色）
      const canvas = await page.evaluate(() => {
        const c = document.querySelector('canvas');
        const r = c.getBoundingClientRect();
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        const px = new Uint8Array(4 * 64 * 64);
        // 取中心区域 64x64 采样，统计不同颜色数
        gl.readPixels(Math.floor(c.width / 2) - 32, Math.floor(c.height / 2) - 32, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const set = new Set();
        for (let i = 0; i < px.length; i += 4) set.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
        return { w: c.width, h: c.height, rectW: r.width, rectH: r.height, distinct: set.size };
      });
      rec.canvas = canvas;
      rec.fillOk = Math.abs(canvas.rectW - 1280) <= 1 && Math.abs(canvas.rectH - 720) <= 1;
      rec.renderedOk = canvas.distinct > 50;   // 纯色画面 distinct 会很小

      // 首次截图（不发额外请求即可验证管线）
      const shot = `D:/lab/qiniandian/shots/deployed/${url.replace(/https?:\/\//, '').replace(/[^\w.-]/g, '_')}.png`;
      await page.screenshot({ path: shot });
      rec.screenshot = shot;

      rec.errors = errs;
      rec.failedRequests = failed;
      rec.ok = rec.status === 200 && rec.envLoaded && rec.hasEnvironment
        && rec.totalHeightOk && rec.segmentsClosedOk && rec.fillOk && rec.renderedOk
        && errs.filter((e) => e.startsWith('pageerror:')).length === 0
        && failed.length === 0;
      if (!rec.ok) failures.push(`${url}: ${JSON.stringify({ status: rec.status, envLoaded: rec.envLoaded, hasEnvironment: rec.hasEnvironment, fillOk: rec.fillOk, renderedOk: rec.renderedOk, errors: errs, failed })}`);
    } catch (e) {
      rec.error = String(e.message ?? e).split('\n')[0];
      failures.push(`${url}: ${rec.error}`);
    }
    results.push(rec);
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ failures, results }, null, 2));
if (failures.length) {
  console.error(`\nDEPLOYED-SITE VERIFICATION FAILED (${failures.length}):\n  ` + failures.join('\n  '));
  process.exit(1);
}
