import { describe, expect, it, vi } from 'vitest';
import {
  canSubmit,
  confirmErrorMessage,
  reasonHint,
  reasonToSend,
  runConfirmed,
  type ConfirmReasonSpec,
} from './confirm';

const REQUIRED: ConfirmReasonSpec = { required: true, label: 'Reason', maxLength: 200 };
const OPTIONAL: ConfirmReasonSpec = { required: false, label: 'Note', maxLength: 200 };

describe('canSubmit', () => {
  it('is always true when the dialog asks for no reason', () => {
    expect(canSubmit('', undefined)).toBe(true);
    expect(canSubmit('anything', undefined)).toBe(true);
  });

  it('stays false until a required reason reaches the minimum, counted after trimming', () => {
    expect(canSubmit('', REQUIRED)).toBe(false);
    expect(canSubmit('ab', REQUIRED)).toBe(false);
    // Three spaces and a letter is one character to the server, which trims.
    expect(canSubmit('   a   ', REQUIRED)).toBe(false);
    expect(canSubmit('abc', REQUIRED)).toBe(true);
  });

  it('honours a custom minimum', () => {
    const spec = { ...REQUIRED, minLength: 10 };
    expect(canSubmit('too short', spec)).toBe(false);
    expect(canSubmit('long enough now', spec)).toBe(true);
  });

  it('refuses a reason over the maximum rather than letting the server 400 it', () => {
    expect(canSubmit('x'.repeat(200), REQUIRED)).toBe(true);
    expect(canSubmit('x'.repeat(201), REQUIRED)).toBe(false);
  });

  it('lets an optional reason be empty, but not too short once somebody starts typing', () => {
    expect(canSubmit('', OPTIONAL)).toBe(true);
    expect(canSubmit('  ', OPTIONAL)).toBe(true);
    expect(canSubmit('ab', OPTIONAL)).toBe(false);
    expect(canSubmit('abc', OPTIONAL)).toBe(true);
  });

  it('is false while the action is in flight, whatever the reason says', () => {
    expect(canSubmit('', undefined, true)).toBe(false);
    expect(canSubmit('a good reason', REQUIRED, true)).toBe(false);
  });
});

describe('reasonToSend', () => {
  it('sends nothing when the dialog has no reason field', () => {
    expect(reasonToSend('typed anyway', undefined)).toBeUndefined();
  });

  it('sends the trimmed reason', () => {
    expect(reasonToSend('  lost the receipt  ', REQUIRED)).toBe('lost the receipt');
  });

  it('sends undefined, not an empty string, for a blank optional reason', () => {
    expect(reasonToSend('   ', OPTIONAL)).toBeUndefined();
  });
});

describe('reasonHint', () => {
  it('counts trimmed characters against the bounds', () => {
    expect(reasonHint('  abcd ', REQUIRED)).toBe('4/200 characters — at least 3 required.');
  });

  it('says optional for an optional reason', () => {
    expect(reasonHint('', OPTIONAL)).toBe('0/200 characters — optional, at least 3 if given.');
  });
});

describe('confirmErrorMessage', () => {
  it('shows the server message of an ApiError verbatim', () => {
    const error = Object.assign(new Error('That visit is already closed.'), { name: 'ApiError' });
    expect(confirmErrorMessage(error)).toBe('That visit is already closed.');
  });

  it('never shows a raw browser error such as a failed fetch', () => {
    expect(confirmErrorMessage(new TypeError('Failed to fetch'))).toBe('Something went wrong.');
    expect(confirmErrorMessage('a string')).toBe('Something went wrong.');
  });

  it('uses the caller fallback when given one', () => {
    expect(confirmErrorMessage(null, 'That did not save.')).toBe('That did not save.');
  });
});

describe('runConfirmed', () => {
  it('marks busy, clears the old error, runs, and unmarks busy on success', async () => {
    const calls: string[] = [];
    const ok = await runConfirmed(
      async () => {
        calls.push('run');
      },
      {
        setBusy: (busy) => calls.push(`busy:${busy}`),
        setError: (message) => calls.push(`error:${message}`),
      },
    );

    expect(ok).toBe(true);
    expect(calls).toEqual(['busy:true', 'error:null', 'run', 'busy:false']);
  });

  it('reports failure through setError, never by rejecting', async () => {
    const setError = vi.fn();
    const setBusy = vi.fn();
    const failure = Object.assign(new Error('Open the cash drawer first.'), { name: 'ApiError' });

    const ok = await runConfirmed(() => Promise.reject(failure), { setBusy, setError });

    expect(ok).toBe(false);
    expect(setError).toHaveBeenLastCalledWith('Open the cash drawer first.');
    expect(setBusy).toHaveBeenLastCalledWith(false);
  });

  it('maps a thrown error through the caller-supplied describer when there is one', async () => {
    const setError = vi.fn();
    const ok = await runConfirmed(
      () => Promise.reject(new Error('raw')),
      { setBusy: () => undefined, setError },
      () => 'Described for the counter.',
    );

    expect(ok).toBe(false);
    expect(setError).toHaveBeenLastCalledWith('Described for the counter.');
  });
});
