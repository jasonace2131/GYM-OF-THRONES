import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { MEMBER_DEVICE_CACHE_KEYS, clearMemberDeviceCache } from './deviceCache';
import { SESSION_CACHE_KEY } from './workouts/sessionCache';
import { SYNC_STORAGE_KEY } from './workouts/syncQueue';

describe('clearMemberDeviceCache', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('registers at least the member identity and the membership snapshot', () => {
    expect(MEMBER_DEVICE_CACHE_KEYS.length).toBeGreaterThanOrEqual(2);
  });

  it("registers the open workout and its unsent sets — a member's weights are theirs", () => {
    expect(MEMBER_DEVICE_CACHE_KEYS).toContain(SESSION_CACHE_KEY);
    expect(MEMBER_DEVICE_CACHE_KEYS).toContain(SYNC_STORAGE_KEY);
  });

  it('removes every registered key from both storages', () => {
    for (const key of MEMBER_DEVICE_CACHE_KEYS) {
      window.localStorage.setItem(key, 'stale');
      window.sessionStorage.setItem(key, 'stale');
    }

    clearMemberDeviceCache();

    for (const key of MEMBER_DEVICE_CACHE_KEYS) {
      expect(window.localStorage.getItem(key)).toBeNull();
      expect(window.sessionStorage.getItem(key)).toBeNull();
    }
  });

  it('leaves unrelated keys alone', () => {
    window.localStorage.setItem('theme', 'dark');
    window.localStorage.setItem('sb-access-token', 'owned-by-supabase');

    clearMemberDeviceCache();

    expect(window.localStorage.getItem('theme')).toBe('dark');
    expect(window.localStorage.getItem('sb-access-token')).toBe('owned-by-supabase');
  });

  it('is a no-op rather than a throw when a key was never written', () => {
    expect(() => clearMemberDeviceCache()).not.toThrow();
  });

  /**
   * A source assertion, deliberately. Rendering PortalLayout would need
   * @testing-library/react and a mocked Supabase client for one line of wiring;
   * this fails just as loudly if someone deletes the call, and costs nothing.
   */
  it('is wired into the portal sign-out path', async () => {
    // `pathToFileURL` rather than `new URL('../app/portal/PortalClientLayout.tsx',
    // import.meta.url)`: under the jsdom test environment on Windows, the
    // WHATWG URL implementation mis-resolves a `file:///E:/...` base with a
    // drive letter and silently falls back to the jsdom document's location
    // (`http://localhost:3000/...`), which then 404s. `pathToFileURL` builds
    // the URL from a plain filesystem path instead, sidestepping that base
    // resolution entirely.
    const layoutPath = path.join(__dirname, '..', 'app', 'portal', 'PortalClientLayout.tsx');
    const source = await readFile(pathToFileURL(layoutPath), 'utf8');
    expect(source).toContain('clearMemberDeviceCache()');
  });
});
