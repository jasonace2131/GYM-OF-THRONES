import { describe, expect, it } from 'vitest';
import { COACH_PLAN, COACH_PLAN_UNLABELLED, HOME, PLAN, SUMMARY, SUMMARY_MONDAY } from './fixtures';
import {
  coachToday,
  finishedOn,
  plannedWeek,
  startKey,
  todaySource,
  workoutDays,
} from './todaySource';

describe('todaySource', () => {
  it("is the member's active AI plan when there is one", () => {
    const source = todaySource({ ...HOME, coachPlan: COACH_PLAN });
    expect(source).toEqual({ kind: 'member', plan: PLAN });
  });

  it("falls back to the coach's plan when no AI plan is active", () => {
    const plans = HOME.plans.map((p) => ({ ...p, isActive: false }));
    expect(todaySource({ plans, coachPlan: COACH_PLAN })).toEqual({
      kind: 'coach',
      plan: COACH_PLAN,
    });
    expect(todaySource({ plans: [], coachPlan: COACH_PLAN }).kind).toBe('coach');
  });

  it('is nothing without either', () => {
    expect(todaySource({ plans: [], coachPlan: null })).toEqual({ kind: 'none' });
    expect(todaySource({ plans: [{ ...PLAN, isActive: false }], coachPlan: null }).kind).toBe(
      'none',
    );
  });
});

describe('coachToday', () => {
  it("trains the day whose label names today's weekday", () => {
    expect(coachToday(COACH_PLAN, 3)).toEqual({ kind: 'train', dayIndex: 1 });
  });

  it('rests otherwise, naming the next labelled day, wrapping past Sunday', () => {
    expect(coachToday(COACH_PLAN, 4)).toEqual({ kind: 'rest', next: { dayIndex: 2, weekday: 5 } });
    expect(coachToday(COACH_PLAN, 6)).toEqual({ kind: 'rest', next: { dayIndex: 0, weekday: 1 } });
  });

  it('asks which day when no label names a weekday', () => {
    expect(coachToday(COACH_PLAN_UNLABELLED, 3)).toEqual({ kind: 'pick' });
  });

  it('never guesses a day for an unlabelled one in a partly labelled plan', () => {
    const partly = { ...COACH_PLAN, weekdays: [1, null, null] };
    expect(coachToday(partly, 3)).toEqual({ kind: 'rest', next: { dayIndex: 0, weekday: 1 } });
  });
});

describe('plannedWeek', () => {
  it('lists the planned weekdays of whichever plan drives Today', () => {
    expect(plannedWeek({ kind: 'member', plan: PLAN })).toEqual([
      { weekday: 1, title: 'Full body A' },
      { weekday: 3, title: 'Full body B' },
      { weekday: 6, title: 'Full body C' },
    ]);
    expect(plannedWeek({ kind: 'coach', plan: COACH_PLAN })).toEqual([
      { weekday: 1, title: 'Lower body' },
      { weekday: 3, title: 'Upper body' },
      { weekday: 5, title: 'Full body' },
    ]);
    expect(plannedWeek({ kind: 'coach', plan: COACH_PLAN_UNLABELLED })).toEqual([]);
    expect(plannedWeek({ kind: 'none' })).toEqual([]);
  });
});

describe('finished sessions', () => {
  it('finds a workout finished on a gym day, newest first', () => {
    expect(finishedOn([SUMMARY, SUMMARY_MONDAY], '2026-09-30')).toBe(SUMMARY);
    expect(finishedOn([SUMMARY, SUMMARY_MONDAY], '2026-09-29')).toBeNull();
    expect(workoutDays([SUMMARY, SUMMARY_MONDAY])).toEqual(['2026-09-30', '2026-09-28']);
  });
});

describe('startKey', () => {
  it('names a startable day, so its inline choice appears beside the right button', () => {
    expect(startKey({ source: 'MEMBER_PLAN', planId: 'plan-1', weekday: 3 })).toBe('m:plan-1:3');
    expect(startKey({ source: 'COACH_PLAN', dayIndex: 2 })).toBe('c:2');
  });
});
