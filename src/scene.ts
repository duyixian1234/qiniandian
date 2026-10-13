import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { latticeTexture, caihuaTexture } from './facadeTextures.js';
import { SOURCED, planSegmentStack, eaveRadii, assertSourcedCounts, stairwayLayout } from './massing.js';
import { FRAMING, cameraDistanceForViewport, framingFractions, type FramingOverrides } from './framing.js';

// 祈年殿场景装配。所有**尺寸**来自 src/massing.ts（已由 tests/massing.test.ts 覆盖）；
// 本文件只负责"把形制变成 three.js 物体"，不重新定义任何考据尺寸。
// 例外并已显式标注：宝顶的**零件分段**（莲花座/宝珠/尖锥）与各材质的**颜色/粗糙度**
// 属外观参数，不属形制尺寸，故在本文件内设定（宝顶总高仍取 SOURCED.finialHeight）。
//
// 关键结构事实（实测确认，见 ../.probe/FACTS.md）：祈年殿是 **墙→檐→墙→檐→墙→檐 交替**，
// 不是"檐叠檐"。按檐叠檐做会出现三重檐漂浮分离的假象。

export interface SceneOptions {
  cam?: string;
  detail?: number;
  facade?: boolean;
  envIntensity?: number;
  width?: number;
  height?: number;
  useEnv?: boolean;
  /** 故障注入（构造故障，仅用于验证门禁会失败）：'' | 'gap' | 'warn' | 'env' */
  fault?: string;
  /** HDRI 地址；fault='env' 时指向不存在的文件 */
  hdriUrl?: string;
  /** 'ortho' 用正交投影：屏幕距离与真实距离成正比，用于量测（无透视畸变） */
  projection?: 'perspective' | 'ortho';
  /**
   * 画布尺寸策略：
   *  - 'fixed'（默认，门禁用）：严格用 width×height，DPR 钉 1 —— 保证截图跨机器字节一致
   *  - 'viewport'：铺满视口 + 监听 resize + DPR min(dpr,2) —— 人看的形态
   */
  sizing?: 'fixed' | 'viewport';
  /** 画质档：影响 DPR 上限与阴影贴图尺寸。门禁一律 'high'。 */
  quality?: QualityTier;
}

/** 画质档位。门禁固定跑 'high'，以免截图基线随设备变化。 */
export type QualityTier = 'high' | 'medium' | 'low';

export interface QualitySettings {
  tier: QualityTier;
  /** DPR 上限 */
  maxPixelRatio: number;
  /** 阴影贴图边长 */
  shadowMapSize: number;
  /** 是否建瓦垄（detail>=1 时才生效） */
  tileRidges: boolean;
}

export const QUALITY: Record<QualityTier, QualitySettings> = {
  high: { tier: 'high', maxPixelRatio: 2, shadowMapSize: 2048, tileRidges: true },
  medium: { tier: 'medium', maxPixelRatio: 1.5, shadowMapSize: 1024, tileRidges: true },
  low: { tier: 'low', maxPixelRatio: 1, shadowMapSize: 512, tileRidges: false },
};

/**
 * 按设备能力启发式选档。**一定会猜错某些设备**，故面板必须能手动覆盖（见 SPEC Q19）。
 * 判据：DPR × 屏幕宽度 × 硬件并发数 —— 三个都可从浏览器直接读到，无需 UA 嗅探。
 */
export function pickQualityTier(nav?: { hardwareConcurrency?: number }, dpr = 1, screenW = 1280): QualityTier {
  const cores = nav?.hardwareConcurrency ?? 4;
  const load = dpr * screenW * cores;
  if (load >= 16000) return 'high';
  if (load >= 6000) return 'medium';
  return 'low';
}

export interface EnvInfo {
  /** 是否请求了 IBL。请求了就必须加载成功，否则门禁判失败。 */
  requested: boolean;
  loaded: boolean;
  error: string | null;
  pmrem: boolean;
}

/**
 * 机位表（固定，保证截图可复现）。
 *
 * `framing` 决定**距离**从哪来：
 *  - `'rule'`（默认）：距离由 Q30 取景规则算出 —— 让建筑"占满宽度"且不切掉大殿本体。
 *    注意预设的 pos 只用来定**方向**，其长度会被规则距离取代，否则 hero 的 96.4 m
 *    会让台基只占屏宽 68%，违背"内容占满宽度"。
 *  - `'preset'`：保留预设自身距离。仅 `top` 用它 —— 俯视是平面图，
 *    其屏幕竖直方向的真实跨度是**台基进深 90.3 m**而非通高 36.8 m，
 *    因此取景规则的前提（竖直跨度 = buildingHeight）不成立，套用会算错。
 */
const CAMS: Record<
  string,
  { pos: [number, number, number]; look: [number, number, number]; framing?: 'rule' | 'preset' }
> = {
  hero: { pos: [0, 26, 96], look: [0, 17, 0] },
  front: { pos: [0, 17, 118], look: [0, 17, 0] },
  low: { pos: [0, 3.2, 82], look: [0, 22, 0] },
  top: { pos: [0, 150, 0.01], look: [0, 0, 0], framing: 'preset' },
  elev: { pos: [0, 18.4, 300], look: [0, 18.4, 0] },
};

/** 取景规则是否适用于该机位（`top` 是平面图，不适用）。供测试与门禁断言使用。 */
export function usesFramingRule(cam: string): boolean {
  return (CAMS[cam] ?? CAMS.hero).framing !== 'preset';
}

/**
 * 求某机位在某视口下的相机距离（把"方向来自预设、距离来自规则"这条策略集中在一处）。
 * @param over 内容的**实测**尺寸。不传则用考据常量（台基直径 / 通高）。
 */
export function distanceForCam(
  cam: string,
  vp: { width: number; height: number },
  over: FramingOverrides = {},
): number {
  const preset = CAMS[cam] ?? CAMS.hero;
  const presetDist = new THREE.Vector3(...preset.pos)
    .sub(new THREE.Vector3(...preset.look)).length();
  return usesFramingRule(cam) ? cameraDistanceForViewport(vp, FRAMING.fovYDeg, over) : presetDist;
}

/** 统计几何的三角形数（index 存在时按 index 计）。 */
function countTriangles(g: THREE.BufferGeometry): number {
  return g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
}

/** 凹曲屋面剖面：脊部陡、檐口缓、檐端微翘——祈年殿的标志性轮廓。
 *  t 的取值区间由 t0/t1 限定：瓦垄用 t0>0 在檐口前收齐，避免盒体厚度越出檐边。 */
export function roofProfile(
  rEave: number, rRidge: number, h: number, upturn: number, N = 28, t0 = 0, t1 = 1,
): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= N; i++) {
    const t = t0 + (t1 - t0) * (i / N);                 // 0 在檐口，1 在脊部
    const r = rEave + (rRidge - rEave) * Math.pow(t, 0.72);
    const yy = h * (1 - Math.pow(1 - t, 1.6)) + upturn * Math.pow(1 - t, 3.4);
    pts.push(new THREE.Vector2(Math.max(r, 0.01), yy));
  }
  return pts;
}

/** 求半径 r 处的剖面参数 t。注意 rRidge < rEave（屋面向上收窄），故分母为负：
 *  传入比 rEave **小** 的半径才得到 t>0。传入 rEave+inset 会得到负分数并被钳为 0，
 *  使 inset 静默失效——该符号错误曾让瓦垄收齐功能完全无效（两张 A/B 图字节相同）。 */
export function tAtRadius(rEave: number, rRidge: number, r: number): number {
  const f = (r - rEave) / (rRidge - rEave);
  return f <= 0 ? 0 : Math.pow(f, 1 / 0.72);
}

/** 瓦垄：沿屋面剖面铺设的条状脊，间距约 0.9 m。这是侧光下条状高光的来源。 */
export function tileRidgeGeometry(
  rEave: number, rRidge: number, h: number, upturn: number, spacing = 0.9, inset = 0.6,
): THREE.BufferGeometry {
  const prof = roofProfile(rEave, rRidge, h, upturn, 18, tAtRadius(rEave, rRidge, rEave - inset), 1);
  const count = Math.max(24, Math.round((2 * Math.PI * rEave) / spacing));
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    for (let k = 0; k < prof.length - 1; k++) {
      const p0 = prof[k], p1 = prof[k + 1];
      const dr = p1.x - p0.x, dy = p1.y - p0.y;
      const len = Math.hypot(dr, dy);
      if (len < 1e-6) continue;
      const box = new THREE.BoxGeometry(0.24, 0.17, len);
      const mid = (p0.x + p1.x) / 2;
      const slope = Math.atan2(dy, dr);
      box.applyMatrix4(new THREE.Matrix4().makeRotationY(-a)
        .multiply(new THREE.Matrix4().makeTranslation(0, (p0.y + p1.y) / 2, -mid))
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2 - slope)));
      parts.push(box);
    }
  }
  return mergeGeometries(parts, false)!;
}

export interface BuiltScene {
  scene: THREE.Scene;
  camera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
  info: Record<string, unknown>;
  loadEnvironment: () => Promise<EnvInfo>;
  render: (silhouette?: boolean) => void;
  /** 把相机切到预设机位（交互热键与截图门禁共用同一组机位定义）。 */
  setCamera: (which: string) => void;
  /** 预设机位的注视点，供 OrbitControls.target 对齐。 */
  presetTarget: (which: string) => THREE.Vector3;
  /** 挂上视口变化监听；返回卸载函数。门禁模式（sizing='fixed'）返回空操作。 */
  observeResize: () => () => void;
}

export function buildScene(opts: SceneOptions = {}): BuiltScene {
  const camName = opts.cam ?? 'hero';
  const detail = opts.detail ?? 2;
  const facadeOn = opts.facade !== false;
  const envIntensity = opts.envIntensity ?? 0.25;
  const useEnv = opts.useEnv ?? true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fb0d2);

  const sizing = opts.sizing ?? 'fixed';
  const quality = QUALITY[opts.quality ?? 'high'];

  // 视口尺寸解析：
  //  - 'fixed'（门禁）：严格用传入的 width/height，DPR 钉 1（截图跨机器字节一致）
  //  - 'viewport'（人看）：铺满视口；显式传入 w/h 时仍以传入为准（门禁要钉死截图尺寸）
  const resolveSize = (): { w: number; h: number } => {
    if (opts.width && opts.height) return { w: opts.width, h: opts.height };
    if (sizing === 'viewport') {
      return {
        w: Math.max(1, Math.floor(window.innerWidth)),
        h: Math.max(1, Math.floor(window.innerHeight)),
      };
    }
    return { w: opts.width ?? 1280, h: opts.height ?? 720 };
  };
  const size0 = resolveSize();

  let camera: THREE.Camera;
  if (opts.projection === 'ortho') {
    // 正交水平机位：无透视畸变，屏幕上的宽度与真实距离成正比 —— 量测轮廓比例必须用这个。
    // 用俯视图量测檐口出挑比是错的：俯视每一行的宽度都是台基直径（实测得到 1:1:1）。
    //
    // **量测机位豁免自动取景**：正交半宽固定 52 m，不随窗口比例变化。
    // 否则"出挑比"会随视口漂移 —— 形制优先的项目里，取景不应改变可量测的比例。
    const halfW = 52;
    const halfH = halfW * (size0.h / size0.w);
    const oc = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.5, 4000);
    oc.position.set(0, 18.4, 300);
    oc.lookAt(new THREE.Vector3(0, 18.4, 0));
    oc.updateProjectionMatrix();
    camera = oc;
  } else {
    const pc = new THREE.PerspectiveCamera(FRAMING.fovYDeg, size0.w / size0.h, 0.5, 4000);
    // 观察**方向**取自机位预设，**距离**由 distanceForCam 决定（见上方 CAMS 注释）。
    const preset = CAMS[camName] ?? CAMS.hero;
    const target = new THREE.Vector3(...preset.look);
    const dir = new THREE.Vector3(...preset.pos).sub(target);
    dir.setLength(distanceForCam(camName, { width: size0.w, height: size0.h }));
    pc.position.copy(target).add(dir);
    pc.lookAt(target);
    camera = pc;
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  // DPR：门禁钉 1（保证跨机器字节一致）；viewport 模式用 min(dpr, 画质档上限)——
  // 1x 与 2x 清晰度差异肉眼可辨，2x→3x 几乎看不出但填充率差 2.25 倍。
  const desiredDpr = sizing === 'viewport'
    ? Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio)
    : 1;
  renderer.setPixelRatio(desiredDpr);
  renderer.setSize(size0.w, size0.h);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // ---- materials ---------------------------------------------------------------------
  // 蓝釉底色来自故宫实测 Lab(28.26, 5.87, −18.99) → #3b4160（换算已往返校验）。
  // 注意：Lab 用作**复测目标**校准光照强度，而不是直接把测量值当反射率。
  const glazeBlue = new THREE.MeshPhysicalMaterial({
    color: 0x3b4160, roughness: 0.22, metalness: 0.0,
    clearcoat: 1.0, clearcoatRoughness: 0.08,
    envMapIntensity: 1.0, side: THREE.DoubleSide,
  });
  const marble = new THREE.MeshStandardMaterial({ color: 0xd9d6cd, roughness: 0.6 });
  const marbleBalustrade = new THREE.MeshStandardMaterial({ color: 0xe2dfd7, roughness: 0.52 });
  const columnRed = new THREE.MeshStandardMaterial({ color: 0x8f3226, roughness: 0.45 });
  const panelRed = new THREE.MeshStandardMaterial({ color: 0x7e2a1f, roughness: 0.55 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xc9a12b, roughness: 0.2, metalness: 1.0 });
  const dougongRed = new THREE.MeshStandardMaterial({ color: 0x7a2b20, roughness: 0.6 });

  const latticeMat = facadeOn
    ? new THREE.MeshStandardMaterial({ map: latticeTexture(12, 6), roughness: 0.62 })
    : panelRed;
  const caihuaMat = facadeOn
    ? new THREE.MeshStandardMaterial({ map: caihuaTexture(24), roughness: 0.5 })
    : panelRed;

  // ---- terrace：三层，**总高** 5.2 m（考据值）；直径 90.3 / 79.3 / 68.2（考据值） --------
  // ⚠️ 逐层高度按 5.2 / 3 **均分**，这一步是**构造量**，不是考据值：
  // 来源只给出总高 5.2 m，没有任何来源给出三层各自的高度
  // （已对《北京文博》2000 全文与官方页做过检索确认，见 ../.probe/FACTS.md 9.15.4）。
  const terraceD = [...SOURCED.terraceDiameters];       // 下→上
  const tierH = SOURCED.terraceHeight / SOURCED.terraceTiers;
  const stairLayout = stairwayLayout();
  const bearingOf = (face: string) =>
    face === 'south' ? Math.PI / 2 : face === 'north' ? -Math.PI / 2 : face === 'east' ? 0 : Math.PI;

  let y = 0;
  for (let i = 0; i < SOURCED.terraceTiers; i++) {
    const r = terraceD[i] / 2;
    const tier = new THREE.Mesh(new THREE.CylinderGeometry(r, r, tierH, 128), marble);
    tier.position.y = y + tierH / 2;
    tier.receiveShadow = true; tier.castShadow = true;
    scene.add(tier);

    // 每一层都有 8 处台阶（「三层坛体各出八陛」）→ 共 24 处。
    // 早先版本用 `if (i > 0)` 跳过最低层，只建了 16 处（自审发现）。
    for (const s of stairLayout) {
      const bearing = bearingOf(s.face);
      const outward = r + 1.6;
      const flight = new THREE.Mesh(new THREE.BoxGeometry(4.2, tierH, 3.2), marble);
      flight.position.set(
        Math.cos(bearing) * outward - Math.sin(bearing) * s.offset,
        y + tierH / 2,
        Math.sin(bearing) * outward + Math.cos(bearing) * s.offset,
      );
      flight.rotation.y = -bearing;
      flight.castShadow = true; flight.receiveShadow = true;
      flight.userData.formTag = 'stair';
      scene.add(flight);
    }
    addBalustrade(scene, r - 0.55, y + tierH, marbleBalustrade);
    y += tierH;
  }

  // ---- 殿堂本体：由 massing 的闭合分段驱动 ------------------------------------------------
  const plan = planSegmentStack();
  let wallIndex = 0;
  // ?fault=gap 把宝顶人为抬离屋面，复现 rev3 的"宝顶悬空"缺陷，用于证明闭合断言真的会失败。
  const finialLift = opts.fault === 'gap' ? 2.0 : 0;
  // ?fault=ratio 把中檐半径人为改坏（0.86 → 0.60），用于证明 S9 的出挑比量测
  // 确实测的是渲染结果，而不是在回读常量（同义反复的检查永远不会失败）。
  const ratioFault = opts.fault === 'ratio';

  for (const seg of plan.segments) {
    if (seg.kind === 'wall') {
      const r = seg.wallRadius!;
      const drumMat = facadeOn ? latticeMat : panelRed;
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(r, r, seg.height, 96, 1, false), drumMat);
      drum.position.y = seg.bottom + seg.height / 2;
      drum.castShadow = true; drum.receiveShadow = true;
      scene.add(drum);

      // 内凹墙面，让柱廊有进深而非"画在鼓上"
      const inner = new THREE.Mesh(
        new THREE.CylinderGeometry(r - 1.9, r - 1.9, seg.height * 0.92, 96, 1, true),
        new THREE.MeshStandardMaterial({ color: 0x4a2018, roughness: 0.75, side: THREE.BackSide }),
      );
      inner.position.y = seg.bottom + seg.height / 2;
      scene.add(inner);

      // 彩画带：照片中紧贴每层檐下
      if (facadeOn) {
        const bandH = Math.min(1.15, seg.height * 0.34);
        const band = new THREE.Mesh(
          new THREE.CylinderGeometry(r + 0.30, r + 0.30, bandH, 96, 1, true), caihuaMat,
        );
        band.position.y = seg.bottom + seg.height - bandH / 2 - 0.12;
        band.castShadow = true;
        scene.add(band);
      }

      // 下枋与上枋带
      for (const [yy, hh, rr] of [
        [seg.bottom + 0.28, 0.56, r + 0.15],
        [seg.bottom + seg.height - 0.3, 0.6, r + 0.2],
      ] as const) {
        const band = new THREE.Mesh(new THREE.CylinderGeometry(rr, rr, hh, 96), columnRed);
        band.position.y = yy; band.castShadow = true; scene.add(band);
      }

      // 柱：最下两段各 12 根（檐柱 / 金柱）。考据为 4 龙井 + 12 金 + 12 檐 = 28，
      // 其中 4 根龙井柱在殿内、本模型（外观范围）未建 —— 故实际建 24 根，
      // 报告里 columnsBuilt 与 SOURCED 的 28 是**两个不同的量**，不可互相替代。
      const cols = SOURCED.columnRings[wallIndex === 0 ? 2 : 1];
      if (wallIndex < 2) {
        for (let i = 0; i < cols; i++) {
          const a = (i / cols) * Math.PI * 2 + Math.PI / cols;
          const col = new THREE.Mesh(
            new THREE.CylinderGeometry(0.62, 0.62, seg.height, 20), columnRed,
          );
          col.position.set(Math.cos(a) * r, seg.bottom + seg.height / 2, Math.sin(a) * r);
          col.castShadow = true;
          col.userData.formTag = 'column';
          scene.add(col);
        }
      }
      wallIndex++;
    } else if (seg.kind === 'eave') {
      // fault=ratio 只改渲染几何，不改 massing 的常量：于是"回读常量"的检查仍会通过，
      // 而"量测渲染"的检查会失败 —— 这正是区分两者是否同义反复的判据。
      let rEave = seg.eaveRadius!;
      if (ratioFault && seg.name === 'eave2') rEave = eaveRadii()[2] * 0.60;
      const rRidge = seg.ridgeRadius!;
      const upturn = 0.55;

      const roof = new THREE.Mesh(
        new THREE.LatheGeometry(roofProfile(rEave, rRidge, seg.height, upturn), 128), glazeBlue,
      );
      roof.position.y = seg.bottom;
      roof.castShadow = true; roof.receiveShadow = true;
      roof.userData.formTag = 'eave';
      scene.add(roof);

      const rim = new THREE.Mesh(new THREE.TorusGeometry(rEave, 0.46, 12, 128), glazeBlue);
      rim.rotation.x = Math.PI / 2;
      rim.position.y = seg.bottom + upturn * 0.8;
      rim.castShadow = true;
      scene.add(rim);

      if (detail >= 1 && quality.tileRidges) {
        const ridges = new THREE.Mesh(
          tileRidgeGeometry(rEave, rRidge, seg.height, upturn, 0.9, 0.6), glazeBlue,
        );
        ridges.position.y = seg.bottom;
        ridges.castShadow = true; ridges.receiveShadow = true;
        scene.add(ridges);
      }
      if (detail >= 2) {
        const dg = new THREE.Mesh(dougongGeometry(rEave, 5), dougongRed);
        dg.position.y = seg.bottom - 0.9;
        dg.castShadow = true; dg.receiveShadow = true;
        scene.add(dg);
      }
    } else {
      // 鎏金宝顶：考据通高 4.7 m × 直径 1.9 m；各零件高度之和**严格等于** 4.7
      const fH = seg.height;
      const baseY = seg.bottom + finialLift;
      const lotusH = 0.9, globeH = 1.9;
      const spireH = fH - lotusH - globeH;
      const lotus = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.7, lotusH, 32), gold);
      lotus.position.y = baseY + lotusH / 2;
      lotus.castShadow = true; lotus.userData.formTag = 'finial'; scene.add(lotus);

      const globeR = globeH / 2;
      const globe = new THREE.Mesh(new THREE.SphereGeometry(globeR, 48, 32), gold);
      globe.position.y = baseY + lotusH + globeR;
      globe.scale.set(0.82, 1.0, 0.82);
      globe.castShadow = true; globe.userData.formTag = 'finial'; scene.add(globe);

      const spire = new THREE.Mesh(new THREE.ConeGeometry(0.3, spireH, 24), gold);
      spire.position.y = baseY + lotusH + globeH + spireH / 2;
      spire.castShadow = true; spire.userData.formTag = 'finial'; scene.add(spire);
    }
  }

  // ---- 光照：固定太阳（可复现）+ 可选 IBL -----------------------------------------------
  const sun = new THREE.DirectionalLight(0xfff6e8, 3.4);
  sun.position.set(62, 88, 44);
  sun.castShadow = true;
  sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
  Object.assign(sun.shadow.camera, { near: 10, far: 340, left: -90, right: 90, top: 90, bottom: -90 });
  scene.add(sun);
  // 开 IBL 时必须下调分析式环境光，否则双重计光发白
  scene.add(new THREE.HemisphereLight(0xcfe0f2, 0x6f6355, useEnv ? 0.25 : 1.25));
  const fill = new THREE.DirectionalLight(0xbcd0e8, useEnv ? 0.15 : 0.5);
  fill.position.set(-40, 30, 60);
  scene.add(fill);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(400, 96),
    new THREE.MeshStandardMaterial({ color: 0x8a867c, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  // 标记为地面：建筑本体包围盒与自动取景都要把它排除（半径 400 m 会把建筑缩成一点）
  ground.userData.formTag = 'ground';
  scene.add(ground);

  const envInfo: EnvInfo = { requested: useEnv, loaded: false, error: null, pmrem: false };

  async function loadEnvironment() {
    if (!useEnv) { info.hasEnvironment = false; return envInfo; }
    try {
      // three 0.186.1: RGBELoader 已废弃（仅 extends HDRLoader 并 warn），
      // 且 HDRLoader 只接受 HalfFloatType（默认）或 FloatType。不要调 setDataType。
      const loader = new HDRLoader();
      const tex = await loader.loadAsync(opts.hdriUrl ?? '/hdri/kloofendal_43d_clear_puresky_2k.hdr');
      tex.mapping = THREE.EquirectangularReflectionMapping;
      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      const rt = pmrem.fromEquirectangular(tex);
      scene.environment = rt.texture;
      scene.background = rt.texture;
      scene.environmentIntensity = envIntensity;
      envInfo.loaded = true;
      envInfo.pmrem = true;
      tex.dispose();
      pmrem.dispose();
    } catch (e) {
      envInfo.error = String((e as Error)?.message ?? e);
      console.error('ENV_LOAD_FAILED ' + envInfo.error);
    }
    // hasEnvironment 必须在**装配完成后**回读：info 在 buildScene() 里就构造好了，
    // 那一刻 scene.environment 必然还是 null（IBL 是异步加载的），
    // 因此早先版本恒报 false —— 一个"字段存在但永远错误"的静默 bug，
    // 由 scripts/verify-offline.mjs 的实测发现。
    info.hasEnvironment = scene.environment !== null;
    return envInfo;
  }

  function render(silhouette = false) {
    if (silhouette) {
      scene.background = new THREE.Color(0xffffff);
      scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
      scene.traverse((o) => {
        if ((o as unknown as { isLight?: boolean }).isLight) o.visible = false;
      });
    }
    renderer.render(scene, camera);
    // Draw calls are only known AFTER a render: renderer.info.render.calls is reset at the
    // start of each render, so reading it while building the scene yields 0. Refresh here so
    // the reported figure describes the frame that was captured.
    info.drawCalls = renderer.info.render.calls;
    info.triangles = renderer.info.render.triangles;
  }

  /**
   * 视口变化时重设画布与投影。
   * 之前完全没有 resize 处理：画布固定在 1280×720，透视相机的 aspect 也硬编码 16/9，
   * 于是窗口一变，画面不是被裁就是被拉伸。
   */
  function applyViewportSize() {
    if (sizing !== 'viewport' || (opts.width && opts.height)) return;   // 门禁模式尺寸由调用方钉死
    const w = Math.max(1, Math.floor(window.innerWidth));
    const h = Math.max(1, Math.floor(window.innerHeight));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio));
    renderer.setSize(w, h, false);
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.aspect = w / h;
      // 取景距离随视口重算：这样"占满"与"不切主体"在任何窗口比例下都成立
      const which = (info.cam as string) ?? camName;
      const preset = CAMS[which] ?? CAMS.hero;
      const target = new THREE.Vector3(...preset.look);
      const dir = camera.position.clone().sub(target);
      dir.setLength(distanceForCam(which, { width: w, height: h }));
      camera.position.copy(target).add(dir);
      camera.lookAt(target);
      camera.updateProjectionMatrix();
    } else if (camera instanceof THREE.OrthographicCamera) {
      // 量测机位：半宽固定，只按新宽高比修正半高（保持可量测的比例不变）
      const halfW = 52;
      camera.left = -halfW; camera.right = halfW;
      camera.top = halfW * (h / w); camera.bottom = -halfW * (h / w);
      camera.updateProjectionMatrix();
    }
    info.viewport = [w, h];
    info.pixelRatio = renderer.getPixelRatio();
    info.canvasSize = [renderer.domElement.width, renderer.domElement.height];
  }

  /** 让调用方（main.ts）在 mount 之后挂上 resize 监听；返回卸载函数。 */
  function observeResize(): () => void {
    if (sizing !== 'viewport') return () => {};
    const onResize = () => applyViewportSize();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    // ResizeObserver 兜住"容器变了但窗口没变"的情况（如手机地址栏收起）
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    ro?.observe(document.documentElement);
    applyViewportSize();
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      ro?.disconnect();
    };
  }

  // ---- 机器可读报告：供截图门禁断言 ------------------------------------------------------
  // IMPORTANT: counts are taken from the ASSEMBLED OBJECTS, not echoed from SOURCED.
  // An earlier version reported `columns: SOURCED.columns`, which meant a regression that
  // stopped building columns would still pass ("echo, not measure" — caught in review).
  let triangles = 0;
  const materials = new Set<THREE.Material>();
  let builtColumns = 0;
  let builtPanels = 0;
  let builtStairFlights = 0;
  let builtEaves = 0;
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    triangles += countTriangles(m.geometry as THREE.BufferGeometry);
    materials.add(m.material as THREE.Material);
    const tag = m.userData?.formTag as string | undefined;
    if (tag === 'column') builtColumns++;
    if (tag === 'balustrade') builtPanels += (m.userData.panels as number) ?? 0;
    if (tag === 'stair') builtStairFlights++;
    if (tag === 'eave') builtEaves++;
  });
  // 建筑本体包围盒：**排除地面圆盘**。
  // 场景里有个半径 400 m 的 CircleGeometry 作为地面；若直接 setFromObject(scene)，
  // 得到的是 800 m 见方的外框，自动取景会把建筑缩成一个点（size 字段也曾因此报 800）。
  // 判据：把地面标记为 formTag='ground' 并跳过；其余网格都属建筑。
  const bbox = new THREE.Box3();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.userData?.formTag === 'ground') return;
    bbox.expandByObject(m);
  });

  // 用**实测**内容尺寸重算取景距离。
  // 为什么不用考据常量：纳入台阶外挑与栏杆后，实测横向尺寸是 97.7 m，
  // 而台基直径只有 90.3 m —— 按 90.3 取景会把台阶切出画面（实测确认）。
  // 竖直方向取 max(建筑高, 最低点以下的地面留白) 之类不做；只用实测高度即可。
  const measuredW = bbox.max.x - bbox.min.x;
  const measuredH = bbox.max.y - bbox.min.y;
  const contentOverride: FramingOverrides = {
    buildingWidth: measuredW,
    buildingHeight: measuredH,
    // 可见宽度下限仍以**大殿本体**为准（不被台阶外挑放大），确保主体永不被切
    minVisibleWidth: FRAMING.minVisibleWidth,
  };
  if (camera instanceof THREE.PerspectiveCamera) {
    const which = camName;
    const preset = CAMS[which] ?? CAMS.hero;
    const target = new THREE.Vector3(...preset.look);
    const dir = camera.position.clone().sub(target);
    dir.setLength(distanceForCam(which, { width: size0.w, height: size0.h }, contentOverride));
    camera.position.copy(target).add(dir);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
  }
  // 闭合检查必须建立在实际装配上，而不是照抄 plan 的数学结果 ——
  // 否则 fault=gap（把宝顶抬离屋面）这类构造故障永远不会被发现，门禁就成了摆设。
  // 两端都取自**实际加入场景的物体**：
  //   roofApexY  = 最高一层檐（lathe 屋面）的包围盒顶
  //   finialBaseY= 宝顶最下零件的包围盒底
  // 注意檐锥的几何顶**高于** plan 的推进量（檐高 × overlap），故宝顶底本来就略嵌入屋面，
  // 这是有意的（宝顶坐落在屋面脊部）。因此判据是"宝顶**不得悬浮在屋面之上**"，
  // 而不是"两点严格相等"：finialBaseY <= roofApexY + eps。
  let roofApexY = -Infinity;
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.userData?.formTag === 'eave') {
      const y = new THREE.Box3().setFromObject(m).max.y;
      if (y > roofApexY) roofApexY = y;
    }
  });
  let finialBaseY = Infinity;
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.userData?.formTag === 'finial') {
      const y = new THREE.Box3().setFromObject(m).min.y;
      if (y < finialBaseY) finialBaseY = y;
    }
  });
  const bothKnown = Number.isFinite(roofApexY) && Number.isFinite(finialBaseY);
  // 悬浮量：只统计"宝顶在屋面之上"的那部分间隙；嵌入记 0。
  const floatGap = bothKnown ? Math.max(0, finialBaseY - roofApexY) : Number.POSITIVE_INFINITY;
  const assertion = {
    totalHeightTarget: SOURCED.totalHeight,
    totalHeightActual: +bbox.max.y.toFixed(3),
    totalHeightOk: Math.abs(bbox.max.y - SOURCED.totalHeight) <= 0.15,
    // 包围盒只能证明"最高点对"，不能证明"内部无缝隙"（rev3 正是死在这里）。
    roofApexY: bothKnown ? +roofApexY.toFixed(3) : null,
    finialBaseY: bothKnown ? +finialBaseY.toFixed(3) : null,
    finialFloatGap: +floatGap.toFixed(4),
    segmentsClosedOk: bothKnown && floatGap <= 1e-3,
    // 保留该字段名以兼容既有断言脚本；语义等同于 finialFloatGap。
    segmentGap: +floatGap.toFixed(4),
    envLoadedOk: !useEnv,
  };

  const info: Record<string, unknown> = {
    cam: camName, detail, facadeTextures: facadeOn,
    // 环境强度必须回读，否则"参数被接受但静默无效"无法被发现
    envint: envIntensity,
    sizing,
    quality: quality.tier,
    // 取景与画布尺寸：供 S13 响应式门禁逐条断言（Q16 的 6 条）
    viewport: [size0.w, size0.h],
    pixelRatio: renderer.getPixelRatio(),
    canvasSize: [renderer.domElement.width, renderer.domElement.height],
    framing: (() => {
      const w = size0.w, h = size0.h;
      const d = camera instanceof THREE.PerspectiveCamera
        ? camera.position.distanceTo(presetTarget(camName))
        : 0;
      const f = camera instanceof THREE.PerspectiveCamera
        ? framingFractions({ width: w, height: h }, d, FRAMING.fovYDeg, contentOverride)
        : { mode: 'ortho-fixed' as const, heightFraction: 0, widthFraction: 0, visibleWidth: 0, distance: 0 };
      return {
        mode: f.mode,
        distance: +d.toFixed(2),
        heightFraction: +(f.heightFraction ?? 0).toFixed(4),
        widthFraction: +(f.widthFraction ?? 0).toFixed(4),
        visibleWidth: +(f.visibleWidth ?? 0).toFixed(2),
        buildingWidth: FRAMING.buildingWidth,
        buildingHeight: FRAMING.buildingHeight,
        // 实测内容尺寸：取景用它的横向值（含台阶外挑），供门禁核对
        measuredContentSize: [+measuredW.toFixed(2), +measuredH.toFixed(2)],
      };
    })(),
    triangles: Math.round(triangles),
    drawCalls: renderer.info.render.calls,
    materials: materials.size,
    size: [bbox.max.x - bbox.min.x, bbox.max.y - bbox.min.y, bbox.max.z - bbox.min.z]
      .map((v) => +v.toFixed(2)),
    // 考据值（常量，供"应然"对照）
    columns: SOURCED.columns,
    panelsPerTier: SOURCED.panelsPerTier,
    stairwaysPerTier: SOURCED.stairwaysPerTier,
    eaveTiers: SOURCED.eaveTiers,
    // 实际建出的构件数（由遍历装配结果得到，不是回读常量）——
    // 二者分开上报，才能真正发现"少建了"这类回归。
    built: {
      columns: builtColumns,
      panels: builtPanels,
      stairFlights: builtStairFlights,
      eaves: builtEaves,
    },
    counts: assertSourcedCounts(),
    assertions: assertion,
    env: envInfo,
    hasEnvironment: scene.environment !== null,
  };

  function setCamera(which: string) {
    const c2 = CAMS[which];
    if (!c2) return;
    const target = new THREE.Vector3(...c2.look);
    if (camera instanceof THREE.PerspectiveCamera) {
      const dir = new THREE.Vector3(...c2.pos).sub(target);
      // 距离由 distanceForCam 决定（top 保留预设距离，其余按取景规则）
      const w = renderer.domElement.clientWidth || renderer.domElement.width;
      const h = renderer.domElement.clientHeight || renderer.domElement.height;
      dir.setLength(distanceForCam(which, { width: w, height: h }));
      camera.position.copy(target).add(dir);
      camera.lookAt(target);
      camera.updateProjectionMatrix();
    } else if (camera instanceof THREE.OrthographicCamera) {
      // 之前只用 instanceof PerspectiveCamera 判断 ⇒ 正交模式下按 1–5 完全无操作（既有缺陷）。
      // 正交量测机位只承认 elev（水平正立面）；其余预设会破坏量测几何，故不改位置。
      if (which === 'elev') {
        camera.position.set(0, 18.4, 300);
        camera.lookAt(new THREE.Vector3(0, 18.4, 0));
      }
      camera.updateProjectionMatrix();
    }
    info.cam = which;
  }

  /** 预设机位的注视点。供 main.ts 对齐 OrbitControls.target，避免"切了机位又被拽回去"。 */
  function presetTarget(which: string): THREE.Vector3 {
    const c2 = CAMS[which] ?? CAMS.hero;
    return new THREE.Vector3(...c2.look);
  }

  return {
    scene, camera, renderer, info, loadEnvironment, render, setCamera,
    presetTarget, observeResize,
  };
}

/** 汉白玉栏杆：108 栏板/层（《北京文博》2000「各层栏板数均为一百零八块」）。 */
export function addBalustrade(
  scene: THREE.Scene, radius: number, y: number, mat: THREE.Material,
): { panels: number } {
  const N = SOURCED.panelsPerTier;
  const seg = (2 * Math.PI) / N;
  const panelW = radius * seg * 0.82;
  const panelH = 0.95, panelT = 0.34;
  const postW = 0.36, postH = 1.35, postT = 0.38;

  // 局部轴约定：rotation.y = PI/2 - a 时，局部 +Z → 径向朝外，局部 +X → 切向。
  // 于是 BoxGeometry(宽=切向, 高=竖向, 深=径向) 天然成为切向栏板。
  // 早先版本用 makeRotationY(-a).multiply(translation) 复合，导致盒体宽度朝了径向，
  // 栏板渲染成"径向鳍片"——该 bug 不报错、计数断言全过，只有目视能发现。
  const parts: THREE.BufferGeometry[] = [];
  const caps: THREE.BufferGeometry[] = [];
  const place = (g: THREE.BufferGeometry, a: number, rad: number, yy: number) => {
    g.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 2 - a));
    g.applyMatrix4(new THREE.Matrix4().makeTranslation(Math.cos(a) * rad, yy, Math.sin(a) * rad));
    return g;
  };
  for (let i = 0; i < N; i++) {
    const a = i * seg;
    parts.push(place(new THREE.BoxGeometry(panelW, panelH, panelT), a, radius - panelT / 2, y + panelH / 2));
    const ap = a - seg / 2;
    parts.push(place(new THREE.BoxGeometry(postW, postH, postT), ap, radius - postT / 2, y + postH / 2));
    caps.push(place(
      new THREE.BoxGeometry(postW + 0.16, 0.22, postT + 0.16), ap, radius - postT / 2, y + postH + 0.11,
    ));
  }
  const bal = new THREE.Mesh(mergeGeometries(parts, false)!, mat);
  bal.castShadow = true; bal.receiveShadow = true;
  bal.userData.formTag = 'balustrade';
  bal.userData.panels = N;
  scene.add(bal);
  const capMesh = new THREE.Mesh(mergeGeometries(caps, false)!, mat);
  capMesh.castShadow = true;
  scene.add(capMesh);
  return { panels: N };
}

/** 简化斗拱：每层檐下一圈扁块，形成檐下层叠进深。真实斗拱（斗+拱+昂）未做。 */
export function dougongGeometry(radius: number, blocks = 5, spacing = 1.6): THREE.BufferGeometry {
  const count = Math.max(12, Math.round((2 * Math.PI * radius) / spacing));
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    for (let b = 0; b < blocks; b++) {
      const w = 0.9 - b * 0.11;
      const box = new THREE.BoxGeometry(w, 0.30, 0.62);
      box.applyMatrix4(new THREE.Matrix4().makeRotationY(-a)
        .multiply(new THREE.Matrix4().makeTranslation(0, b * 0.30, -(radius + 0.10 + b * 0.16))));
      parts.push(box);
    }
  }
  return mergeGeometries(parts, false)!;
}
