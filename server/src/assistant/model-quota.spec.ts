import { GoogleGenerativeAIFetchError } from '@google/generative-ai';
import {
  ModelQuota,
  REQUESTS_PER_QUESTION,
  nextQuotaReset,
  quotaDay,
  rateLimitInfo,
} from './model-quota';

const MAIN = 'gemini-3.1-flash-lite'; // 15/min, 500/day
const SMALL = 'gemini-2.5-flash'; // 5/min, 20/day

// 2026-09-24 10:00 Manila = 02:00 UTC = 2026-09-23 19:00 in Los Angeles (PDT).
const T0 = new Date('2026-09-24T02:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

/** The shape Gemini actually returns on a 429, per google.rpc error details. */
function quotaError(
  quotaId: string,
  retryDelay?: string,
  quotaValue?: string,
): GoogleGenerativeAIFetchError {
  const details: Record<string, unknown>[] = [
    {
      '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
      violations: [
        {
          quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
          quotaId,
          ...(quotaValue === undefined ? {} : { quotaValue }),
        },
      ],
    },
  ];
  if (retryDelay !== undefined) {
    details.push({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay });
  }
  return new GoogleGenerativeAIFetchError(
    '[429 Too Many Requests] quota',
    429,
    'Too Many Requests',
    details,
  );
}

const PER_DAY = 'GenerateRequestsPerDayPerProjectPerModel-FreeTier';
const PER_MINUTE = 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier';

describe('quota day — Google resets free quota at midnight Pacific', () => {
  it('names the Pacific calendar day, not the UTC or Manila one', () => {
    expect(quotaDay(T0)).toBe('2026-09-23');
  });

  it('resets at 07:00 UTC while California is on daylight time (3 PM Manila)', () => {
    expect(nextQuotaReset(T0).toISOString()).toBe('2026-09-24T07:00:00.000Z');
  });

  it('resets at 08:00 UTC once daylight time has ended (4 PM Manila)', () => {
    expect(nextQuotaReset(new Date('2026-11-20T02:00:00.000Z')).toISOString()).toBe(
      '2026-11-20T08:00:00.000Z',
    );
  });

  it('lands on midnight across the day daylight time ends', () => {
    // 2026-11-01 is 25 hours long in Los Angeles.
    expect(nextQuotaReset(new Date('2026-11-01T12:00:00.000Z')).toISOString()).toBe(
      '2026-11-02T08:00:00.000Z',
    );
  });
});

describe('rateLimitInfo — what a 429 says about itself', () => {
  it('recognises a daily limit and the limit Google enforced', () => {
    expect(rateLimitInfo(quotaError(PER_DAY, '37s', '20'))).toEqual({
      kind: 'per-day',
      retryAfterMs: 37_000,
      limit: 20,
    });
  });

  it('recognises a per-minute limit', () => {
    expect(rateLimitInfo(quotaError(PER_MINUTE, '12.5s')).kind).toBe('per-minute');
    expect(rateLimitInfo(quotaError(PER_MINUTE, '12.5s')).retryAfterMs).toBe(12_500);
  });

  it('copes with a 429 that carries no details at all', () => {
    const bare = new GoogleGenerativeAIFetchError(
      '[429 Too Many Requests]',
      429,
      'Too Many Requests',
    );
    expect(rateLimitInfo(bare)).toEqual({ kind: 'unknown', retryAfterMs: null, limit: null });
    expect(rateLimitInfo(new Error('nope'))).toEqual({
      kind: 'unknown',
      retryAfterMs: null,
      limit: null,
    });
  });
});

describe('ModelQuota — counting what has been spent', () => {
  it('counts each request against the minute and the day', () => {
    const quota = new ModelQuota();
    quota.record(MAIN, T0);
    quota.record(MAIN, T0);
    expect(quota.remaining(MAIN, T0)).toEqual({ minute: 13, day: 498 });
  });

  it('frees the minute window after sixty seconds, but not the day', () => {
    const quota = new ModelQuota();
    for (let i = 0; i < 5; i += 1) quota.record(SMALL, T0);
    expect(quota.remaining(SMALL, T0)).toEqual({ minute: 0, day: 15 });
    expect(quota.remaining(SMALL, at(60_001))).toEqual({ minute: 5, day: 15 });
  });

  it('starts a fresh day at midnight Pacific', () => {
    const quota = new ModelQuota();
    for (let i = 0; i < 20; i += 1) quota.record(SMALL, at(i * 61_000));
    expect(quota.remaining(SMALL, at(21 * 61_000)).day).toBe(0);
    expect(quota.remaining(SMALL, new Date('2026-09-24T07:00:01.000Z')).day).toBe(20);
  });

  it('knows nothing about a model it has no table for, so never guesses it is near', () => {
    const quota = new ModelQuota();
    quota.record('gemini-9-experimental', T0);
    expect(quota.remaining('gemini-9-experimental', T0)).toEqual({ minute: null, day: null });
  });
});

describe('ModelQuota — switching before the limit', () => {
  /**
   * The owner's rule: change model when one is NEAR its quota, not after it
   * has failed. A question can cost two requests (the ask and a tool round),
   * so a model with fewer than that left cannot be relied on to finish one.
   */
  it(`treats a model with fewer than ${REQUESTS_PER_QUESTION} requests left as near`, () => {
    const quota = new ModelQuota();
    for (let i = 0; i < 19; i += 1) quota.record(SMALL, at(i * 61_000));
    const now = at(20 * 61_000);
    expect(quota.remaining(SMALL, now).day).toBe(1);
    expect(quota.isNear(SMALL, now)).toBe(true);
  });

  it('puts near models behind fresh ones rather than dropping them', () => {
    const quota = new ModelQuota();
    for (let i = 0; i < 14; i += 1) quota.record(MAIN, T0); // 1 left this minute
    const plan = quota.order([MAIN, 'gemini-2.5-flash-lite', SMALL], T0);
    expect(plan.usable).toEqual(['gemini-2.5-flash-lite', SMALL, MAIN]);
    expect(plan.skipped).toEqual([]);
  });

  it('keeps the configured order among fresh models', () => {
    const plan = new ModelQuota().order([MAIN, 'gemini-2.5-flash-lite', SMALL], T0);
    expect(plan.usable).toEqual([MAIN, 'gemini-2.5-flash-lite', SMALL]);
  });
});

describe('ModelQuota — remembering a refusal', () => {
  it('skips a model that hit its DAILY limit until the Pacific reset', () => {
    const quota = new ModelQuota();
    quota.onRateLimited(SMALL, quotaError(PER_DAY, '37s', '20'), T0);

    const later = at(2 * 60 * 60_000);
    const plan = quota.order([MAIN, SMALL], later);
    expect(plan.usable).toEqual([MAIN]);
    expect(plan.skipped).toEqual([
      { model: SMALL, until: '2026-09-24T07:00:00.000Z', reason: 'per-day' },
    ]);
    expect(quota.order([MAIN, SMALL], new Date('2026-09-24T07:00:01.000Z')).usable).toEqual([
      MAIN,
      SMALL,
    ]);
  });

  it('skips a model that hit its PER-MINUTE limit only for the delay Google gave', () => {
    const quota = new ModelQuota();
    quota.onRateLimited(MAIN, quotaError(PER_MINUTE, '20s'), T0);
    expect(quota.order([MAIN], at(19_000)).usable).toEqual([]);
    expect(quota.order([MAIN], at(20_001)).usable).toEqual([MAIN]);
  });

  it('waits a minute on a 429 that says nothing about itself', () => {
    const quota = new ModelQuota();
    quota.onRateLimited(
      MAIN,
      new GoogleGenerativeAIFetchError('[429]', 429, 'Too Many Requests'),
      T0,
    );
    expect(quota.order([MAIN], at(59_000)).usable).toEqual([]);
    expect(quota.order([MAIN], at(60_001)).usable).toEqual([MAIN]);
  });

  it("learns the real daily limit from Google's answer when the table is wrong", () => {
    const quota = new ModelQuota();
    quota.onRateLimited(MAIN, quotaError(PER_DAY, undefined, '250'), T0);
    const tomorrow = new Date('2026-09-24T08:00:00.000Z');
    expect(quota.remaining(MAIN, tomorrow).day).toBe(250);
  });

  it('says when the first skipped model comes back', () => {
    const quota = new ModelQuota();
    quota.onRateLimited(MAIN, quotaError(PER_DAY), T0);
    quota.onRateLimited(SMALL, quotaError(PER_MINUTE, '30s'), T0);
    expect(quota.nextAvailableAt([MAIN, SMALL], T0)?.toISOString()).toBe(at(30_000).toISOString());
    expect(quota.nextAvailableAt([MAIN], T0)?.toISOString()).toBe('2026-09-24T07:00:00.000Z');
    expect(new ModelQuota().nextAvailableAt([MAIN], T0)).toBeNull();
  });

  it('summarises today, for the log', () => {
    const quota = new ModelQuota();
    quota.record(MAIN, T0);
    expect(quota.describe(MAIN, T0)).toBe('gemini-3.1-flash-lite 1/500 today');
    expect(quota.describe('gemini-9-experimental', T0)).toBe(
      'gemini-9-experimental (no limit table)',
    );
  });
});
