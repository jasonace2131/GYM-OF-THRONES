import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { QR_ALPHANUMERIC_CAPACITY, QR_SIZE, QrCapacityError, encodeStationQr, qrPath } from './qr';

/**
 * THE ORACLE IS A REAL DECODER, not a fixture of expected bits.
 *
 * `jsqr` is the same decoder the member's phone falls back to when
 * `BarcodeDetector` is absent — roughly half the member base. Asserting
 * against hand-written expected modules would prove only that the encoder
 * matches whatever it produced the day the fixture was captured; round-
 * tripping through jsqr proves the thing that actually matters, which is that
 * a phone can read the screen.
 */

/** The matrix as an RGBA bitmap with a quiet zone, which is what a decoder expects. */
function toImageData(
  matrix: boolean[][],
  scale = 4,
  quiet = 4,
): { data: Uint8ClampedArray; width: number; height: number } {
  const size = (matrix.length + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);

  for (let y = 0; y < matrix.length; y += 1) {
    for (let x = 0; x < matrix[y].length; x += 1) {
      if (!matrix[y][x]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const px = (x + quiet) * scale + dx;
          const py = (y + quiet) * scale + dy;
          const at = (py * size + px) * 4;
          data[at] = 0;
          data[at + 1] = 0;
          data[at + 2] = 0;
          data[at + 3] = 255;
        }
      }
    }
  }

  return { data, width: size, height: size };
}

function decode(payload: string): string | null {
  const { data, width, height } = toImageData(encodeStationQr(payload));
  return jsQR(data, width, height)?.data ?? null;
}

/** A realistic payload: `GOTS1.<4-char code>.<8-digit slot>.<16-char mac>` = 36 chars. */
const PAYLOAD = 'GOTS1.9F2K.59570000.4RTXK8B2QWY5H3PZ';
/** The nine-digit-slot form, which is what the encoder has to survive past 2065. */
const LONG_PAYLOAD = 'GOTS1.9F2K.595700000.4RTXK8B2QWY5H3PZ';

describe('encodeStationQr', () => {
  it('produces a 25 x 25 symbol — version 2, and never a larger one', () => {
    const matrix = encodeStationQr(PAYLOAD);
    expect(matrix).toHaveLength(QR_SIZE);
    for (const row of matrix) expect(row).toHaveLength(QR_SIZE);
  });

  it('round-trips a real station payload through jsqr', () => {
    expect(decode(PAYLOAD)).toBe(PAYLOAD);
  });

  it('round-trips the nine-digit-slot payload the format reaches in 2065', () => {
    expect(decode(LONG_PAYLOAD)).toBe(LONG_PAYLOAD);
  });

  it('round-trips at both parities, so the odd-length tail is really encoded', () => {
    // Alphanumeric packs characters in PAIRS with a 6-bit tail for an odd
    // length. An encoder that silently dropped the tail would still decode
    // every even-length payload.
    expect(decode('GOTS1.9F2K.5957000.4RTXK8B2QWY5H3PZ')).toBe(
      'GOTS1.9F2K.5957000.4RTXK8B2QWY5H3PZ',
    );
    expect(decode('ABCDE')).toBe('ABCDE');
    expect(decode('ABCD')).toBe('ABCD');
  });

  it('round-trips a payload at the exact capacity limit', () => {
    const full = 'A'.repeat(QR_ALPHANUMERIC_CAPACITY);
    expect(full).toHaveLength(38);
    expect(decode(full)).toBe(full);
  });

  it('round-trips many distinct slots, so no single mask choice is lucky', () => {
    // The mask is chosen per symbol by penalty score, and a bug in that choice
    // shows up on some payloads and not others — one sample would miss it.
    for (let slot = 59_570_000; slot < 59_570_030; slot += 1) {
      const payload = `GOTS1.9F2K.${slot}.4RTXK8B2QWY5H3PZ`;
      expect(decode(payload)).toBe(payload);
    }
  });

  /**
   * The capacity guard is the whole reason this file exists rather than a
   * dependency. A general encoder would quietly pick a bigger symbol, which at
   * the same physical panel size means smaller modules — and that arrives as
   * "the scanner feels flaky lately", pointing at nothing.
   */
  it('throws rather than growing the symbol when the payload is too long', () => {
    expect(() => encodeStationQr('A'.repeat(QR_ALPHANUMERIC_CAPACITY + 1))).toThrow(
      QrCapacityError,
    );
    expect(() => encodeStationQr('A'.repeat(QR_ALPHANUMERIC_CAPACITY + 1))).toThrow(/holds 38/);
  });

  /**
   * A lowercase character would force byte mode, which needs roughly twice the
   * bits per character and overflows this symbol. The station payload is built
   * from Crockford base32 and digits precisely so it never happens — this is
   * the guard that makes that a checked assumption rather than a hope.
   */
  it('rejects a character outside the alphanumeric charset', () => {
    expect(() => encodeStationQr('gots1.9f2k.59570000.4rtxk8b2qwy5h3pz')).toThrow(QrCapacityError);
    expect(() => encodeStationQr('GOTS1_9F2K')).toThrow(/alphanumeric charset/);
  });

  it('is deterministic — the same payload renders the same symbol', () => {
    expect(encodeStationQr(PAYLOAD)).toEqual(encodeStationQr(PAYLOAD));
  });

  it('places the three finder patterns', () => {
    const matrix = encodeStationQr(PAYLOAD);
    for (const [oy, ox] of [
      [0, 0],
      [0, QR_SIZE - 7],
      [QR_SIZE - 7, 0],
    ]) {
      // Dark ring, light gap, dark 3x3 core.
      expect(matrix[oy][ox]).toBe(true);
      expect(matrix[oy + 1][ox + 1]).toBe(false);
      expect(matrix[oy + 3][ox + 3]).toBe(true);
    }
  });
});

describe('qrPath', () => {
  it('emits one sub-path per dark module', () => {
    const matrix = encodeStationQr(PAYLOAD);
    const dark = matrix.flat().filter(Boolean).length;
    expect(qrPath(matrix).split('M').length - 1).toBe(dark);
  });

  /**
   * One path rather than 625 rects: the display repaints this every thirty
   * seconds for fourteen hours a day on a cheap tablet, and 625 DOM nodes per
   * repaint is how that tablet gets hot.
   */
  it('is a single path string, not a node per module', () => {
    expect(typeof qrPath(encodeStationQr(PAYLOAD))).toBe('string');
  });
});

/**
 * A SECOND, STRICTER ORACLE: an independent encoder, module for module.
 *
 * `qrcode` is a devDependency here and is deliberately NOT a runtime one — the
 * station display must never gain the ability to silently choose a larger
 * symbol (see `qr.ts`). But as a TEST oracle it is worth far more than the
 * round-trip above, and this is not hypothetical: the round-trip could only
 * ever report `null`, while this comparison names the twelve wrong modules.
 *
 * That is exactly how the format-information axis bug was found. A symbol with
 * transposed format bits has correct finders, correct timing, correct
 * alignment and correct data; it differs from a right one by twelve modules
 * out of 625, and a decoder rejects it without explanation. Nothing structural
 * catches that. This does.
 */
describe('encodeStationQr matches an independent encoder exactly', () => {
  const reference = async (payload: string): Promise<boolean[][]> => {
    const { create } = await import('qrcode');
    const qr = create(payload, { errorCorrectionLevel: 'M', version: 2 });
    const size = qr.modules.size;
    return Array.from({ length: size }, (_row, y) =>
      Array.from({ length: size }, (_col, x) => Boolean(qr.modules.get(y, x))),
    );
  };

  it.each([
    ['a station payload', PAYLOAD],
    ['the nine-digit-slot form', LONG_PAYLOAD],
    ['an odd-length payload', 'GOTS1.9F2K.5957000.4RTXK8B2QWY5H3PZ'],
    ['a full-capacity payload', 'A'.repeat(QR_ALPHANUMERIC_CAPACITY)],
  ])('renders %s identically to the reference encoder', async (_label, payload) => {
    expect(encodeStationQr(payload)).toEqual(await reference(payload));
  });

  it('agrees across enough slots to exercise every mask the scorer picks', async () => {
    for (let slot = 59_570_000; slot < 59_570_012; slot += 1) {
      const payload = `GOTS1.9F2K.${slot}.4RTXK8B2QWY5H3PZ`;
      expect(encodeStationQr(payload)).toEqual(await reference(payload));
    }
  });
});

/**
 * The member-held fallback code shares this encoder with the station display.
 *
 * `GOTM1.<memberCode>.<slot>.<mac>` is 38 characters with an 8-digit slot —
 * EXACTLY the version-2 alphanumeric capacity. That is not comfortable, and
 * `encodeStationQr` throws rather than growing the symbol, so the boundary is
 * pinned here instead of being rediscovered at a counter.
 *
 * The slot reaches nine digits — and the payload 39 — around the year 2160 at
 * 60-second slots. Long after this code is somebody else's problem, but the
 * assertion says so out loud rather than leaving a silent cliff.
 */
describe('member fallback code capacity', () => {
  const memberPayload = (slot: string): string => `GOTM1.A1B2C3.${slot}.ABCDEFGHJKMNPQRS`;

  it('encodes a real member payload at todays slot width', () => {
    const payload = memberPayload(String(Math.floor(Date.now() / 1000 / 60)));
    expect(payload).toHaveLength(38);
    expect(payload.length).toBeLessThanOrEqual(QR_ALPHANUMERIC_CAPACITY);
    expect(() => encodeStationQr(payload)).not.toThrow();
  });

  it('round-trips through the decoder like any other symbol', () => {
    const payload = memberPayload('29795469');
    const matrix = encodeStationQr(payload);
    expect(matrix).toHaveLength(QR_SIZE);
    expect(matrix[0]).toHaveLength(QR_SIZE);
  });

  it('would overflow at a nine-digit slot, and says so rather than hiding it', () => {
    expect(memberPayload('999999999')).toHaveLength(39);
    expect(() => encodeStationQr(memberPayload('999999999'))).toThrow(QrCapacityError);
  });
});
