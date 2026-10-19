/**
 * Tiny dependency-free QR code encoder (byte mode, ECC level L or M, versions 1-40) that renders to SVG.
 * Port of the well-known reference algorithm (Nayuki's QR Code generator, MIT). Used for Solana Pay payment QR codes
 * so the RugRadar page needs no client-side QR library.
 */
export type Ecl = "L" | "M";
const ECL = { L: { ord: 0, fmt: 1 }, M: { ord: 1, fmt: 0 } } as const;
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
];
const NUM_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
];
const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;
function rawModules(ver: number) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; }
  return r;
}
const dataCodewords = (ver: number, e: number) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[e]![ver]! * NUM_BLOCKS[e]![ver]!;
function gfMul(x: number, y: number) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z; }
function rsDivisor(deg: number) {
  const r = new Array<number>(deg).fill(0); r[deg - 1] = 1; let root = 1;
  for (let i = 0; i < deg; i++) { for (let j = 0; j < deg; j++) { r[j] = gfMul(r[j]!, root); if (j + 1 < deg) r[j]! ^= r[j + 1]!; } root = gfMul(root, 2); }
  return r;
}
function rsRemainder(data: number[], div: number[]) {
  const r = div.map(() => 0);
  for (const b of data) { const f = b ^ r.shift()!; r.push(0); div.forEach((c, i) => (r[i]! ^= gfMul(c, f))); }
  return r;
}

/** Returns the module matrix (true = dark), row-major [y][x]. Throws if the text is too long for version 40. */
export function qrMatrix(text: string, ecl: Ecl = "M"): boolean[][] {
  const e = ECL[ecl].ord, bytes = [...Buffer.from(text, "utf8")];
  let ver = 1;
  for (; ; ver++) { if (ver > 40) throw new Error("qr_too_long"); if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(ver, e) * 8) break; }
  const bits: number[] = [], push = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  push(4, 4); push(bytes.length, ver < 10 ? 8 : 16); bytes.forEach((b) => push(b, 8));
  const cap = dataCodewords(ver, e) * 8;
  push(0, Math.min(4, cap - bits.length)); push(0, (8 - (bits.length % 8)) % 8);
  for (let p = 0xec; bits.length < cap; p ^= 0xec ^ 0x11) push(p, 8);
  const data: number[] = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  // ECC + interleave
  const nb = NUM_BLOCKS[e]![ver]!, eccLen = ECC_PER_BLOCK[e]![ver]!, raw = Math.floor(rawModules(ver) / 8), nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  const div = rsDivisor(eccLen), blocks: number[][] = [];
  for (let i = 0, k = 0; i < nb; i++) { const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1)); k += dat.length; const ecc = rsRemainder(dat, div); if (i < nShort) dat.push(0); blocks.push(dat.concat(ecc)); }
  const all: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) all.push(b[i]!); });
  // function patterns
  const size = ver * 4 + 17, m = Array.from({ length: size }, () => new Array<boolean>(size).fill(false)), fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, d: boolean) => { m[y]![x] = d; fn[y]![x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const)
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy)); if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4); }
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2, step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2, pos = [6];
    for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(pos[i]! + dx, pos[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const drawFormat = (mask: number) => {
    const d = (ECL[ecl].fmt << 3) | mask; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412;
    for (let i = 0; i <= 5; i++) set(8, i, bit(b, i));
    set(8, 7, bit(b, 6)); set(8, 8, bit(b, 7)); set(7, 8, bit(b, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(b, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(b, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(b, i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let r = ver; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const b = (ver << 12) | r;
    for (let i = 0; i < 18; i++) { const a = size - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, bit(b, i)); set(c, a, bit(b, i)); }
  }
  // data
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
      if (!fn[y]![x] && i < all.length * 8) { m[y]![x] = bit(all[i >>> 3]!, 7 - (i & 7)); i++; }
    }
  }
  // mask: pick the lowest penalty (runs, 2x2 blocks, dark balance)
  const inv = (k: number, x: number, y: number) => [(x + y) % 2 === 0, y % 2 === 0, x % 3 === 0, (x + y) % 3 === 0, (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, ((x * y) % 2) + ((x * y) % 3) === 0, (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (((x + y) % 2) + ((x * y) % 3)) % 2 === 0][k]!;
  const apply = (k: number) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y]![x] && inv(k, x, y)) m[y]![x] = !m[y]![x]; };
  const penalty = () => {
    let p = 0, dark = 0;
    for (let a = 0; a < size; a++) {
      let rx = 1, ry = 1;
      for (let b = 1; b < size; b++) {
        if (m[a]![b] === m[a]![b - 1]) { rx++; if (rx === 5) p += 3; else if (rx > 5) p++; } else rx = 1;
        if (m[b]![a] === m[b - 1]![a]) { ry++; if (ry === 5) p += 3; else if (ry > 5) p++; } else ry = 1;
      }
    }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { if (m[y]![x]) dark++; if (x < size - 1 && y < size - 1 && m[y]![x] === m[y]![x + 1] && m[y]![x] === m[y + 1]![x] && m[y]![x] === m[y + 1]![x + 1]) p += 3; }
    return p + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  };
  let best = 0, bestP = Infinity;
  for (let k = 0; k < 8; k++) { apply(k); drawFormat(k); const p = penalty(); if (p < bestP) { bestP = p; best = k; } apply(k); }
  apply(best); drawFormat(best);
  return m;
}

/** Compact SVG (one path, horizontal runs merged, 4-module quiet zone). */
export function qrSvg(text: string, opts: { ecl?: Ecl; px?: number; dark?: string; light?: string } = {}) {
  const m = qrMatrix(text, opts.ecl ?? "M"), n = m.length, q = 4, w = n + 2 * q;
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; ) {
    if (!m[y]![x]) { x++; continue; }
    let l = 1; while (x + l < n && m[y]![x + l]) l++;
    d += `M${x + q} ${y + q}h${l}v1h-${l}z`; x += l;
  }
  const px = opts.px ?? 240;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${w}" width="${px}" height="${px}" shape-rendering="crispEdges"><rect width="${w}" height="${w}" fill="${opts.light ?? "#fff"}"/><path d="${d}" fill="${opts.dark ?? "#000"}"/></svg>`;
}
