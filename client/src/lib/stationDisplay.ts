import type { StationTokenBatch } from '@got/shared';

/**
 * The station display's decision logic, with no React and no clock of its own.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE HARD RULE: NEVER RENDER A CODE THE DISPLAY CANNOT PROVE IS IN WINDOW.
 *
 * A code that scans and then fails is worse than no code at all. It teaches
 * members the system is broken so they stop trying, and it manufactures a
 * queue of denials for a fault that is not theirs. Every function here exists
 * to make that rule checkable rather than hoped for — which is why the module
 * is pure: `now` is always a parameter, so the rule is testable without a
 * fake timer, a network or a tablet.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * THE TABLET'S OWN CLOCK IS IRRELEVANT, and that is a design goal rather than
 * an accident. Cheap Android tablets drift, and a mounted one may never see a
 * time server. The display therefore computes `serverTime − Date.now()` once
 * per fetch and corrects every comparison through it, so a tablet two minutes
 * fast still renders the right slot.
 */

/** What one fetch of the batch endpoint tells us about the clock. */
export interface ClockAnchor {
  /** `serverTime − localNow`, in milliseconds. Added to `Date.now()` to correct it. */
  offsetMs: number;
  /** The local instant this anchor was taken, so staleness is checkable. */
  takenAtMs: number;
}

/**
 * Anchor from a batch response.
 *
 * `receivedAtMs` is the LOCAL instant the response landed. Round-trip latency
 * makes the anchor late by up to half an RTT, which on gym wifi is single-digit
 * milliseconds against a 30-second slot — three orders of magnitude of margin,
 * so no RTT compensation is attempted. Attempting it would add a moving part
 * that is wrong in exactly the case (a slow network) where it is meant to help.
 */
export function anchorFrom(batch: StationTokenBatch, receivedAtMs: number): ClockAnchor {
  return {
    offsetMs: new Date(batch.serverTime).getTime() - receivedAtMs,
    takenAtMs: receivedAtMs,
  };
}

export function correctedNow(anchor: ClockAnchor | null, localNowMs: number): number {
  return localNowMs + (anchor?.offsetMs ?? 0);
}

export type StationToken = StationTokenBatch['tokens'][number];

/**
 * The one token whose own `[notBefore, notAfter)` contains the corrected now,
 * or `null`.
 *
 * `null` is not an error state to paper over — it is the batch running out, and
 * the caller MUST switch to the fallback panel rather than keep painting the
 * last code. Returning "the closest token" here would be exactly the silent
 * failure the hard rule forbids.
 *
 * The interval is half-open: at an exact boundary the NEXT slot wins. A closed
 * interval would make two tokens valid for one millisecond and the choice
 * order-dependent.
 */
export function activeToken(batch: StationTokenBatch | null, nowMs: number): StationToken | null {
  if (batch === null) return null;
  return (
    batch.tokens.find(
      (token) =>
        nowMs >= new Date(token.notBefore).getTime() && nowMs < new Date(token.notAfter).getTime(),
    ) ?? null
  );
}

/** Milliseconds until the current slot ends — what the repaint timer is set to. */
export function msUntilNextSlot(batch: StationTokenBatch | null, nowMs: number): number {
  const token = activeToken(batch, nowMs);
  if (token === null) return 0;
  return Math.max(0, new Date(token.notAfter).getTime() - nowMs);
}

/**
 * How much painting time the held batch still has.
 *
 * The display refills at HALF the remaining runway rather than at the end, so
 * a single failed request never costs a visible outage — there is always a
 * second chance inside the same batch.
 */
export function runwayMs(batch: StationTokenBatch | null, nowMs: number): number {
  if (batch === null || batch.tokens.length === 0) return 0;
  const last = batch.tokens[batch.tokens.length - 1];
  return Math.max(0, new Date(last.notAfter).getTime() - nowMs);
}

export function shouldRefill(batch: StationTokenBatch | null, nowMs: number): boolean {
  if (batch === null) return true;
  const total = batch.tokens.length * batch.slotSeconds * 1000;
  return runwayMs(batch, nowMs) <= total / 2;
}

/**
 * Four states, and exactly four. The display is a public surface rendering
 * "working" or "not working" — every failure mode collapses into `FALLBACK`
 * because a member cannot act differently on any of them, and the distinction
 * belongs in the small, dull diagnostic line staff reads from behind the
 * counter.
 */
export type DisplayState = 'BOOTING' | 'LIVE' | 'CLOSED' | 'FALLBACK' | 'UNCONFIGURED';

export interface DisplayInput {
  /** Null until the first successful fetch. */
  batch: StationTokenBatch | null;
  /** Corrected wall clock, in ms. */
  nowMs: number;
  /** True once a credential exists — a fresh tablet has none. */
  configured: boolean;
  /** True once at least one fetch attempt has completed, success or failure. */
  settled: boolean;
  /** The gym is shut: the token endpoint answered 410, or `openUntil` has passed. */
  closed: boolean;
}

export function displayState(input: DisplayInput): DisplayState {
  if (!input.configured) return 'UNCONFIGURED';
  // CLOSED outranks FALLBACK: "we open at 5" is a true and useful thing to say,
  // and it must not be replaced by "our network is down" just because the
  // out-of-hours poll also failed.
  if (input.closed) return 'CLOSED';
  if (!input.settled && input.batch === null) return 'BOOTING';
  return activeToken(input.batch, input.nowMs) === null ? 'FALLBACK' : 'LIVE';
}

/**
 * Has the gym closed since this batch was minted?
 *
 * `openUntil` is the server's own gym-hours edge, carried on the batch, so the
 * display never has to know the opening times, the time zone, or how the
 * fifteen-minute buffer works. One fact, computed once, on the side that owns
 * it.
 */
export function pastOpenUntil(batch: StationTokenBatch | null, nowMs: number): boolean {
  if (batch === null) return false;
  return nowMs > new Date(batch.openUntil).getTime();
}

/**
 * Poll interval for the epoch head check.
 *
 * Once per slot while open — one round trip per 30 s is negligible and it is
 * what makes a `tokenEpoch` bump a ONE-SLOT panic button instead of a
 * five-minute one. Backed off hard while closed so an unattended screen does
 * not hammer the endpoint for seven hours or hold a pooled connection warm all
 * night for nothing.
 */
export function headPollMs(state: DisplayState, slotSeconds: number): number {
  return state === 'CLOSED' ? 10 * 60_000 : slotSeconds * 1000;
}

/** `6:14 PM` and `Mon 18 Aug`, in the gym's own zone. Members trust a clock. */
export function deskClock(nowMs: number, timeZone: string): { time: string; date: string } {
  const at = new Date(nowMs);
  return {
    time: new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(at),
    date: new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(at),
  };
}

/** `00:42` — how long the display has been unable to reach the API. */
export function formatOutage(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
