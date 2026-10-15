import { describe, expect, it } from 'vitest';
import { handleUpdate, normalizeChatId, parseCommand, safeEqual, type CommandEnv } from './commands';

const HEALTHY = JSON.stringify({ success: true, data: { status: 'ok' } });
const GROUP = '-5492583912';

function env(state: unknown = { status: 'up', since: '2026-09-23T02:30:00Z', lastAlertAt: null }): CommandEnv {
  return {
    HEALTH_URL: 'https://site.test/api/health',
    DIRECT_URL: 'https://api.test/api/health',
    TELEGRAM_CHAT_ID: GROUP,
    BOT_USERNAME: 'GYM_OF_THRONES_BOT',
    PINGER_STATE: { get: async () => state, put: async () => {} },
  };
}

function net(site: number | 'hang', direct = 200) {
  const calls: string[] = [];
  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const status = url.startsWith('https://site.test') ? site : direct;
    if (status === 'hang') {
      return new Promise((_r, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      );
    }
    return Promise.resolve(new Response(status === 200 ? HEALTHY : 'down', { status }));
  }) as typeof fetch;
  return { impl, calls };
}

const msg = (text: string, chatId: number | string = GROUP) => ({
  message: { message_id: 7, text, chat: { id: Number(chatId) } },
});

const FAST = { memberTimeoutMs: 30, directTimeoutMs: 30 };
let tick = 0;
const clock = () => (tick += 420); // every read advances 0.42s

describe('parseCommand', () => {
  it.each([
    ['/check', 'check'],
    ['/check@GYM_OF_THRONES_BOT', 'check'],
    ['/check@gym_of_thrones_bot', 'check'],
    ['/check now please', 'check'],
    ['/help', 'help'],
    ['/start', 'help'],
  ])('%s -> %s', (text, expected) => {
    expect(parseCommand(text, 'GYM_OF_THRONES_BOT')).toBe(expected);
  });

  it.each([
    ['/check@SomeOtherBot', 'addressed to a different bot in the same group'],
    ['/checkup', 'a longer command that merely starts with check'],
    ['check', 'no slash'],
    ['hello everyone', 'ordinary conversation'],
    ['', 'empty'],
  ])('ignores %s (%s)', (text) => {
    expect(parseCommand(text, 'GYM_OF_THRONES_BOT')).toBeNull();
  });

  it('ignores a message with no text at all (a photo, a sticker)', () => {
    expect(parseCommand(undefined, 'GYM_OF_THRONES_BOT')).toBeNull();
  });
});

describe('safeEqual — the webhook secret comparison', () => {
  it('matches only the exact secret', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
    expect(safeEqual('abc123', 'abc124')).toBe(false);
    expect(safeEqual('abc123', 'abc1234')).toBe(false);
    expect(safeEqual('', 'abc')).toBe(false);
  });
});

describe('handleUpdate — who gets an answer', () => {
  /**
   * The bot is public: anyone can find it by username and message it. It
   * answers in the staff group only, and says nothing at all elsewhere —
   * not even "not allowed", which would confirm there is something to probe.
   */
  it('ignores /check from any chat but the staff group, without probing', async () => {
    const n = net(200);
    const reply = await handleUpdate(msg('/check', 99999), env(), n.impl, clock, FAST);
    expect(reply).toBeNull();
    expect(n.calls).toEqual([]);
  });

  it('ignores ordinary group chatter', async () => {
    const n = net(200);
    expect(await handleUpdate(msg('anyone training tonight?'), env(), n.impl, clock, FAST)).toBeNull();
    expect(n.calls).toEqual([]);
  });

  it('ignores updates that are not messages', async () => {
    const n = net(200);
    expect(await handleUpdate({ my_chat_member: {} }, env(), n.impl, clock, FAST)).toBeNull();
    expect(await handleUpdate(null, env(), n.impl, clock, FAST)).toBeNull();
  });
});

describe('handleUpdate — what /check says', () => {
  it('reports online with how long the site took to answer', async () => {
    const reply = await handleUpdate(msg('/check'), env(), net(200).impl, clock, FAST);
    expect(reply?.text).toMatch(/^🟢 Online/);
    expect(reply?.text).toMatch(/answered in 0\.4s/);
    expect(reply?.replyTo).toBe(7);
  });

  it('only probes the member path when it is healthy', async () => {
    const n = net(200);
    await handleUpdate(msg('/check'), env(), n.impl, clock, FAST);
    expect(n.calls).toEqual(['https://site.test/api/health']);
  });

  it('names the failure and which leg broke', async () => {
    const reply = await handleUpdate(msg('/check'), env(), net(502, 200).impl, clock, FAST);
    expect(reply?.text).toMatch(/^🔴/);
    expect(reply?.text).toContain('HTTP 502');
    expect(reply?.text).toMatch(/Vercel/);
  });

  /**
   * Overnight the API sleeps and takes ~50s to wake, longer than a reply can
   * wait. A timeout there is not necessarily an outage — and the check that
   * timed out has already started the wake-up.
   */
  it('says to try again when it times out, since the probe itself wakes the API', async () => {
    const reply = await handleUpdate(msg('/check'), env(), net('hang', 200).impl, clock, FAST);
    expect(reply?.text).toContain('no answer');
    expect(reply?.text).toMatch(/try \/check again/i);
  });

  it('flags when the scheduled alerts still think it is down', async () => {
    const stillDown = { status: 'down', since: '2026-09-23T02:40:34Z', lastAlertAt: '2026-09-23T02:40:34Z' };
    const reply = await handleUpdate(msg('/check'), env(stillDown), net(200).impl, clock, FAST);
    expect(reply?.text).toMatch(/recovery/i);
  });

  it('never writes the alert state — /check is read-only', async () => {
    let wrote = false;
    const e = env();
    e.PINGER_STATE.put = async () => {
      wrote = true;
    };
    await handleUpdate(msg('/check'), e, net(502).impl, clock, FAST);
    expect(wrote).toBe(false);
  });

  it('answers /help with what the bot does', async () => {
    const reply = await handleUpdate(msg('/help'), env(), net(200).impl, clock, FAST);
    expect(reply?.text).toContain('/check');
  });
});

describe('normalizeChatId — what a pasted chat id can drag along', () => {
  /**
   * 2026-09-23: /check was silently ignored. The configured id was 12
   * characters against the group's 11, yet alerts to it were delivered —
   * Telegram reads past a stray character when sending, the strict
   * comparison on receiving did not. Copying the id out of getUpdates JSON
   * picks up the trailing comma.
   */
  it('drops a trailing comma copied out of JSON', () => {
    expect(normalizeChatId('-5492583912,')).toEqual({ id: '-5492583912', stripped: ["','"] });
  });

  it('drops invisible characters that trim() leaves behind', () => {
    expect(normalizeChatId('\u200E-5492583912')).toEqual({ id: '-5492583912', stripped: ['U+200E'] });
    expect(normalizeChatId('-5492583912\u200B')).toEqual({ id: '-5492583912', stripped: ['U+200B'] });
  });

  it('turns a typographic minus into the ASCII one', () => {
    expect(normalizeChatId('\u22125492583912').id).toBe('-5492583912');
  });

  it('drops quotes and whitespace', () => {
    expect(normalizeChatId(' "-5492583912"\n').id).toBe('-5492583912');
  });

  it('leaves a clean id alone', () => {
    expect(normalizeChatId('-5492583912')).toEqual({ id: '-5492583912', stripped: [] });
  });

  it('is undefined when nothing is configured', () => {
    expect(normalizeChatId(undefined)).toEqual({ id: undefined, stripped: [] });
  });

  it('answers /check when the configured id carries the stray comma', async () => {
    const e = { ...env(), TELEGRAM_CHAT_ID: '-5492583912,' };
    const reply = await handleUpdate(msg('/check'), e, net(200).impl, clock, FAST);
    expect(reply?.text).toMatch(/^🟢 Online/);
  });
});
