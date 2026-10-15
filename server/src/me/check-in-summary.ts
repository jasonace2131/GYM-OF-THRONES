import { addDays, civilDaysBetween, type CivilDate } from '../common/time/gym-time';

/**
 * The member's own attendance, summarised.
 *
 * PURE. Takes the business dates a member visited on and today's date; returns
 * every number the portal renders. No clock, no Prisma — which is what makes
 * the streak rules testable as rules rather than sampled through a database.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EVERYTHING HERE COUNTS BUSINESS DATES, NOT TIMESTAMPS.
 *
 * A visit belongs to the gym's civil day, and `businessDate` is a `@db.Date`
 * compared as a `CivilDate` string end to end. Bucketing on `occurredAt`
 * instead would put every visit before 08:00 Manila on the previous day — and
 * the gym opens at 05:00, so that is the busiest hour of the morning landing
 * in the wrong square of the heatmap.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** How much history the heatmap shows. Half a year of squares reads at a glance. */
export const HEATMAP_WEEKS = 26;

export interface CheckInSummary {
  thisMonth: number;
  allTime: number;
  /** Over the heatmap window, to one decimal. */
  avgPerWeek: number;
  /** Consecutive weeks ending with the current one. */
  currentStreakWeeks: number;
  longestStreakWeeks: number;
  /** One entry per day that had at least one visit. Sparse on purpose. */
  days: { date: CivilDate; count: number }[];
}

/**
 * `visits` is every non-voided business date, one entry per visit — so a
 * member who came twice on one day appears twice, and that day's square counts
 * two.
 */
export function summariseCheckIns(visits: readonly CivilDate[], today: CivilDate): CheckInSummary {
  const counts = new Map<string, number>();
  for (const day of visits) counts.set(day, (counts.get(day) ?? 0) + 1);

  const windowStart = addDays(today, -(HEATMAP_WEEKS * 7 - 1));

  const days = [...counts.entries()]
    .filter(([day]) => day >= windowStart && day <= today)
    .map(([date, count]) => ({ date: date as CivilDate, count }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const inWindow = days.reduce((total, day) => total + day.count, 0);

  // The current month, gym-local, by string prefix. A date comparison would
  // work too; a prefix cannot get the month boundary wrong.
  const month = today.slice(0, 7);
  const thisMonth = [...counts.entries()]
    .filter(([day]) => day.startsWith(month))
    .reduce((total, [, count]) => total + count, 0);

  const weeks = weeksWithAVisit(days.map((day) => day.date), today);

  return {
    thisMonth,
    allTime: visits.length,
    // Over the WINDOW, not over all time: a member who trained hard two years
    // ago and stopped should not read as "3.4 per week" today.
    avgPerWeek: Math.round((inWindow / HEATMAP_WEEKS) * 10) / 10,
    currentStreakWeeks: currentStreak(weeks),
    longestStreakWeeks: longestStreak(weeks),
    days,
  };
}

/**
 * WEEKS, NOT DAYS, and that is the whole point of the streak.
 *
 * A daily streak punishes a rest day, which is exactly the behaviour a gym
 * wants — nobody should feel a counter reset for not training on a Sunday. A
 * weekly streak rewards the habit that actually matters: turning up most
 * weeks, indefinitely.
 *
 * Week index 0 is the week containing `today`, 1 is the week before, and so on.
 */
function weeksWithAVisit(days: readonly CivilDate[], today: CivilDate): Set<number> {
  const weeks = new Set<number>();
  for (const day of days) {
    weeks.add(Math.floor(civilDaysBetween(day, today) / 7));
  }
  return weeks;
}

/**
 * Counts back from the current week.
 *
 * THE CURRENT WEEK IS FORGIVEN. A member who trained last week but not yet
 * this one still has their streak — it is Monday morning, and telling them
 * they have lost a twelve-week run because they have not been in since Friday
 * is both wrong and the kind of thing that makes people stop opening the app.
 * The streak only breaks once a whole week passes with no visit.
 */
function currentStreak(weeks: ReadonlySet<number>): number {
  if (weeks.size === 0) return 0;

  const start = weeks.has(0) ? 0 : weeks.has(1) ? 1 : -1;
  if (start === -1) return 0;

  let streak = 0;
  for (let week = start; weeks.has(week); week += 1) streak += 1;
  return streak;
}

function longestStreak(weeks: ReadonlySet<number>): number {
  if (weeks.size === 0) return 0;

  const sorted = [...weeks].sort((a, b) => a - b);
  let best = 1;
  let run = 1;

  for (let i = 1; i < sorted.length; i += 1) {
    run = sorted[i] === sorted[i - 1] + 1 ? run + 1 : 1;
    if (run > best) best = run;
  }

  return best;
}
