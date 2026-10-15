import { SchemaType, type ResponseSchema } from '@google/generative-ai';
import { WORKOUT_PLAN_LIMITS, type MyCheckInSummary } from '@got/shared';
import { addDays, type CivilDate } from '../common/time/gym-time';
import type { ProgressSummary } from '../me/progress.presenter';

/**
 * Everything the plan suggester sends to Gemini — pure, so what leaves the
 * building is tested as data.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MODEL GETS FACTS TO PLAN WITH, AND NOTHING THAT IDENTIFIES ANYBODY.
 *
 * `buildPlanContext` takes the member's progress summary and attendance and
 * keeps only numbers and goal labels: no name, no member code, no id, no date
 * of birth — and NO free-text measurement notes, because a note is where
 * "knee sore after the stairs" gets written, which is health data (RA 10173
 * §3(l)) and not the model's business. The coach reads the draft and adds
 * what they know before anything reaches the member.
 *
 * The model is also given NO TOOLS: the server builds the whole context
 * itself, through the same scoped reads the progress screen uses.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface PlanContext {
  goals: {
    goal: string;
    unit: string;
    start: number;
    current: number;
    target: number;
    achieved: boolean;
  }[];
  latest: {
    weightKg: number | null;
    heightCm: number | null;
    bodyFatPercent: number | null;
    bmi: number | null;
  };
  weightChange: { kg: number; overDays: number } | null;
  attendance: { visitsLast30Days: number; averageVisitsPerWeek: number };
}

const ATTENDANCE_WINDOW_DAYS = 30;

/** One decimal, the precision a coach would say out loud. */
const oneDecimal = (value: number): number => Math.round(value * 10) / 10;

/** The newest reading that HAS this value — not simply the newest row. */
function latestOf<T>(rows: readonly T[], pick: (row: T) => number | null): number | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const value = pick(rows[i]);
    if (value !== null) return value;
  }
  return null;
}

export function buildPlanContext(
  progress: ProgressSummary,
  checkIns: MyCheckInSummary,
  today: CivilDate,
): PlanContext {
  // `measurements` is oldest first (ProgressService.summary).
  const heightMm = latestOf(progress.measurements, (m) => m.heightMm);
  const bodyFat = latestOf(progress.measurements, (m) => m.bodyFatPermille);
  const since = addDays(today, -(ATTENDANCE_WINDOW_DAYS - 1));

  return {
    goals: progress.goals.map((goal) => ({
      goal: goal.name,
      unit: goal.unit,
      start: goal.startHundredths / 100,
      current: goal.currentHundredths / 100,
      target: goal.targetHundredths / 100,
      achieved: goal.achievedAt !== null,
    })),
    latest: {
      weightKg:
        progress.latestWeightGrams === null ? null : oneDecimal(progress.latestWeightGrams / 1000),
      heightCm: heightMm === null ? null : oneDecimal(heightMm / 10),
      bodyFatPercent: bodyFat === null ? null : oneDecimal(bodyFat / 10),
      bmi: progress.bmiThousandths === null ? null : oneDecimal(progress.bmiThousandths / 1000),
    },
    weightChange:
      progress.changeGrams === null || progress.changeOverDays === null
        ? null
        : { kg: oneDecimal(progress.changeGrams / 1000), overDays: progress.changeOverDays },
    attendance: {
      visitsLast30Days: checkIns.days
        .filter((day) => day.date >= since && day.date <= today)
        .reduce((sum, day) => sum + day.count, 0),
      averageVisitsPerWeek: checkIns.avgPerWeek,
    },
  };
}

export const WORKOUT_PLAN_SYSTEM_PROMPT = [
  'You help a gym coach draft a weekly workout plan for one of their clients. The coach reviews and edits your draft before the client sees it.',
  'Use only the facts you are given. Never invent injuries, conditions or equipment limits; if something matters and is unknown, keep the plan conservative.',
  'Prefer safe, well-known exercises a commercial gym has. Match the number of training days to how often the client actually comes in (their recent attendance), between 2 and 5 days.',
  // The member's Today finds a day by its label (feat/workout-sessions), so
  // the label must BE a weekday name and name each weekday at most once.
  `Each day's label is the weekday name it is trained on, in English: "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday" or "Sunday" (at most ${WORKOUT_PLAN_LIMITS.dayLabelMax} characters). Use one weekday per training day and never use the same weekday twice; spread the days across the week with rest days between hard sessions.`,
  `Each day also has a focus (at most ${WORKOUT_PLAN_LIMITS.focusMax} characters) and 4 to 8 exercises (never more than ${WORKOUT_PLAN_LIMITS.exercisesMax}).`,
  `Every exercise has a name (at most ${WORKOUT_PLAN_LIMITS.exerciseNameMax} characters), whole-number sets from 1 to ${WORKOUT_PLAN_LIMITS.setsMax}, reps as short text such as "8-10" or "30s" (at most ${WORKOUT_PLAN_LIMITS.repsMax} characters), and optional notes (at most ${WORKOUT_PLAN_LIMITS.notesMax} characters).`,
  `The summary (at most ${WORKOUT_PLAN_LIMITS.summaryMax} characters) explains the plan in plain words to the client and ties it to their goals.`,
  'Reply with JSON only, matching the response schema. No markdown, no commentary.',
].join('\n');

/** The one user turn: the facts, as JSON. */
export function planPrompt(context: PlanContext): string {
  return `Draft a weekly plan for this client.\nClient facts: ${JSON.stringify(context)}`;
}

/**
 * The structured-output schema (`generationConfig.responseSchema`).
 *
 * The bounds are deliberately NOT in the schema: min/max keywords are the
 * part of the schema subset most likely to be refused by one model and not
 * another, and a 400 fails fast rather than rotating. They are in the prompt,
 * and `parseWorkoutPlan` enforces them on the reply either way.
 */
export const WORKOUT_PLAN_RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    summary: { type: SchemaType.STRING, description: 'Plain-language overview for the client.' },
    days: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          day: {
            type: SchemaType.STRING,
            description: 'The weekday name, e.g. "Monday". One per day, never repeated.',
          },
          focus: { type: SchemaType.STRING, description: 'What the day trains.' },
          exercises: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                name: { type: SchemaType.STRING },
                sets: { type: SchemaType.INTEGER },
                reps: { type: SchemaType.STRING, description: 'e.g. "8-10", "12", "30s".' },
                notes: { type: SchemaType.STRING },
              },
              required: ['name', 'sets', 'reps'],
            },
          },
        },
        required: ['day', 'focus', 'exercises'],
      },
    },
  },
  required: ['summary', 'days'],
};

/**
 * The model's reply as JSON, or null. A JSON mime type should mean a bare
 * object, but a fenced reply costs nothing to accept.
 */
export function readModelJson(text: string): unknown {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  if (unfenced === '') return null;
  try {
    return JSON.parse(unfenced) as unknown;
  } catch {
    return null;
  }
}
