/**
 * A QR encoder that does exactly one thing: version 2, ECC level M,
 * alphanumeric mode, 25 × 25 modules.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY NOT THE `qrcode` PACKAGE.
 *
 * Because this is not a general encoder and must not become one. The station
 * display renders ONE payload shape — `GOTS1.<code>.<slot>.<mac>`, 36-37
 * characters, drawn entirely from QR's own alphanumeric charset — and a
 * general encoder would silently pick a LARGER symbol the day that payload
 * grows by one character. A larger symbol at the same physical panel size
 * means smaller modules, which means a member's phone stops decoding it from
 * arm's length, in a gym, at an angle, on a glossy screen. That failure would
 * arrive as "the scanner feels flaky lately" and nothing would point at the
 * cause.
 *
 * So the version is FIXED and `encodeStationQr` THROWS if the payload does not
 * fit. A build-time capacity error beats a silent scannability regression.
 *
 * The spec calls for version 2 / ECC M specifically. Version 3 or ECC Q is a
 * strictly larger symbol for no benefit on a pristine emissive screen that is
 * cleaned daily and viewed from half a metre.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Everything here is pure and synchronous. `qr.test.ts` round-trips its output
 * through `jsqr` — the same decoder the member's phone falls back to — so the
 * test oracle is a real decoder rather than a fixture of expected bits.
 */

/** QR's alphanumeric charset, in its canonical index order. */
const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/** Version 2 is 25 × 25. */
export const QR_SIZE = 25;

/**
 * Version 2, ECC M: 44 total codewords, 28 data and 16 error correction, in a
 * single block. The single block is why no interleaving is needed below.
 */
const DATA_CODEWORDS = 28;
const EC_CODEWORDS = 16;

/**
 * 38 alphanumeric characters. The mode indicator is 4 bits, the character
 * count indicator is 9 bits at this version, and alphanumeric packs two
 * characters into 11 bits: 4 + 9 + ceil(38/2 × 11) = 222 bits, which fits 28
 * codewords (224 bits) with 2 to spare.
 */
export const QR_ALPHANUMERIC_CAPACITY = 38;

export class QrCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QrCapacityError';
  }
}

/**
 * `true` is a dark module. Row-major, `matrix[y][x]`.
 */
export type QrMatrix = boolean[][];

/**
 * Encode one station payload.
 *
 * Throws `QrCapacityError` rather than growing the symbol — see the header.
 */
export function encodeStationQr(payload: string): QrMatrix {
  if (payload.length > QR_ALPHANUMERIC_CAPACITY) {
    throw new QrCapacityError(
      `Payload is ${payload.length} characters; version 2 / ECC M holds ${QR_ALPHANUMERIC_CAPACITY}. ` +
        'Growing the symbol would shrink every module and quietly break scanning at arm’s length.',
    );
  }

  const values: number[] = [];
  for (const char of payload) {
    const index = ALPHANUMERIC.indexOf(char);
    if (index === -1) {
      throw new QrCapacityError(
        `${JSON.stringify(char)} is not in QR's alphanumeric charset. ` +
          'The station payload is built from that charset on purpose; a lowercase or punctuation ' +
          'character here would force byte mode and overflow the symbol.',
      );
    }
    values.push(index);
  }

  const bits = new BitWriter();
  bits.write(0b0010, 4); // alphanumeric mode
  bits.write(values.length, 9); // character count, 9 bits for versions 1-9

  for (let i = 0; i + 1 < values.length; i += 2) {
    bits.write(values[i] * 45 + values[i + 1], 11);
  }
  if (values.length % 2 === 1) {
    bits.write(values[values.length - 1], 6);
  }

  const data = finishCodewords(bits);
  const codewords = [...data, ...reedSolomon(data, EC_CODEWORDS)];

  return renderMatrix(codewords);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bit and codeword assembly
// ─────────────────────────────────────────────────────────────────────────────

class BitWriter {
  readonly bits: number[] = [];

  write(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.bits.push((value >>> i) & 1);
    }
  }
}

/**
 * Terminator, byte alignment, then the alternating 0xEC / 0x11 pad bytes the
 * standard specifies. The pad pattern is not arbitrary decoration: a decoder
 * uses the character count to know where the data ends, and these bytes keep
 * the remaining codewords from forming an accidental low-penalty pattern.
 */
function finishCodewords(writer: BitWriter): number[] {
  const capacityBits = DATA_CODEWORDS * 8;
  const bits = writer.bits;

  for (let i = 0; i < 4 && bits.length < capacityBits; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b += 1) byte = (byte << 1) | bits[i + b];
    codewords.push(byte);
  }

  const PAD = [0xec, 0x11];
  while (codewords.length < DATA_CODEWORDS) {
    codewords.push(PAD[(codewords.length - bits.length / 8) % 2]);
  }

  return codewords;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reed-Solomon over GF(256), the QR field (primitive polynomial 0x11d)
// ─────────────────────────────────────────────────────────────────────────────

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(function buildTables(): void {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

function mul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

/** The generator polynomial for `degree` error-correction codewords. */
function generatorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= mul(poly[j], 1);
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function reedSolomon(data: readonly number[], degree: number): number[] {
  const generator = generatorPoly(degree);
  const remainder = new Array<number>(degree).fill(0);

  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < degree; i += 1) {
      remainder[i] ^= mul(generator[i + 1], factor);
    }
  }

  return remainder;
}

// ─────────────────────────────────────────────────────────────────────────────
// Module placement
// ─────────────────────────────────────────────────────────────────────────────

interface Grid {
  modules: (boolean | null)[][];
  /** Function patterns are immovable and must never be masked. */
  reserved: boolean[][];
}

function renderMatrix(codewords: readonly number[]): QrMatrix {
  const grid: Grid = {
    modules: Array.from({ length: QR_SIZE }, () => new Array<boolean | null>(QR_SIZE).fill(null)),
    reserved: Array.from({ length: QR_SIZE }, () => new Array<boolean>(QR_SIZE).fill(false)),
  };

  placeFinders(grid);
  placeAlignment(grid);
  placeTiming(grid);
  reserveFormat(grid);
  placeData(grid, codewords);

  // The mask is CHOSEN, not fixed. Each of the eight is scored by the
  // standard's four penalty rules and the lowest wins. A fixed mask still
  // decodes, but it can leave large same-colour runs or finder-like patterns
  // in the data region — which is exactly the kind of symbol that reads fine
  // on a desk and fails on a phone at an angle.
  let best: { matrix: QrMatrix; penalty: number } | null = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = applyMask(grid, mask);
    writeFormat(candidate, mask);
    const penalty = scorePenalty(candidate);
    if (best === null || penalty < best.penalty) best = { matrix: candidate, penalty };
  }

  return best!.matrix;
}

function placeFinders(grid: Grid): void {
  for (const [originY, originX] of [
    [0, 0],
    [0, QR_SIZE - 7],
    [QR_SIZE - 7, 0],
  ]) {
    // The 7x7 finder plus its one-module separator on the inward sides.
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const y = originY + dy;
        const x = originX + dx;
        if (y < 0 || y >= QR_SIZE || x < 0 || x >= QR_SIZE) continue;
        const inner = dy >= 0 && dy <= 6 && dx >= 0 && dx <= 6;
        const ring = inner && (dy === 0 || dy === 6 || dx === 0 || dx === 6);
        const core = inner && dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4;
        set(grid, y, x, ring || core);
      }
    }
  }
}

/** Version 2 has exactly one alignment pattern, centred at (18, 18). */
function placeAlignment(grid: Grid): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const dark = Math.max(Math.abs(dy), Math.abs(dx)) !== 1;
      set(grid, 18 + dy, 18 + dx, dark);
    }
  }
}

function placeTiming(grid: Grid): void {
  for (let i = 8; i < QR_SIZE - 8; i += 1) {
    const dark = i % 2 === 0;
    set(grid, 6, i, dark);
    set(grid, i, 6, dark);
  }
  // The dark module, always at (4 x version + 9, 8).
  set(grid, QR_SIZE - 8, 8, true);
}

/** Reserved now, written after the mask is chosen — the format encodes the mask. */
function reserveFormat(grid: Grid): void {
  for (let i = 0; i < 9; i += 1) {
    if (grid.modules[8][i] === null) set(grid, 8, i, false);
    if (grid.modules[i][8] === null) set(grid, i, 8, false);
  }
  for (let i = 0; i < 8; i += 1) {
    if (grid.modules[8][QR_SIZE - 1 - i] === null) set(grid, 8, QR_SIZE - 1 - i, false);
    if (grid.modules[QR_SIZE - 1 - i][8] === null) set(grid, QR_SIZE - 1 - i, 8, false);
  }
}

function set(grid: Grid, y: number, x: number, dark: boolean): void {
  if (y < 0 || y >= QR_SIZE || x < 0 || x >= QR_SIZE) return;
  grid.modules[y][x] = dark;
  grid.reserved[y][x] = true;
}

/**
 * The zig-zag: two-module-wide columns, right to left, alternating upward and
 * downward, skipping the vertical timing column at x = 6.
 */
function placeData(grid: Grid, codewords: readonly number[]): void {
  const bits: number[] = [];
  for (const byte of codewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1);
  }

  let bit = 0;
  let upward = true;

  for (let right = QR_SIZE - 1; right >= 1; right -= 2) {
    // The vertical timing column at x = 6 is SKIPPED ENTIRELY, which shifts
    // every pair to its left by one: the pairs are (24,23) … (8,7), then
    // (5,4), (3,2), (1,0). Reassigning `right` here rather than nudging a
    // local is what produces that shift — computing `column = right - 1` for
    // this one iteration and leaving `right` alone gives (5,4) followed by
    // (4,3), which writes column 4 twice and drops column 0. The symbol then
    // encodes most of the payload correctly and simply fails to decode, which
    // is the least debuggable outcome available.
    if (right === 6) right = 5;
    const column = right;
    for (let step = 0; step < QR_SIZE; step += 1) {
      const y = upward ? QR_SIZE - 1 - step : step;
      for (const x of [column, column - 1]) {
        if (grid.reserved[y][x]) continue;
        grid.modules[y][x] = bit < bits.length ? bits[bit] === 1 : false;
        bit += 1;
      }
    }
    upward = !upward;
  }
}

const MASKS: ((y: number, x: number) => boolean)[] = [
  (y, x) => (y + x) % 2 === 0,
  (y) => y % 2 === 0,
  (_y, x) => x % 3 === 0,
  (y, x) => (y + x) % 3 === 0,
  (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
  (y, x) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
  (y, x) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
];

function applyMask(grid: Grid, mask: number): QrMatrix {
  const rule = MASKS[mask];
  return grid.modules.map((row, y) =>
    row.map((value, x) => {
      const dark = value ?? false;
      return grid.reserved[y][x] ? dark : dark !== rule(y, x);
    }),
  );
}

/**
 * Format information: 5 bits (2 for ECC level, 3 for mask) expanded to 15 with
 * a BCH(15,5) code, XORed with the fixed 0x5412 mask, written TWICE so a
 * damaged corner still yields a readable symbol.
 */
function writeFormat(matrix: QrMatrix, mask: number): void {
  // ECC level M is 0b00 in the format's own encoding.
  const data = (0b00 << 3) | mask;
  let bch = data << 10;
  for (let i = 4; i >= 0; i -= 1) {
    if ((bch >>> (i + 10)) & 1) bch ^= 0b10100110111 << i;
  }
  const format = ((data << 10) | bch) ^ 0b101010000010010;

  const bitAt = (i: number): boolean => ((format >>> i) & 1) === 1;

  // ── Copy 1, around the top-left finder ──────────────────────────────────
  // Bits 0-8 run DOWN column 8; bits 9-14 run LEFT along row 8. The two axes
  // are NOT interchangeable, and swapping them is invisible to every
  // structural check: the symbol still has correct finders, timing, alignment
  // and data, and differs from a correct one by twelve modules — but a decoder
  // then reads a format word that is the bit-reversal of the real one, fails
  // its BCH check, and gives up without ever reaching the data. It presents as
  // "the QR just doesn't scan", pointing at nothing.
  for (let i = 0; i <= 5; i += 1) matrix[i][8] = bitAt(i);
  matrix[7][8] = bitAt(6);
  matrix[8][8] = bitAt(7);
  matrix[8][7] = bitAt(8);
  for (let i = 9; i <= 14; i += 1) matrix[8][14 - i] = bitAt(i);

  // ── Copy 2, split between the other two finders ─────────────────────────
  // Bits 0-7 run LEFT along row 8 from the right edge; bits 8-14 run DOWN
  // column 8 to the bottom edge. Two copies exist so a damaged or occluded
  // corner still yields a readable symbol.
  for (let i = 0; i <= 7; i += 1) matrix[8][QR_SIZE - 1 - i] = bitAt(i);
  for (let i = 8; i <= 14; i += 1) matrix[QR_SIZE - 15 + i][8] = bitAt(i);

  // The dark module survives the mask and the format write.
  matrix[QR_SIZE - 8][8] = true;
}

/**
 * The standard's four penalty rules. Lower is better.
 *
 * These exist to keep the data region from accidentally looking like a finder
 * pattern or forming large uniform blocks — both of which confuse a decoder
 * that is locating the symbol in a noisy camera frame.
 */
function scorePenalty(matrix: QrMatrix): number {
  let penalty = 0;

  // Rule 1: runs of five or more same-colour modules in a row or column.
  for (let i = 0; i < QR_SIZE; i += 1) {
    penalty += runPenalty(matrix[i]);
    penalty += runPenalty(matrix.map((row) => row[i]));
  }

  // Rule 2: every 2x2 block of one colour.
  for (let y = 0; y < QR_SIZE - 1; y += 1) {
    for (let x = 0; x < QR_SIZE - 1; x += 1) {
      const v = matrix[y][x];
      if (v === matrix[y][x + 1] && v === matrix[y + 1][x] && v === matrix[y + 1][x + 1]) {
        penalty += 3;
      }
    }
  }

  // Rule 3: the 1:1:3:1:1 finder-like pattern with four light modules either side.
  const FINDER = [true, false, true, true, true, false, true];
  const matches = (line: boolean[], at: number): boolean => {
    for (let i = 0; i < 7; i += 1) if (line[at + i] !== FINDER[i]) return false;
    const before = line.slice(Math.max(0, at - 4), at);
    const after = line.slice(at + 7, at + 11);
    return (
      (before.length === 4 && before.every((m) => !m)) ||
      (after.length === 4 && after.every((m) => !m))
    );
  };
  for (let i = 0; i < QR_SIZE; i += 1) {
    const row = matrix[i];
    const col = matrix.map((r) => r[i]);
    for (let at = 0; at + 7 <= QR_SIZE; at += 1) {
      if (matches(row, at)) penalty += 40;
      if (matches(col, at)) penalty += 40;
    }
  }

  // Rule 4: deviation from a 50/50 dark ratio.
  const dark = matrix.flat().filter(Boolean).length;
  const ratio = (dark * 100) / (QR_SIZE * QR_SIZE);
  penalty += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return penalty;
}

function runPenalty(line: boolean[]): number {
  let penalty = 0;
  let run = 1;
  for (let i = 1; i < line.length; i += 1) {
    if (line[i] === line[i - 1]) {
      run += 1;
      if (run === 5) penalty += 3;
      else if (run > 5) penalty += 1;
    } else {
      run = 1;
    }
  }
  return penalty;
}

/**
 * The matrix as one SVG `path` `d` attribute, one `M…h…v…h…z` per dark module.
 *
 * A path rather than 625 `<rect>` elements: the display repaints this every
 * thirty seconds for fourteen hours a day on a cheap tablet, and 625 DOM nodes
 * per repaint is how that tablet gets hot.
 */
export function qrPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  for (let y = 0; y < matrix.length; y += 1) {
    for (let x = 0; x < matrix[y].length; x += 1) {
      if (matrix[y][x]) parts.push(`M${x} ${y}h1v1h-1z`);
    }
  }
  return parts.join('');
}
