import { describe, it, expect } from 'vitest';
import {
  SOURCED,
  DERIVED,
  planSegmentStack,
  eaveRadii,
  assertSourcedCounts,
  stairwayLayout,
} from '../src/massing.js';

// ---------------------------------------------------------------------------------------
// Expected values in this file come from INDEPENDENT sources, never from re-running the
// implementation:
//   - sourced dimensions: SPEC.md / the fact sheet (each with a URL)
//   - the reference eave ratio: manual grid reading of a public-domain photograph
//   - total height: the user's explicit decision (Q19: 36.8 m)
// That is deliberate: a test whose expected value is computed the same way as the code is
// tautological and can never disagree with it.
// ---------------------------------------------------------------------------------------

describe('SOURCED dimensions (sourced values, each with a primary source)', () => {
  it('total height is the user-selected 36.8 m and equals hall body + terrace', () => {
    expect(SOURCED.totalHeight).toBeCloseTo(36.8, 6);
    expect(SOURCED.hallBodyHeight + SOURCED.terraceHeight).toBeCloseTo(SOURCED.totalHeight, 6);
  });

  it('hall body is 31.6 m and terrace 5.2 m (official self-consistent set)', () => {
    expect(SOURCED.hallBodyHeight).toBeCloseTo(31.6, 6);
    expect(SOURCED.terraceHeight).toBeCloseTo(5.2, 6);
  });

  it('hall body diameter is 32.72 m, distinct from the ~24 m eave-column ring', () => {
    expect(SOURCED.bodyDiameter).toBeCloseTo(32.72, 6);
    expect(SOURCED.eaveColumnRingDiameter).toBeCloseTo(24, 6);
    expect(SOURCED.bodyDiameter).not.toBeCloseTo(SOURCED.eaveColumnRingDiameter, 1);
  });

  it('terrace tier diameters are 68.2 / 79.3 / 90.3 m, increasing downward', () => {
    expect(SOURCED.terraceDiameters).toEqual([90.3, 79.3, 68.2]);
    // each step is ~11.05 m per the official figures
    expect(SOURCED.terraceDiameters[0] - SOURCED.terraceDiameters[1]).toBeCloseTo(11.0, 1);
    expect(SOURCED.terraceDiameters[1] - SOURCED.terraceDiameters[2]).toBeCloseTo(11.1, 1);
  });

  it('finial is 4.7 m tall and 1.9 m in diameter', () => {
    expect(SOURCED.finialHeight).toBeCloseTo(4.7, 6);
    expect(SOURCED.finialDiameter).toBeCloseTo(1.9, 6);
  });

  it('finial fits within the hall body height', () => {
    expect(SOURCED.finialHeight).toBeLessThan(SOURCED.hallBodyHeight);
  });
});

describe('SOURCED counts (form facts that must not silently regress)', () => {
  it('has 28 columns in three rings: 4 + 12 + 12', () => {
    expect(SOURCED.columns).toBe(28);
    expect(SOURCED.columnRings).toEqual([4, 12, 12]);
    expect(SOURCED.columnRings.reduce((a, b) => a + b, 0)).toBe(28);
  });

  it('has 8 stairways per terrace tier (北京文博 2000: 各出八陛)', () => {
    expect(SOURCED.stairwaysPerTier).toBe(8);
    const layout = stairwayLayout();
    // counts are the SOURCED part
    expect(layout).toHaveLength(8);
    expect(layout.filter((s) => s.face === 'south')).toHaveLength(3);
    expect(layout.filter((s) => s.face === 'north')).toHaveLength(3);
    expect(layout.filter((s) => s.face === 'east')).toHaveLength(1);
    expect(layout.filter((s) => s.face === 'west')).toHaveLength(1);
  });

  it('keeps the sourced stairway COUNT separate from the derived spacing', () => {
    // The source gives the count (3 south, 3 north, 1 + 1 sides) but no spacing, so the
    // offsets are constructed. They must live in DERIVED, not SOURCED, so that a reader can
    // tell which numbers are attested and which are ours.
    const layout = stairwayLayout();
    const spreads = layout.filter((s) => s.face === 'south').map((s) => s.offset);
    expect(spreads).toEqual([...DERIVED.stairwayOffsets]);
    expect(DERIVED.stairwayOffsets.length).toBe(3);
    // constructed offsets must be symmetric about the axis and non-overlapping
    expect(DERIVED.stairwayOffsets[0]).toBe(0);
    expect(DERIVED.stairwayOffsets[1]).toBe(-DERIVED.stairwayOffsets[2]);
  });

  it('builds 8 stairways on EVERY tier, i.e. 24 flights in total', () => {
    // The source says 三层坛体各出八陛 — all three tiers have eight. An earlier
    // implementation skipped the lowest tier, building only 16.
    const perTier = stairwayLayout().length;
    expect(perTier * SOURCED.terraceTiers).toBe(24);
  });

  it('has 108 balustrade panels per terrace tier (北京文博 2000: 各层栏板数均为一百零八块)', () => {
    expect(SOURCED.panelsPerTier).toBe(108);
    expect(SOURCED.terraceTiers).toBe(3);
  });

  it('has 3 glazed eave tiers', () => {
    expect(SOURCED.eaveTiers).toBe(3);
  });

  it('reports every checked count with a pass flag', () => {
    const checks = assertSourcedCounts();
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    for (const n of ['columns', 'panelsPerTier', 'stairwaysPerTier', 'eaveTiers', 'terraceTiers', 'columnRings']) {
      expect(byName[n], `missing check ${n}`).toBeDefined();
    }
    expect(checks.every((c) => c.ok)).toBe(true);
    // expectations must be independent literals, not recomputed from SOURCED
    expect(byName.columns.expected).toBe(28);
    expect(byName.panelsPerTier.expected).toBe(108);
  });

  it('assertSourcedCounts detects a corrupted count (proves the check can fail)', () => {
    const checks = assertSourcedCounts({ columns: 27 });
    const c = checks.find((x) => x.name === 'columns');
    expect(c?.ok).toBe(false);
    expect(c?.expected).toBe(28);
    expect(c?.actual).toBe(27);
  });
});

describe('planSegmentStack — heights close exactly (S1 seam)', () => {
  it('produces EXACTLY the target total height', () => {
    const { segments, totalHeight } = planSegmentStack();
    expect(totalHeight).toBeCloseTo(SOURCED.totalHeight, 6);
    const top = segments[segments.length - 1].top;
    expect(top).toBeCloseTo(SOURCED.totalHeight, 6);
  });

  it('has no gaps: every segment top meets the next segment bottom', () => {
    const { segments } = planSegmentStack();
    expect(segments.length).toBeGreaterThan(1);
    for (let i = 0; i < segments.length - 1; i++) {
      expect(
        Math.abs(segments[i].top - segments[i + 1].bottom),
        `gap between ${segments[i].name} and ${segments[i + 1].name}`,
      ).toBeLessThanOrEqual(1e-3);
    }
  });

  it('starts at the terrace top and alternates wall, eave, wall, eave, ...', () => {
    const { segments } = planSegmentStack();
    expect(segments[0].kind).toBe('wall');
    expect(segments[0].bottom).toBeCloseTo(SOURCED.terraceHeight, 6);
    const kinds = segments.filter((s) => s.kind === 'wall' || s.kind === 'eave').map((s) => s.kind);
    for (let i = 0; i < kinds.length; i++) {
      expect(kinds[i], `segment ${i} should alternate`).toBe(i % 2 === 0 ? 'wall' : 'eave');
    }
  });

  it('ends with the finial occupying exactly finialHeight metres', () => {
    const { segments } = planSegmentStack();
    const finial = segments.find((s) => s.kind === 'finial');
    expect(finial).toBeDefined();
    expect(finial!.top - finial!.bottom).toBeCloseTo(SOURCED.finialHeight, 6);
    expect(finial!.top).toBeCloseTo(SOURCED.totalHeight, 6);
  });

  it('has 3 wall bands and 3 eave tiers, matching the sourced tier count', () => {
    const { segments } = planSegmentStack();
    expect(segments.filter((s) => s.kind === 'wall')).toHaveLength(3);
    expect(segments.filter((s) => s.kind === 'eave')).toHaveLength(3);
    expect(segments.filter((s) => s.kind === 'wall')).toHaveLength(SOURCED.eaveTiers);
  });

  it('storey heights decrease upward (下大上小, as the photographs show)', () => {
    const { segments } = planSegmentStack();
    const walls = segments.filter((s) => s.kind === 'wall').map((s) => s.height);
    expect(walls).toHaveLength(3);
    expect(walls[0]).toBeGreaterThan(walls[1]);
    expect(walls[1]).toBeGreaterThan(walls[2]);
  });

  it('is a pure function: same inputs give the same output (determinism)', () => {
    const a = planSegmentStack();
    const b = planSegmentStack();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('closes for the alternative 38 m total too (the disputed figure stays buildable)', () => {
    // Q19 chose 36.8, but the source conflict is real, so the planner must not be hard-wired
    // to one number. A different total must still produce an exactly-closed stack.
    const { totalHeight, segments } = planSegmentStack({ totalHeight: 38.0 });
    expect(totalHeight).toBeCloseTo(38.0, 6);
    for (let i = 0; i < segments.length - 1; i++) {
      expect(Math.abs(segments[i].top - segments[i + 1].bottom)).toBeLessThanOrEqual(1e-3);
    }
    expect(segments[segments.length - 1].top).toBeCloseTo(38.0, 6);
  });

  it('rejects an impossible configuration rather than returning garbage', () => {
    // a total height smaller than terrace + finial cannot host any storeys
    expect(() => planSegmentStack({ totalHeight: 5.0 })).toThrow();
  });

  it('exposes ground-level closure: first segment starts at terrace top, terrace at 0', () => {
    const { segments } = planSegmentStack();
    expect(segments[0].bottom).toBeGreaterThan(0);
    expect(segments[0].bottom).toBeCloseTo(SOURCED.terraceHeight, 6);
  });
});

describe('eaveRadii — overhang ratio from the reference reading (S2 seam)', () => {
  it('matches the photographed ratio 0.64 : 0.86 : 1.00 within 0.01', () => {
    // Expected values are independent literals read off a photograph, NOT recomputed from
    // DERIVED.eaveRatioTopToBottom — otherwise this could never disagree with the code.
    const [rTop, rMid, rBot] = eaveRadii();
    expect(rTop / rBot).toBeCloseTo(0.64, 2);
    expect(rMid / rBot).toBeCloseTo(0.86, 2);
    // the bottom tier defines the scale, so its ratio is 1 by construction; assert the
    // absolute radius instead, which is a real constraint rather than x/x.
    expect(rBot).toBeCloseTo(DERIVED.bottomEaveRadius, 6);
  });

  it('scales all three radii proportionally when the bottom radius changes', () => {
    // A genuine invariant: doubling the reference radius must double every tier.
    const a = eaveRadii();
    const b = eaveRadii({ bottomRadius: DERIVED.bottomEaveRadius * 2 });
    for (let i = 0; i < 3; i++) expect(b[i] / a[i]).toBeCloseTo(2, 6);
  });

  it('orders the radii bottom > middle > top', () => {
    const [rTop, rMid, rBot] = eaveRadii();
    expect(rBot).toBeGreaterThan(rMid);
    expect(rMid).toBeGreaterThan(rTop);
  });

  it('every eave overhangs its wall band (radius greater than the wall it caps)', () => {
    const [rTop, rMid, rBot] = eaveRadii();
    const { segments } = planSegmentStack();
    const wallRadii = segments.filter((s) => s.kind === 'wall').map((s) => s.wallRadius!);
    expect(rBot).toBeGreaterThan(wallRadii[0]);
    expect(rMid).toBeGreaterThan(wallRadii[1]);
    expect(rTop).toBeGreaterThan(wallRadii[2]);
  });

  it('is pure and applies the reference ratio at any bottom radius', () => {
    expect(eaveRadii()).toEqual(eaveRadii());
    // at a bottom radius of 40, the top tier must land at 0.64 * 40 = 25.6 (independent
    // literal), and the middle at 0.86 * 40 = 34.4 — not just "c[2] equals what we passed".
    const c = eaveRadii({ bottomRadius: 40 });
    expect(c[0]).toBeCloseTo(25.6, 6);
    expect(c[1]).toBeCloseTo(34.4, 6);
    expect(c[2]).toBeCloseTo(40, 6);
  });
});
