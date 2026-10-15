import { describe, expect, it } from 'vitest';
import type { MemberPlanBody, MemberPlanDay } from '@got/shared';
import { applyAdjust, applySwap, beginEdit, commitEdit, freshHistory, undoEdit } from './planEdits';

const day = (weekday: number, title: string): MemberPlanDay => ({
  weekday,
  title,
  focus: 'Whole body',
  minutes: 45,
  warmUp: '5 min bike',
  coolDown: '3 min walk',
  exercises: [
    { name: 'Goblet squat', muscles: 'Legs · glutes', sets: 3, reps: '10-12', restSeconds: 90 },
    { name: 'Plank', muscles: 'Core', sets: 3, reps: '30 s', restSeconds: 45 },
  ],
});

const PLAN: MemberPlanBody = {
  summary: 'Three full-body days.',
  days: [day(1, 'Full body A'), day(3, 'Full body B')],
  guidance: [
    { title: 'Sleep', body: '7–9 hours.' },
    { title: 'Water', body: 'Drink.' },
  ],
};

describe('applySwap', () => {
  it('replaces one exercise, drops the "why", and leaves the input untouched', () => {
    const next = applySwap(PLAN, 3, 1, {
      name: 'Dead bug',
      muscles: 'Core',
      sets: 3,
      reps: '8 each',
      restSeconds: 45,
      why: 'Easier on the wrists.',
    });
    expect(next.days[1]?.exercises[1]).toEqual({
      name: 'Dead bug',
      muscles: 'Core',
      sets: 3,
      reps: '8 each',
      restSeconds: 45,
    });
    expect(next.days[0]).toBe(PLAN.days[0]);
    expect(PLAN.days[1]?.exercises[1]?.name).toBe('Plank');
    expect(next).not.toBe(PLAN);
  });

  it('keeps the exercise notes when the alternative has them', () => {
    const next = applySwap(PLAN, 1, 0, {
      name: 'Leg press',
      muscles: 'Legs',
      sets: 3,
      reps: '12',
      restSeconds: 90,
      notes: 'Do not lock out.',
      why: 'Guided.',
    });
    expect(next.days[0]?.exercises[0]?.notes).toBe('Do not lock out.');
  });

  it('is a no-op for a weekday or index the plan does not have', () => {
    const alt = { name: 'X', muscles: 'Y', sets: 1, reps: '1', restSeconds: 0, why: 'z' };
    expect(applySwap(PLAN, 5, 0, alt)).toBe(PLAN);
    expect(applySwap(PLAN, 1, 9, alt)).toBe(PLAN);
  });
});

describe('applyAdjust', () => {
  it('replaces the whole day with the same weekday', () => {
    const replacement = { ...day(3, 'Short B'), minutes: 30 };
    const next = applyAdjust(PLAN, replacement);
    expect(next.days[1]).toBe(replacement);
    expect(next.days[0]).toBe(PLAN.days[0]);
    expect(PLAN.days[1]?.title).toBe('Full body B');
  });

  it('is a no-op when the weekday is not in the plan', () => {
    expect(applyAdjust(PLAN, day(0, 'Sunday?'))).toBe(PLAN);
  });
});

describe('edit history', () => {
  const ALT = { name: 'Leg press', muscles: 'Legs', sets: 3, reps: '12', restSeconds: 90, why: '' };

  it('keeps exactly one previous body, until the next action replaces it', () => {
    const h0 = freshHistory(PLAN);
    const a = applyAdjust(PLAN, { ...day(1, 'A2'), minutes: 30 });
    const h1 = beginEdit(h0, a, { kind: 'adjust', weekday: 1, summary: 'shortened' });
    expect(h1.current).toBe(a);
    expect(h1.previous).toBe(PLAN);
    expect(h1.pending?.kind).toBe('adjust');

    const b = applySwap(a, 3, 0, ALT);
    const h2 = beginEdit(h1, b, {
      kind: 'swap',
      weekday: 3,
      index: 0,
      from: 'Goblet squat',
      to: 'Leg press',
    });
    expect(h2.previous).toBe(a);

    const undone = undoEdit(h2);
    expect(undone.current).toBe(a);
    expect(undone.previous).toBeNull();
    expect(undone.pending).toBeNull();
  });

  it('undo with nothing to undo returns the same state', () => {
    const h = freshHistory(PLAN);
    expect(undoEdit(h)).toBe(h);
  });

  it('commit keeps the current body and forgets the previous one', () => {
    const a = applyAdjust(PLAN, { ...day(1, 'A2'), minutes: 30 });
    const h = commitEdit(
      beginEdit(freshHistory(PLAN), a, { kind: 'adjust', weekday: 1, summary: '' }),
    );
    expect(h).toEqual({ current: a, previous: null, pending: null });
  });
});
