import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real library would fetch a WASM core and language data from a CDN.
const tesseract = vi.hoisted(() => ({
  createWorker: vi.fn(),
  recognize: vi.fn(),
  terminate: vi.fn(),
}));
vi.mock('tesseract.js', () => ({ createWorker: tesseract.createWorker }));

import {
  extractGcashReference,
  formatGcashReference,
  READ_TIMEOUT_MS,
  readGcashReference,
} from './gcashReceiptRef';

// Roughly what Tesseract reads off the owner's real GCash receipt screenshot.
const RECEIPT = [
  'MA•Y RU••••L S.',
  '+63 994 417 8758',
  'Sent via GCash',
  'Amount 10.00',
  'Total Amount Sent ₱10.00',
  'Ref No. 6041 342 312154 May 30, 2026 6:21 PM',
  '279g (gCO2e)',
  'By going digital, you reduce your carbon footprint from transportation, paper, and plastic.',
].join('\n');

const withRefLine = (line: string): string =>
  RECEIPT.replace('Ref No. 6041 342 312154 May 30, 2026 6:21 PM', line);

describe('extractGcashReference', () => {
  it('reads the Ref No. off the real receipt', () => {
    expect(extractGcashReference(RECEIPT)).toBe('6041342312154');
  });

  it.each([
    'Ref No. 6041342312154 May 30, 2026 6:21 PM',
    'Ref. No 6041 342 312154 May 30, 2026 6:21 PM',
    'Ref No: 6041 342 312154 May 30, 2026 6:21 PM',
    'REF NO 6041 342 312154 May 30, 2026 6:21 PM',
    'Ret No. 6041 342 312154 May 30, 2026 6:21 PM',
    'Ref No.6041 342 312154',
  ])('accepts the label written as %j', (line) => {
    expect(extractGcashReference(withRefLine(line))).toBe('6041342312154');
  });

  it('reads what tesseract.js 5.1.1 actually returned for the owner’s receipt', () => {
    // Verbatim OCR output of screenshots/2026-09-06/GCash-…-30052026182156.PNG.jpg,
    // including its misreads ("RUeeeel", "£10.00").
    const ocr = [
      'MA.Y RUeeeel S.',
      '+63 994 417 8758',
      'Sent via GCash',
      'Amount 10.00',
      'Total Amount Sent £10.00',
      'Ref No. 6041 342 312154 May 30, 2026 6:21 PM',
      '',
    ].join('\n');
    expect(extractGcashReference(ocr)).toBe('6041342312154');
  });

  it('accepts the label and the number on separate lines', () => {
    expect(extractGcashReference(withRefLine('Ref No.\n6041 342 312154\nMay 30, 2026'))).toBe(
      '6041342312154',
    );
  });

  it.each([
    ['O and o as 0', 'Ref No. 6O41 342 312154', '6041342312154'],
    ['lowercase o as 0', 'Ref No. 6041 342 3121o4', '6041342312104'],
    ['I, l and | as 1', 'Ref No. 6041 342 3I2l54', '6041342312154'],
    ['pipe as 1', 'Ref No. 6041 342 |12154', '6041342112154'],
    ['S as 5', 'Ref No. 6041 342 3121S4', '6041342312154'],
    ['B as 8', 'Ref No. 6041 342 B12154', '6041342812154'],
  ])('maps OCR confusions inside the number: %s', (_name, line, expected) => {
    expect(extractGcashReference(withRefLine(line))).toBe(expected);
  });

  it('does not map letters inside words into digits', () => {
    // "SOIB" is a word, not a mangled number; it must not pad a 9-digit run to 13.
    expect(extractGcashReference(withRefLine('Ref No. 604134231 SOIB'))).toBeNull();
  });

  it.each([
    ['12 digits', 'Ref No. 6041 342 31215'],
    ['14 digits', 'Ref No. 6041 342 3121545'],
  ])('refuses a labelled number that is not 13 digits (%s)', (_name, line) => {
    expect(extractGcashReference(withRefLine(line))).toBeNull();
  });

  it('never takes the phone number, amount, date or carbon line', () => {
    const noRef = RECEIPT.replace(/Ref No\. 6041 342 312154 /, '');
    expect(extractGcashReference(noRef)).toBeNull();
    expect(extractGcashReference('+63 994 417 8758')).toBeNull();
    expect(extractGcashReference('+639944178758')).toBeNull();
    expect(extractGcashReference('Total Amount Sent ₱10.00\n279g (gCO2e)')).toBeNull();
    expect(extractGcashReference('May 30, 2026 6:21 PM')).toBeNull();
  });

  it('falls back to a single standalone 13-digit run when there is no label', () => {
    expect(extractGcashReference(withRefLine('6041 342 312154 May 30, 2026 6:21 PM'))).toBe(
      '6041342312154',
    );
    expect(extractGcashReference(withRefLine('6041342312154'))).toBe('6041342312154');
  });

  it.each(['.', ',', ';', ':'])('ignores a trailing %j on the number', (mark) => {
    expect(extractGcashReference(withRefLine(`Ref No. 6041 342 312154${mark} May 30`))).toBe(
      '6041342312154',
    );
    expect(extractGcashReference(withRefLine(`6041 342 312154${mark}`))).toBe('6041342312154');
  });

  it('gives up when there is no label and two different candidates', () => {
    expect(extractGcashReference(withRefLine('6041 342 312154\n1234 567 890123'))).toBeNull();
  });

  it('returns null for empty or unrelated text', () => {
    expect(extractGcashReference('')).toBeNull();
    expect(extractGcashReference('Sent via GCash')).toBeNull();
  });
});

describe('formatGcashReference', () => {
  it('groups 13 digits 4-3-6 like the receipt', () => {
    expect(formatGcashReference('6041342312154')).toBe('6041 342 312154');
  });
});

describe('readGcashReference', () => {
  const file = new File(['x'], 'receipt.png', { type: 'image/png' });

  beforeEach(() => {
    vi.resetAllMocks();
    tesseract.terminate.mockResolvedValue({});
    tesseract.createWorker.mockResolvedValue({
      recognize: tesseract.recognize,
      terminate: tesseract.terminate,
    });
  });

  it('returns the formatted Ref No. and terminates the worker', async () => {
    tesseract.recognize.mockResolvedValue({ data: { text: RECEIPT } });
    await expect(readGcashReference(file)).resolves.toBe('6041 342 312154');
    expect(tesseract.recognize).toHaveBeenCalledWith(file);
    expect(tesseract.terminate).toHaveBeenCalledTimes(1);
  });

  it('returns null when the text has no Ref No.', async () => {
    tesseract.recognize.mockResolvedValue({ data: { text: 'Sent via GCash' } });
    await expect(readGcashReference(file)).resolves.toBeNull();
    expect(tesseract.terminate).toHaveBeenCalledTimes(1);
  });

  it('returns null, never throws, when recognition fails', async () => {
    tesseract.recognize.mockRejectedValue(new Error('worker died'));
    await expect(readGcashReference(file)).resolves.toBeNull();
    expect(tesseract.terminate).toHaveBeenCalledTimes(1);
  });

  it('gives up with null after READ_TIMEOUT_MS when recognition hangs', async () => {
    vi.useFakeTimers();
    try {
      tesseract.recognize.mockReturnValue(new Promise(() => undefined));
      // A terminate that also hangs must not hold the answer up.
      tesseract.terminate.mockReturnValue(new Promise(() => undefined));
      let settled: string | null | undefined;
      void readGcashReference(file).then((value) => (settled = value));

      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBeNull();
      expect(tesseract.terminate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null when the library cannot start', async () => {
    tesseract.createWorker.mockRejectedValue(new Error('CDN unreachable'));
    await expect(readGcashReference(file)).resolves.toBeNull();
  });
});
