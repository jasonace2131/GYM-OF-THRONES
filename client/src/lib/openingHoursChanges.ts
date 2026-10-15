import { hhmmTo12h } from './gymTime';

/** One weekday's hours, as `GET /admin/hours` returns them. */
export interface WeekdayHours {
  /** 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number;
  opensAt: string;
  closesAt: string;
  isClosed: boolean;
}

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

function describe(day: WeekdayHours): string {
  return day.isClosed ? 'closed all day' : `${hhmmTo12h(day.opensAt)} – ${hhmmTo12h(day.closesAt)}`;
}

/**
 * What a "Save hours" is about to change, one line per day, for the
 * confirmation.
 *
 * Opening hours decide who gets through the door, and a save takes effect at
 * the next scan — so the dialog lists exactly which days move rather than
 * asking somebody to re-read a seven-row table they just edited.
 *
 * A day that is closed before AND after is unchanged whatever its times say:
 * the gate reads nothing from the times of a closed day, so listing them
 * would announce a change that has no effect.
 */
export function hoursChanges(before: WeekdayHours[], after: WeekdayHours[]): string[] {
  const was = new Map(before.map((day) => [day.dayOfWeek, day]));

  return [...after]
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
    .flatMap((day) => {
      const name = WEEKDAY_NAMES[day.dayOfWeek] ?? `Day ${day.dayOfWeek}`;
      const previous = was.get(day.dayOfWeek);
      if (previous === undefined) return [`${name}: set to ${describe(day)}`];

      if (previous.isClosed && day.isClosed) return [];
      if (
        previous.isClosed === day.isClosed &&
        previous.opensAt === day.opensAt &&
        previous.closesAt === day.closesAt
      ) {
        return [];
      }
      return [`${name}: ${describe(previous)} → ${describe(day)}`];
    });
}
