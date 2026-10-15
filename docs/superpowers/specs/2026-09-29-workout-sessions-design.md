# Workout sessions and the coach's plan in Workouts — design

**Date:** 2026-09-29 · **Branch:** `feat/workout-sessions` (from `main` 71b714b) ·
**Mockup:** the "AI Workout Planner — UI proposal" canvas, row "Round 3" —
`PhoneHubCoach`, `PhoneSession` (interactive), `PhoneFinish`.
**Owner approvals:** session mode (2026-09-29); "the client should have the workout plan as
well" = the coach's plan inside Workouts; "Build round 3, then push" = push to main once green.

## 1. What changes for the member

1. **The coach's plan is a plan in Workouts.** It appears first in "My workout plans" with a
   FROM COACH badge, read-only. It drives Today unless the member has made one of their AI plans
   active; "Use this plan" on the coach card clears the AI plans' active flag. How to works on
   its exercises.
2. **Session mode.** "Start" on Today, or "Start this day" on any day of any plan, opens a
   full-screen session: one exercise at a time, target and "last time", per-set weight and reps
   steppers (typeable), a big tick, a rest timer from the plan (+15 s, Skip), Prev/Next, Add a set,
   How to, Finish. Sets save as they are ticked and survive a dead signal. The screen stays awake.
3. **Done screen and history.** Finishing shows duration, sets, weight moved, new bests, "what you
   did", and an optional "How did it feel?". The hub gets Recent workouts and a history page; the
   week strip ticks days with a finished session; Today shows In progress / Done.
4. **Coach's editor:** each day's label becomes a weekday picker (plus "Other" for free text), and
   the coach's AI suggestion is told to label days with weekday names, so Today can find the day.

No AI actions are spent by anything in this round.

## 2. Data (hand-written migration `20261001000000_workout_sessions`, additive, RLS deny-all)

New enums (created, not altered): `WorkoutSessionSource` (MEMBER_PLAN, COACH_PLAN),
`WorkoutFeeling` (EASY, RIGHT, HARD).

**`WorkoutSession`** — `id`, `memberId` (FK User RESTRICT), `source`, `memberPlanId` (FK
MemberWorkoutPlan **SET NULL**), `coachPlanId` (FK WorkoutPlan **SET NULL**), `planName` (1–60),
`coachFirstName`/`coachLastName` (nullable snapshot), `dayTitle` (1–40), `weekday` SMALLINT NULL
(0–6), `exercises` JSONB (the `SessionExercise[]` snapshot), `businessDate` DATE (gym day it
started), `startedAt`, `finishedAt` NULL, `feeling` NULL, `createdAt`, `updatedAt`.
CHECKs: not both plan ids set; `memberPlanId` only with MEMBER_PLAN, `coachPlanId` only with
COACH_PLAN; `feeling` only when finished; `finishedAt >= startedAt`; `exercises` is an array of
1–12; weekday 0–6; name/title lengths.
Partial unique **`WorkoutSession_one_open ON (memberId) WHERE "finishedAt" IS NULL`**.
Index `(memberId, startedAt DESC)`.

**`WorkoutSetLog`** — only DONE sets exist (tick = upsert, untick = delete). PK
`(sessionId, exerciseIndex, setIndex)`; `sessionId` FK CASCADE; `memberId` FK RESTRICT
(denormalised for "last time"); `exerciseName`; `exerciseSlug` (`^[a-z0-9-]{1,80}$`);
`weightGrams` INT NULL (1–500000; NULL = bodyweight); `reps` SMALLINT (1–200); `completedAt`;
`updatedAt`. CHECKs: indexes `exerciseIndex` 0–11, `setIndex` 0–19. Index
`(memberId, exerciseSlug, completedAt DESC)`.

## 3. Shared contract (`shared/src/workouts/sessions.ts`, written and tested)

Types `SessionExercise`, `LoggedSet`, `LogSetBody`, `LastTime`, `SessionExerciseView`,
`WorkoutSessionView`, `NewBest`, `SessionExerciseSummary`, `WorkoutSessionSummary`,
`StartSessionBody`, `FinishSessionBody`, `PatchSessionBody`, `CoachPlanInWorkouts`; rules
`weekdayFromLabel` (English + Filipino, exact names only), `coachDayWeekdays`,
`sessionExercisesFromMemberDay`, `sessionExercisesFromCoachDay` (rest defaults to 90 s),
`targetReps`, `parseLogSetBody` (kg with ≤ 2 decimals → grams), `sessionStats` (sets, exercises,
volume, per-exercise top set, new bests vs the previous best only), `finishInstant` (an idle
session finishes at its last set), `durationMinutes`, `sessionExerciseSlug`; `SESSION_LIMITS`,
`DEFAULT_REST_SECONDS`, `SESSION_IDLE_CLOSE_MS`, `WORKOUT_FEELINGS`.
`WorkoutsHome` gains `coachPlan`, `session` (the open one) and `recent` (≤ 5 finished).
Error codes: `WORKOUT_SESSION_OPEN` 409 (`details.sessionId`), `WORKOUT_SESSION_MISSING` 404,
`WORKOUT_SESSION_FINISHED` 409, `WORKOUT_SESSION_EMPTY` 422, `WORKOUT_DAY_UNKNOWN` 404,
`WORKOUT_SET_INVALID` 400.

## 4. API (all `workout.member` at OWN; unscoped misses are 404)

| Route                                                            | Does                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me/workouts`                                               | + `coachPlan` (via the existing member read of `WorkoutPlan`, `isActive` = no active AI plan), `session`, `recent`.                                                                                  |
| `POST /me/workouts/coach-plan/use`                               | Clears `isActive` on the caller's AI plans (idempotent). 404 `WORKOUT_DAY_UNKNOWN` if there is no coach plan.                                                                                        |
| `POST /me/workouts/sessions`                                     | `StartSessionBody`. 409 `WORKOUT_SESSION_OPEN` if one is open. Snapshots the day; `businessDate` = gym today. Returns 201 `WorkoutSessionView` with `lastTime`/`bestKg` per exercise. `@Idempotent`. |
| `GET /me/workouts/sessions/current`                              | `{ session: WorkoutSessionView \| null }`.                                                                                                                                                           |
| `GET /me/workouts/sessions/:id`                                  | One session (open or finished) as `WorkoutSessionView`.                                                                                                                                              |
| `PUT /me/workouts/sessions/:id/sets/:exerciseIndex/:setIndex`    | `LogSetBody` → upsert (idempotent by key). 409 when finished; 400 `WORKOUT_SET_INVALID` for a bad body or index. Returns the `LoggedSet`.                                                            |
| `DELETE /me/workouts/sessions/:id/sets/:exerciseIndex/:setIndex` | Untick. 200 `{ deleted: boolean }` (false when it did not exist — replay-safe).                                                                                                                      |
| `POST /me/workouts/sessions/:id/finish`                          | `FinishSessionBody`. Needs ≥ 1 set (422). `finishedAt = finishInstant(lastSet, now)`. Finishing a finished session returns its summary again. Returns `WorkoutSessionSummary`. `@Idempotent`.        |
| `PATCH /me/workouts/sessions/:id`                                | `PatchSessionBody` — the feeling, finished sessions only.                                                                                                                                            |
| `DELETE /me/workouts/sessions/:id`                               | Discard an OPEN session (its sets cascade). A finished one → 409.                                                                                                                                    |
| `GET /me/workouts/sessions?limit=`                               | Finished summaries, newest first, limit ≤ 50.                                                                                                                                                        |
| `GET /me/workouts/sessions/:id/summary`                          | One finished session's `WorkoutSessionSummary`.                                                                                                                                                      |

`lastTime` = that exercise slug's done sets in the member's most recent OTHER finished session;
`bestKg` = the heaviest weight ever logged for that slug in finished sessions before this one.
Both feed `sessionStats`'s new-best rule. `ExerciseGuidesService`'s "is it one of yours" check
also accepts the caller's coach plan and their open session's snapshot.

## 5. Client

- Folders already Tailwind-scanned (`app/portal/workouts`, `components/workouts`).
- **Hub:** coach card first (FROM COACH, ACTIVE / Use this plan, Open → `/portal/workouts/coach`);
  Today from the active AI plan or else the coach's plan; coach plan with no weekday labels →
  Today lists its days to pick from. Today states: Start (POST session → `/session`), In progress
  (Continue + "n of m done"), Done (tick + View summary). Recent workouts (≤ 5, See all →
  `/portal/workouts/history`). Week strip `done` also from finished sessions.
- **`/portal/workouts/coach`:** the coach's plan read-only in the same day-card style; How to;
  "Start this day" per day.
- **Plan pages:** "Start this day" on each day card.
- **`/portal/workouts/session`:** full-viewport focus screen per `PhoneSession` (covers the tab
  bar with a fixed overlay; no layout change). Steppers with a typeable centre
  (`inputmode="decimal"`, 2.5 kg step, reps step 1); prefill from `lastTime`, else the target's
  first number and no weight. Tick = PUT, untick = DELETE. Rest timer computed from an
  `endsAt` timestamp (survives the phone sleeping), +15 s, Skip, `navigator.vibrate` at zero
  when available. `navigator.wakeLock` while open, re-acquired on visibility. **Offline:** every
  op goes through a persisted queue (`localStorage`), replayed in order when back online —
  safe because PUT/DELETE are idempotent by key; a small "Saved / Saving… / Offline — n waiting"
  line. End = Finish (or Discard when nothing is ticked). A 409 `WORKOUT_SESSION_OPEN` on start
  offers Continue or Discard.
- **`/portal/workouts/history/[sessionId]`:** the summary per `PhoneFinish`; `?just=1` shows the
  "Workout done" header and the feeling chips; history rows open it read-only.
- **`/portal/workouts/history`:** finished sessions list.
- **Dashboard `TodayWorkoutCard`:** coach-plan fallback and In progress / Done states.
- **Coach editor** (`coaching/members/[memberId]/_components/WorkoutPlanTab.tsx` + `lib/workoutPlan/editor.ts`):
  day label = `<select>` Monday…Sunday + "Other…" revealing the text input; existing labels that
  are weekday names select themselves, others show as Other with their text.
- Pure, tested modules in `lib/workouts/`: `sessionState.ts` (reducer: sets, current exercise,
  prefill, progress via `sessionStats`), `syncQueue.ts` (persist, order, replay, drop on 404/409),
  `restTimer.ts`, `todaySource.ts` (which plan drives Today, coach-day picking), `history.ts`
  (copy/formatting).

## 6. Server-side prompt change

`server/src/workout-plans/workout-plan-prompt.ts` (the coach's suggester): day labels must be
weekday names, one per day, no repeats. Keep every phrase its spec pins, update the ones it must.

## 7. Tests

Server jest for every service rule (start/snapshot/last time/best, set upsert bounds, finish
rules incl. idle close and empty, discard, coach-plan use, guides membership, presenter
shapes). E2E written, not run: `workout-sessions.e2e-spec.ts`,
`workout-sessions-constraints.e2e-spec.ts` (CHECK names and predicates, the one-open partial
index predicate, RLS, FK delete rules incl. SET NULL on plan delete keeping history).
Client vitest for every `lib/workouts/*` module.

## 8. Out of scope

Swapping mid-session, per-exercise progress charts, coach visibility of the member's own plans
and sessions, supersets, timers per exercise other than rest.
