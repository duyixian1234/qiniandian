import { buildScene, pickQualityTier, type QualityTier } from './scene.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ViewHelper } from 'three/addons/helpers/ViewHelper.js';

// 入口：读取查询参数（供确定性截图门禁驱动），装配场景，挂上相机操控与可视化控件。
//
// 参数（默认值）：
//   cam=hero  detail=2  facade=on  envint=0.25  env=on  projection=perspective
//   w / h（**门禁专用**：钉死画布尺寸）。缺省时 sizing='viewport' —— 画布铺满视口。
//   controls=on（?controls=0 关闭相机操控）
//   hud=off（?hud=1 显示左上角 SCENE_JSON）
//   quality=auto|high|medium|low
//   fault=（构造故障，仅用于验证门禁会失败）
//
// 「门禁不创建控件」而不是"禁用控件"：OrbitControls 即使 enabled=false，
// update() 仍会把相机重新 lookAt(target)（源码 L797 无 enabled 检查），
// 所以禁用并不能保证姿态不变 —— 唯一可靠的做法是**根本不构造它**。
const q = new URLSearchParams(location.search);
const silhouette = q.get('silhouette') === '1';
const fault = q.get('fault') ?? '';
// 显式传入 w/h ⇒ 门禁模式（尺寸钉死、DPR 钉 1）；否则铺满视口。
const hasExplicitSize = q.has('w') && q.has('h');
const width = parseInt(q.get('w') ?? '1280', 10);
const height = parseInt(q.get('h') ?? '720', 10);
// 相机操控默认开启（本项目 Q5 要求）；门禁显式传 controls=0。
const wantControls = q.get('controls') !== '0';
const wantHud = q.get('hud') === '1';

// 画质档：auto 时按设备能力启发式选；面板可手动覆盖。
const qualityParam = q.get('quality') ?? 'auto';
const autoTier = pickQualityTier(navigator, window.devicePixelRatio || 1, window.screen?.width ?? 1280);
const quality: QualityTier = qualityParam === 'auto' ? autoTier : (qualityParam as QualityTier);

const built = buildScene({
  cam: q.get('cam') ?? 'hero',
  detail: parseInt(q.get('detail') ?? '2', 10),
  facade: q.get('facade') !== '0',
  envIntensity: parseFloat(q.get('envint') ?? '0.25'),
  useEnv: q.get('env') !== '0',
  // 只有显式给了 w/h 才进入固定尺寸模式（门禁）；否则铺满视口
  width: hasExplicitSize ? width : undefined,
  height: hasExplicitSize ? height : undefined,
  sizing: hasExplicitSize ? 'fixed' : 'viewport',
  quality,
  fault,
  projection: q.get('projection') === 'ortho' ? 'ortho' : 'perspective',
  hdriUrl: fault === 'env'
    ? '/hdri/definitely-missing-' + Date.now() + '.hdr'
    : '/hdri/kloofendal_43d_clear_puresky_2k.hdr',
});

document.body.appendChild(built.renderer.domElement);

const PRESETS: Record<string, string> = {
  Digit1: 'hero', Digit2: 'front', Digit3: 'low', Digit4: 'top', Digit5: 'elev',
};

/** 极简自建控件面板：零依赖、风格统一、可响应式折叠。 */
function buildPanel() {
  const panel = document.createElement('div');
  panel.id = 'panel';
  // 窄屏默认折叠为一个小按钮，避免吃掉本就有限的画面（本项目要求「占满宽度」）
  panel.innerHTML = `
    <button id="panel-toggle" type="button" aria-expanded="false" aria-controls="panel-body">控件</button>
    <div id="panel-body" hidden>
      <div class="row"><span>机位</span>
        <button data-cam="hero">1</button><button data-cam="front">2</button>
        <button data-cam="low">3</button><button data-cam="top">4</button>
        <button data-cam="elev">5</button>
      </div>
      <div class="row"><span>画质</span>
        <button data-q="high">高</button><button data-q="medium">中</button><button data-q="low">低</button>
      </div>
      <div class="row">
        <button id="btn-reset">重置视角 (R)</button>
        <button id="btn-full">全屏 (F)</button>
      </div>
      <div class="row"><label><input id="chk-hud" type="checkbox"> 调试信息</label></div>
      <div class="row hint">拖拽旋转 · 滚轮/双指缩放</div>
    </div>`;
  document.body.appendChild(panel);
  return panel;
}

async function main() {
  // ?fault=warn 抛一个未捕获页面错误，用于证明 noPageErrors 断言真的会失败。
  if (fault === 'warn') {
    setTimeout(() => { throw new Error('FAULT_INJECTED page error for gate testing'); }, 0);
  }
  const env = await built.loadEnvironment();
  built.render(silhouette);

  let controls: OrbitControls | null = null;
  let stopResize: () => void = () => {};
  let viewHelper: ViewHelper | null = null;

  if (wantControls) {
    controls = new OrbitControls(built.camera, built.renderer.domElement);
    controls.enableDamping = true;
    // target 直接取自预设的 look 点 —— 从根上消除"切了机位却被拽回去"这类错配。
    // （此前 main.ts 硬编码 target.set(0,17,0)，而 low 的 look 是 y=22、top 是 y=0。）
    controls.target.copy(built.presetTarget((built.info.cam as string) ?? 'hero'));
    // 相机边界：不钻到地面以下、不过近也不过远（elev 在 300 m 处，故上限要容得下）
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.minDistance = 20;
    controls.maxDistance = 360;
    controls.update();

    const animate = () => {
      requestAnimationFrame(animate);
      controls!.update();
      built.renderer.render(built.scene, built.camera);
      // ViewHelper 是 3D 方位指示器（立方体 + 轴标签），必须在主场景渲染之后
      // 渲染到自己的视口 —— 它会接管 renderer.setViewport，故不能与剪影模式混用。
      if (viewHelper && !silhouette) {
        built.renderer.autoClear = false;
        viewHelper.render(built.renderer);
        built.renderer.autoClear = true;
      }
    };
    animate();

    // 相机操控可视化：ViewHelper（three 0.186.1 自带，constructor(camera, domElement)）
    viewHelper = new ViewHelper(built.camera, built.renderer.domElement);
    viewHelper.setLabels('右', '上', '前');

    // 显式暴露控件实例，供触摸验证脚本读取**精确**的相机数值。
    // 探针曾用 patch Function.prototype.bind 的 hack 拿到它；我们既然能改源码，
    // 就直接显式暴露 —— 更干净，也不依赖压缩后的内部实现。
    (window as unknown as { __OC__?: unknown }).__OC__ = controls;

    stopResize = built.observeResize();

    const applyQuality = (t: QualityTier) => {
      // 画质切换：只改 DPR 上限与阴影贴图，不重建几何（避免切档时卡顿与状态丢失）
      const cap = t === 'high' ? 2 : t === 'medium' ? 1.5 : 1;
      built.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
      built.renderer.shadowMap.needsUpdate = true;
      (built.info as Record<string, unknown>).quality = t;
    };

    const panel = buildPanel();

    const applyPreset = (which: string) => {
      built.setCamera(which);
      // 切机位时同步 target，否则控件会把相机重新瞄回旧注视点
      controls!.target.copy(built.presetTarget(which));
      controls!.update();
    };

    panel.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach((b) => {
      b.addEventListener('click', () => applyPreset(b.dataset.cam!));
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-q]').forEach((b) => {
      b.addEventListener('click', () => applyQuality(b.dataset.q as QualityTier));
    });
    panel.querySelector('#btn-reset')?.addEventListener('click', () => applyPreset('hero'));
    panel.querySelector('#btn-full')?.addEventListener('click', () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
    });
    const toggle = panel.querySelector<HTMLButtonElement>('#panel-toggle')!;
    const body = panel.querySelector<HTMLDivElement>('#panel-body')!;
    toggle.addEventListener('click', () => {
      const open = body.hidden;
      body.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    });
    // 宽屏默认展开，窄屏默认折叠（按可用宽度而非 UA）
    if (window.innerWidth >= 720) {
      body.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
    }

    addEventListener('keydown', (e) => {
      if (e.code === 'KeyR') { applyPreset('hero'); return; }
      if (e.code === 'KeyF') {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen();
        return;
      }
      if (e.code === 'KeyG') { toggle.click(); return; }
      const which = PRESETS[e.code];
      if (which) applyPreset(which);
    });
  } else {
    // 门禁路径：不构造任何控件，也不挂 resize（尺寸由 w/h 钉死）
    stopResize = () => {};
  }

  // HUD 默认**隐藏**（?hud=1 才显示）。它是一行 ~1100 字符的 JSON，
  // 在 390px 视口上渲染宽 6701px，既遮挡观感又与面板叠层。
  // 门禁不依赖它（capture.mjs 用 page.evaluate 读 window.__SCENE__）。
  //
  // 注意顺序：`info` 是**唯一**的报告对象，setHud 直接写它的字段。
  // 首版是 `const info = {...built.info}` 之后再 `setHud()` 写 `built.info.hudVisible`，
  // 于是字段写进了另一份对象、永远到不了 __SCENE__ ⇒ hudHidden 断言全部失败
  // （这正是"字段存在但永远读不到"的又一类静默 bug，由门禁实测发现）。
  const info: Record<string, unknown> = {
    ...built.info,
    controls: wantControls,
    hudVisible: wantHud,
    assertions: {
      ...(built.info.assertions as Record<string, unknown>),
      envLoadedOk: !env.requested || env.loaded,
    },
  };

  let hudEl: HTMLPreElement | null = null;
  const setHud = (on: boolean) => {
    info.hudVisible = on;
    if (on && !hudEl) {
      hudEl = document.createElement('pre');
      hudEl.id = 'sceneinfo';
      hudEl.style.cssText =
        'position:fixed;left:0;bottom:0;margin:0;color:#fff;font:11px monospace;z-index:9;opacity:.75;'
        + 'max-width:100%;white-space:pre-wrap;word-break:break-all;pointer-events:none';
      document.body.appendChild(hudEl);
    }
    if (hudEl) {
      hudEl.textContent = 'SCENE_JSON=' + JSON.stringify(info);
      hudEl.hidden = !on;
    }
  };

  (window as unknown as { __SCENE__: unknown }).__SCENE__ = info;
  setHud(wantHud);
  const chk = document.querySelector<HTMLInputElement>('#chk-hud');
  if (chk) {
    chk.checked = wantHud;
    chk.addEventListener('change', () => setHud(chk.checked));
  }
  console.log('SCENE_READY ' + JSON.stringify(info));
  void stopResize;
}

void main();
