import { describe, expect, it, vi } from 'vitest';
import { run, type Env } from './index';

const HEALTHY = JSON.stringify({ success: true, data: { status: 'ok' } });

function memoryKv(initial: unknown = null) {
  let value: string | null = initial === null ? null : JSON.stringify(initial);
  return {
    get: vi.fn(async () => (value === null ? null : JSON.parse(value))),
    put: vi.fn(async (_key: string, next: string) => {
      value = next;
    }),
    read: () => (value === null ? null : JSON.parse(value)),
  };
}

function env(kv: ReturnType<typeof memoryKv>, overrides: Partial<Env> = {}): Env {
  return {
    HEALTH_URL: 'https://site.test/api/health',
    DIRECT_URL: 'https://api.test/api/health',
    TELEGRAM_BOT_TOKEN: 'SECRET-TOKEN',
    TELEGRAM_CHAT_ID: '12345',
    PINGER_STATE: kv,
    ...overrides,
  };
}

/** A fetch that answers per host, and records every Telegram call. */
function network({ site, direct, telegram }: { site: number; direct: number; telegram: number }) {
  const sent: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://api.telegram.org/')) {
      sent.push(JSON.parse(String(init?.body)).text);
      return new Response('{}', { status: telegram });
    }
    const status = url.startsWith('https://site.test') ? site : direct;
    return new Response(status === 200 ? HEALTHY : 'down', { status });
  }) as typeof fetch;
  return { impl, sent };
}

const NOW = new Date('2026-09-23T06:14:00Z');
const FAST = { timeoutMs: 1000, retryDelayMs: 0 };

describe('run — one scheduled tick, end to end', () => {
  it('sends one DOWN alert with the diagnosis, and records it', async () => {
    const kv = memoryKv({ status: 'up', since: '2026-09-22T00:00:00Z', lastAlertAt: null });
    const net = network({ site: 502, direct: 503, telegram: 200 });
    await run(env(kv), NOW, net.impl, FAST);

    expect(net.sent).toHaveLength(1);
    expect(net.sent[0]).toContain('DOWN');
    expect(net.sent[0]).toContain('HTTP 502 (twice)');
    expect(net.sent[0]).toContain("Render isn't answering directly either (HTTP 503)");
    expect(kv.read().status).toBe('down');
  });

  /**
   * THE RULE THIS TEST EXISTS FOR. If Telegram rejects the message and the
   * state is saved anyway, the pinger believes it has told the owner and
   * stays silent for the rest of the outage. Not saving means the next tick
   * sees "was up, now down" and tries again.
   */
  it('does not record an alert that failed to send', async () => {
    const kv = memoryKv({ status: 'up', since: '2026-09-22T00:00:00Z', lastAlertAt: null });
    const net = network({ site: 502, direct: 503, telegram: 500 });
    await run(env(kv), NOW, net.impl, FAST);

    expect(net.sent).toHaveLength(1);
    expect(kv.put).not.toHaveBeenCalled();
    expect(kv.read().status).toBe('up');
  });

  it('writes nothing and sends nothing on an ordinary healthy tick', async () => {
    const kv = memoryKv({ status: 'up', since: '2026-09-22T00:00:00Z', lastAlertAt: null });
    const net = network({ site: 200, direct: 200, telegram: 200 });
    await run(env(kv), NOW, net.impl, FAST);

    expect(net.sent).toHaveLength(0);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('skips the direct probe entirely while healthy', async () => {
    const kv = memoryKv({ status: 'up', since: '2026-09-22T00:00:00Z', lastAlertAt: null });
    const calls: string[] = [];
    const impl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(HEALTHY, { status: 200 });
    }) as typeof fetch;
    await run(env(kv), NOW, impl, FAST);
    expect(calls).toEqual(['https://site.test/api/health']);
  });

  it('never writes the bot token to the log, even when Telegram fails', async () => {
    const kv = memoryKv({ status: 'up', since: '2026-09-22T00:00:00Z', lastAlertAt: null });
    const net = network({ site: 502, direct: 503, telegram: 401 });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await run(env(kv), NOW, net.impl, FAST);

    const logged = log.mock.calls.flat().map(String).join(' ');
    log.mockRestore();
    expect(logged).toContain('401');
    expect(logged).not.toContain('SECRET-TOKEN');
  });

  it('logs rather than crashes when the Telegram secrets are missing', async () => {
    const kv = memoryKv({ status: 'up', since: '2026-09-22T00:00:00Z', lastAlertAt: null });
    const net = network({ site: 502, direct: 503, telegram: 200 });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await run(env(kv, { TELEGRAM_BOT_TOKEN: undefined }), NOW, net.impl, FAST);
    log.mockRestore();

    expect(net.sent).toHaveLength(0);
    expect(kv.put).not.toHaveBeenCalled();
  });
});
