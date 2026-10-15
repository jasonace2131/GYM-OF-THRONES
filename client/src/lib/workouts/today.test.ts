import { describe, expect, it } from 'vitest';
import type { CivilDate } from '@/lib/gymTime';
import {
  bookedClassesByWeekday,
  dashboardCard,
  nextSession,
  todayKicker,
  todayModel,
  todayView,
  trainingProgress,
  weekExplanation,
  weekStrip,
} from './today';
import {
  CHECKINS,
  COACH_PLAN,
  COACH_PLAN_UNLABELLED,
  HOME,
  PLAN,
  PLAN_BODY,
  SESSION,
  SPIN,
  SUMMARY,
  SUMMARY_MONDAY,
  TODAY,
} from './fixtures';

describe('todayKicker', () => {
  it('reads "TODAY · WEDNESDAY, SEP 30", and short on a phone', () => {
    expect(todayKicker(TODAY, 'long')).toBe('TODAY · WEDNESDAY, SEP 30');
    expect(todayKicker(TODAY, 'short')).toBe('TODAY · WED, SEP 30');
  });
});

describe('todayView', () => {
  it('is a training day when the active plan has one on this weekday', () => {
    const view = todayView(PLAN, TODAY);
    expect(view.kind).toBe('train');
    if (view.kind !== 'train') return;
    expect(view.day.title).toBe('Full body B');
    expect(view.dayNumber).toBe(2);
    expect(view.lead).toBe('Legs, back and shoulders — day 2 of your active plan,');
    expect(view.planName).toBe('Beginner Muscle');
    expect(view.chips).toEqual(['5 exercises', 'About 45 min', 'Evening, within opening hours']);
    expect(view.phoneLine).toBe('5 exercises · about 45 min · Beginner Muscle');
    expect(view.startHref).toBe('/portal/workouts/plan-1#day-3');
    expect(view.adjustHref).toBe('/portal/workouts/plan-1?adjust=3#day-3');
  });

  it('is a rest day otherwise, naming the next session', () => {
    const view = todayView(PLAN, '2026-10-01' as CivilDate); // Thursday
    expect(view.kind).toBe('rest');
    if (view.kind !== 'rest') return;
    expect(view.title).toBe('Rest day');
    expect(view.lead).toBe('Next session: Saturday — Full body C, from your active plan,');
    expect(view.next?.day.title).toBe('Full body C');
  });

  it('is "none" without an active plan', () => {
    expect(todayView(null, TODAY).kind).toBe('none');
    expect(todayView({ ...PLAN, isActive: false }, TODAY).kind).toBe('none');
  });
});

describe('nextSession', () => {
  it('finds the next planned weekday after today, wrapping past Sunday', () => {
    expect(nextSession(PLAN_BODY, 3)?.day.weekday).toBe(6);
    expect(nextSession(PLAN_BODY, 6)?.day.weekday).toBe(1);
    expect(nextSession(PLAN_BODY, 0)?.day.weekday).toBe(1);
    expect(nextSession(PLAN_BODY, 6)?.label).toBe('Monday');
  });

  it('is null for a plan with no days', () => {
    expect(nextSession({ ...PLAN_BODY, days: [] }, 3)).toBeNull();
  });
});

describe('bookedClassesByWeekday', () => {
  it('maps live BOOKED classes in this gym week to a caption', () => {
    expect(bookedClassesByWeekday([SPIN], TODAY)).toEqual({ 2: 'Spin 6 PM' });
    expect(bookedClassesByWeekday([SPIN], TODAY, 'long')).toEqual({
      2: 'Spin class · 6:00 PM (booked)',
    });
  });

  it('ignores cancelled, waitlisted and other-week bookings', () => {
    const cancelled = {
      ...SPIN,
      status: 'CANCELLED' as const,
      cancelledAt: '2026-09-21T00:00:00Z',
    };
    const waitlisted = { ...SPIN, status: 'WAITLISTED' as const };
    const nextWeek = {
      ...SPIN,
      session: { ...SPIN.session, businessDate: '2026-10-06', startsAt: '2026-10-06T10:00:00Z' },
    };
    expect(bookedClassesByWeekday([cancelled, waitlisted, nextWeek], TODAY)).toEqual({});
  });
});

describe('weekStrip', () => {
  it('ticks the check-in, colours the class, lights today, outlines planned days, dashes rest', () => {
    const cells = weekStrip(PLAN_BODY, CHECKINS, [SPIN], TODAY);
    expect(cells.map((c) => `${c.dow} ${c.date} ${c.kind} ${c.caption}`)).toEqual([
      'MON 28 done Done',
      'TUE 29 class Spin 6 PM',
      'WED 30 today Today',
      'THU 1 rest Rest',
      'FRI 2 rest Rest',
      'SAT 3 train Full body C',
      'SUN 4 rest Rest',
    ]);
    expect(cells.map((c) => c.letter).join('')).toBe('MTWTFSS');
    expect(cells[2]?.civil).toBe('2026-09-30');
  });

  it('never shows a tick or a class from another week', () => {
    const cells = weekStrip(PLAN_BODY, CHECKINS, [SPIN], '2026-10-07' as CivilDate);
    expect(cells.some((c) => c.kind === 'done' || c.kind === 'class')).toBe(false);
  });

  it('still shows the calendar without a plan', () => {
    const cells = weekStrip(null, null, [], TODAY);
    expect(cells.filter((c) => c.kind === 'rest')).toHaveLength(6);
    expect(cells[2]?.kind).toBe('today');
  });
});

describe('weekExplanation and trainingProgress', () => {
  it('explains the tick and the class in one line', () => {
    const cells = weekStrip(PLAN_BODY, CHECKINS, [SPIN], TODAY);
    expect(weekExplanation(cells)).toBe(
      'Monday is ticked from your check-in. Your Tuesday Spin class counts as cardio.',
    );
    expect(trainingProgress(cells, PLAN_BODY)).toEqual({ done: 1, total: 3 });
  });

  it('pluralises, and says nothing when there is nothing to explain', () => {
    const twice = {
      ...CHECKINS,
      days: [...CHECKINS.days, { date: '2026-09-30' as CivilDate, count: 1 }],
    };
    const cells = weekStrip(PLAN_BODY, twice, [], TODAY);
    expect(weekExplanation(cells)).toBe('Monday and Wednesday are ticked from your check-ins.');
    expect(trainingProgress(cells, PLAN_BODY)).toEqual({ done: 2, total: 3 });
    expect(weekExplanation(weekStrip(PLAN_BODY, null, [], TODAY))).toBe(
      'Planned days are outlined in gold; a tick appears when you check in or finish a workout.',
    );
  });
});

describe('weekStrip with finished workouts', () => {
  it('ticks a day with a finished workout, today included', () => {
    const cells = weekStrip(PLAN_BODY, null, [], TODAY, ['2026-09-28', '2026-09-30']);
    expect(cells.map((c) => `${c.dow} ${c.kind} ${c.caption}`).slice(0, 3)).toEqual([
      'MON done Done',
      'TUE rest Rest',
      'WED done Done',
    ]);
    expect(cells[0]?.workedOut).toBe(true);
    expect(cells[0]?.checkedIn).toBe(false);
    expect(trainingProgress(cells, PLAN_BODY)).toEqual({ done: 2, total: 3 });
  });

  it('says which ticks came from a check-in and which from a workout', () => {
    const cells = weekStrip(PLAN_BODY, CHECKINS, [], TODAY, ['2026-09-30']);
    expect(weekExplanation(cells)).toBe(
      'Monday is ticked from your check-in. Wednesday is ticked from your workout.',
    );
    const both = weekStrip(PLAN_BODY, CHECKINS, [], TODAY, ['2026-09-28', '2026-09-30']);
    expect(weekExplanation(both)).toBe('Monday and Wednesday are ticked from your workouts.');
  });

  it("marks the coach's planned days too", () => {
    const planned = { days: [{ weekday: 5, title: 'Full body' }] };
    const cells = weekStrip(planned, null, [], TODAY);
    expect(cells[4]).toMatchObject({ kind: 'train', caption: 'Full body' });
  });
});

describe('todayModel', () => {
  const inactive = HOME.plans.map((p) => ({ ...p, isActive: false }));

  it('is "in progress" while a session is open, whatever the plans say', () => {
    const model = todayModel({ ...HOME, session: SESSION }, TODAY);
    expect(model.kind).toBe('open');
    if (model.kind !== 'open') return;
    expect(model.title).toBe('Full body B');
    expect(model.line).toBe('Beginner Muscle · 5 exercises');
    expect(model.startedLabel).toBe('Started 6:12 PM');
    expect(model.progress).toMatchObject({ complete: 2, total: 5 });
    expect(model.progress.segments).toEqual(['done', 'done', 'current', 'todo', 'todo']);

    const coach = todayModel(
      {
        ...HOME,
        session: { ...SESSION, source: 'COACH_PLAN', coach: { firstName: 'Ana', lastName: 'R' } },
      },
      TODAY,
    );
    expect(coach.kind === 'open' && coach.line).toBe("From Coach Ana's plan · 5 exercises");
  });

  it('is "done" once a workout finished today', () => {
    const model = todayModel({ ...HOME, recent: [SUMMARY, SUMMARY_MONDAY] }, TODAY);
    expect(model).toMatchObject({
      kind: 'done',
      title: 'Full body B',
      line: '46 min · 13 sets · 4,435 kg',
      href: '/portal/workouts/history/sess-1',
    });
  });

  it("starts today's day of the active AI plan", () => {
    const model = todayModel(HOME, TODAY);
    expect(model).toMatchObject({
      kind: 'train',
      source: 'member',
      title: 'Full body B',
      lead: 'Legs, back and shoulders — day 2 of your active plan,',
      planName: 'Beginner Muscle',
      minutes: 45,
      start: { source: 'MEMBER_PLAN', planId: 'plan-1', weekday: 3 },
      planHref: '/portal/workouts/plan-1#day-3',
      adjustHref: '/portal/workouts/plan-1?adjust=3#day-3',
    });
    if (model.kind !== 'train') return;
    expect(model.exercises[0]).toEqual({
      name: 'Leg press',
      muscles: 'Legs · glutes',
      dose: '3 × 12',
      rest: 'Rest 90 s',
      line: '3 × 12 · rest 90 s',
    });
  });

  it("starts today's day of the coach's plan, with no rest the coach never set", () => {
    const model = todayModel({ ...HOME, plans: inactive, coachPlan: COACH_PLAN }, TODAY);
    expect(model).toMatchObject({
      kind: 'train',
      source: 'coach',
      title: 'Upper body',
      lead: 'Day 2 of the plan from',
      planName: 'Coach Ana',
      chips: ['3 exercises'],
      phoneLine: "3 exercises · Coach Ana's plan",
      minutes: null,
      start: { source: 'COACH_PLAN', dayIndex: 1 },
      planHref: '/portal/workouts/coach#coach-day-1',
      adjustHref: null,
    });
    if (model.kind !== 'train') return;
    expect(model.exercises[0]).toEqual({
      name: 'Bench press',
      muscles: null,
      dose: '4 × 6–8',
      rest: null,
      line: '4 × 6–8',
    });
  });

  it("rests on a coach plan's unlabelled weekday, naming the next session", () => {
    const model = todayModel(
      { ...HOME, plans: inactive, coachPlan: COACH_PLAN },
      '2026-10-01' as CivilDate,
    );
    expect(model).toMatchObject({
      kind: 'rest',
      lead: 'Next session: Friday — Full body, from',
      planName: 'Coach Ana',
      nextHref: '/portal/workouts/coach#coach-day-2',
      next: { label: 'Friday', title: 'Full body' },
    });
  });

  it('asks "Which day are you doing?" when the coach named no weekdays', () => {
    const model = todayModel({ ...HOME, plans: [], coachPlan: COACH_PLAN_UNLABELLED }, TODAY);
    expect(model.kind).toBe('pick');
    if (model.kind !== 'pick') return;
    expect(model.planName).toBe("Coach Ana's plan");
    expect(model.lead).toBe(
      "Coach Ana's plan does not name a weekday for its days, so pick the one you are doing.",
    );
    expect(model.days.map((d) => `${d.label} · ${d.title} · ${d.count}`)).toEqual([
      'Day 1 · Lower body · 2 exercises',
      'Day 2 · Upper body · 3 exercises',
      'Day 3 · Full body · 1 exercise',
    ]);
    expect(model.days[2]?.start).toEqual({ source: 'COACH_PLAN', dayIndex: 2 });
  });

  it('is "none" with no plan of either kind', () => {
    expect(todayModel({ ...HOME, plans: inactive }, TODAY)).toEqual({ kind: 'none' });
  });
});

describe('dashboardCard', () => {
  it('describes today for the dashboard', () => {
    expect(dashboardCard(todayModel(HOME, TODAY))).toEqual({
      heading: "Today's AI workout",
      planLabel: 'Beginner Muscle',
      title: 'Full body B',
      meta: '5 exercises · about 45 min',
      href: '/portal/workouts/plan-1#day-3',
      cta: 'Start',
    });
    expect(dashboardCard(todayModel(HOME, '2026-10-01' as CivilDate))).toEqual({
      heading: "Today's AI workout",
      planLabel: 'Beginner Muscle',
      title: 'Rest day',
      meta: 'Next Saturday: Full body C',
      href: '/portal/workouts/plan-1#day-6',
      cta: 'Open plan',
    });
    expect(dashboardCard(todayModel({ ...HOME, plans: [] }, TODAY))).toBeNull();
  });

  it("falls back to the coach's plan", () => {
    const plans = HOME.plans.map((p) => ({ ...p, isActive: false }));
    expect(dashboardCard(todayModel({ ...HOME, plans, coachPlan: COACH_PLAN }, TODAY))).toEqual({
      heading: "Today's workout",
      planLabel: "Coach Ana's plan",
      title: 'Upper body',
      meta: '3 exercises',
      href: '/portal/workouts/coach#coach-day-1',
      cta: 'Start',
    });
    expect(
      dashboardCard(todayModel({ ...HOME, plans: [], coachPlan: COACH_PLAN_UNLABELLED }, TODAY)),
    ).toEqual({
      heading: "Today's workout",
      planLabel: "Coach Ana's plan",
      title: 'Pick a day',
      meta: '3 days to choose from',
      href: '/portal/workouts',
      cta: 'Choose',
    });
  });

  it('continues an open workout, and shows a finished one', () => {
    expect(dashboardCard(todayModel({ ...HOME, session: SESSION }, TODAY))).toEqual({
      heading: 'Workout in progress',
      planLabel: 'Beginner Muscle',
      title: 'Full body B',
      meta: '2 of 5 exercises done',
      href: '/portal/workouts/session',
      cta: 'Continue',
    });
    expect(dashboardCard(todayModel({ ...HOME, recent: [SUMMARY] }, TODAY))).toEqual({
      heading: 'Done today',
      planLabel: 'Beginner Muscle',
      title: 'Full body B',
      meta: '46 min · 13 sets · 4,435 kg',
      href: '/portal/workouts/history/sess-1',
      cta: 'View summary',
    });
  });
});
