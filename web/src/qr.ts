/** Pure-TS ISO-18004 QR code encoder (Version 1-10, Byte mode, ECC-L). */

type BlockSpec = readonly [count: number, dataCodewords: number];
interface VersionSpec {
  version: number;
  totalData: number;
  ecPerBlock: number;
  blocks: readonly BlockSpec[];
  align: readonly number[];
}

const VERSIONS: readonly VersionSpec[] = [
  { version: 1, totalData: 19, ecPerBlock: 7, blocks: [[1, 19]], align: [] },
  { version: 2, totalData: 34, ecPerBlock: 10, blocks: [[1, 34]], align: [6, 18] },
  { version: 3, totalData: 55, ecPerBlock: 15, blocks: [[1, 55]], align: [6, 22] },
  { version: 4, totalData: 80, ecPerBlock: 20, blocks: [[1, 80]], align: [6, 26] },
  { version: 5, totalData: 108, ecPerBlock: 26, blocks: [[1, 108]], align: [6, 30] },
  { version: 6, totalData: 136, ecPerBlock: 18, blocks: [[2, 68]], align: [6, 34] },
  { version: 7, totalData: 156, ecPerBlock: 20, blocks: [[2, 78]], align: [6, 22, 38] },
  { version: 8, totalData: 194, ecPerBlock: 24, blocks: [[2, 97]], align: [6, 24, 42] },
  { version: 9, totalData: 232, ecPerBlock: 30, blocks: [[2, 116]], align: [6, 26, 46] },
  { version: 10, totalData: 274, ecPerBlock: 18, blocks: [[2, 68], [2, 69]], align: [6, 28, 50] },
];

const FORMAT_BITS_L = [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976];
const VERSION_BITS: Record<number, number> = {
  7: 0x07c94,
  8: 0x085bc,
  9: 0x09a99,
  10: 0x0a4d3,
};

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    EXP[i + 255] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
}

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

function rsGenerator(ecLen: number): number[] {
  let poly = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    const alpha = EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], alpha);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: number[], ecLen: number): number[] {
  const gen = rsGenerator(ecLen);
  const res = [...data, ...new Array<number>(ecLen).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const factor = res[i];
    if (factor !== 0) {
      for (let j = 1; j < gen.length; j++) {
        res[i + j] ^= gfMul(gen[j], factor);
      }
    }
  }
  return res.slice(data.length);
}

function encodeCodewords(payload: Uint8Array): {
  version: number;
  align: readonly number[];
  codewords: number[];
} {
  const n = payload.length;
  const spec = VERSIONS.find((v) => {
    const countBits = v.version <= 9 ? 8 : 16;
    return 4 + countBits + n * 8 <= v.totalData * 8;
  });
  if (!spec) {
    throw new Error(`QR payload too long (${n} bytes)`);
  }

  const bits: number[] = [];
  const pushBits = (val: number, width: number) => {
    for (let shift = width - 1; shift >= 0; shift--) {
      bits.push((val >> shift) & 1);
    }
  };

  pushBits(0b0100, 4);
  pushBits(n, spec.version <= 9 ? 8 : 16);
  for (const b of payload) pushBits(b, 8);
  const rem = spec.totalData * 8 - bits.length;
  pushBits(0, Math.min(4, rem));
  while (bits.length % 8 !== 0) bits.push(0);

  const dataCw: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byteVal = 0;
    for (let k = 0; k < 8; k++) byteVal = (byteVal << 1) | bits[i + k];
    dataCw.push(byteVal);
  }
  const pads = [0xec, 0x11];
  let padIdx = 0;
  while (dataCw.length < spec.totalData) {
    dataCw.push(pads[padIdx & 1]);
    padIdx += 1;
  }

  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (const [count, bw] of spec.blocks) {
    for (let i = 0; i < count; i++) {
      const blk = dataCw.slice(offset, offset + bw);
      offset += bw;
      dataBlocks.push(blk);
      ecBlocks.push(rsRemainder(blk, spec.ecPerBlock));
    }
  }

  const out: number[] = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const ecb of ecBlocks) out.push(ecb[i]);
  }
  return { version: spec.version, align: spec.align, codewords: out };
}

const MASK_FNS: readonly ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penaltyScore(mat: boolean[][]): number {
  const n = mat.length;
  let score = 0;

  for (const isRow of [true, false]) {
    for (let i = 0; i < n; i++) {
      let run = 1;
      let prev = isRow ? mat[i][0] : mat[0][i];
      for (let j = 1; j < n; j++) {
        const cur = isRow ? mat[i][j] : mat[j][i];
        if (cur === prev) {
          run += 1;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else {
          prev = cur;
          run = 1;
        }
      }
    }
  }

  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = mat[r][c];
      if (v === mat[r][c + 1] && v === mat[r + 1][c] && v === mat[r + 1][c + 1]) {
        score += 3;
      }
    }
  }

  const p1 = [true, false, true, true, true, false, true, false, false, false, false];
  const p2 = [false, false, false, false, true, false, true, true, true, false, true];
  const matchAt = (arr: boolean[], start: number, pat: boolean[]) => {
    for (let k = 0; k < 11; k++) if (arr[start + k] !== pat[k]) return false;
    return true;
  };
  for (let i = 0; i < n; i++) {
    const row = mat[i];
    const col = mat.map((r) => r[i]);
    for (let c = 0; c <= n - 11; c++) {
      if (matchAt(row, c, p1) || matchAt(row, c, p2)) score += 40;
      if (matchAt(col, c, p1) || matchAt(col, c, p2)) score += 40;
    }
  }

  let dark = 0;
  for (const row of mat) for (const v of row) if (v) dark += 1;
  const pct = Math.floor((dark * 100) / (n * n));
  const lo = Math.floor(Math.abs(Math.floor(pct / 5) * 5 - 50) / 5);
  const hi = Math.floor(Math.abs(Math.floor((pct + 4) / 5) * 5 - 50) / 5);
  score += Math.min(lo, hi) * 10;
  return score;
}

function stampFormat(mat: boolean[][], size: number, maskId: number): void {
  const bits = FORMAT_BITS_L[maskId];
  for (let i = 0; i < 15; i++) {
    const bit = Boolean((bits >> i) & 1);
    if (i < 6) mat[8][i] = bit;
    else if (i < 8) mat[8][i + 1] = bit;
    else mat[8][size - 15 + i] = bit;

    if (i < 8) mat[size - 1 - i][8] = bit;
    else if (i === 8) mat[7][8] = bit;
    else mat[14 - i][8] = bit;
  }
}

function stampVersion(mat: boolean[][], size: number, version: number): void {
  const bits = VERSION_BITS[version];
  if (bits === undefined) return;
  for (let i = 0; i < 18; i++) {
    const bit = Boolean((bits >> i) & 1);
    const r = Math.floor(i / 3);
    const c = size - 11 + (i % 3);
    mat[r][c] = bit;
    mat[c][r] = bit;
  }
}

/** Encode ``text`` into a square boolean QR matrix (true = dark module). */
export function encodeQrMatrix(text: string): boolean[][] {
  const payload = new TextEncoder().encode(text);
  const { version, align, codewords } = encodeCodewords(payload);
  const size = version * 4 + 17;
  const base: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const setFn = (r: number, c: number, val: boolean) => {
    base[r][c] = val;
    reserved[r][c] = true;
  };

  for (const [fr, fc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = fr + dr;
        const cc = fc + dc;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inOuter = (dr === 0 || dr === 6) && dc >= 0 && dc <= 6;
        const inSide = (dc === 0 || dc === 6) && dr >= 0 && dr <= 6;
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFn(rr, cc, inOuter || inSide || inCore);
      }
    }
  }

  for (const ar of align) {
    for (const ac of align) {
      if (
        (ar === align[0] && ac === align[0]) ||
        (ar === align[0] && ac === align[align.length - 1]) ||
        (ar === align[align.length - 1] && ac === align[0])
      ) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          setFn(ar + dr, ac + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    const val = i % 2 === 0;
    setFn(6, i, val);
    setFn(i, 6, val);
  }
  setFn(version * 4 + 9, 8, true);

  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      reserved[8][i] = true;
      reserved[i][8] = true;
    }
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      reserved[r][c] = true;
      reserved[c][r] = true;
    }
  }

  const bitStream: boolean[] = [];
  for (const cw of codewords) {
    for (let shift = 7; shift >= 0; shift--) {
      bitStream.push(Boolean((cw >> shift) & 1));
    }
  }

  let bitIdx = 0;
  let up = true;
  let col = size - 1;
  while (col > 0) {
    if (col === 6) col -= 1;
    for (let step = 0; step < size; step++) {
      const r = up ? size - 1 - step : step;
      for (const dc of [0, -1]) {
        const c = col + dc;
        if (!reserved[r][c]) {
          base[r][c] = bitIdx < bitStream.length ? bitStream[bitIdx] : false;
          bitIdx += 1;
        }
      }
    }
    up = !up;
    col -= 2;
  }

  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let maskId = 0; maskId < MASK_FNS.length; maskId++) {
    const pred = MASK_FNS[maskId];
    const cand = base.map((row, r) =>
      row.map((val, c) => (reserved[r][c] ? val : val !== pred(r, c)))
    );
    stampFormat(cand, size, maskId);
    if (version >= 7) stampVersion(cand, size, version);
    const sc = penaltyScore(cand);
    if (sc < bestScore) {
      bestScore = sc;
      best = cand;
    }
  }
  return best!;
}

/** Combined SVG path ``d`` string for all dark modules (with quiet zone offset). */
export function qrSvgPath(mat: boolean[][], quiet = 4): string {
  const parts: string[] = [];
  for (let r = 0; r < mat.length; r++) {
    const row = mat[r];
    for (let c = 0; c < row.length; c++) {
      if (row[c]) {
        parts.push(`M${c + quiet},${r + quiet}h1v1h-1z`);
      }
    }
  }
  return parts.join("");
}

/** Deterministic standalone CSP-clean SVG markup string for ``text``. */
export function qrToSvgMarkup(text: string, quiet = 4): string {
  const mat = encodeQrMatrix(text);
  const total = mat.length + quiet * 2;
  const d = qrSvgPath(mat, quiet);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="Pairing QR code">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
    `<path d="${d}" fill="#000000"/>` +
    `</svg>`
  );
}
