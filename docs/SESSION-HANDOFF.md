# Session handoff — 2026-09-06

Everything a fresh session needs to continue. Read this first, then
`CLAUDE.md`, then `docs/paper-amendments.md`.

---

## 0. The rules that override everything

1. **NEVER push or commit to `main`.** It auto-deploys to production
   (Vercel + API host) and the project is still in development. All work goes
   on a feature branch. Touch `main` ONLY on an explicit, per-change
   "push to main" from the owner, in that conversation. This is written into
   `CLAUDE.md` under "Branch workflow" after main was polluted once.
2. **Migrations ship when their branch merges**, never applied to the shared
   database while `main` still runs pre-migration code.
3. **Never run `npm run lint`** — the server script is `eslint --fix` and
   rewrites unrelated files.
4. Follow the production gate in `CLAUDE.md` before any push: clean → build
   shared → prisma generate → build server → `ls server/dist/main.js` → build
   client → typecheck both → jest → vitest.

---

## 1. Where the code is

| Branch | Head | Contents |
|---|---|---|
| `main` | `23dfd6d` | Deployed. Walk-in↔member conversion, re-entry grace, editable opening hours, 12-hour clock, the branch rule. |
| `feat/walkin-gcash` | `4d0c191` | **Unmerged.** GCash reference recording + duplicate detection, printable Transaction Slip, `/admin/walk-ins` page + checkout modal. |
| `feat/paper-alignment` | `1decb1e` | **Unmerged, current work.** Branches FROM `feat/walkin-gcash`, so merging it brings both. Phase 0 fixes, Reports, paper amendments, and all of Phase 1. |

Merging `feat/paper-alignment` into main brings the walk-in/GCash work with
it. That is intentional; do not cherry-pick them apart.

### Two owner actions outstanding

**a. The GCash constraint on main.** The GCash migration was applied to the
live database **before** main was reverted, and one of its constraints breaks
GCash sales on main's older code (cash is unaffected). The owner was asked to
run this once from `server/`:

```
echo 'ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "Payment_reference_normalized_shape";' | npx prisma db execute --stdin --schema prisma/schema
```

`feat/walkin-gcash` carries `20260903120000_restore_reference_normalized_shape`
which restores it (idempotent, with a re-backfill) at merge time. **Confirm
with the owner whether they ran it** before assuming GCash sales work on main.

**b. `prisma db seed` is mandatory at merge.** This branch adds two permission
keys (`notification.read`, `notification.resolve`), taking the catalogue from
53 to 55 and the grants to 94. Without a re-seed the Notifications panel 403s
for everybody including ADMIN, silently — the failure mode `CLAUDE.md` warns
about.

---

## 2. What this session did — Phase 1 is complete

Three commits, each self-contained and independently green.

### `8d2c105` — the coach dashboard, class editing, coach assignment

**Coach dashboard, `/portal/coaching`** (Figure 12, **REQ020**). There was no
coach surface at all: the server has supported `coachId` on a class session
since classes shipped and `CoachAssignment` since the RBAC work, but nothing
rendered either.

It lives in the **portal, not the console**, and that is load-bearing. A coach
is not staff as this system defines staff — they hold `member.read` at scope
OWN, so `isStaff()` is false and `/admin` shows them the "Staff only" gate.
`safeNext.ts` records the bug that came from getting this backwards.

New `GET /me/coaching/{summary,schedule,members}`, gated on `coach.read`,
hard-scoped to the caller — the coach is always `request.user.id` and there is
no `coachId` parameter to tamper with. Four panels: the week at a glance,
today's register (the only write), the week's timetable, the caseload.

**REQ013** — `PATCH /admin/class-sessions/:id` had existed the whole time with
no client wrapper, so "modify a class" was unreachable from any UI. The
timetable's Composer now creates or edits, sending only changed fields.
`ClassSessionDto` gained `coachId` so an edit form can preselect the coach by
identity rather than by matching a display name.

**REQ014** — `/admin/coaches` used to end with a paragraph admitting that
assignment "runs through the coach-assignment API today; a screen for it is
the next thing this page needs". It now has one. That work surfaced a real
client/server disagreement: `CoachAssignmentItem` declared `coachName`,
`memberName` and `memberCode` while the server sent none of them.

### `652ed44` — the Notifications panel (Figure 22, **REQ021**)

Two columns, and only one is a table. **Expiration alerts are derived** on
every load from the same `memberships({ expiringWithinDays })` query the
Subscriptions screen runs — storing them would leave a stale row behind every
renewal and need a nightly sweep to stay honest. **System notifications are
stored**, because nothing else records them.

Two real producers, and the enum has no speculative values: a lead arriving
(WARNING when no email went out, because then the board is the only trace),
and the nightly membership job changing something or throwing. Silent when
nothing changed.

`raise()` never throws, by contract and by test — losing a reminder must never
cost the gym the enquiry it was reminding them about.

### `1decb1e` — the audit log

`audit.read` had been a seeded permission with **no model, no route and no
screen** since the RBAC work. Eleven producers now write to it: payment void,
denial override, visit void, member suspend/reactivate/delete/restore, role
change, plan edit, plan archive, opening hours.

Append-only in fact, not by convention: `actorId` is `ON DELETE RESTRICT` and
there is no update or delete path anywhere. `actorRole` is snapshotted so a
later promotion cannot rewrite what somebody was when they acted. The
controller is read-only — a route that let a caller author an entry would let
them author an alibi.

`record()` never throws, and `audit.service.ts` says why at length: an
operator who cannot void a wrong charge will find another way that leaves no
trail at all. `GET /admin/audit/coverage` exists so the screen can print
"recording started <date>" rather than letting an empty list imply that
nothing has ever gone wrong.

---

## 3. Owner decisions already taken (do not re-ask)

- **Defense date: six weeks or more out** from 2026-09-06, so on or after
  roughly **18 October 2026**. All of Phases 1–3 fit. Confirm the exact date
  if it is still unset by late September.
- **AI:** build the workout plan generator the paper specifies (Objective 1.2,
  REQ017-019) **and keep** the existing Q&A assistant.
- **Notifications:** email + in-app. **Drop SMS and OTP** from the paper.
- **UI fidelity:** match the mockups' *structure* (page names, sections, nav)
  with better, modern UX inside. The Miro figures are a reference for the
  panel's mental model, not a pixel contract.
- **Priority:** demo-able screens first.
- Sending domain **is being acquired** → email notices are unblocked.
- Audit logging is **forward-only**, no backfill.
- `/portal/coach` **stays** and eventually gets real messaging.
- **"Trial" tier struck** from the paper — it was only an example.
- Nav renames approved: ~~`/admin/subscriptions` → **Memberships**~~ (SUPERSEDED —
  the screen was merged into `/admin/members` instead; there is nothing left to
  rename), `/admin/revenue` → **Analytics**. **Not done yet** — see §5.

---

## 4. What remains — the plan

Full plan lives at `C:\Users\patri\.claude\plans\vast-swimming-rossum.md`.
Phase 1 is done. What is left:

### Phase 2 — AI workout plan generator (REQ017-019, Objective 1.2)

The paper's headline AI feature; what exists today is a *membership Q&A
chatbot* whose own prompt says "You cannot change anything". Additive.

- Schema: `WorkoutPlan` (userId, goalsText, experienceLevel, healthDeclaration,
  planJson, model, timestamps). No experience-level field exists anywhere
  today, and `medicalNotes` is staff-entered only (`user.prisma:60`).
- Server: `POST /me/workout-plan`, `GET /me/workout-plans`,
  `PATCH /me/workout-plans/:id`. Reuse `assistant/gemini-models.ts` rotation
  and the Gemini client in `assistant.service.ts`. **Hard 5-second deadline
  (REQ034)** — on timeout refuse clearly, never return a half plan.
- Client: `/portal/workout` — intake (goals, experience, health declaration,
  injuries) → plan rendered day by day (REQ037) → Save / Regenerate / Edit.
- **Mandatory safety copy:** the paper's Scope says the system "does not
  provide medical diagnosis". Every plan carries that disclaimer.

### Phase 3 — Email notifications + member self-service

- `EmailService` has only `sendMemberJoin` (which replaced `sendMagicLink` with
  counter sign-up), `sendStaffInvite` and `sendLeadNotification`. Add
  renewal-due / expiring-soon / expired notices, sent from
  `membership-nightly.job.ts`, recording `emailSent` the way leads do. The
  nightly job now also raises a console notification, so the two should be
  designed together rather than duplicating each other.
- **`PATCH /me` + `/portal/profile`** — members cannot edit their own contact
  details at all today; there is no `PATCH /me`, and the RBAC spec specified
  one (`docs/superpowers/specs/2026-08-16-rbac-auth-design.md:414`). **REQ009.**
- Member Settings page (Figure 13's nav).
- Real coach messaging: small `Message` model, member ↔ assigned coach only.
  The coach side lands on the Phase 1 coach dashboard, which is built.

### Phase 4 — paper amendments

`docs/paper-amendments.md` is written and was updated this session with the
audit trail and the notification board. Update it as later phases land.

---

## 5. Small things left on the floor, deliberately

- **One nav rename is left, and the other was superseded.** `/admin/revenue` →
  Analytics is still approved and still undone; route renames touch the nav,
  the titles, every internal link and any bookmark staff already have, so it
  belongs in its own commit rather than buried in a feature.
  `/admin/subscriptions` → Memberships is **moot**: that screen was merged into
  `/admin/members` (one table, subscription columns folded in, `sort=ending`
  carrying the renewal call sheet). The old URL redirects — `next.config.ts` —
  because stored `SystemNotification.linkPath` rows in production still point
  at it.
- **`GET /check-ins` is unscoped**, and its own comment says "`checkin.read`
  at ALL, which FRONT_DESK, COACH and ADMIN hold". The registry grants COACH
  `checkin.read` at **OWN** (`permission-registry.ts`). So a coach calling
  that route reads every member's attendance, not just their assigned members'.
  The comment is stale and the route never applies a scope filter. Not touched
  this session — it is an RBAC change on a shared route, and it deserves its
  own commit and its own test. The new `/me/coaching/*` routes deliberately do
  not depend on it.

---

## 6. Requirement scoreboard

**Built:** REQ001, 002, 003, 005, 007, 008, 010, 011, 012, 015, 016, 022, 025,
026, 027, 030, 036 — plus **REQ013, 014, 020, 021 closed this session**.

**Partial:** REQ006 (no Trial — being struck), REQ009 (no `PATCH /me`),
REQ017 (no experience level or member-authored health input), REQ032
(< 1 s check-in is unmeasured; design budgets ≤ 1.5 s p95).

**Missing:** REQ004 / REQ028 / REQ029 (OTP + idle logout — being struck from
the paper per owner decision #3 in the design spec), REQ018 / REQ019 (workout
generator — Phase 2), REQ034 (bounded for the assistant only so far).

---

## 7. Test state

Green: **973 jest**, **193 vitest**, server and client typecheck, both
platform build paths, `server/dist/main.js` emitted. Full gate run from the
committed tree at `1decb1e`.

**e2e: 387 of 389.** Two failures, both pre-existing and both a *design
question rather than a defect*. Do not "fix" either without asking the owner:

- `checkin.e2e-spec.ts` — "never lets a suspended account reach the door"
  expects a **403** from `POST /checkin`, and expects no `StationScan` row.
- `soft-delete.e2e-spec.ts` — expects **403** from `GET /me` for a suspended
  account.

Both assert an earlier design that the code deliberately reversed, with the
reasoning written down in each place:

- `auth.guard.ts` lets SUSPENDED through on **"C1's binding ruling: suspend
  blocks CHECK-IN ONLY, not portal login"**.
- `POST /checkin` returns **200 in every business outcome including denials**
  (`CLAUDE.md`), because `client/src/lib/api.ts` throws on `!body.success` and
  a 4xx reaches a member's phone as a bare `Error`.
- The station slot is claimed **before** the verdict, by presentation, on
  purpose (§6.11.1).

**No reason leaks to the member either way.** `denialMemberCopy` maps
`ACCOUNT_SUSPENDED` to vague copy, and the staff-directive form travels on a
different HTTP response, so the member's body is structurally incapable of
carrying it. The question is only whether a suspended self-scan should be a
403 or a 200-with-vague-denial. That is the owner's call.

Two other e2e specs failed at the start of this session and were fixed here:
the CheckIn CHECK list had never been extended for the guest-waiver or
converted-guest migrations, and the walk-in guest route still asserted that
the front desk lacks `member.create`, which Phase 0 granted per REQ005.

---

## 8. Gotchas that cost time — do not rediscover

- **E2E database:** `npm run test:e2e --workspace=server` needs the docker
  Postgres `got-chunk0-e2e-v2` (port 5546) **running** — `docker start
  got-chunk0-e2e-v2` first, else globalSetup dies with P1001. After a new
  migration, run `prisma migrate deploy` **and** `prisma db seed` against it
  with `DATABASE_URL`/`DIRECT_URL` set inline from `.env.test` — the Prisma
  CLI does its own dotenv load and knows nothing about `TEST_DATABASE_URL`.
- **Client tests must run from `client/`** (`cd client && npx vitest run`).
  From the repo root the jsdom config is missed and `deviceCache` tests fail
  with "window is not defined".
- **`prisma migrate dev` refuses** against the shared dev database (checksum
  drift on `20260820010000_chunk2_station_attendance`) and offers only a
  reset. **Hand-write migration SQL** and apply with `prisma migrate deploy`,
  as every migration since `20260827010000_payment_void_kind` has done.
- **`next build` fails while `next dev` is running** — stop dev servers and
  `rm -rf client/.next` first. If `rm` says "Directory not empty", the dev
  server still holds it; retry in a loop until it clears.
- **Bash heredocs mangle content.** They choke on some TSX, and they silently
  ate a backslash inside a SQL `CHECK` this session, turning
  `strpos(x, '\')` into `strpos(x, '')`. Use the Write tool for anything with
  escapes or JSX. Where SQL genuinely needs a backslash, write `chr(92)` —
  it survives every layer.
- Money is **integer centavos**; the server never emits a formatted peso
  string. Times render **12-hour**; stored `HH:mm` stays 24-hour because
  `closesAt <= opensAt` is a lexicographic correctness check.
- `DeskMember` is a **privacy boundary** — do not widen it. Guest phone and
  emergency contact travel only on the `member.create`-gated
  `GET /front-desk/check-ins/:id/guest`.
- The portal must **not** import `adminApi`. It is the console's surface and a
  coach never reaches the console. `lib/coachApi.ts` is the portal's own, and
  `civilDate` now lives in `lib/gymTime.ts` and is re-exported from `adminApi`
  under its old name so the console's call sites are untouched.

---

## 9. Test accounts

`ysa+admin@test.com`, `ysa+frontdesk@test.com`, `ysa+coach@test.com`,
`ysa+client@test.com` — password `Pass123!`.
`npm run seed:showcase --workspace=server` loads demo data tagged
`[showcase]` (undoable).

**To demo the coach dashboard** the coach account needs assigned members and
classes: sign in as admin, use `/admin/coaches` → Assign a coach, and
`/admin/classes` → Schedule a class with that coach named.

**To demo the audit log** something dangerous has to happen first — the log is
forward-only and the screen will honestly say it is empty. Void a payment or
change a plan price before the defense.

## 10. Deployment note

Railway's free trial ended; the API host is undecided. Analysis given to the
owner: **Render** free tier is the easiest migration but sleeps after 15 min
(cold start hurts the 5 AM first scan — mitigate with a free pinger);
**Google Cloud Run** is genuinely free at this scale and faster to wake but
needs a Dockerfile (none exists yet — only `railway.json`); **Fly.io** is
~$2-5/month and simplest to keep always-on. The app has a live **SSE feed**
and an **in-process nightly scheduler**, so anything that scales to zero
needs an external cron. Supabase free projects also pause after ~1 week of
inactivity — wake it before a defense demo.
