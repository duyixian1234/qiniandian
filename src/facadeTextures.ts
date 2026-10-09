// Procedural facade textures, generated on a canvas at load time.
//
// WHY PROCEDURAL: the project must be offline-self-contained, and no CC0 texture set exists for
// Chinese architectural 隔扇 lattice or 和玺彩画 (the fact sheet records that no hex/RGB source
// exists for the 彩画 palette either). Generating them from code keeps the build offline and the
// result deterministic.
//
// HONESTY NOTE: the 彩画 colours below are ARTISTIC APPROXIMATIONS using the traditional palette
// names (石青 azurite blue, 石绿 malachite green, 库金 gold, 章丹 vermilion). They are NOT
// measured values and must be labelled as constructed, unlike the roof glaze which has a
// sourced Lab reading. No randomness is used, so screenshots stay reproducible.
import * as THREE from 'three';

/** Deterministic canvas: no Math.random, no Date. */
function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  return { c, ctx };
}

function toTexture(c: HTMLCanvasElement, repeatX = 1, repeatY = 1) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  // Default is ONE mapping around the cylinder: a cylinder's UV runs 0..1 around its
  // circumference, so repeat(1,1) lays the whole painted band once around the building.
  // Tiling it would multiply the door and motif count well beyond the real 12 bays.
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 8;
  return t;
}

// ---- 隔扇门/槛窗 lattice ---------------------------------------------------------------
// The reference photographs show the lower wall band filled with timber lattice doors, whose
// 格心 (upper lattice) carries a fine grid while the 裙板 (lower panel) is solid. Gold/ochre
// lattice on a dark vermilion ground.
export function latticeTexture(cols = 12, rows = 6): THREE.Texture {
  const W = 1024, H = 512;
  const { c, ctx } = makeCanvas(W, H);
  // dark vermilion ground
  ctx.fillStyle = '#5e1f16';
  ctx.fillRect(0, 0, W, H);

  const cw = W / cols, ch = H / rows;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = i * cw, y = j * ch;
      // 裙板 (lower third of each leaf) is solid with a bevelled frame
      const isSkirt = j >= rows - 2;
      if (isSkirt) {
        ctx.fillStyle = '#6b2418';
        ctx.fillRect(x + 3, y + 3, cw - 6, ch - 6);
        ctx.strokeStyle = '#a8763a';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 8, y + 8, cw - 16, ch - 16);
      } else {
        // 格心: lattice of crossed bars (three-tier 菱花-like grid, simplified)
        ctx.fillStyle = '#7a2a1c';
        ctx.fillRect(x + 2, y + 2, cw - 4, ch - 4);
        ctx.strokeStyle = '#c9a24a';
        ctx.lineWidth = 2.5;
        const cells = 4;
        const sx = (cw - 8) / cells, sy = (ch - 8) / cells;
        for (let a = 0; a <= cells; a++) {
          ctx.beginPath(); ctx.moveTo(x + 4 + a * sx, y + 4); ctx.lineTo(x + 4 + a * sx, y + ch - 4); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(x + 4, y + 4 + a * sy); ctx.lineTo(x + cw - 4, y + 4 + a * sy); ctx.stroke();
        }
        // small diagonal accents so the grid is not a plain mesh
        ctx.strokeStyle = '#8c6a2c';
        ctx.lineWidth = 1.5;
        for (let a = 0; a < cells; a++) {
          ctx.beginPath(); ctx.moveTo(x + 4 + a * sx, y + 4); ctx.lineTo(x + 4 + (a + 1) * sx, y + 4 + sy); ctx.stroke();
        }
      }
    }
  }
  return toTexture(c, 1, 1);
}

// ---- 和玺彩画 band ----------------------------------------------------------------------
// Horizontal painted band: alternating 石青 (blue) and 石绿 (green) fields framed by 库金 (gold)
// dividing lines, with a repeating floral/cloud motif. Applied below each eave and above the
// doors. Colours are approximate (see honesty note at the top of this file).
export function caihuaTexture(segments = 24): THREE.Texture {
  const W = 2048, H = 256;
  const { c, ctx } = makeCanvas(W, H);
  const BLUE = '#2f4f8f', GREEN = '#2f6b52', GOLD = '#c9a24a', INK = '#1b2a3a';

  ctx.fillStyle = INK; ctx.fillRect(0, 0, W, H);
  const sw = W / segments;
  for (let i = 0; i < segments; i++) {
    const x = i * sw;
    const field = i % 2 === 0 ? BLUE : GREEN;
    // main field
    ctx.fillStyle = field;
    ctx.fillRect(x + 6, 26, sw - 12, H - 52);
    // gold frame bands top and bottom
    ctx.fillStyle = GOLD;
    ctx.fillRect(x, 0, sw, 22);
    ctx.fillRect(x, H - 22, sw, 22);
    // divider between segments
    ctx.fillRect(x, 22, 4, H - 44);
    // a stylised cloud/floral medallion in the centre (concentric lobes)
    const cx = x + sw / 2, cy = H / 2;
    for (let ring = 3; ring >= 1; ring--) {
      ctx.beginPath();
      const rr = (H - 70) / 2 * (ring / 3);
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.fillStyle = ring === 3 ? GOLD : (ring === 2 ? '#dfe7ef' : field);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fillStyle = GOLD; ctx.fill();
  }
  return toTexture(c, 1, 1);
}
