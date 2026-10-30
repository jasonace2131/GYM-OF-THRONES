import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));

vi.mock('./supabase', () => ({ supabase: { auth: { signOut } } }));

/**
 * The module keeps one flag for the page's lifetime, so every test loads a
 * fresh copy of it (and of the navigation seam it calls).
 */
async function load(): Promise<{
  mod: typeof import('./sessionReplaced');
  assign: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();
  const nav = await import('./loginCodeRedirect');
  const assign = vi.fn();
  nav.browserNavigation.assign = assign;
  const mod = await import('./sessionReplaced');
  return { mod, assign };
}

describe('sessionReplacedRedirectFor', () => {
  it('sends a page to /login with the reason, and the page and its query as next', async () => {
    const { mod } = await load();
    expect(mod.sessionReplacedRedirectFor('/portal/bookings', '?tab=past')).toBe(
      '/login?reason=replaced&next=%2Fportal%2Fbookings%3Ftab%3Dpast',
    );
    expect(mod.sessionReplacedRedirectFor('/desk/station', '?mode=staff')).toBe(
      '/login?reason=replaced&next=%2Fdesk%2Fstation%3Fmode%3Dstaff',
    );
  });

  it.each(['/login', '/', '/join/abc', '/register', '/reset-password'])(
    'leaves %s alone: that page deals with a signed-out visitor itself',
    async (pathname) => {
      const { mod } = await load();
      expect(mod.sessionReplacedRedirectFor(pathname, '')).toBeNull();
    },
  );
});

describe('signOutReplacedSession', () => {
  beforeEach(() => {
    signOut.mockReset().mockResolvedValue({ error: null });
    window.localStorage.setItem('got.member.profile', '{"name":"Juan"}');
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
    window.localStorage.clear();
  });

  it('signs out LOCALLY, never globally, so the newer device keeps its sign-in', async () => {
    window.history.pushState({}, '', '/portal/dashboard');
    const { mod } = await load();

    await mod.signOutReplacedSession();

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it("clears the member's device cache, like any sign-out", async () => {
    window.history.pushState({}, '', '/portal/dashboard');
    const { mod } = await load();

    await mod.signOutReplacedSession();

    expect(window.localStorage.getItem('got.member.profile')).toBeNull();
  });

  it('then loads the login page with the reason and this page as next', async () => {
    window.history.pushState({}, '', '/admin/members?page=2');
    const { mod, assign } = await load();

    await mod.signOutReplacedSession();

    expect(assign).toHaveBeenCalledWith(
      '/login?reason=replaced&next=%2Fadmin%2Fmembers%3Fpage%3D2',
    );
  });

  it('does it ONCE when several requests fail together', async () => {
    window.history.pushState({}, '', '/portal/dashboard');
    const { mod, assign } = await load();

    await Promise.all([
      mod.signOutReplacedSession(),
      mod.signOutReplacedSession(),
      mod.signOutReplacedSession(),
    ]);
    await mod.signOutReplacedSession();

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('still navigates when the sign-out itself fails', async () => {
    signOut.mockRejectedValue(new Error('offline'));
    window.history.pushState({}, '', '/portal/dashboard');
    const { mod, assign } = await load();

    await mod.signOutReplacedSession();

    expect(assign).toHaveBeenCalledWith('/login?reason=replaced&next=%2Fportal%2Fdashboard');
  });

  it('on the login page: signs out, does not navigate (no loop), and can run again later', async () => {
    window.history.pushState({}, '', '/login?next=%2Fadmin');
    const { mod, assign } = await load();

    await mod.signOutReplacedSession();
    expect(assign).not.toHaveBeenCalled();
    expect(mod.sessionWasReplaced()).toBe(false);

    await mod.signOutReplacedSession();
    expect(signOut).toHaveBeenCalledTimes(2);
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('signedOutLoginPath — where the shells send a signed-out visitor', () => {
  beforeEach(() => {
    signOut.mockReset().mockResolvedValue({ error: null });
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('is the plain /login?next= normally', async () => {
    const { mod } = await load();
    expect(mod.sessionWasReplaced()).toBe(false);
    expect(mod.signedOutLoginPath('/admin', '')).toBe('/login?next=%2Fadmin');
  });

  it("is apiFetch's own ?reason=replaced address once the sign-out has started", async () => {
    window.history.pushState({}, '', '/admin');
    const { mod } = await load();

    // Not awaited: the shell reacts while the sign-out is still in flight.
    const pending = mod.signOutReplacedSession();
    expect(mod.sessionWasReplaced()).toBe(true);
    expect(mod.signedOutLoginPath('/admin', '')).toBe('/login?reason=replaced&next=%2Fadmin');
    await pending;
  });
});
