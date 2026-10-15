/**
 * The pinger's decisions, kept free of the Worker runtime so they can be
 * tested with a fake clock and a fake fetch.
 *
 * Two jobs, one request:
 *   1. Keep Render's free instance awake during gym hours. It sleeps after
 *      fifteen idle minutes and takes ~50s to wake, which a member at the
 *      counter experiences as a broken app.
 *   2. Tell the owner, in Telegram, when the member path stops answering —
 *      once when it breaks, every thirty minutes while it stays broken, and
 *      once when it recovers. Never on every check.
 */

export type Health = { ok: true } | { ok: false; detail: string };

export interface PingerState {
  status: 'up' | 'down';
  /** When the current status began (ISO). The outage start never moves. */
  since: string;
  /** When the last DOWN alert or reminder went out (ISO). Null while up. */
  lastAlertAt: string | null;
}

export interface Decision {
  next: PingerState;
  message: string | null;
  /** Whether `next` must be written. KV is written on change only. */
  persist: boolean;
}

/** A reminder while an outage lasts. Often enough to act on, rare enough not to mute. */
export const REMINDER_MS = 30 * 60_000;

export function decide(
  prev: PingerState | null,
  health: Health,
  now: Date,
  diagnosis = '',
): Decision {
  const iso = now.toISOString();

  if (health.ok) {
    if (prev?.status === 'down') {
      const started = new Date(prev.since);
      return {
        next: { status: 'up', since: iso, lastAlertAt: null },
        message: [
          '🟢 Gym of Thrones is back',
          `Down for ${formatDuration(now.getTime() - started.getTime())} ` +
            `(${formatManila(started)} – ${formatManila(now)} Manila).`,
        ].join('\n'),
        persist: true,
      };
    }
    // Up and was up: nothing to say. First run ever: record a baseline quietly.
    return prev === null
      ? { next: { status: 'up', since: iso, lastAlertAt: null }, message: null, persist: true }
      : { next: prev, message: null, persist: false };
  }

  if (prev?.status === 'down') {
    const lastAlert = new Date(prev.lastAlertAt ?? prev.since).getTime();
    if (now.getTime() - lastAlert < REMINDER_MS) {
      return { next: prev, message: null, persist: false };
    }
    const started = new Date(prev.since);
    return {
      next: { ...prev, lastAlertAt: iso },
      message: [
        `🔴 Still down — ${formatDuration(now.getTime() - started.getTime())} now ` +
          `(since ${formatManila(started)} Manila).`,
        `Last check: ${health.detail}.`,
        diagnosis,
      ]
        .filter(Boolean)
        .join('\n'),
      persist: true,
    };
  }

  return {
    next: { status: 'down', since: iso, lastAlertAt: iso },
    message: [
      '🔴 Gym of Thrones is DOWN',
      "Members can't sign in or load their dashboard.",
      `Check: ${health.detail}, at ${formatManila(now)} Manila.`,
      diagnosis,
    ]
      .filter(Boolean)
      .join('\n'),
    persist: true,
  };
}

/**
 * Which leg failed. The member path is browser → Vercel → Render, so when it
 * breaks, asking Render directly separates "the proxy" from "the API".
 */
export function diagnose(direct: Health): string {
  return direct.ok
    ? 'Render answers directly, so the Vercel proxy leg is failing — check the Vercel deployment.'
    : `Render isn't answering directly either (${direct.detail}). ` +
        'Check the Render dashboard: Events, Logs, and free instance hours used this month.';
}

export async function checkHealth(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Health> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: abort.signal,
      headers: { 'user-agent': 'got-uptime-pinger' },
    });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    // A 200 is not enough: a proxy or an error page can answer 200 too. Only
    // the API's own envelope counts as the API being up.
    const body = (await response.json().catch(() => null)) as {
      success?: unknown;
      data?: { status?: unknown };
    } | null;
    return body?.success === true && body.data?.status === 'ok'
      ? { ok: true }
      : { ok: false, detail: 'answered, but not with a healthy response' };
  } catch (error) {
    if (abort.signal.aborted) return { ok: false, detail: `no answer after ${timeoutMs / 1000}s` };
    return { ok: false, detail: `could not connect (${(error as Error).message})` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One retry, because the first check after a quiet night can land on a
 * sleeping instance and time out while it wakes. Two misses in a row is an
 * outage; one is usually a cold start.
 */
export async function checkWithRetry(
  url: string,
  { timeoutMs, retryDelayMs }: { timeoutMs: number; retryDelayMs: number },
  fetchImpl: typeof fetch = fetch,
): Promise<Health> {
  const first = await checkHealth(url, timeoutMs, fetchImpl);
  if (first.ok) return first;
  if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  const second = await checkHealth(url, timeoutMs, fetchImpl);
  return second.ok ? second : { ok: false, detail: `${second.detail} (twice)` };
}

/** "2:14 PM" in the gym's clock, whatever region the Worker runs in. */
export function formatManila(date: Date): string {
  return date
    .toLocaleTimeString('en-US', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' })
    .replace(/\s/g, ' '); // newer ICU puts a narrow no-break space before AM/PM
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
