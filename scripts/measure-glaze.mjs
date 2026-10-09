// 量测**渲染结果**的蓝釉颜色，并与其考据基准（故宫博物院实测值）比对。
//
// 为什么必须量测渲染而非回读常量：把材质色常量再和基准比较是同义反复，永远相等。
// "光照是否把釉色照到了正确的亮度"只能从**渲染出的像素**上测得。
//
// 基准（考据值）：故宫博物院《清代官式建筑琉璃瓦件颜色与光泽量化表征研究》
//   天坛蓝釉标准样品  Lab(28.26, 5.87, −18.99)
//   容差：L* ∈ [24,34]，a* ∈ [1.87, 8.77]，b* ∈ [−25.36, −12.71]，90% 测量值 ΔE ≤ 3
//   该文图三即"天坛祈年殿屋面上的蓝釉琉璃瓦"。
//
// 注意：这是**合理性判据**，不是物理等同 —— 故宫值是釉面的比色读数，可能含镜面成分。
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const PALACE = { L: 28.26, a: 5.87, b: -18.99 };
const TOL = { L: [24, 34], a: [1.87, 8.77], b: [-25.36, -12.71] };

function srgbToLab(r, g, b) {
  const inv = (c) => { const u = c / 255; return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4); };
  const [R, G, B] = [inv(r), inv(g), inv(b)];
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

const png = PNG.sync.read(readFileSync(process.argv[2]));
const { width: W, height: H, data } = png;

// 蓝釉判别：蓝通道显著高于红，且中等偏暗（排除天空的亮蓝与台基的暖白）。
let n = 0, sr = 0, sg = 0, sb = 0;
const hist = new Map();
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (b > r + 8 && lum < 150 && lum > 15) {
      n++; sr += r; sg += g; sb += b;
      const band = Math.floor(lum / 10) * 10;
      const c = hist.get(band) ?? { n: 0, r: 0, g: 0, b: 0 };
      c.n++; c.r += r; c.g += g; c.b += b; hist.set(band, c);
    }
  }
}
if (n < 500) {
  console.log(JSON.stringify({ ok: false, reason: `only ${n} glaze pixels found`, pixels: n }));
  process.exit(0);
}
const mean = [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
const lab = srgbToLab(...mean).map((v) => +v.toFixed(2));
const inTol = {
  L: lab[0] >= TOL.L[0] && lab[0] <= TOL.L[1],
  a: lab[1] >= TOL.a[0] && lab[1] <= TOL.a[1],
  b: lab[2] >= TOL.b[0] && lab[2] <= TOL.b[1],
};
const dE = +Math.hypot(lab[0] - PALACE.L, lab[1] - PALACE.a, lab[2] - PALACE.b).toFixed(2);

// 中段（最接近"标准中心"的受光带）也要给出，便于人工判断
const bands = [...hist.entries()].sort((a, b) => a[0] - b[0])
  .map(([k, v]) => ({ lumBand: k, n: v.n, lab: srgbToLab(Math.round(v.r / v.n), Math.round(v.g / v.n), Math.round(v.b / v.n)).map((x) => +x.toFixed(1)) }));

console.log(JSON.stringify({
  ok: true,
  file: process.argv[2].replace(/.*[\\/]/, ''),
  glazePixels: n,
  meanRGB: mean,
  meanLab: lab,
  palace: PALACE,
  tolerance: TOL,
  inTolerance: inTol,
  allInTolerance: inTol.L && inTol.a && inTol.b,
  deltaE: dE,
  bands,
  caveat: '故宫值是釉面比色读数，可能含镜面成分；本判据是合理性检查而非物理等同',
}, null, 2));
