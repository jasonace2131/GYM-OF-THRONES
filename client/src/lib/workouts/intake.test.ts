import { describe, expect, it } from 'vitest';
import {
  STEP_LABELS,
  buildRequest,
  canGoTo,
  healthFlag,
  initialIntake,
  intakeReducer,
  nextLabel,
  prefillIntake,
  restoreIntake,
  serializeIntake,
  stepProblem,
  summaryRows,
  whatAiSees,
  type IntakeState,
} from './intake';
import { INTAKE } from './fixtures';

const filled = (): IntakeState => {
  let s = initialIntake();
  s = intakeReducer(s, { type: 'goal', goal: 'MUSCLE' });
  s = intakeReducer(s, { type: 'experience', experience: 'NEW' });
  s = intakeReducer(s, { type: 'toggleDay', weekday: 1 });
  s = intakeReducer(s, { type: 'toggleDay', weekday: 3 });
  s = intakeReducer(s, { type: 'toggleDay', weekday: 6 });
  return s;
};

describe('initialIntake', () => {
  it('starts on step 1 with nothing chosen, every switch on, no health flags, no consent', () => {
    const s = initialIntake();
    expect(s.step).toBe(1);
    expect(s.goal).toBeNull();
    expect(s.experience).toBeNull();
    expect(s.weekdays).toEqual([]);
    expect(s.sessionMinutes).toBe(45);
    expect(s.timeOfDay).toBe('EVENING');
    expect(s.use).toEqual({ measurements: true, attendance: true, bookings: true });
    expect(s.parq).toEqual([false, false, false, false, false, false, false]);
    expect(s.easyOn).toEqual([]);
    expect(s.consent).toBe(false);
    expect(STEP_LABELS).toEqual(['Goal', 'About you', 'Your week', 'Health check']);
  });
});

describe('stepProblem', () => {
  it('needs a goal, a level, at least one day, and consent', () => {
    const s = initialIntake();
    expect(stepProblem(s, 1)).toBe('Pick a goal to continue.');
    expect(stepProblem(s, 2)).toBe('Pick your experience level.');
    expect(stepProblem(s, 3)).toBe('Pick at least one day.');
    expect(stepProblem(s, 4)).toBe('Tick the consent box first.');
    const f = filled();
    expect(stepProblem(f, 1)).toBeNull();
    expect(stepProblem(f, 2)).toBeNull();
    expect(stepProblem(f, 3)).toBeNull();
    expect(stepProblem(intakeReducer(f, { type: 'consent', value: true }), 4)).toBeNull();
  });

  it('caps the own-words box at 300 characters', () => {
    const s = intakeReducer(filled(), { type: 'goalNotes', value: 'x'.repeat(301) });
    expect(stepProblem(s, 1)).toBe('Keep your own words under 300 characters.');
  });
});

describe('intakeReducer', () => {
  it('moves forward only when the step is complete, and remembers the attempt', () => {
    const blocked = intakeReducer(initialIntake(), { type: 'next' });
    expect(blocked.step).toBe(1);
    expect(blocked.attempted).toBe(true);
    const moved = intakeReducer(filled(), { type: 'next' });
    expect(moved.step).toBe(2);
    expect(moved.attempted).toBe(false);
  });

  it('goes back, and jumps only to a completed step', () => {
    const f = intakeReducer(intakeReducer(filled(), { type: 'next' }), { type: 'next' });
    expect(f.step).toBe(3);
    expect(canGoTo(f, 1)).toBe(true);
    expect(canGoTo(f, 4)).toBe(false);
    expect(intakeReducer(f, { type: 'goto', step: 4 }).step).toBe(3);
    expect(intakeReducer(f, { type: 'goto', step: 1 }).step).toBe(1);
    expect(intakeReducer(f, { type: 'back' }).step).toBe(2);
    expect(intakeReducer(intakeReducer(f, { type: 'goto', step: 1 }), { type: 'back' }).step).toBe(
      1,
    );
  });

  it('keeps weekdays sorted and unique, toggling on and off', () => {
    let s = initialIntake();
    s = intakeReducer(s, { type: 'toggleDay', weekday: 6 });
    s = intakeReducer(s, { type: 'toggleDay', weekday: 1 });
    expect(s.weekdays).toEqual([1, 6]);
    s = intakeReducer(s, { type: 'toggleDay', weekday: 6 });
    expect(s.weekdays).toEqual([1]);
  });

  it('records each PAR-Q answer and toggles easy-on areas', () => {
    let s = initialIntake();
    s = intakeReducer(s, { type: 'parq', index: 5, value: true });
    expect(s.parq[5]).toBe(true);
    expect(healthFlag(s)).toBe(true);
    s = intakeReducer(s, { type: 'parq', index: 5, value: false });
    expect(healthFlag(s)).toBe(false);
    s = intakeReducer(s, { type: 'toggleEasyOn', area: 'KNEES' });
    s = intakeReducer(s, { type: 'toggleEasyOn', area: 'HIPS' });
    s = intakeReducer(s, { type: 'toggleEasyOn', area: 'KNEES' });
    expect(s.easyOn).toEqual(['HIPS']);
  });

  it('replaces the whole state on restore — one render, no flash of the blank form', () => {
    const prefilled = prefillIntake(INTAKE);
    expect(intakeReducer(initialIntake(), { type: 'restore', state: prefilled })).toBe(prefilled);
  });

  it('flips the "use what the gym knows" switches', () => {
    const s = intakeReducer(initialIntake(), { type: 'use', key: 'bookings', value: false });
    expect(s.use).toEqual({ measurements: true, attendance: true, bookings: false });
  });
});

describe('buildRequest — the seven answers never leave the browser', () => {
  it('sends healthFlag and easyOn, never the answers, and validates with the shared parser', () => {
    let s = filled();
    s = intakeReducer(s, { type: 'parq', index: 2, value: true });
    s = intakeReducer(s, { type: 'toggleEasyOn', area: 'KNEES' });
    s = intakeReducer(s, { type: 'goalNotes', value: '  10 push-ups by December  ' });
    s = intakeReducer(s, { type: 'consent', value: true });

    const result = buildRequest(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      goal: 'MUSCLE',
      goalNotes: '10 push-ups by December',
      experience: 'NEW',
      weekdays: [1, 3, 6],
      sessionMinutes: 45,
      timeOfDay: 'EVENING',
      healthFlag: true,
      easyOn: ['KNEES'],
      use: { measurements: true, attendance: true, bookings: true },
      consent: true,
    });
    expect(Object.keys(result.value)).not.toContain('parq');
    expect(JSON.stringify(result.value)).not.toMatch(/parq|answers|question/i);
  });

  it('omits blank own words and refuses without consent', () => {
    const ok = buildRequest(intakeReducer(filled(), { type: 'consent', value: true }));
    expect(ok.ok && 'goalNotes' in ok.value).toBe(false);
    const refused = buildRequest(filled());
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors).toContain('consent must be true.');
  });
});

describe('prefill', () => {
  it('fills from a stored intake with the answers blank and consent unticked', () => {
    const s = prefillIntake(INTAKE);
    expect(s.goal).toBe('MUSCLE');
    expect(s.weekdays).toEqual([1, 3, 6]);
    expect(s.easyOn).toEqual(['KNEES']);
    expect(s.parq.every((a) => a === false)).toBe(true);
    expect(s.consent).toBe(false);
    expect(s.step).toBe(1);
    expect(s.goalNotes).toBe('');
  });

  it('is the blank state without one', () => {
    expect(prefillIntake(null)).toEqual(initialIntake());
  });
});

describe('serialize / restore (this tab only, for "Try again")', () => {
  it('round-trips the whole reducer state, answers included, and rejects junk', () => {
    let s = filled();
    s = intakeReducer(s, { type: 'parq', index: 1, value: true });
    s = intakeReducer(s, { type: 'consent', value: true });
    const restored = restoreIntake(serializeIntake(s));
    expect(restored).toEqual({ ...s, step: 4, attempted: false });
    expect(restoreIntake('not json')).toBeNull();
    expect(restoreIntake(JSON.stringify({ goal: 'MUSCLE' }))).toBeNull();
    expect(restoreIntake(null)).toBeNull();
  });
});

describe('the rail', () => {
  it('summarises the plan so far', () => {
    let s = filled();
    s = intakeReducer(s, { type: 'toggleEasyOn', area: 'KNEES' });
    expect(summaryRows(s)).toEqual([
      ['Goal', 'Build muscle'],
      ['Level', 'New to lifting'],
      ['Days', 'Mon · Wed · Sat'],
      ['Sessions', '45 min · Evening'],
      ['Health', 'No flags'],
      ['Go easy on', 'knees'],
    ]);
    expect(summaryRows(initialIntake()).map((r) => r[1])).toEqual([
      'Not picked yet',
      'Not picked yet',
      'None yet',
      '45 min · Evening',
      'No flags',
      'Nothing',
    ]);
  });

  it('lists what the AI sees, following the switches', () => {
    let s = filled();
    s = intakeReducer(s, { type: 'parq', index: 0, value: true });
    s = intakeReducer(s, { type: 'toggleEasyOn', area: 'KNEES' });
    const facts = {
      measurements: '68 kg · 165 cm',
      attendance: '2.1 visits a week',
      bookings: 'Spin, Tuesday 6 PM',
    };
    expect(whatAiSees(s, facts)).toEqual([
      'Goal, level, days and session length',
      'Weight and height: 68 kg · 165 cm',
      'Attendance: 2.1 visits a week',
      'Booked class: Spin, Tuesday 6 PM',
      'Gym opening hours for each day',
      'Health: keep it gentle',
      'Go easy on: knees',
    ]);
    const off = intakeReducer(s, { type: 'use', key: 'measurements', value: false });
    expect(whatAiSees(off, facts)).not.toContain('Weight and height: 68 kg · 165 cm');
    expect(whatAiSees(s, { measurements: null, attendance: null, bookings: null })).toEqual([
      'Goal, level, days and session length',
      'Gym opening hours for each day',
      'Health: keep it gentle',
      'Go easy on: knees',
    ]);
  });

  it('labels the Next button with the coming step', () => {
    expect(nextLabel(1)).toBe('NEXT: ABOUT YOU');
    expect(nextLabel(3)).toBe('NEXT: HEALTH CHECK');
    expect(nextLabel(4)).toBeNull();
  });
});
