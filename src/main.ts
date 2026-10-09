import { buildScene } from './scene.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// 入口：读取查询参数（供确定性截图门禁驱动），装配场景，把机器可读报告挂到 window。
// 参数：cam / detail / facade / envint / env / silhouette / w / h
const q = new URLSearchParams(location.search);
const width = parseInt(q.get('w') ?? '1280', 10);
const height = parseInt(q.get('h') ?? '720', 10);
const silhouette = q.get('silhouette') === '1';
// 故障注入，用于"测试这个测试"：证明截图门禁真的会失败。
// 明确是**构造故障**，不是产品缺陷，也不用于交付渲染。
//   env  → 指向不存在的 HDRI（应触发 envLoadedOk + noFailedResources 失败）
//   warn → 抛页面错误（应触发 noPageErrors 失败）
//   gap  → 把宝顶抬离屋面（应触发 segmentsClosedOk / totalHeightOk 失败）
const fault = q.get('fault') ?? '';

const built = buildScene({
  cam: q.get('cam') ?? 'hero',
  detail: parseInt(q.get('detail') ?? '2', 10),
  facade: q.get('facade') !== '0',
  envIntensity: parseFloat(q.get('envint') ?? '0.25'),
  useEnv: q.get('env') !== '0',
  width,
  height,
  fault,
  projection: q.get('projection') === 'ortho' ? 'ortho' : 'perspective',
  hdriUrl: fault === 'env'
    ? '/hdri/definitely-missing-' + Date.now() + '.hdr'
    : '/hdri/kloofendal_43d_clear_puresky_2k.hdr',
});

document.body.appendChild(built.renderer.domElement);

// 交互（SPEC Q17）：OrbitControls + 预设机位热键。
// 用 ?interactive=1 开启 —— 截图门禁不开启，以免相机被用户操作改变而破坏确定性。
const interactive = q.get('interactive') === '1';
const PRESET_KEYS: Record<string, string> = {
  Digit1: 'hero', Digit2: 'front', Digit3: 'low', Digit4: 'top', Digit5: 'elev',
};

async function main() {
  // ?fault=warn 抛一个未捕获页面错误，用于证明 noPageErrors 断言真的会失败。
  if (fault === 'warn') {
    setTimeout(() => { throw new Error('FAULT_INJECTED page error for gate testing'); }, 0);
  }
  const env = await built.loadEnvironment();
  built.render(silhouette);

  if (interactive) {
    const controls = new OrbitControls(built.camera, built.renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 17, 0);
    const animate = () => {
      requestAnimationFrame(animate);
      controls.update();
      built.renderer.render(built.scene, built.camera);
    };
    animate();
    // 预设机位热键：1–5 切到 hero/front/low/top/elev
    addEventListener('keydown', (e) => {
      const which = PRESET_KEYS[e.code];
      if (!which) return;
      built.setCamera(which);
      controls.target.set(0, which === 'elev' ? 18.4 : 17, 0);
      controls.update();
    });
    const hint = document.createElement('div');
    hint.textContent = '拖拽旋转 · 滚轮缩放 · 1 hero / 2 front / 3 low / 4 top / 5 elev';
    hint.style.cssText =
      'position:fixed;left:8px;bottom:8px;color:#fff;font:12px monospace;background:#0008;padding:4px 8px;border-radius:4px;z-index:10';
    document.body.appendChild(hint);
  }

  // IBL 是"渲染写实"的一半；加载失败必须成为硬失败，而不是静默降级。
  const info = {
    ...built.info,
    assertions: {
      ...(built.info.assertions as Record<string, unknown>),
      envLoadedOk: !env.requested || env.loaded,
    },
  };
  (window as unknown as { __SCENE__: unknown }).__SCENE__ = info;
  // 供截图门禁读取的机器可读输出。
  // 注意：它是贴在画面左上角的 <pre>，会在截图里可见 —— 这是刻意保留的（便于人工核对
  // 每张图对应的参数与断言值）。若将来要出"干净成片"，应改成 `?hud=0` 控制显隐。
  if (q.get('hud') !== '0') {
    const pre = document.createElement('pre');
    pre.id = 'sceneinfo';
    pre.textContent = 'SCENE_JSON=' + JSON.stringify(info);
    pre.style.cssText =
      'position:fixed;left:0;top:0;margin:0;color:#fff;font:11px monospace;z-index:9;opacity:.75';
    document.body.appendChild(pre);
  }
  console.log('SCENE_READY ' + JSON.stringify(info));
}

void main();
