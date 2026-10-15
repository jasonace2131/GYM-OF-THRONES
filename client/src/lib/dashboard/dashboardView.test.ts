import { describe, expect, it } from 'vitest';
import type { AllowReason, MyCheckInSummary } from '@got/shared';
import type { MembershipDetail } from '@/lib/portalData';
import { booking, at } from '@/lib/schedule/fixtures';
import {
  BOOKING_NEEDS_PLAN,
  UPCOMING_DAYS,
  dayMonth,
  greeting,
  heatmapMonthLabels,
  nextUpParts,
  statTiles,
  streakLabel,
  upcomingEmptyHint,
  waitlistLine,
} from './dashboardView';

describe('dayMonth', () => {
  it('is "4 Oct" — read off the civil date, no zone applied', () => {
    expect(dayMonth('2026-10-04')).toBe('4 Oct');
    expect(dayMonth('2026-01-31')).toBe('31 Jan');
  });
});

describe('streakLabel', () => {
  /** "0 week streak" is not a streak — it is a reproach. Say nothing. */
  it('is null at zero', () => {
    expect(streakLabel(0)).toBeNull();
  });

  it('is hyphenated, and singular at one', () => {
    expect(streakLabel(1)).toBe('1-week streak');
    expect(streakLabel(3)).toBe('3-week streak');
  });
});

describe('statTiles', () => {
  const summary = {
    thisMonth: 3,
    allTime: 41,
    avgPerWeek: 1.4,
    currentStreakWeeks: 3,
    longestStreakWeeks: 5,
    days: [],
  } as unknown as MyCheckInSummary;

  it('labels each number with what it counts', () => {
    expect(statTiles(summary, 2)).toEqual([
      { label: 'Check-ins this month', value: '3' },
      { label: 'All-time visits', value: '41' },
      { label: 'Avg. per week', value: '1.4' },
      { label: 'Booked · next 14 days', value: '2' },
    ]);
  });

  it('prints a whole average without a trailing .0', () => {
    expect(statTiles({ ...summary, avgPerWeek: 2 }, 0)[2]?.value).toBe('2');
  });

  it('shows a dash for a section that failed to load', () => {
    expect(statTiles(null, null).map((tile) => tile.value)).toEqual(['—', '—', '—', '—']);
  });

  /** The label is built from the same number the fetch uses, so the two cannot drift. */
  it('names the same fortnight the dashboard fetches', () => {
    expect(UPCOMING_DAYS).toBe(14);
    expect(statTiles(summary, 0)[3]?.label).toBe(`Booked · next ${UPCOMING_DAYS} days`);
  });
});

describe('waitlistLine', () => {
  it('is null without a waitlist place', () => {
    expect(waitlistLine(0)).toBeNull();
  });

  it('counts the places the Booked tile leaves out', () => {
    expect(waitlistLine(1)).toBe('1 waitlist place, not counted in Booked.');
    expect(waitlistLine(2)).toBe('2 waitlist places, not counted in Booked.');
  });
});

describe('upcomingEmptyHint', () => {
  // Thu 24 Sep 2026: a fortnight runs to 7 Oct, three weeks to 14 Oct.
  const now = at('2026-09-24', '09:00');
  const plan = (planCode: string, endsOn: string) =>
    ({ planCode, endsOn }) as Pick<MembershipDetail, 'planCode' | 'endsOn'>;
  const allow = (allowReason: AllowReason) => ({ allowReason });
  const denied = { allowReason: null };

  it("names the member's window while their plan covers today and the whole of it", () => {
    expect(upcomingEmptyHint(plan('MONTHLY', '2026-10-20'), allow('MEMBERSHIP_ACTIVE'), now)).toBe(
      'Classes for the next two weeks are open for booking.',
    );
    expect(
      upcomingEmptyHint(plan('QUARTERLY', '2026-12-01'), allow('MEMBERSHIP_ENDING'), now),
    ).toBe('Classes for the next three weeks are open for booking.');
  });

  it('counts the last day of the window as covered', () => {
    expect(upcomingEmptyHint(plan('MONTHLY', '2026-10-07'), allow('MEMBERSHIP_ACTIVE'), now)).toBe(
      'Classes for the next two weeks are open for booking.',
    );
    expect(upcomingEmptyHint(plan('MONTHLY', '2026-10-06'), allow('MEMBERSHIP_ACTIVE'), now)).toBe(
      BOOKING_NEEDS_PLAN,
    );
  });

  /** Owner, 2026-10-11: a member books only on a day their plan is active. */
  it('never promises the window to anybody whose plan does not cover today', () => {
    expect(upcomingEmptyHint(null, denied, now)).toBe(BOOKING_NEEDS_PLAN);
    expect(upcomingEmptyHint(plan('MONTHLY', '2026-09-20'), denied, now)).toBe(BOOKING_NEEDS_PLAN);
    // Grace and a day pass open the door, never a class.
    expect(
      upcomingEmptyHint(plan('MONTHLY', '2026-09-22'), allow('MEMBERSHIP_IN_GRACE'), now),
    ).toBe(BOOKING_NEEDS_PLAN);
    expect(upcomingEmptyHint(null, allow('DAY_PASS_VALID'), now)).toBe(BOOKING_NEEDS_PLAN);
  });

  it('does not promise the window to a plan that ends inside it', () => {
    expect(
      upcomingEmptyHint(plan('ANNUAL', '2026-09-24'), allow('MEMBERSHIP_EXPIRES_TODAY'), now),
    ).toBe(BOOKING_NEEDS_PLAN);
    expect(
      upcomingEmptyHint(plan('QUARTERLY', '2026-10-10'), allow('MEMBERSHIP_EXPIRING_SOON'), now),
    ).toBe(BOOKING_NEEDS_PLAN);
  });
});

describe('greeting', () => {
  it("follows the gym's clock", () => {
    expect(greeting(at('2026-09-24', '06:00'))).toBe('Good morning');
    expect(greeting(at('2026-09-24', '11:59'))).toBe('Good morning');
    expect(greeting(at('2026-09-24', '12:00'))).toBe('Good afternoon');
    expect(greeting(at('2026-09-24', '18:00'))).toBe('Good evening');
  });
});

describe('nextUpParts', () => {
  it('says "tomorrow at" for the next gym day', () => {
    const next = booking('BOOKED', {
      title: 'Spin',
      coachName: 'Mia Santos',
      startsAt: at('2026-09-25', '07:00').toISOString(),
      businessDate: '2026-09-25',
    });
    expect(nextUpParts(next, at('2026-09-24', '20:00'))).toEqual({
      title: 'Spin',
      when: 'tomorrow at 7:00 AM',
      coach: 'Mia Santos',
    });
  });

  it('says "today at" and "on <day> at"', () => {
    const today = booking('BOOKED', {
      startsAt: at('2026-09-24', '18:00').toISOString(),
      businessDate: '2026-09-24',
    });
    expect(nextUpParts(today, at('2026-09-24', '09:00')).when).toBe('today at 6:00 PM');

    const later = booking('BOOKED', {
      startsAt: at('2026-09-27', '09:00').toISOString(),
      businessDate: '2026-09-27',
    });
    expect(nextUpParts(later, at('2026-09-24', '09:00')).when).toBe('on Sun 27 Sep at 9:00 AM');
  });
});

describe('heatmapMonthLabels', () => {
  /** Each entry is the first civil day of one week column. */
  const columns = [
    '2026-03-30', // Mar — a partial month right before April starts
    '2026-04-06',
    '2026-04-13',
    '2026-04-20',
    '2026-04-27',
    '2026-05-04',
    '2026-05-11',
    '2026-05-18',
    '2026-05-25',
    '2026-06-01',
  ];

  it('labels the first column of each month', () => {
    expect(heatmapMonthLabels(columns.slice(1))).toEqual([
      'Apr',
      null,
      null,
      null,
      'May',
      null,
      null,
      null,
      'Jun',
    ]);
  });

  /** "MAR" and "APR" one column apart printed on top of each other: "MARPR". */
  it('drops a label that would collide with the next one', () => {
    expect(heatmapMonthLabels(columns)).toEqual([
      null,
      'Apr',
      null,
      null,
      null,
      'May',
      null,
      null,
      null,
      'Jun',
    ]);
  });

  it('is empty for no columns', () => {
    expect(heatmapMonthLabels([])).toEqual([]);
  });
});
