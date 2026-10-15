import { describe, expect, it } from 'vitest';
import {
  REMINDER_MS,
  checkHealth,
  checkWithRetry,
  decide,
  diagnose,
  formatDuration,
  formatManila,
  type PingerState,
} from './monitor';

const T0 = new Date('2026-09-23T06:14:00Z'); // 2:14 PM Manila
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const UP: PingerState = { status: 'up', since: at(-600).toISOString(), lastAlertAt: null };
const DOWN_AT_T0: PingerState = { status: 'down', since: T0.toISOString(), lastAlertAt: T0.toISOString() };
const FAIL = { ok: false as const, detail: 'no answer after 45s' };
const OK = { ok: true as const };

describe('decide — when a message is sent, and when nothing is written', () => {
  it('stays silent and writes nothing while the API is up', () => {
    const d = decide(UP, OK, T0);
    expect(d.message).toBeNull();
    expect(d.persist).toBe(false);
  });

  it('alerts once when the API goes down', () => {
    const d = decide(UP, FAIL, T0, 'Render is not answering.');
    expect(d.message).toContain('DOWN');
    expect(d.message).toContain('no answer after 45s');
    expect(d.message).toContain('Render is not answering.');
    expect(d.message).toContain('2:14 PM');
    expect(d.next).toEqual({ status: 'down', since: T0.toISOString(), lastAlertAt: T0.toISOString() });
    expect(d.persist).toBe(true);
  });

  /**
   * Checks run every ten minutes. Without this the chat would buzz six times
   * an hour for one outage, and the owner would mute it — which is how an
   * alert channel stops being one.
   */
  it('does not repeat itself inside the reminder window', () => {
    const d = decide(DOWN_AT_T0, FAIL, at(10));
    expect(d.message).toBeNull();
    expect(d.persist).toBe(false);
  });

  it('reminds after thirty minutes, with how long it has been down', () => {
    const d = decide(DOWN_AT_T0, FAIL, new Date(T0.getTime() + REMINDER_MS));
    expect(d.message).toContain('Still down');
    expect(d.message).toContain('30 min');
    expect(d.next.since).toBe(T0.toISOString()); // the outage start does not move
    expect(d.next.lastAlertAt).toBe(new Date(T0.getTime() + REMINDER_MS).toISOString());
    expect(d.persist).toBe(true);
  });

  it('announces recovery with the outage length and window', () => {
    const d = decide(DOWN_AT_T0, OK, at(23));
    expect(d.message).toContain('back');
    expect(d.message).toContain('23 min');
    expect(d.message).toContain('2:14 PM');
    expect(d.message).toContain('2:37 PM');
    expect(d.next.status).toBe('up');
    expect(d.next.lastAlertAt).toBeNull();
    expect(d.persist).toBe(true);
  });

  it('records a baseline on its very first run without messaging', () => {
    const d = decide(null, OK, T0);
    expect(d.message).toBeNull();
    expect(d.next.status).toBe('up');
    expect(d.persist).toBe(true);
  });

  it('alerts on its very first run if the API is already down', () => {
    const d = decide(null, FAIL, T0);
    expect(d.message).toContain('DOWN');
    expect(d.next.status).toBe('down');
  });
});

describe('diagnose — which leg failed', () => {
  it('blames the Vercel leg when Render answers directly', () => {
    expect(diagnose(OK)).toMatch(/Vercel/);
  });

  it('sends the owner to Render when Render is silent too', () => {
    const text = diagnose({ ok: false, detail: 'HTTP 503' });
    expect(text).toContain('HTTP 503');
    expect(text).toMatch(/Render dashboard/);
    // The cause the 2026-09-23 outage pointed at first: the free-hour budget.
    expect(text).toMatch(/free instance hours/);
  });
});

describe('formatting, in the gym’s clock', () => {
  it('prints Manila time regardless of where the Worker runs', () => {
    expect(formatManila(T0)).toBe('2:14 PM');
    expect(formatManila(new Date('2026-09-22T22:00:00Z'))).toBe('6:00 AM');
  });

  it('reads durations the way a person would say them', () => {
    expect(formatDuration(20_000)).toBe('under a minute');
    expect(formatDuration(23 * 60_000)).toBe('23 min');
    expect(formatDuration(65 * 60_000)).toBe('1 h 5 min');
    expect(formatDuration(120 * 60_000)).toBe('2 h');
  });
});

describe('checkHealth — what counts as healthy', () => {
  const respond = (status: number, body: unknown) =>
    (async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as typeof fetch;

  it('is healthy only on the API’s own success envelope', async () => {
    const r = await checkHealth('https://x.test/api/health', 1000, respond(200, { success: true, data: { status: 'ok' } }));
    expect(r).toEqual({ ok: true });
  });

  /**
   * Vercel answers 502/504 with an HTML error page when Render is dead. A
   * check that only looked at "did something answer" would call that up.
   */
  it('treats a gateway error from the proxy as down', async () => {
    const r = await checkHealth('https://x.test/api/health', 1000, respond(504, '<html>Gateway Timeout</html>'));
    expect(r).toEqual({ ok: false, detail: 'HTTP 504' });
  });

  it('treats a 200 that is not the health envelope as down', async () => {
    const r = await checkHealth('https://x.test/api/health', 1000, respond(200, '<html>some other page</html>'));
    expect(r.ok).toBe(false);
  });

  it('gives up after the timeout and says so', async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    const r = await checkHealth('https://x.test/api/health', 30, hang);
    expect(r).toEqual({ ok: false, detail: 'no answer after 0.03s' });
  });

  it('reports a connection failure rather than throwing', async () => {
    const refuse = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const r = await checkHealth('https://x.test/api/health', 1000, refuse);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('could not connect');
  });
});

describe('checkWithRetry — riding out a cold start', () => {
  /**
   * Render's free tier sleeps overnight and takes ~50s to wake. The first
   * check of the morning can time out on a perfectly healthy API; one retry
   * is the difference between that and a false 6am alert.
   */
  it('is healthy if the second attempt succeeds', async () => {
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      return calls === 1
        ? new Response('', { status: 503 })
        : new Response(JSON.stringify({ success: true, data: { status: 'ok' } }), { status: 200 });
    }) as typeof fetch;
    const r = await checkWithRetry('https://x.test/api/health', { timeoutMs: 1000, retryDelayMs: 0 }, flaky);
    expect(r).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('does not retry a healthy first answer', async () => {
    let calls = 0;
    const healthy = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ success: true, data: { status: 'ok' } }), { status: 200 });
    }) as typeof fetch;
    await checkWithRetry('https://x.test/api/health', { timeoutMs: 1000, retryDelayMs: 0 }, healthy);
    expect(calls).toBe(1);
  });

  it('reports down with the last failure when both attempts fail', async () => {
    const dead = (async () => new Response('', { status: 502 })) as typeof fetch;
    const r = await checkWithRetry('https://x.test/api/health', { timeoutMs: 1000, retryDelayMs: 0 }, dead);
    expect(r).toEqual({ ok: false, detail: 'HTTP 502 (twice)' });
  });
});
