import { describe, expect, it } from 'vitest';
import { COACH_PLAN, COACH_PLAN_UNLABELLED } from './fixtures';
import {
  COACH_PLAN_HREF,
  coachBadge,
  coachDayHref,
  coachDays,
  coachName,
  coachPlanMeta,
  coachPlanTitle,
} from './coachPlan';

const NO_COACH = { ...COACH_PLAN, coach: null };

describe('the coach card', () => {
  it('names the coach, or says "your coach" when the account is gone', () => {
    expect(coachName(COACH_PLAN)).toBe('Coach Ana');
    expect(coachName(NO_COACH)).toBe('your coach');
    expect(coachPlanTitle(COACH_PLAN)).toBe("Coach Ana's plan");
    expect(coachPlanTitle(NO_COACH)).toBe("Your coach's plan");
    expect(coachBadge(COACH_PLAN)).toBe('From coach Ana');
    expect(coachBadge(NO_COACH)).toBe('From your coach');
  });

  it('reads "3 days · Mon · Wed · Fri · updated by your coach Sep 27"', () => {
    expect(coachPlanMeta(COACH_PLAN)).toBe(
      '3 days · Mon · Wed · Fri · updated by your coach Sep 27',
    );
    expect(coachPlanMeta(COACH_PLAN_UNLABELLED)).toBe('3 days · updated by your coach Sep 27');
  });
});

describe('coachDays', () => {
  it('titles a day by its focus — the workout will be called that — under DAY · WEEKDAY', () => {
    const [monday] = coachDays(COACH_PLAN);
    expect(monday).toMatchObject({
      index: 0,
      weekday: 1,
      kicker: 'DAY 1 · MONDAY',
      title: 'Lower body',
      count: '2 exercises',
      start: { source: 'COACH_PLAN', dayIndex: 0 },
      anchor: 'coach-day-0',
    });
    // The coach records no rest, so the session's default applies.
    expect(monday?.exercises[1]).toEqual({
      name: 'Romanian deadlift',
      muscles: null,
      sets: 3,
      reps: '8-10',
      restSeconds: 90,
      notes: 'Soft knees, flat back.',
    });
  });

  it("keeps a coach's own label in the kicker when it says more than the day number", () => {
    const [first] = coachDays(COACH_PLAN_UNLABELLED);
    expect(first).toMatchObject({ weekday: null, kicker: 'DAY 1', title: 'Lower body' });
    const named = {
      ...COACH_PLAN_UNLABELLED,
      plan: {
        ...COACH_PLAN_UNLABELLED.plan,
        days: [{ ...COACH_PLAN_UNLABELLED.plan.days[0]!, day: 'Upper A' }],
      },
      weekdays: [null],
    };
    expect(coachDays(named)[0]?.kicker).toBe('DAY 1 · UPPER A');
    // A second "Monday" is not Today's Monday, but it still says Monday.
    const twice = { ...COACH_PLAN, weekdays: [1, null, 5] };
    const doubled = {
      ...twice,
      plan: {
        ...twice.plan,
        days: twice.plan.days.map((d, i) => (i === 1 ? { ...d, day: 'Monday' } : d)),
      },
    };
    expect(coachDays(doubled)[1]?.kicker).toBe('DAY 2 · MONDAY');
  });

  it('clips nothing on the page — the server clips the session title to 40', () => {
    const long = 'Lower body, conditioning and a long core finisher to end';
    const plan = {
      ...COACH_PLAN,
      plan: {
        ...COACH_PLAN.plan,
        days: [{ ...COACH_PLAN.plan.days[0]!, focus: long }],
      },
      weekdays: [1],
    };
    expect(coachDays(plan)[0]?.title).toBe(long);
  });

  it('links a day on the coach page', () => {
    expect(COACH_PLAN_HREF).toBe('/portal/workouts/coach');
    expect(coachDayHref(2)).toBe('/portal/workouts/coach#coach-day-2');
  });
});
