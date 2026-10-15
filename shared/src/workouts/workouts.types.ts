/**
 * The member workout planner's wire contract (feat/member-workouts).
 *
 * Spec: docs/superpowers/specs/2026-09-26-member-workout-planner-design.md.
 * Both the NestJS module under /me/workouts and the /portal/workouts screens
 * build against these; `parseWorkoutIntake` and `parseMemberPlan` (member-plan.ts)
 * are the two rules both sides run.
 */

import type { MemberPlanBody, MemberPlanDay, MemberPlanExercise } from './member-plan';
import type { CoachPlanInWorkouts, WorkoutSessionSummary, WorkoutSessionView } from './sessions';

export const WORKOUT_GOALS = [
  'MUSCLE',
  'FAT_LOSS',
  'STRENGTH',
  'ENDURANCE',
  'GENERAL',
  'SPORT',
] as const;
export type WorkoutGoal = (typeof WORKOUT_GOALS)[number];

export const WORKOUT_EXPERIENCE = ['NEW', 'SOME', 'EXPERIENCED'] as const;
export type WorkoutExperience = (typeof WORKOUT_EXPERIENCE)[number];

export const WORKOUT_TIMES_OF_DAY = ['MORNING', 'AFTERNOON', 'EVENING'] as const;
export type WorkoutTimeOfDay = (typeof WORKOUT_TIMES_OF_DAY)[number];

export const WORKOUT_EASY_ON = [
  'KNEES',
  'LOWER_BACK',
  'SHOULDERS',
  'WRISTS',
  'NECK',
  'HIPS',
] as const;
export type WorkoutEasyOn = (typeof WORKOUT_EASY_ON)[number];

export const WORKOUT_SESSION_MINUTES = [30, 45, 60, 75] as const;
export type WorkoutSessionMinutes = (typeof WORKOUT_SESSION_MINUTES)[number];

/** The gym-day cap on AI actions per member. Generate, Swap and Adjust cost one each. */
export const WORKOUT_AI_DAILY_LIMIT = 8;
/** How many plans a member may keep. */
export const WORKOUT_LIBRARY_LIMIT = 5;
/** A RUNNING draft older than this is FAILED (and refunded) by the next read. */
export const WORKOUT_DRAFT_STALE_MS = 90_000;

export const WORKOUT_ADJUST_PRESETS = [
  'SHORTER',
  'BUSY',
  'EASIER',
  'HARDER',
  'LOW_IMPACT',
] as const;
export type WorkoutAdjustPreset = (typeof WORKOUT_ADJUST_PRESETS)[number];

/**
 * The seven PAR-Q+ questions live in the browser only. What the server ever
 * sees is `healthFlag` — any "yes" — and the areas to go easy on.
 */
export interface WorkoutIntake {
  goal: WorkoutGoal;
  /** The member's own words, 1–300 chars. Sent to the model AS DATA. */
  goalNotes?: string;
  experience: WorkoutExperience;
  /** 0 = Sunday … 6 = Saturday, like OpeningHours.dayOfWeek. 1–7 unique entries. */
  weekdays: number[];
  sessionMinutes: WorkoutSessionMinutes;
  timeOfDay: WorkoutTimeOfDay;
  healthFlag: boolean;
  easyOn: WorkoutEasyOn[];
  /** Which gym-held facts the member allows into the prompt. */
  use: { measurements: boolean; attendance: boolean; bookings: boolean };
  /** Must be literally `true` — the member agreed to send the intake to Gemini. */
  consent: true;
}

/** The intake as stored on a plan or draft: everything but the consent literal. */
export type WorkoutIntakeSummary = Omit<WorkoutIntake, 'consent'>;

export type WorkoutPlanSource = 'AI' | 'EDITED';
export type WorkoutDraftStatus = 'RUNNING' | 'READY' | 'FAILED';

export interface WorkoutAiQuotaView {
  used: number;
  limit: number;
  remaining: number;
  /** ISO instant of the next gym-midnight reset. */
  resetsAt: string;
}

export interface MemberWorkoutPlanView {
  id: string;
  name: string;
  isActive: boolean;
  intake: WorkoutIntakeSummary;
  plan: MemberPlanBody;
  source: WorkoutPlanSource;
  createdAt: string;
  updatedAt: string;
}

/**
 * The draft is the generation job. While RUNNING, `plan` fills in as the
 * model's lines arrive: `summary` first, then one `days` entry per training
 * day, then `guidance`. Only a READY draft's plan is whole and validated.
 */
export interface WorkoutDraftView {
  status: WorkoutDraftStatus;
  intake: WorkoutIntakeSummary;
  plan: {
    summary: string | null;
    days: MemberPlanDay[];
    guidance: MemberPlanBody['guidance'] | null;
  };
  /** Member copy when FAILED, else null. */
  error: string | null;
  startedAt: string;
  /** Milliseconds from start to the first day on screen — REQ034's evidence. */
  firstDayMs: number | null;
}

/** `GET /me/workouts`. */
export interface WorkoutsHome {
  plans: MemberWorkoutPlanView[];
  draft: WorkoutDraftView | null;
  quota: WorkoutAiQuotaView;
  /** The newest plan's intake, for prefilling the wizard. */
  lastIntake: WorkoutIntakeSummary | null;
  // ── Workout sessions (feat/workout-sessions) — additive ──
  /** The plan the member's coach saved for them, or null. */
  coachPlan: CoachPlanInWorkouts | null;
  /** The member's one OPEN session, or null. */
  session: WorkoutSessionView | null;
  /** The newest finished sessions, newest first, at most SESSION_LIMITS.recentOnHub. */
  recent: WorkoutSessionSummary[];
}

/** `POST /me/workouts/plans/:id/swap` → one of three. */
export interface SwapAlternative extends MemberPlanExercise {
  /** One sentence on why it fits. */
  why: string;
}

export interface SwapResponse {
  alternatives: SwapAlternative[];
  quota: WorkoutAiQuotaView;
}

export interface AdjustResponse {
  day: MemberPlanDay;
  quota: WorkoutAiQuotaView;
}

/** `GET /me/workouts/guides?exercise=` — shared across members, nothing personal in it. */
export interface ExerciseGuideView {
  name: string;
  /** 3–5 plain steps. */
  steps: string[];
  mistake: string;
  easier: string;
  harder: string;
}

export interface CreateWorkoutPlanBody {
  name: string;
  makeActive: boolean;
}

export interface PatchWorkoutPlanBody {
  name?: string;
  isActive?: boolean;
}

export interface SwapRequestBody {
  weekday: number;
  index: number;
}

export interface AdjustRequestBody {
  weekday: number;
  preset?: WorkoutAdjustPreset;
  /** Free text, 1–200 chars. Exactly one of `preset` / `request`. */
  request?: string;
}
