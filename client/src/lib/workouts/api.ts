import {
  SESSION_LIMITS,
  type AdjustRequestBody,
  type AdjustResponse,
  type CoachPlanInWorkouts,
  type CreateWorkoutPlanBody,
  type ExerciseGuideView,
  type FinishSessionBody,
  type LogSetBody,
  type LoggedSet,
  type MemberPlanBody,
  type MemberWorkoutPlanView,
  type PatchSessionBody,
  type PatchWorkoutPlanBody,
  type StartSessionBody,
  type SwapRequestBody,
  type SwapResponse,
  type WorkoutAiQuotaView,
  type WorkoutDraftView,
  type WorkoutIntake,
  type WorkoutSessionSummary,
  type WorkoutSessionView,
  type WorkoutsHome,
} from '@got/shared';
import { apiFetch } from '@/lib/api';
import type { SyncOp } from './syncQueue';

/**
 * `/me/workouts` on the wire — spec §5, typed against `shared/src/workouts`.
 *
 * Every POST carries the `Idempotency-Key` `apiFetch` mints. Nothing here
 * ever sees the PAR-Q+ answers: `startDraft` takes the `WorkoutIntake` that
 * `buildRequest` produced, which has no field for them.
 */

const BASE = '/me/workouts';

const json = (method: 'POST' | 'PATCH' | 'PUT', body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

const sessionPath = (id: string): string => `${BASE}/sessions/${encodeURIComponent(id)}`;
const setPath = (id: string, exerciseIndex: number, setIndex: number): string =>
  `${sessionPath(id)}/sets/${exerciseIndex}/${setIndex}`;

function putSet(
  id: string,
  exerciseIndex: number,
  setIndex: number,
  body: LogSetBody,
): Promise<LoggedSet> {
  return apiFetch<LoggedSet>(setPath(id, exerciseIndex, setIndex), json('PUT', body));
}

function deleteSet(
  id: string,
  exerciseIndex: number,
  setIndex: number,
): Promise<{ deleted: boolean }> {
  return apiFetch<{ deleted: boolean }>(setPath(id, exerciseIndex, setIndex), {
    method: 'DELETE',
  });
}

export const workoutsApi = {
  home: (): Promise<WorkoutsHome> => apiFetch<WorkoutsHome>(BASE),

  startDraft: (
    intake: WorkoutIntake,
  ): Promise<{ draft: WorkoutDraftView; quota: WorkoutAiQuotaView }> =>
    apiFetch(`${BASE}/drafts`, json('POST', intake)),

  draft: (): Promise<WorkoutDraftView> => apiFetch<WorkoutDraftView>(`${BASE}/draft`),

  discardDraft: (): Promise<unknown> => apiFetch<unknown>(`${BASE}/draft`, { method: 'DELETE' }),

  savePlan: (body: CreateWorkoutPlanBody): Promise<MemberWorkoutPlanView> =>
    apiFetch<MemberWorkoutPlanView>(`${BASE}/plans`, json('POST', body)),

  plan: (id: string): Promise<MemberWorkoutPlanView> =>
    apiFetch<MemberWorkoutPlanView>(`${BASE}/plans/${encodeURIComponent(id)}`),

  patchPlan: (id: string, body: PatchWorkoutPlanBody): Promise<MemberWorkoutPlanView> =>
    apiFetch<MemberWorkoutPlanView>(`${BASE}/plans/${encodeURIComponent(id)}`, json('PATCH', body)),

  putBody: (id: string, plan: MemberPlanBody): Promise<MemberWorkoutPlanView> =>
    apiFetch<MemberWorkoutPlanView>(
      `${BASE}/plans/${encodeURIComponent(id)}/body`,
      json('PUT', { plan }),
    ),

  deletePlan: (id: string): Promise<unknown> =>
    apiFetch<unknown>(`${BASE}/plans/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  swap: (id: string, body: SwapRequestBody): Promise<SwapResponse> =>
    apiFetch<SwapResponse>(`${BASE}/plans/${encodeURIComponent(id)}/swap`, json('POST', body)),

  adjust: (id: string, body: AdjustRequestBody): Promise<AdjustResponse> =>
    apiFetch<AdjustResponse>(`${BASE}/plans/${encodeURIComponent(id)}/adjust`, json('POST', body)),

  guide: (exercise: string): Promise<ExerciseGuideView> =>
    apiFetch<ExerciseGuideView>(`${BASE}/guides?exercise=${encodeURIComponent(exercise)}`),

  // ── Workout sessions (feat/workout-sessions, spec §4) ──────────────────

  /** "Use this plan" on the coach card: clears the AI plans' active flag. */
  adoptCoachPlan: (): Promise<CoachPlanInWorkouts> =>
    apiFetch<CoachPlanInWorkouts>(`${BASE}/coach-plan/use`, { method: 'POST' }),

  /** 409 WORKOUT_SESSION_OPEN when one is open already (`details.sessionId`). */
  startSession: (body: StartSessionBody): Promise<WorkoutSessionView> =>
    apiFetch<WorkoutSessionView>(`${BASE}/sessions`, json('POST', body)),

  currentSession: (): Promise<{ session: WorkoutSessionView | null }> =>
    apiFetch<{ session: WorkoutSessionView | null }>(`${BASE}/sessions/current`),

  session: (id: string): Promise<WorkoutSessionView> =>
    apiFetch<WorkoutSessionView>(sessionPath(id)),

  putSet,
  deleteSet,

  /** The sync queue's one door to the server. */
  sendOp: (op: SyncOp): Promise<unknown> =>
    op.kind === 'put'
      ? putSet(op.sessionId, op.exerciseIndex, op.setIndex, op.body)
      : deleteSet(op.sessionId, op.exerciseIndex, op.setIndex),

  /** 422 WORKOUT_SESSION_EMPTY with nothing ticked; finishing twice returns the same summary. */
  finishSession: (id: string, body: FinishSessionBody = {}): Promise<WorkoutSessionSummary> =>
    apiFetch<WorkoutSessionSummary>(`${sessionPath(id)}/finish`, json('POST', body)),

  /** The feeling, on a finished workout (409 WORKOUT_SESSION_OPEN while it is open). */
  patchSession: (id: string, body: PatchSessionBody): Promise<WorkoutSessionSummary> =>
    apiFetch<WorkoutSessionSummary>(sessionPath(id), json('PATCH', body)),

  /** Discard an OPEN workout; its sets go with it (409 WORKOUT_SESSION_FINISHED if finished). */
  discardSession: (id: string): Promise<{ id: string }> =>
    apiFetch<{ id: string }>(sessionPath(id), { method: 'DELETE' }),

  /** 409 WORKOUT_SESSION_OPEN while the workout is still open. */
  summary: (id: string): Promise<WorkoutSessionSummary> =>
    apiFetch<WorkoutSessionSummary>(`${sessionPath(id)}/summary`),

  /** Finished summaries, newest first — a bare list, at most 50. */
  sessions: (limit: number = SESSION_LIMITS.historyPageMax): Promise<WorkoutSessionSummary[]> =>
    apiFetch<WorkoutSessionSummary[]>(`${BASE}/sessions?limit=${limit}`),
};
