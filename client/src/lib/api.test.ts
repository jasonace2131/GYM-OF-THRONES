import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'test-token' } } }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
  },
}));

import { ApiError, apiFetch, onApiForbidden } from './api';
import { browserNavigation } from './loginCodeRedirect';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('apiFetch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('unwraps the envelope on success', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true, data: { id: 'abc' } }));

    await expect(apiFetch<{ id: string }>('/me')).resolves.toEqual({ id: 'abc' });
  });

  it('attaches the Supabase access token', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true, data: null }));

    await apiFetch('/me');

    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer test-token');
  });

  it('throws an ApiError carrying the status and the domain code', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: { code: 'COACH_SELF_ASSIGNMENT', message: 'A coach cannot coach themselves' },
        },
        422,
      ),
    );

    await expect(apiFetch('/coach-assignments')).rejects.toMatchObject({
      name: 'ApiError',
      status: 422,
      code: 'COACH_SELF_ASSIGNMENT',
      message: 'A coach cannot coach themselves',
    });
  });

  it('is still an Error, so existing callers are unaffected', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ success: false, error: { code: 'HTTP_403', message: 'Forbidden' } }, 403),
    );

    await expect(apiFetch('/admin/permissions')).rejects.toBeInstanceOf(Error);
    await expect(apiFetch('/admin/permissions')).rejects.toBeInstanceOf(ApiError);
  });

  it('falls back to HTTP_<status> when the body carries no code', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: false }, 401));

    await expect(apiFetch('/me')).rejects.toMatchObject({ status: 401, code: 'HTTP_401' });
  });

  it('reports a non-JSON response as INVALID_RESPONSE rather than a parse crash', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    } as unknown as Response);

    await expect(apiFetch('/me')).rejects.toMatchObject({ status: 502, code: 'INVALID_RESPONSE' });
  });
});

/**
 * The signal the `/me` providers listen to. A 403 usually means the
 * permission set on screen is stale, so the provider re-fetches `/me` and the
 * nav and page guards catch up. It must not change what apiFetch throws.
 */
describe('onApiForbidden', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('tells listeners about a 403, with the path, and still throws the same ApiError', async () => {
    const seen: string[] = [];
    const off = onApiForbidden((path) => seen.push(path));
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ success: false, error: { code: 'HTTP_403', message: 'Forbidden' } }, 403),
    );

    await expect(apiFetch('/reports/revenue')).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      code: 'HTTP_403',
      message: 'Forbidden',
    });
    expect(seen).toEqual(['/reports/revenue']);
    off();
  });

  it('says nothing for a success, a 401 or any other failure', async () => {
    const seen: string[] = [];
    const off = onApiForbidden((path) => seen.push(path));

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: true, data: null }));
    await apiFetch('/me');
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: false }, 401));
    await expect(apiFetch('/me')).rejects.toBeInstanceOf(ApiError);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: false }, 422));
    await expect(apiFetch('/payments')).rejects.toBeInstanceOf(ApiError);

    expect(seen).toEqual([]);
    off();
  });

  it('stops telling a listener once it unsubscribes', async () => {
    const seen: string[] = [];
    const off = onApiForbidden((path) => seen.push(path));
    off();
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: false }, 403));

    await expect(apiFetch('/audit')).rejects.toBeInstanceOf(ApiError);
    expect(seen).toEqual([]);
  });

  it('keeps apiFetch throwing even when a listener itself throws', async () => {
    const off = onApiForbidden(() => {
      throw new Error('listener bug');
    });
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: false }, 403));

    await expect(apiFetch('/audit')).rejects.toMatchObject({ name: 'ApiError', status: 403 });
    off();
  });
});

describe('apiFetch idempotency header', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function stubFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { id: '1' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function headersOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
    return (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
  }

  it('sets a UUID Idempotency-Key on a POST', async () => {
    const fetchMock = stubFetch();

    await apiFetch('/payments', { method: 'POST', body: JSON.stringify({ a: 1 }) });

    expect(headersOf(fetchMock)['Idempotency-Key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  // Chunk 1 is scheduled to change this: a user-visible retry of the same
  // logical write should reuse one Idempotency-Key rather than minting a
  // fresh one. This test pins today's per-call behaviour only — it is not a
  // statement that key reuse across calls is wrong.
  it('mints a fresh key per apiFetch call, absent any retry/reuse wiring', async () => {
    const fetchMock = stubFetch();

    await apiFetch('/payments', { method: 'POST' });
    await apiFetch('/payments', { method: 'POST' });

    const first = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    const second = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(first['Idempotency-Key']).not.toBe(second['Idempotency-Key']);
  });

  it('never sets the header on a GET', async () => {
    const fetchMock = stubFetch();

    await apiFetch('/me');

    expect(headersOf(fetchMock)['Idempotency-Key']).toBeUndefined();
  });
});

describe('apiFetch — LOGIN_CODE_REQUIRED', () => {
  let assign: MockInstance<(url: string) => void>;

  const required = (): Response =>
    jsonResponse(
      {
        success: false,
        error: { code: 'LOGIN_CODE_REQUIRED', message: 'Enter the 6-digit code we emailed you.' },
      },
      401,
    );

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    assign = vi.spyOn(browserNavigation, 'assign').mockImplementation(() => undefined);
  });

  afterEach(() => {
    assign.mockRestore();
    window.history.pushState({}, '', '/');
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('sends the browser to /login with this page as next, and still throws the ApiError', async () => {
    window.history.pushState({}, '', '/portal/bookings?tab=past');
    vi.mocked(fetch).mockResolvedValue(required());

    await expect(apiFetch('/me')).rejects.toMatchObject({
      status: 401,
      code: 'LOGIN_CODE_REQUIRED',
    });
    expect(assign).toHaveBeenCalledWith('/login?next=%2Fportal%2Fbookings%3Ftab%3Dpast');
  });

  it('stays on /login, which shows the code step itself', async () => {
    window.history.pushState({}, '', '/login?next=%2Fadmin');
    vi.mocked(fetch).mockResolvedValue(required());

    await expect(apiFetch('/me')).rejects.toMatchObject({ code: 'LOGIN_CODE_REQUIRED' });
    expect(assign).not.toHaveBeenCalled();
  });

  it('does not navigate on an ordinary 401', async () => {
    window.history.pushState({}, '', '/portal/dashboard');
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: false }, 401));

    await expect(apiFetch('/me')).rejects.toMatchObject({ status: 401, code: 'HTTP_401' });
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('apiFetch — SESSION_REPLACED (one device at a time)', () => {
  const replacedResponse = (): Response =>
    jsonResponse(
      {
        success: false,
        error: {
          code: 'SESSION_REPLACED',
          message: 'You were signed out because your account signed in on another device.',
        },
      },
      401,
    );

  /** A fresh copy: the sign-out runs once per page, and each test is a new page. */
  async function load(): Promise<{
    fetchApi: typeof apiFetch;
    signOut: ReturnType<typeof vi.fn>;
    assign: ReturnType<typeof vi.fn>;
  }> {
    vi.resetModules();
    const nav = await import('./loginCodeRedirect');
    const assign = vi.fn();
    nav.browserNavigation.assign = assign;
    const { supabase } = await import('./supabase');
    const api = await import('./api');
    return {
      fetchApi: api.apiFetch,
      signOut: vi.mocked(supabase.auth.signOut) as unknown as ReturnType<typeof vi.fn>,
      assign,
    };
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('signs this device out LOCALLY, goes to the login notice, and still throws', async () => {
    window.history.pushState({}, '', '/portal/bookings?tab=past');
    vi.mocked(fetch).mockResolvedValue(replacedResponse());
    const { fetchApi, signOut, assign } = await load();

    await expect(fetchApi('/me')).rejects.toMatchObject({ status: 401, code: 'SESSION_REPLACED' });
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());

    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(assign).toHaveBeenCalledWith(
      '/login?reason=replaced&next=%2Fportal%2Fbookings%3Ftab%3Dpast',
    );
  });

  it('signs out and navigates once, however many requests fail together', async () => {
    window.history.pushState({}, '', '/admin');
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(replacedResponse()));
    const { fetchApi, signOut, assign } = await load();

    const results = await Promise.allSettled([fetchApi('/me'), fetchApi('/a'), fetchApi('/b')]);
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('on the login page: signs out locally but stays, so the page shows why itself', async () => {
    window.history.pushState({}, '', '/login?next=%2Fadmin');
    vi.mocked(fetch).mockResolvedValue(replacedResponse());
    const { fetchApi, signOut, assign } = await load();

    await expect(fetchApi('/me')).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledWith({ scope: 'local' }));
    expect(assign).not.toHaveBeenCalled();
  });

  it('signs nobody out on an ordinary 401', async () => {
    window.history.pushState({}, '', '/portal/dashboard');
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: false }, 401));
    const { fetchApi, signOut, assign } = await load();

    await expect(fetchApi('/me')).rejects.toMatchObject({ status: 401, code: 'HTTP_401' });
    expect(signOut).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});
