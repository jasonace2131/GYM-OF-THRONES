import { describe, expect, it } from 'vitest';
import type { StationTokenBatch } from '@got/shared';
import {
  activeToken,
  anchorFrom,
  correctedNow,
  deskClock,
  displayState,
  formatOutage,
  headPollMs,
  msUntilNextSlot,
  pastOpenUntil,
  runwayMs,
  shouldRefill,
} from './stationDisplay';

const SLOT_SECONDS = 30;
/** 18:00:00 Manila. */
const T0 = Date.parse('2026-08-18T10:00:00.000Z');

function batchAt(startMs = T0, count = 10): StationTokenBatch {
  return {
    station: { id: 's-1', code: '9F2K', name: 'Front desk' },
    slotSeconds: SLOT_SECONDS,
    serverTime: new Date(startMs).toISOString(),
    tokenEpoch: 1,
    openUntil: new Date(Date.parse('2026-08-18T14:15:00.000Z')).toISOString(),
    batchEtag: '9F2K:1:59570000',
    tokens: Array.from({ length: count }, (_t, i) => ({
      slot: 59_570_000 + i,
      notBefore: new Date(startMs + i * SLOT_SECONDS * 1000).toISOString(),
      notAfter: new Date(startMs + (i + 1) * SLOT_SECONDS * 1000).toISOString(),
      payload: `GOTS1.9F2K.${59_570_000 + i}.4RTXK8B2QWY5H3PZ`,
    })),
  };
}

/**
 * The tablet's own clock is irrelevant BY DESIGN. Cheap mounted Android
 * tablets drift and may never see a time server; a display that trusted
 * `Date.now()` would paint the wrong slot and produce a queue of denials for a
 * fault nobody could see.
 */
describe('clock correction', () => {
  it('corrects a tablet running two minutes fast', () => {
    const localNow = T0 + 120_000;
    const anchor = anchorFrom(batchAt(T0), localNow);

    expect(anchor.offsetMs).toBe(-120_000);
    expect(correctedNow(anchor, localNow)).toBe(T0);
  });

  it('corrects a tablet running two minutes slow', () => {
    const localNow = T0 - 120_000;
    expect(correctedNow(anchorFrom(batchAt(T0), localNow), localNow)).toBe(T0);
  });

  it('falls back to the local clock when nothing has anchored yet', () => {
    expect(correctedNow(null, T0)).toBe(T0);
  });

  it('picks the right slot on a drifting tablet', () => {
    const batch = batchAt(T0);
    // Local clock is 5 minutes ahead; the corrected now is 45 s in, slot index 1.
    const localNow = T0 + 45_000 + 300_000;
    const anchor = anchorFrom(batch, T0 + 300_000);

    expect(activeToken(batch, correctedNow(anchor, localNow))?.slot).toBe(59_570_001);
  });
});

describe('activeToken', () => {
  it('returns the token whose own window contains now', () => {
    const batch = batchAt();
    expect(activeToken(batch, T0)?.slot).toBe(59_570_000);
    expect(activeToken(batch, T0 + 29_999)?.slot).toBe(59_570_000);
    expect(activeToken(batch, T0 + 30_000)?.slot).toBe(59_570_001);
  });

  /**
   * Half-open on purpose. A closed interval makes two tokens valid for one
   * millisecond and the winner order-dependent.
   */
  it('gives an exact boundary to the NEXT slot', () => {
    const batch = batchAt();
    const boundary = T0 + SLOT_SECONDS * 1000;
    expect(activeToken(batch, boundary)?.slot).toBe(59_570_001);
  });

  /**
   * THE HARD RULE. Returning "the closest token" here is exactly the silent
   * failure that teaches members the system is broken: the code scans, then
   * the server refuses it, and the denial is not their fault.
   */
  it('returns null past the end of the batch rather than the last token', () => {
    const batch = batchAt();
    const pastEnd = T0 + 10 * SLOT_SECONDS * 1000;
    expect(activeToken(batch, pastEnd)).toBeNull();
  });

  it('returns null before the batch begins', () => {
    expect(activeToken(batchAt(), T0 - 1)).toBeNull();
  });

  it('returns null when nothing has been fetched', () => {
    expect(activeToken(null, T0)).toBeNull();
  });
});

describe('repaint and refill timing', () => {
  it('counts down to the slot boundary, never past it', () => {
    expect(msUntilNextSlot(batchAt(), T0)).toBe(30_000);
    expect(msUntilNextSlot(batchAt(), T0 + 29_000)).toBe(1_000);
    expect(msUntilNextSlot(batchAt(), T0 + 10 * 30_000)).toBe(0);
  });

  it('measures the runway to the end of the last token', () => {
    expect(runwayMs(batchAt(), T0)).toBe(300_000);
    expect(runwayMs(batchAt(), T0 + 150_000)).toBe(150_000);
    expect(runwayMs(null, T0)).toBe(0);
  });

  /**
   * Refilling at HALF the runway rather than at the end is what stops one
   * failed request from ever being visible: there is always a second chance
   * inside the same batch.
   */
  it('refills at half the runway, giving a failed request a second chance', () => {
    const batch = batchAt();
    expect(shouldRefill(batch, T0)).toBe(false);
    expect(shouldRefill(batch, T0 + 149_000)).toBe(false);
    expect(shouldRefill(batch, T0 + 150_000)).toBe(true);
  });

  it('always refills when there is no batch at all', () => {
    expect(shouldRefill(null, T0)).toBe(true);
  });
});

describe('displayState', () => {
  const base = { batch: batchAt(), nowMs: T0, configured: true, settled: true, closed: false };

  it('is UNCONFIGURED on a fresh tablet with no credential', () => {
    expect(displayState({ ...base, configured: false })).toBe('UNCONFIGURED');
  });

  it('is BOOTING until the first attempt settles', () => {
    expect(displayState({ ...base, batch: null, settled: false })).toBe('BOOTING');
  });

  it('is LIVE while a token is in window', () => {
    expect(displayState(base)).toBe('LIVE');
  });

  it('is FALLBACK once the batch is exhausted', () => {
    expect(displayState({ ...base, nowMs: T0 + 400_000 })).toBe('FALLBACK');
  });

  it('is FALLBACK when the first fetch failed outright', () => {
    expect(displayState({ ...base, batch: null })).toBe('FALLBACK');
  });

  /**
   * CLOSED outranks FALLBACK. "We open at 5" is true and useful; it must not
   * be replaced by "our network is down" merely because the out-of-hours poll
   * also failed.
   */
  it('prefers CLOSED over FALLBACK when both apply', () => {
    expect(displayState({ ...base, batch: null, closed: true })).toBe('CLOSED');
  });

  it('is UNCONFIGURED even when closed, because there is nothing to say yet', () => {
    expect(displayState({ ...base, configured: false, closed: true })).toBe('UNCONFIGURED');
  });
});

describe('pastOpenUntil', () => {
  it('uses the edge the SERVER carried on the batch, not a local opinion', () => {
    const batch = batchAt();
    const openUntil = Date.parse(batch.openUntil);
    expect(pastOpenUntil(batch, openUntil - 1)).toBe(false);
    expect(pastOpenUntil(batch, openUntil + 1)).toBe(true);
  });

  it('is false with no batch — an unknown edge is not a closed gym', () => {
    expect(pastOpenUntil(null, T0)).toBe(false);
  });
});

describe('headPollMs', () => {
  /**
   * One round trip per slot is what makes a tokenEpoch bump a ONE-SLOT panic
   * button instead of a five-minute one.
   */
  it('polls once per slot while the gym is open', () => {
    expect(headPollMs('LIVE', SLOT_SECONDS)).toBe(30_000);
    expect(headPollMs('FALLBACK', SLOT_SECONDS)).toBe(30_000);
  });

  it('backs off hard while closed, so an unattended screen sleeps', () => {
    expect(headPollMs('CLOSED', SLOT_SECONDS)).toBe(600_000);
  });
});

describe('deskClock', () => {
  it('renders gym-local time, not the tablet locale', () => {
    // 10:00 UTC is 18:00 in Manila. A tablet set to UTC must still say 6 PM.
    expect(deskClock(T0, 'Asia/Manila')).toEqual({ time: '6:00 PM', date: 'Tue 18 Aug' });
  });
});

describe('formatOutage', () => {
  it.each([
    [0, '00:00'],
    [42_000, '00:42'],
    [61_000, '01:01'],
    [3_600_000, '60:00'],
  ])('renders %ims as %s', (ms, expected) => {
    expect(formatOutage(ms)).toBe(expected);
  });

  it('never renders a negative outage from a clock correction', () => {
    expect(formatOutage(-5_000)).toBe('00:00');
  });
});
