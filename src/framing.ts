// 取景（framing）—— 纯函数，无 three.js、无 DOM。
//
// 这一层回答一个可判定的问题：**给定视口尺寸，相机该放多远，才能既"占满"又不切掉建筑本体。**
// 之所以把纯数学从场景装配里剥离，是因为取景一旦写错，症状是"看起来有点小/有点被切"，
// 无法在渲染层被可靠断言；而在纯函数里，两条不等式可以直接断言（见 tests/framing.test.ts）。
//
// 规则来源（本项目 grilling 的 Q1 / Q12 / Q28 / Q30）：
//   1) 先算 contain 距离：宽与高都装得下（取两者所需距离的较大者）
//   2) 若 contain 下建筑占屏高已 >= 45%，就用 contain —— 此时整座台基完整可见
//   3) 否则"靠近"，直到 占屏高 >= 45% 或 可见宽度降到下限；**取两者中较远的距离**
// 第 3 条的"可见宽度下限"是 Q30 的关键修正：我最初的方案在竖屏会切到大殿本体
// （390x844 填满高度时可见宽度仅 17.0 m < 大殿 32.72 m），那不是适配而是切掉主体。

import { SOURCED } from './massing.js';

/** 取景参数。宽高取自**建筑本体**，不是场景包围盒（后者含半径 400 m 的地面圆盘）。 */
export const FRAMING = {
  /** 相机竖直视场角（度）——必须与 PerspectiveCamera 的构造参数一致 */
  fovYDeg: 42,
  /** 建筑本体宽度：台基最下层直径（考据值 90.3 m） */
  buildingWidth: SOURCED.terraceDiameters[0],
  /** 建筑本体高度：通高（考据值 36.8 m） */
  buildingHeight: SOURCED.totalHeight,
  /** 大殿身直径（考据值 32.72 m）——必须始终完整可见 */
  hallBodyWidth: SOURCED.bodyDiameter,
  /** 两侧各留的余量（米），避免建筑贴死画面边缘 */
  widthMargin: 1.6,
  /** 可见宽度下限 = 大殿本体 + 两侧余量。**永不以切掉主体为代价换取占屏比例。** */
  get minVisibleWidth() { return this.hallBodyWidth + this.widthMargin * 2; },
  /** 建筑占屏高的目标下限 */
  minHeightFraction: 0.45,
} as const;

export interface Viewport { width: number; height: number }

/** 覆盖默认取景尺寸。场景装配完成后应传入**实测**尺寸，而不是硬编码的台基直径。 */
export interface FramingOverrides {
  /** 要装进画面的内容宽度（米）。默认取台基直径；实测含台阶外挑约 97.7 m。 */
  buildingWidth?: number;
  /** 要装进画面的内容高度（米）。默认取通高。 */
  buildingHeight?: number;
  /** 可见宽度下限（米）。默认 = 大殿本体 + 两侧余量。 */
  minVisibleWidth?: number;
}

export type FramingMode = 'contain' | 'close-until-floor';

export interface FramingResult {
  /** 相机到注视点的距离（米） */
  distance: number;
  /** 实际采用的模式，供门禁断言 */
  mode: FramingMode;
  /** 建筑占屏高的比例 */
  heightFraction: number;
  /** 建筑占屏宽的比例 */
  widthFraction: number;
  /** 该距离下画面可见的世界宽度（米） */
  visibleWidth: number;
}

const tanHalfY = (fovYDeg: number) => Math.tan((fovYDeg / 2) * (Math.PI / 180));

/** 在距离 d、视口宽高比 A、竖直视场角 fov 下，画面可见的世界宽度。 */
export function visibleWidthAt(d: number, aspect: number, fovYDeg = FRAMING.fovYDeg): number {
  return 2 * d * tanHalfY(fovYDeg) * aspect;
}

function assertUsableViewport(vp: Viewport): number {
  if (!Number.isFinite(vp.width) || !Number.isFinite(vp.height) || vp.width <= 0 || vp.height <= 0) {
    throw new Error(`unusable viewport: ${vp.width}x${vp.height}`);
  }
  return vp.width / vp.height;
}

/**
 * 由视口尺寸求相机距离。规则见文件头（Q30）。
 * @throws 视口退化（任一维 <= 0 或非有限数）时抛错，而不是返回 NaN/Infinity
 */
export function cameraDistanceForViewport(
  vp: Viewport,
  fovYDeg = FRAMING.fovYDeg,
  over: FramingOverrides = {},
): number {
  const aspect = assertUsableViewport(vp);
  const tanY = tanHalfY(fovYDeg);
  const tanX = tanY * aspect;
  const contentW = over.buildingWidth ?? FRAMING.buildingWidth;
  const contentH = over.buildingHeight ?? FRAMING.buildingHeight;
  const minVisible = over.minVisibleWidth ?? FRAMING.minVisibleWidth;
  const halfW = contentW / 2;
  const halfH = contentH / 2;

  // 1) contain：宽高都装得下
  const dContain = Math.max(halfW / tanX, halfH / tanY);
  const heightFractionContain = halfH / (dContain * tanY);
  if (heightFractionContain >= FRAMING.minHeightFraction) return dContain;

  // 3) 靠近：占屏高达标的（最远）距离 与 可见宽度触底限的（最近）距离，取较远者
  const dForTargetHeight = halfH / (tanY * FRAMING.minHeightFraction);
  const dForWidthFloor = minVisible / (2 * tanX);
  return Math.max(dForTargetHeight, dForWidthFloor);
}

/** 给定视口与距离，回报各项取景比例与模式（供门禁与人工核对）。 */
export function framingFractions(
  vp: Viewport,
  distance: number,
  fovYDeg = FRAMING.fovYDeg,
  over: FramingOverrides = {},
): FramingResult {
  const aspect = assertUsableViewport(vp);
  const tanY = tanHalfY(fovYDeg);
  const tanX = tanY * aspect;
  const contentW = over.buildingWidth ?? FRAMING.buildingWidth;
  const contentH = over.buildingHeight ?? FRAMING.buildingHeight;
  const visibleWidth = 2 * distance * tanX;
  const visibleHeight = 2 * distance * tanY;
  const heightFraction = contentH / visibleHeight;
  const widthFraction = contentW / visibleWidth;
  // 宽度约束主导 => contain（整座台基可见）；否则说明是靠"靠近"把高度拉到达标
  const halfW = contentW / 2;
  const halfH = contentH / 2;
  const dContain = Math.max(halfW / tanX, halfH / tanY);
  const mode: FramingMode = Math.abs(distance - dContain) < 1e-6 ? 'contain' : 'close-until-floor';
  return { distance, mode, heightFraction, widthFraction, visibleWidth };
}

/**
 * 把 Q30 的两条约束写成可判定的谓词，供测试与门禁共用（避免两处阈值漂移）。
 * @returns 未通过的项（空数组 = 全部通过）
 */
export function framingViolations(vp: Viewport, distance: number): string[] {
  const f = framingFractions(vp, distance);
  const out: string[] = [];
  const label = `${vp.width}x${vp.height}`;
  if (f.heightFraction < FRAMING.minHeightFraction - 1e-9) {
    out.push(`${label}: height fill ${(f.heightFraction * 100).toFixed(1)}% < ${(FRAMING.minHeightFraction * 100).toFixed(0)}%`);
  }
  if (f.visibleWidth < FRAMING.minVisibleWidth - 1e-9) {
    out.push(`${label}: visible width ${f.visibleWidth.toFixed(2)} m < floor ${FRAMING.minVisibleWidth.toFixed(2)} m`);
  }
  if (f.visibleWidth < FRAMING.hallBodyWidth - 1e-9) {
    out.push(`${label}: visible width ${f.visibleWidth.toFixed(2)} m crops the hall body (${FRAMING.hallBodyWidth} m)`);
  }
  if (!Number.isFinite(distance) || distance <= 0) {
    out.push(`${label}: distance ${distance} is not a positive finite number`);
  }
  return out;
}
