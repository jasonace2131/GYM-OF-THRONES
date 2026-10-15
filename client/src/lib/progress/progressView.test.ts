import { describe, expect, it } from 'vitest';
import {
  currentValuePatch,
  emptyMeasurementForm,
  formatBmi,
  formatBodyFat,
  formatChangeKg,
  formatHeightCm,
  formatHundredths,
  formatKg,
  goalBody,
  goalProblem,
  historyLatestFirst,
  measurementBody,
  measurementFormFrom,
  measurementPatch,
  measurementProblem,
  measurementSummary,
  pageMode,
  provenanceLabel,
  type GoalForm,
  type MeasurementForm,
} from './progressView';
import type { Goal, Measurement } from './types';

const TODAY = '2026-09-24';

function measurement(over: Partial<Measurement> = {}): Measurement {
  return {
    id: 'm1',
    businessDate: '2026-09-20',
    weightGrams: 72_400,
    heightMm: null,
    bodyFatPermille: null,
    notes: null,
    recordedBy: { firstName: 'Ana' },
    updatedBy: null,
    ...over,
  };
}

function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: 'g1',
    name: 'Bench',
    unit: 'kg',
    startHundredths: 6000,
    currentHundredths: 8000,
    targetHundredths: 10_000,
    percent: 50,
    achievedAt: null,
    recordedBy: { firstName: 'Ana' },
    updatedBy: null,
    ...over,
  };
}

function form(over: Partial<MeasurementForm> = {}): MeasurementForm {
  return { ...emptyMeasurementForm(TODAY), ...over };
}

describe('provenanceLabel', () => {
  it('names the recording coach', () => {
    expect(provenanceLabel(measurement())).toBe('Recorded by Coach Ana');
  });

  it('names a second coach who corrected it', () => {
    expect(provenanceLabel(measurement({ updatedBy: { firstName: 'Ben' } }))).toBe(
      'Recorded by Coach Ana · updated by Coach Ben',
    );
  });

  /** NULL is the only spelling of "the member entered this themselves". */
  it('labels a row with no recorder as self-recorded', () => {
    expect(provenanceLabel(measurement({ recordedBy: null }))).toBe('Self-recorded');
  });

  /**
   * An API from before coaches recorded sends no `recordedBy` at all. Calling
   * that "Self-recorded" would be a guess dressed as a fact — say nothing.
   */
  it('says nothing when the server did not send provenance', () => {
    const old = measurement();
    delete old.recordedBy;
    delete old.updatedBy;
    expect(provenanceLabel(old)).toBeNull();
  });

  it('works on goals the same way', () => {
    expect(provenanceLabel(goal())).toBe('Recorded by Coach Ana');
    expect(provenanceLabel(goal({ recordedBy: null }))).toBe('Self-recorded');
  });
});

describe('pageMode', () => {
  it('is coached with a coach, uncoached with null, unknown when the field is absent', () => {
    expect(pageMode({ coach: { firstName: 'Ana', lastName: 'Reyes' } })).toBe('coached');
    expect(pageMode({ coach: null })).toBe('uncoached');
    expect(pageMode({})).toBe('unknown');
  });
});

describe('formatters', () => {
  it('formats integers from the wire for a person', () => {
    expect(formatKg(72_400)).toBe('72.4');
    expect(formatChangeKg(-1200)).toBe('-1.2');
    expect(formatChangeKg(600)).toBe('+0.6');
    expect(formatHundredths(10_050)).toBe('100.5');
    expect(formatHundredths(10_000)).toBe('100');
    expect(formatBmi(24_312)).toBe('24.3');
    expect(formatHeightCm(1750)).toBe('175');
    expect(formatHeightCm(1755)).toBe('175.5');
    expect(formatBodyFat(185)).toBe('18.5');
  });

  it('summarises a day in one line, skipping what was not measured', () => {
    expect(measurementSummary(measurement())).toBe('72.4 kg');
    expect(measurementSummary(measurement({ heightMm: 1750, bodyFatPermille: 185 }))).toBe(
      '72.4 kg · 175 cm · 18.5% body fat',
    );
    expect(measurementSummary(measurement({ weightGrams: null, heightMm: 1750 }))).toBe('175 cm');
  });

  it('lists history latest first without mutating the server order', () => {
    const rows = [
      measurement({ id: 'a', businessDate: '2026-09-01' }),
      measurement({ id: 'b', businessDate: '2026-09-20' }),
    ];
    expect(historyLatestFirst(rows).map((m) => m.id)).toEqual(['b', 'a']);
    expect(rows.map((m) => m.id)).toEqual(['a', 'b']);
  });
});

describe('measurementBody / measurementProblem', () => {
  it('defaults the date to today', () => {
    expect(emptyMeasurementForm(TODAY).date).toBe(TODAY);
  });

  it('converts to integers and leaves out what was not entered', () => {
    expect(measurementBody(form({ weight: '72.4' }))).toEqual({
      businessDate: TODAY,
      weightGrams: 72_400,
    });
    expect(
      measurementBody(form({ height: '175.5', bodyFat: '18.5', notes: '  after leg day ' })),
    ).toEqual({
      businessDate: TODAY,
      heightMm: 1755,
      bodyFatPermille: 185,
      notes: 'after leg day',
    });
  });

  it('asks for at least one reading — notes alone are not a measurement', () => {
    expect(measurementProblem(form({ notes: 'felt strong' }), TODAY)).toBe(
      'Enter at least one of weight, height or body fat.',
    );
    expect(measurementProblem(form({ weight: '72.4' }), TODAY)).toBeNull();
  });

  /** Bounds copied from RecordMeasurementDto, so the pipe never has to say it. */
  it('names the field that is out of range', () => {
    expect(measurementProblem(form({ weight: '7.24' }), TODAY)).toBe(
      'Weight must be between 20 and 400 kg.',
    );
    expect(measurementProblem(form({ weight: 'heavy' }), TODAY)).toBe('Weight must be a number.');
    expect(measurementProblem(form({ height: '17.5' }), TODAY)).toBe(
      'Height must be between 50 and 250 cm.',
    );
    expect(measurementProblem(form({ bodyFat: '85' }), TODAY)).toBe(
      'Body fat must be between 1 and 70%.',
    );
    expect(measurementProblem(form({ weight: '20' }), TODAY)).toBeNull();
    expect(measurementProblem(form({ weight: '400' }), TODAY)).toBeNull();
  });

  it('refuses a future date and a missing one', () => {
    expect(measurementProblem(form({ weight: '70', date: '2026-09-25' }), TODAY)).toBe(
      'The date cannot be in the future.',
    );
    expect(measurementProblem(form({ weight: '70', date: '' }), TODAY)).toBe('Pick a date.');
    expect(measurementProblem(form({ weight: '70', date: '2026-01-02' }), TODAY)).toBeNull();
  });

  it('caps notes at the server limit', () => {
    expect(measurementProblem(form({ weight: '70', notes: 'x'.repeat(501) }), TODAY)).toBe(
      'Notes must be 500 characters or fewer.',
    );
  });
});

describe('measurementPatch', () => {
  it('round-trips a row into the edit form', () => {
    expect(measurementFormFrom(measurement({ heightMm: 1755, notes: 'hi' }))).toEqual({
      date: '2026-09-20',
      weight: '72.4',
      height: '175.5',
      bodyFat: '',
      notes: 'hi',
    });
  });

  it('sends only what changed', () => {
    const original = measurement({ heightMm: 1750 });
    const edited = { ...measurementFormFrom(original), weight: '72.1' };
    expect(measurementPatch(original, edited)).toEqual({
      patch: { weightGrams: 72_100 },
      problem: null,
    });
  });

  it('sends nothing when nothing changed', () => {
    const original = measurement();
    expect(measurementPatch(original, measurementFormFrom(original))).toEqual({
      patch: {},
      problem: null,
    });
  });

  it('clears a field with an explicit null', () => {
    const original = measurement({ heightMm: 1750, notes: 'old' });
    const edited = { ...measurementFormFrom(original), height: '', notes: '' };
    expect(measurementPatch(original, edited).patch).toEqual({ heightMm: null, notes: null });
  });

  it('refuses to clear every reading — that is a delete, not an edit', () => {
    const original = measurement();
    const edited = { ...measurementFormFrom(original), weight: '' };
    expect(measurementPatch(original, edited).problem).toBe(
      'A day needs at least one reading. Delete the entry instead.',
    );
  });

  it('reports an out-of-range value as a problem', () => {
    const original = measurement();
    const edited = { ...measurementFormFrom(original), weight: '4000' };
    expect(measurementPatch(original, edited).problem).toBe(
      'Weight must be between 20 and 400 kg.',
    );
  });
});

describe('goalBody / goalProblem', () => {
  const goalForm = (over: Partial<GoalForm> = {}): GoalForm => ({
    name: 'Bench',
    unit: 'kg',
    start: '60',
    target: '100',
    ...over,
  });

  it('converts to hundredths and trims the words', () => {
    expect(goalBody(goalForm({ name: '  Bench  ', start: '60.5' }))).toEqual({
      name: 'Bench',
      unit: 'kg',
      startHundredths: 6050,
      targetHundredths: 10_000,
    });
  });

  /** The database forbids target === start: a ring with no span divides by zero. */
  it('refuses a target equal to the start', () => {
    expect(goalProblem(goalForm({ target: '60' }))).toBe(
      'The target has to differ from the starting value.',
    );
    expect(goalProblem(goalForm({ start: '60.001', target: '60' }))).toBe(
      'The target has to differ from the starting value.',
    );
  });

  it('asks for every part of the goal', () => {
    expect(goalProblem(goalForm({ name: '  ' }))).toBe('Name the goal.');
    expect(goalProblem(goalForm({ unit: '' }))).toBe('Give a unit, such as kg, reps or km.');
    expect(goalProblem(goalForm({ start: '' }))).toBe('Enter where the member is starting.');
    expect(goalProblem(goalForm({ target: 'lots' }))).toBe('Enter the target as a number.');
    expect(goalProblem(goalForm({ name: 'x'.repeat(81) }))).toBe('Keep the name to 80 characters.');
    expect(goalProblem(goalForm())).toBeNull();
  });
});

describe('currentValuePatch', () => {
  it('patches a changed value in hundredths', () => {
    expect(currentValuePatch(goal(), '85.5')).toEqual({ currentHundredths: 8550 });
  });

  it('sends nothing for an unchanged, empty or unreadable value', () => {
    expect(currentValuePatch(goal(), '80')).toBeNull();
    expect(currentValuePatch(goal(), '')).toBeNull();
    expect(currentValuePatch(goal(), 'abc')).toBeNull();
    expect(currentValuePatch(goal(), '99999999999')).toBeNull();
  });
});
