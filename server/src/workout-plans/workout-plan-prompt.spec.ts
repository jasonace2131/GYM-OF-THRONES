import type { MyCheckInSummary } from '@got/shared';
import { asCivilDate } from '../common/time/gym-time';
import type { ProgressSummary } from '../me/progress.presenter';
import type { ProgressMember } from '../me/progress.service';
import {
  WORKOUT_PLAN_RESPONSE_SCHEMA,
  WORKOUT_PLAN_SYSTEM_PROMPT,
  buildPlanContext,
  planPrompt,
  readModelJson,
} from './workout-plan-prompt';

const today = asCivilDate('2026-09-25');

const member: ProgressMember = {
  id: 'member-uuid-7731',
  firstName: 'Maria',
  lastName: 'Santos',
  memberCode: 'K7Q2PX',
};

const progress = (overrides: Partial<ProgressSummary> = {}): ProgressSummary => ({
  measurements: [
    {
      id: 'm1',
      businessDate: asCivilDate('2026-08-01'),
      weightGrams: 72_400,
      heightMm: 1_620,
      bodyFatPermille: 285,
      notes: 'Knee sore after the stairs — PRIVATE-NOTE',
      recordedBy: { firstName: 'Ana' },
      updatedBy: null,
    },
    {
      id: 'm2',
      businessDate: asCivilDate('2026-09-20'),
      weightGrams: 70_900,
      heightMm: null,
      bodyFatPermille: null,
      notes: null,
      recordedBy: { firstName: 'Ana' },
      updatedBy: null,
    },
  ],
  goals: [
    {
      id: 'g1',
      name: 'Lose 5kg',
      unit: 'kg',
      startHundredths: 7_500,
      currentHundredths: 7_090,
      targetHundredths: 7_000,
      percent: 82,
      achievedAt: null,
      recordedBy: { firstName: 'Ana' },
      updatedBy: null,
    },
  ],
  latestWeightGrams: 70_900,
  changeGrams: -1_500,
  changeOverDays: 50,
  bmiThousandths: 27_016,
  coach: { firstName: 'Ana', lastName: 'Reyes' },
  ...overrides,
});

const checkIns: MyCheckInSummary = {
  thisMonth: 7,
  allTime: 40,
  avgPerWeek: 2.4,
  currentStreakWeeks: 3,
  longestStreakWeeks: 6,
  days: [
    { date: asCivilDate('2026-08-20'), count: 1 }, // outside the 30 days
    { date: asCivilDate('2026-08-27'), count: 1 }, // first day inside
    { date: asCivilDate('2026-09-10'), count: 2 },
    { date: asCivilDate('2026-09-24'), count: 1 },
  ],
};

describe('buildPlanContext', () => {
  it('turns stored integers into the units a coach would say', () => {
    const context = buildPlanContext(progress(), checkIns, today);

    expect(context.latest).toEqual({
      weightKg: 70.9,
      // The newest reading that HAS each value, not the newest row.
      heightCm: 162,
      bodyFatPercent: 28.5,
      bmi: 27,
    });
    expect(context.weightChange).toEqual({ kg: -1.5, overDays: 50 });
    expect(context.goals).toEqual([
      { goal: 'Lose 5kg', unit: 'kg', start: 75, current: 70.9, target: 70, achieved: false },
    ]);
  });

  it('counts visits in the last 30 gym days, today included', () => {
    const context = buildPlanContext(progress(), checkIns, today);
    expect(context.attendance).toEqual({ visitsLast30Days: 4, averageVisitsPerWeek: 2.4 });
  });

  // Owner, 2026-10-20: the member's own height (My account) comes first; the
  // weight and BMI arrive already account-first in the progress summary.
  it("uses the member's account height ahead of a measured one", () => {
    const context = buildPlanContext(progress(), checkIns, today, { heightCm: 182 });
    expect(context.latest.heightCm).toBe(182);
  });

  it('falls back to the measured height when the account has none', () => {
    const measured = buildPlanContext(progress(), checkIns, today).latest.heightCm;
    expect(buildPlanContext(progress(), checkIns, today, { heightCm: null }).latest.heightCm).toBe(
      measured,
    );
  });

  it('says nothing it does not know', () => {
    const context = buildPlanContext(
      progress({
        measurements: [],
        goals: [],
        latestWeightGrams: null,
        changeGrams: null,
        changeOverDays: null,
        bmiThousandths: null,
      }),
      { ...checkIns, days: [], avgPerWeek: 0 },
      today,
    );
    expect(context).toEqual({
      goals: [],
      latest: { weightKg: null, heightCm: null, bodyFatPercent: null, bmi: null },
      weightChange: null,
      attendance: { visitsLast30Days: 0, averageVisitsPerWeek: 0 },
    });
  });
});

describe('planPrompt', () => {
  /**
   * The model is told what it needs to plan, and nothing that identifies the
   * person: no name, no member code, no id — and no free-text measurement
   * notes, which is where an injury or a condition would be written down.
   */
  it('names nobody and carries no free-text notes', () => {
    const prompt = planPrompt(buildPlanContext(progress(), checkIns, today));

    for (const secret of ['Maria', 'Santos', 'K7Q2PX', 'member-uuid-7731', 'PRIVATE-NOTE', 'Ana']) {
      expect(prompt).not.toContain(secret);
    }
    expect(prompt).toContain('"visitsLast30Days":4');
    expect(prompt).toContain('Lose 5kg');
    // The member object is not even reachable from the context.
    expect(JSON.stringify(buildPlanContext(progress(), checkIns, today))).not.toContain(
      member.firstName,
    );
  });
});

describe('gym equipment (owner, 2026-10-23)', () => {
  it('gives the coach suggester the list as data, and nothing when it is empty', () => {
    const list = ['Dumbbells (2–40 kg pairs)', 'Rower'];
    expect(buildPlanContext(progress(), checkIns, today, null, list).gymEquipment).toEqual(list);
    expect(buildPlanContext(progress(), checkIns, today, null, [])).not.toHaveProperty(
      'gymEquipment',
    );
    expect(planPrompt(buildPlanContext(progress(), checkIns, today, null, list))).toContain(
      '"gymEquipment":["Dumbbells (2–40 kg pairs)","Rower"]',
    );
    const line = WORKOUT_PLAN_SYSTEM_PROMPT.split('\n').find((l) => l.includes('"gymEquipment"'));
    expect(line).toMatch(/only/i);
    expect(line).toMatch(/bodyweight/i);
  });

  it('prefers commercial-gym basics only when no list is given', () => {
    for (const line of WORKOUT_PLAN_SYSTEM_PROMPT.split('\n').filter((l) =>
      /commercial gym has|common gym|barbells/i.test(l),
    )) {
      expect(line).toContain('"gymEquipment"');
      expect(line.search(/barbells|common gym/i)).toBeGreaterThan(line.indexOf('absent'));
    }
    expect(planPrompt(buildPlanContext(progress(), checkIns, today, null, []))).not.toContain(
      'gymEquipment',
    );
    expect(planPrompt(buildPlanContext(progress(), checkIns, today, null, ['Rower']))).toContain(
      '"gymEquipment"',
    );
  });
});

describe('readModelJson', () => {
  it('parses a bare JSON reply', () => {
    expect(readModelJson('{"summary":"x","days":[]}')).toEqual({ summary: 'x', days: [] });
  });

  it('tolerates a fenced reply', () => {
    expect(readModelJson('```json\n{"summary":"x"}\n```')).toEqual({ summary: 'x' });
  });

  it('answers null for anything that is not JSON', () => {
    expect(readModelJson('Sure! Here is a plan: Monday squats')).toBeNull();
    expect(readModelJson('')).toBeNull();
  });
});

/**
 * The member's Today finds the coach's day by its label (feat/workout-sessions,
 * `weekdayFromLabel`): only a label that IS a weekday name counts, and a
 * repeated weekday keeps only its first day. So the suggester is told exactly
 * that — and no longer offers "Day 1" as an example.
 */
describe('WORKOUT_PLAN_SYSTEM_PROMPT day labels', () => {
  it('asks for weekday names, one per training day, never the same weekday twice', () => {
    expect(WORKOUT_PLAN_SYSTEM_PROMPT).toMatch(/weekday name/i);
    expect(WORKOUT_PLAN_SYSTEM_PROMPT).toContain('"Monday"');
    expect(WORKOUT_PLAN_SYSTEM_PROMPT).toMatch(/one weekday per training day/i);
    expect(WORKOUT_PLAN_SYSTEM_PROMPT).toMatch(/never use the same weekday twice/i);
    expect(WORKOUT_PLAN_SYSTEM_PROMPT).not.toContain('Day 1');
  });

  it('keeps the limits, the focus and the exercise count it always had', () => {
    expect(WORKOUT_PLAN_SYSTEM_PROMPT).toContain('at most 40 characters');
    expect(WORKOUT_PLAN_SYSTEM_PROMPT).toContain('4 to 8 exercises (never more than 12)');
    expect(WORKOUT_PLAN_SYSTEM_PROMPT).toContain('between 2 and 5 days');
    expect(WORKOUT_PLAN_SYSTEM_PROMPT).toContain('Reply with JSON only');
  });

  it("describes the schema's day field as a weekday name too", () => {
    const schema = WORKOUT_PLAN_RESPONSE_SCHEMA as unknown as {
      properties: { days: { items: { properties: { day: { description: string } } } } };
    };
    const description = schema.properties.days.items.properties.day.description;
    expect(description).toMatch(/weekday name/i);
    expect(description).not.toContain('Day 1');
  });
});

describe('WORKOUT_PLAN_RESPONSE_SCHEMA', () => {
  it('asks for exactly the fields parseWorkoutPlan accepts', () => {
    const schema = WORKOUT_PLAN_RESPONSE_SCHEMA as unknown as {
      properties: Record<string, { items?: { properties: Record<string, unknown> } }>;
      required: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual(['days', 'summary']);
    expect(schema.required.sort()).toEqual(['days', 'summary']);

    const day = schema.properties['days'].items as unknown as {
      properties: Record<
        string,
        { items: { properties: Record<string, unknown>; required: string[] } }
      >;
      required: string[];
    };
    expect(Object.keys(day.properties).sort()).toEqual(['day', 'exercises', 'focus']);
    expect(day.required.sort()).toEqual(['day', 'exercises', 'focus']);

    const exercise = day.properties['exercises'].items;
    expect(Object.keys(exercise.properties).sort()).toEqual(['name', 'notes', 'reps', 'sets']);
    expect(exercise.required.sort()).toEqual(['name', 'reps', 'sets']);
  });
});
