/**
 * The pure half of `ConfirmDialog` — every decision the dialog makes that is
 * not a pixel.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE DIALOG, EVERY ADMIN EDIT (owner decision, 2026-09-25).
 *
 * The console confirms every write with the same modal: it names the item and
 * the action, says in one sentence what happens, and puts the verb on the
 * button. Where the SERVER already demands a reason (void, refund, suspend,
 * membership cancel, class cancel, GCash refuse, role change) the same modal
 * carries the reason field, so there is exactly one look and one set of rules.
 *
 * The rules live here rather than in the component because they are the part
 * that can be wrong in a way nobody sees: a confirm button enabled on a reason
 * the server will reject is a 400 at the counter; a reason sent untrimmed is a
 * row that fails its CHECK constraint.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** A reason field inside the confirmation. */
export interface ConfirmReasonSpec {
  /** Whether the confirm button waits for it. */
  required: boolean;
  label: string;
  /** The server DTO's `@Length` upper bound — 200 for voids and suspensions, 300 for class cancel. */
  maxLength: number;
  /** Defaults to 3, the lower bound every reason DTO in the API shares. */
  minLength?: number;
  placeholder?: string;
}

/** Every reason DTO in the API is `@Length(3, …)`. */
export const DEFAULT_REASON_MIN = 3;

function bounds(spec: ConfirmReasonSpec): { min: number; max: number } {
  return { min: spec.minLength ?? DEFAULT_REASON_MIN, max: spec.maxLength };
}

/**
 * Whether the confirm button may be pressed.
 *
 * Counted AFTER trimming, because the server trims: three spaces and a letter
 * is one character there, and a button that enabled on it would promise a
 * submit the API refuses. An optional reason may be blank, but once somebody
 * starts typing it must be a reason the server would accept.
 */
export function canSubmit(
  reason: string,
  spec: ConfirmReasonSpec | undefined,
  busy: boolean = false,
): boolean {
  if (busy) return false;
  if (spec === undefined) return true;

  const length = reason.trim().length;
  const { min, max } = bounds(spec);
  if (length > max) return false;
  if (length === 0) return !spec.required;
  return length >= min;
}

/** What `onConfirm` receives: the trimmed reason, or `undefined` when there is none to send. */
export function reasonToSend(reason: string, spec: ConfirmReasonSpec | undefined): string | undefined {
  if (spec === undefined) return undefined;
  const trimmed = reason.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** The counter under the reason field. */
export function reasonHint(reason: string, spec: ConfirmReasonSpec): string {
  const length = reason.trim().length;
  const { min, max } = bounds(spec);
  return spec.required
    ? `${length}/${max} characters — at least ${min} required.`
    : `${length}/${max} characters — optional, at least ${min} if given.`;
}

/**
 * The sentence shown in the dialog's error strip.
 *
 * An `ApiError` carries the server's own message, written for a person at a
 * counter, so it is shown verbatim. Anything else — a dropped connection's
 * `TypeError: Failed to fetch`, a thrown string — is not, because it is not
 * written for anybody. Matched by `name` rather than `instanceof` so this
 * module stays pure: importing `./api` would pull in the Supabase client.
 */
export function confirmErrorMessage(
  caught: unknown,
  fallback: string = 'Something went wrong.',
): string {
  if (caught instanceof Error && caught.name === 'ApiError' && caught.message !== '') {
    return caught.message;
  }
  return fallback;
}

export interface ConfirmRunHandlers {
  setBusy: (busy: boolean) => void;
  setError: (message: string | null) => void;
}

/**
 * Runs the confirmed write with the bookkeeping every dialog needs.
 *
 * Resolves `true` on success and `false` on failure — it NEVER rejects. The
 * caller is an `onClick`, and a rejection escaping one is an unhandled
 * rejection: the kind of failure that used to leave `void adminApi.checkOut(…)`
 * silently doing nothing at the desk. Busy is cleared on both paths so a
 * dialog reopened after a success does not come back disabled.
 */
export async function runConfirmed(
  action: () => Promise<unknown>,
  handlers: ConfirmRunHandlers,
  describe: (caught: unknown) => string = confirmErrorMessage,
): Promise<boolean> {
  handlers.setBusy(true);
  handlers.setError(null);
  try {
    await action();
    handlers.setBusy(false);
    return true;
  } catch (caught) {
    handlers.setError(describe(caught));
    handlers.setBusy(false);
    return false;
  }
}
