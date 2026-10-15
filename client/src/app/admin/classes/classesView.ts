import { waitlistClosesAt, type ClassRegisterEntryWire, type ClassSessionWire } from '@got/shared';
// gymTime, not classes.ts: the latter imports the API client (and through it
// Supabase), which a unit test cannot load.
import { addDays, asCivilDate, civilDaysBetween } from '@/lib/gymTime';

/**
 * The pure half of the console's Classes screen: which days it shows, how the
 * URL spells that, and the sentences its confirmations say. Everything here
 * is decided from its arguments — `now` and `today` included — so it is
 * tested without a clock.
 */

// ── The window of days on screen ────────────────────────────────────────────

/**
 * Days shown at once, and the step Earlier / Later moves by — two weeks, the
 * same fortnight the timetable showed before it could move at all.
 */
export const TIMETABLE_WINDOW_DAYS = 14;

/**
 * `?from=` read back: a real gym day, or `today`.
 *
 * VALIDATED, never cast. A link is user input, and `?from=lol` passed to the
 * API would come back a 400 and an error card instead of a timetable.
 */
export function readWindowStart(raw: string | null, today: string): string {
  if (raw === null) return today;
  try {
    return asCivilDate(raw);
  } catch {
    return today;
  }
}

/** The inclusive gym days of the window starting `start`. */
export function timetableWindow(start: string): { from: string; to: string } {
  return { from: start, to: addDays(asCivilDate(start), TIMETABLE_WINDOW_DAYS - 1) };
}

/** The start of the window `steps` windows away — negative is earlier. */
export function stepWindow(start: string, steps: number): string {
  return addDays(asCivilDate(start), steps * TIMETABLE_WINDOW_DAYS);
}

/**
 * The start of the window containing `day`, on the same two-week grid as
 * `start` — where a class just scheduled outside the visible days lives.
 */
export function windowContaining(start: string, day: string): string {
  const offset = civilDaysBetween(asCivilDate(start), asCivilDate(day));
  return stepWindow(start, Math.floor(offset / TIMETABLE_WINDOW_DAYS));
}

/** `@IsUUID('4')`'s own pattern: anything else the API answers with a 400. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** `?coach=` read back: a coach id the API would accept, or '' for everybody. */
export function readCoachFilter(raw: string | null): string {
  return raw !== null && UUID_V4.test(raw) ? raw : '';
}

/**
 * The screen's URL for a window and a coach filter.
 *
 * Today's window and "all coaches" are the defaults, and they leave the URL:
 * a bare `/admin/classes` keeps following today, so a screen left open at the
 * desk moves on to the new day at midnight instead of pinning yesterday.
 */
export function timetableHref(start: string, coach: string, today: string): string {
  const params = new URLSearchParams();
  if (start !== today) params.set('from', start);
  if (coach !== '') params.set('coach', coach);
  const query = params.toString();
  return query === '' ? '/admin/classes' : `/admin/classes?${query}`;
}

// ── Who is told, and what ───────────────────────────────────────────────────
//
// Members get a notice in the app (owner, 2026-10-11) when a class they are
// booked into, or waiting for, is cancelled or changes its time, coach or
// name — and when the desk adds or removes them. The console's copy used to
// say "the system does not notify them, so tell them"; these sentences are
// what replaced it, worked out from what the write will actually do.

/**
 * The subject and verb of a sentence about who gets a notice:
 * "all 7 people booked or waiting get", "the one person booked gets".
 * Null when nobody holds a place.
 */
export function holdersPhrase(booked: number, waiting: number): string | null {
  const total = booked + waiting;
  if (total === 0) return null;
  if (total === 1)
    return booked === 1 ? 'the one person booked gets' : 'the one person waiting gets';
  const who = booked > 0 && waiting > 0 ? 'booked or waiting' : booked > 0 ? 'booked' : 'waiting';
  return `all ${total} people ${who} get`;
}

/** "5 people have booked this and 2 are waiting." Null when nobody holds a place. */
export function holdersSentence(booked: number, waiting: number): string | null {
  if (booked === 0 && waiting === 0) return null;
  if (booked === 0) {
    return `${waiting} ${waiting === 1 ? 'person is' : 'people are'} waiting for a place.`;
  }
  const seated = `${booked} ${booked === 1 ? 'person has' : 'people have'} booked this`;
  return waiting === 0
    ? `${seated}.`
    : `${seated} and ${waiting} ${waiting === 1 ? 'is' : 'are'} waiting.`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The cancel confirmation's sentence. Everybody booked or waiting is told, with
 * the reason — every booking that is not itself cancelled, which is exactly
 * `bookedCount + waitlistCount`: a register marked early (the half hour before
 * the start) still holds its seat in `bookedCount`, and the server tells those
 * members too, and resets their marks.
 */
export function cancelConsequence(booked: number, waiting: number): string {
  const told = holdersPhrase(booked, waiting);
  return told === null
    ? 'The class stays on the timetable marked cancelled, with your reason.'
    : `The class stays on the timetable marked cancelled, and ${told} a notice in the app with your reason.`;
}

/** What an edit sends — `PATCH /admin/class-sessions/:id`, the changed fields only. */
export interface ClassPatch {
  title?: string;
  coachId?: string;
  startsAt?: string;
  endsAt?: string;
  capacity?: number;
}

/** Whether the edit changes what people were told: the time, the coach or the name. */
export function patchNotifies(patch: ClassPatch): boolean {
  return (
    patch.title !== undefined ||
    patch.coachId !== undefined ||
    patch.startsAt !== undefined ||
    patch.endsAt !== undefined
  );
}

type EditedSession = Pick<
  ClassSessionWire,
  'capacity' | 'bookedCount' | 'waitlistCount' | 'startsAt'
>;

/**
 * How many people a capacity raise moves off the waitlist — at most.
 *
 * Zero once the waitlist has closed (judged on the class's NEW start, which is
 * what the server judges): from then on nobody is promoted, and the new places
 * go to whoever books first. "At most", because a member who joined the
 * waitlist themselves and whose plan will not cover the class is skipped and
 * stays where they are. (Somebody the desk added is moved in regardless: the
 * desk's add already waived the plan rule.)
 */
export function raiseMovesUp(session: EditedSession, patch: ClassPatch, now: Date): number {
  if (patch.capacity === undefined || patch.capacity <= session.capacity) return 0;
  const startsAt = patch.startsAt ?? session.startsAt;
  if (now.getTime() >= waitlistClosesAt(startsAt).getTime()) return 0;
  return Math.max(0, Math.min(patch.capacity - session.bookedCount, session.waitlistCount));
}

/**
 * The edit confirmation: its one sentence, and any supporting fact.
 *
 * The sentence says who is told; a waitlist moving up (or, after the cutoff,
 * not moving) is the fact under it. With nobody to tell, the waitlist line
 * becomes the sentence itself.
 *
 * Nothing here promises WHO moves up: the next person in the queue may be
 * passed over (see `raiseMovesUp`), so the copy says "the next eligible
 * person". Who is told follows the server: before the start, everybody booked
 * or waiting; once the class is running, the seats only — a waitlist place on
 * a running class is no place at all (`stillWaiting`).
 */
export function editConsequence(
  session: EditedSession,
  patch: ClassPatch,
  now: Date,
): { consequence: string; facts: string[] } {
  const facts: string[] = [];
  const movesUp = raiseMovesUp(session, patch, now);
  const raised = patch.capacity !== undefined && patch.capacity > session.capacity;
  if (movesUp > 1) {
    facts.push(
      `The new places go to up to ${movesUp} eligible people on the waitlist, in queue order, and each is told in the app.`,
    );
  } else if (movesUp === 1) {
    facts.push(
      session.waitlistCount === 1
        ? 'The person waiting moves into a new place if they are still eligible, and is told in the app.'
        : 'The new place goes to the next eligible person on the waitlist, who is told in the app.',
    );
  } else if (raised && session.waitlistCount > 0) {
    facts.push(
      'The waitlist has closed, so nobody moves up by themselves: the new places go to whoever books first.',
    );
  }

  // The stored start, not the patched one: the server asks whether the class
  // is running now, before the edit lands.
  const running = now.getTime() >= new Date(session.startsAt).getTime();
  const told = patchNotifies(patch)
    ? holdersPhrase(session.bookedCount, running ? 0 : session.waitlistCount)
    : null;
  if (told !== null) {
    return { consequence: `${capitalise(told)} a notice in the app with the new details.`, facts };
  }
  const [first, ...rest] = facts;
  return first === undefined
    ? { consequence: 'Members see the new details on the timetable straight away.', facts: [] }
    : { consequence: first, facts: rest };
}

/**
 * The remove confirmation's sentence. The member is always told, with the
 * reason; what happens to their place depends on the waitlist — before the
 * cutoff it goes to the next ELIGIBLE person waiting, who need not be the
 * first in the queue (see `raiseMovesUp`).
 */
export function removeConsequence(
  entry: Pick<ClassRegisterEntryWire, 'status'>,
  firstName: string,
  session: Pick<ClassSessionWire, 'startsAt' | 'waitlistCount'>,
  now: Date,
): string {
  if (entry.status === 'WAITLISTED') {
    return `${firstName} comes off the waitlist and gets a notice in the app with your reason.`;
  }
  const queueTakesIt =
    session.waitlistCount > 0 && now.getTime() < waitlistClosesAt(session.startsAt).getTime();
  return queueTakesIt
    ? `${firstName}'s place goes to the next eligible person on the waitlist, and ${firstName} gets a notice in the app with your reason.`
    : `${firstName}'s place opens up for somebody else to book, and ${firstName} gets a notice in the app with your reason.`;
}
