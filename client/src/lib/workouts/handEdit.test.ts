import { describe, expect, it } from 'vitest';
import {
  addExercise,
  formToBody,
  planToForm,
  removeExercise,
  updateDay,
  updateExercise,
} from './handEdit';
import { PLAN_BODY } from './fixtures';

describe('planToForm / formToBody', () => {
  it('round-trips a valid plan through string fields', () => {
    const form = planToForm(PLAN_BODY);
    expect(form.days[0]?.exercises[0]).toEqual({
      name: 'Goblet squat',
      muscles: 'Legs · glutes',
      sets: '3',
      reps: '10-12',
      restSeconds: '90',
      notes: 'Hold one dumbbell against your chest.',
    });
    expect(form.days[0]?.minutes).toBe('45');
    const back = formToBody(form);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value).toEqual(PLAN_BODY);
  });

  it('reports every problem by path, through the shared parser', () => {
    let form = planToForm(PLAN_BODY);
    form = updateExercise(form, 0, 1, { name: '', sets: 'three' });
    form = updateDay(form, 1, { title: '' });
    const result = formToBody(form);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'days[0].exercises[1].name must be 1-80 characters.',
        'days[0].exercises[1].sets must be a whole number from 1 to 10.',
        'days[1].title must be 1-40 characters.',
      ]),
    );
  });

  it('treats blank notes as none', () => {
    const form = updateExercise(planToForm(PLAN_BODY), 0, 0, { notes: '   ' });
    const result = formToBody(form);
    expect(result.ok && result.value.days[0]?.exercises[0]?.notes).toBeUndefined();
  });
});

describe('add / remove exercise', () => {
  it('appends a blank row and removes by index, without touching other days', () => {
    const form = planToForm(PLAN_BODY);
    const added = addExercise(form, 1);
    expect(added.days[1]?.exercises).toHaveLength(6);
    expect(added.days[1]?.exercises[5]).toEqual({
      name: '',
      muscles: '',
      sets: '3',
      reps: '10',
      restSeconds: '60',
      notes: '',
    });
    expect(added.days[0]).toBe(form.days[0]);
    const removed = removeExercise(added, 1, 0);
    expect(removed.days[1]?.exercises[0]?.name).toBe('Seated cable row');
    expect(removed.days[1]?.exercises).toHaveLength(5);
  });

  it('refuses to remove the last exercise of a day — the parser needs one', () => {
    let form = planToForm(PLAN_BODY);
    for (let i = 0; i < 4; i += 1) form = removeExercise(form, 0, 0);
    expect(form.days[0]?.exercises).toHaveLength(1);
    expect(removeExercise(form, 0, 0)).toBe(form);
  });
});
