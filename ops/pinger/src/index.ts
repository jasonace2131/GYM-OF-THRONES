import { handleUpdate, normalizeChatId, safeEqual } from './commands';
import { checkHealth, checkWithRetry, decide, diagnose, type PingerState } from './monitor';

/*
 * The handful of Worker runtime types this file touches, declared here so the
 * pinger needs no @cloudflare/workers-types install. Wrangler bundles with
 * esbuild and never type-checks, so these exist for `tsc` and the tests.
 */
interface KvLike {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
}
interface ScheduledEventLike {
  scheduledTime: number;
}
interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  /** The member path: the site's own origin, proxied by Vercel to Render. */
  HEALTH_URL: string;
  /** Render directly — probed only on failure, to say which leg broke. */
  DIRECT_URL: string;
  /** Public, so /check@SomeOtherBot in a shared group is left alone. */
  BOT_USERNAME?: string;
  /** Secrets, set with `wrangler secret put`. Never in wrangler.toml. */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  /** Telegram sends it on every webhook call; anything without it is refused. */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Render's deploy hook for got-api. The URL is the credential. */
  RENDER_DEPLOY_HOOK?: string;
  PINGER_STATE: KvLike;
}

const STATE_KEY = 'state';

/**
 * 45s per attempt: Render's free tier takes ~50s to wake, so the first
 * attempt after a quiet night can time out while the retry lands on a warm
 * instance. Two misses is an outage.
 */
const CHECK = { timeoutMs: 45_000, retryDelayMs: 5_000 };

export default {
  async scheduled(event: ScheduledEventLike, env: Env, ctx: ExecutionContextLike): Promise<void> {
    ctx.waitUntil(run(env, new Date(event.scheduledTime)));
  },
  fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
};

/**
 * The Worker's only two HTTP routes. It has a public workers.dev URL because
 * Telegram must be able to reach it; both routes are closed to anyone who
 * does not hold TELEGRAM_WEBHOOK_SECRET.
 */
export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContextLike,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const { pathname, origin } = new URL(request.url);
  if (request.method !== 'POST') return new Response('not found', { status: 404 });

  if (pathname === '/telegram') {
    if (!authorised(request.headers.get('x-telegram-bot-api-secret-token'), env)) {
      return new Response('forbidden', { status: 403 });
    }
    const update = await request.json().catch(() => null);
    /*
     * Answer Telegram now and reply afterwards. Telegram retries a webhook
     * that is slow to answer, and a check can take several seconds — waiting
     * would post the same reply twice.
     */
    ctx.waitUntil(
      handleUpdate(update, env, fetchImpl).then((reply) =>
        reply === null ? undefined : sendTelegram(env, reply.text, fetchImpl, reply.replyTo),
      ),
    );
    return new Response('ok');
  }

  if (pathname === '/telegram/register') {
    if (!authorised(request.headers.get('x-register-key'), env)) {
      return new Response('forbidden', { status: 403 });
    }
    return Response.json(await register(env, `${origin}/telegram`, fetchImpl));
  }

  return new Response('not found', { status: 404 });
}

/** An unset secret means closed, never "no check configured". */
function authorised(presented: string | null, env: Env): boolean {
  return env.TELEGRAM_WEBHOOK_SECRET !== undefined && safeEqual(presented ?? '', env.TELEGRAM_WEBHOOK_SECRET);
}

/**
 * Points Telegram at this Worker and publishes the command menu. The Worker
 * does it with the token it already holds, so setting up /check never needs
 * the token to be typed into a browser again.
 */
async function register(env: Env, webhookUrl: string, fetchImpl: typeof fetch) {
  const webhook = await telegramApi(env, 'setWebhook', {
    url: webhookUrl,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  }, fetchImpl);
  const commands = await telegramApi(env, 'setMyCommands', {
    commands: [
      { command: 'check', description: 'Is the site online right now?' },
      { command: 'redeploy', description: 'Restart the API on Render when it is stuck' },
      { command: 'help', description: 'What this bot does' },
    ],
  }, fetchImpl);
  // Telegram's own ok/description only. Never the secret or the token.
  return { webhook, commands };
}

async function telegramApi(
  env: Env,
  method: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; description?: string }> {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, description: 'TELEGRAM_BOT_TOKEN is not set' };
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    return { ok: parsed.ok === true, description: parsed.description };
  } catch (error) {
    return { ok: false, description: `could not reach Telegram (${(error as Error).name})` };
  }
}

export async function run(
  env: Env,
  now: Date,
  fetchImpl: typeof fetch = fetch,
  check = CHECK,
): Promise<void> {
  const health = await checkWithRetry(env.HEALTH_URL, check, fetchImpl);
  // Only a failure earns the second probe; a healthy tick is one request.
  const diagnosis = health.ok ? '' : diagnose(await checkHealth(env.DIRECT_URL, 20_000, fetchImpl));

  const previous = (await env.PINGER_STATE.get(STATE_KEY, 'json')) as PingerState | null;
  const decision = decide(previous, health, now, diagnosis);

  if (decision.message !== null) {
    const delivered = await sendTelegram(env, decision.message, fetchImpl);
    /*
     * An alert that did not go out must not be recorded as sent. Saving here
     * would leave the pinger believing it had told the owner, and it would
     * stay silent for the rest of the outage. Leaving the old state means the
     * next tick sees the same transition and tries again.
     */
    if (!delivered) return;
  }

  if (decision.persist) {
    await env.PINGER_STATE.put(STATE_KEY, JSON.stringify(decision.next));
  }
}

async function sendTelegram(
  env: Env,
  text: string,
  fetchImpl: typeof fetch,
  replyTo?: number,
): Promise<boolean> {
  // Cleaned the same way the webhook's comparison is, so the id a message is
  // sent to and the id a /check is accepted from can never disagree.
  const chatId = normalizeChatId(env.TELEGRAM_CHAT_ID).id;
  if (!env.TELEGRAM_BOT_TOKEN || chatId === undefined) {
    console.error('pinger: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set; alert not sent');
    return false;
  }
  try {
    // The token is part of this URL. It is never logged — only the status.
    const response = await fetchImpl(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
          ...(replyTo === undefined ? {} : { reply_to_message_id: replyTo }),
        }),
      },
    );
    if (!response.ok) {
      console.error(`pinger: Telegram answered HTTP ${response.status}; alert not sent`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`pinger: could not reach Telegram (${(error as Error).name}); alert not sent`);
    return false;
  }
}
