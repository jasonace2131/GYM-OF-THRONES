import type {
  ClassRegisterEntryWire,
  CoachProfileView,
  WorkoutPlanSuggestion,
  WorkoutPlanView,
} from '@got/shared';
import { apiFetch } from './api';
import {
  markResultFromWire,
  registerEntryFromWire,
  type MarkResult,
  type MarkResultReply,
  type RegisterEntryReply,
} from './classRegister';
import type {
  CoachMemberProgress,
  Goal,
  GoalBody,
  GoalPatch,
  Measurement,
  MeasurementBody,
  MeasurementPatch,
} from './progress/types';

/**
 * The coach's own dashboard — Figure 12 of the proposal, REQ020.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT IN `adminApi.ts`.
 *
 * `adminApi` is the CRM's surface, and a coach never reaches the CRM: they
 * hold `member.read` at scope OWN, so `isStaff()` is false for them and
 * `/admin` bounces them to the portal. Importing `adminApi` from a portal page
 * would put the whole console's fetcher set — payments, shifts, stations — one
 * autocomplete away from a screen whose caller can call none of it.
 *
 * The two register calls below are the deliberate exception, and they are
 * copies rather than imports for the same reason: a coach holds `booking.read`
 * and `booking.attend` at ALL, so those two routes are genuinely theirs.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Instants arrive as ISO strings and civil dates as `YYYY-MM-DD`. Nothing here
 * formats either — the page does, with an explicit time zone.
 */

export interface CoachSummary {
  assignedMembers: number;
  sessionsThisWeek: number;
  sessionsToday: number;
  bookedToday: number;
  markedToday: number;
  weekFrom: string;
  weekTo: string;
}

export interface CoachSession {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  businessDate: string;
  capacity: number;
  bookedCount: number;
  seatsLeft: number;
  cancelledAt: string | null;
  cancelReason: string | null;
  attended: number;
  noShow: number;
  marked: number;
}

export interface CoachMemberRow {
  userId: string;
  firstName: string;
  lastName: string;
  memberCode: string | null;
  avatarUrl: string | null;
  since: string;
  lastVisitAt: string | null;
  visits30d: number;
  inGymNow: boolean;
  classesAttended: number;
  classesMarked: number;
  /** NULL when nothing has been marked. Render a dash, never `0%`. */
  attendanceRate: number | null;
}

/**
 * One member's progress routes. The id is ENCODED: it comes from the URL bar,
 * and a path segment built from raw input can walk somewhere else. The server
 * would refuse it anyway (ParseUUIDPipe, then the `coachedMember` scope), but
 * a wrapper should not build a path it would not want to be called.
 */
const memberBase = (memberId: string): string =>
  `/me/coaching/members/${encodeURIComponent(memberId)}`;

export const coachApi = {
  summary: (): Promise<CoachSummary> => apiFetch<CoachSummary>('/me/coaching/summary'),

  /**
   * Staff & Access: the coach's own profile, as an admin wrote it. `coach.read`
   * at OWN reaches the caller's own row and nobody else's, so this is the
   * coach reading themselves — read-only; editing is `coach.profile.update`,
   * an admin's key.
   */
  ownProfile: (coachId: string): Promise<CoachProfileView> =>
    apiFetch<CoachProfileView>(`/coaches/${encodeURIComponent(coachId)}/profile`),

  /** Omitting the range means the gym-local week containing today. */
  schedule: (params: { from?: string; to?: string } = {}): Promise<CoachSession[]> => {
    const search = new URLSearchParams();
    if (params.from) search.set('from', params.from);
    if (params.to) search.set('to', params.to);
    const query = search.toString();
    return apiFetch<CoachSession[]>(`/me/coaching/schedule${query === '' ? '' : `?${query}`}`);
  },

  members: (): Promise<CoachMemberRow[]> => apiFetch<CoachMemberRow[]>('/me/coaching/members'),

  /**
   * Who is in a class. `booking.read`, which COACH holds at ALL.
   *
   * The shared `ClassRegisterEntryWire` — the console reads the same shape —
   * so who marked each entry, and when, reaches the coach as well. Read
   * through `registerEntryFromWire`, like the console's: during a deploy the
   * API this one replaces sends rows with neither.
   */
  register: (sessionId: string): Promise<ClassRegisterEntryWire[]> =>
    apiFetch<RegisterEntryReply[]>(`/class-sessions/${sessionId}/register`).then((rows) =>
      rows.map(registerEntryFromWire),
    ),

  /**
   * Marking the register. `booking.attend`, which COACH holds at ALL.
   *
   * The path says `/admin/` because that is where the route lives — it is the
   * staff-side timetable controller. The permission, not the path segment,
   * decides who may call it. The answer carries the marker and the time, so a
   * row patched in place shows the same "Marked by" line a reload would (and
   * no line at all from an API too old to say).
   */
  markAttendance: (bookingId: string, attended: boolean): Promise<MarkResult> =>
    apiFetch<MarkResultReply>(`/admin/class-sessions/bookings/${bookingId}/attendance`, {
      method: 'POST',
      body: JSON.stringify({ attended }),
    }).then(markResultFromWire),

  // ── Recording an assigned member's progress ──────────────────────────────
  //
  // `progress.read` / `progress.record`, held by COACH at OWN: the member must
  // be actively assigned to the caller. Anything else — not theirs, ended,
  // deleted, their own id — is one identical 404, and a non-coach gets 403.
  // Every DELETE answers 200 `{ id }`, because `apiFetch` always reads JSON.

  memberProgress: (memberId: string): Promise<CoachMemberProgress> =>
    apiFetch<CoachMemberProgress>(`${memberBase(memberId)}/progress`),

  /** Merges into the day if it exists; an omitted field is left alone. */
  recordMeasurement: (memberId: string, body: MeasurementBody): Promise<Measurement> =>
    apiFetch<Measurement>(`${memberBase(memberId)}/measurements`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** An explicit null CLEARS that field. Self-recorded rows answer 409. */
  updateMeasurement: (
    memberId: string,
    measurementId: string,
    patch: MeasurementPatch,
  ): Promise<Measurement> =>
    apiFetch<Measurement>(`${memberBase(memberId)}/measurements/${measurementId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteMeasurement: (memberId: string, measurementId: string): Promise<{ id: string }> =>
    apiFetch<{ id: string }>(`${memberBase(memberId)}/measurements/${measurementId}`, {
      method: 'DELETE',
    }),

  /** Replay-protected server-side; `apiFetch` mints the Idempotency-Key. */
  createGoal: (memberId: string, body: GoalBody): Promise<Goal> =>
    apiFetch<Goal>(`${memberBase(memberId)}/goals`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateGoal: (memberId: string, goalId: string, patch: GoalPatch): Promise<Goal> =>
    apiFetch<Goal>(`${memberBase(memberId)}/goals/${goalId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteGoal: (memberId: string, goalId: string): Promise<{ id: string }> =>
    apiFetch<{ id: string }>(`${memberBase(memberId)}/goals/${goalId}`, { method: 'DELETE' }),

  // ── Workout plan (feat/coach-tools) ──────────────────────────────────────
  //
  // `workout.manage` / `workout.suggest`, COACH at OWN, `coachedMember`
  // scope: the same one 404 for everything that is not a member I coach now.

  workoutPlan: (memberId: string): Promise<{ plan: WorkoutPlanView | null }> =>
    apiFetch<{ plan: WorkoutPlanView | null }>(`${memberBase(memberId)}/workout-plan`),

  /** An AI draft. NOT saved — the coach edits it, then `saveWorkoutPlan`. */
  suggestWorkoutPlan: (memberId: string): Promise<WorkoutPlanSuggestion> =>
    apiFetch<WorkoutPlanSuggestion>(`${memberBase(memberId)}/workout-plan/suggest`, {
      method: 'POST',
    }),

  /** Replaces the member's current plan. 422 WORKOUT_PLAN_INVALID names each bad field. */
  saveWorkoutPlan: (memberId: string, body: unknown): Promise<WorkoutPlanView> =>
    apiFetch<WorkoutPlanView>(`${memberBase(memberId)}/workout-plan`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
};
