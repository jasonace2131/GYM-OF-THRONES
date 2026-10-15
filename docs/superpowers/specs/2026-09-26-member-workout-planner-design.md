# Member workout planner — design

**Date:** 2026-09-26 · **Branch:** `feat/member-workouts` (from `integration/round-2`) ·
**Paper:** Objective 1.2, REQ017–019, REQ034, REQ037 · **Mockup:** the "AI Workout Planner — UI proposal" canvas.

## 1. What it is

A new member module, `/portal/workouts`, where a CLIENT builds their own AI workout plan
and keeps a small library of them. It is separate from the coach's plan (`WorkoutPlan`,
feat/coach-tools), which stays exactly as it is: a coached member can have both, and the
dashboard shows the coach's plan first.

The owner chose **generator + AI toolbelt**: intake → streamed plan → Swap an exercise,
How to do it, Adjust a day, Regenerate, hand edits → Save (up to 5 plans, one active).

Most members are on phones. Every screen is designed at 390 px first.

## 2. Owner decisions

| Topic                  | Decision                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depth                  | Generator + toolbelt (Swap, How to, Adjust, wellness tips). No logging or adaptive weeks in v1.                                                              |
| Library                | Up to **5** saved plans per member, **one active**. A generation is a draft until saved.                                                                     |
| AI budget              | **8 AI actions per member per day** (gym-day, resets at midnight Manila). Generate/regenerate, Swap and Adjust cost 1 each. How to is free (cached, shared). |
| Coach                  | Both plans coexist, clearly labelled. Nothing changes on the coach side in v1.                                                                               |
| 5-second rule (REQ034) | The plan is **streamed**: Day 1 is on screen in about 3 s; the rest fills in. `firstDayMs` is recorded per generation as evidence.                           |
| Half plans             | Never kept. A failed generation discards the draft and refunds the AI action.                                                                                |
| Health data            | The 7 PAR-Q+ answers **never leave the browser**. The server receives only `healthFlag` (any "yes") and the "go easy on" areas.                              |
| Naming                 | The module is **Workouts** (the phone tab bar already uses "Plan" for the subscription).                                                                     |
| Phone tab bar          | Workouts becomes the 4th tab for a CLIENT; Plan (subscription) moves to More.                                                                                |

## 3. Data (hand-written migration `20260930000000_member_workouts`, additive, RLS deny-all)

Enums: `WorkoutGoal` (MUSCLE, FAT_LOSS, STRENGTH, ENDURANCE, GENERAL, SPORT), `WorkoutExperience`
(NEW, SOME, EXPERIENCED), `WorkoutTimeOfDay` (MORNING, AFTERNOON, EVENING), `WorkoutEasyOn` (KNEES,
LOWER_BACK, SHOULDERS, WRISTS, NECK, HIPS), `WorkoutPlanSource` (AI, EDITED), `WorkoutDraftStatus`
(RUNNING, READY, FAILED). No existing enum is altered, so no separate enum migration.

**`MemberWorkoutPlan`** — a saved plan. `id`, `memberId` (FK User RESTRICT), `name` (1–60), `goal`,
`goalNotes` (≤300, nullable), `experience`, `weekdays SMALLINT[]` (0 = Sunday, like `OpeningHours`),
`sessionMinutes` (30|45|60|75), `timeOfDay`, `healthFlag`, `easyOn "WorkoutEasyOn"[]`, `body JSONB`,
`source`, `model` (nullable), `isActive`, `consentAt`, `createdAt`, `updatedAt`.
CHECKs: name and notes lengths, `sessionMinutes IN (30,45,60,75)`, `weekdays <@ ARRAY[0..6]` and
1–7 long, `cardinality(easyOn) <= 6`, `jsonb_typeof(body->'days') = 'array'`.
Partial unique index `MemberWorkoutPlan_one_active ON (memberId) WHERE isActive`. Index (memberId, createdAt).
The 5-plan limit is a service rule (409), covered by e2e.

**`MemberWorkoutDraft`** — at most one per member (`memberId` PK, FK RESTRICT). `jobId UUID`, `status`,
`intake JSONB`, `plan JSONB` (partial: `{summary, days[], guidance}` filled in as events arrive),
`error TEXT`, `model`, `consentAt`, `startedAt`, `firstDayAt`, `finishedAt`, `updatedAt`.
The draft IS the job: polling reads it, a restart cannot lose it, and a RUNNING draft older
than 90 s is marked FAILED (and refunded) by the next read.

**`WorkoutAiQuota`** — `(memberId, day DATE) PK`, `used SMALLINT CHECK (used >= 0)`.

**`ExerciseGuide`** — the shared "How to" cache. `slug TEXT PK` (`^[a-z0-9-]{1,80}$`), `name`, `body JSONB`,
`model`, `createdAt`. Holds nothing personal: the prompt is the exercise name only.

## 4. Shared contract (`shared/src/workouts/`)

- `WORKOUT_LIMITS`, `WORKOUT_AI_DAILY_LIMIT = 8`, `WORKOUT_LIBRARY_LIMIT = 5`, `WORKOUT_SESSION_MINUTES`.
- `WorkoutIntake` + `parseWorkoutIntake` — the wizard and the DTO agree through one function.
- `MemberPlanBody` + `parseMemberPlan` — strict, normalising, every error at once (same pattern as
  `parseWorkoutPlan`). Shape: `{ summary, days: [{ weekday, title, focus, minutes, warmUp, coolDown,
exercises: [{ name, muscles, sets, reps, restSeconds, notes? }] }], guidance: [{ title, body }] }`.
  Days: 1–6, unique weekdays. Exercises: 1–10 per day.
- Wire views: `MemberWorkoutPlanView`, `WorkoutDraftView`, `WorkoutAiQuotaView`, `WorkoutsHome`,
  `SwapAlternative`, `ExerciseGuideView`, `WorkoutAdjustPreset`.
- Permission key `workout.member` — "Build and keep your own AI workout plans" — CLIENT at OWN.
  DEV bypasses. Nobody else holds it.

## 5. API (`server/src/workouts/`, all under `/me/workouts`, `@RequirePermission('workout.member')` at OWN)

| Route                                                                   | Does                                                                                                                                                                                                        | AI cost |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `GET /me/workouts`                                                      | `{ plans, draft, quota, lastIntake }`                                                                                                                                                                       | –       |
| `POST /me/workouts/drafts`                                              | Charges the quota, creates the draft (RUNNING), starts the job, returns 202 `{ draft, quota }`. 409 `WORKOUT_DRAFT_RUNNING`, 429 `WORKOUT_AI_LIMIT`, 400 `WORKOUT_CONSENT_REQUIRED`.                        | 1       |
| `GET /me/workouts/draft`                                                | Poll target. Times out a stale RUNNING draft.                                                                                                                                                               | –       |
| `DELETE /me/workouts/draft`                                             | Discard (a running job's later writes match zero rows, by `jobId`). No refund.                                                                                                                              | –       |
| `POST /me/workouts/plans` `{ name, makeActive }`                        | Saves the READY draft as a plan, deletes the draft. 409 `WORKOUT_DRAFT_NOT_READY`, 409 `WORKOUT_PLAN_LIMIT`.                                                                                                | –       |
| `GET /me/workouts/plans/:id`                                            | One plan. Unscoped miss → 404.                                                                                                                                                                              | –       |
| `PATCH /me/workouts/plans/:id` `{ name?, isActive? }`                   | Rename / set active (deactivates the others in one transaction).                                                                                                                                            | –       |
| `PUT /me/workouts/plans/:id/body` `{ plan }`                            | Hand edits and kept Swap/Adjust results. `parseMemberPlan`; 400 `WORKOUT_PLAN_INVALID` with the error list. Sets `source = EDITED`.                                                                         | –       |
| `DELETE /me/workouts/plans/:id`                                         | Delete.                                                                                                                                                                                                     | –       |
| `POST /me/workouts/plans/:id/swap` `{ weekday, index }`                 | 3 alternatives for that exercise.                                                                                                                                                                           | 1       |
| `POST /me/workouts/plans/:id/adjust` `{ weekday, preset? \| request? }` | A replacement day (same weekday), validated. The client shows Keep/Undo; Keep = `PUT …/body`.                                                                                                               | 1       |
| `GET /me/workouts/guides?exercise=`                                     | Cached How-to; a miss asks Gemini and stores it. The name must appear in one of the caller's plans or draft (404 `WORKOUT_EXERCISE_UNKNOWN`), so this is never a free general endpoint. `@Throttle` 10/min. | 0       |

Every POST carries the usual `Idempotency-Key` (the client mints it). `swap`/`adjust` are
synchronous through `GeminiGateway.rotate` with `ASK_BUDGET_MS`; the gateway's own codes
(`ASSISTANT_BUSY`, `ASSISTANT_TIMEOUT`, `ASSISTANT_NOT_CONFIGURED`) propagate and are refunded.

### The generation job

`WorkoutDraftService.start()` charges the quota, writes the draft, then runs the job without
awaiting it. The job builds the context from existing scoped reads (progress summary,
check-in summary, bookings, `OpeningHoursService.week()`), then one call through
`gemini.rotate('member-workout', COPY, 40_000, attempt)`. The attempt uses
`sendMessageStream` and asks for **NDJSON**: one JSON object per line, in order —
`{"summary": …}`, then `{"day": {…}}` per training day, then `{"guidance": […]}`.
Each completed line is validated and appended to the draft row (`updateMany` where
`memberId` and `jobId` match). The first `day` line stamps `firstDayAt` and logs
`firstDayMs`. A bad line throws, the partial fields are reset, and the gateway rotates to
the next model. When the stream ends, the assembled plan goes through `parseMemberPlan`
plus two extra rules: every weekday is one of the intake's, and no weekday repeats. Success →
READY; final failure → FAILED with member copy in `error`, and the quota refunded.

**What the model receives (pure `member-plan-prompt.ts`, tested):** goal, notes (as JSON data,
never as instructions), experience, weekdays, minutes, time of day, `healthFlag` as
"keep it gentle", easy-on areas, and — each only if the member left its switch on —
weight/height/body-fat/BMI, 30-day visits and weekly average, booked classes as
`{ weekday, time, name }`, plus opening hours per weekday. Never a name, email, member code,
date of birth, measurement notes or the raw health answers. Log counts and timings only.

**Prompt rules:** safe, common commercial-gym exercises; sessions fit the minutes and the
gym's hours for that weekday and time of day; a booked class day is a cardio day and the
day after avoids heavy legs; gentle mode means no maximal efforts, no jumping, conservative
progressions and a line suggesting medical clearance; easy-on areas get substitutions;
if weekly attendance is well below the chosen days, the summary says so kindly; guidance is
4 short tips (sleep, protein, water, rest days or similar) and never diet prescriptions or
medical claims.

## 6. Client (`client/src/app/portal/workouts/`, `client/src/components/workouts/`)

Both folders are added to `tailwind.css` `@source` and `tailwind-containment.mjs` `SCANNED`.
Tailwind utilities on the portal's tokens, like the dashboard. Nothing rendered as HTML.

Screens (per the mockup):

- **Hub `/portal/workouts`** — Today (title, chips, week strip with check-in ticks and booked
  classes, Start / Adjust today), today's exercises, AI actions left meter, today's wellness tip,
  My workout plans (cards, Set active, Open, Create with AI), safety line. Empty state when there
  are no plans: the Create card leads.
- **Intake `/portal/workouts/new`** — 4 steps: Goal, About you (experience + the three
  "use what the gym knows" switches), Your week (days, minutes, time of day, the booked-class
  hint), Health check (7 PAR-Q+ questions, easy-on chips, gentle notice, consent). Sticky
  bottom bar on phones. `?from=<planId>` prefills for Regenerate.
- **Generating / draft `/portal/workouts/draft`** — polls `GET /me/workouts/draft` every 800 ms
  (pure backoff module), shows progress steps and the days as they land, Cancel. When READY it
  becomes the plan screen in draft mode with "Save to my plans" (name + make active).
- **Plan `/portal/workouts/[planId]`** — the plan screen in saved mode: chips, Regenerate,
  Edit by hand, day cards with Swap (3 alternatives, Use, Undo), How to (steps, watch out,
  easier, harder), Adjust this day (5 presets + free text; Keep/Undo), Why this plan, Your week,
  Wellness guidance, Train safely. On phones Swap opens the existing `ui/sheet` from the bottom.
- **Nav** — "Workouts" in the sidebar's MAIN group after Dashboard, gated on `workout.member`;
  `TAB_ITEMS` gains Workouts as the 4th candidate (before Plan). `titleForPath` follows.
- **Dashboard** — `TodayWorkoutCard`: when an active AI plan exists, one compact card (today's
  session or "Rest day · next Saturday") linking to the plan. The coach's card is untouched.

Pure, tested modules in `client/src/lib/workouts/`: `intake.ts` (wizard reducer, validation,
prefill), `today.ts` (today + week strip from plan, check-ins, bookings, gym date), `quota.ts`
(copy), `polling.ts`, `planEdits.ts` (apply swap/adjust, undo), `guidance.ts` (tip of the day),
`api.ts`.

Accessibility: real buttons, `aria-pressed` / `role="radio"` groups, 44 px targets, focus
rings, `role="status"` for progress, reduced-motion safe. No emoji.

## 7. Errors (added to `DomainErrorCode`)

`WORKOUT_AI_LIMIT` (429), `WORKOUT_DRAFT_RUNNING` (409), `WORKOUT_DRAFT_NOT_READY` (409),
`WORKOUT_DRAFT_MISSING` (404), `WORKOUT_PLAN_LIMIT` (409), `WORKOUT_PLAN_INVALID` (400),
`WORKOUT_EXERCISE_UNKNOWN` (404), `WORKOUT_CONSENT_REQUIRED` (400). Messages are member copy.

## 8. Tests

Server jest: prompt builder (no PII, every switch), NDJSON line parser, quota day/charge/refund,
draft state machine (stale timeout, cancel by jobId, retry resets partial), `parseMemberPlan`
and `parseWorkoutIntake` (strict, XSS-shaped strings, limits), guides slugging and membership
check, controller scope. Client vitest: every `lib/workouts/*` module. E2E written, not run:
`member-workouts.e2e-spec.ts` (quota, library limit, one active, draft lifecycle with a stubbed
gateway, scope 404s, guides membership) and `member-workouts-constraints.e2e-spec.ts` (CHECK
names and predicates, the partial unique index predicate, RLS, FK delete rules).

## 9. Out of scope (v1)

Workout logging, adaptive weeks, coach review of member plans, minors rule for the planner,
exercise images/videos, printing.
