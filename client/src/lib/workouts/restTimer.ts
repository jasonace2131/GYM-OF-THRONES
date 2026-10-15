/**
 * The rest timer on the session screen (spec §5).
 *
 * A rest is an END INSTANT, not a countdown: a phone that locks its screen
 * mid-rest stops running timers, and a countdown would wake up wrong. Every
 * number on screen is `endsAt - now`, recomputed on each tick.
 */

/** "+15 s". */
export const REST_STEP_SECONDS = 15;

export interface RestState {
  /** Epoch milliseconds. */
  endsAt: number;
  /** The exercise whose set started it. */
  exerciseIndex: number;
  /** "REST · NEXT SET 3" — one-based. */
  nextSet: number;
}

/** Null when the plan gives no rest for this exercise. */
export function startRest(
  now: number,
  seconds: number,
  exerciseIndex: number,
  nextSet: number,
): RestState | null {
  if (seconds <= 0) return null;
  return { endsAt: now + seconds * 1000, exerciseIndex, nextSet };
}

/** Whole seconds left, rounded up; 0 once it is over. */
export function restRemaining(rest: RestState, now: number): number {
  return Math.max(0, Math.ceil((rest.endsAt - now) / 1000));
}

/** +15 s on whatever is left — or from now, if it had already run out. */
export function extendRest(
  rest: RestState,
  now: number,
  seconds: number = REST_STEP_SECONDS,
): RestState {
  return { ...rest, endsAt: Math.max(rest.endsAt, now) + seconds * 1000 };
}

/** "0:48", "1:30". */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Time in the workout: "18:42", or "1:02:03" past the hour. */
export function elapsedClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  if (hours === 0) return clock(total);
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function spoken(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  const parts: string[] = [];
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  if (rest > 0 || minutes === 0) parts.push(`${rest} ${rest === 1 ? 'second' : 'seconds'}`);
  return parts.join(' ');
}

/**
 * What the polite live region says. A timer that announced every second
 * would talk over the member's music for the whole rest, so it speaks when
 * the rest starts, on each 15-second mark, and when it is over.
 */
export function restAnnouncement(remaining: number, justStarted: boolean): string | null {
  if (remaining <= 0) return 'Rest over. Next set.';
  if (justStarted) return `Rest, ${spoken(remaining)}.`;
  if (remaining % REST_STEP_SECONDS === 0) return `${spoken(remaining)} left.`;
  return null;
}
