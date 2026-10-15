import { describe, expect, it } from 'vitest';
import {
  aboutMinutes,
  adjustedSummary,
  dayDots,
  dayKicker,
  dose,
  doseLine,
  exerciseCount,
  planChips,
  planMeta,
  restLabel,
  savedLabel,
  shortDate,
  weekRows,
  writtenLine,
} from './planView';
import { DAY_A, INTAKE, PLAN, PLAN_BODY } from './fixtures';

describe('exercise formatting', () => {
  it('renders the dose as "3 × 10–12" with an en dash between numbers', () => {
    expect(dose({ sets: 3, reps: '10-12' })).toBe('3 × 10–12');
    expect(dose({ sets: 3, reps: '30 s' })).toBe('3 × 30 s');
    expect(dose({ sets: 2, reps: '10 each' })).toBe('2 × 10 each');
    expect(dose({ sets: 1, reps: 'AMRAP' })).toBe('1 × AMRAP');
  });

  it('renders rest in seconds under two minutes and in minutes above', () => {
    expect(restLabel(90)).toBe('Rest 90 s');
    expect(restLabel(120)).toBe('Rest 2 min');
    expect(restLabel(150)).toBe('Rest 150 s');
    expect(restLabel(0)).toBe('No rest');
  });

  it('joins them for the phone list — "3 × 12 · rest 90 s"', () => {
    expect(doseLine({ sets: 3, reps: '12', restSeconds: 90 })).toBe('3 × 12 · rest 90 s');
    expect(doseLine({ sets: 3, reps: '12', restSeconds: 0 })).toBe('3 × 12');
  });

  it('counts and times a day', () => {
    expect(aboutMinutes(45)).toBe('About 45 min');
    expect(exerciseCount(5)).toBe('5 exercises');
    expect(exerciseCount(1)).toBe('1 exercise');
    expect(dayKicker(0, 1)).toBe('DAY 1 · MONDAY');
    expect(dayKicker(2, 6)).toBe('DAY 3 · SATURDAY');
  });
});

describe('plan card copy', () => {
  it('summarises a plan as "Build muscle · Beginner · 45 min sessions"', () => {
    expect(planMeta(PLAN)).toBe('Build muscle · Beginner · 45 min sessions');
  });

  it('lights the Monday-first day dots the plan trains on', () => {
    expect(dayDots([1, 3, 6]).map((d) => `${d.letter}${d.on ? '*' : ''}`)).toEqual([
      'M*',
      'T',
      'W*',
      'T',
      'F',
      'S*',
      'S',
    ]);
    expect(dayDots([1, 3, 6]).map((d) => d.name)).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ]);
  });

  it('dates in the gym zone — "Sep 28", and "Saved Sep 28"', () => {
    expect(shortDate('2026-09-28T02:00:00.000Z')).toBe('Sep 28');
    // 23:30Z on the 27th is already the 28th in Manila.
    expect(shortDate('2026-09-27T23:30:00.000Z')).toBe('Sep 28');
    expect(savedLabel(PLAN)).toBe('Saved Sep 28');
  });
});

describe('plan header', () => {
  it('chips: goal, level, days, minutes · time, and a warn chip for easy-on areas', () => {
    expect(planChips(INTAKE)).toEqual([
      { label: 'Build muscle', tone: 'neutral' },
      { label: 'New to lifting', tone: 'neutral' },
      { label: 'Mon · Wed · Sat', tone: 'neutral' },
      { label: '45 min · Evening', tone: 'neutral' },
      { label: 'Go easy on knees', tone: 'warn' },
    ]);
    expect(planChips({ ...INTAKE, easyOn: [] })).toHaveLength(4);
    expect(planChips({ ...INTAKE, healthFlag: true }).at(-1)).toEqual({
      label: 'Kept gentle',
      tone: 'warn',
    });
  });

  it('says who wrote it and when', () => {
    expect(writtenLine(PLAN)).toBe(
      'Written by AI on Sep 25 — check with a coach or the front desk if anything feels off.',
    );
    expect(writtenLine({ ...PLAN, source: 'EDITED' })).toBe(
      'Written by AI on Sep 25, edited by you on Sep 28 — check with a coach or the front desk if anything feels off.',
    );
  });
});

describe('weekRows (the rail)', () => {
  it('lists Monday to Sunday: the session title, the booked class, or Rest', () => {
    const rows = weekRows(PLAN_BODY, { 2: 'Spin class · 6:00 PM (booked)' });
    expect(rows.map((r) => `${r.day}:${r.kind}:${r.what}`)).toEqual([
      'Mon:train:Full body A',
      'Tue:class:Spin class · 6:00 PM (booked)',
      'Wed:train:Full body B',
      'Thu:rest:Rest',
      'Fri:rest:Rest',
      'Sat:train:Full body C',
      'Sun:rest:Rest',
    ]);
  });

  it('lets a training day win over a class on the same weekday', () => {
    const rows = weekRows({ ...PLAN_BODY, days: [DAY_A] }, { 1: 'Yoga' });
    expect(rows[0]?.what).toBe('Full body A');
  });
});

describe('adjustedSummary', () => {
  it('names the request and what the day became', () => {
    expect(adjustedSummary('Only 30 min', { ...DAY_A, title: 'Short A', minutes: 30 })).toBe(
      'Only 30 min — now “Short A”: 5 exercises, about 30 min.',
    );
  });
});
