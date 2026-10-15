import { describe, expect, it } from 'vitest';
import {
  FOCUS_REFETCH_MS,
  FORBIDDEN_REFETCH_MS,
  INITIAL_ME,
  meReducer,
  shouldRefetchOnFocus,
  shouldRefetchOnForbidden,
  type MeSnapshot,
} from './meState';

interface TestMe {
  id: string;
  permissions: { key: string; scope: string }[];
}

const ME: TestMe = { id: 'u1', permissions: [{ key: 'member.read', scope: 'ALL' }] };
const LATER: TestMe = { id: 'u1', permissions: [] };

const ready = (me: TestMe = ME): MeSnapshot<TestMe> => ({
  status: 'ready',
  me,
  errorStatus: null,
  fetchedAt: 1_000,
});

describe('meReducer', () => {
  it('starts loading with nobody known', () => {
    expect(INITIAL_ME).toEqual({ status: 'loading', me: null, errorStatus: null, fetchedAt: null });
  });

  it('becomes ready with the profile and when it was fetched', () => {
    expect(meReducer<TestMe>(INITIAL_ME, { type: 'loaded', me: ME, at: 5 })).toEqual({
      status: 'ready',
      me: ME,
      errorStatus: null,
      fetchedAt: 5,
    });
  });

  it('replaces the profile on a refetch, so a revoked key disappears', () => {
    const next = meReducer(ready(), { type: 'loaded', me: LATER, at: 9 });
    expect(next.me).toBe(LATER);
    expect(next.fetchedAt).toBe(9);
  });

  /**
   * 401 is the only answer that means "not signed in", and 403 is a real
   * answer from a working server. Both drop the profile: keeping a stale one
   * would keep painting privileged UI for a session the server refuses.
   */
  it.each([401, 403])('drops the profile on %i', (status) => {
    expect(meReducer(ready(), { type: 'failed', status })).toEqual({
      status: 'error',
      me: null,
      errorStatus: status,
      fetchedAt: null,
    });
  });

  /**
   * A failed REFRESH is a network blip, not an authorisation problem. The
   * portal has always kept its last known answer here, so a coach's own
   * dashboard does not vanish from the nav because a background refetch
   * timed out.
   */
  it('keeps the last known profile when a refresh fails for any other reason', () => {
    const state = ready();
    expect(meReducer(state, { type: 'failed', status: 500 })).toBe(state);
    expect(meReducer(state, { type: 'failed', status: null })).toBe(state);
  });

  it('is an error when the first load fails for any reason', () => {
    expect(meReducer<TestMe>(INITIAL_ME, { type: 'failed', status: null })).toEqual({
      status: 'error',
      me: null,
      errorStatus: null,
      fetchedAt: null,
    });
    expect(meReducer<TestMe>(INITIAL_ME, { type: 'failed', status: 503 }).errorStatus).toBe(503);
  });

  it('forgets everything on sign-out, so the next account inherits nothing', () => {
    expect(meReducer(ready(), { type: 'signedOut' })).toEqual({
      status: 'error',
      me: null,
      errorStatus: 401,
      fetchedAt: null,
    });
  });

  it('goes back to loading on a retry from an error', () => {
    const failed = meReducer<TestMe>(INITIAL_ME, { type: 'failed', status: null });
    expect(meReducer(failed, { type: 'retry' })).toEqual(INITIAL_ME);
  });

  it('ignores a retry while a profile is on screen — the refetch runs in the background', () => {
    const state = ready();
    expect(meReducer(state, { type: 'retry' })).toBe(state);
  });
});

describe('shouldRefetchOnFocus', () => {
  it('refetches when nothing has been fetched yet', () => {
    expect(shouldRefetchOnFocus(null, 0)).toBe(true);
  });

  it('is throttled to about a minute', () => {
    expect(FOCUS_REFETCH_MS).toBe(60_000);
    expect(shouldRefetchOnFocus(1_000, 1_000 + 59_999)).toBe(false);
    expect(shouldRefetchOnFocus(1_000, 1_000 + 60_000)).toBe(true);
  });
});

describe('shouldRefetchOnForbidden', () => {
  it('refetches straight after the first 403', () => {
    expect(shouldRefetchOnForbidden('/reports/revenue', null, 0)).toBe(true);
  });

  /**
   * The loop guard. Re-fetching /me after a 403 FROM /me would re-fetch
   * forever; /me is keyless, so a 403 there is never a stale-permission
   * signal anyway.
   */
  it('never refetches for a 403 from /me itself', () => {
    expect(shouldRefetchOnForbidden('/me', null, 0)).toBe(false);
  });

  /**
   * A screen with five panels can collect five 403s in one render, and a
   * polling panel collects one every cycle. One refetch covers them all.
   */
  it('refetches at most once per short window', () => {
    expect(FORBIDDEN_REFETCH_MS).toBe(5_000);
    expect(shouldRefetchOnForbidden('/payments', 10_000, 14_999)).toBe(false);
    expect(shouldRefetchOnForbidden('/payments', 10_000, 15_000)).toBe(true);
  });

  it('still refetches for a 403 from another /me/* route', () => {
    expect(shouldRefetchOnForbidden('/me/coach', null, 0)).toBe(true);
  });
});
