/**
 * Knowing how much of each model's free quota is left, so the assistant can
 * change model BEFORE one runs out rather than after it has refused.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY (2026-09-25). The owner asked for the assistant to "change the agent
 * whenever it is near the quota". It already rotated — but only reactively:
 * every question tried the first model, waited for its 429, then moved on.
 * Once the main model was spent for the day, EVERY question paid that wasted
 * round trip first, and nothing ever switched ahead of the limit.
 *
 * This keeps three things per model, in memory:
 *   - requests sent in the last minute and today (the two limits Google
 *     meters the free tier by);
 *   - a cool-down after a 429 — until the Pacific-midnight reset for a daily
 *     limit, or for the delay Google names for a per-minute one;
 *   - the limit Google actually enforced, when its 429 says so, so a stale
 *     table corrects itself.
 *
 * WHAT IT DOES NOT DO: add capacity. Across the whole list the free tier is
 * ~540 requests a day. Rotation spends that well; only billing raises it.
 *
 * PER INSTANCE. Counts live in this process. A Render restart forgets them,
 * and the first 429 afterwards re-teaches the cool-down — one wasted request,
 * not an outage. Keeping them in the database would survive restarts, at the
 * cost of a write per request; not worth it on one free instance.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface ModelLimits {
  /** Requests per minute, or null when unknown. */
  rpm: number | null;
  /** Requests per day (Pacific calendar day), or null when unknown. */
  rpd: number | null;
}

/**
 * The free-tier limits, as measured against the project's Gemini dashboard
 * (see the table in ./gemini-models). A model missing from here — e.g. one
 * pinned with GEMINI_MODEL — is never treated as "near"; only a real 429 can
 * cool it down, and that 429 teaches the limit.
 */
export const FREE_TIER_LIMITS: Readonly<Record<string, ModelLimits>> = {
  'gemini-3.1-flash-lite': { rpm: 15, rpd: 500 },
  'gemini-2.5-flash-lite': { rpm: 10, rpd: 20 },
  'gemini-2.5-flash': { rpm: 5, rpd: 20 },
};

/**
 * What one question can cost: the ask, plus one tool round (e.g. reading the
 * gym's hours before placing sessions in a plan). A model with fewer requests
 * left than this may start a question and fail it half-way, so it counts as
 * "near" and goes to the back of the line.
 */
export const REQUESTS_PER_QUESTION = 2;

const MINUTE_MS = 60_000;
/** A 429 that names no delay waits one full per-minute window. */
const DEFAULT_COOLDOWN_MS = MINUTE_MS;

export type RateLimitKind = 'per-day' | 'per-minute' | 'unknown';

export interface RateLimitInfo {
  kind: RateLimitKind;
  retryAfterMs: number | null;
  /** The limit Google says it enforced (`quotaValue`), when it says. */
  limit: number | null;
}

export interface QuotaPlan {
  /** Fresh models first, then near ones — each group in the configured order. */
  usable: string[];
  /** Models cooling down after a 429, and until when. */
  skipped: { model: string; until: string; reason: RateLimitKind }[];
}

// ── The quota day ──────────────────────────────────────────────────────────

/** Google resets free-tier daily quota at midnight Pacific time. */
const PACIFIC = 'America/Los_Angeles';

const pacificFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function pacificParts(
  date: Date,
): Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string> {
  const parts = Object.fromEntries(
    pacificFormat.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return parts as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string>;
}

/** The Pacific calendar day a request is counted against, as YYYY-MM-DD. */
export function quotaDay(now: Date): string {
  const p = pacificParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

/** The next midnight in Los Angeles — 3 PM Manila in summer, 4 PM in winter. */
export function nextQuotaReset(now: Date): Date {
  const p = pacificParts(now);
  const intoDay =
    ((Number(p.hour) * 60 + Number(p.minute)) * 60 + Number(p.second)) * 1000 +
    now.getUTCMilliseconds();
  let guess = now.getTime() - intoDay + 24 * 60 * MINUTE_MS;
  // Daylight-saving days are 23 or 25 hours long, so the guess can land an
  // hour off; nudge it onto the hour that really reads 00 in Pacific.
  for (let i = 0; i < 3; i += 1) {
    const hour = Number(pacificParts(new Date(guess)).hour);
    if (hour === 0) break;
    guess += hour >= 12 ? 60 * MINUTE_MS : -60 * MINUTE_MS;
  }
  return new Date(guess);
}

// ── Reading a 429 ──────────────────────────────────────────────────────────

/**
 * A Gemini 429 carries google.rpc error details: a QuotaFailure naming WHICH
 * quota was hit (`GenerateRequestsPerDay…` vs `…PerMinute…`) and often a
 * RetryInfo with the delay. Anything missing reads as unknown, never a throw.
 */
/** A detail field as text — Google sends strings, but nothing here trusts that. */
function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

export function rateLimitInfo(error: unknown): RateLimitInfo {
  const details = (error as { errorDetails?: unknown } | null)?.errorDetails;
  if (!Array.isArray(details)) return { kind: 'unknown', retryAfterMs: null, limit: null };

  let kind: RateLimitKind = 'unknown';
  let limit: number | null = null;
  let retryAfterMs: number | null = null;

  for (const detail of details as Record<string, unknown>[]) {
    const type = text(detail['@type']);
    if (type.endsWith('QuotaFailure') && Array.isArray(detail['violations'])) {
      for (const violation of detail['violations'] as Record<string, unknown>[]) {
        const quotaId = text(violation['quotaId']);
        if (/PerDay/i.test(quotaId)) kind = 'per-day';
        else if (/PerMinute/i.test(quotaId) && kind !== 'per-day') kind = 'per-minute';
        const value = Number.parseInt(text(violation['quotaValue']), 10);
        if (Number.isFinite(value) && value > 0) limit = value;
      }
    }
    if (type.endsWith('RetryInfo')) {
      const seconds = Number.parseFloat(text(detail['retryDelay']));
      if (Number.isFinite(seconds) && seconds >= 0) retryAfterMs = Math.round(seconds * 1000);
    }
  }
  return { kind, retryAfterMs, limit };
}

// ── The ledger ─────────────────────────────────────────────────────────────

export class ModelQuota {
  private readonly limits = new Map<string, ModelLimits>();
  private readonly minute = new Map<string, number[]>();
  private readonly day = new Map<string, { day: string; count: number }>();
  private readonly cooling = new Map<string, { until: number; reason: RateLimitKind }>();

  constructor(limits: Readonly<Record<string, ModelLimits>> = FREE_TIER_LIMITS) {
    for (const [model, value] of Object.entries(limits)) this.limits.set(model, { ...value });
  }

  /** One request sent to `model` — the ask or a tool round alike. */
  record(model: string, now: Date): void {
    const stamps = this.recentStamps(model, now);
    stamps.push(now.getTime());
    this.minute.set(model, stamps);

    const today = quotaDay(now);
    const entry = this.day.get(model);
    this.day.set(model, { day: today, count: entry?.day === today ? entry.count + 1 : 1 });
  }

  /** Requests left this minute and today; null where the limit is unknown. */
  remaining(model: string, now: Date): { minute: number | null; day: number | null } {
    const limits = this.limits.get(model);
    const usedToday = this.day.get(model);
    const today = quotaDay(now);
    return {
      minute:
        limits?.rpm == null ? null : Math.max(0, limits.rpm - this.recentStamps(model, now).length),
      day:
        limits?.rpd == null
          ? null
          : Math.max(0, limits.rpd - (usedToday?.day === today ? usedToday.count : 0)),
    };
  }

  /** Too little left to be sure of finishing one question. */
  isNear(model: string, now: Date): boolean {
    const { minute, day } = this.remaining(model, now);
    return (
      (minute !== null && minute < REQUESTS_PER_QUESTION) ||
      (day !== null && day < REQUESTS_PER_QUESTION)
    );
  }

  /** The order to try models in: fresh first, near last, cooling left out. */
  order(models: readonly string[], now: Date): QuotaPlan {
    const fresh: string[] = [];
    const near: string[] = [];
    const skipped: QuotaPlan['skipped'] = [];
    for (const model of models) {
      const cool = this.activeCooldown(model, now);
      if (cool !== null) {
        skipped.push({ model, until: new Date(cool.until).toISOString(), reason: cool.reason });
      } else if (this.isNear(model, now)) {
        near.push(model);
      } else {
        fresh.push(model);
      }
    }
    return { usable: [...fresh, ...near], skipped };
  }

  /** A 429 from `model`: rest it, and learn the limit if Google named one. */
  onRateLimited(model: string, error: unknown, now: Date): void {
    const info = rateLimitInfo(error);
    const until =
      info.kind === 'per-day'
        ? nextQuotaReset(now).getTime()
        : now.getTime() + (info.retryAfterMs ?? DEFAULT_COOLDOWN_MS);

    const existing = this.cooling.get(model);
    if (existing === undefined || existing.until < until) {
      this.cooling.set(model, { until, reason: info.kind });
    }

    if (info.limit !== null && info.kind !== 'unknown') {
      const limits = this.limits.get(model) ?? { rpm: null, rpd: null };
      if (info.kind === 'per-day') limits.rpd = info.limit;
      else limits.rpm = info.limit;
      this.limits.set(model, limits);
    }
  }

  /** When the first of these cooling models comes back; null if none is cooling. */
  nextAvailableAt(models: readonly string[], now: Date): Date | null {
    let earliest: number | null = null;
    for (const model of models) {
      const cool = this.activeCooldown(model, now);
      if (cool !== null && (earliest === null || cool.until < earliest)) earliest = cool.until;
    }
    return earliest === null ? null : new Date(earliest);
  }

  /** "gemini-3.1-flash-lite 12/500 today", for the log line. */
  describe(model: string, now: Date): string {
    const rpd = this.limits.get(model)?.rpd;
    if (rpd == null) return `${model} (no limit table)`;
    const left = this.remaining(model, now).day ?? rpd;
    return `${model} ${rpd - left}/${rpd} today`;
  }

  private recentStamps(model: string, now: Date): number[] {
    const since = now.getTime() - MINUTE_MS;
    return (this.minute.get(model) ?? []).filter((stamp) => stamp > since);
  }

  private activeCooldown(
    model: string,
    now: Date,
  ): { until: number; reason: RateLimitKind } | null {
    const cool = this.cooling.get(model);
    if (cool === undefined) return null;
    if (now.getTime() >= cool.until) {
      this.cooling.delete(model);
      return null;
    }
    return cool;
  }
}
