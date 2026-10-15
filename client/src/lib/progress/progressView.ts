import type {
  Goal,
  GoalBody,
  GoalPatch,
  Measurement,
  MeasurementBody,
  MeasurementPatch,
  Provenance,
  ProgressSummary,
} from './types';

/**
 * Everything the progress screens DECIDE, as pure functions.
 *
 * The member page and the coach drill-down stay thin: they fetch, hold form
 * state and render. What a label says, whether a form may be submitted, and
 * which integers go on the wire are all here, because this is what can be
 * tested without rendering React — the client deliberately has no
 * @testing-library.
 *
 * The wire is integers (grams, millimetres, per mille, hundredths); forms are
 * the decimal strings a person types. The two conversions live side by side
 * below so they cannot drift.
 */

// ── Provenance and page mode ───────────────────────────────────────────────

/**
 * "Recorded by Coach Ana", "Recorded by Coach Ana · updated by Coach Ben", or
 * "Self-recorded" — and NULL when the server did not send provenance at all
 * (an API from before coaches recorded), because guessing "Self-recorded"
 * there would state as fact something the data does not say.
 */
export function provenanceLabel(entry: Provenance): string | null {
  if (entry.recordedBy === undefined) return null;
  if (entry.recordedBy === null) return 'Self-recorded';

  const recorded = `Recorded by Coach ${entry.recordedBy.firstName}`;
  return entry.updatedBy ? `${recorded} · updated by Coach ${entry.updatedBy.firstName}` : recorded;
}

export type PageMode = 'coached' | 'uncoached' | 'unknown';

/**
 * Which member page to show.
 *
 * `unknown` is an older API that sends no `coach` field. It gets neither the
 * coaching banner nor the explainer — telling a coached member "progress
 * comes with coaching, ask at the desk" would be wrong, and so would naming a
 * coach the server never mentioned.
 */
export function pageMode(summary: Pick<ProgressSummary, 'coach'>): PageMode {
  if (summary.coach === undefined) return 'unknown';
  return summary.coach === null ? 'uncoached' : 'coached';
}

// ── Formatters ─────────────────────────────────────────────────────────────

/** 72400 → "72.4". Kilograms, one decimal: what a gym scale shows. */
export function formatKg(grams: number): string {
  return (grams / 1000).toFixed(1);
}

/** Signed, because the sign IS the news: "+0.6", "-1.2". */
export function formatChangeKg(grams: number): string {
  return `${grams > 0 ? '+' : ''}${formatKg(grams)}`;
}

/** 10050 → "100.5", 10000 → "100". Goals are free-form, so no unit here. */
export function formatHundredths(value: number): string {
  return (value / 100).toFixed(1).replace(/\.0$/, '');
}

/** 24312 → "24.3". */
export function formatBmi(thousandths: number): string {
  return (thousandths / 1000).toFixed(1);
}

/** 1750 → "175", 1755 → "175.5". */
export function formatHeightCm(mm: number): string {
  return (mm / 10).toFixed(1).replace(/\.0$/, '');
}

/** 185 → "18.5". */
export function formatBodyFat(permille: number): string {
  return (permille / 10).toFixed(1);
}

/** One line per day: "72.4 kg · 175 cm · 18.5% body fat", skipping what was not measured. */
export function measurementSummary(entry: Measurement): string {
  const parts: string[] = [];
  if (entry.weightGrams !== null) parts.push(`${formatKg(entry.weightGrams)} kg`);
  if (entry.heightMm !== null) parts.push(`${formatHeightCm(entry.heightMm)} cm`);
  if (entry.bodyFatPermille !== null) {
    parts.push(`${formatBodyFat(entry.bodyFatPermille)}% body fat`);
  }
  return parts.join(' · ');
}

/**
 * The server sends oldest first, for the chart. A history list reads newest
 * first. Copied, never sorted in place — the chart shares the array.
 */
export function historyLatestFirst(entries: readonly Measurement[]): Measurement[] {
  return [...entries].sort((a, b) => (a.businessDate < b.businessDate ? 1 : -1));
}

// ── Measurement form ───────────────────────────────────────────────────────

/** What a person types. Strings, because an empty box is not zero. */
export interface MeasurementForm {
  /** `yyyy-mm-dd`, from a date input. */
  date: string;
  /** Kilograms. */
  weight: string;
  /** Centimetres. */
  height: string;
  /** Percent. */
  bodyFat: string;
  notes: string;
}

export function emptyMeasurementForm(today: string): MeasurementForm {
  return { date: today, weight: '', height: '', bodyFat: '', notes: '' };
}

/**
 * The three readings, their conversion to wire integers, and the bounds from
 * `RecordMeasurementDto` — which match the `BodyMeasurement_*_sane` CHECKs.
 * Checked on the INTEGER, exactly as the server checks it, so a value the form
 * accepts is never one the pipe rejects.
 */
const READINGS = [
  {
    field: 'weightGrams',
    input: 'weight',
    label: 'Weight',
    scale: 1000,
    min: 20_000,
    max: 400_000,
    range: 'between 20 and 400 kg',
  },
  {
    field: 'heightMm',
    input: 'height',
    label: 'Height',
    scale: 10,
    min: 500,
    max: 2500,
    range: 'between 50 and 250 cm',
  },
  {
    field: 'bodyFatPermille',
    input: 'bodyFat',
    label: 'Body fat',
    scale: 10,
    min: 10,
    max: 700,
    range: 'between 1 and 70%',
  },
] as const;

type ReadingField = (typeof READINGS)[number]['field'];

const NOTES_MAX = 500;
const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** '' → null (not entered); unreadable → NaN; otherwise the scaled integer. */
function scaled(raw: string, scale: number): number | null {
  const text = raw.trim();
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? Math.round(value * scale) : Number.NaN;
}

/** The first reading that is unreadable or out of range, as a sentence. */
function readingProblem(form: MeasurementForm): string | null {
  for (const reading of READINGS) {
    const value = scaled(form[reading.input], reading.scale);
    if (value === null) continue;
    if (Number.isNaN(value)) return `${reading.label} must be a number.`;
    if (value < reading.min || value > reading.max) {
      return `${reading.label} must be ${reading.range}.`;
    }
  }
  if (form.notes.trim().length > NOTES_MAX)
    return `Notes must be ${NOTES_MAX} characters or fewer.`;
  return null;
}

/**
 * Why this reading cannot be saved yet, or null.
 *
 * `today` is the gym's civil day. A reading cannot be dated after it: it would
 * become the "current weight" on every screen until that day came.
 */
export function measurementProblem(form: MeasurementForm, today: string): string | null {
  if (!CIVIL_DATE.test(form.date)) return 'Pick a date.';
  if (form.date > today) return 'The date cannot be in the future.';
  if (READINGS.every((reading) => form[reading.input].trim() === '')) {
    return 'Enter at least one of weight, height or body fat.';
  }
  return readingProblem(form);
}

/** The POST body. Only what was entered: an empty box is "not given", never "clear". */
export function measurementBody(form: MeasurementForm): MeasurementBody {
  const body: MeasurementBody = { businessDate: form.date };
  for (const reading of READINGS) {
    const value = scaled(form[reading.input], reading.scale);
    if (value !== null && !Number.isNaN(value)) body[reading.field] = value;
  }
  const notes = form.notes.trim();
  if (notes !== '') body.notes = notes;
  return body;
}

/** A recorded day, back in the edit form's terms. */
export function measurementFormFrom(entry: Measurement): MeasurementForm {
  const text = (value: number | null, format: (n: number) => string): string =>
    value === null ? '' : format(value);
  return {
    date: entry.businessDate,
    weight: text(entry.weightGrams, formatKg),
    height: text(entry.heightMm, formatHeightCm),
    bodyFat: text(entry.bodyFatPermille, formatBodyFat),
    notes: entry.notes ?? '',
  };
}

/**
 * The PATCH for an edited day: CHANGED fields only, with an emptied box sent
 * as an explicit null (which clears it). Clearing every reading is a problem,
 * not a patch — a day with no reading is a delete, and the server would say
 * MEASUREMENT_EMPTY anyway.
 */
export function measurementPatch(
  original: Measurement,
  form: MeasurementForm,
): { patch: MeasurementPatch; problem: string | null } {
  const problem = readingProblem(form);
  if (problem !== null) return { patch: {}, problem };

  const patch: MeasurementPatch = {};
  const after: Record<ReadingField, number | null> = {
    weightGrams: original.weightGrams,
    heightMm: original.heightMm,
    bodyFatPermille: original.bodyFatPermille,
  };

  for (const reading of READINGS) {
    const value = scaled(form[reading.input], reading.scale);
    after[reading.field] = value;
    if (value !== original[reading.field]) patch[reading.field] = value;
  }

  const notes = form.notes.trim() === '' ? null : form.notes.trim();
  if (notes !== original.notes) patch.notes = notes;

  if (READINGS.every((reading) => after[reading.field] === null)) {
    return { patch: {}, problem: 'A day needs at least one reading. Delete the entry instead.' };
  }
  return { patch, problem: null };
}

// ── Goals ──────────────────────────────────────────────────────────────────

export interface GoalForm {
  name: string;
  unit: string;
  start: string;
  target: string;
}

/**
 * The overflow guard from `goal.dto.ts`: the columns are INTEGER, and a value
 * past this is a 400 from the pipe rather than anything a goal means.
 */
const GOAL_VALUE_LIMIT = 100_000_000;

function hundredths(raw: string): number | null {
  return scaled(raw, 100);
}

export function goalProblem(form: GoalForm): string | null {
  const name = form.name.trim();
  const unit = form.unit.trim();
  if (name === '') return 'Name the goal.';
  if (name.length > 80) return 'Keep the name to 80 characters.';
  if (unit === '') return 'Give a unit, such as kg, reps or km.';
  if (unit.length > 12) return 'Keep the unit to 12 characters.';

  const start = hundredths(form.start);
  const target = hundredths(form.target);
  if (start === null) return 'Enter where the member is starting.';
  if (Number.isNaN(start)) return 'Enter the starting value as a number.';
  if (target === null) return 'Enter the target.';
  if (Number.isNaN(target)) return 'Enter the target as a number.';
  if (Math.abs(start) > GOAL_VALUE_LIMIT || Math.abs(target) > GOAL_VALUE_LIMIT) {
    return 'That number is too large.';
  }
  // Compared AFTER rounding to hundredths, as the server compares them: a ring
  // with no span divides by zero, and the database refuses the row.
  if (start === target) return 'The target has to differ from the starting value.';
  return null;
}

/** Only meaningful once `goalProblem` is null. */
export function goalBody(form: GoalForm): GoalBody {
  return {
    name: form.name.trim(),
    unit: form.unit.trim(),
    startHundredths: hundredths(form.start) ?? 0,
    targetHundredths: hundredths(form.target) ?? 0,
  };
}

/**
 * The PATCH for a goal's "where are they now" box, or null when there is
 * nothing to send: an empty, unreadable, oversized or unchanged value.
 */
export function currentValuePatch(goal: Goal, input: string): GoalPatch | null {
  const next = hundredths(input);
  if (next === null || Number.isNaN(next)) return null;
  if (Math.abs(next) > GOAL_VALUE_LIMIT) return null;
  if (next === goal.currentHundredths) return null;
  return { currentHundredths: next };
}
