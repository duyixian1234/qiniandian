// 触摸交互验证（S14 的一半）。
//
// 为什么这条不能只测"触摸生效"：OrbitControls 的触摸走**独立分支**
// （pointerType==='touch' → _onTouchStart，单指 ROTATE、双指 DOLLY_PAN），
// 与鼠标路径不同；而 Playwright 的 page.touchscreen 只有 tap()，**没有拖拽/捏合助手**。
// 所以必须用 CDP Input.dispatchTouchEvent 合成触摸序列。
//
// 已验证的关键事实（.qiniandian-touch/REPORT.md）：
//  - CDP 触摸确实以 pointerType==='touch' 的 PointerEvent 送达 canvas，走 _onTouchStart
//  - 单指拖拽 = 纯旋转（dDist 不变）；双指捏合 = dolly+pan（不是纯 zoom）
//  - enableDamping 会让相机在 touchEnd 后继续滑行数秒 ⇒ 必须**poll 直到静止**再断言
//  - 控制变量法：**不能用 ?controls=0**（那种页面没有 touch-action:none，
//    原生手势会把页面导航到 about:blank，于是"没变化"是在测一张白屏）。
//    正确做法：controls=1 且把 __OC__.enabled 设为 false。
//
// 用法：node scripts/verify-touch.mjs <baseUrl>
import { chromium } from 'playwright';

const baseUrl = process.argv[2];
if (!baseUrl) { console.error('usage: node verify-touch.mjs <baseUrl>'); process.exit(2); }

// 阈值依据（来自探针实测）：静置时像素差恒为 0；
// 真实拖拽 pctGt32 ≥ 23%（鼠标）/ 87%（触摸）。取 5% 作阈值 ——
// 比噪声高约两个数量级，又远低于最弱真实信号。
const PIXEL_THRESHOLD = 5.0;   // % of pixels with channel delta > 32
const ROTATE_MIN_POS_DELTA = 10;   // metres of camera position change
const DOLLY_EPS = 0.01;            // |Δdistance| below this counts as "no dolly"

const failures = [];
const results = [];
const browser = await chromium.launch({ channel: 'msedge', headless: true });

/** 等相机静止（damping 滑行结束后再做断言，否则必然 flaky）。 */
async function waitUntilQuiet(page, quietMs = 500, timeoutMs = 15000) {
  const t0 = Date.now();
  let last = null, lastChange = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const cur = await page.evaluate(() => {
      const oc = window.__OC__;
      const p = oc.object.position;
      return [p.x, p.y, p.z, oc.object.position.distanceTo(oc.target)];
    });
    const s = JSON.stringify(cur);
    if (s !== last) { last = s; lastChange = Date.now(); }
    else if (Date.now() - lastChange >= quietMs) return cur;
    await page.waitForTimeout(80);
  }
  return last;
}

/** 读取相机状态（位置 + 到 target 的距离）。 */
const readCam = (page) => page.evaluate(() => {
  const oc = window.__OC__;
  const p = oc.object.position;
  return { pos: [p.x, p.y, p.z], dist: p.distanceTo(oc.target) };
});

/** 合成一次 CDP 触摸手势。points 为若干帧，每帧是 [[x,y], ...] 触点数组。 */
async function touchGesture(cdp, frames) {
  for (let i = 0; i < frames.length; i++) {
    const touchPoints = frames[i].map(([x, y], id) => ({ x, y, id, radiusX: 12, radiusY: 12 }));
    const type = i === 0 ? 'touchStart' : 'touchMove';
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    await new Promise((r) => setTimeout(r, 16));
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** 两帧像素差异（用页面内 canvas 取样，避免额外依赖）。 */
async function pixelDiffPct(page, before) {
  return page.evaluate((beforeB64) => {
    const c = document.querySelector('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    const w = c.width, h = c.height;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // 抽样（每 37 个像素取一个）以控制开销；真实变化面积很大，抽样足够
    let n = 0, diff = 0;
    const step = 37 * 4;
    for (let i = 0; i + 3 < buf.length; i += step) {
      n++;
      const a = buf[i], b = buf[i + 1], cc = buf[i + 2];
      const j = i;
      const pa = beforeB64[j], pb = beforeB64[j + 1], pc = beforeB64[j + 2];
      if (Math.abs(a - pa) > 32 || Math.abs(b - pb) > 32 || Math.abs(cc - pc) > 32) diff++;
    }
    return n ? (diff / n) * 100 : 0;
  }, before);
}

/** 取当前帧的抽样像素。 */
const samplePixels = (page) => page.evaluate(() => {
  const c = document.querySelector('canvas');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  const w = c.width, h = c.height;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return Array.from(buf);
});

try {
  // 移动端上下文：hasTouch 是触摸 API 的硬前提（探针实测过抛错）
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));

  async function freshPage(extra = '') {
    await page.goto(`${baseUrl}?controls=1&hud=0${extra}`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.__SCENE__ !== undefined && window.__OC__, null, { timeout: 30000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }

  // ---- 断言 1: canvas 的 touch-action 必须是 none ----
  // 这一条单独重要：若为 auto，移动端原生手势会把页面导航走（探针实测到 about:blank），
  // 于是后续所有"触摸没改变画面"的断言都会在测一张白屏而假通过。
  await freshPage();
  const touchAction = await page.evaluate(() => getComputedStyle(document.querySelector('canvas')).touchAction);
  const taOk = touchAction === 'none';
  if (!taOk) failures.push('touch-action on canvas is not none');
  results.push({ check: 'canvas_touch_action_none', touchAction, ok: taOk });

  // ---- 断言 2: touchscreen.tap 不抛错（证明触摸确实接通）----
  let tapThrew = null;
  try { await page.touchscreen.tap(195, 420); } catch (e) { tapThrew = String(e.message ?? e); }
  const tapOk = tapThrew === null;
  if (!tapOk) failures.push('touchscreen.tap threw: ' + tapThrew);
  results.push({ check: 'touchscreen_tap_ok', threw: tapThrew, ok: tapOk });

  // ---- 断言 3: CDP 单指拖拽 => 纯旋转 ----
  await freshPage();
  const cdp = await ctx.newCDPSession(page);
  const before1 = await readCam(page);
  const px1 = await samplePixels(page);
  const frames1 = [];
  for (let i = 0; i <= 14; i++) {
    frames1.push([[195 - i * 4, 500 + i * 8]]);
  }
  await touchGesture(cdp, frames1);
  await waitUntilQuiet(page);
  const after1 = await readCam(page);
  const dPos1 = Math.hypot(...after1.pos.map((v, i) => v - before1.pos[i]));
  const dDist1 = Math.abs(after1.dist - before1.dist);
  const pct1 = await pixelDiffPct(page, px1);
  const rotateOk = dPos1 > ROTATE_MIN_POS_DELTA && dDist1 < DOLLY_EPS;
  if (!rotateOk) failures.push(`CDP single-finger drag did not rotate (dPos=${dPos1.toFixed(2)}, dDist=${dDist1.toFixed(3)})`);
  results.push({
    check: 'cdp_single_finger_drag_rotates',
    dPos: +dPos1.toFixed(3), dDist: +dDist1.toFixed(4), pixelPct: +pct1.toFixed(2),
    ok: rotateOk,
  });

  // ---- 断言 4: CDP 双指捏合 => dolly 改变距离；反向捏合可逆 ----
  await freshPage();
  const cdp2 = await ctx.newCDPSession(page);
  const before2 = await readCam(page);
  // 触点必须**留在视口内**：视口宽 390，中心 x=195。
  // 首版用了 ±204 的偏移（195-204 = -9，已在屏幕外），浏览器直接丢弃了这些触点，
  // 于是"反向捏合"看起来毫无反应 —— 那是脚本 bug，不是被测行为。
  const CX = 195, CY = 420;
  const spread = [];
  for (let i = 0; i <= 12; i++) {
    const d = 40 + i * 3;   // 两指 80px → 116px，逐渐分开（全部留在 [79, 311] 内）
    spread.push([[CX - d, CY], [CX + d, CY]]);
  }
  await touchGesture(cdp2, spread);
  await waitUntilQuiet(page);
  const after2 = await readCam(page);
  const dDist2 = after2.dist - before2.dist;

  // 反向捏合（两指靠拢）应当把距离推回去
  const pinch = [];
  for (let i = 0; i <= 12; i++) {
    const d = 76 - i * 3;   // 116px → 80px，逐渐靠拢
    pinch.push([[CX - d, CY], [CX + d, CY]]);
  }
  await touchGesture(cdp2, pinch);
  await waitUntilQuiet(page);
  const after3 = await readCam(page);
  const dDist3 = after3.dist - after2.dist;

  const pinchOk = Math.abs(dDist2) > 5 && Math.sign(dDist2) !== Math.sign(dDist3) && Math.abs(dDist3) > 5;
  if (!pinchOk) failures.push(`CDP two-finger pinch did not change distance reversibly (d1=${dDist2.toFixed(2)}, d2=${dDist3.toFixed(2)})`);
  results.push({
    check: 'cdp_two_finger_pinch_changes_distance_reversibly',
    dDistAway: +dDist2.toFixed(3), dDistTogether: +dDist3.toFixed(3),
    ok: pinchOk,
  });

  // ---- 断言 5（控制变量法）: 禁用控件后，同一手势必须**不改变**相机 ----
  // 注意：这里**不能**用 ?controls=0。那种页面没有 touch-action:none，
  // 原生手势会把页面导航到 about:blank — 于是"没变化"是在测一张白屏，属于假通过。
  // 正确做法：controls=1（保证 touch-action 与控件存在）但 enabled=false。
  await freshPage();
  await page.evaluate(() => { window.__OC__.enabled = false; });
  const cdp3 = await ctx.newCDPSession(page);
  const before5 = await readCam(page);
  await touchGesture(cdp3, frames1);
  await waitUntilQuiet(page, 400, 6000);
  const after5 = await readCam(page);
  const dPos5 = Math.hypot(...after5.pos.map((v, i) => v - before5.pos[i]));
  const stillHref = await page.evaluate(() => location.href);
  const stillHasCanvas = await page.evaluate(() => !!document.querySelector('canvas'));
  const ctrlOk = dPos5 < 0.01 && stillHasCanvas && !stillHref.startsWith('about:');
  if (!ctrlOk) failures.push(`control (enabled=false) camera moved or page navigated (dPos=${dPos5.toFixed(3)}, href=${stillHref})`);
  results.push({
    check: 'control_disabled_controls_do_not_move',
    dPos: +dPos5.toFixed(4), href: stillHref, canvasPresent: stillHasCanvas, ok: ctrlOk,
  });

  if (pageErrors.length) failures.push('page errors: ' + pageErrors.join(' | '));

  await ctx.close();
} finally {
  await browser.close();
}

console.log(JSON.stringify({ failures, results }, null, 2));
if (failures.length) {
  console.error(`\nTOUCH ASSERTIONS FAILED (${failures.length}):\n  ` + failures.join('\n  '));
  process.exit(1);
}
