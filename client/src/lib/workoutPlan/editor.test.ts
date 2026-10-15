import { describe, expect, it } from 'vitest';
import type { WorkoutPlanBody } from '@got/shared';
import {
  DAY_OPTIONS,
  OTHER_DAY,
  addDay,
  addExercise,
  dayChoice,
  draftFromPlan,
  labelForChoice,
  repeatedWeekdays,
  draftToBody,
  emptyDraft,
  humanizeError,
  planTotals,
  removeDay,
  removeExercise,
  updateDay,
  updateExercise,
  validateDraft,
  type PlanDraft,
} from './editor';

/** Deterministic keys, so drafts compare with toEqual. */
const keys = (): (() => string) => {
  let n = 0;
  return () => `k${(n += 1)}`;
};

const PLAN: WorkoutPlanBody = {
  summary: 'Two days to start.',
  days: [
    {
      day: 'Monday',
      focus: 'Lower body',
      exercises: [
        { name: 'Goblet squat', sets: 3, reps: '8-10' },
        { name: 'Plank', sets: 3, reps: '30s', notes: 'Brace hard' },
      ],
    },
  ],
};

describe('draftFromPlan / draftToBody', () => {
  it('round-trips a saved plan through the editor unchanged', () => {
    const draft = draftFromPlan(PLAN, keys());
    expect(draft.days[0].exercises[0]).toEqual({
      key: 'k2',
      name: 'Goblet squat',
      sets: '3',
      reps: '8-10',
      notes: '',
    });
    expect(draftToBody(draft)).toEqual(PLAN);
    expect(validateDraft(draft)).toEqual({ ok: true, plan: PLAN });
  });

  it('sends sets the coach typed as a number, and anything else as not-a-number', () => {
    const draft = draftFromPlan(PLAN, keys());
    const typed = updateExercise(draft, draft.days[0].key, draft.days[0].exercises[0].key, {
      sets: ' 4 ',
    });
    expect(draftToBody(typed)).toMatchObject({
      days: [{ exercises: [{ sets: 4 }, { sets: 3 }] }],
    });

    const junk = updateExercise(draft, draft.days[0].key, draft.days[0].exercises[0].key, {
      sets: 'three',
    });
    const result = validateDraft(junk);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toContain(
      'days[0].exercises[0].sets must be a whole number from 1 to 10.',
    );
  });
});

describe('editing', () => {
  it('starts an empty plan with one day and one exercise to fill in', () => {
    const draft = emptyDraft(keys());
    expect(draft).toEqual({
      summary: '',
      days: [
        {
          key: 'k1',
          day: 'Day 1',
          focus: '',
          exercises: [{ key: 'k2', name: '', sets: '3', reps: '10', notes: '' }],
        },
      ],
    });
    expect(validateDraft(draft).ok).toBe(false);
  });

  it('adds, edits and removes days and exercises by key', () => {
    const make = keys();
    let draft: PlanDraft = draftFromPlan(PLAN, make);
    draft = addDay(draft, make);
    const second = draft.days[1];
    expect(second).toMatchObject({ day: 'Day 2', exercises: [{ name: '' }] });

    draft = updateDay(draft, second.key, { focus: 'Upper body' });
    draft = updateExercise(draft, second.key, second.exercises[0].key, { name: 'Row' });
    draft = addExercise(draft, second.key, make);
    expect(draft.days[1].exercises.map((e) => e.name)).toEqual(['Row', '']);

    draft = removeExercise(draft, second.key, draft.days[1].exercises[1].key);
    expect(draft.days[1].exercises.map((e) => e.name)).toEqual(['Row']);

    draft = removeDay(draft, draft.days[0].key);
    expect(draft.days.map((d) => d.focus)).toEqual(['Upper body']);
    // The original plan was never mutated.
    expect(PLAN.days).toHaveLength(1);
  });

  it('never removes the last day or the last exercise of a day — a plan needs one', () => {
    const draft = emptyDraft(keys());
    const day = draft.days[0];
    expect(removeDay(draft, day.key)).toBe(draft);
    expect(removeExercise(draft, day.key, day.exercises[0].key)).toBe(draft);
  });

  it('stops adding at the limits the server enforces', () => {
    const make = keys();
    let draft = emptyDraft(make);
    for (let i = 0; i < 10; i += 1) draft = addDay(draft, make);
    expect(draft.days).toHaveLength(7);
    const day = draft.days[0];
    for (let i = 0; i < 20; i += 1) draft = addExercise(draft, day.key, make);
    expect(draft.days[0].exercises).toHaveLength(12);
  });
});

describe('humanizeError', () => {
  it("rewrites the schema's paths the way a coach counts: from one", () => {
    expect(humanizeError('days[0].exercises[1].sets must be a whole number from 1 to 10.')).toBe(
      'Day 1, exercise 2: sets must be a whole number from 1 to 10.',
    );
    expect(humanizeError('days[2].focus must be 1-80 characters.')).toBe(
      'Day 3: focus must be 1-80 characters.',
    );
    expect(humanizeError('summary must be 1-600 characters.')).toBe(
      'Summary must be 1-600 characters.',
    );
  });
});

describe('the day label picker', () => {
  it('offers Monday to Sunday, then Other…', () => {
    expect(DAY_OPTIONS.map((o) => o.label)).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
      'Other…',
    ]);
    expect(DAY_OPTIONS[0]).toEqual({ value: '1', label: 'Monday' });
    expect(DAY_OPTIONS[7]).toEqual({ value: OTHER_DAY, label: 'Other…' });
  });

  it('selects the weekday a label already names — in English or Filipino, full or short', () => {
    expect(dayChoice('Monday')).toBe('1');
    expect(dayChoice(' wed. ')).toBe('3');
    expect(dayChoice('Lunes')).toBe('1');
    expect(dayChoice('Sunday')).toBe('0');
  });

  it('shows anything else as Other, with its text', () => {
    expect(dayChoice('Day 1')).toBe(OTHER_DAY);
    expect(dayChoice('Monday or Tuesday')).toBe(OTHER_DAY);
    expect(dayChoice('')).toBe(OTHER_DAY);
  });

  it('writes the weekday name when one is picked', () => {
    expect(labelForChoice('5', 'Day 1')).toBe('Friday');
    expect(labelForChoice('0', 'Lunes')).toBe('Sunday');
  });

  it('keeps a free-text label on Other, and empties a weekday so the text box starts blank', () => {
    expect(labelForChoice(OTHER_DAY, 'Upper A')).toBe('Upper A');
    expect(labelForChoice(OTHER_DAY, 'Monday')).toBe('');
  });

  it('round-trips through the draft: picking Wednesday saves "Wednesday"', () => {
    const draft = draftFromPlan(PLAN, keys());
    const day = draft.days[0]!;
    const next = updateDay(draft, day.key, { day: labelForChoice('3', day.day) });
    expect(draftToBody(next)).toMatchObject({ days: [{ day: 'Wednesday' }] });
    expect(validateDraft(next).ok).toBe(true);
  });

  it('names a weekday two days share — Today only uses the first', () => {
    const make = keys();
    let draft = addDay(draftFromPlan(PLAN, make), make);
    draft = updateDay(draft, draft.days[1]!.key, { day: 'mon' });
    expect(repeatedWeekdays(draft)).toEqual(['Monday']);
    expect(repeatedWeekdays(draftFromPlan(PLAN, keys()))).toEqual([]);
  });
});

describe('planTotals', () => {
  it('counts days and exercises', () => {
    expect(planTotals(PLAN)).toEqual({ days: 1, exercises: 2 });
  });
});
