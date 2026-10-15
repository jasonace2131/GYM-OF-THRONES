/**
 * The state behind each surface's `MeProvider`, as a pure reducer.
 *
 * `/me` is the caller's permission set, and every nav item, page guard and
 * button reads it — so what happens when a refetch fails, or the session
 * ends, is decided here once rather than in each shell.
 */

export type MeStatus = 'loading' | 'ready' | 'error';

export interface MeSnapshot<M> {
  status: MeStatus;
  me: M | null;
  /** HTTP status of the failure; `null` for a network failure or no failure. */
  errorStatus: number | null;
  /** When the profile on screen was fetched, for the focus throttle. */
  fetchedAt: number | null;
}

export type MeAction<M> =
  | { type: 'loaded'; me: M; at: number }
  | { type: 'failed'; status: number | null }
  | { type: 'signedOut' }
  | { type: 'retry' };

export const INITIAL_ME: MeSnapshot<never> = {
  status: 'loading',
  me: null,
  errorStatus: null,
  fetchedAt: null,
};

/** Re-fetch on focus or visibility no more than this often. */
export const FOCUS_REFETCH_MS = 60_000;
/** One re-fetch covers every 403 inside this window. */
export const FORBIDDEN_REFETCH_MS = 5_000;

export function meReducer<M>(state: MeSnapshot<M>, action: MeAction<M>): MeSnapshot<M> {
  switch (action.type) {
    case 'loaded':
      return { status: 'ready', me: action.me, errorStatus: null, fetchedAt: action.at };

    case 'failed':
      // 401: not signed in. 403: a real refusal from a working server. Either
      // way the profile goes — a stale one would keep painting privileged UI.
      if (action.status === 401 || action.status === 403) {
        return { status: 'error', me: null, errorStatus: action.status, fetchedAt: null };
      }
      // Anything else is a failure to ASK. With a profile already on screen
      // that is a blip, and the last known answer stands.
      if (state.me !== null) return state;
      return { status: 'error', me: null, errorStatus: action.status, fetchedAt: null };

    case 'signedOut':
      return { status: 'error', me: null, errorStatus: 401, fetchedAt: null };

    case 'retry':
      return state.status === 'error' ? INITIAL_ME : state;
  }
}

export function shouldRefetchOnFocus(
  fetchedAt: number | null,
  now: number,
  minMs: number = FOCUS_REFETCH_MS,
): boolean {
  return fetchedAt === null || now - fetchedAt >= minMs;
}

/**
 * Whether a 403 from `path` should re-fetch `/me`.
 *
 * A 403 usually means the permission set on screen is stale — a grant was
 * revoked since the page loaded — so the provider re-fetches and the nav and
 * guards catch up. Never for `/me` itself (that would loop), and at most once
 * per short window, so a polling panel that 403s every cycle costs one extra
 * request rather than a storm.
 */
export function shouldRefetchOnForbidden(
  path: string,
  lastAt: number | null,
  now: number,
  minMs: number = FORBIDDEN_REFETCH_MS,
): boolean {
  if (path === '/me') return false;
  return lastAt === null || now - lastAt >= minMs;
}
