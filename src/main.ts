import { buildScene } from './scene.js';

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

async function main() {
  // ?fault=warn 抛一个未捕获页面错误，用于证明 noPageErrors 断言真的会失败。
  if (fault === 'warn') {
    setTimeout(() => { throw new Error('FAULT_INJECTED page error for gate testing'); }, 0);
  }
  const env = await built.loadEnvironment();
  built.render(silhouette);
  // IBL 是"渲染写实"的一半；加载失败必须成为硬失败，而不是静默降级。
  const info = {
    ...built.info,
    assertions: {
      ...(built.info.assertions as Record<string, unknown>),
      envLoadedOk: !env.requested || env.loaded,
    },
  };
  (window as unknown as { __SCENE__: unknown }).__SCENE__ = info;
  const pre = document.createElement('pre');
  pre.id = 'sceneinfo';
  pre.textContent = 'SCENE_JSON=' + JSON.stringify(info);
  pre.style.cssText =
    'position:fixed;left:0;top:0;margin:0;color:#fff;font:11px monospace;z-index:9;opacity:.75';
  document.body.appendChild(pre);
  console.log('SCENE_READY ' + JSON.stringify(info));
}

void main();
