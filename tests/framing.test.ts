import { describe, it, expect } from 'vitest';
import {
  FRAMING,
  cameraDistanceForViewport,
  framingFractions,
  visibleWidthAt,
  type Viewport,
} from '../src/framing.js';

// ---------------------------------------------------------------------------------------
// Expected values are INDEPENDENT literals computed by hand from the geometry, not by
// re-running the implementation. The hand computation (fovY = 42°, building 90.3 x 36.8 m):
//   tan(21°) = 0.383864
//   16:9 viewport (A = 1.7778): tanHalfX = 0.383864 * 1.77778 = 0.682425
//     d_width  = 45.15 / 0.682425 = 66.16 m
//     d_height = 18.40 / 0.383864 = 47.93 m   => contain takes max = 66.16 m
//   390x844 (A = 0.462085): tanHalfX = 0.177373
//     d_width  = 45.15 / 0.177373 = 254.55 m  => contain would be 254.55, fh only 19%
//     so we close in; the width floor binds: d = 35.92 / (2 * 0.177373) = 101.27 m
// ---------------------------------------------------------------------------------------

describe('FRAMING constants (Q30 rule, verified across 8 viewports by hand)', () => {
  it('uses the building body as the visible-width floor, plus margin', () => {
    // 大殿本体 32.72 m 必须完整可见；两侧各留 1.6 m 余量
    expect(FRAMING.hallBodyWidth).toBeCloseTo(32.72, 6);
    expect(FRAMING.widthMargin).toBeCloseTo(1.6, 6);
    expect(FRAMING.minVisibleWidth).toBeCloseTo(35.92, 6);
  });

  it('targets at least 45% of the viewport height for the building', () => {
    expect(FRAMING.minHeightFraction).toBeCloseTo(0.45, 6);
  });

  it('takes the building footprint from the terrace, not the 400 m ground disc', () => {
    // 关键: 场景里有个半径 400 m 的地面圆盘。若把地面算进包围盒，取景会把建筑缩成一点。
    expect(FRAMING.buildingWidth).toBeCloseTo(90.3, 6);
    expect(FRAMING.buildingHeight).toBeCloseTo(36.8, 6);
    expect(FRAMING.buildingWidth).toBeLessThan(400);
  });

  it('exposes the camera vertical field of view as 42 degrees', () => {
    expect(FRAMING.fovYDeg).toBeCloseTo(42, 6);
  });
});

describe('visibleWidthAt — frustum geometry', () => {
  it('matches the hand-computed width at 66.16 m in a 16:9 viewport', () => {
    // 2 * d * tanHalfX, tanHalfX = tan(21°) * (16/9)
    const w = visibleWidthAt(66.16, 16 / 9, 42);
    expect(w).toBeCloseTo(90.3, 0);   // ±0.5 m tolerance on the hand-rounded distance
  });

  it('grows linearly with distance', () => {
    const a = visibleWidthAt(100, 16 / 9, 42);
    const b = visibleWidthAt(200, 16 / 9, 42);
    expect(b / a).toBeCloseTo(2, 6);
  });

  it('is narrower in a portrait viewport at the same distance', () => {
    const landscape = visibleWidthAt(100, 16 / 9, 42);
    const portrait = visibleWidthAt(100, 390 / 844, 42);
    expect(portrait).toBeLessThan(landscape);
    expect(portrait / landscape).toBeCloseTo((390 / 844) / (16 / 9), 6);
  });
});

describe('cameraDistanceForViewport — the Q30 rule', () => {
  const LANDSCAPE: Viewport = { width: 1280, height: 720 };
  const ULTRAWIDE: Viewport = { width: 2560, height: 1080 };
  const TABLET: Viewport = { width: 1024, height: 768 };
  const PORTRAIT: Viewport = { width: 390, height: 844 };

  it('uses contain for 16:9, so the whole terrace fits (90.3 m visible)', () => {
    const d = cameraDistanceForViewport(LANDSCAPE);
    expect(d).toBeCloseTo(66.16, 1);
    expect(visibleWidthAt(d, 16 / 9, 42)).toBeGreaterThanOrEqual(FRAMING.buildingWidth - 1e-6);
  });

  it('uses contain for ultrawide and gets a far better height fill than 16:9', () => {
    const dU = cameraDistanceForViewport(ULTRAWIDE);
    const fU = framingFractions(ULTRAWIDE, dU);
    const dL = cameraDistanceForViewport(LANDSCAPE);
    const fL = framingFractions(LANDSCAPE, dL);
    expect(fU.heightFraction).toBeGreaterThan(fL.heightFraction);
    expect(fU.heightFraction).toBeGreaterThan(0.9);   // ~97% per the hand table
  });

  it('uses contain for 4:3 and still satisfies both constraints', () => {
    const d = cameraDistanceForViewport(TABLET);
    const f = framingFractions(TABLET, d);
    expect(f.heightFraction).toBeGreaterThanOrEqual(FRAMING.minHeightFraction - 1e-9);
    expect(f.visibleWidth).toBeGreaterThanOrEqual(FRAMING.minVisibleWidth - 1e-9);
  });

  it('closes in for portrait, raising height fill from 19% to the 45% target', () => {
    const d = cameraDistanceForViewport(PORTRAIT);
    const f = framingFractions(PORTRAIT, d);
    // 45% is exactly the target the rule aims for
    expect(f.heightFraction).toBeCloseTo(0.45, 2);
    // and crucially: contain would only have given ~19%
    const dContain = FRAMING.buildingWidth / 2 / (Math.tan((42 / 2) * Math.PI / 180) * (390 / 844));
    const fContain = framingFractions(PORTRAIT, dContain);
    expect(fContain.heightFraction).toBeLessThan(0.2);
    expect(f.heightFraction).toBeGreaterThan(fContain.heightFraction);
  });

  it('NEVER crops the hall body in portrait (the flaw being fixed)', () => {
    // 我原先的 Q28(C) 方案在竖屏会切到大殿：填满高度时可见宽度只剩 17 m < 32.72 m。
    // 这条断言把"永不以切掉主体为代价"钉死。
    const d = cameraDistanceForViewport(PORTRAIT);
    const f = framingFractions(PORTRAIT, d);
    expect(f.visibleWidth).toBeGreaterThanOrEqual(FRAMING.hallBodyWidth);
    expect(f.visibleWidth).toBeGreaterThanOrEqual(FRAMING.minVisibleWidth - 1e-9);
    // 反证：填满高度的距离确实会切掉主体，故规则不能选它
    const dFillHeight = FRAMING.buildingHeight / 2 / Math.tan((42 / 2) * Math.PI / 180);
    const wAtFill = visibleWidthAt(dFillHeight, 390 / 844, 42);
    expect(wAtFill).toBeLessThan(FRAMING.hallBodyWidth);
  });

  it('satisfies BOTH constraints on every viewport in the agreed set', () => {
    const viewports: Viewport[] = [
      { width: 1280, height: 720 }, { width: 1920, height: 1080 }, { width: 2560, height: 1080 },
      { width: 3440, height: 1440 }, { width: 1024, height: 768 }, { width: 844, height: 390 },
      { width: 390, height: 844 }, { width: 360, height: 780 },
    ];
    for (const vp of viewports) {
      const d = cameraDistanceForViewport(vp);
      const f = framingFractions(vp, d);
      const label = `${vp.width}x${vp.height}`;
      expect(f.heightFraction, `${label} height fill`).toBeGreaterThanOrEqual(FRAMING.minHeightFraction - 1e-9);
      expect(f.visibleWidth, `${label} visible width`).toBeGreaterThanOrEqual(FRAMING.minVisibleWidth - 1e-9);
      expect(Number.isFinite(d) && d > 0, `${label} distance finite`).toBe(true);
    }
  });

  it('is deterministic: same viewport gives the same distance', () => {
    expect(cameraDistanceForViewport(PORTRAIT)).toBe(cameraDistanceForViewport(PORTRAIT));
  });

  it('rejects a degenerate viewport rather than returning NaN/Infinity', () => {
    expect(() => cameraDistanceForViewport({ width: 0, height: 720 })).toThrow();
    expect(() => cameraDistanceForViewport({ width: 1280, height: 0 })).toThrow();
    expect(() => cameraDistanceForViewport({ width: -100, height: -100 })).toThrow();
  });

  it('never places the camera inside the building', () => {
    for (const vp of [{ width: 1280, height: 720 }, { width: 390, height: 844 }] as Viewport[]) {
      const d = cameraDistanceForViewport(vp);
      expect(d).toBeGreaterThan(FRAMING.buildingHeight);   // 不能钻进建筑里
    }
  });
});

describe('framingFractions — reported metrics used by the layout gate', () => {
  it('returns widthFraction close to 1 when the width constraint binds', () => {
    const vp: Viewport = { width: 1280, height: 720 };
    const f = framingFractions(vp, cameraDistanceForViewport(vp));
    // 宽度约束生效时，台基恰好占满宽度
    expect(f.widthFraction).toBeCloseTo(1, 2);
    expect(f.mode).toBe('contain');
  });

  it('reports the mode it actually used, so the gate can assert on it', () => {
    expect(framingFractions({ width: 1280, height: 720 }, cameraDistanceForViewport({ width: 1280, height: 720 })).mode).toBe('contain');
    expect(framingFractions({ width: 390, height: 844 }, cameraDistanceForViewport({ width: 390, height: 844 })).mode).toBe('close-until-floor');
  });

  it('may let the terrace overflow in portrait, but the HALL BODY must always fit', () => {
    // 关键区分（Q30 的本意）：
    //  - 台基（90.3 m）在竖屏下**允许溢出**——这正是"靠近"的代价，widthFraction 会 >1；
    //  - 但大殿本体（32.72 m）**永不允许被切**，这是不可越过的底线。
    // 我起初写成"widthFraction <= 1"，那是错的：它会把 Q30 的核心行为判为失败。
    for (const vp of [
      { width: 1280, height: 720 }, { width: 390, height: 844 },
      { width: 2560, height: 1080 }, { width: 360, height: 780 },
    ] as Viewport[]) {
      const f = framingFractions(vp, cameraDistanceForViewport(vp));
      expect(f.visibleWidth, `${vp.width}x${vp.height} 大殿本体必须完整`).toBeGreaterThanOrEqual(FRAMING.hallBodyWidth - 1e-9);
      expect(f.visibleWidth, `${vp.width}x${vp.height} 可见宽度下限`).toBeGreaterThanOrEqual(FRAMING.minVisibleWidth - 1e-9);
    }
    // 并且确认竖屏下台基确实溢出（否则说明规则没有真的"靠近"）
    const portrait = { width: 390, height: 844 } as Viewport;
    const fp = framingFractions(portrait, cameraDistanceForViewport(portrait));
    expect(fp.widthFraction).toBeGreaterThan(1);
    expect(fp.mode).toBe('close-until-floor');
  });
});
