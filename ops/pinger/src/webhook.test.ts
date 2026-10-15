import { describe, expect, it } from 'vitest';
import { handleRequest, type Env } from './index';

const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const GROUP = '-5492583912';
const HEALTHY = JSON.stringify({ success: true, data: { status: 'ok' } });

function env(overrides: Partial<Env> = {}): Env {
  return {
    HEALTH_URL: 'https://site.test/api/health',
    DIRECT_URL: 'https://api.test/api/health',
    TELEGRAM_BOT_TOKEN: 'BOT-TOKEN',
    TELEGRAM_CHAT_ID: GROUP,
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    BOT_USERNAME: 'GYM_OF_THRONES_BOT',
    PINGER_STATE: { get: async () => null, put: async () => {} },
    ...overrides,
  };
}

/** Records every Telegram API call; the site is always healthy. */
function network() {
  const telegram: { method: string; body: Record<string, unknown> }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://api.telegram.org/')) {
      telegram.push({ method: url.split('/').pop() ?? '', body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, result: true, description: 'Webhook was set' }), { status: 200 });
    }
    return new Response(HEALTHY, { status: 200 });
  }) as typeof fetch;
  return { impl, telegram };
}

function context() {
  const waits: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => void waits.push(p) }, settle: () => Promise.all(waits) };
}

const update = (text: string) =>
  JSON.stringify({ update_id: 1, message: { message_id: 42, text, chat: { id: Number(GROUP) } } });

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  new Request(`https://pinger.test${path}`, { method: 'POST', body, headers });

describe('the webhook — what gets in', () => {
  it('rejects a /telegram call without Telegram’s secret header', async () => {
    const n = network();
    const { ctx, settle } = context();
    const res = await handleRequest(post('/telegram', update('/check')), env(), ctx, n.impl);
    await settle();
    expect(res.status).toBe(403);
    expect(n.telegram).toEqual([]);
  });

  it('rejects the wrong secret', async () => {
    const n = network();
    const { ctx, settle } = context();
    const res = await handleRequest(
      post('/telegram', update('/check'), { 'x-telegram-bot-api-secret-token': 'guess' }),
      env(),
      ctx,
      n.impl,
    );
    await settle();
    expect(res.status).toBe(403);
    expect(n.telegram).toEqual([]);
  });

  /** An unset secret must mean closed, never "no check configured, let everyone in". */
  it('stays closed when no webhook secret is configured', async () => {
    const n = network();
    const { ctx } = context();
    const res = await handleRequest(
      post('/telegram', update('/check'), { 'x-telegram-bot-api-secret-token': '' }),
      env({ TELEGRAM_WEBHOOK_SECRET: undefined }),
      ctx,
      n.impl,
    );
    expect(res.status).toBe(403);
  });

  /**
   * Telegram retries a webhook that is slow to answer, which would post the
   * same reply twice. So the webhook answers at once and does the check
   * afterwards.
   */
  it('answers Telegram immediately and replies in the thread afterwards', async () => {
    const n = network();
    const { ctx, settle } = context();
    const res = await handleRequest(
      post('/telegram', update('/check'), { 'x-telegram-bot-api-secret-token': SECRET }),
      env(),
      ctx,
      n.impl,
    );
    expect(res.status).toBe(200);
    await settle();
    expect(n.telegram).toHaveLength(1);
    expect(n.telegram[0].method).toBe('sendMessage');
    expect(n.telegram[0].body.chat_id).toBe(GROUP);
    expect(n.telegram[0].body.reply_to_message_id).toBe(42);
    expect(String(n.telegram[0].body.text)).toMatch(/^🟢 Online/);
  });

  it('acknowledges but stays silent for chatter', async () => {
    const n = network();
    const { ctx, settle } = context();
    const res = await handleRequest(
      post('/telegram', update('good morning'), { 'x-telegram-bot-api-secret-token': SECRET }),
      env(),
      ctx,
      n.impl,
    );
    await settle();
    expect(res.status).toBe(200);
    expect(n.telegram).toEqual([]);
  });

  it('serves nothing else', async () => {
    const n = network();
    const { ctx } = context();
    expect((await handleRequest(new Request('https://pinger.test/'), env(), ctx, n.impl)).status).toBe(404);
    expect((await handleRequest(new Request('https://pinger.test/telegram'), env(), ctx, n.impl)).status).toBe(404);
  });
});

describe('/telegram/register — the one-time setup', () => {
  it('refuses without the key', async () => {
    const n = network();
    const { ctx } = context();
    const res = await handleRequest(post('/telegram/register', ''), env(), ctx, n.impl);
    expect(res.status).toBe(403);
    expect(n.telegram).toEqual([]);
  });

  it('points Telegram at this Worker with the secret, and publishes the command menu', async () => {
    const n = network();
    const { ctx } = context();
    const res = await handleRequest(post('/telegram/register', '', { 'x-register-key': SECRET }), env(), ctx, n.impl);
    expect(res.status).toBe(200);

    const webhook = n.telegram.find((c) => c.method === 'setWebhook');
    expect(webhook?.body.url).toBe('https://pinger.test/telegram');
    expect(webhook?.body.secret_token).toBe(SECRET);
    expect(webhook?.body.allowed_updates).toEqual(['message']);

    const commands = n.telegram.find((c) => c.method === 'setMyCommands');
    expect(JSON.stringify(commands?.body)).toContain('"command":"check"');
    expect(JSON.stringify(commands?.body)).toContain('"command":"redeploy"');
  });

  it('never echoes the secret or the bot token back in its response', async () => {
    const n = network();
    const { ctx } = context();
    const res = await handleRequest(post('/telegram/register', '', { 'x-register-key': SECRET }), env(), ctx, n.impl);
    const body = await res.text();
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain('BOT-TOKEN');
  });
});
