import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { latticeTexture, caihuaTexture } from './facadeTextures.js';
import { SOURCED, planSegmentStack, eaveRadii, assertSourcedCounts } from './massing.js';

// 祈年殿场景装配。所有几何尺寸都来自 src/massing.ts（已由 tests/massing.test.ts 覆盖），
// 本文件只负责"把形制变成 three.js 物体"，不重新定义任何考据数字。
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
}

export interface EnvInfo {
  /** 是否请求了 IBL。请求了就必须加载成功，否则门禁判失败。 */
  requested: boolean;
  loaded: boolean;
  error: string | null;
  pmrem: boolean;
}

// 机位表（固定，保证截图可复现）
const CAMS: Record<string, { pos: [number, number, number]; look: [number, number, number] }> = {
  hero: { pos: [0, 26, 96], look: [0, 17, 0] },
  front: { pos: [0, 17, 118], look: [0, 17, 0] },
  low: { pos: [0, 3.2, 82], look: [0, 22, 0] },
  top: { pos: [0, 150, 0.01], look: [0, 0, 0] },
  elev: { pos: [0, 18.4, 300], look: [0, 18.4, 0] },
};

/** 凹曲屋面剖面：脊部陡、檐口缓、檐端微翘——祈年殿的标志性轮廓。 */
export function roofProfile(
  rEave: number, rRidge: number, h: number, upturn: number, N = 28,
): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;                                    // 0 在檐口，1 在脊部
    const r = rEave + (rRidge - rEave) * Math.pow(t, 0.72);
    const yy = h * (1 - Math.pow(1 - t, 1.6)) + upturn * Math.pow(1 - t, 3.4);
    pts.push(new THREE.Vector2(Math.max(r, 0.01), yy));
  }
  return pts;
}

/** 瓦垄：沿屋面剖面铺设的条状脊，间距约 0.9 m。这是侧光下条状高光的来源。 */
export function tileRidgeGeometry(
  rEave: number, rRidge: number, h: number, upturn: number, spacing = 0.9, inset = 0.6,
): THREE.BufferGeometry {
  // inset 让瓦垄在檐口前收齐，避免盒体厚度越出檐边
  const tSpan = (() => {
    const f = (rEave - inset - rEave) / (rRidge - rEave);
    return f <= 0 ? 0 : Math.pow(f, 1 / 0.72);
  })();
  const prof: THREE.Vector2[] = [];
  const N = 18;
  for (let i = 0; i <= N; i++) {
    const t = tSpan + (1 - tSpan) * (i / N);
    const r = rEave + (rRidge - rEave) * Math.pow(t, 0.72);
    const yy = h * (1 - Math.pow(1 - t, 1.6)) + upturn * Math.pow(1 - t, 3.4);
    prof.push(new THREE.Vector2(Math.max(r, 0.01), yy));
  }
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
}

export function buildScene(opts: SceneOptions = {}): BuiltScene {
  const camName = opts.cam ?? 'hero';
  const detail = opts.detail ?? 2;
  const facadeOn = opts.facade !== false;
  const envIntensity = opts.envIntensity ?? 0.25;
  const useEnv = opts.useEnv ?? true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fb0d2);

  let camera: THREE.Camera;
  if (opts.projection === 'ortho') {
    // 正交水平机位：无透视畸变，屏幕上的宽度与真实半径成正比 —— 量测轮廓比例必须用这个。
    // 用俯视图量测檐口出挑比是错的：俯视每一行的宽度都是台基直径（实测得到 1:1:1）。
    const halfW = 52, halfH = halfW * (9 / 16);
    const oc = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.5, 4000);
    oc.position.set(0, 18.4, 300);
    oc.lookAt(new THREE.Vector3(0, 18.4, 0));
    oc.updateProjectionMatrix();
    camera = oc;
  } else {
    const pc = new THREE.PerspectiveCamera(42, 16 / 9, 0.5, 4000);
    const c = CAMS[camName] ?? CAMS.hero;
    pc.position.set(...c.pos);
    pc.lookAt(new THREE.Vector3(...c.look));
    camera = pc;
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(opts.width ?? 1280, opts.height ?? 720);
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

  // ---- terrace：三层，5.2 m，直径 90.3 / 79.3 / 68.2（考据值） ------------------------
  const terraceD = [...SOURCED.terraceDiameters];       // 下→上
  const tierH = SOURCED.terraceHeight / SOURCED.terraceTiers;
  const stairLayout = SOURCED.stairwayLayout as readonly { face: string; offset: number }[];
  const bearingOf = (face: string) =>
    face === 'south' ? Math.PI / 2 : face === 'north' ? -Math.PI / 2 : face === 'east' ? 0 : Math.PI;

  let y = 0;
  for (let i = 0; i < SOURCED.terraceTiers; i++) {
    const r = terraceD[i] / 2;
    const tier = new THREE.Mesh(new THREE.CylinderGeometry(r, r, tierH, 128), marble);
    tier.position.y = y + tierH / 2;
    tier.receiveShadow = true; tier.castShadow = true;
    scene.add(tier);

    if (i > 0) {
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
        scene.add(flight);
      }
    }
    addBalustrade(scene, r - 0.55, y + tierH, marbleBalustrade);
    y += tierH;
  }

  // ---- 殿堂本体：由 massing 的闭合分段驱动 ------------------------------------------------
  const plan = planSegmentStack();
  let wallIndex = 0;
  // ?fault=gap 把宝顶人为抬离屋面，复现 rev3 的"宝顶悬空"缺陷，用于证明闭合断言真的会失败。
  const finialLift = opts.fault === 'gap' ? 2.0 : 0;

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

      // 柱：最下两段各 12 根（檐柱 / 金柱），与考据的 4+12+12 对应
      const cols = SOURCED.columnRings[wallIndex === 0 ? 2 : 1];
      if (wallIndex < 2) {
        for (let i = 0; i < cols; i++) {
          const a = (i / cols) * Math.PI * 2 + Math.PI / cols;
          const col = new THREE.Mesh(
            new THREE.CylinderGeometry(0.62, 0.62, seg.height, 20), columnRed,
          );
          col.position.set(Math.cos(a) * r, seg.bottom + seg.height / 2, Math.sin(a) * r);
          col.castShadow = true;
          scene.add(col);
        }
      }
      wallIndex++;
    } else if (seg.kind === 'eave') {
      const rEave = seg.eaveRadius!;
      const rRidge = seg.ridgeRadius!;
      const upturn = 0.55;

      const roof = new THREE.Mesh(
        new THREE.LatheGeometry(roofProfile(rEave, rRidge, seg.height, upturn), 128), glazeBlue,
      );
      roof.position.y = seg.bottom;
      roof.castShadow = true; roof.receiveShadow = true;
      scene.add(roof);

      const rim = new THREE.Mesh(new THREE.TorusGeometry(rEave, 0.46, 12, 128), glazeBlue);
      rim.rotation.x = Math.PI / 2;
      rim.position.y = seg.bottom + upturn * 0.8;
      rim.castShadow = true;
      scene.add(rim);

      if (detail >= 1) {
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
      lotus.castShadow = true; scene.add(lotus);

      const globeR = globeH / 2;
      const globe = new THREE.Mesh(new THREE.SphereGeometry(globeR, 48, 32), gold);
      globe.position.y = baseY + lotusH + globeR;
      globe.scale.set(0.82, 1.0, 0.82);
      globe.castShadow = true; scene.add(globe);

      const spire = new THREE.Mesh(new THREE.ConeGeometry(0.3, spireH, 24), gold);
      spire.position.y = baseY + lotusH + globeH + spireH / 2;
      spire.castShadow = true; scene.add(spire);
    }
  }

  // ---- 光照：固定太阳（可复现）+ 可选 IBL -----------------------------------------------
  const sun = new THREE.DirectionalLight(0xfff6e8, 3.4);
  sun.position.set(62, 88, 44);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
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
  scene.add(ground);

  const envInfo: EnvInfo = { requested: useEnv, loaded: false, error: null, pmrem: false };

  async function loadEnvironment() {
    if (!useEnv) return envInfo;
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

  // ---- 机器可读报告：供截图门禁断言 ------------------------------------------------------
  let triangles = 0;
  const materials = new Set<THREE.Material>();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      const g = m.geometry as THREE.BufferGeometry;
      triangles += g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
      materials.add(m.material as THREE.Material);
    }
  });
  const bbox = new THREE.Box3().setFromObject(scene);
  const r = eaveRadii();
  // 逐段闭合检查必须建立在实际装配上，而不是照抄 plan 的数学结果 ——
  // 否则 fault=gap（把宝顶抬离屋面）这类构造故障永远不会被发现，门禁就成了摆设。
  const actualFinialBase = plan.segments[plan.segments.length - 1].bottom + finialLift;
  const roofApex = plan.segments[plan.segments.length - 2].top;
  const segmentGap = Math.abs(roofApex - actualFinialBase);
  const assertion = {
    totalHeightTarget: SOURCED.totalHeight,
    totalHeightActual: +bbox.max.y.toFixed(3),
    totalHeightOk: Math.abs(bbox.max.y - SOURCED.totalHeight) <= 0.15,
    // 包围盒只能证明"最高点对"，不能证明"内部无缝隙"（rev3 正是死在这里）
    segmentGap: +segmentGap.toFixed(4),
    segmentsClosedOk: segmentGap <= 1e-3,
    envLoadedOk: !useEnv,
  };

  const info: Record<string, unknown> = {
    cam: camName, detail, facadeTextures: facadeOn,
    // 环境强度必须回读，否则"参数被接受但静默无效"无法被发现
    envint: envIntensity,
    ridgeInset: 0.6,
    triangles: Math.round(triangles),
    drawCalls: renderer.info.render.calls,
    materials: materials.size,
    size: [bbox.max.x - bbox.min.x, bbox.max.y - bbox.min.y, bbox.max.z - bbox.min.z]
      .map((v) => +v.toFixed(2)),
    // 考据计数（供断言，防静默回归）
    columns: SOURCED.columns,
    panelsPerTier: SOURCED.panelsPerTier,
    stairwaysPerTier: SOURCED.stairwaysPerTier,
    eaveTiers: SOURCED.eaveTiers,
    // 出挑比实测（供与参考读值比对）
    eaveRatios: [r[0] / r[2], r[1] / r[2], 1].map((v) => +v.toFixed(3)),
    counts: assertSourcedCounts(),
    assertions: assertion,
    env: envInfo,
    hasEnvironment: scene.environment !== null,
  };

  return { scene, camera, renderer, info, loadEnvironment, render };
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
