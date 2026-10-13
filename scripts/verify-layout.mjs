// 响应式布局验证（S13）。
//
// 断言的是**渲染出来的真实 DOM/相机数值**，不是回读源码常量：
//   1) 画布 rect 宽 == 视口宽（±1px）      2) rect 高 == 视口高
//   3) 画布宽高比 == 视口宽高比（±0.01）   4) 无水平滚动
//   5) 门禁/固定模式下 DPR == 1            6) 建筑占屏高 >=45% 且可见宽 >= 下限（Q30）
//
// 为什么每条都要单独报：布局错了与取景错了是两类故障，合成一条只会说"失败了"。
//
// 用法：node scripts/verify-layout.mjs <baseUrl> [--fixed]
//   --fixed 时给每个视口附加 w/h（模拟门禁的固定尺寸路径）
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const baseUrl = argv.find((a) => !a.startsWith('--'));
const fixed = argv.includes('--fixed');
if (!baseUrl) { console.error('usage: node verify-layout.mjs <baseUrl> [--fixed]'); process.exit(2); }

const VIEWPORTS = [
  { name: 'desktop-1280x720', width: 1280, height: 720 },
  { name: 'portrait-390x844', width: 390, height: 844 },
  { name: 'ultrawide-2560x1080', width: 2560, height: 1080 },
];

const MIN_HEIGHT_FRACTION = 0.45;
const MIN_VISIBLE_WIDTH = 35.92;   // 大殿本体 32.72 + 两侧各 1.6（与 src/framing.ts 同阈值）
const HALL_BODY = 32.72;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
const failures = [];
try {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    const url = fixed
      ? `${baseUrl}?w=${vp.width}&h=${vp.height}&hud=0&controls=0`
      : `${baseUrl}?hud=0`;
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.__SCENE__ !== undefined, null, { timeout: 30000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const m = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      const r = c.getBoundingClientRect();
      return {
        rect: { w: r.width, h: r.height, x: r.x, y: r.y },
        attr: { w: c.width, h: c.height },
        style: { w: getComputedStyle(c).width, h: getComputedStyle(c).height, touchAction: getComputedStyle(c).touchAction },
        doc: {
          scrollW: document.documentElement.scrollWidth,
          clientW: document.documentElement.clientWidth,
          scrollH: document.documentElement.scrollHeight,
          clientH: document.documentElement.clientHeight,
        },
        dpr: window.devicePixelRatio,
        scene: window.__SCENE__,
      };
    });

    const checks = [];
    const near = (a, b, tol) => Math.abs(a - b) <= tol;
    checks.push(['canvas_width_eq_viewport', near(m.rect.w, vp.width, 1)]);
    checks.push(['canvas_height_eq_viewport', near(m.rect.h, vp.height, 1)]);
    checks.push(['canvas_aspect_eq_viewport', near(m.rect.w / m.rect.h, vp.width / vp.height, 0.01)]);
    checks.push(['no_horizontal_scroll', m.doc.scrollW <= m.doc.clientW + 1]);
    if (fixed) checks.push(['dpr_is_1', m.scene.pixelRatio === 1]);
    checks.push(['touch_action_none', m.style.touchAction === 'none']);
    // 取景（Q30）：占屏高与可见宽度两条约束
    const fr = m.scene.framing ?? {};
    checks.push(['framing_height_fraction_ok', (fr.heightFraction ?? 0) >= MIN_HEIGHT_FRACTION - 1e-3]);
    checks.push(['framing_visible_width_ok', (fr.visibleWidth ?? 0) >= MIN_VISIBLE_WIDTH - 1e-3]);
    checks.push(['framing_hall_body_not_cropped', (fr.visibleWidth ?? 0) >= HALL_BODY - 1e-3]);
    checks.push(['no_page_errors', errs.filter((e) => e.startsWith('pageerror:')).length === 0]);

    for (const [name, ok] of checks) if (!ok) failures.push(`${vp.name} -> ${name}`);

    results.push({
      viewport: vp.name,
      url,
      rect: m.rect, attr: m.attr, style: m.style, doc: m.doc, dpr: m.dpr,
      sizing: m.scene.sizing, pixelRatio: m.scene.pixelRatio,
      framing: fr, errs, checks,
    });
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ mode: fixed ? 'fixed' : 'viewport', failures, results }, null, 2));
if (failures.length) {
  console.error(`\nLAYOUT ASSERTIONS FAILED (${failures.length}):\n  ` + failures.join('\n  '));
  process.exit(1);
}
