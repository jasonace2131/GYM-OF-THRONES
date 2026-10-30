import type { ClassSession } from '@/lib/classes';

/**
 * Which days of the member's window have classes (gym report, 2026-10-30:
 * "members can't book in advance, the member side only shows today").
 *
 * They could book ahead all along. The timetable opened on today, one day at
 * a time, and the date strip only marked days the member had ALREADY booked,
 * so once today's classes had passed the page was an empty day with nothing
 * to say that Thursday had six. These answer the three questions that fix:
 * which days have classes, which day to open on, and where the next class is.
 *
 * Pure, and a type-only import of `@/lib/classes` (which pulls in Supabase).
 */

/** Classes per gym day. A cancelled class is left out: it is nothing to go to. */
export function classCountsByDay(sessions: readonly ClassSession[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    if (session.cancelledAt !== null) continue;
    counts.set(session.businessDate, (counts.get(session.businessDate) ?? 0) + 1);
  }
  return counts;
}

/** Gym days with a class still to come: not cancelled, not started. */
function daysWithClassesAhead(sessions: readonly ClassSession[], now: Date): Set<string> {
  return new Set(
    sessions
      .filter(
        (session) =>
          session.cancelledAt === null && new Date(session.startsAt).getTime() > now.getTime(),
      )
      .map((session) => session.businessDate),
  );
}

/**
 * The day the timetable opens on when the link names none: today, while
 * today still has a class to come; otherwise the first day in the window that
 * does. A window with nothing ahead at all opens on today, where the empty
 * state says so.
 */
export function openingDay(
  days: readonly string[],
  sessions: readonly ClassSession[],
  today: string,
  now: Date,
): string {
  const ahead = daysWithClassesAhead(sessions, now);
  if (ahead.has(today)) return today;
  return days.find((day) => ahead.has(day)) ?? today;
}

/**
 * The first day after `day`, inside the window, with a class still to come —
 * the empty day's "Next class" button. Null when there is none.
 */
export function nextClassDay(
  days: readonly string[],
  sessions: readonly ClassSession[],
  day: string,
  now: Date,
): string | null {
  const ahead = daysWithClassesAhead(sessions, now);
  return days.find((candidate) => candidate > day && ahead.has(candidate)) ?? null;
}

/** "3 classes" for a chip's spoken name; "no classes" on a day with none. */
export function classCountLabel(count: number): string {
  if (count === 0) return 'no classes';
  return count === 1 ? '1 class' : `${count} classes`;
}
