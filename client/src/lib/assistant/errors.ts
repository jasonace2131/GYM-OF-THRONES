import { ASSISTANT_CLIENT_TIMEOUT_MS } from './pending';

/**
 * What the chat says when a question fails.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SCREEN USED TO THROW THE REASON AWAY.
 *
 * Every 503 became "The assistant is not available right now." — whether the
 * server meant "switched off", "every model is busy" or "that plan took too
 * long", and although the server's own message said which. The member who
 * asked for a school-week workout plan saw that line and had no idea a
 * shorter request would have worked.
 *
 * Now the server's words are shown whenever it named the failure
 * (ASSISTANT_*, or the legacy HTTP_503 that already carried a sentence), and
 * the screen writes its own copy only for failures the server never saw.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const DROPPED =
  'The connection dropped while the answer was being written. Try again — shorter requests are faster.';
const RATE_LIMITED = 'That is a lot of questions at once. Give it a minute.';
const SERVER_FAULT = 'That one did not go through. Try asking again.';
const TIMED_OUT = `No answer after ${ASSISTANT_CLIENT_TIMEOUT_MS / 1000} seconds. Try again, or ask for something shorter.`;
const OFFLINE = 'You look to be offline. Check your connection and try again.';
const GENERIC = 'Something went wrong. Try asking again.';

interface ApiErrorLike {
  message: string;
  status: number;
  code: string;
}

/**
 * Structural, not `instanceof ApiError`: importing lib/api would pull the
 * Supabase client into this module, which throws at import time without its
 * env vars and would make this file impossible to test on its own.
 */
function isApiError(caught: unknown): caught is ApiErrorLike {
  return (
    caught instanceof Error &&
    caught.name === 'ApiError' &&
    typeof (caught as { status?: unknown }).status === 'number' &&
    typeof (caught as { code?: unknown }).code === 'string'
  );
}

function nameOf(caught: unknown): string | null {
  if (caught === null || typeof caught !== 'object') return null;
  const name = (caught as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

export function assistantErrorMessage(caught: unknown): string {
  if (isApiError(caught)) {
    if (caught.code.startsWith('ASSISTANT_') || caught.code === 'HTTP_503') return caught.message;

    // A proxy page, a cut-off body, or a gateway that gave up mid-answer:
    // the request left, the answer never arrived intact.
    if (caught.code === 'INVALID_RESPONSE' || caught.status === 502 || caught.status === 504) {
      return DROPPED;
    }

    if (caught.status === 429) return RATE_LIMITED;

    // The raw envelope message here is "Internal server error" — a
    // stack-trace phrase in a chat bubble. "Try again" is the only thing a
    // member can act on.
    if (caught.status >= 500) return SERVER_FAULT;

    // Any other refusal (a 403 once `ai.chat.use` is revoked, a 400 from
    // validation) keeps the server's own sentence, as this screen always has.
    return caught.message;
  }

  // AbortSignal.timeout fires TimeoutError; some older engines report the
  // same abort as AbortError. This screen aborts for no other reason.
  const name = nameOf(caught);
  if (name === 'TimeoutError' || name === 'AbortError') return TIMED_OUT;

  // `fetch` rejects with a TypeError when the request never left the device.
  if (caught instanceof TypeError) return OFFLINE;

  return GENERIC;
}
