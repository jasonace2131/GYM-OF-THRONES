/**
 * Reading the Ref No. off a GCash receipt screenshot, in the member's browser.
 *
 * This is a typing aid, nothing more. It fills the reference field so the
 * member does not have to copy thirteen digits off one screen onto another; it
 * proves nothing about the receipt, and the desk still checks every claim
 * against the gym's own GCash account. So the rules lean hard towards "fill
 * nothing" — a blank field the member types into costs ten seconds, a wrong
 * number filled in with confidence costs a rejected claim.
 *
 * A GCash Ref No. is exactly 13 digits, printed 4-3-6: `6041 342 312154`.
 */

const REF_DIGITS = 13;

/** "Ref No.", "Ref. No", "Ref No:", "REF NO", and OCR's favourite misread, "Ret No.". */
const REF_LABEL = /\bRe[ft]\.?\s*No\b[.:]*/i;

/**
 * One whitespace-separated piece of a number as OCR sees it: digits, plus the
 * letters OCR swaps in for digits. It must hold at least one real digit, so a
 * word made only of those letters ("SOIB") is never read as a number.
 */
const NUMBER_TOKEN = /^[0-9OoIl|SB]+$/;

const CONFUSIONS: Record<string, string> = {
  O: '0',
  o: '0',
  I: '1',
  l: '1',
  '|': '1',
  S: '5',
  B: '8',
};

const isNumberToken = (token: string): boolean => NUMBER_TOKEN.test(token) && /\d/.test(token);

/**
 * A token as a piece of a number: `null` if it is not one, otherwise its body
 * and whether it closes the run. Trailing `.,;:` is sentence punctuation OCR
 * glued on (`312154.`), so it is dropped — but it still ends the run, so a date
 * like `30, 2026` stays two numbers rather than becoming one.
 */
function numberPiece(token: string): { body: string; closes: boolean } | null {
  const body = token.replace(/[.,;:]+$/, '');
  return isNumberToken(body) ? { body, closes: body !== token } : null;
}

const toDigits = (tokens: string[]): string =>
  tokens.join('').replace(/[OoIl|SB]/g, (char) => CONFUSIONS[char] ?? char);

/**
 * Every maximal run of number tokens on one line, joined. Runs never cross a
 * line break, anything with punctuation inside it (`+63`, `10.00`, `6:21`,
 * `279g`) is not a number piece at all, and trailing punctuation (`30,`) ends
 * the run it finishes.
 */
function runsOnLine(line: string): string[] {
  const runs: string[] = [];
  let current: string[] = [];
  const close = (): void => {
    if (current.length > 0) runs.push(toDigits(current));
    current = [];
  };
  for (const token of line.split(/[ \t]+/)) {
    const piece = numberPiece(token);
    if (piece === null) {
      close();
      continue;
    }
    current.push(piece.body);
    if (piece.closes) close();
  }
  close();
  return runs;
}

/** The number right after a Ref label — on the same line, or the next one if the label ends its line. */
function afterLabel(text: string): string | null {
  const label = REF_LABEL.exec(text);
  if (label === null) return null;
  const rest = text.slice(label.index + label[0].length).replace(/^\s+/, '');
  const firstLine = rest.split(/\r?\n/, 1)[0] ?? '';
  // Only the run that starts the line counts; a 13-digit number further along
  // is something else.
  const tokens = firstLine.split(/[ \t]+/);
  const leading: string[] = [];
  for (const token of tokens) {
    const piece = numberPiece(token);
    if (piece === null) break;
    leading.push(piece.body);
    if (piece.closes) break;
  }
  return leading.length === 0 ? null : toDigits(leading);
}

/** The 13-digit GCash Ref No. in OCR'd receipt text, digits only, or null if there is no single clear one. */
export function extractGcashReference(text: string): string | null {
  const labelled = afterLabel(text);
  if (labelled !== null && labelled.length === REF_DIGITS) return labelled;

  // No usable label: take a standalone 13-digit run, but only if it is the
  // only one. Two different candidates means we cannot tell which is the ref.
  const candidates = new Set(
    text
      .split(/\r?\n/)
      .flatMap(runsOnLine)
      .filter((run) => run.length === REF_DIGITS),
  );
  return candidates.size === 1 ? ([...candidates][0] ?? null) : null;
}

/** `'6041342312154'` → `'6041 342 312154'`, grouped the way the receipt prints it. */
export function formatGcashReference(digits: string): string {
  return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
}

/**
 * How long a read may take before the member is told to type the number in. A
 * phone on slow data fetching the core and English data for the first time is
 * the slow case; past this, waiting longer helps nobody.
 */
export const READ_TIMEOUT_MS = 30_000;

/**
 * OCR the screenshot and return its Ref No., formatted, or null. Never throws
 * and never hangs: a library that fails to load, a worker that dies, an image
 * it cannot read, or a read still running after READ_TIMEOUT_MS all come back
 * as null, and the member types the number in as before.
 *
 * tesseract.js is imported here, on demand, so its weight never lands in the
 * page's bundle; it fetches its worker, WASM core and English data from its
 * default CDN on first use. One worker per read, terminated afterwards — a
 * member reads one receipt, maybe two, so a worker kept warm for the card's
 * lifetime would only hold memory on a phone.
 */
type Terminable = { terminate: () => Promise<unknown> };

/** Fire and forget: terminate can hang too, and the answer must not wait on it. */
function release(target: Terminable): void {
  try {
    void target.terminate().catch(() => undefined);
  } catch {
    // A worker that cannot even be told to stop is already gone.
  }
}

export async function readGcashReference(file: File): Promise<string | null> {
  let worker: Terminable | null = null;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const read = async (): Promise<string | null> => {
    const { createWorker } = await import('tesseract.js');
    const created = await createWorker('eng');
    if (finished) {
      // Timed out while the worker was still starting; nobody wants it now.
      release(created);
      return null;
    }
    worker = created;
    const {
      data: { text },
    } = await created.recognize(file);
    const digits = extractGcashReference(text);
    return digits === null ? null : formatGcashReference(digits);
  };

  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS);
  });

  try {
    return await Promise.race([read(), timeout]);
  } catch {
    return null;
  } finally {
    finished = true;
    clearTimeout(timer);
    if (worker !== null) release(worker);
  }
}
