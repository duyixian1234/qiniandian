// 从**渲染出的剪影图像**量测三重檐出挑比。
//
// 为什么需要它：如果把 scene.ts 里用于建模的常量再读出来和参考值比较，
// 那是**同义反复**——它永远相等，永远不可能发现几何错误。
// 参考值（0.64:0.86:1.00，人工读图）必须与**渲染结果的实测**比较，检查才有意义。
//
// 做法：俯视剪影里逐行取结构宽度，找三个"檐口出挑"峰（排除台基）。
// 这与 .probe/tier-ratios.mjs 同一思路，但作用于本项目的输出。
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const png = PNG.sync.read(readFileSync(process.argv[2]));
const { width: W, height: H, data } = png;
const isSolid = (o) => data[o] < 128;   // 剪影：黑=建筑，白=背景

const rowW = new Int32Array(H), rowHas = new Uint8Array(H);
for (let y = 0; y < H; y++) {
  let lo = -1, hi = -1;
  for (let x = 0; x < W; x++) {
    if (isSolid((y * W + x) * 4)) { if (lo < 0) lo = x; hi = x; }
  }
  if (hi >= 0) { rowW[y] = hi - lo + 1; rowHas[y] = 1; }
}

let minY = -1, maxY = -1;
for (let y = 0; y < H; y++) if (rowHas[y]) { if (minY < 0) minY = y; maxY = y; }
if (minY < 0) { console.log(JSON.stringify({ ok: false, reason: 'no solid rows' })); process.exit(0); }

// 平滑后取局部极大值
const K = 4;
const sm = new Float64Array(H);
for (let y = 0; y < H; y++) {
  let s = 0, n = 0;
  for (let j = Math.max(0, y - K); j <= Math.min(H - 1, y + K); j++) { s += rowW[j]; n++; }
  sm[y] = s / n;
}
const peaks = [];
for (let y = minY + 3; y <= maxY - 3; y++) {
  if (sm[y] < 20) continue;
  let isMax = true;
  for (let j = y - 5; j <= y + 5; j++) if (j !== y && sm[j] > sm[y]) { isMax = false; break; }
  if (isMax) peaks.push({ y, w: Math.round(sm[y]) });
}
const merged = [];
for (const p of peaks) {
  const last = merged[merged.length - 1];
  if (last && p.y - last.y < 12) { if (p.w > last.w) merged[merged.length - 1] = p; }
  else merged.push(p);
}

// 排除台基：台基占建筑总高的下方约 14%（5.2/36.8），且是全局最宽的特征。
// 只看上方 72%，并强制峰间距，避免把墙段误当檐口。
const terraceCut = minY + (maxY - minY) * 0.72;
const minSep = Math.round((maxY - minY) * 0.12);
const cand = merged.filter((p) => p.y < terraceCut).sort((a, b) => b.w - a.w);
const chosen = [];
for (const p of cand) {
  if (chosen.length >= 3) break;
  if (chosen.every((c) => Math.abs(c.y - p.y) >= minSep)) chosen.push(p);
}
const top3 = chosen.sort((a, b) => a.y - b.y);
if (top3.length < 3) {
  console.log(JSON.stringify({ ok: false, reason: `found ${top3.length} eave peaks, need 3`, peaks: merged }));
  process.exit(0);
}
const widest = top3[2].w;
const ratios = top3.map((p) => +(p.w / widest).toFixed(3));
const ref = [0.64, 0.86, 1.0];
const diffs = ratios.map((v, i) => +Math.abs(v - ref[i]).toFixed(4));
console.log(JSON.stringify({
  ok: true, ratios, reference: ref, diffs, worst: Math.max(...diffs),
  peaks: top3.map((p) => ({ y: p.y, width: p.w })),
}, null, 2));
