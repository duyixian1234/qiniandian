// 证明 contentOverride 的修复是真的：**resize 与切机位之后**取景仍用实测尺寸（97.7 m），
// 而不是退回考据常量 90.3 m（那会把台阶切出画面）。
//
// 为什么必须专门测这条：审查发现初版只在初始构建时传入实测尺寸，
// 而 applyViewportSize / setCamera 漏传 —— 两次操作后取景就退化了。
// 这类"初始正确、后续退化"的 bug 在单次截图中完全看不出来。
//
// 用法：node scripts/verify-reframe.mjs <baseUrl>
import { chromium } from 'playwright';

const baseUrl = process.argv[2];
if (!baseUrl) { console.error('usage: node verify-reframe.mjs <baseUrl>'); process.exit(2); }

const HALL_BODY = 32.72;
const failures = [];
const results = [];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  // 视口模式 + 开启控件（只有这样 resize 与切机位才有效）
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

  await page.goto(`${baseUrl}?hud=0`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__SCENE__ !== undefined && window.__OC__, null, { timeout: 30000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  const readFraming = () => page.evaluate(() => {
    const s = window.__SCENE__;
    return { framing: s.framing, viewport: s.viewport, cam: s.cam };
  });

  // 断言 1: 初始构建即用实测尺寸
  const initial = await readFraming();
  const ok1 = initial.framing.measuredContentSize?.[0] > 90.3
    && initial.framing.visibleWidth >= initial.framing.measuredContentSize[0] - 0.5;
  if (!ok1) failures.push(`initial framing did not use measured size: visibleWidth=${initial.framing.visibleWidth}`);
  results.push({ check: 'initial_uses_measured_size', visibleWidth: initial.framing.visibleWidth, ok: ok1 });

  // 断言 2: resize 之后仍用实测尺寸（宽度收紧到 900）
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(600);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const afterResize = await readFraming();
  const ok2 = afterResize.framing.measuredContentSize?.[0] > 90.3
    && afterResize.framing.visibleWidth >= afterResize.framing.measuredContentSize[0] - 0.5;
  if (!ok2) failures.push(`after RESIZE framing regressed: visibleWidth=${afterResize.framing.visibleWidth}`);
  results.push({
    check: 'after_resize_keeps_measured_size',
    viewport: afterResize.viewport,
    visibleWidth: afterResize.framing.visibleWidth,
    ok: ok2,
  });

  // 断言 3: 切机位之后仍用实测尺寸（用键盘切到 low）
  await page.keyboard.press('Digit3');
  await page.waitForTimeout(600);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const afterCam = await readFraming();
  const ok3 = afterCam.framing.measuredContentSize?.[0] > 90.3
    && afterCam.framing.visibleWidth >= afterCam.framing.measuredContentSize[0] - 0.5
    && afterCam.cam === 'low';
  if (!ok3) failures.push(`after CAMERA SWITCH framing regressed: cam=${afterCam.cam} visibleWidth=${afterCam.framing.visibleWidth}`);
  results.push({
    check: 'after_camera_switch_keeps_measured_size',
    cam: afterCam.cam,
    visibleWidth: afterCam.framing.visibleWidth,
    ok: ok3,
  });

  // 断言 4: 任何情况下可见宽度都不得切到大殿本体
  for (const [label, st] of [['initial', initial], ['resize', afterResize], ['camswitch', afterCam]]) {
    const ok = st.framing.visibleWidth >= HALL_BODY;
    if (!ok) failures.push(`${label}: visibleWidth ${st.framing.visibleWidth} crops hall body`);
  }
  results.push({ check: 'hall_body_never_cropped_in_all_three_states', ok: failures.length === 0 });

  // 断言 5: 非法 quality 不得让页面崩溃（审查发现 ?quality=x 会抛 TypeError）
  const p2 = await ctx.newPage();
  const qErrs = [];
  p2.on('pageerror', (e) => qErrs.push('pageerror: ' + e.message));
  await p2.goto(`${baseUrl}?hud=0&quality=bogus`, { waitUntil: 'load', timeout: 30000 });
  let qOk = false;
  try {
    await p2.waitForFunction(() => window.__SCENE__ !== undefined, null, { timeout: 15000 });
    const s = await p2.evaluate(() => window.__SCENE__);
    qOk = qErrs.length === 0 && ['high', 'medium', 'low'].includes(s.quality);
  } catch { qOk = false; }
  if (!qOk) failures.push(`?quality=bogus crashed or produced invalid tier: ${qErrs.join(' | ')}`);
  results.push({ check: 'invalid_quality_falls_back_without_crash', errors: qErrs, ok: qOk });

  if (errs.length) failures.push('page errors: ' + errs.join(' | '));
  await ctx.close();
} finally {
  await browser.close();
}

console.log(JSON.stringify({ failures, results }, null, 2));
if (failures.length) {
  console.error(`\nREFRAME ASSERTIONS FAILED (${failures.length}):\n  ` + failures.join('\n  '));
  process.exit(1);
}
