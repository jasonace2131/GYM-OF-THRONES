import type { ClassSession } from '@/lib/classes';
import { REPEAT_WEEKS, repeatWeeksProblem } from './classRepeat';
import { gymParts } from './gymClock';

/**
 * Coaches run their own classes (owner, 2026-10-23) — the decisions behind
 * the Class Schedule's "New class", "Edit" and "Cancel class" for a coach.
 *
 * Pure, and a type-only import of `@/lib/classes` (which pulls in Supabase).
 * The SERVER is the authority: `class.manage` at OWN, enforced against the
 * class's coach, and the same time and capacity checks as the admin's form.
 * These only stop the form offering what would be refused.
 */

export interface ClassDraft {
  title: string;
  /** yyyy-mm-dd, gym day. */
  date: string;
  /** HH:mm, gym clock. */
  start: string;
  minutes: number;
  capacity: number;
  /**
   * "Repeat weekly" (owner, 2026-10-30), a new class only: the same class
   * every week for `weeks` weeks, the first included. `weeks` is kept while
   * the switch is off, so switching it back on finds the number it had.
   */
  repeat: boolean;
  weeks: number;
}

export const CLASS_LIMITS = { titleMax: 80, minutesMin: 10, minutesMax: 300, placesMax: 500 };

const hhmm = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** The form's starting values: a new class on `day`, or the class as it is. */
export function draftFor(session: ClassSession | null, day: string): ClassDraft {
  const once = { repeat: false, weeks: REPEAT_WEEKS.default };
  if (session === null) {
    return { title: '', date: day, start: '18:00', minutes: 60, capacity: 16, ...once };
  }
  return {
    title: session.title,
    date: session.businessDate,
    start: hhmm(gymParts(session.startsAt).minutes),
    minutes: Math.round(
      (new Date(session.endsAt).getTime() - new Date(session.startsAt).getTime()) / 60_000,
    ),
    capacity: session.capacity,
    ...once,
  };
}

/**
 * Gym-local date and time to instants. `+08:00` explicitly, as the admin
 * form does: a coach whose phone is set to another zone still schedules
 * 6pm Manila. Null while the date or time is not filled in.
 */
export function instantsOf(draft: ClassDraft): { startsAt: string; endsAt: string } | null {
  if (draft.date === '' || draft.start === '') return null;
  const startsAt = new Date(`${draft.date}T${draft.start}:00+08:00`);
  if (Number.isNaN(startsAt.getTime())) return null;
  return {
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + draft.minutes * 60_000).toISOString(),
  };
}

export function classFormProblem(draft: ClassDraft): string | null {
  const title = draft.title.trim();
  if (title === '') return 'Give the class a name.';
  if (Array.from(title).length > CLASS_LIMITS.titleMax) return 'Keep the name to 80 characters.';
  if (instantsOf(draft) === null) return 'Pick a date and a start time.';
  if (
    !Number.isInteger(draft.minutes) ||
    draft.minutes < CLASS_LIMITS.minutesMin ||
    draft.minutes > CLASS_LIMITS.minutesMax
  ) {
    return 'A class runs 10 to 300 minutes.';
  }
  if (!Number.isInteger(draft.capacity) || draft.capacity < 1 || draft.capacity > CLASS_LIMITS.placesMax) {
    return 'Places must be 1 to 500.';
  }
  if (draft.repeat) return repeatWeeksProblem(draft.weeks);
  return null;
}

/**
 * `POST /admin/class-sessions` — the coach is always the caller. `repeatWeeks`
 * only when repeating: a single class sends exactly the body it always did.
 */
export function createBody(
  draft: ClassDraft,
  coachId: string,
): {
  title: string;
  coachId: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  repeatWeeks?: number;
} {
  const times = instantsOf(draft);
  if (times === null) throw new Error('createBody: no date');
  return {
    title: draft.title.trim(),
    coachId,
    ...times,
    capacity: draft.capacity,
    ...(draft.repeat ? { repeatWeeks: draft.weeks } : {}),
  };
}

export interface ClassPatchBody {
  title?: string;
  startsAt?: string;
  endsAt?: string;
  capacity?: number;
}

/**
 * Only what changed — an untouched field resent would still tell everybody
 * booked that the class "changed". Never `coachId`: a coach cannot hand
 * their class to somebody else (the server refuses it too).
 */
export function patchFor(session: ClassSession, draft: ClassDraft): ClassPatchBody {
  const patch: ClassPatchBody = {};
  const title = draft.title.trim();
  if (title !== session.title) patch.title = title;
  const times = instantsOf(draft);
  if (times !== null) {
    if (times.startsAt !== new Date(session.startsAt).toISOString()) patch.startsAt = times.startsAt;
    if (times.endsAt !== new Date(session.endsAt).toISOString()) patch.endsAt = times.endsAt;
  }
  if (draft.capacity !== session.capacity) patch.capacity = draft.capacity;
  return patch;
}

const mine = (session: ClassSession, meId: string | null): boolean =>
  meId !== null && session.coachId === meId && session.cancelledAt === null;

/** Until it ends: a running class may still have its end moved. */
export function canEditClass(session: ClassSession, meId: string | null, now: Date): boolean {
  return mine(session, meId) && new Date(session.endsAt).getTime() > now.getTime();
}

/** Only before it starts — a class that ran cannot be called off. */
export function canCancelClass(session: ClassSession, meId: string | null, now: Date): boolean {
  return mine(session, meId) && new Date(session.startsAt).getTime() > now.getTime();
}
