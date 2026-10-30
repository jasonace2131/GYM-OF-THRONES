import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchStationBatch, isBatchStale } from './stationClient';

const TABLET = { kind: 'STATION_KEY', key: 'k-123' } as const;
const STAFF = { kind: 'STAFF_SESSION', accessToken: 'jwt-abc' } as const;

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function headersOf(call: unknown[]): Record<string, string> {
  return (call[1] as RequestInit).headers as Record<string, string>;
}

describe('fetchStationBatch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('authenticates a tablet with its key and never a Bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { success: true, data: {} }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchStationBatch(TABLET, null);

    const headers = headersOf(fetchMock.mock.calls[0]!);
    expect(headers['X-Station-Key']).toBe('k-123');
    expect(headers['Authorization']).toBeUndefined();
  });

  it("authenticates the staff display with the staff member's own session and no key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { success: true, data: {} }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchStationBatch(STAFF, 'ZDQA');

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toMatch(/\/checkin\/station-tokens\?station=ZDQA$/);
    expect(headers['Authorization']).toBe('Bearer jwt-abc');
    expect(headers['X-Station-Key']).toBeUndefined();
  });

  it('reads a refused tablet key as revoked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(401, { success: false })));
    expect(await fetchStationBatch(TABLET, null)).toEqual({ kind: 'REVOKED' });
  });

  it('reads a 401 on the staff display as an expired login — send them to sign in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(401, { success: false })));
    expect(await fetchStationBatch(STAFF, null)).toEqual({ kind: 'SESSION_EXPIRED' });
  });

  it('reads 401 SESSION_REPLACED on the staff display as signed in on another device', async () => {
    const replaced = {
      success: false,
      error: { code: 'SESSION_REPLACED', message: 'Signed in on another device.' },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(401, replaced)));
    expect(await fetchStationBatch(STAFF, null)).toEqual({ kind: 'SESSION_REPLACED' });
  });

  it('keeps a tablet key 401 as revoked, whatever its code: a tablet has no sign-in', async () => {
    const replaced = { success: false, error: { code: 'SESSION_REPLACED', message: 'x' } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(401, replaced)));
    expect(await fetchStationBatch(TABLET, null)).toEqual({ kind: 'REVOKED' });
  });

  it('reads a 403 on the staff display as an account that may not show the code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(403, { success: false })));
    expect(await fetchStationBatch(STAFF, null)).toEqual({ kind: 'FORBIDDEN' });
  });

  it('reads 410 GYM_CLOSED as closed, carrying the next opening, for either credential', async () => {
    const closed = {
      success: false,
      error: {
        code: 'GYM_CLOSED',
        message: 'The gym is closed.',
        details: { nextOpensAt: '2026-09-26T21:00:00.000Z' },
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(410, closed)));

    expect(await fetchStationBatch(STAFF, null)).toEqual({
      kind: 'CLOSED',
      nextOpensAt: '2026-09-26T21:00:00.000Z',
    });
  });

  it('keeps the server message when the station cannot be resolved', async () => {
    const ambiguous = {
      success: false,
      error: { code: 'STATION_AMBIGUOUS', message: 'More than one active station exists.' },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(409, ambiguous)));

    expect(await fetchStationBatch(STAFF, null)).toEqual({
      kind: 'OFFLINE',
      message: 'More than one active station exists.',
    });
  });
});

describe('isBatchStale', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the same credential on the head check as on the batch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await isBatchStale(STAFF, null, 'ZDQA:1:100')).toBe(false);

    const headers = headersOf(fetchMock.mock.calls[0]!);
    expect(headers['Authorization']).toBe('Bearer jwt-abc');
    expect(headers['If-None-Match']).toBe('ZDQA:1:100');
    expect(headers['X-Station-Key']).toBeUndefined();
  });

  it('is stale on a 409', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 409 })));
    expect(await isBatchStale(TABLET, null, 'ZDQA:1:100')).toBe(true);
  });
});
