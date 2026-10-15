import type { Prisma } from '@prisma/client';
import {
  parseGuidance,
  parseMemberDay,
  parseMemberPlan,
  type MemberPlanBody,
  type MemberPlanDay,
  type MemberWorkoutPlanView,
  type WorkoutDraftStatus,
  type WorkoutDraftView,
  type WorkoutIntake,
  type WorkoutIntakeSummary,
} from '@got/shared';

/**
 * The wire shapes of the member workout planner (feat/member-workouts).
 *
 * Every read goes back through the shared schema, so the wire type is PROVEN
 * rather than cast: a stored body that fails it (only possible by writing
 * around the API) comes back as null and the caller decides what to show.
 */

/** The columns a plan view is built from. */
export interface PlanRow {
  id: string;
  name: string;
  goal: WorkoutIntakeSummary['goal'];
  goalNotes: string | null;
  experience: WorkoutIntakeSummary['experience'];
  weekdays: number[];
  sessionMinutes: number;
  timeOfDay: WorkoutIntakeSummary['timeOfDay'];
  healthFlag: boolean;
  easyOn: WorkoutIntakeSummary['easyOn'];
  useMeasurements: boolean;
  useAttendance: boolean;
  useBookings: boolean;
  body: Prisma.JsonValue;
  source: 'AI' | 'EDITED';
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const PLAN_SELECT = {
  id: true,
  name: true,
  goal: true,
  goalNotes: true,
  experience: true,
  weekdays: true,
  sessionMinutes: true,
  timeOfDay: true,
  healthFlag: true,
  easyOn: true,
  useMeasurements: true,
  useAttendance: true,
  useBookings: true,
  body: true,
  source: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** The intake as stored on a draft or a plan: everything but the consent literal. */
export function intakeSummaryOf(intake: WorkoutIntake): WorkoutIntakeSummary {
  const summary: WorkoutIntakeSummary = {
    goal: intake.goal,
    experience: intake.experience,
    weekdays: intake.weekdays,
    sessionMinutes: intake.sessionMinutes,
    timeOfDay: intake.timeOfDay,
    healthFlag: intake.healthFlag,
    easyOn: intake.easyOn,
    use: intake.use,
  };
  return intake.goalNotes === undefined ? summary : { ...summary, goalNotes: intake.goalNotes };
}

export function intakeOf(row: PlanRow): WorkoutIntakeSummary {
  const intake: WorkoutIntakeSummary = {
    goal: row.goal,
    experience: row.experience,
    weekdays: [...row.weekdays].sort((a, b) => a - b),
    sessionMinutes: row.sessionMinutes as WorkoutIntakeSummary['sessionMinutes'],
    timeOfDay: row.timeOfDay,
    healthFlag: row.healthFlag,
    easyOn: [...row.easyOn],
    use: {
      measurements: row.useMeasurements,
      attendance: row.useAttendance,
      bookings: row.useBookings,
    },
  };
  return row.goalNotes === null ? intake : { ...intake, goalNotes: row.goalNotes };
}

/** Null when the stored body no longer passes the schema. */
export function toPlanView(row: PlanRow): MemberWorkoutPlanView | null {
  const parsed = parseMemberPlan(row.body);
  if (!parsed.ok) return null;
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    intake: intakeOf(row),
    plan: parsed.value,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface DraftRow {
  status: WorkoutDraftStatus;
  intake: Prisma.JsonValue;
  plan: Prisma.JsonValue;
  error: string | null;
  startedAt: Date;
  firstDayAt: Date | null;
}

/** What a draft's `plan` column looks like while the job fills it in. */
export interface PartialPlan {
  summary: string | null;
  days: MemberPlanDay[];
  guidance: MemberPlanBody['guidance'] | null;
}

export const EMPTY_PLAN: PartialPlan = { summary: null, days: [], guidance: null };

/**
 * A partial plan, re-validated field by field: a day that no longer parses
 * is dropped rather than shown half-drawn, and anything missing is null.
 */
export function partialPlanOf(value: Prisma.JsonValue): PartialPlan {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ...EMPTY_PLAN };
  const record = value as Record<string, unknown>;
  const summary = typeof record['summary'] === 'string' ? record['summary'] : null;
  const days = Array.isArray(record['days'])
    ? record['days']
        .map((day, i) => parseMemberDay(day, `days[${i}]`, []))
        .filter((day): day is MemberPlanDay => day !== null)
    : [];
  const guidance =
    record['guidance'] === null || record['guidance'] === undefined
      ? null
      : parseGuidance(record['guidance'], 'guidance', []);
  return { summary, days, guidance };
}

export function toDraftView(row: DraftRow): WorkoutDraftView {
  return {
    status: row.status,
    intake: row.intake as unknown as WorkoutIntakeSummary,
    plan: partialPlanOf(row.plan),
    error: row.status === 'FAILED' ? row.error : null,
    startedAt: row.startedAt.toISOString(),
    firstDayMs: row.firstDayAt === null ? null : row.firstDayAt.getTime() - row.startedAt.getTime(),
  };
}
