import { checkHealth, diagnose, formatManila, type PingerState } from './monitor';

/**
 * The bot's commands, typed in the staff group.
 *
 * /check is READ-ONLY. It probes the member path right now and replies; it
 * never touches the state the scheduled alerts keep. Two writers to one
 * record would race, and a /check that happened to land mid-outage could
 * swallow the recovery message the schedule was about to send.
 */

export interface CommandEnv {
  HEALTH_URL: string;
  DIRECT_URL: string;
  TELEGRAM_CHAT_ID?: string;
  /** The bot's public username, so /check@OtherBot is left for OtherBot. */
  BOT_USERNAME?: string;
  /**
   * Render → got-api → Settings → Deploy Hook. A secret: the URL itself is
   * the credential, and anyone holding it can redeploy production.
   */
  RENDER_DEPLOY_HOOK?: string;
  PINGER_STATE: { get(key: string, type: 'json'): Promise<unknown>; put(key: string, value: string): Promise<void> };
}

/**
 * One redeploy per 15 minutes. Not an access rule — every member of the
 * group may redeploy, by the owner's decision — but two people tapping it a
 * minute apart would queue two full builds (migrations and seed included)
 * and spend Render build minutes twice for one outage.
 *
 * Best-effort: KV is not transactional, so two taps in the same second can
 * both get through. Render queues the second deploy; nothing breaks.
 */
export const REDEPLOY_COOLDOWN_MS = 15 * 60_000;
const REDEPLOY_KEY = 'redeploy';
const DEPLOY_HOOK_TIMEOUT_MS = 10_000;

export interface Reply {
  text: string;
  /** The /check message this answers, so the reply threads under it. */
  replyTo: number;
}

/**
 * A reply must go out inside the free plan's budget for work after the
 * webhook has been answered (about 30 seconds). 18s + 7s leaves room for the
 * Telegram call. That is shorter than a cold start, which is why a timeout
 * says "try again" rather than "down".
 */
export const COMMAND_TIMEOUTS = { memberTimeoutMs: 18_000, directTimeoutMs: 7_000 };

const HELP = [
  'Gym of Thrones uptime bot.',
  '',
  '/check — is the site answering right now?',
  '/redeploy — restart the API on Render when it is stuck (takes 5–8 minutes)',
  '',
  'I also check on my own: every 10 minutes from 6 AM to 11 PM, hourly overnight.',
  'I post here when the site goes down, every 30 minutes while it stays down, and when it is back.',
].join('\n');

export function parseCommand(
  text: string | undefined,
  botUsername?: string,
): 'check' | 'help' | 'redeploy' | null {
  const match = /^\/([a-z]+)(?:@(\w+))?(?:\s|$)/i.exec(text ?? '');
  if (match === null) return null;
  const [, command, addressedTo] = match;
  if (addressedTo !== undefined && botUsername !== undefined && addressedTo.toLowerCase() !== botUsername.toLowerCase()) {
    return null; // /check@SomeOtherBot is not ours to answer
  }
  switch (command.toLowerCase()) {
    case 'check':
      return 'check';
    case 'redeploy':
    case 'restart': // what people will actually type when it is stuck
      return 'redeploy';
    case 'help':
    case 'start':
      return 'help';
    default:
      return null;
  }
}

/**
 * A Telegram chat id is only ever an integer with an optional leading minus.
 * Cleans the configured value to exactly that, and reports what it removed.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 2026-09-23: /check was silently ignored. The group's id was 11 characters
 * and the configured TELEGRAM_CHAT_ID was 12 — yet the scheduled alerts to it
 * had been delivered. Telegram reads past a stray trailing character when it
 * SENDS; an exact comparison on RECEIVE does not. Copying an id out of the
 * getUpdates JSON picks up the comma after it, and copying from rendered text
 * can bring invisible direction marks that trim() leaves in place.
 * ─────────────────────────────────────────────────────────────────────────
 */
export function normalizeChatId(raw: string | undefined): { id: string | undefined; stripped: string[] } {
  if (raw === undefined) return { id: undefined, stripped: [] };
  const stripped: string[] = [];
  let id = '';
  for (const ch of raw) {
    if (/[0-9-]/.test(ch)) {
      id += ch;
    } else if (/[−‒–—﹣－]/.test(ch)) {
      id += '-'; // a typographic minus pasted from rendered text
      stripped.push(`${codepoint(ch)} as '-'`);
    } else {
      stripped.push(ch >= '!' && ch <= '~' ? `'${ch}'` : codepoint(ch));
    }
  }
  return { id: id === '' ? undefined : id, stripped };
}

function codepoint(ch: string): string {
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Constant-time comparison for the webhook secret, so a caller cannot learn
 * it a character at a time from how long a rejection takes.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface TelegramUpdate {
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id?: number | string; type?: string };
    from?: { first_name?: string; username?: string };
  };
}

export async function handleUpdate(
  update: unknown,
  env: CommandEnv,
  fetchImpl: typeof fetch = fetch,
  clock: () => number = Date.now,
  timeouts = COMMAND_TIMEOUTS,
): Promise<Reply | null> {
  const message = (update as TelegramUpdate | null)?.message;
  if (message?.chat?.id === undefined || message.message_id === undefined) {
    console.log('pinger: ignored an update with no message in it');
    return null;
  }

  // The bot is public — anyone can find it by name. It answers in the staff
  // group and nowhere else, and says nothing elsewhere: even "not allowed"
  // would confirm there is something here worth poking at.
  //
  // It does say so in the LOG. A /check that silently vanished is exactly how
  // this was first debugged, and the reply-less group gave nothing to go on.
  // Chat ids are not secrets; the message text is never logged.
  const incoming = String(message.chat.id);
  const { id: configured, stripped } = normalizeChatId(env.TELEGRAM_CHAT_ID);
  if (stripped.length > 0) {
    console.log(
      `pinger: TELEGRAM_CHAT_ID contained ${stripped.join(', ')}, which is not part of a chat id; ignored. ` +
        'Re-enter it with `wrangler secret put TELEGRAM_CHAT_ID` to tidy it.',
    );
  }
  if (configured === undefined || incoming !== configured) {
    console.log(
      `pinger: ignored a message from chat ${incoming} (${message.chat.type ?? 'unknown type'}); ` +
        (configured === undefined ? 'TELEGRAM_CHAT_ID is not set' : `the configured group is ${configured}`),
    );
    return null;
  }

  const command = parseCommand(message.text, env.BOT_USERNAME);
  if (command === null) {
    const token = message.text?.startsWith('/') ? message.text.split(/\s/, 1)[0].slice(0, 64) : null;
    console.log(`pinger: ignored ${token === null ? 'a non-command message' : `an unhandled command ${token}`}`);
    return null;
  }
  if (command === 'help') return { text: HELP, replyTo: message.message_id };
  if (command === 'redeploy') {
    const who = message.from?.first_name ?? message.from?.username ?? 'someone';
    return { text: await redeploy(env, who, fetchImpl, clock), replyTo: message.message_id };
  }

  return { text: await check(env, fetchImpl, clock, timeouts), replyTo: message.message_id };
}

/**
 * Triggers a fresh Render deploy through the service's deploy hook — what
 * brought the API back on 2026-09-23, when it had built fine but was not
 * serving. A ping can wake a sleeping instance; only a deploy replaces a
 * stuck one.
 *
 * Replies never include the hook URL: it is the credential, and every member
 * of the group reads the reply.
 */
async function redeploy(env: CommandEnv, who: string, fetchImpl: typeof fetch, clock: () => number): Promise<string> {
  if (!env.RENDER_DEPLOY_HOOK) {
    return [
      "⚙️ /redeploy isn't set up yet.",
      'Copy the hook from Render → got-api → Settings → Deploy Hook, then run:',
      'npx wrangler@4 secret put RENDER_DEPLOY_HOOK',
    ].join('\n');
  }

  const now = clock();
  const last = (await env.PINGER_STATE.get(REDEPLOY_KEY, 'json').catch(() => null)) as
    | { at: string; by: string }
    | null;
  if (last !== null && now - Date.parse(last.at) < REDEPLOY_COOLDOWN_MS) {
    const minutes = Math.round((now - Date.parse(last.at)) / 60_000);
    const ago = minutes < 1 ? 'less than a minute ago' : `${minutes} min ago`;
    return [
      `⏳ A redeploy was already started ${ago} by ${last.by}.`,
      'It takes about 5–8 minutes. Use /check to see whether the site is back.',
    ].join('\n');
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), DEPLOY_HOOK_TIMEOUT_MS);
  let failure: string | null = null;
  try {
    const response = await fetchImpl(env.RENDER_DEPLOY_HOOK, { method: 'POST', signal: abort.signal });
    if (!response.ok) failure = `Render refused it (HTTP ${response.status})`;
  } catch {
    failure = abort.signal.aborted
      ? `Render did not answer within ${DEPLOY_HOOK_TIMEOUT_MS / 1000}s`
      : 'could not reach Render';
  } finally {
    clearTimeout(timer);
  }

  if (failure !== null) {
    // The cooldown only starts on a deploy that actually started.
    console.error(`pinger: redeploy failed: ${failure}`); // status only, never the URL
    return [
      `❌ Redeploy did not start: ${failure}.`,
      'If the deploy hook was regenerated in Render, update it with:',
      'npx wrangler@4 secret put RENDER_DEPLOY_HOOK',
    ].join('\n');
  }

  await env.PINGER_STATE.put(REDEPLOY_KEY, JSON.stringify({ at: new Date(now).toISOString(), by: who }));
  return [
    `🔄 Redeploy started by ${who}.`,
    'Render is rebuilding the API. It takes about 5–8 minutes, and the site may not answer until it finishes.',
    'Use /check in a few minutes. If I had flagged the site as down, I will post 🟢 by myself when it is back.',
  ].join('\n');
}

async function check(
  env: CommandEnv,
  fetchImpl: typeof fetch,
  clock: () => number,
  timeouts: typeof COMMAND_TIMEOUTS,
): Promise<string> {
  const started = clock();
  const health = await checkHealth(env.HEALTH_URL, timeouts.memberTimeoutMs, fetchImpl);
  const seconds = ((clock() - started) / 1000).toFixed(1);

  if (health.ok) {
    const lines = [`🟢 Online — the site answered in ${seconds}s.`];
    const state = (await env.PINGER_STATE.get('state', 'json').catch(() => null)) as PingerState | null;
    if (state?.status === 'down') {
      lines.push(
        `The scheduled check still has it down since ${formatManila(new Date(state.since))} Manila; ` +
          'it will post the recovery on its next run.',
      );
    }
    return lines.join('\n');
  }

  const direct = await checkHealth(env.DIRECT_URL, timeouts.directTimeoutMs, fetchImpl);
  const lines = [`🔴 Not answering: ${health.detail}.`, diagnose(direct)];
  if (health.detail.startsWith('no answer')) {
    lines.push(
      'If this is overnight, the API may just be waking from sleep (it takes about 50 seconds) — ' +
        'this check has already started it. Try /check again in a minute.',
    );
  }
  return lines.join('\n');
}
