import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No network: the card's API client and the OCR wrapper are both stand-ins.
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));
vi.mock('@/lib/gcashApi', () => ({
  MAX_PROOF_BYTES: 5 * 1024 * 1024,
  gcashApi: { mine: vi.fn(async () => []), uploadProof: vi.fn(), submit: vi.fn() },
}));
const ocr = vi.hoisted(() => ({ readGcashReference: vi.fn() }));
vi.mock('@/lib/gcashReceiptRef', () => ({ readGcashReference: ocr.readGcashReference }));

import { GcashClaimCard } from './GcashClaimCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HELPER = 'On your receipt next to';
const READING = 'Reading your receipt…';
const FILLED = 'Filled from your receipt — check it matches.';
const FAILED = 'Couldn’t read the Ref No. — type it in.';

let container: HTMLDivElement;
let root: Root;

/** A promise the test resolves by hand, to control when an OCR read "finishes". */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

const referenceInput = (): HTMLInputElement =>
  container.querySelector('input[placeholder="e.g. 6041 342 312154"]') as HTMLInputElement;

const fileInput = (): HTMLInputElement =>
  container.querySelector('input[type="file"]') as HTMLInputElement;

const text = (): string => container.textContent ?? '';

async function openForm(): Promise<void> {
  await act(async () => {
    root.render(<GcashClaimCard plans={[{ code: 'M1', name: 'Monthly', priceCentavos: 1000 }]} />);
  });
  await flush();
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Send your receipt',
  ) as HTMLButtonElement;
  await act(async () => {
    button.click();
  });
}

async function typeReference(value: string): Promise<void> {
  const input = referenceInput();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pickFile(name: string): Promise<File> {
  const file = new File(['x'], name, { type: 'image/png' });
  const input = fileInput();
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  return file;
}

beforeEach(() => {
  ocr.readGcashReference.mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('GcashClaimCard — filling the Ref No. from the receipt', () => {
  it('shows the normal helper before a file is picked', async () => {
    await openForm();
    expect(text()).toContain(HELPER);
  });

  it('says it is reading, then fills an empty field and says so', async () => {
    const read = deferred<string | null>();
    ocr.readGcashReference.mockReturnValue(read.promise);
    await openForm();

    const file = await pickFile('receipt.png');
    expect(ocr.readGcashReference).toHaveBeenCalledWith(file);
    expect(text()).toContain(READING);
    expect(text()).not.toContain(HELPER);

    await act(async () => read.resolve('6041 342 312154'));
    expect(referenceInput().value).toBe('6041 342 312154');
    expect(text()).toContain(FILLED);
    expect(text()).not.toContain(READING);
  });

  it('never overwrites a reference the member already typed, and says nothing', async () => {
    const read = deferred<string | null>();
    ocr.readGcashReference.mockReturnValue(read.promise);
    await openForm();
    await typeReference('1111 222 333333');

    await pickFile('receipt.png');
    await act(async () => read.resolve('6041 342 312154'));

    expect(referenceInput().value).toBe('1111 222 333333');
    expect(text()).not.toContain(FILLED);
    expect(text()).not.toContain(FAILED);
    expect(text()).not.toContain(READING);
    expect(text()).toContain(HELPER);
  });

  it('keeps what the member typed while the receipt was still being read', async () => {
    const read = deferred<string | null>();
    ocr.readGcashReference.mockReturnValue(read.promise);
    await openForm();

    await pickFile('receipt.png');
    await typeReference('1111 222 333333');
    await act(async () => read.resolve('6041 342 312154'));

    expect(referenceInput().value).toBe('1111 222 333333');
    expect(text()).not.toContain(FILLED);
    expect(text()).toContain(HELPER);
  });

  it('asks the member to type it when the receipt cannot be read', async () => {
    ocr.readGcashReference.mockResolvedValue(null);
    await openForm();

    await pickFile('receipt.png');
    await flush();

    expect(referenceInput().value).toBe('');
    expect(text()).toContain(FAILED);
  });

  it('goes back to the normal helper once the member types', async () => {
    ocr.readGcashReference.mockResolvedValue(null);
    await openForm();
    await pickFile('receipt.png');
    await flush();
    expect(text()).toContain(FAILED);

    await typeReference('6');
    expect(text()).not.toContain(FAILED);
    expect(text()).toContain(HELPER);
  });

  it('lets only the latest file fill the field when an earlier read finishes late', async () => {
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    ocr.readGcashReference.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await openForm();

    await pickFile('old.png');
    await pickFile('new.png');
    await act(async () => second.resolve('2222 333 444444'));
    await act(async () => first.resolve('6041 342 312154'));

    expect(referenceInput().value).toBe('2222 333 444444');
    expect(text()).toContain(FILLED);
  });

  it('ignores a stale failure too', async () => {
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    ocr.readGcashReference.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await openForm();

    await pickFile('old.png');
    await pickFile('new.png');
    await act(async () => second.resolve('2222 333 444444'));
    await act(async () => first.resolve(null));

    expect(text()).toContain(FILLED);
    expect(text()).not.toContain(FAILED);
  });

  it('replaces its own fill when the member picks a different receipt', async () => {
    ocr.readGcashReference
      .mockResolvedValueOnce('6041 342 312154')
      .mockResolvedValueOnce('2222 333 444444');
    await openForm();

    await pickFile('wrong.png');
    await flush();
    expect(referenceInput().value).toBe('6041 342 312154');

    await pickFile('right.png');
    await flush();
    expect(ocr.readGcashReference).toHaveBeenCalledTimes(2);
    expect(referenceInput().value).toBe('2222 333 444444');
    expect(text()).toContain(FILLED);
  });

  it('clears its own stale fill when the next receipt cannot be read', async () => {
    ocr.readGcashReference.mockResolvedValueOnce('6041 342 312154').mockResolvedValueOnce(null);
    await openForm();

    await pickFile('wrong.png');
    await flush();
    await pickFile('unreadable.png');
    await flush();

    expect(referenceInput().value).toBe('');
    expect(text()).toContain(FAILED);
  });

  it('keeps a filled number the member then edited by hand', async () => {
    ocr.readGcashReference
      .mockResolvedValueOnce('6041 342 312154')
      .mockResolvedValueOnce('2222 333 444444');
    await openForm();

    await pickFile('first.png');
    await flush();
    await typeReference('6041 342 312155');
    await pickFile('second.png');
    await flush();

    expect(referenceInput().value).toBe('6041 342 312155');
    expect(text()).not.toContain(FILLED);
    expect(text()).toContain(HELPER);
  });

  it('keeps the status out of the field label and describes the field with it', async () => {
    const read = deferred<string | null>();
    ocr.readGcashReference.mockReturnValue(read.promise);
    await openForm();

    const description = (): string => {
      const ids = (referenceInput().getAttribute('aria-describedby') ?? '').split(' ');
      return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    };
    expect(description()).toContain(HELPER);

    await pickFile('receipt.png');
    const label = referenceInput().closest('label') as HTMLLabelElement;
    expect(label.textContent).not.toContain(READING);
    expect(label.textContent).not.toContain(HELPER);
    expect(description()).toContain(READING);
    const status = container.querySelector('[role="status"]') as HTMLElement;
    expect(status.textContent).toBe(READING);

    await act(async () => read.resolve('6041 342 312154'));
    expect(status.textContent).toBe(FILLED);
    expect(description()).toContain(FILLED);
  });

  it('keeps the field editable while a read is in flight', async () => {
    ocr.readGcashReference.mockReturnValue(deferred<string | null>().promise);
    await openForm();
    await pickFile('receipt.png');

    expect(referenceInput().disabled).toBe(false);
    expect(referenceInput().readOnly).toBe(false);
  });
});
