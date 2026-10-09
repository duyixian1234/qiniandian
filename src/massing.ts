// 祈年殿 形制（massing）计算 —— 纯函数，无 three.js、无 DOM。
//
// 这一层承载"形制优先"的可判定部分：尺寸、闭合、比例、考据计数。
// 之所以把纯数学从几何装配中剥离，是因为 rev3 曾在装配层静默失败：
// 各段高度逐段手估，屋顶收顶于 29.53 m 而宝顶底放在 32.10 m，宝顶悬空 2.57 m，
// 而包围盒只显示"总高 37.08 m 看起来正常"。逐段闭合只能在纯函数里被可靠断言。
//
// 证据纪律：SOURCED 里的每个数字都有一手出处（见 ../../.probe/research/qiniandian_factsheet.md）；
// DERIVED 里的每个数字都是推导或人工读图得来，报告中必须标注为构造量。

// =======================================================================================
// 考据值（sourced）—— 每个都有 URL 出处，见 SPEC.md §2
// =======================================================================================
export const SOURCED = {
  // 通高 = 殿身 + 台基。官方北京市公园管理中心给 31.6 + 5.2 = 36.8（内部自洽）。
  // 注意：另有 38 m 派三方来源（含《北京文博》2000），冲突真实存在，故本层不做硬编码假设。
  totalHeight: 36.8,
  hallBodyHeight: 31.6,
  terraceHeight: 5.2,

  bodyDiameter: 32.72,
  // 天坛官网的 24 m 是"檐柱之间"的直径，与殿身直径是两件事，勿混。
  eaveColumnRingDiameter: 24,

  terraceTiers: 3,
  terraceDiameters: [90.3, 79.3, 68.2],   // 下→上

  finialHeight: 4.7,
  finialDiameter: 1.9,

  columns: 28,
  columnRings: [4, 12, 12],               // 龙井柱 + 金柱 + 檐柱
  eaveTiers: 3,
  panelsPerTier: 108,                     // 《北京文博》2000：「各层栏板数均为一百零八块」
  stairwaysPerTier: 8,                    // 《北京文博》2000：「三层坛体各出八陛」
} as const;

// =======================================================================================
// 构造量（derived）—— 无一手出处，报告须标注
// =======================================================================================
export const DERIVED = {
  // 三重檐外缘半径之比：对公有领域照片的人工网格读值（1850×1200, CSIRO）
  eaveRatioTopToBottom: [0.64, 0.86, 1.0] as const,
  // 檐覆盖其上方墙段的比例（檐比墙段更靠上，故推进量小于檐高）。模型约定，非考据。
  eaveOverlap: 0.80,
  // 三段墙段占"可用屋面跨度"的比例（下大上小，与照片观感一致）
  wallFractions: [0.42, 0.32, 0.26] as const,
  // 檐层总推进量占可用屋面跨度的比例
  eaveSpanFraction: 0.42,
  // 各层墙段外半径（由殿身直径与层间收分反推）
  wallRadii: [16.36, 12.20, 8.60] as const,
  // 底檐外缘半径基准
  bottomEaveRadius: 20.6,
  // 台基台阶的切向偏移（米）。来源只给出「南北两面各三出」的**数量**，
  // **没有**给出三条台阶之间的间距；0 / ±9 m 是我为了让三条台阶不重叠而选的**构造量**。
  // 原先它被误放在 SOURCED 里，与该块"每个数字都有一手出处"的声明冲突（自审发现）。
  stairwayOffsets: [0, -9, 9] as const,
} as const;

export interface Stairway {
  face: 'south' | 'north' | 'east' | 'west';
  /** 切向偏移（米）—— 构造量，见 DERIVED.stairwayOffsets */
  offset: number;
}

/**
 * 每层台基的台阶布置：**数量**是考据值（南北各 3、东西各 1，共 8，出自《北京文博》2000），
 * 而**切向间距**是构造量（来源未给）。
 * 二者刻意分开表达，是为了让"哪些是考据、哪些是推导"在代码里就一目了然。
 */
export function stairwayLayout(): Stairway[] {
  const [a, b, c] = DERIVED.stairwayOffsets;
  return [
    { face: 'south', offset: a }, { face: 'south', offset: b }, { face: 'south', offset: c },
    { face: 'north', offset: a }, { face: 'north', offset: b }, { face: 'north', offset: c },
    { face: 'east', offset: 0 },
    { face: 'west', offset: 0 },
  ];
}

export type SegmentKind = 'wall' | 'eave' | 'finial';

export interface Segment {
  name: string;
  kind: SegmentKind;
  /** 段底标高（米，0 = 台基底） */
  bottom: number;
  /** 段顶标高（米） */
  top: number;
  /** 段高（米）。檐段的"推进量" = height × eaveOverlap */
  height: number;
  /** 仅墙段：外半径 */
  wallRadius?: number;
  /** 仅檐段：外缘半径 */
  eaveRadius?: number;
  /** 仅檐段：脊部半径 */
  ridgeRadius?: number;
}

export interface PlanOptions {
  totalHeight?: number;
  terraceHeight?: number;
  finialHeight?: number;
  wallFractions?: readonly number[];
  eaveOverlap?: number;
  eaveSpanFraction?: number;
  /** 各层墙段外半径；长度须等于墙段数 */
  wallRadii?: readonly number[];
}

export interface Plan {
  segments: Segment[];
  totalHeight: number;
  terraceHeight: number;
  finialHeight: number;
}

/**
 * 由"总高"反推各段高度，并保证**逐段首尾严格相接**且总高精确等于目标。
 *
 * 约束链：台基顶 → [墙1 → 檐1 → 墙2 → 檐2 → 墙3 → 檐3] → 宝顶底 = 宝顶顶 = 总高
 * 其中檐段的推进量 = 檐高 × eaveOverlap（檐覆盖其上方墙段）。
 *
 * 这是 rev3 缺陷（宝顶悬空）的根治做法：**各段高度由总高反推，而非逐段手估**。
 */
export function planSegmentStack(opts: PlanOptions = {}): Plan {
  const totalHeight = opts.totalHeight ?? SOURCED.totalHeight;
  const terraceHeight = opts.terraceHeight ?? SOURCED.terraceHeight;
  const finialHeight = opts.finialHeight ?? SOURCED.finialHeight;
  const wallFractions = opts.wallFractions ?? DERIVED.wallFractions;
  const eaveOverlap = opts.eaveOverlap ?? DERIVED.eaveOverlap;
  const eaveSpanFraction = opts.eaveSpanFraction ?? DERIVED.eaveSpanFraction;
  const wallRadii = opts.wallRadii ?? DERIVED.wallRadii;

  const wallCount = wallFractions.length;
  if (wallCount !== SOURCED.eaveTiers) {
    throw new Error(`expected ${SOURCED.eaveTiers} wall bands, got ${wallCount}`);
  }
  if (wallRadii.length !== wallCount) {
    throw new Error(`wallRadii length ${wallRadii.length} != wall band count ${wallCount}`);
  }
  if (eaveOverlap <= 0 || eaveOverlap > 1) {
    throw new Error(`eaveOverlap must be in (0,1], got ${eaveOverlap}`);
  }

  // 可用于墙段与檐段的总跨度
  const roofSpan = totalHeight - terraceHeight - finialHeight;
  if (roofSpan <= 0) {
    throw new Error(
      `impossible configuration: totalHeight ${totalHeight} cannot host terrace ` +
      `${terraceHeight} + finial ${finialHeight}`,
    );
  }

  const eaveAdvanceTotal = roofSpan * eaveSpanFraction;
  const wallTotal = roofSpan - eaveAdvanceTotal;

  // 檐的"段高"要除以 overlap，因为只有 height×overlap 才推进标高
  const wallHeights = wallFractions.map((f) => wallTotal * f);
  const eaveHeights = wallHeights.map(() => (eaveAdvanceTotal / wallCount) / eaveOverlap);

  const segments: Segment[] = [];
  let y = terraceHeight;

  for (let i = 0; i < wallCount; i++) {
    // 墙段
    const wallBottom = y;
    const wallTop = wallBottom + wallHeights[i];
    segments.push({
      name: `wall${i + 1}`,
      kind: 'wall',
      bottom: wallBottom,
      top: wallTop,
      height: wallHeights[i],
      wallRadius: wallRadii[i],
    });
    y = wallTop;

    // 该墙段之上的檐（最后一层檐收顶）
    const eaveBottom = y;
    const advance = eaveHeights[i] * eaveOverlap;
    const eaveTop = eaveBottom + advance;
    const radii = eaveRadii({
      bottomRadius: DERIVED.bottomEaveRadius,
      ratio: DERIVED.eaveRatioTopToBottom,
    });
    // radii 顺序为 [上, 中, 下]；i=0 是最下层檐，对应 radii[2]
    const eaveRadius = radii[wallCount - 1 - i];
    segments.push({
      name: `eave${i + 1}`,
      kind: 'eave',
      bottom: eaveBottom,
      top: eaveTop,
      height: eaveHeights[i],
      eaveRadius,
      ridgeRadius: eaveRadius * 0.6,
    });
    y = eaveTop;
  }

  // 宝顶：底 = 屋面顶，顶 = 总高。二者必须严格相接——这正是 rev3 失败之处。
  segments.push({
    name: 'finial',
    kind: 'finial',
    bottom: y,
    top: y + finialHeight,
    height: finialHeight,
  });
  y += finialHeight;

  return { segments, totalHeight: y, terraceHeight, finialHeight };
}

export interface EaveRadiiOptions {
  bottomRadius?: number;
  /** [上, 中, 下] 比例；默认取 DERIVED.eaveRatioTopToBottom */
  ratio?: readonly number[];
}

/**
 * 三重檐外缘半径。比例来自对公有领域照片的**人工网格读值**（构造量，非测量学精确值），
 * 但它是"形制准确"可回归判定的基础：改几何 → 重测比值 → 看偏差是否下降。
 * @returns [上檐, 中檐, 下檐] 半径
 */
export function eaveRadii(opts: EaveRadiiOptions = {}): [number, number, number] {
  const bottomRadius = opts.bottomRadius ?? DERIVED.bottomEaveRadius;
  const ratio = opts.ratio ?? DERIVED.eaveRatioTopToBottom;   // [上, 中, 下]
  if (ratio.length !== 3) throw new Error(`expected 3 eave ratios, got ${ratio.length}`);
  const bottomRatio = ratio[2];
  if (bottomRatio <= 0) throw new Error('bottom eave ratio must be positive');
  return [
    bottomRadius * (ratio[0] / bottomRatio),
    bottomRadius * (ratio[1] / bottomRatio),
    bottomRadius * (ratio[2] / bottomRatio),
  ];
}

export interface CountCheck {
  name: string;
  expected: number;
  actual: number;
  ok: boolean;
}

/**
 * 考据计数自检。可传入 override 以**证明该检查会失败**（构造故障），
 * 这是本项目的纪律：检查的价值来自它失败过。
 */
export function assertSourcedCounts(override: Partial<Record<string, number>> = {}): CountCheck[] {
  const ringsSum = SOURCED.columnRings.reduce((a, b) => a + b, 0);
  const layout = stairwayLayout();
  const define: Array<[string, number]> = [
    ['columns', SOURCED.columns],
    ['columnRings', ringsSum],
    ['panelsPerTier', SOURCED.panelsPerTier],
    ['stairwaysPerTier', SOURCED.stairwaysPerTier],
    ['stairwayLayout', layout.length],
    ['stairwaysSouth', layout.filter((s) => s.face === 'south').length],
    ['stairwaysNorth', layout.filter((s) => s.face === 'north').length],
    ['eaveTiers', SOURCED.eaveTiers],
    ['terraceTiers', SOURCED.terraceTiers],
  ];
  // 期望值写死为字面量，而不是从 SOURCED 现算 —— 否则检查会与实现同源，永远不可能失败。
  const expectedLiteral: Record<string, number> = {
    columns: 28, columnRings: 28, panelsPerTier: 108, stairwaysPerTier: 8,
    stairwayLayout: 8, stairwaysSouth: 3, stairwaysNorth: 3, eaveTiers: 3, terraceTiers: 3,
  };
  return define.map(([name]) => {
    const expected = expectedLiteral[name];
    const actual = override[name] ?? define.find((d) => d[0] === name)![1];
    return { name, expected, actual, ok: actual === expected };
  });
}
