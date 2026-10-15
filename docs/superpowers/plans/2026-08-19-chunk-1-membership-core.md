# Chunk 1 — Membership Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the gym a commercial model — plans, memberships, terms, freezes, payments and a cash drawer — and the accessVerdict() helper that answers "may this person train today" from dates rather than a status column a missed cron job can falsify.

**Architecture:** The pure core (anniversary arithmetic, the door ladder, the transition table) is separated from Prisma so §5.12's test contract can hit it directly; persistence, HTTP and the nightly job are layered on top. One migration carries all six models plus the hand-written SQL Prisma cannot express.

**Tech Stack:** NestJS 11, Prisma 6 (folder-based schema), Supabase Postgres, class-validator DTOs, @nestjs/schedule, Next.js 16 client.

**Spec:** `docs/superpowers/specs/2026-08-18-membership-attendance-design.md` §5

**Builds on:** `docs/superpowers/plans/2026-08-18-chunk-0-foundations.md` (complete, 29 commits). **Read its "Carried into Chunk 1" section before starting** — it is binding.

---

## Global Constraints

- MembershipStatus has exactly four values: ACTIVE, EXPIRED, FROZEN, CANCELLED. No PAST_DUE, no GRACE, no PENDING_CANCELLATION, no TRIAL, no EXPIRING. Notice of cancellation is Membership.cancelRequestedOn, a nullable @db.Date on an otherwise ACTIVE row.
- Grace is a date, not a status. Grace end is `today <= addDays(endsOn, graceDays)`, computed. There is NO graceEndsOn column. Membership.graceDays is snapshotted at purchase from Plan.graceDays so the bound exists from the moment the membership is sold, not from the moment a job notices it lapsed.
- R1 — Dates are the authority; stored status is a materialised convenience. accessVerdict() never trusts Membership.status alone; it recomputes from endsOn, graceDays and the hold window on every call. The nightly job is an optimiser, never a gatekeeper.
- R2 — Business dates are @db.Date holding a gym-local civil date; instants are @db.Timestamptz(3). Membership.startsOn/endsOn, MembershipHold.startsOn/endsOn, Payment.termStartsOn/termEndsOn, Payment.businessDate, Membership.joinedOn/cancelRequestedOn/cancelledOn are DATE. Payment.receivedAt, MembershipEvent.effectiveAt and every createdAt/updatedAt are timestamptz. civilDateFromPrisma() in server/src/common/time/gym-time.ts is the ONLY place toISOString().slice(0,10) may appear.
- R3 — Money is Int centavos, and every invariant that can be a database constraint is one. No Decimal, no floats, no BigInt. Field names end in Centavos. No response body anywhere contains a formatted currency string.
- Date column naming is startsOn / endsOn on every term-bearing model. startDate, endDate and startedOn are dead vocabulary and must not appear.
- One Membership header row per member — userId @unique, forever. Renewals mutate that row. Per-term history lives on Payment.termStartsOn/termEndsOn. There is no MembershipTerm table and no sixth table.
- Partial unique indexes are deliberately not used anywhere in this chunk. "At most one X" uses a nullable-unique sentinel column (MembershipHold.activeMembershipId, Shift.openMarker) plus CHECK constraints that make the sentinel unable to lie or be omitted — Prisma introspects indexes, so a partial unique index absent from schema.prisma is drift and the next migrate emits a DROP INDEX for it.
- The transaction rule: inside prisma.$transaction, never catch a unique violation then issue another statement on the same tx — Postgres aborts and every later statement dies with 25P02. Use tx.model.createMany({ data, skipDuplicates: true }) and branch on count === 0. This applies to the Payment idempotencyKey claim, the MembershipEvent batchRef claim, and every sentinel race.
- MembershipEvent is append-only, enforced by a BEFORE UPDATE OR DELETE trigger (membership_event_append_only, ERRCODE restrict_violation), not by convention. That trigger is deliberately unmapped in CONSTRAINT_ERROR_CODES: it firing is a genuine bug and must surface as a logged 500. Test teardown must use TRUNCATE, never deleteMany.
- No hard deletes. Every relation is onDelete: Restrict. member.delete can only ever mean setting User.deletedAt.
- A denial is a 200. Business outcomes travel as payload fields, never as HTTP errors. accessVerdict() returns a value; it never throws and never mutates.
- A findOne that finds nothing under a narrowed scope returns 404 MEMBERSHIP_NOT_FOUND / PAYMENT_NOT_FOUND, never 403 — a 403 confirms the row exists.
- Every scoped repository method takes `scope: ScopedWhere<...>` as a REQUIRED parameter and ANDs it internally as `where: { AND: [filters, scope] }`. Spreading is forbidden and is a compile error. The permission key appears ONCE per route, in @RequirePermission; @Scope('subject') reads the guard's stash.
- Statutory senior-citizen and PWD discounts are mandatory (RA 9994 / RA 10754): 20% plus VAT exemption, computed by the system so staff never type a price, with the OSCA/PWD ID number recorded in Payment.statutoryIdNo. computeAmounts: gross = plan.priceCentavos; for SENIOR|PWD vatExempt = vatRegistered, vatBase = vatRegistered ? roundHalfUp(gross / 1.12) : gross, discount = roundHalfUp(vatBase * 0.20); otherwise vatExempt = false, vatBase = gross, discount = 0 for NONE else the operator amount; net = vatBase − discount. Rounding is half-up to the centavo, applied once, and all three results are stored, never recomputed on read.
- netCentavos = 0 is legal exactly when discountType IN (PROMO, STAFF, GUEST_PASS, GOODWILL). grossCentavos > 0 always. The DTO validates @IsInt() @Min(1) on grossCentavos and @Min(0) on netCentavos, matching the CHECK constraints exactly.
- Freeze bounds: Plan.freezable only (Quarterly and Annual, never Monthly); endsOn mandatory; backdating forbidden (startsOn >= today); future scheduling allowed up to today + 60 days; minimum 7 days; maximum 90 days per hold; one freeze per term (freezesUsedThisTerm); 90 days per rolling 365; one running hold (activeMembershipId @unique plus the EXCLUDE on overlapping non-cancelled windows); fee ₱100 (MEMBERSHIP_FREEZE_FEE_CENTAVOS) waived when the reason is medical; authorised by membership.freeze — ADMIN only, not FRONT_DESK; no member self-service.
- A freeze extends the term day for day, always. The extension is applied when the hold STARTS (endsOn += daysRequested, daysApplied = daysRequested) and clawed back on early release or cancellation (unused = civilDaysBetween(today, hold.endsOn); endsOn −= unused; daysApplied −= unused). Completing on time does no date arithmetic at all. A same-day freeze flips the status and applies the extension inside the creating transaction.
- Anniversary billing, zero proration. endsOn = addDays(anniversary(billingAnchorDay, startsOn, termMonths), −1) and is the INCLUSIVE last day of access. billingAnchorDay comes from the member's ORIGINAL join date and is never rewritten by month-end clamping. Renewal timing: before expiry and inside grace both start at endsOn + 1 with the anchor unchanged; after grace and after CANCELLED start at today and re-anchor, and are REACTIVATED events, not RENEWED.
- Every money-writing POST requires an Idempotency-Key header and carries @Idempotent(). The header value is also stored on the resulting Payment as idempotencyKey @unique alongside idempotencyHash (SHA-256 of the canonical body). Key unseen → 201; key seen with a matching hash → 200 with the stored row; key seen with a differing hash → 409 IDEMPOTENCY_KEY_REUSED.
- Payment.shiftId is NOT NULL and stays that way. Recording any payment with no open shift is 422 SHIFT_NOT_OPEN. Payments are immutable: no PATCH, no partial refund, no negative amounts — a mistake is VOIDED with who and why.
- Walk-ins are a CheckIn with entryType WALK_IN plus a Payment. There is NO DayPass model and none is introduced. accessVerdict takes dayPassValidToday as a boolean so this chunk has no dependency on the attendance schema; Chunk 1 ships a DayPassResolver seam returning false.
- Staff are not special at the door. There is no `if (role !== CLIENT) return ALLOW`. A coach who trains here gets a comped membership on a ₱0 STAFF-discounted payment.
- GRACE is not ALLOW. Callers that collapse the three-value AccessDecision to a boolean are rejected in review. decision 'GRACE' maps to the stored AccessVerdict.ALLOWED_IN_GRACE, 'ALLOW' to ALLOWED.
- Constraints are backstops, not validation paths: every rule they enforce is also checked in the service, so a constraint firing is a bug report. Every one is nonetheless mapped in CONSTRAINT_ERROR_CODES so a violation is never a 500 the console cannot branch on.
- `prisma db seed` is mandatory after every migrate dev / migrate deploy, and again after any edit to permission-registry.ts or plan-registry.ts. Skipping it fails closed silently.
- No operating parameter is read from process.env at a call site — everything goes through GymConfigService. Never open, read or write any .env file except .env.example, and never transcribe a secret value.
- Civil dates in DTOs use @Matches(/^\d{4}-\d{2}-\d{2}$/) or IsGymDate, never @IsDateString(). Money fields use @IsInt() with the same bounds as their CHECK constraint.
- Extend the existing scheduler job registry for the nightly job; do not write a second scheduler. PruneEphemeraJob's skip of IdempotencyRecord rows at responseStatus 0 must not be changed.

---

## Ordering and prerequisites

- ONE migration for the whole chunk: `npx prisma migrate dev --name add_membership_billing`, run from server/. Six tables plus the User delta must ship together because MembershipEvent.paymentId references Payment and Payment.shiftId references Shift. Task 6 owns it; no other task creates a migration. If a later task needs a schema change, it amends task 6's not-yet-shipped migration or, once shipped, adds a second named migration and says so in its commit.
- Hand-written SQL appended to that one migration.sql, in this order: (a) §5.8.1 — `SET TIME ZONE 'UTC';` then the four `ALTER TABLE "User" ALTER COLUMN … TYPE TIMESTAMPTZ(3) USING … AT TIME ZONE 'UTC'` casts. Prisma generates a BARE cast here and it is WRONG: a bare cast reads the session TimeZone, so running it from a machine set to Asia/Manila silently shifts every historical timestamp eight hours with no error. This is the highest-consequence statement in the project. (b) §5.8.2 — four Plan CHECKs. (c) §5.8.3 — seven Membership CHECKs, `CREATE EXTENSION IF NOT EXISTS btree_gist`, five MembershipHold CHECKs, and the `MembershipHold_no_overlap` EXCLUDE USING gist over (membershipId WITH =, daterange(startsOn, endsOn, '[]') WITH &&) WHERE status IN ('SCHEDULED','ACTIVE'). (d) §5.8.4 — the `membership_event_append_only()` function, the `MembershipEvent_append_only` BEFORE UPDATE OR DELETE trigger, and MembershipEvent's reason-required and dates-paired CHECKs. (e) §5.8.5 — six Payment CHECKs and three Shift CHECKs. Constraint NAMES are load-bearing: they are written character for character here, keyed on in CONSTRAINT_ERROR_CODES, and asserted by name in the constraint-presence suite.
- Ordering hazard: enums (task 1) before models (task 6), and models before every service. The pure core (tasks 3, 4, 5) deliberately sits BEFORE the migration because none of it imports Prisma — that is the whole point of §5.12's test contract, and it lets three authors work while the migration is still being hand-edited. If any of tasks 3–5 finds itself needing @prisma/client, the split has been drawn in the wrong place and the task should stop and say so rather than import it.
- §5.12's separation, stated explicitly for the four authors: access-verdict.ts, membership-terms.ts, membership-transitions.ts and membership-freeze-rules.ts are PURE — no clock, no Prisma, no GymConfigService, no Nest DI. Every configurable value arrives as an explicit `cfg` parameter and `today` arrives as a CivilDate argument. The loading, the transaction and the config read all live in the services (MembershipService.verdictFor, MembershipSalesService, MembershipHoldsService), which is the same split as PermissionsService/PermissionsGuard. A reviewer who sees `new Date()` or `this.gym.` in one of those four files should reject the task.
- Ordering hazard: Shift before Payment (Payment.shiftId is NOT NULL), Payment before membership sales (a sale writes a Payment in the same transaction), and the membership read surface (task 11) before every mutating task because it produces MembershipDetail, writeMembershipEvent and MembershipService.loadForUpdate that tasks 12–16 all consume.
- Ordering hazard: the state machine (task 5) and the holds service (task 14) both land before the nightly job (task 16). The job calls MembershipHoldsService.activateHoldInTx/completeHoldInTx rather than reimplementing the arithmetic — a second copy of `endsOn += daysRequested` is the exact bug §5.6.2 is written to prevent.
- Permission keys to add to server/src/rbac/permission-registry.ts (task 2), all seventeen from §5.11: plan.read (all roles ALL), plan.manage (ADMIN), membership.read (FRONT_DESK ALL, COACH OWN, ADMIN ALL), membership.sell (FRONT_DESK, ADMIN), membership.cancel.request (FRONT_DESK, ADMIN), membership.freeze (ADMIN only), membership.cancel (ADMIN, dangerous), membership.term.adjust (ADMIN, dangerous), membership.status.correct (ADMIN, dangerous), membership.import (ADMIN, dangerous), payment.read (FRONT_DESK, ADMIN), payment.record (FRONT_DESK, ADMIN), payment.discount.statutory (FRONT_DESK, ADMIN), payment.discount.grant (ADMIN), payment.void (ADMIN, dangerous), shift.manage (FRONT_DESK, ADMIN), job.run (ADMIN, dangerous). CLIENT is deliberately granted NONE of them — the member's own data is served by keyless /me/* routes with a hard-coded userId, so OWN never has to mean two different things depending on the caller's role.
- `npm run db:seed --workspace=server` must be re-run after task 2 (new permission catalogue entries and role grants), after task 6 (migration), and after task 8 (the create-only plan rows). Skipping it fails closed silently: the route 403s for an ADMIN with nothing in the logs to point at. The seed already validates the transitive `requires` closure (assertRequiresClosure), so a key granted without its prerequisites throws at seed time — that is intended, not a bug to work around.
- Adjudication, module path: §5.11 names `server/src/billing/plan-registry.ts` while §7.8 names `catalogue/` as the Chunk 1 Plan module. This plan uses `server/src/catalogue/` for the module AND for plan-registry.ts, because §7.8 is the layout Chunk 2 is written against and two directories for one model is how the import graph forks. Anyone reading §5.11 should treat `billing/` as superseded.
- Adjudication, date helpers: §5.7.1 names a new `server/src/common/time/civil-date.ts`. Chunk 0 already shipped that vocabulary in `server/src/common/time/gym-time.ts` (gymToday, addDays, civilDaysBetween, civilDateFromPrisma, toDateColumn, asCivilDate). anniversary() is added THERE. Do not create civil-date.ts; a second module means two CivilDate brands and the two runtimes stop agreeing.
- Adjudication, DenialReason: §5.2 lists six values. shared/src/types/attendance.types.ts already exports ten (the six plus STATION_TOKEN_EXPIRED, ALREADY_CHECKED_IN, CHECKIN_DAILY_LIMIT, GYM_CLOSED) and its own header states that where §5.2 disagrees, §6.0.2 wins. The Prisma enum ships with ALL TEN in Chunk 1. Mirroring the short list now and widening it later is the enum-removal migration shape that makes Prisma recreate the table and take every hand-written CHECK with it, silently.
- Adjudication, error code spelling: §5.5.3 says MEMBERSHIP_TRANSITION_INVALID; §7.2 and §7.7 say MEMBERSHIP_INVALID_TRANSITION. Use MEMBERSHIP_INVALID_TRANSITION — it is what the route table and the shared union carry, and the client switches on that string.
- AccessVerdict ships with exactly the two §5.2 values (ALLOWED, ALLOWED_IN_GRACE). §7.7 route 48 mentions an ALLOWED_OVERRIDE that §6.4.1 explicitly says does not exist (an override writes CheckInDenial.outcome = OVERRIDDEN instead). Adding an enum VALUE later is safe and additive; removing one is the dangerous shape. Do not pre-add it.
- §5.11 says every membership and payment endpoint depends on scopeFilter(), which Chunk 0 shipped. Subject 'ownedByUser' is the right ScopeSubject for Membership and Payment (both hang off User via userId). Do NOT apply notDeletedUserWhere to Membership, Payment, Shift or MembershipHold — none of them has a deletedAt column, and buildScopeWhere folds it in for subject 'user' only.
- A route may carry exactly one @RequirePermission key (getAllAndOverride means a method-level decorator REPLACES a class-level one). POST /payments therefore carries payment.record only; the additional payment.discount.statutory / payment.discount.grant check is an in-service call against PermissionsService.getEffectivePermissions, never a second decorator. Task 10 owns assertDiscountAllowed and every money-writing service calls it.
- Membership.graceAdmissionsThisTerm is INCREMENTED by Chunk 2 on every GRACE admission. Chunk 1 only ever resets it (to 0 on RENEWED/REACTIVATED, or to graceAdmissionsMax when §5.4.3's previous-term-lapsed rule fires at renewal). No Chunk 1 task increments it; a task that does has misread the split.
- OwnerSummaryPayload.membersNotSeenIn30Days is sourced from CheckIn, which does not exist until Chunk 2. It ships as `number | null` and is null in Chunk 1 so the SummaryTransport contract does not change when Chunk 2 fills it in. Same reasoning for DayPassResolver: the seam exists now, returns false now, and is swapped in Chunk 2 — which is what stops anyone `restoring` the DayPass table the name dayPassValidToday implies.
- ts-jest does NOT fail on type errors in this repo, so `npm run typecheck --workspace=server` is the only enforcement of @ts-expect-error contract proofs. Task 11 adds proofs to server/src/rbac/scope-contract.spec.ts that a Membership and a Payment repository method reject a bare Prisma.WhereInput and that spreading the scope loses the brand. Whoever wires CI must run typecheck, not just test.
- E2E runs against a database built by `prisma migrate deploy` followed by `prisma db seed`, never `db push` — db push skips migration.sql entirely, so every CHECK, the EXCLUDE and the append-only trigger would be absent and the whole integrity suite would pass against a schema that has none of them. test/support/db.ts already resets with TRUNCATE … RESTART IDENTITY CASCADE, which does not fire row triggers, so the append-only trigger needs no teardown special-casing.
- Baselines to keep green: server 29 suites / 271 tests, server e2e 37, client 53, and `npm run typecheck --workspace=server` exiting 0. `npm run lint` is already red with ~19–27 pre-existing problems — do not plan to fix them, and note server's lint script is `eslint --fix`, so it mutates the tree.
- Client work in this chunk is exactly one task (18): /portal/subscription flips fully to the live API against routes 5, 10, 11 and 12, and its mock functions are deleted in the same commit. §9.11 steps 3–6 (check-ins, dashboard, the scanner) all depend on Chunk 2's CheckIn and are out of scope. Carried forward from Chunk 0 and NOT closed here: apiFetch mints a fresh Idempotency-Key per call, so a user pressing a button twice is unprotected — that only bites on the desk console's POST /payments, which is Chunk 2's surface, and the fix belongs there.
- Deliberately not built in Chunk 1, so nobody adds them: routes 13–19 (/me/check-ins, /me/check-ins/summary, /me/desk-pin, /members*, member photo capture) — the first two need CheckIn, the rest are the desk console and ship in Chunk 2 with member.photo.capture. Also not built, per §5.10: TRIAL and PENDING_CANCELLATION statuses, a graceEndsOn column, a MembershipTerm table, PT session packs, a formal freeze approval workflow, proration and negative Payment rows, a receiptNo sequence, a GymClosure model, and a JobRun scheduler ledger.
- One residual drift hazard worth naming in the migration's comment header: if a FUTURE migration makes Prisma recreate one of these tables (it does this for certain enum-value removals), that table's CHECK and EXCLUDE constraints go with it silently, because Prisma models neither. The mitigation is task 7's constraint-presence suite running in CI against a migrate-deploy-built database — a service-level test passes whether or not the constraint is there.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `server/prisma/schema/enums.prisma` | modify | Append §5.2's eleven enums: MembershipStatus, MembershipEventType, HoldStatus, PlanKind, PaymentPurpose, PaymentMethod, PaymentStatus, DiscountType, ShiftStatus, AccessVerdict, DenialReason. Nothing else in this file changes. |
| `server/prisma/schema/user.prisma` | modify | §5.3.1: add seniorPwdIdNo, the eight back-relations, and @db.Timestamptz(3) on every existing DateTime. memberCode already exists from Chunk 0 and is not re-added. |
| `server/prisma/schema/plan.prisma` | create | §5.3.2 Plan model — the published price list, one row per product, snapshotted at purchase. |
| `server/prisma/schema/membership.prisma` | create | §5.3.3 Membership model — one header row per member (userId @unique) carrying the current term's snapshot, dates and per-term counters. |
| `server/prisma/schema/membership-event.prisma` | create | §5.3.4 MembershipEvent model — the append-only transition ledger, with @@unique([membershipId, batchRef]) for bulk idempotency. |
| `server/prisma/schema/membership-hold.prisma` | create | §5.3.5 MembershipHold model — a freeze window with the activeMembershipId nullable-unique sentinel and the daysRequested/daysApplied pair. |
| `server/prisma/schema/payment.prisma` | create | §5.3.6 Payment model — integer-centavos money, plan/term snapshot, discount shape, idempotencyKey/@unique + idempotencyHash, void columns. |
| `server/prisma/schema/shift.prisma` | create | §5.3.7 Shift model — one cash-drawer session with the openMarker nullable-unique sentinel and blind-count columns. |
| `server/prisma/schema/migrations/<ts>_add_membership_billing/migration.sql` | create | The chunk's single migration. Prisma-generated DDL for six tables + the User delta, then hand-appended §5.8.1 timestamptz USING casts, §5.8.2–§5.8.5 CHECK/EXCLUDE constraints, btree_gist, and the §5.8.4 MembershipEvent append-only trigger. |
| `server/prisma/seed.ts` | modify | Add the create-only plan pass (createMany skipDuplicates) after the permission catalogue pass. Prices are business data: never convergent, never an upsert. |
| `server/src/catalogue/plan-registry.ts` | create | The four seed Plan rows from §5.3.2's table plus seedPlans(); mirrors permission-registry.ts's shape but is CREATE-ONLY. |
| `server/src/catalogue/plans.service.ts` | create | Plan reads and admin writes: list, create, update, archive. Owns PLAN_NOT_FOUND / PLAN_ARCHIVED. |
| `server/src/catalogue/plans.controller.ts` | create | Routes 5–9: GET /plans (@Public), GET/POST /admin/plans, PATCH /admin/plans/:id, POST /admin/plans/:id/archive. |
| `server/src/catalogue/plan.presenter.ts` | create | Plan row → PublicPlan / AdminPlan projections. No formatted currency strings; centavos integers only. |
| `server/src/catalogue/catalogue.module.ts` | create | Wires the plans controller/service and exports PlansService for MembershipModule and PaymentsModule. |
| `server/src/catalogue/dto/create-plan.dto.ts` | create | CreatePlanDto — code/name/kind/priceCentavos/termMonths/freezable/graceDays/guestPassesPerTerm/perks with bounds identical to the Plan CHECKs. |
| `server/src/catalogue/dto/update-plan.dto.ts` | create | UpdatePlanDto — every CreatePlanDto field except `code`, which is the immutable snapshot key. |
| `server/src/catalogue/dto/list-plans-query.dto.ts` | create | ListPlansQueryDto — pagination plus includeInactive/kind filters. |
| `server/src/membership/access-verdict.ts` | create | §5.4 accessVerdict() — the pure door ladder. No clock, no Prisma, no config read; graceDays arrives on the snapshot. |
| `server/src/membership/access-verdict.spec.ts` | create | §5.12's access-verdict contract: all eleven §5.4.4 rows with decision+reason+offer, boundary triples, the 23:59/00:01 Manila pair, both self-heals, account-gate-beats-entitlement, entitlement-beats-membership-state, grace exhaustion. |
| `server/src/membership/membership-terms.ts` | create | §5.7.1–§5.7.4 + §5.6.2 pure arithmetic: term end from the anchor, the four renewal-timing cases, computeAmounts with half-up rounding, and hold apply/claw-back deltas. |
| `server/src/membership/membership-terms.spec.ts` | create | §5.12's membership-terms contract: the Jan-31 four-term table, the Feb-29 leap cycle to 2032, quarterly/annual from a 31st anchor, the four renewal cases, SENIOR/PWD × VAT-registered centavo results, and the four freeze-arithmetic cases. |
| `server/src/membership/membership-transitions.ts` | create | §5.5.2/§5.5.3: the TRANSITIONS table and assertTransition(), the one place a forbidden transition is refused. |
| `server/src/membership/membership-transitions.spec.ts` | create | §5.12: accepts every §5.5.2 row, rejects every §5.5.3 row with MEMBERSHIP_INVALID_TRANSITION. |
| `server/src/membership/membership-freeze-rules.ts` | create | §5.6's eligibility table as a pure assertion: plan freezable, no backdating, ≤ today+60d scheduling, 7–90 days, one per term, 90-day rolling-365 cap. |
| `server/src/membership/membership-events.ts` | create | writeMembershipEvent() — the single write path into the append-only ledger, so every mutating service logs the same shape. |
| `server/src/membership/membership.service.ts` | create | The loader half of the §5.4.1 split: loadSubject/verdictFor, membership list and findOne under @Scope, and the read projections every mutating service returns. |
| `server/src/membership/day-pass.resolver.ts` | create | The DayPassResolver seam. Chunk 1 ships NO_DAY_PASSES (always false); Chunk 2 replaces it with a WALK_IN CheckIn read. There is no DayPass table and none is introduced. |
| `server/src/membership/membership-sales.service.ts` | create | Transitions 1, 3, 4, 14, 15: sell and renew, inside one transaction with the Payment write, lazy memberCode allocation and counter resets. |
| `server/src/membership/membership-lifecycle.service.ts` | create | Transitions 5, 6, 13, 16, 17: cancellation notice and withdrawal, admin termination, comp days, and the transition-table bypass under membership.status.correct. |
| `server/src/membership/membership-holds.service.ts` | create | Transitions 7, 8, 9, 10: freeze creation (same-day applies inside the creating transaction), early release with claw-back, and the tx-level activate/complete helpers the nightly job calls. |
| `server/src/membership/membership-import.service.ts` | create | §5.5.4 and §5.5.5: the only payment-less membership creation path, and the batchRef-idempotent bulk term extension. |
| `server/src/membership/membership.presenter.ts` | create | Membership + relations → MembershipListItem / MembershipDetail / HoldView / MembershipEventView, with the verdict projected through accessVerdict so the CRM and the door can never disagree. |
| `server/src/membership/memberships.controller.ts` | create | Routes 20–30: the scoped membership read pair and every staff/admin write, one @RequirePermission key per route. |
| `server/src/membership/admin-memberships.controller.ts` | create | Routes 31–32: POST /admin/memberships/import and POST /admin/memberships/extend, both dangerous, both confirm-gated, both @Idempotent(). |
| `server/src/membership/admin-jobs.controller.ts` | create | Route 41: POST /admin/jobs/membership-nightly behind job.run — the post-downtime catch-up trigger. |
| `server/src/membership/membership-nightly.job.ts` | create | §5.9's six ordered steps as a ScheduledJob, every step a conditional UPDATE its own effect falsifies, with runFor(today) exposed for the manual trigger. |
| `server/src/membership/membership.module.ts` | create | Wires the membership controllers, services, the nightly job and the DayPassResolver token; exports MembershipService for the /me module and Chunk 2. |
| `server/src/membership/dto/create-membership.dto.ts` | create | CreateMembershipDto — userId, planCode, optional startsOn, discount block, payment block. The canonical money DTO for this chunk. |
| `server/src/membership/dto/renew-membership.dto.ts` | create | RenewMembershipDto — planCode plus the same discount and payment blocks; the server decides backdating, never the client. |
| `server/src/membership/dto/cancellation.dto.ts` | create | RequestCancellationDto and CancelMembershipDto (confirm + reason ≥ 3 chars, matching MembershipEvent_reason_required). |
| `server/src/membership/dto/freeze-membership.dto.ts` | create | FreezeMembershipDto (startsOn ≥ today, endsOn mandatory, reason, feeWaived) and UnfreezeMembershipDto. |
| `server/src/membership/dto/adjust-term.dto.ts` | create | AdjustTermDto and CorrectMembershipDto — the two dangerous admin writes, both confirm-gated with a mandatory reason. |
| `server/src/membership/dto/import-memberships.dto.ts` | create | ImportMembershipsDto (rows + confirm) and ExtendAllDto (days, reason, batchRef, confirm). |
| `server/src/membership/dto/list-memberships-query.dto.ts` | create | ListMembershipsQueryDto — pagination, status filter, expiringWithinDays, planCode, search. |
| `server/src/payments/payments.service.ts` | create | §5.7.4–§5.7.6: record, list with totals, void, and the createInTx helper membership sales reuse. Owns the discount-permission check and the SHIFT_NOT_OPEN gate. |
| `server/src/payments/payments.controller.ts` | create | Routes 33–35: GET /payments (scoped), POST /payments (@Idempotent), POST /payments/:id/void. |
| `server/src/payments/payment.presenter.ts` | create | Payment row → PaymentSummary. Every money field ends in Centavos and is an integer; no formatted currency string leaves the server. |
| `server/src/payments/shifts.service.ts` | create | §5.7.6's drawer: open, blind close with computed expected/variance, current, and requireOpenShift(tx) — the single source of SHIFT_NOT_OPEN. |
| `server/src/payments/shifts.controller.ts` | create | Routes 38–40: POST /shifts/open, POST /shifts/:id/close (@Idempotent), GET /shifts/current. |
| `server/src/payments/shift.presenter.ts` | create | Shift row → ShiftView / ShiftClosure. The expected figure is only ever present on the close response, never before the count. |
| `server/src/payments/reports.service.ts` | create | §5.7.4/§5.7.6 registers: the BIR statutory-discount register and the GCash reference list, plus the OwnerSummaryPayload builder step 6 hands to the transport. |
| `server/src/payments/reports.controller.ts` | create | Routes 36–37: GET /reports/statutory-discounts and GET /reports/gcash, both IsGymDate-bounded. |
| `server/src/payments/summary-transport.ts` | create | §5.9.4's one-method SummaryTransport interface plus the v1 LoggingSummaryTransport, so email/Viber/SMS is a provider swap. |
| `server/src/payments/payments.module.ts` | create | Wires payments, shifts, reports and the summary transport; exports PaymentsService and ShiftsService to MembershipModule. |
| `server/src/payments/dto/record-payment.dto.ts` | create | RecordPaymentDto — purpose, plan, discount block, method/reference, receiptNo, receivedAt. Bounds match the Payment CHECKs exactly. |
| `server/src/payments/dto/void-payment.dto.ts` | create | VoidPaymentDto — confirm + reason. |
| `server/src/payments/dto/list-payments-query.dto.ts` | create | ListPaymentsQueryDto — pagination, businessDate range, method, status, discountType, shiftId, userId. |
| `server/src/payments/dto/shift.dto.ts` | create | OpenShiftDto (openingFloatCentavos) and CloseShiftDto (blind countedCentavos, optional note). |
| `server/src/payments/dto/report-range-query.dto.ts` | create | ReportRangeQueryDto — from/to as IsGymDate civil dates, never IsDateString. |
| `server/src/me/me.controller.ts` | create | Routes 10–12: GET /me/overview, /me/membership, /me/payments — keyless, hard-coded to the caller's own userId, exactly like the existing GET /me. |
| `server/src/me/me.presenter.ts` | create | MemberOverview / MyMembership projections. /me/membership never 404s: no membership is a valid, renderable state. |
| `server/src/me/me.module.ts` | create | Wires MeController over MembershipService and PaymentsService without granting the caller any permission key. |
| `server/src/common/time/gym-time.ts` | modify | Add anniversary(anchorDay, from, months) beside addDays/civilDaysBetween. §5.11 named a new civil-date.ts; Chunk 0 already owns this vocabulary here and a second module would fork it. |
| `server/src/common/time/gym-time.spec.ts` | modify | Add the month-end clamping and anchor-recovery cases for anniversary(). |
| `server/src/common/validators/is-centavos.validator.ts` | create | IsCentavos(min, max) — one decorator whose bounds are written to match the money CHECKs, so no input the pipe accepts can be rejected by the database. |
| `server/src/common/dto/confirm.dto.ts` | create | The `confirm: true` mixin every dangerous route reuses, throwing CONFIRMATION_REQUIRED as a 400 rather than a validation message. |
| `server/src/common/exceptions/prisma-error.mapper.ts` | modify | Extend CONSTRAINT_ERROR_CODES and CONSTRAINT_MESSAGES with §5.8.6's table, and give the mapper a per-constraint HTTP status (409 vs 422) instead of a fixed 422. |
| `server/src/common/exceptions/prisma-error.mapper.spec.ts` | modify | One case per newly mapped constraint name, asserting code and status; and that the append-only trigger stays unmapped (a genuine 500). |
| `server/src/config/env.validation.ts` | modify | Add MEMBERSHIP_GRACE_ADMISSIONS_MAX, MEMBERSHIP_FREEZE_FEE_CENTAVOS, SHIFT_VARIANCE_NOTE_THRESHOLD_CENTAVOS and GYM_VAT_REGISTERED with §5.11's validation. |
| `server/src/config/gym.config.ts` | modify | Expose the four new parameters as graceAdmissionsMax, freezeFeeCentavos, shiftVarianceNoteThresholdCentavos, vatRegistered. No service reads process.env. |
| `server/src/rbac/permission-registry.ts` | modify | Add §5.11's seventeen permission keys to PERMISSION_CATALOGUE with their `requires`, and their role grants to ROLE_PERMISSIONS. |
| `server/src/rbac/permission-registry.spec.ts` | modify | Assert the new keys' dangerous flags, scopes and requires-closure, including that CLIENT is granted no membership.* or payment.* key at all. |
| `server/src/rbac/scope-contract.spec.ts` | modify | Add @ts-expect-error proofs that a Membership and a Payment repository method reject a bare WhereInput and that spreading the scope loses the brand. |
| `server/src/prisma/mirrored-enums.ts` | modify | Move seven enums out of PENDING_PRISMA_MIRRORS into MIRRORED_ENUM_PAIRS and add AccessVerdict; only CheckInMethod remains pending for Chunk 2. |
| `server/src/prisma/enum-parity.spec.ts` | modify | One it() per newly mirrored enum, in the same commit that adds the Prisma side. |
| `server/src/scheduler/scheduler.service.ts` | modify | Register MembershipNightlyJob alongside PruneEphemeraJob. One registry, one timezone, one SCHEDULER_ENABLED switch. |
| `server/src/scheduler/scheduler.module.ts` | modify | Import MembershipModule so the nightly job is injectable; PruneEphemeraJob's responseStatus-0 exclusion is untouched. |
| `server/src/app.module.ts` | modify | Register CatalogueModule, MembershipModule, PaymentsModule and MeModule in the feature list. |
| `shared/src/types/attendance.types.ts` | modify | Add the AccessVerdict enum (ALLOWED, ALLOWED_IN_GRACE). AccessDecision, AllowReason and DenialReason already live here. |
| `shared/src/types/api.types.ts` | modify | Extend DomainErrorCode with the thirteen codes this chunk throws, so no service can invent a code the client's switch does not handle. |
| `.env.example` | modify | Document the four new operating parameters with their defaults; no secret values. |
| `server/test/support/membership-fixtures.ts` | create | Builders for the membership states every e2e suite needs: active, in-grace, expired-past-grace, frozen, cancelled, no-membership, plus an open shift. |
| `server/test/membership-constraints.e2e-spec.ts` | create | §5.8.7/§11.6: one raw-SQL test per §5.8 constraint asserting the REJECTION and the mapped domain code, including the append-only trigger and both nullable-unique sentinels. |
| `server/test/plans.e2e-spec.ts` | create | Routes 5–9 end to end, plus the create-only seed proving a re-seed reverts no price. |
| `server/test/memberships.e2e-spec.ts` | create | Sell/renew/freeze/cancel/import round trips, the scope-leak matrix for GET /memberships and /memberships/:id (404 not 403), and the payments-field gating on payment.read. |
| `server/test/payments-shifts.e2e-spec.ts` | create | Idempotent sale, key-reuse 409, SHIFT_NOT_OPEN, blind close and variance, and the statutory-discount permission split. |
| `server/test/membership-nightly.e2e-spec.ts` | create | §5.12's integration requirement: run the nightly job twice against one fixture and assert identical state and no duplicated events, plus the three-day catch-up. |
| `client/src/lib/portalData.ts` | modify | Replace getSubscription()'s membership, plans and payments mocks with apiFetch calls against /me/overview, /plans and /me/payments; delete the replaced mock constants in the same commit. |
| `client/src/app/portal/subscription/page.tsx` | modify | Render the real MembershipStatus/AccessDecision vocabulary and centavos-derived amounts; no screen runs mock and live behind a flag. |
| `client/src/lib/portalData.test.ts` | create | Vitest coverage for the centavos→display formatting and the civil-date handling on the subscription screen. |

---

### Task 1: Enums, shared mirrors and parity

**Files:**
- Modify: `server/prisma/schema/enums.prisma:38` (append the eleven enums after the last line — the file ends at line 38 with `CoachAssignmentStatus`'s closing brace)
- Modify: `shared/src/types/attendance.types.ts:50` (append `AccessVerdict` at EOF)
- Modify: `server/src/prisma/mirrored-enums.ts:1-13` (imports), `:33-36` (`MIRRORED_ENUM_PAIRS`), `:46-55` (`PENDING_PRISMA_MIRRORS`), `:60-71` (`MIRRORED_SHARED_ENUMS`)
- Test: `server/src/prisma/enum-parity.spec.ts:1-3` (imports) and `:78` (append the new describe at EOF)

**Interfaces:**
- Consumes: `shared/src/types/membership.types.ts` already exports `enum MembershipStatus { ACTIVE, EXPIRED, FROZEN, CANCELLED }`, `enum PlanKind { TERM, WALK_IN }`, `enum PaymentPurpose { MEMBERSHIP, WALK_IN, FREEZE_FEE }`, `enum PaymentMethod { CASH, GCASH }`, `enum PaymentStatus { RECORDED, VOIDED }`, `enum DiscountType { NONE, SENIOR, PWD, PROMO, STAFF, GUEST_PASS, GOODWILL }`; `shared/src/types/attendance.types.ts` already exports `enum CheckInMethod`, `enum DenialReason` (10 values), `type AccessDecision = 'ALLOW' | 'GRACE' | 'DENY'`, `type AllowReason`; `server/src/prisma/mirrored-enums.ts` exports `interface MirroredEnumPair { name: string; prisma: Record<string, string>; shared: Record<string, string> }`, `const MIRRORED_ENUM_PAIRS: readonly MirroredEnumPair[]`, `const PENDING_PRISMA_MIRRORS: readonly { name: string; landsInChunk: 1 | 2 }[]`
- Produces: `enums.prisma` gains eleven enums — `MembershipStatus{ACTIVE,EXPIRED,FROZEN,CANCELLED}`, `MembershipEventType{IMPORTED,PURCHASED,RENEWED,REACTIVATED,EXPIRED,HOLD_APPLIED,HOLD_RELEASED,CANCELLATION_REQUESTED,CANCELLATION_WITHDRAWN,CANCELLED,ADJUSTED,STATUS_CORRECTED}`, `HoldStatus{SCHEDULED,ACTIVE,COMPLETED,CANCELLED}`, `PlanKind{TERM,WALK_IN}`, `PaymentPurpose{MEMBERSHIP,WALK_IN,FREEZE_FEE}`, `PaymentMethod{CASH,GCASH}`, `PaymentStatus{RECORDED,VOIDED}`, `DiscountType{NONE,SENIOR,PWD,PROMO,STAFF,GUEST_PASS,GOODWILL}`, `ShiftStatus{OPEN,CLOSED}`, `AccessVerdict{ALLOWED,ALLOWED_IN_GRACE}`, `DenialReason{NO_MEMBERSHIP,MEMBERSHIP_EXPIRED,MEMBERSHIP_FROZEN,MEMBERSHIP_CANCELLED,ACCOUNT_SUSPENDED,ACCOUNT_DEACTIVATED,STATION_TOKEN_EXPIRED,ALREADY_CHECKED_IN,CHECKIN_DAILY_LIMIT,GYM_CLOSED}`; `shared/src/types/attendance.types.ts` exports `enum AccessVerdict { ALLOWED = 'ALLOWED', ALLOWED_IN_GRACE = 'ALLOWED_IN_GRACE' }`; `MIRRORED_ENUM_PAIRS` grows to ten entries; `PENDING_PRISMA_MIRRORS` shrinks to `[{ name: 'CheckInMethod', landsInChunk: 2 }]`

- [ ] **Step 1: Write the failing parity test**

Replace lines 1-3 of `server/src/prisma/enum-parity.spec.ts` with this import block:

```typescript
import * as shared from '@got/shared';
import {
  AccessVerdict as PrismaAccessVerdict,
  DenialReason as PrismaDenialReason,
  DiscountType as PrismaDiscountType,
  MembershipStatus as PrismaMembershipStatus,
  PaymentMethod as PrismaPaymentMethod,
  PaymentPurpose as PrismaPaymentPurpose,
  PaymentStatus as PrismaPaymentStatus,
  PlanKind as PrismaPlanKind,
} from '@prisma/client';
import {
  AccessVerdict,
  CODE_ALPHABET,
  CODE_CHAR_CLASS,
  DenialReason,
  DiscountType,
  MembershipStatus,
  PaymentMethod,
  PaymentPurpose,
  PaymentStatus,
  PlanKind,
  STATION_TOKEN_REGEX,
} from '@got/shared';
import { MIRRORED_ENUM_PAIRS, PENDING_PRISMA_MIRRORS } from './mirrored-enums';
```

Then append this describe block at the end of the file (after line 78):

```typescript
/**
 * One it() per enum this chunk mirrors, in the same commit that adds the Prisma
 * side. The data-driven test above proves the TABLE agrees; these prove the
 * table names the enums a reader expects to find in it, so deleting a row is a
 * failing test rather than a silently shorter loop.
 */
describe('chunk 1 mirrored enums', () => {
  it('MembershipStatus is exactly the four spec values on both sides', () => {
    expect(Object.values(PrismaMembershipStatus).sort()).toEqual(
      ['ACTIVE', 'CANCELLED', 'EXPIRED', 'FROZEN'].sort(),
    );
    expect(Object.values(MembershipStatus).sort()).toEqual(
      Object.values(PrismaMembershipStatus).sort(),
    );
  });

  it('PlanKind matches its Prisma mirror', () => {
    expect(Object.values(PrismaPlanKind).sort()).toEqual(Object.values(PlanKind).sort());
  });

  it('PaymentPurpose matches its Prisma mirror', () => {
    expect(Object.values(PrismaPaymentPurpose).sort()).toEqual(Object.values(PaymentPurpose).sort());
  });

  it('PaymentMethod matches its Prisma mirror', () => {
    expect(Object.values(PrismaPaymentMethod).sort()).toEqual(Object.values(PaymentMethod).sort());
  });

  it('PaymentStatus matches its Prisma mirror', () => {
    expect(Object.values(PrismaPaymentStatus).sort()).toEqual(Object.values(PaymentStatus).sort());
  });

  it('DiscountType matches its Prisma mirror', () => {
    expect(Object.values(PrismaDiscountType).sort()).toEqual(Object.values(DiscountType).sort());
  });

  it('AccessVerdict ships with exactly ALLOWED and ALLOWED_IN_GRACE', () => {
    // §7.7 route 48 mentions an ALLOWED_OVERRIDE that §6.4.1 says does not
    // exist — an override writes CheckInDenial.outcome = OVERRIDDEN instead.
    // Adding an enum value later is additive; removing one makes Prisma
    // recreate the table and take every hand-written CHECK with it.
    expect(Object.values(PrismaAccessVerdict).sort()).toEqual(['ALLOWED', 'ALLOWED_IN_GRACE']);
    expect(Object.values(AccessVerdict).sort()).toEqual(Object.values(PrismaAccessVerdict).sort());
  });

  it('DenialReason ships all TEN values now, not §5.2 six', () => {
    // Mirroring the short list now and widening it in chunk 2 is the
    // enum-removal migration shape that silently drops CHECK constraints.
    expect(Object.values(PrismaDenialReason).sort()).toEqual(
      [
        'ACCOUNT_DEACTIVATED',
        'ACCOUNT_SUSPENDED',
        'ALREADY_CHECKED_IN',
        'CHECKIN_DAILY_LIMIT',
        'GYM_CLOSED',
        'MEMBERSHIP_CANCELLED',
        'MEMBERSHIP_EXPIRED',
        'MEMBERSHIP_FROZEN',
        'NO_MEMBERSHIP',
        'STATION_TOKEN_EXPIRED',
      ].sort(),
    );
    expect(Object.values(DenialReason).sort()).toEqual(Object.values(PrismaDenialReason).sort());
  });

  it('leaves only CheckInMethod pending, for chunk 2', () => {
    expect(PENDING_PRISMA_MIRRORS).toEqual([{ name: 'CheckInMethod', landsInChunk: 2 }]);
  });

  it('pairs ten enums in total', () => {
    expect(MIRRORED_ENUM_PAIRS).toHaveLength(10);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm test --workspace=server -- enum-parity`
Expected: FAIL — `TypeError: Cannot convert undefined or null to object` from `Object.values(PrismaMembershipStatus)` (the Prisma client exports no such enum yet), and `lists every enum exported by @got/shared exactly once` fails because `AccessVerdict` is not exported from `@got/shared` at all.

- [ ] **Step 3: Append the eleven enums to `enums.prisma`**

Append to `server/prisma/schema/enums.prisma` after line 38:

```prisma

// ── Membership ───────────────────────────────────────────────────────────

// A membership's lifecycle. Deliberately four values.
//
// No PAST_DUE / GRACE: grace is `today <= endsOn + graceDays`, computed from
// columns already on the row. A status for it would be a second source of
// truth that a missed nightly run silently falsifies.
//
// No PENDING_CANCELLATION: notice is `cancelRequestedOn`, a nullable date on
// an otherwise ACTIVE row. That keeps the portal's "cancel any time, no
// lock-in" promise while honouring the rule that CANCELLED denies at once.
enum MembershipStatus {
  ACTIVE
  // Term elapsed. Still admits while within the row's own graceDays.
  EXPIRED
  // Paused by a MembershipHold. Denies entry immediately, no grace.
  FROZEN
  // Terminated. Denies entry immediately, no grace. Reactivating reuses this
  // same row with a fresh, re-anchored term.
  CANCELLED
}

// Why a membership row changed. Carried alongside fromStatus/toStatus because
// the status pair alone is ambiguous — ADJUSTED and RENEWED can both leave the
// status untouched while moving endsOn. Server-side only, not mirrored.
enum MembershipEventType {
  IMPORTED
  PURCHASED
  RENEWED
  REACTIVATED
  EXPIRED
  HOLD_APPLIED
  HOLD_RELEASED
  CANCELLATION_REQUESTED
  CANCELLATION_WITHDRAWN
  CANCELLED
  ADJUSTED
  STATUS_CORRECTED
}

// Server-side only. Not mirrored: no client screen switches on it.
enum HoldStatus {
  SCHEDULED
  ACTIVE
  COMPLETED
  CANCELLED
}

// TERM plans create or extend a Membership. WALK_IN plans never do — they
// price a single day's entry and produce a Payment (and, in chunk 2, a
// WALK_IN CheckIn), nothing else.
enum PlanKind {
  TERM
  WALK_IN
}

// ── Money ────────────────────────────────────────────────────────────────

enum PaymentPurpose {
  MEMBERSHIP
  WALK_IN
  FREEZE_FEE
}

// Staff-recorded only. GCASH means "the member showed a GCash receipt and
// staff typed the reference from their screen".
enum PaymentMethod {
  CASH
  GCASH
}

// A Payment row exists because money changed hands, so there is no PENDING and
// no FAILED. Mistakes are VOIDED, never deleted, never edited.
enum PaymentStatus {
  RECORDED
  VOIDED
}

// Why the collected amount differs from the list price. SENIOR and PWD are
// statutory and mandatory (RA 9994 / RA 10754); the rest are commercial.
enum DiscountType {
  NONE
  SENIOR
  PWD
  PROMO
  STAFF
  GUEST_PASS
  GOODWILL
}

enum ShiftStatus {
  OPEN
  CLOSED
}

// ── Access ───────────────────────────────────────────────────────────────

// Stored on an admitted entry (chunk 2's CheckIn). Only ever an allow —
// refusals carry a DenialReason on their own table.
enum AccessVerdict {
  ALLOWED
  ALLOWED_IN_GRACE
}

// One DenialReason in the system, mirrored to the client because the member's
// phone and the desk's denial feed both switch on the code and never on the
// English. All TEN values ship now: §6.0.2 is the normative surface and
// widening an enum later is the migration shape that makes Prisma recreate the
// table, taking every hand-written CHECK constraint with it.
enum DenialReason {
  NO_MEMBERSHIP
  MEMBERSHIP_EXPIRED
  MEMBERSHIP_FROZEN
  MEMBERSHIP_CANCELLED
  ACCOUNT_SUSPENDED
  ACCOUNT_DEACTIVATED
  STATION_TOKEN_EXPIRED
  ALREADY_CHECKED_IN
  CHECKIN_DAILY_LIMIT
  GYM_CLOSED
}
```

- [ ] **Step 4: Regenerate the Prisma client**

Run: `cd server && npx prisma generate`
Expected: `Generated Prisma Client (v6.x)`. No migration is created — enums with no model referencing them emit types only. The migration is task 6's and no earlier task may create one.

- [ ] **Step 5: Add `AccessVerdict` to the shared package**

Append to `shared/src/types/attendance.types.ts` at EOF:

```typescript
/**
 * The stored verdict on an admitted entry. Only ever an allow — refusals carry
 * a DenialReason instead.
 *
 * Exactly two values. `decision === 'GRACE'` maps to ALLOWED_IN_GRACE and
 * `'ALLOW'` to ALLOWED; there is deliberately no ALLOWED_OVERRIDE, because an
 * override writes CheckInDenial.outcome = OVERRIDDEN and no CheckIn verdict.
 */
export enum AccessVerdict {
  ALLOWED = 'ALLOWED',
  ALLOWED_IN_GRACE = 'ALLOWED_IN_GRACE',
}
```

- [ ] **Step 6: Move seven enums into the pairs table and add AccessVerdict**

Rewrite `server/src/prisma/mirrored-enums.ts` lines 1-13 (the import block), 33-36 (`MIRRORED_ENUM_PAIRS`), 46-55 (`PENDING_PRISMA_MIRRORS`) and 60-71 (`MIRRORED_SHARED_ENUMS`) so the file reads:

```typescript
import {
  AccessVerdict as PrismaAccessVerdict,
  DenialReason as PrismaDenialReason,
  DiscountType as PrismaDiscountType,
  MembershipStatus as PrismaMembershipStatus,
  PaymentMethod as PrismaPaymentMethod,
  PaymentPurpose as PrismaPaymentPurpose,
  PaymentStatus as PrismaPaymentStatus,
  PlanKind as PrismaPlanKind,
  Role,
  UserStatus as PrismaUserStatus,
} from '@prisma/client';
import {
  AccessVerdict,
  CheckInMethod,
  DenialReason,
  DiscountType,
  MembershipStatus,
  PaymentMethod,
  PaymentPurpose,
  PaymentStatus,
  PlanKind,
  UserRole,
  UserStatus,
} from '@got/shared';
```

`MIRRORED_ENUM_PAIRS` becomes:

```typescript
export const MIRRORED_ENUM_PAIRS: readonly MirroredEnumPair[] = [
  { name: 'UserRole', prisma: Role, shared: UserRole },
  { name: 'UserStatus', prisma: PrismaUserStatus, shared: UserStatus },
  { name: 'MembershipStatus', prisma: PrismaMembershipStatus, shared: MembershipStatus },
  { name: 'PlanKind', prisma: PrismaPlanKind, shared: PlanKind },
  { name: 'PaymentPurpose', prisma: PrismaPaymentPurpose, shared: PaymentPurpose },
  { name: 'PaymentMethod', prisma: PrismaPaymentMethod, shared: PaymentMethod },
  { name: 'PaymentStatus', prisma: PrismaPaymentStatus, shared: PaymentStatus },
  { name: 'DiscountType', prisma: PrismaDiscountType, shared: DiscountType },
  { name: 'DenialReason', prisma: PrismaDenialReason, shared: DenialReason },
  { name: 'AccessVerdict', prisma: PrismaAccessVerdict, shared: AccessVerdict },
];
```

`PENDING_PRISMA_MIRRORS` and `MIRRORED_SHARED_ENUMS` become:

```typescript
export const PENDING_PRISMA_MIRRORS: readonly { name: string; landsInChunk: 1 | 2 }[] = [
  { name: 'CheckInMethod', landsInChunk: 2 },
];

// Referenced so the imports above are load-bearing rather than decorative:
// if an enum is removed from @got/shared this file stops compiling, which is a
// louder failure than a spec that silently has one fewer case.
const MIRRORED_SHARED_ENUMS = {
  MembershipStatus,
  PlanKind,
  PaymentPurpose,
  PaymentMethod,
  PaymentStatus,
  DiscountType,
  CheckInMethod,
  DenialReason,
  AccessVerdict,
} as const;
```

- [ ] **Step 7: Build shared so `tsc` and the client resolve the new export**

Run: `npm run build --workspace=shared`
Expected: exits 0, `shared/dist/types/attendance.d.ts` now declares `AccessVerdict`. Jest maps `@got/shared` to `shared/src/index.ts` and does not need this, but `npm run typecheck --workspace=server` resolves through `shared/dist/`.

- [ ] **Step 8: Run the tests and watch them pass**

Run: `npm test --workspace=server -- enum-parity`
Expected: PASS — the data-driven `%s matches its Prisma mirror` now runs ten times, the meta-test accounts for nine shared enums across the two lists, and every new `it()` is green.

- [ ] **Step 9: Run the full server suite and typecheck**

Run: `npm test --workspace=server && npm run typecheck --workspace=server`
Expected: PASS, 29 suites / 271+ tests, typecheck exits 0.

- [ ] **Step 10: Commit**

```bash
git add server/prisma/schema/enums.prisma \
        shared/src/types/attendance.types.ts \
        server/src/prisma/mirrored-enums.ts \
        server/src/prisma/enum-parity.spec.ts
git commit -m "feat(membership): the eleven chunk-1 enums, mirrored and asserted

DenialReason ships all ten §6.0.2 values now rather than §5.2's six:
widening a Prisma enum later makes it recreate the table and silently
drop every hand-written CHECK constraint with it."
```

---

### Task 2: Contract and configuration surface

**Files:**
- Modify: `shared/src/types/api.types.ts:39-69` (the `DomainErrorCode` union)
- Modify: `server/src/config/env.validation.ts:56-63` (the membership block) and `:85-93` (housekeeping/booleans)
- Modify: `server/src/config/gym.config.ts:13-27` (the `GymConfig` interface) and `:37-66` (the service fields and constructor)
- Modify: `server/src/rbac/permission-registry.ts:60-105` (`PERMISSION_CATALOGUE`) and `:117-167` (`ROLE_PERMISSIONS`)
- Modify: `.env.example:59-65` and `:81-87`
- Create: `server/src/common/validators/is-centavos.validator.ts`
- Create: `server/src/common/dto/confirm.dto.ts`
- Test: `server/src/config/env.validation.spec.ts` (modify), `server/src/rbac/permission-registry.spec.ts:55-90` (modify), `server/src/common/validators/validators.spec.ts` (modify), `server/src/common/dto/confirm.dto.spec.ts` (create)

**Interfaces:**
- Consumes: `shared/src/types/api.types.ts` exports `type DomainErrorCode = 'MEMBERSHIP_NOT_FOUND' | 'MEMBERSHIP_NOT_ACTIVE' | 'MEMBERSHIP_ALREADY_FROZEN' | 'MEMBERSHIP_NOT_FROZEN' | 'MEMBERSHIP_ALREADY_CANCELLED' | 'MEMBER_HAS_NO_MEMBERSHIP' | 'PLAN_NOT_FOUND' | 'PLAN_ARCHIVED' | 'PAYMENT_NOT_FOUND' | 'PAYMENT_ALREADY_VOIDED' | 'PAYMENT_AMOUNT_MISMATCH' | 'STATUTORY_ID_REQUIRED' | 'CONFIRMATION_REQUIRED' | 'HOLD_OVERLAPS' | 'HOLD_LIMIT_EXCEEDED' | 'SHIFT_NOT_OPEN' | 'SHIFT_ALREADY_OPEN' | 'IDEMPOTENCY_KEY_REUSED' | …`; `server/src/config/gym.config.ts` exports `interface GymConfig { timeZone; openTime; closeTime; graceDays; expiringSoonDays; freezeMinDays; freezeMaxDays; freezeAnnualCapDays; stationTokenSlotSeconds; stationTokenBatchSize; checkinMinSessionMinutes; idempotencyRetentionHours; schedulerEnabled }`; `server/src/rbac/permission-registry.ts` exports `define(key, description, options?)` (module-private), `PERMISSION_CATALOGUE`, `ROLE_PERMISSIONS`, `assertRequiresKeysExist`, `assertRequiresClosure`; `server/src/common/exceptions/domain.exception.ts` exports `class DomainException extends HttpException { constructor(code: DomainErrorCode, message: string, status?: HttpStatus) }`
- Produces: `DomainErrorCode` additionally admits `'MEMBERSHIP_INVALID_TRANSITION' | 'MEMBERSHIP_FREEZE_LIMIT' | 'MEMBERSHIP_STATE_INVALID' | 'MEMBER_NOT_FOUND' | 'MEMBER_ALREADY_IMPORTED' | 'PLAN_NOT_FREEZABLE' | 'FREEZE_ALREADY_USED_THIS_TERM' | 'FREEZE_WINDOW_INVALID' | 'GCASH_REFERENCE_REQUIRED' | 'DISCOUNT_ID_REQUIRED' | 'PAYMENT_SHAPE_INVALID' | 'SHIFT_ALREADY_CLOSED' | 'SHIFT_VARIANCE_REASON_REQUIRED'`; `Env` gains `MEMBERSHIP_GRACE_ADMISSIONS_MAX` (int 0–14, default 3), `MEMBERSHIP_FREEZE_FEE_CENTAVOS` (int 0–100000, default 10000), `SHIFT_VARIANCE_NOTE_THRESHOLD_CENTAVOS` (int ≥ 0, default 20000), `GYM_VAT_REGISTERED` (`z.enum(['true','false']).transform(v => v === 'true')`, default false); `GymConfig`/`GymConfigService` gain `readonly graceAdmissionsMax: number`, `readonly freezeFeeCentavos: number`, `readonly shiftVarianceNoteThresholdCentavos: number`, `readonly vatRegistered: boolean`; `PERMISSION_CATALOGUE` gains the seventeen §5.11 keys with their `requires`, `ROLE_PERMISSIONS` gains §5.11's grants exactly (CLIENT gets none of the membership/payment keys); `server/src/common/validators/is-centavos.validator.ts` exports `function IsCentavos(min: number, max: number, options?: ValidationOptions): PropertyDecorator`; `server/src/common/dto/confirm.dto.ts` exports `abstract class ConfirmDto { confirm!: true }` and `function assertConfirmed(dto: { confirm?: boolean }): void`

- [ ] **Step 1: Write the failing env + config test**

In `server/src/config/env.validation.spec.ts`, add these four assertions inside the existing `it('applies every documented default')` block (after the `MEMBERSHIP_FREEZE_ANNUAL_CAP_DAYS` line):

```typescript
    expect(env.MEMBERSHIP_GRACE_ADMISSIONS_MAX).toBe(3);
    expect(env.MEMBERSHIP_FREEZE_FEE_CENTAVOS).toBe(10000);
    expect(env.SHIFT_VARIANCE_NOTE_THRESHOLD_CENTAVOS).toBe(20000);
    expect(env.GYM_VAT_REGISTERED).toBe(false);
```

Add this describe block immediately after the existing `describe('SCHEDULER_ENABLED', …)` block, still inside `describe('envValidationSchema', …)`:

```typescript
  describe('chunk 1 operating parameters', () => {
    it('accepts the bounds of MEMBERSHIP_GRACE_ADMISSIONS_MAX', () => {
      expect(parse({ MEMBERSHIP_GRACE_ADMISSIONS_MAX: '0' }).MEMBERSHIP_GRACE_ADMISSIONS_MAX).toBe(
        0,
      );
      expect(parse({ MEMBERSHIP_GRACE_ADMISSIONS_MAX: '14' }).MEMBERSHIP_GRACE_ADMISSIONS_MAX).toBe(
        14,
      );
    });

    it('rejects MEMBERSHIP_GRACE_ADMISSIONS_MAX above 14', () => {
      expect(() => parse({ MEMBERSHIP_GRACE_ADMISSIONS_MAX: '15' })).toThrow(
        /MEMBERSHIP_GRACE_ADMISSIONS_MAX/,
      );
    });

    it('rejects a freeze fee outside 0..100000 centavos', () => {
      expect(() => parse({ MEMBERSHIP_FREEZE_FEE_CENTAVOS: '-1' })).toThrow(
        /MEMBERSHIP_FREEZE_FEE_CENTAVOS/,
      );
      expect(() => parse({ MEMBERSHIP_FREEZE_FEE_CENTAVOS: '100001' })).toThrow(
        /MEMBERSHIP_FREEZE_FEE_CENTAVOS/,
      );
      expect(parse({ MEMBERSHIP_FREEZE_FEE_CENTAVOS: '0' }).MEMBERSHIP_FREEZE_FEE_CENTAVOS).toBe(0);
    });

    it('rejects a negative variance threshold', () => {
      expect(() => parse({ SHIFT_VARIANCE_NOTE_THRESHOLD_CENTAVOS: '-1' })).toThrow(
        /SHIFT_VARIANCE_NOTE_THRESHOLD_CENTAVOS/,
      );
    });

    it("parses GYM_VAT_REGISTERED as the STRING 'true'/'false', never z.coerce.boolean", () => {
      expect(parse({ GYM_VAT_REGISTERED: 'true' }).GYM_VAT_REGISTERED).toBe(true);
      expect(parse({ GYM_VAT_REGISTERED: 'false' }).GYM_VAT_REGISTERED).toBe(false);
      expect(() => parse({ GYM_VAT_REGISTERED: '1' })).toThrow(/GYM_VAT_REGISTERED/);
    });
  });
```

And in the existing `describe('GymConfigService')`, add to `it('exposes every gym setting in typed form')`:

```typescript
    expect(gym.graceAdmissionsMax).toBe(3);
    expect(gym.freezeFeeCentavos).toBe(10000);
    expect(gym.shiftVarianceNoteThresholdCentavos).toBe(20000);
    expect(gym.vatRegistered).toBe(false);
```

- [ ] **Step 2: Run the env test and watch it fail**

Run: `npm test --workspace=server -- env.validation`
Expected: FAIL — `expect(received).toBe(expected) // Expected: 3, Received: undefined` on `env.MEMBERSHIP_GRACE_ADMISSIONS_MAX`, and `expect(parse({ GYM_VAT_REGISTERED: '1' })).toThrow` fails because an unknown key is simply ignored by the schema.

- [ ] **Step 3: Add the four env vars**

In `server/src/config/env.validation.ts`, extend the membership block (after line 63, `MEMBERSHIP_FREEZE_ANNUAL_CAP_DAYS`):

```typescript
    // How many times one term may be admitted on grace before the door stops
    // saying yes. Without a ceiling a monthly member trains three free days
    // every cycle, forever.
    MEMBERSHIP_GRACE_ADMISSIONS_MAX: z.coerce.number().int().min(0).max(14).default(3),
    // ₱100. A freeze is pure days-owed liability with zero retention upside in
    // a prepaid cash gym, so it has a visible price — waived when medical.
    MEMBERSHIP_FREEZE_FEE_CENTAVOS: z.coerce.number().int().min(0).max(100000).default(10000),
```

And after `IDEMPOTENCY_RETENTION_HOURS` (line 87):

```typescript
    // ±₱200. Beyond this the closing staffer must type a note explaining the
    // difference, which is the only thing that makes a blind count useful.
    SHIFT_VARIANCE_NOTE_THRESHOLD_CENTAVOS: z.coerce.number().int().min(0).default(20000),
    // Drives the statutory senior/PWD computation: a VAT-registered seller
    // nets out the 12% before applying the 20% discount. NOT
    // z.coerce.boolean(), which maps the string "false" to true.
    GYM_VAT_REGISTERED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
```

- [ ] **Step 4: Expose the four on `GymConfigService`**

In `server/src/config/gym.config.ts`, add to the `GymConfig` interface after `freezeAnnualCapDays` and to the class fields/constructor in the same order:

```typescript
  graceAdmissionsMax: number;
  freezeFeeCentavos: number;
  shiftVarianceNoteThresholdCentavos: number;
  vatRegistered: boolean;
```

```typescript
  readonly graceAdmissionsMax: number;
  readonly freezeFeeCentavos: number;
  readonly shiftVarianceNoteThresholdCentavos: number;
  readonly vatRegistered: boolean;
```

```typescript
    this.graceAdmissionsMax = config.get('MEMBERSHIP_GRACE_ADMISSIONS_MAX');
    this.freezeFeeCentavos = config.get('MEMBERSHIP_FREEZE_FEE_CENTAVOS');
    this.shiftVarianceNoteThresholdCentavos = config.get('SHIFT_VARIANCE_NOTE_THRESHOLD_CENTAVOS');
    this.vatRegistered = config.get('GYM_VAT_REGISTERED');
```

- [ ] **Step 5: Run the env test and watch it pass**

Run: `npm test --workspace=server -- env.validation`
Expected: PASS.

- [ ] **Step 6: Document the four in `.env.example`**

In `.env.example`, extend the membership block (after line 65) and the housekeeping block (after line 83):

```bash
MEMBERSHIP_GRACE_ADMISSIONS_MAX=3    # int 0-14, admissions on grace per term
MEMBERSHIP_FREEZE_FEE_CENTAVOS=10000 # int 0-100000, ₱100; waived when medical
```

```bash
# Cash drawer. A blind close beyond ±this figure demands a written note.
SHIFT_VARIANCE_NOTE_THRESHOLD_CENTAVOS=20000  # int >= 0, ₱200

# Is the gym VAT-registered? Drives the statutory senior/PWD computation:
# registered sellers net out the 12% before the 20% discount. Literal string.
GYM_VAT_REGISTERED="false"
```

- [ ] **Step 7: Write the failing DomainErrorCode + permission-registry test**

Append to `server/src/rbac/permission-registry.spec.ts` at EOF:

```typescript
describe('chunk 1 permission keys', () => {
  const byKey = new Map(PERMISSION_CATALOGUE.map((def) => [def.key, def]));

  const expected: ReadonlyArray<[string, boolean, string[]]> = [
    ['plan.read', false, []],
    ['plan.manage', false, ['plan.read']],
    ['membership.read', false, []],
    ['membership.sell', false, ['membership.read', 'payment.record']],
    ['membership.cancel.request', false, ['membership.read']],
    ['membership.freeze', false, ['membership.read']],
    ['membership.cancel', true, ['membership.read']],
    ['membership.term.adjust', true, ['membership.read']],
    ['membership.status.correct', true, ['membership.read']],
    ['membership.import', true, ['membership.read', 'member.create']],
    ['payment.read', false, []],
    ['payment.record', false, []],
    ['payment.discount.statutory', false, ['payment.record']],
    ['payment.discount.grant', false, ['payment.record']],
    ['payment.void', true, ['payment.read', 'payment.record']],
    ['shift.manage', false, ['payment.read']],
    ['job.run', true, []],
  ];

  it.each(expected)('%s carries its dangerous flag and requires', (key, isDangerous, requires) => {
    const def = byKey.get(key);
    expect(def).toBeDefined();
    expect(def?.isDangerous).toBe(isDangerous);
    expect(def?.requires).toEqual(requires);
  });

  it('adds exactly seventeen keys', () => {
    expect(expected).toHaveLength(17);
    for (const [key] of expected) expect(byKey.has(key)).toBe(true);
  });

  // The member's own membership and payment history is served by keyless
  // /me/* routes with a hard-coded userId, exactly like GET /me — so OWN never
  // has to mean two different things depending on the caller's role.
  it('grants CLIENT no membership.* or payment.* key at all', () => {
    for (const grant of ROLE_PERMISSIONS.CLIENT) {
      expect(grant.key.startsWith('membership.')).toBe(false);
      expect(grant.key.startsWith('payment.')).toBe(false);
      expect(grant.key.startsWith('shift.')).toBe(false);
    }
  });

  it('grants plan.read to every seeded role at ALL', () => {
    for (const grants of Object.values(ROLE_PERMISSIONS)) {
      expect(grants.find((g) => g.key === 'plan.read')).toEqual({ key: 'plan.read', scope: 'ALL' });
    }
  });

  it('grants membership.read to COACH only at OWN', () => {
    expect(ROLE_PERMISSIONS.COACH.find((g) => g.key === 'membership.read')?.scope).toBe('OWN');
    expect(ROLE_PERMISSIONS.FRONT_DESK.find((g) => g.key === 'membership.read')?.scope).toBe('ALL');
    expect(ROLE_PERMISSIONS.ADMIN.find((g) => g.key === 'membership.read')?.scope).toBe('ALL');
  });

  // §5.6: this is the load-bearing rule — it moves the "no" off the desk and
  // onto the owner. FRONT_DESK holding it would make every freeze a one-tap yes.
  it('grants membership.freeze to ADMIN only, never FRONT_DESK', () => {
    expect(ROLE_PERMISSIONS.FRONT_DESK.some((g) => g.key === 'membership.freeze')).toBe(false);
    expect(ROLE_PERMISSIONS.ADMIN.some((g) => g.key === 'membership.freeze')).toBe(true);
  });

  it('grants the discretionary discount key to ADMIN only, the statutory one to FRONT_DESK too', () => {
    expect(ROLE_PERMISSIONS.FRONT_DESK.some((g) => g.key === 'payment.discount.statutory')).toBe(
      true,
    );
    expect(ROLE_PERMISSIONS.FRONT_DESK.some((g) => g.key === 'payment.discount.grant')).toBe(false);
    expect(ROLE_PERMISSIONS.ADMIN.some((g) => g.key === 'payment.discount.grant')).toBe(true);
  });

  it('keeps the requires closure intact for every seeded role', () => {
    expect(() => assertRequiresClosure(PERMISSION_CATALOGUE, ROLE_PERMISSIONS)).not.toThrow();
    expect(() => assertRequiresKeysExist(PERMISSION_CATALOGUE)).not.toThrow();
  });
});
```

- [ ] **Step 8: Run the registry test and watch it fail**

Run: `npm test --workspace=server -- permission-registry`
Expected: FAIL — `expect(received).toBeDefined()` on `byKey.get('plan.read')`, seventeen times over.

- [ ] **Step 9: Add the seventeen keys to the catalogue**

In `server/src/rbac/permission-registry.ts`, insert into `PERMISSION_CATALOGUE` after the `member.*` block (line 65) and before `checkin.self`:

```typescript
  define('plan.read', 'View the published price list'),
  define('plan.manage', 'Create, edit and archive plans', { requires: ['plan.read'] }),

  define('membership.read', 'View memberships'),
  define('membership.sell', 'Sell or renew a membership', {
    requires: ['membership.read', 'payment.record'],
  }),
  define('membership.cancel.request', 'Record or withdraw notice of cancellation', {
    requires: ['membership.read'],
  }),
  // ADMIN only, deliberately not FRONT_DESK: this is what moves the "no" off
  // the desk staff and onto the owner.
  define('membership.freeze', 'Freeze or release a membership', {
    requires: ['membership.read'],
  }),
  define('membership.cancel', 'Terminate a membership', {
    isDangerous: true,
    requires: ['membership.read'],
  }),
  define('membership.term.adjust', 'Move a term end date — comp days and closures', {
    isDangerous: true,
    requires: ['membership.read'],
  }),
  define('membership.status.correct', 'Override the membership transition table', {
    isDangerous: true,
    requires: ['membership.read'],
  }),
  define('membership.import', 'Load the legacy member base', {
    isDangerous: true,
    requires: ['membership.read', 'member.create'],
  }),

  define('payment.read', 'View payments'),
  define('payment.record', 'Record a payment'),
  // Statutory and mandatory (RA 9994 / RA 10754), so the desk must be able to
  // ring it without a manager or the till never reconciles.
  define('payment.discount.statutory', 'Apply a senior-citizen or PWD discount', {
    requires: ['payment.record'],
  }),
  define('payment.discount.grant', 'Apply a discretionary discount', {
    requires: ['payment.record'],
  }),
  define('payment.void', 'Void a recorded payment', {
    isDangerous: true,
    requires: ['payment.read', 'payment.record'],
  }),
  define('shift.manage', 'Open and close the cash drawer', { requires: ['payment.read'] }),

  define('job.run', 'Trigger a scheduled job by hand', { isDangerous: true }),
```

- [ ] **Step 10: Add the role grants**

In the same file, add to `ROLE_PERMISSIONS`. `CLIENT` gains only `plan.read`:

```typescript
  CLIENT: [
    { key: 'checkin.self', scope: 'OWN' },
    { key: 'ai.chat.use', scope: 'OWN' },
    { key: 'ai.chat.history.read', scope: 'OWN' },
    { key: 'announcement.read', scope: 'ALL' },
    { key: 'plan.read', scope: 'ALL' },
  ],
```

`FRONT_DESK` gains the desk's selling surface:

```typescript
    { key: 'plan.read', scope: 'ALL' },
    { key: 'membership.read', scope: 'ALL' },
    { key: 'membership.sell', scope: 'ALL' },
    { key: 'membership.cancel.request', scope: 'ALL' },
    { key: 'payment.read', scope: 'ALL' },
    { key: 'payment.record', scope: 'ALL' },
    { key: 'payment.discount.statutory', scope: 'ALL' },
    { key: 'shift.manage', scope: 'ALL' },
```

`COACH` gains reads only:

```typescript
    { key: 'plan.read', scope: 'ALL' },
    { key: 'membership.read', scope: 'OWN' },
```

`ADMIN` gains everything:

```typescript
    { key: 'plan.read', scope: 'ALL' },
    { key: 'plan.manage', scope: 'ALL' },
    { key: 'membership.read', scope: 'ALL' },
    { key: 'membership.sell', scope: 'ALL' },
    { key: 'membership.cancel.request', scope: 'ALL' },
    { key: 'membership.freeze', scope: 'ALL' },
    { key: 'membership.cancel', scope: 'ALL' },
    { key: 'membership.term.adjust', scope: 'ALL' },
    { key: 'membership.status.correct', scope: 'ALL' },
    { key: 'membership.import', scope: 'ALL' },
    { key: 'payment.read', scope: 'ALL' },
    { key: 'payment.record', scope: 'ALL' },
    { key: 'payment.discount.statutory', scope: 'ALL' },
    { key: 'payment.discount.grant', scope: 'ALL' },
    { key: 'payment.void', scope: 'ALL' },
    { key: 'shift.manage', scope: 'ALL' },
    { key: 'job.run', scope: 'ALL' },
```

- [ ] **Step 11: Run the registry test and watch it pass**

Run: `npm test --workspace=server -- permission-registry`
Expected: PASS. In particular `keeps the requires closure intact` proves FRONT_DESK holds `payment.record` alongside `membership.sell`, and ADMIN holds `member.create` alongside `membership.import`.

- [ ] **Step 12: Re-run the seed so the new keys exist in the database**

Run: `npm run db:seed --workspace=server`
Expected: the permission catalogue pass reports 17 new `Permission` rows and the role grants are rewritten. **This is mandatory** — skipping it fails closed silently: `/admin/plans` 403s even for an ADMIN, with nothing in the logs to point at.

- [ ] **Step 13: Widen `DomainErrorCode` with the thirteen codes this chunk throws**

In `shared/src/types/api.types.ts`, insert into the union (keeping the existing entries) so the membership, plan, payment and shift groups read:

```typescript
  | 'MEMBERSHIP_NOT_FOUND'
  | 'MEMBERSHIP_NOT_ACTIVE'
  | 'MEMBERSHIP_ALREADY_FROZEN'
  | 'MEMBERSHIP_NOT_FROZEN'
  | 'MEMBERSHIP_ALREADY_CANCELLED'
  | 'MEMBERSHIP_INVALID_TRANSITION'
  | 'MEMBERSHIP_FREEZE_LIMIT'
  | 'MEMBERSHIP_STATE_INVALID'
  | 'MEMBER_HAS_NO_MEMBERSHIP'
  | 'MEMBER_NOT_FOUND'
  | 'MEMBER_ALREADY_IMPORTED'
  | 'PLAN_NOT_FOUND'
  | 'PLAN_ARCHIVED'
  | 'PLAN_NOT_FREEZABLE'
  | 'FREEZE_ALREADY_USED_THIS_TERM'
  | 'FREEZE_WINDOW_INVALID'
  | 'PAYMENT_NOT_FOUND'
  | 'PAYMENT_ALREADY_VOIDED'
  | 'PAYMENT_AMOUNT_MISMATCH'
  | 'PAYMENT_SHAPE_INVALID'
  | 'GCASH_REFERENCE_REQUIRED'
  | 'DISCOUNT_ID_REQUIRED'
  | 'STATUTORY_ID_REQUIRED'
  | 'CONFIRMATION_REQUIRED'
  | 'SHIFT_NOT_OPEN'
  | 'SHIFT_ALREADY_OPEN'
  | 'SHIFT_ALREADY_CLOSED'
  | 'SHIFT_VARIANCE_REASON_REQUIRED'
```

Leave `STATION_*`, `GYM_CLOSED`, `CHECKIN_*`, `HOLD_*`, `IDEMPOTENCY_KEY_REUSED` and `COACH_*` exactly where they are.

Run: `npm run build --workspace=shared`
Expected: exits 0.

- [ ] **Step 14: Write the failing IsCentavos and ConfirmDto tests**

Append to `server/src/common/validators/validators.spec.ts` (and add `import { IsCentavos } from './is-centavos.validator';` to its import block, plus the class beside the existing DTOs):

```typescript
class MoneyDto {
  @IsCentavos(1, 100_000_000)
  grossCentavos!: number;
}

describe('IsCentavos', () => {
  it('accepts a realistic monthly price in integer centavos', () => {
    expect(errorsFor(MoneyDto, { grossCentavos: 80000 })).toEqual([]);
  });

  it('accepts the walk-in price at the lower bound of a sale', () => {
    expect(errorsFor(MoneyDto, { grossCentavos: 9000 })).toEqual([]);
  });

  it('rejects a fractional centavo', () => {
    expect(errorsFor(MoneyDto, { grossCentavos: 8000.5 })).toEqual(['isInt']);
  });

  it('rejects zero when the bound says a gross must be positive', () => {
    // grossCentavos > 0 always: a ₱0 collection still carries the list price
    // it was discounted from.
    expect(errorsFor(MoneyDto, { grossCentavos: 0 })).toEqual(['min']);
  });

  it('rejects a value above the CHECK constraint ceiling', () => {
    expect(errorsFor(MoneyDto, { grossCentavos: 100_000_001 })).toEqual(['max']);
  });

  it('coerces a numeric string, because the pipe converts before validating', () => {
    expect(errorsFor(MoneyDto, { grossCentavos: '220000' })).toEqual([]);
  });
});
```

Create `server/src/common/dto/confirm.dto.spec.ts`:

```typescript
import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../exceptions/domain.exception';
import { assertConfirmed } from './confirm.dto';

describe('assertConfirmed', () => {
  it('passes when confirm is exactly true', () => {
    expect(() => assertConfirmed({ confirm: true })).not.toThrow();
  });

  it.each([{ confirm: false }, { confirm: undefined }, {}])('throws for %p', (dto) => {
    expect(() => assertConfirmed(dto)).toThrow(DomainException);
  });

  it('throws CONFIRMATION_REQUIRED as a 400, not a validation message', () => {
    // A dangerous route that 400s with "confirm must be true" reads like a
    // client bug. CONFIRMATION_REQUIRED is a code the console can branch on to
    // re-open its own are-you-sure dialog.
    try {
      assertConfirmed({});
      throw new Error('assertConfirmed did not throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainException);
      expect((error as DomainException).code).toBe('CONFIRMATION_REQUIRED');
      expect((error as DomainException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    }
  });
});
```

- [ ] **Step 15: Run both and watch them fail**

Run: `npm test --workspace=server -- "validators|confirm.dto"`
Expected: FAIL — `Cannot find module './is-centavos.validator'` and `Cannot find module './confirm.dto'`.

- [ ] **Step 16: Write `is-centavos.validator.ts`**

Create `server/src/common/validators/is-centavos.validator.ts`:

```typescript
import { applyDecorators } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import type { ValidationOptions } from 'class-validator';

/**
 * Money, as an integer number of centavos.
 *
 * The bounds are written to match the money CHECK constraint on the column the
 * field lands in, so there is no input the pipe accepts that the database then
 * rejects — a 422 from a CHECK is a bug report, never a user-facing path.
 *
 * No Decimal, no BigInt (Prisma maps it to JS BigInt, which JSON.stringify
 * throws on, and every response passes through TransformInterceptor), no
 * floats. int4 caps at ₱21,474,836.47 per row against a largest published
 * price of ₱7,500.
 *
 * Note that enableImplicitConversion coerces by the reflected design type
 * BEFORE validators run, so `{"grossCentavos": "80000"}` passes @IsInt().
 * Input is lenient and storage is strict; that is why the Min/Max pair is not
 * optional here.
 */
export function IsCentavos(
  min: number,
  max: number,
  options?: ValidationOptions,
): PropertyDecorator {
  return applyDecorators(
    Type(() => Number),
    IsInt({ message: '$property must be a whole number of centavos', ...options }),
    Min(min, options),
    Max(max, options),
  );
}
```

- [ ] **Step 17: Write `confirm.dto.ts`**

Create `server/src/common/dto/confirm.dto.ts`:

```typescript
import { HttpStatus } from '@nestjs/common';
import { IsBoolean, IsOptional } from 'class-validator';
import { DomainException } from '../exceptions/domain.exception';

/**
 * The `confirm: true` mixin every dangerous route reuses.
 *
 * Deliberately NOT `@Equals(true)`: that makes a missing confirmation a
 * ValidationPipe 400 carrying "confirm must be equal to true", which reads like
 * a client bug and gives the console nothing to branch on. The property is
 * optional to the pipe and mandatory to the service, so the refusal is a
 * CONFIRMATION_REQUIRED code the are-you-sure dialog can re-open on.
 *
 * The declared type is `true` rather than `boolean | undefined` because that is
 * the only value a request which has passed assertConfirmed can carry. The gap
 * between the type and the wire is exactly one call, at the top of the handler.
 */
export abstract class ConfirmDto {
  @IsOptional()
  @IsBoolean()
  confirm!: true;
}

/** Throws CONFIRMATION_REQUIRED (400) unless `confirm` is exactly `true`. */
export function assertConfirmed(dto: { confirm?: boolean }): void {
  if (dto.confirm !== true) {
    throw new DomainException(
      'CONFIRMATION_REQUIRED',
      'This action is irreversible and requires "confirm": true.',
      HttpStatus.BAD_REQUEST,
    );
  }
}
```

- [ ] **Step 18: Run everything and watch it pass**

Run: `npm test --workspace=server && npm run typecheck --workspace=server`
Expected: PASS — 31 suites green (the new `confirm.dto.spec.ts` plus the existing 30), typecheck exits 0.

- [ ] **Step 19: Commit**

```bash
git add shared/src/types/api.types.ts \
        server/src/config/env.validation.ts \
        server/src/config/env.validation.spec.ts \
        server/src/config/gym.config.ts \
        server/src/rbac/permission-registry.ts \
        server/src/rbac/permission-registry.spec.ts \
        server/src/common/validators/is-centavos.validator.ts \
        server/src/common/validators/validators.spec.ts \
        server/src/common/dto/confirm.dto.ts \
        server/src/common/dto/confirm.dto.spec.ts \
        .env.example
git commit -m "feat(rbac,config): chunk 1 permission keys, error codes and money DTO primitives

Seventeen keys from §5.11 with their requires-closure, four operating
parameters behind GymConfigService, thirteen DomainErrorCodes, and the
IsCentavos/ConfirmDto pair every money and dangerous route reuses.

Requires \`npm run db:seed --workspace=server\` — the seed is the only live
grant path and skipping it 403s an ADMIN silently."
```

---

### Task 3: Pure billing core — anniversary, renewal timing, money, freeze arithmetic

**Files:**
- Modify: `server/src/common/time/gym-time.ts:58-67` (add `anniversary()` after `civilDaysBetween`)
- Modify: `server/src/common/time/gym-time.spec.ts:92` (append the `anniversary` describe after the `civilDaysBetween` block)
- Create: `server/src/membership/membership-terms.ts`
- Test: `server/src/membership/membership-terms.spec.ts`

**Interfaces:**
- Consumes: `server/src/common/time/gym-time.ts` exports `type CivilDate`, `gymToday(now, timeZone)`, `toDateColumn(day)`, `civilDateFromPrisma(d)`, `addDays(day, n)`, `civilDaysBetween(a, b)`, `asCivilDate(value)`; `@got/shared` exports `enum MembershipStatus` and `enum DiscountType` (task 1)
- Produces: `gym-time.ts` exports `function anniversary(anchorDay: number, from: CivilDate, months: number): CivilDate`; `membership-terms.ts` exports `termEndsOn(anchorDay, startsOn, termMonths): CivilDate`, `graceEndsOn(endsOn, graceDays): CivilDate`, `type TermKind = 'FIRST_TERM' | 'RENEWAL_BEFORE_EXPIRY' | 'RENEWAL_IN_GRACE' | 'REACTIVATION'`, `interface CurrentTerm { status: MembershipStatus; endsOn: CivilDate; graceDays: number; billingAnchorDay: number }`, `interface PlannedTerm { kind: TermKind; startsOn: CivilDate; endsOn: CivilDate; billingAnchorDay: number }`, `planTerm(current, today, termMonths): PlannedTerm`, `interface Amounts { grossCentavos; vatBaseCentavos; discountCentavos; netCentavos; vatExempt }`, `interface AmountsInput { priceCentavos; discountType; vatRegistered; operatorDiscountCentavos? }`, `computeAmounts(input): Amounts`, `roundHalfUp(value): number`, `holdDaysRequested(startsOn, endsOn): number`, `interface HoldDelta { endsOnDaysDelta: number; daysAppliedDelta: number }`, `holdStartDelta(daysRequested): HoldDelta`, `holdClawBackDelta(hold, today): HoldDelta`, `holdCompleteDelta(): HoldDelta`

- [ ] **Step 1: Write the failing `anniversary` test**

Append to `server/src/common/time/gym-time.spec.ts` after the `civilDaysBetween` describe (line 92), and add `anniversary` to the import list on line 2:

```typescript
describe('anniversary', () => {
  // §5.7.2 — the anchor comes from the member's ORIGINAL join date and is
  // never rewritten by clamping. Without it a 31st joiner clamps to Feb 28 and
  // then bills on the 28th forever.
  const clamping: ReadonlyArray<[number, string, number, string]> = [
    [31, '2027-01-31', 1, '2027-02-28'],
    [31, '2027-02-28', 1, '2027-03-31'],
    [31, '2027-03-31', 1, '2027-04-30'],
    [31, '2027-04-30', 1, '2027-05-31'],
    [30, '2027-01-30', 1, '2027-02-28'],
    [15, '2027-01-15', 1, '2027-02-15'],
    [31, '2027-01-31', 3, '2027-04-30'],
    [31, '2027-01-31', 12, '2028-01-31'],
    [1, '2026-12-01', 1, '2027-01-01'],
  ];

  it.each(clamping)('anchor %i from %s + %i months is %s', (anchor, from, months, expected) => {
    expect(anniversary(anchor, asCivilDate(from), months)).toBe(expected);
  });

  it('recovers the anchor after a clamp instead of drifting', () => {
    const clamped = anniversary(31, asCivilDate('2027-01-31'), 1);
    expect(clamped).toBe('2027-02-28');
    expect(anniversary(31, clamped, 1)).toBe('2027-03-31');
  });

  it('walks a full leap cycle and returns the 29th in 2032', () => {
    const a2029 = anniversary(29, asCivilDate('2028-02-29'), 12);
    const a2030 = anniversary(29, a2029, 12);
    const a2031 = anniversary(29, a2030, 12);
    const a2032 = anniversary(29, a2031, 12);
    expect([a2029, a2030, a2031, a2032]).toEqual([
      '2029-02-28',
      '2030-02-28',
      '2031-02-28',
      '2032-02-29',
    ]);
  });

  it('crosses a year boundary', () => {
    expect(anniversary(15, asCivilDate('2026-12-15'), 1)).toBe('2027-01-15');
  });

  it.each([0, 32, 1.5, -1])('rejects an impossible anchor day %p', (anchor) => {
    expect(() => anniversary(anchor, asCivilDate('2026-08-19'), 1)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test --workspace=server -- gym-time`
Expected: FAIL — `TypeError: (0 , gym_time_1.anniversary) is not a function`.

- [ ] **Step 3: Implement `anniversary()`**

Insert into `server/src/common/time/gym-time.ts` after `civilDaysBetween` (line 67):

```typescript
/**
 * The same day-of-month `months` out, clamped to that month's last day.
 *
 * `anchorDay` is the member's ORIGINAL join day-of-month and is passed in
 * rather than read off `from`, which is the whole point: each term computes
 * from the anchor, not from the previous clamped date, so a 31st joiner who
 * clamps to Feb 28 recovers the 31st in March instead of billing on the 28th
 * forever (§5.7.2).
 *
 * Date.UTC normalises a month index past 11 into the following year, so no
 * year arithmetic is written here. Day 0 of month+1 is the last day of month.
 */
export function anniversary(anchorDay: number, from: CivilDate, months: number): CivilDate {
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw new RangeError(`${JSON.stringify(anchorDay)} is not a day-of-month anchor (1..31)`);
  }
  if (!Number.isInteger(months)) {
    throw new RangeError(`${JSON.stringify(months)} is not a whole number of months`);
  }
  const base = toDateColumn(from);
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth() + months;
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return civilDateFromPrisma(new Date(Date.UTC(year, month, Math.min(anchorDay, lastDayOfMonth))));
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test --workspace=server -- gym-time`
Expected: PASS.

- [ ] **Step 5: Commit the date helper**

```bash
git add server/src/common/time/gym-time.ts server/src/common/time/gym-time.spec.ts
git commit -m "feat(time): anniversary() with month-end clamping and anchor recovery

§5.7.1 named a new common/time/civil-date.ts; chunk 0 already owns this
vocabulary here and a second module would fork the CivilDate brand."
```

- [ ] **Step 6: Write the failing membership-terms test**

Create `server/src/membership/membership-terms.spec.ts`:

```typescript
import { DiscountType, MembershipStatus } from '@got/shared';
import { asCivilDate } from '../common/time/gym-time';
import type { CivilDate } from '../common/time/gym-time';
import {
  computeAmounts,
  graceEndsOn,
  holdClawBackDelta,
  holdCompleteDelta,
  holdDaysRequested,
  holdStartDelta,
  planTerm,
  roundHalfUp,
  termEndsOn,
} from './membership-terms';
import type { CurrentTerm } from './membership-terms';

const d = (value: string): CivilDate => asCivilDate(value);

describe('termEndsOn', () => {
  // §5.7.2's four-term Jan-31 table. endsOn is the INCLUSIVE last day of
  // access: anniversary(anchor, startsOn, months) minus one day.
  const jan31: ReadonlyArray<[string, string]> = [
    ['2027-01-31', '2027-02-27'],
    ['2027-02-28', '2027-03-30'],
    ['2027-03-31', '2027-04-29'],
    ['2027-04-30', '2027-05-30'],
  ];

  it.each(jan31)('monthly from a 31st anchor: %s ends %s', (startsOn, expected) => {
    expect(termEndsOn(31, d(startsOn), 1)).toBe(expected);
  });

  it('runs a quarterly term from a 31st anchor', () => {
    expect(termEndsOn(31, d('2027-01-31'), 3)).toBe('2027-04-29');
  });

  it('runs an annual term from a 31st anchor', () => {
    expect(termEndsOn(31, d('2027-01-31'), 12)).toBe('2028-01-30');
  });

  it('runs an annual term across the leap cycle', () => {
    expect(termEndsOn(29, d('2028-02-29'), 12)).toBe('2029-02-27');
    expect(termEndsOn(29, d('2031-02-28'), 12)).toBe('2032-02-28');
  });

  it('runs a plain monthly term from a mid-month anchor', () => {
    expect(termEndsOn(19, d('2026-08-19'), 1)).toBe('2026-09-18');
  });
});

describe('graceEndsOn', () => {
  it('is endsOn plus the row own graceDays, never a stored column', () => {
    expect(graceEndsOn(d('2026-09-18'), 3)).toBe('2026-09-21');
  });

  it('is endsOn itself when the plan grants no grace', () => {
    expect(graceEndsOn(d('2026-09-18'), 0)).toBe('2026-09-18');
  });
});

describe('planTerm', () => {
  const current: CurrentTerm = {
    status: MembershipStatus.ACTIVE,
    endsOn: d('2026-09-18'),
    graceDays: 3,
    billingAnchorDay: 19,
  };

  it('FIRST_TERM starts today and anchors to today', () => {
    expect(planTerm(null, d('2026-08-19'), 1)).toEqual({
      kind: 'FIRST_TERM',
      startsOn: '2026-08-19',
      endsOn: '2026-09-18',
      billingAnchorDay: 19,
    });
  });

  it('RENEWAL_BEFORE_EXPIRY starts at endsOn + 1 and keeps the anchor', () => {
    // Early renewal must never cost days: `today + 1 month` punishes the gym's
    // best-behaved members.
    expect(planTerm(current, d('2026-09-10'), 1)).toEqual({
      kind: 'RENEWAL_BEFORE_EXPIRY',
      startsOn: '2026-09-19',
      endsOn: '2026-10-18',
      billingAnchorDay: 19,
    });
  });

  it('RENEWAL_BEFORE_EXPIRY still applies on the last day of the term', () => {
    expect(planTerm(current, d('2026-09-18'), 1).kind).toBe('RENEWAL_BEFORE_EXPIRY');
  });

  it('RENEWAL_IN_GRACE backdates to endsOn + 1 and keeps the anchor', () => {
    const expired: CurrentTerm = { ...current, status: MembershipStatus.EXPIRED };
    expect(planTerm(expired, d('2026-09-20'), 1)).toEqual({
      kind: 'RENEWAL_IN_GRACE',
      startsOn: '2026-09-19',
      endsOn: '2026-10-18',
      billingAnchorDay: 19,
    });
  });

  it('RENEWAL_IN_GRACE holds on the very last grace day', () => {
    const expired: CurrentTerm = { ...current, status: MembershipStatus.EXPIRED };
    expect(planTerm(expired, d('2026-09-21'), 1).kind).toBe('RENEWAL_IN_GRACE');
  });

  it('REACTIVATION starts today and RE-ANCHORS once grace has run out', () => {
    const expired: CurrentTerm = { ...current, status: MembershipStatus.EXPIRED };
    expect(planTerm(expired, d('2026-09-22'), 1)).toEqual({
      kind: 'REACTIVATION',
      startsOn: '2026-09-22',
      endsOn: '2026-10-21',
      billingAnchorDay: 22,
    });
  });

  it('REACTIVATION applies after CANCELLED even inside the old grace window', () => {
    // Status beats dates here: a cancelled membership has no term to extend.
    const cancelled: CurrentTerm = { ...current, status: MembershipStatus.CANCELLED };
    expect(planTerm(cancelled, d('2026-09-20'), 1)).toEqual({
      kind: 'REACTIVATION',
      startsOn: '2026-09-20',
      endsOn: '2026-10-19',
      billingAnchorDay: 20,
    });
  });

  it('REACTIVATION after CANCELLED re-anchors to a later date', () => {
    const cancelled: CurrentTerm = { ...current, status: MembershipStatus.CANCELLED };
    expect(planTerm(cancelled, d('2026-10-05'), 1)).toEqual({
      kind: 'REACTIVATION',
      startsOn: '2026-10-05',
      endsOn: '2026-11-04',
      billingAnchorDay: 5,
    });
  });

  it('plans a quarterly renewal before expiry', () => {
    expect(planTerm(current, d('2026-09-10'), 3)).toEqual({
      kind: 'RENEWAL_BEFORE_EXPIRY',
      startsOn: '2026-09-19',
      endsOn: '2026-12-18',
      billingAnchorDay: 19,
    });
  });
});

describe('roundHalfUp', () => {
  it.each([
    [0.5, 1],
    [1.5, 2],
    [2.5, 3],
    [1.4999, 1],
    [8035.714285714286, 8036],
    [0, 0],
  ])('rounds %p to %i', (value, expected) => {
    expect(roundHalfUp(value)).toBe(expected);
  });
});

describe('computeAmounts', () => {
  it('SENIOR on a monthly plan, VAT-registered', () => {
    // 80000 / 1.12 = 71428.571… → 71429; 20% of that = 14285.8 → 14286.
    expect(
      computeAmounts({
        priceCentavos: 80000,
        discountType: DiscountType.SENIOR,
        vatRegistered: true,
      }),
    ).toEqual({
      grossCentavos: 80000,
      vatBaseCentavos: 71429,
      discountCentavos: 14286,
      netCentavos: 57143,
      vatExempt: true,
    });
  });

  it('PWD on a monthly plan, NOT VAT-registered', () => {
    expect(
      computeAmounts({
        priceCentavos: 80000,
        discountType: DiscountType.PWD,
        vatRegistered: false,
      }),
    ).toEqual({
      grossCentavos: 80000,
      vatBaseCentavos: 80000,
      discountCentavos: 16000,
      netCentavos: 64000,
      vatExempt: false,
    });
  });

  it('SENIOR on a walk-in, VAT-registered', () => {
    expect(
      computeAmounts({ priceCentavos: 9000, discountType: DiscountType.SENIOR, vatRegistered: true }),
    ).toEqual({
      grossCentavos: 9000,
      vatBaseCentavos: 8036,
      discountCentavos: 1607,
      netCentavos: 6429,
      vatExempt: true,
    });
  });

  it('PWD on a quarterly plan, VAT-registered', () => {
    expect(
      computeAmounts({
        priceCentavos: 220000,
        discountType: DiscountType.PWD,
        vatRegistered: true,
      }),
    ).toEqual({
      grossCentavos: 220000,
      vatBaseCentavos: 196429,
      discountCentavos: 39286,
      netCentavos: 157143,
      vatExempt: true,
    });
  });

  it('SENIOR on an annual plan, VAT-registered', () => {
    expect(
      computeAmounts({
        priceCentavos: 750000,
        discountType: DiscountType.SENIOR,
        vatRegistered: true,
      }),
    ).toEqual({
      grossCentavos: 750000,
      vatBaseCentavos: 669643,
      discountCentavos: 133929,
      netCentavos: 535714,
      vatExempt: true,
    });
  });

  it('SENIOR on an annual plan, NOT VAT-registered', () => {
    expect(
      computeAmounts({
        priceCentavos: 750000,
        discountType: DiscountType.SENIOR,
        vatRegistered: false,
      }),
    ).toEqual({
      grossCentavos: 750000,
      vatBaseCentavos: 750000,
      discountCentavos: 150000,
      netCentavos: 600000,
      vatExempt: false,
    });
  });

  it('NONE charges the list price and never exempts VAT', () => {
    expect(
      computeAmounts({ priceCentavos: 80000, discountType: DiscountType.NONE, vatRegistered: true }),
    ).toEqual({
      grossCentavos: 80000,
      vatBaseCentavos: 80000,
      discountCentavos: 0,
      netCentavos: 80000,
      vatExempt: false,
    });
  });

  it('a STAFF comp is a full discount down to zero, on the full list price', () => {
    // netCentavos = 0 is legal exactly for PROMO/STAFF/GUEST_PASS/GOODWILL —
    // this is what lets a coach who trains here hold a comped membership
    // instead of a role bypass at the door.
    expect(
      computeAmounts({
        priceCentavos: 80000,
        discountType: DiscountType.STAFF,
        vatRegistered: true,
        operatorDiscountCentavos: 80000,
      }),
    ).toEqual({
      grossCentavos: 80000,
      vatBaseCentavos: 80000,
      discountCentavos: 80000,
      netCentavos: 0,
      vatExempt: false,
    });
  });

  it('a PROMO with no operator amount discounts nothing', () => {
    expect(
      computeAmounts({
        priceCentavos: 220000,
        discountType: DiscountType.PROMO,
        vatRegistered: false,
      }).netCentavos,
    ).toBe(220000);
  });

  it('refuses an operator discount larger than the base', () => {
    expect(() =>
      computeAmounts({
        priceCentavos: 80000,
        discountType: DiscountType.GOODWILL,
        vatRegistered: false,
        operatorDiscountCentavos: 80001,
      }),
    ).toThrow(/PAYMENT_AMOUNT_MISMATCH|discount/i);
  });

  it('net = vatBase − discount in every branch', () => {
    const inputs = [
      DiscountType.NONE,
      DiscountType.SENIOR,
      DiscountType.PWD,
      DiscountType.PROMO,
      DiscountType.STAFF,
      DiscountType.GUEST_PASS,
      DiscountType.GOODWILL,
    ];
    for (const discountType of inputs) {
      for (const vatRegistered of [true, false]) {
        const amounts = computeAmounts({
          priceCentavos: 220000,
          discountType,
          vatRegistered,
          operatorDiscountCentavos: 5000,
        });
        expect(amounts.netCentavos).toBe(amounts.vatBaseCentavos - amounts.discountCentavos);
        expect(Number.isInteger(amounts.netCentavos)).toBe(true);
        expect(amounts.grossCentavos).toBeGreaterThan(0);
        expect(amounts.netCentavos).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('freeze arithmetic', () => {
  it('counts an inclusive hold window', () => {
    expect(holdDaysRequested(d('2026-09-01'), d('2026-09-30'))).toBe(30);
    expect(holdDaysRequested(d('2026-09-01'), d('2026-09-07'))).toBe(7);
  });

  it('applies the whole window when the hold STARTS', () => {
    // Applied at start, not at booking: booking-time application banks days a
    // member has not yet given up, and with a cancellable hold that is a
    // two-call loop that mints free membership.
    expect(holdStartDelta(30)).toEqual({ endsOnDaysDelta: 30, daysAppliedDelta: 30 });
  });

  it('does no arithmetic at all when a hold completes on time', () => {
    expect(holdCompleteDelta()).toEqual({ endsOnDaysDelta: 0, daysAppliedDelta: 0 });
  });

  it('claws back exactly the unused days on early release', () => {
    expect(holdClawBackDelta({ endsOn: d('2026-09-30'), daysApplied: 30 }, d('2026-09-11'))).toEqual(
      { endsOnDaysDelta: -19, daysAppliedDelta: -19 },
    );
  });

  it('claws back nothing when released on the hold last day', () => {
    expect(holdClawBackDelta({ endsOn: d('2026-09-30'), daysApplied: 30 }, d('2026-09-30'))).toEqual(
      { endsOnDaysDelta: 0, daysAppliedDelta: 0 },
    );
  });

  it('claws back nothing when the job is late and today is past the window', () => {
    expect(holdClawBackDelta({ endsOn: d('2026-09-30'), daysApplied: 30 }, d('2026-10-05'))).toEqual(
      { endsOnDaysDelta: 0, daysAppliedDelta: 0 },
    );
  });

  it('cancelling a hold that never started claws back nothing, because nothing was applied', () => {
    expect(holdClawBackDelta({ endsOn: d('2026-09-30'), daysApplied: 0 }, d('2026-08-20'))).toEqual({
      endsOnDaysDelta: 0,
      daysAppliedDelta: 0,
    });
  });

  it('can never claw back more than was applied, so applying twice is unrepresentable', () => {
    const delta = holdClawBackDelta({ endsOn: d('2026-12-31'), daysApplied: 7 }, d('2026-09-01'));
    expect(delta.daysAppliedDelta).toBe(-7);
    expect(delta.endsOnDaysDelta).toBe(-7);
  });
});
```

- [ ] **Step 7: Run it and watch it fail**

Run: `npm test --workspace=server -- membership-terms`
Expected: FAIL — `Cannot find module './membership-terms' from 'src/membership/membership-terms.spec.ts'`.

- [ ] **Step 8: Implement `membership-terms.ts`**

Create `server/src/membership/membership-terms.ts`:

```typescript
import { HttpStatus } from '@nestjs/common';
import { DiscountType, MembershipStatus } from '@got/shared';
import { DomainException } from '../common/exceptions/domain.exception';
import { addDays, anniversary, civilDaysBetween } from '../common/time/gym-time';
import type { CivilDate } from '../common/time/gym-time';

/**
 * The pure billing core: anniversary arithmetic, renewal timing, statutory
 * money and freeze deltas.
 *
 * PURE. No clock, no Prisma, no GymConfigService, no Nest DI. `today` arrives
 * as an argument and every configurable value arrives on an input object. The
 * loading, the transaction and the config read live in the services, which is
 * the same split as PermissionsService / PermissionsGuard. A reviewer who sees
 * `new Date()` or `this.gym.` in this file should reject the change.
 */

/** The INCLUSIVE last day of access for a term. */
export function termEndsOn(
  anchorDay: number,
  startsOn: CivilDate,
  termMonths: number,
): CivilDate {
  return addDays(anniversary(anchorDay, startsOn, termMonths), -1);
}

/**
 * The last day the door still admits after a term elapsed.
 *
 * Computed, never stored: a stored copy goes stale the moment the nightly job
 * misses a run, which is the exact failure this chunk is designed to survive.
 */
export function graceEndsOn(endsOn: CivilDate, graceDays: number): CivilDate {
  return addDays(endsOn, graceDays);
}

export type TermKind =
  | 'FIRST_TERM'
  | 'RENEWAL_BEFORE_EXPIRY'
  | 'RENEWAL_IN_GRACE'
  | 'REACTIVATION';

export interface CurrentTerm {
  status: MembershipStatus;
  endsOn: CivilDate;
  graceDays: number;
  billingAnchorDay: number;
}

export interface PlannedTerm {
  kind: TermKind;
  startsOn: CivilDate;
  endsOn: CivilDate;
  billingAnchorDay: number;
}

function dayOfMonth(day: CivilDate): number {
  return Number(day.slice(8, 10));
}

/**
 * §5.7.3's four cases, decided by the SERVER — the client never sends a start
 * date.
 *
 * Before expiry and inside grace both start at `endsOn + 1` with the anchor
 * unchanged: early renewal must never cost days, and a member admitted on
 * grace days consumed them. After grace and after CANCELLED are restarts, not
 * renewals — they begin today and re-anchor, and churn reporting depends on
 * the distinction.
 */
export function planTerm(
  current: CurrentTerm | null,
  today: CivilDate,
  termMonths: number,
): PlannedTerm {
  if (current === null) {
    const anchor = dayOfMonth(today);
    return {
      kind: 'FIRST_TERM',
      startsOn: today,
      endsOn: termEndsOn(anchor, today, termMonths),
      billingAnchorDay: anchor,
    };
  }

  if (current.status !== MembershipStatus.CANCELLED) {
    const continuous =
      today <= current.endsOn || today <= graceEndsOn(current.endsOn, current.graceDays);
    if (continuous) {
      const startsOn = addDays(current.endsOn, 1);
      return {
        kind: today <= current.endsOn ? 'RENEWAL_BEFORE_EXPIRY' : 'RENEWAL_IN_GRACE',
        startsOn,
        endsOn: termEndsOn(current.billingAnchorDay, startsOn, termMonths),
        billingAnchorDay: current.billingAnchorDay,
      };
    }
  }

  const anchor = dayOfMonth(today);
  return {
    kind: 'REACTIVATION',
    startsOn: today,
    endsOn: termEndsOn(anchor, today, termMonths),
    billingAnchorDay: anchor,
  };
}

export interface Amounts {
  grossCentavos: number;
  vatBaseCentavos: number;
  discountCentavos: number;
  netCentavos: number;
  vatExempt: boolean;
}

export interface AmountsInput {
  priceCentavos: number;
  discountType: DiscountType;
  vatRegistered: boolean;
  operatorDiscountCentavos?: number;
}

/** Half-up to the centavo. Every money value in this system is non-negative. */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

/**
 * §5.7.4. Staff never type an amount for a statutory discount: they select the
 * type and enter the OSCA/PWD ID, and this computes. Rounding is applied ONCE
 * and all three results are stored, never recomputed on read.
 */
export function computeAmounts(input: AmountsInput): Amounts {
  const grossCentavos = input.priceCentavos;

  if (input.discountType === DiscountType.SENIOR || input.discountType === DiscountType.PWD) {
    const vatExempt = input.vatRegistered;
    const vatBaseCentavos = input.vatRegistered
      ? roundHalfUp(grossCentavos / 1.12)
      : grossCentavos;
    const discountCentavos = roundHalfUp(vatBaseCentavos * 0.2);
    return {
      grossCentavos,
      vatBaseCentavos,
      discountCentavos,
      netCentavos: vatBaseCentavos - discountCentavos,
      vatExempt,
    };
  }

  const discountCentavos =
    input.discountType === DiscountType.NONE ? 0 : (input.operatorDiscountCentavos ?? 0);

  if (!Number.isInteger(discountCentavos) || discountCentavos < 0) {
    throw new DomainException(
      'PAYMENT_AMOUNT_MISMATCH',
      'A discount must be a whole, non-negative number of centavos.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  if (discountCentavos > grossCentavos) {
    throw new DomainException(
      'PAYMENT_AMOUNT_MISMATCH',
      'A discount cannot exceed the list price — there are no negative payments.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  return {
    grossCentavos,
    vatBaseCentavos: grossCentavos,
    discountCentavos,
    netCentavos: grossCentavos - discountCentavos,
    vatExempt: false,
  };
}

export interface HoldDelta {
  endsOnDaysDelta: number;
  daysAppliedDelta: number;
}

/** An inclusive freeze window: both endpoints are frozen days. */
export function holdDaysRequested(startsOn: CivilDate, endsOn: CivilDate): number {
  return civilDaysBetween(startsOn, endsOn) + 1;
}

/** Applied when the hold STARTS, for the whole window, exactly once. */
export function holdStartDelta(daysRequested: number): HoldDelta {
  return { endsOnDaysDelta: daysRequested, daysAppliedDelta: daysRequested };
}

/**
 * Early release, or cancellation while a hold is running.
 *
 * `daysApplied` is what makes this exact rather than recomputed, and clamping
 * to it is what makes a double claw-back unrepresentable.
 */
export function holdClawBackDelta(
  hold: { endsOn: CivilDate; daysApplied: number },
  today: CivilDate,
): HoldDelta {
  const remaining = civilDaysBetween(today, hold.endsOn);
  const unused = Math.min(Math.max(remaining, 0), hold.daysApplied);
  return { endsOnDaysDelta: -unused, daysAppliedDelta: -unused };
}

/** Completing on time is a status flip and an event. No arithmetic at all. */
export function holdCompleteDelta(): HoldDelta {
  return { endsOnDaysDelta: 0, daysAppliedDelta: 0 };
}
```

- [ ] **Step 9: Run it and watch it pass**

Run: `npm test --workspace=server -- membership-terms`
Expected: PASS — all 40+ cases, including the Jan-31 table, the leap cycle to 2032, the four renewal cases and the exact SENIOR/PWD centavo results in both VAT modes.

- [ ] **Step 10: Prove the file imports no Prisma**

Run: `npx --no-install rg -n "@prisma/client|PrismaService|new Date\(|GymConfigService" server/src/membership/membership-terms.ts; echo "exit=$?"`
Expected: no matches, `exit=1`. If any of tasks 3–5 finds itself needing `@prisma/client`, the pure/impure split has been drawn in the wrong place — stop and say so rather than importing it.

- [ ] **Step 11: Commit**

```bash
git add server/src/membership/membership-terms.ts server/src/membership/membership-terms.spec.ts
git commit -m "feat(membership): the pure billing core — terms, renewal timing, money, freeze deltas

Anniversary billing with zero proration, statutory RA 9994 / RA 10754
arithmetic rounded half-up exactly once, and the apply-at-start /
claw-back-on-release freeze deltas. No clock, no Prisma, no config read."
```

---

### Task 4: accessVerdict — the pure door ladder

**Files:**
- Create: `server/src/membership/access-verdict.ts`
- Test: `server/src/membership/access-verdict.spec.ts`

**Interfaces:**
- Consumes: `server/src/common/time/gym-time.ts` exports `CivilDate`, `addDays`, `civilDaysBetween`; `@got/shared` exports `enum MembershipStatus`, `enum DenialReason`, `enum AccessVerdict`, `type AccessDecision`, `type AllowReason` (task 1); `@prisma/client` exports `UserStatus`
- Produces: `interface MembershipSnapshot { status: MembershipStatus; startsOn: CivilDate; endsOn: CivilDate; graceDays: number; graceAdmissionsThisTerm: number; cancelRequestedOn: CivilDate | null; planName: string; planPriceCentavos: number; hold: { startsOn: CivilDate; endsOn: CivilDate } | null }`; `interface AccessSubject { userStatus: UserStatus; membership: MembershipSnapshot | null; dayPassValidToday: boolean }`; `interface AccessResult { decision: AccessDecision; verdict: AccessVerdict | null; allowReason: AllowReason | null; denialReason: DenialReason | null; message: string; relevantDate: CivilDate | null; daysRemaining: number | null; graceDaysRemaining: number; offer: 'NONE' | 'RENEW' | 'UNFREEZE' | 'OVERRIDE' | 'MANAGER' }`; `interface AccessVerdictConfig { expiringSoonDays: number; graceAdmissionsMax: number }`; `function accessVerdict(subject: AccessSubject, today: CivilDate, cfg: AccessVerdictConfig): AccessResult`

- [ ] **Step 1: Write the failing eleven-row test**

Create `server/src/membership/access-verdict.spec.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccessVerdict, DenialReason, MembershipStatus } from '@got/shared';
import type { AccessDecision, AllowReason } from '@got/shared';
import { asCivilDate, gymToday } from '../common/time/gym-time';
import type { CivilDate } from '../common/time/gym-time';
import { accessVerdict } from './access-verdict';
import type { AccessSubject, AccessVerdictConfig, MembershipSnapshot } from './access-verdict';

const d = (value: string): CivilDate => asCivilDate(value);
const MANILA = 'Asia/Manila';
const CFG: AccessVerdictConfig = { expiringSoonDays: 7, graceAdmissionsMax: 3 };

function snapshot(overrides: Partial<MembershipSnapshot> = {}): MembershipSnapshot {
  return {
    status: MembershipStatus.ACTIVE,
    startsOn: d('2026-08-01'),
    endsOn: d('2026-08-28'),
    graceDays: 3,
    graceAdmissionsThisTerm: 0,
    cancelRequestedOn: null,
    planName: 'Monthly',
    planPriceCentavos: 80000,
    hold: null,
    ...overrides,
  };
}

function subject(overrides: Partial<AccessSubject> = {}): AccessSubject {
  return {
    userStatus: 'ACTIVE',
    membership: snapshot(),
    dayPassValidToday: false,
    ...overrides,
  };
}

describe('accessVerdict — the eleven cases the desk actually sees', () => {
  const cases: ReadonlyArray<
    [string, AccessSubject, string, AccessDecision, AllowReason | DenialReason, string]
  > = [
    [
      'active, mid-term',
      subject(),
      '2026-08-14',
      'ALLOW',
      'MEMBERSHIP_ACTIVE',
      'NONE',
    ],
    [
      'active, 5 days left',
      subject({ membership: snapshot({ endsOn: d('2026-08-31') }) }),
      '2026-08-26',
      'ALLOW',
      'MEMBERSHIP_EXPIRING_SOON',
      'RENEW',
    ],
    [
      'last day',
      subject({ membership: snapshot({ endsOn: d('2026-08-31') }) }),
      '2026-08-31',
      'ALLOW',
      'MEMBERSHIP_EXPIRES_TODAY',
      'RENEW',
    ],
    [
      'notice given, term still running',
      subject({ membership: snapshot({ cancelRequestedOn: d('2026-08-10') }) }),
      '2026-08-14',
      'ALLOW',
      'MEMBERSHIP_ENDING',
      'NONE',
    ],
    [
      'grace, one admission left',
      subject({
        membership: snapshot({
          status: MembershipStatus.EXPIRED,
          endsOn: d('2026-08-16'),
          graceAdmissionsThisTerm: 2,
        }),
      }),
      '2026-08-18',
      'GRACE',
      'MEMBERSHIP_IN_GRACE',
      'RENEW',
    ],
    [
      'expired past grace',
      subject({
        membership: snapshot({ status: MembershipStatus.EXPIRED, endsOn: d('2026-08-12') }),
      }),
      '2026-08-18',
      'DENY',
      DenialReason.MEMBERSHIP_EXPIRED,
      'RENEW',
    ],
    [
      'frozen',
      subject({
        membership: snapshot({
          status: MembershipStatus.FROZEN,
          hold: { startsOn: d('2026-08-01'), endsOn: d('2026-10-01') },
        }),
      }),
      '2026-08-18',
      'DENY',
      DenialReason.MEMBERSHIP_FROZEN,
      'OVERRIDE',
    ],
    [
      'cancelled',
      subject({
        membership: snapshot({ status: MembershipStatus.CANCELLED, endsOn: d('2026-08-03') }),
      }),
      '2026-08-18',
      'DENY',
      DenialReason.MEMBERSHIP_CANCELLED,
      'RENEW',
    ],
    [
      'no membership',
      subject({ membership: null }),
      '2026-08-18',
      'DENY',
      DenialReason.NO_MEMBERSHIP,
      'RENEW',
    ],
    [
      'day pass bought today',
      subject({ membership: null, dayPassValidToday: true }),
      '2026-08-18',
      'ALLOW',
      'DAY_PASS_VALID',
      'NONE',
    ],
    [
      'account suspended',
      subject({ userStatus: 'SUSPENDED' }),
      '2026-08-18',
      'DENY',
      DenialReason.ACCOUNT_SUSPENDED,
      'MANAGER',
    ],
  ];

  it.each(cases)('%s', (_label, subj, today, decision, reason, offer) => {
    const result = accessVerdict(subj, d(today), CFG);
    expect(result.decision).toBe(decision);
    expect(result.allowReason ?? result.denialReason).toBe(reason);
    expect(result.offer).toBe(offer);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('maps ALLOW to ALLOWED and GRACE to ALLOWED_IN_GRACE, and DENY to null', () => {
    expect(accessVerdict(subject(), d('2026-08-14'), CFG).verdict).toBe(AccessVerdict.ALLOWED);
    expect(
      accessVerdict(
        subject({
          membership: snapshot({ status: MembershipStatus.EXPIRED, endsOn: d('2026-08-16') }),
        }),
        d('2026-08-18'),
        CFG,
      ).verdict,
    ).toBe(AccessVerdict.ALLOWED_IN_GRACE);
    expect(accessVerdict(subject({ membership: null }), d('2026-08-18'), CFG).verdict).toBeNull();
  });

  it('composes the grace sentence with both numbers the desk needs', () => {
    const result = accessVerdict(
      subject({
        membership: snapshot({
          status: MembershipStatus.EXPIRED,
          endsOn: d('2026-08-16'),
          graceAdmissionsThisTerm: 2,
        }),
      }),
      d('2026-08-18'),
      CFG,
    );
    expect(result.message).toBe(
      'Ended 16 Aug. Grace — 1 of 3 admissions left, 1 day remaining. Let them in and collect the renewal.',
    );
    expect(result.graceDaysRemaining).toBe(1);
    expect(result.relevantDate).toBe('2026-08-16');
  });

  it('names the plan and the date on a plain active admission', () => {
    expect(accessVerdict(subject(), d('2026-08-14'), CFG).message).toBe(
      'Monthly — active until 28 Aug (14 days left). Let them in.',
    );
  });
});

describe('accessVerdict — boundaries', () => {
  const m = snapshot({ endsOn: d('2026-08-31') });

  it.each([
    ['2026-08-30', 'ALLOW', 'MEMBERSHIP_EXPIRING_SOON'],
    ['2026-08-31', 'ALLOW', 'MEMBERSHIP_EXPIRES_TODAY'],
    ['2026-09-01', 'GRACE', 'MEMBERSHIP_IN_GRACE'],
  ])('endsOn boundary triple: %s is %s', (today, decision, reason) => {
    const result = accessVerdict(subject({ membership: m }), d(today), CFG);
    expect(result.decision).toBe(decision);
    expect(result.allowReason).toBe(reason);
  });

  it.each([
    ['2026-09-02', 'GRACE'],
    ['2026-09-03', 'GRACE'],
    ['2026-09-04', 'DENY'],
  ])('grace-end boundary: %s is %s', (today, decision) => {
    expect(accessVerdict(subject({ membership: m }), d(today), CFG).decision).toBe(decision);
  });

  it('23:59 and 00:01 Manila on the expiry date both read MEMBERSHIP_EXPIRES_TODAY', () => {
    // The regression test for the UTC date-bucketing bug, and the reason
    // gymToday takes an injected `now`.
    const lateEvening = gymToday(new Date('2026-08-31T15:59:00Z'), MANILA);
    const justAfterMidnight = gymToday(new Date('2026-08-30T16:01:00Z'), MANILA);
    expect(lateEvening).toBe('2026-08-31');
    expect(justAfterMidnight).toBe('2026-08-31');
    for (const today of [lateEvening, justAfterMidnight]) {
      expect(accessVerdict(subject({ membership: m }), today, CFG).allowReason).toBe(
        'MEMBERSHIP_EXPIRES_TODAY',
      );
    }
  });
});

describe('accessVerdict — the two self-heals', () => {
  it('FROZEN whose hold ended yesterday admits as ACTIVE', () => {
    // Exact, not approximate: the extension was applied when the hold started,
    // so nothing is being guessed at.
    const result = accessVerdict(
      subject({
        membership: snapshot({
          status: MembershipStatus.FROZEN,
          endsOn: d('2026-09-30'),
          hold: { startsOn: d('2026-08-01'), endsOn: d('2026-08-17') },
        }),
      }),
      d('2026-08-18'),
      CFG,
    );
    expect(result.decision).toBe('ALLOW');
    expect(result.allowReason).toBe('MEMBERSHIP_ACTIVE');
  });

  it('ACTIVE under notice whose term ended denies as CANCELLED', () => {
    const result = accessVerdict(
      subject({
        membership: snapshot({
          status: MembershipStatus.ACTIVE,
          endsOn: d('2026-08-17'),
          cancelRequestedOn: d('2026-08-01'),
        }),
      }),
      d('2026-08-18'),
      CFG,
    );
    expect(result.decision).toBe('DENY');
    expect(result.denialReason).toBe(DenialReason.MEMBERSHIP_CANCELLED);
  });

  it('does NOT honour a SCHEDULED hold the job has not activated', () => {
    // Deliberately not self-healed: denying on a stale schedule while the
    // day-credit has not been applied would be actively unfair.
    const result = accessVerdict(
      subject({ membership: snapshot({ status: MembershipStatus.ACTIVE, hold: null }) }),
      d('2026-08-18'),
      CFG,
    );
    expect(result.decision).toBe('ALLOW');
  });
});

describe('accessVerdict — precedence', () => {
  it('the account gate beats a valid day pass', () => {
    const result = accessVerdict(
      subject({ userStatus: 'SUSPENDED', membership: null, dayPassValidToday: true }),
      d('2026-08-18'),
      CFG,
    );
    expect(result.decision).toBe('DENY');
    expect(result.denialReason).toBe(DenialReason.ACCOUNT_SUSPENDED);
    expect(result.offer).toBe('MANAGER');
  });

  it('a deactivated account is refused too', () => {
    expect(
      accessVerdict(subject({ userStatus: 'DEACTIVATED' }), d('2026-08-18'), CFG).denialReason,
    ).toBe(DenialReason.ACCOUNT_DEACTIVATED);
  });

  it.each([
    MembershipStatus.FROZEN,
    MembershipStatus.CANCELLED,
    MembershipStatus.EXPIRED,
  ])("today's day pass beats a %s membership", (status) => {
    const result = accessVerdict(
      subject({
        membership: snapshot({
          status,
          endsOn: d('2026-07-01'),
          hold: status === MembershipStatus.FROZEN ? { startsOn: d('2026-08-01'), endsOn: d('2026-10-01') } : null,
        }),
        dayPassValidToday: true,
      }),
      d('2026-08-18'),
      CFG,
    );
    expect(result.decision).toBe('ALLOW');
    expect(result.allowReason).toBe('DAY_PASS_VALID');
  });

  it('an active membership is reported as such even when a day pass exists', () => {
    const result = accessVerdict(subject({ dayPassValidToday: true }), d('2026-08-14'), CFG);
    expect(result.allowReason).toBe('MEMBERSHIP_ACTIVE');
  });
});

describe('accessVerdict — grace is finite', () => {
  const inGrace = (used: number): MembershipSnapshot =>
    snapshot({
      status: MembershipStatus.EXPIRED,
      endsOn: d('2026-08-16'),
      graceAdmissionsThisTerm: used,
    });

  it('admits while admissions remain', () => {
    expect(accessVerdict(subject({ membership: inGrace(2) }), d('2026-08-18'), CFG).decision).toBe(
      'GRACE',
    );
  });

  it('refuses once the term has used its allowance, inside the window', () => {
    const result = accessVerdict(subject({ membership: inGrace(3) }), d('2026-08-18'), CFG);
    expect(result.decision).toBe('DENY');
    expect(result.denialReason).toBe(DenialReason.MEMBERSHIP_EXPIRED);
    expect(result.offer).toBe('RENEW');
  });

  it('never grants grace to a membership under notice', () => {
    const result = accessVerdict(
      subject({
        membership: snapshot({ endsOn: d('2026-08-16'), cancelRequestedOn: d('2026-08-01') }),
      }),
      d('2026-08-18'),
      CFG,
    );
    expect(result.decision).toBe('DENY');
    expect(result.denialReason).toBe(DenialReason.MEMBERSHIP_CANCELLED);
  });
});

describe('accessVerdict — result invariants', () => {
  it('daysRemaining is never negative and is null with no term', () => {
    expect(
      accessVerdict(
        subject({
          membership: snapshot({ status: MembershipStatus.EXPIRED, endsOn: d('2026-07-01') }),
        }),
        d('2026-08-18'),
        CFG,
      ).daysRemaining,
    ).toBe(0);
    expect(
      accessVerdict(subject({ membership: null }), d('2026-08-18'), CFG).daysRemaining,
    ).toBeNull();
  });

  it('graceDaysRemaining is 0 for every non-grace result', () => {
    const results = [
      accessVerdict(subject(), d('2026-08-14'), CFG),
      accessVerdict(subject({ membership: null }), d('2026-08-18'), CFG),
      accessVerdict(subject({ userStatus: 'SUSPENDED' }), d('2026-08-18'), CFG),
      accessVerdict(
        subject({
          membership: snapshot({ status: MembershipStatus.CANCELLED, endsOn: d('2026-08-03') }),
        }),
        d('2026-08-18'),
        CFG,
      ),
    ];
    for (const result of results) expect(result.graceDaysRemaining).toBe(0);
  });

  it('never mutates its subject', () => {
    const subj = subject();
    const before = JSON.stringify(subj);
    accessVerdict(subj, d('2026-08-14'), CFG);
    expect(JSON.stringify(subj)).toBe(before);
  });

  it('carries no formatted currency string in the message', () => {
    // The desk composes the peso figure client-side from planPriceCentavos.
    // No response body anywhere carries a formatted currency string.
    const all = [
      accessVerdict(subject(), d('2026-08-14'), CFG),
      accessVerdict(subject({ membership: null }), d('2026-08-18'), CFG),
      accessVerdict(
        subject({
          membership: snapshot({ status: MembershipStatus.EXPIRED, endsOn: d('2026-08-16') }),
        }),
        d('2026-08-18'),
        CFG,
      ),
    ];
    for (const result of all) expect(result.message).not.toMatch(/₱|PHP|\d+\.\d{2}/);
  });
});

describe('access-verdict.ts stays pure', () => {
  const source = readFileSync(join(__dirname, 'access-verdict.ts'), 'utf8');

  it('reads no clock', () => {
    expect(source).not.toMatch(/new Date\(/);
    expect(source).not.toMatch(/Date\.now\(/);
  });

  it('reads no config service and no Prisma client at runtime', () => {
    expect(source).not.toMatch(/GymConfigService/);
    expect(source).not.toMatch(/PrismaService/);
    expect(source.match(/^import .*'@prisma\/client';$/gm) ?? []).toEqual([
      "import type { UserStatus } from '@prisma/client';",
    ]);
  });

  it('is not a Nest provider', () => {
    expect(source).not.toMatch(/@Injectable/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test --workspace=server -- access-verdict`
Expected: FAIL — `Cannot find module './access-verdict' from 'src/membership/access-verdict.spec.ts'`.

- [ ] **Step 3: Implement the ladder**

Create `server/src/membership/access-verdict.ts`:

```typescript
import type { UserStatus } from '@prisma/client';
import { AccessVerdict, DenialReason, MembershipStatus } from '@got/shared';
import type { AccessDecision, AllowReason } from '@got/shared';
import { addDays, civilDaysBetween } from '../common/time/gym-time';
import type { CivilDate } from '../common/time/gym-time';

/**
 * The door ladder. First match wins.
 *
 * PURE: no clock, no database, no config read. `graceDays` is a column on the
 * snapshot, not an env lookup, so the bound exists from the moment the
 * membership is sold rather than from the moment a job notices it lapsed.
 * MembershipService.verdictFor(userId, now) does the loading; this does the
 * deciding — the same split as PermissionsService / PermissionsGuard.
 *
 * R1: dates are the authority and stored status is a materialised convenience.
 * This function never trusts Membership.status alone; step 0 recomputes an
 * effective status from endsOn, cancelRequestedOn and the hold window on every
 * call, which is what makes "the scheduler was down for three days" a boring
 * incident.
 *
 * Staff are NOT special: there is deliberately no `if (role !== CLIENT) return
 * ALLOW`. A coach who trains here gets a comped membership on a ₱0
 * STAFF-discounted payment.
 */

export interface MembershipSnapshot {
  status: MembershipStatus;
  startsOn: CivilDate;
  endsOn: CivilDate;
  graceDays: number;
  graceAdmissionsThisTerm: number;
  cancelRequestedOn: CivilDate | null;
  planName: string;
  planPriceCentavos: number;
  /** The running hold's window, when status === FROZEN. */
  hold: { startsOn: CivilDate; endsOn: CivilDate } | null;
}

export interface AccessSubject {
  userStatus: UserStatus;
  membership: MembershipSnapshot | null;
  /**
   * Chunk 2 resolves this from a WALK_IN CheckIn on the current gym-local
   * business date. A boolean, so this file has no dependency on the attendance
   * schema — and so nobody "restores" the DayPass table the name implies.
   */
  dayPassValidToday: boolean;
}

export interface AccessResult {
  decision: AccessDecision;
  /** Which stored verdict chunk 2 writes on the CheckIn. Null when DENY. */
  verdict: AccessVerdict | null;
  allowReason: AllowReason | null;
  denialReason: DenialReason | null;
  /**
   * One sentence, composed server-side, so every surface stays dumb. Always
   * carries the date or count the staffer needs and always ends in an
   * instruction. It carries NO peso figure: no response body anywhere holds a
   * formatted currency string, and the console renders the price itself from
   * the integer centavos it already has.
   */
  message: string;
  relevantDate: CivilDate | null;
  /** Days left in the term. Clamped to >= 0. Null when there is no term. */
  daysRemaining: number | null;
  /** Days of grace left. 0 unless allowReason === 'MEMBERSHIP_IN_GRACE'. */
  graceDaysRemaining: number;
  offer: 'NONE' | 'RENEW' | 'UNFREEZE' | 'OVERRIDE' | 'MANAGER';
}

export interface AccessVerdictConfig {
  expiringSoonDays: number;
  graceAdmissionsMax: number;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** '2026-08-16' → '16 Aug'. Pure string work: no Intl, no locale drift. */
function shortDate(day: CivilDate): string {
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
}

function days(n: number): string {
  return `${n} day${n === 1 ? '' : 's'}`;
}

/** Step 0 — the two self-heals for a nightly job that has not run. */
function effectiveStatus(m: MembershipSnapshot, today: CivilDate): MembershipStatus {
  if (m.status === MembershipStatus.FROZEN && m.hold !== null && today > m.hold.endsOn) {
    return MembershipStatus.ACTIVE;
  }
  if (
    m.status === MembershipStatus.ACTIVE &&
    m.cancelRequestedOn !== null &&
    today > m.endsOn
  ) {
    return MembershipStatus.CANCELLED;
  }
  return m.status;
}

export function accessVerdict(
  subject: AccessSubject,
  today: CivilDate,
  cfg: AccessVerdictConfig,
): AccessResult {
  const m = subject.membership;
  const remaining = m === null ? 0 : Math.max(0, civilDaysBetween(today, m.endsOn));
  const daysRemaining = m === null ? null : remaining;

  const deny = (
    denialReason: DenialReason,
    message: string,
    offer: AccessResult['offer'],
    relevantDate: CivilDate | null,
  ): AccessResult => ({
    decision: 'DENY',
    verdict: null,
    allowReason: null,
    denialReason,
    message,
    relevantDate,
    daysRemaining,
    graceDaysRemaining: 0,
    offer,
  });

  const allow = (
    allowReason: AllowReason,
    message: string,
    offer: AccessResult['offer'],
    relevantDate: CivilDate | null,
  ): AccessResult => ({
    decision: 'ALLOW',
    verdict: AccessVerdict.ALLOWED,
    allowReason,
    denialReason: null,
    message,
    relevantDate,
    daysRemaining,
    graceDaysRemaining: 0,
    offer,
  });

  // 1-2. Account gates are absolute and sit above the day-pass check, so an
  // entitlement can never override a closed account — and the walk-in sale
  // endpoint runs this same ladder, so one cannot be sold to a closed account.
  if (subject.userStatus === 'SUSPENDED') {
    return deny(
      DenialReason.ACCOUNT_SUSPENDED,
      'This account is suspended. Do not let them in — get a manager.',
      'MANAGER',
      null,
    );
  }
  if (subject.userStatus === 'DEACTIVATED') {
    return deny(
      DenialReason.ACCOUNT_DEACTIVATED,
      'This account is deactivated. Do not let them in — get a manager.',
      'MANAGER',
      null,
    );
  }

  const effective = m === null ? null : effectiveStatus(m, today);

  // 3. Inside a running term.
  if (m !== null && effective === MembershipStatus.ACTIVE && today <= m.endsOn) {
    if (m.cancelRequestedOn !== null) {
      return allow(
        'MEMBERSHIP_ENDING',
        `${m.planName} — cancelling on ${shortDate(m.endsOn)}. Let them in.`,
        'NONE',
        m.endsOn,
      );
    }
    if (today === m.endsOn) {
      return allow(
        'MEMBERSHIP_EXPIRES_TODAY',
        `${m.planName} — last day. Let them in, and ask if they want to renew today.`,
        'RENEW',
        m.endsOn,
      );
    }
    if (remaining <= cfg.expiringSoonDays) {
      return allow(
        'MEMBERSHIP_EXPIRING_SOON',
        `${m.planName} — ${days(remaining)} left, ends ${shortDate(m.endsOn)}. Let them in; ask about renewing.`,
        'RENEW',
        m.endsOn,
      );
    }
    return allow(
      'MEMBERSHIP_ACTIVE',
      `${m.planName} — active until ${shortDate(m.endsOn)} (${days(remaining)} left). Let them in.`,
      'NONE',
      m.endsOn,
    );
  }

  // 4. Grace. ACTIVE is included on purpose: it is the window before the
  // nightly job has run. Grace is finite because graceDays lives on the row,
  // whether or not that job ever runs again.
  if (
    m !== null &&
    (effective === MembershipStatus.ACTIVE || effective === MembershipStatus.EXPIRED) &&
    m.cancelRequestedOn === null
  ) {
    const graceEnd = addDays(m.endsOn, m.graceDays);
    if (today <= graceEnd && m.graceAdmissionsThisTerm < cfg.graceAdmissionsMax) {
      const graceDaysRemaining = civilDaysBetween(today, graceEnd);
      const left = cfg.graceAdmissionsMax - m.graceAdmissionsThisTerm;
      return {
        decision: 'GRACE',
        verdict: AccessVerdict.ALLOWED_IN_GRACE,
        allowReason: 'MEMBERSHIP_IN_GRACE',
        denialReason: null,
        message: `Ended ${shortDate(m.endsOn)}. Grace — ${left} of ${cfg.graceAdmissionsMax} admissions left, ${days(graceDaysRemaining)} remaining. Let them in and collect the renewal.`,
        relevantDate: m.endsOn,
        daysRemaining,
        graceDaysRemaining,
        offer: 'RENEW',
      };
    }
    // Grace exhausted or expired: deliberately FALL THROUGH rather than
    // returning here. Step 8 below produces the identical DENY
    // MEMBERSHIP_EXPIRED / offer RENEW, and falling through keeps the day-pass
    // check above every membership denial — which is the whole reason rule 5
    // exists: it stops the desk double-charging someone who already paid for
    // today.
  }

  // 5. An entitlement already paid for beats any membership state below it.
  if (subject.dayPassValidToday) {
    return allow(
      'DAY_PASS_VALID',
      'Day pass for today — already paid. Let them in.',
      'NONE',
      today,
    );
  }

  if (m !== null) {
    // 6.
    if (effective === MembershipStatus.FROZEN) {
      const until = m.hold === null ? null : m.hold.endsOn;
      return deny(
        DenialReason.MEMBERSHIP_FROZEN,
        until === null
          ? 'Frozen. Sell a walk-in, or a manager can end the freeze early.'
          : `Frozen until ${shortDate(until)}. Sell a walk-in, or a manager can end the freeze early.`,
        'OVERRIDE',
        until ?? m.endsOn,
      );
    }
    // 7.
    if (effective === MembershipStatus.CANCELLED) {
      return deny(
        DenialReason.MEMBERSHIP_CANCELLED,
        `Cancelled — the term ended ${shortDate(m.endsOn)}. Start a new plan, or sell a walk-in.`,
        'RENEW',
        m.endsOn,
      );
    }
    // 8.
    return deny(
      DenialReason.MEMBERSHIP_EXPIRED,
      `Ended ${shortDate(m.endsOn)}, grace is over. Renew, or sell a walk-in.`,
      'RENEW',
      m.endsOn,
    );
  }

  // 9.
  return deny(
    DenialReason.NO_MEMBERSHIP,
    'No plan on file. Sell a walk-in, or sign them up.',
    'RENEW',
    null,
  );
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test --workspace=server -- access-verdict`
Expected: PASS — all eleven §5.4.4 rows with decision, reason and offer; both boundary triples; the 23:59/00:01 Manila pair; both self-heals; account-gate-beats-entitlement; entitlement-beats-membership-state; grace exhaustion; and the three purity assertions.

- [ ] **Step 5: Run the whole server suite**

Run: `npm test --workspace=server && npm run typecheck --workspace=server`
Expected: PASS, typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/membership/access-verdict.ts server/src/membership/access-verdict.spec.ts
git commit -m "feat(membership): accessVerdict() — the pure door ladder

R1 in one function: it recomputes from endsOn, graceDays and the hold
window on every call and never trusts Membership.status alone, so a
three-day scheduler outage neither admits for free nor turns away
paying members.

One deliberate reading of §5.4.2: an exhausted grace allowance falls
THROUGH to the day-pass check rather than returning at step 4. The DENY
reason and offer are identical either way, and falling through is what
stops the desk double-charging someone who bought a pass this morning."
```

---

### Task 5: The transition table

**Files:**
- Create: `server/src/membership/membership-transitions.ts`
- Test: `server/src/membership/membership-transitions.spec.ts`

**Interfaces:**
- Consumes: `@got/shared` exports `enum MembershipStatus` (task 1); `server/src/common/exceptions/domain.exception.ts` exports `DomainException`; `DomainErrorCode` now admits `'MEMBERSHIP_INVALID_TRANSITION'` (task 2)
- Produces: `const TRANSITIONS: Readonly<Record<MembershipStatus, ReadonlySet<MembershipStatus>>>`; `function isTransitionAllowed(from: MembershipStatus | null, to: MembershipStatus): boolean` — `from === null` is the creation edge and admits only `ACTIVE`; `function assertTransition(from: MembershipStatus | null, to: MembershipStatus): void` — throws `new DomainException('MEMBERSHIP_INVALID_TRANSITION', message, HttpStatus.UNPROCESSABLE_ENTITY)`, never silently no-ops; `const TRANSITION_BYPASS_REASON_REQUIRED = true as const`

- [ ] **Step 1: Write the failing transition test**

Create `server/src/membership/membership-transitions.spec.ts`:

```typescript
import { HttpStatus } from '@nestjs/common';
import { MembershipStatus } from '@got/shared';
import { DomainException } from '../common/exceptions/domain.exception';
import {
  TRANSITIONS,
  TRANSITION_BYPASS_REASON_REQUIRED,
  assertTransition,
  isTransitionAllowed,
} from './membership-transitions';

const { ACTIVE, EXPIRED, FROZEN, CANCELLED } = MembershipStatus;

/** Every (from, to) pair §5.5.2's seventeen rows actually produce. */
const ALLOWED: ReadonlyArray<[MembershipStatus | null, MembershipStatus, string]> = [
  [null, ACTIVE, 'rows 1 and 2 — first paid term, and the legacy import'],
  [ACTIVE, ACTIVE, 'rows 3, 5, 6, 16 — renewal before expiry, notice, withdrawal, comp days'],
  [ACTIVE, FROZEN, 'row 7 — hold starts'],
  [ACTIVE, EXPIRED, 'row 11 — nightly, endsOn passed with no notice'],
  [ACTIVE, CANCELLED, 'rows 12 and 13 — notice ran out, or an admin terminates'],
  [EXPIRED, ACTIVE, 'rows 4 and 14 — renewal in grace, reactivation past grace'],
  [EXPIRED, EXPIRED, 'row 16 — comp days on an expired member'],
  [EXPIRED, CANCELLED, 'row 13 — admin terminates'],
  [FROZEN, ACTIVE, 'rows 8 and 9 — hold completed, or released early'],
  [FROZEN, FROZEN, 'row 16 — comp days while frozen'],
  [FROZEN, CANCELLED, 'row 10 — admin terminates during a freeze'],
  [CANCELLED, ACTIVE, 'row 15 — reactivation'],
];

/** The complement. Every one of these is a 422, never a silent no-op. */
const REJECTED: ReadonlyArray<[MembershipStatus | null, MembershipStatus, string]> = [
  [null, EXPIRED, 'a membership is never created already expired'],
  [null, FROZEN, 'a membership is never created already frozen'],
  [null, CANCELLED, 'a membership is never created already cancelled'],
  [EXPIRED, FROZEN, '§5.5.3 — you cannot pause a term you have not paid for'],
  [CANCELLED, FROZEN, '§5.5.3 — same, after termination'],
  [FROZEN, EXPIRED, 'the nightly expiry step excludes FROZEN deliberately'],
  [CANCELLED, EXPIRED, 'a cancelled membership has no term left to elapse'],
  [CANCELLED, CANCELLED, 'already cancelled — nothing to terminate'],
];

function domainErrorFrom(from: MembershipStatus | null, to: MembershipStatus): DomainException {
  try {
    assertTransition(from, to);
  } catch (error) {
    if (error instanceof DomainException) return error;
    throw error;
  }
  throw new Error(`assertTransition(${String(from)}, ${to}) did not throw`);
}

describe('isTransitionAllowed', () => {
  it.each(ALLOWED)('allows %s → %s (%s)', (from, to) => {
    expect(isTransitionAllowed(from, to)).toBe(true);
  });

  it.each(REJECTED)('refuses %s → %s (%s)', (from, to) => {
    expect(isTransitionAllowed(from, to)).toBe(false);
  });

  it('covers every (from, to) pair exactly once across the two tables', () => {
    const froms: Array<MembershipStatus | null> = [null, ACTIVE, EXPIRED, FROZEN, CANCELLED];
    const tos = [ACTIVE, EXPIRED, FROZEN, CANCELLED];
    const listed = new Set(
      [...ALLOWED, ...REJECTED].map(([from, to]) => `${String(from)}->${to}`),
    );
    expect(listed.size).toBe(froms.length * tos.length);
    for (const from of froms) {
      for (const to of tos) {
        expect(listed.has(`${String(from)}->${to}`)).toBe(true);
      }
    }
  });
});

describe('assertTransition', () => {
  it.each(ALLOWED)('does not throw for %s → %s', (from, to) => {
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each(REJECTED)('throws MEMBERSHIP_INVALID_TRANSITION at 422 for %s → %s', (from, to) => {
    const error = domainErrorFrom(from, to);
    expect(error.code).toBe('MEMBERSHIP_INVALID_TRANSITION');
    expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
  });

  it('names both states in the message, so the desk log is readable', () => {
    expect(domainErrorFrom(EXPIRED, FROZEN).message).toContain('EXPIRED');
    expect(domainErrorFrom(EXPIRED, FROZEN).message).toContain('FROZEN');
  });

  it('names the creation edge rather than printing null', () => {
    expect(domainErrorFrom(null, FROZEN).message).toMatch(/new membership|creation/i);
  });
});

describe('TRANSITIONS', () => {
  it('is keyed by every MembershipStatus, and only those four', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual(Object.values(MembershipStatus).sort());
  });

  it('lets a cancelled membership go only to ACTIVE', () => {
    expect([...TRANSITIONS[CANCELLED]]).toEqual([ACTIVE]);
  });
});

describe('what this table deliberately does NOT refuse', () => {
  // Four of §5.5.3's seven rows are not status pairs. Written down here so the
  // next author looks in the right file rather than "fixing" the table.
  it('allows FROZEN → ACTIVE, because row 9 needs it — the renewal refusal is elsewhere', () => {
    // Renewing a FROZEN membership is 422 MEMBERSHIP_NOT_ACTIVE in
    // MembershipSalesService, so the extension arithmetic never has two writers.
    expect(isTransitionAllowed(FROZEN, ACTIVE)).toBe(true);
  });

  it('allows FROZEN → FROZEN, because row 16 needs it — the second freeze is refused by the sentinel', () => {
    // A second running hold is structurally impossible:
    // MembershipHold.activeMembershipId is nullable-unique.
    expect(isTransitionAllowed(FROZEN, FROZEN)).toBe(true);
  });

  it('allows CANCELLED → ACTIVE, because row 15 is reactivation, not notice', () => {
    // Giving notice on a CANCELLED membership is refused by
    // MembershipLifecycleService: there is nothing left to give notice on.
    expect(isTransitionAllowed(CANCELLED, ACTIVE)).toBe(true);
  });

  it('documents that membership.status.correct is the only permitted bypass', () => {
    expect(TRANSITION_BYPASS_REASON_REQUIRED).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test --workspace=server -- membership-transitions`
Expected: FAIL — `Cannot find module './membership-transitions' from 'src/membership/membership-transitions.spec.ts'`.

- [ ] **Step 3: Implement the table**

Create `server/src/membership/membership-transitions.ts`:

```typescript
import { HttpStatus } from '@nestjs/common';
import { MembershipStatus } from '@got/shared';
import { DomainException } from '../common/exceptions/domain.exception';

/**
 * The membership state machine, in one place.
 *
 * PURE: no clock, no Prisma, no config. Every mutating service calls
 * assertTransition(from, to) at the top of its method, so a forbidden
 * transition is refused identically whichever route reached it — and refused
 * LOUDLY. A silent no-op here means the desk believes it froze a lapsed member
 * and the member believes it too, right up until the door refuses them.
 *
 * §5.5.3 lists seven refusals. Three are status pairs and live in this table.
 * The other four are not, and deliberately are not modelled here:
 *   - FROZEN → renewal is 422 MEMBERSHIP_NOT_ACTIVE in MembershipSalesService,
 *     because FROZEN → ACTIVE is legitimate (row 9, early release);
 *   - a second concurrent freeze is refused by MembershipHold's nullable-unique
 *     activeMembershipId, because FROZEN → FROZEN is legitimate (row 16, comp
 *     days while frozen);
 *   - notice on a CANCELLED membership is refused by
 *     MembershipLifecycleService, because CANCELLED → ACTIVE is legitimate
 *     (row 15, reactivation);
 *   - a non-freezable plan and a second freeze in one term are
 *     membership-freeze-rules.ts's, not a status question at all.
 */

const { ACTIVE, EXPIRED, FROZEN, CANCELLED } = MembershipStatus;

export const TRANSITIONS: Readonly<Record<MembershipStatus, ReadonlySet<MembershipStatus>>> =
  Object.freeze({
    // Renewal, notice, withdrawal and comp days all leave it ACTIVE; the
    // nightly job expires or cancels it; a hold freezes it.
    [ACTIVE]: new Set([ACTIVE, EXPIRED, FROZEN, CANCELLED]),
    // Renewal in grace, reactivation past grace, comp days, admin termination.
    // NOT FROZEN: you cannot pause a term you have not paid for.
    [EXPIRED]: new Set([ACTIVE, EXPIRED, CANCELLED]),
    // Hold completes or is released early, comp days, admin termination.
    // NOT EXPIRED: the nightly expiry step excludes FROZEN deliberately.
    [FROZEN]: new Set([ACTIVE, FROZEN, CANCELLED]),
    // Reactivation reuses this same row with a fresh, re-anchored term.
    [CANCELLED]: new Set([ACTIVE]),
  });

/** `from === null` is the creation edge: rows 1 and 2, and it admits only ACTIVE. */
export function isTransitionAllowed(from: MembershipStatus | null, to: MembershipStatus): boolean {
  if (from === null) return to === ACTIVE;
  return TRANSITIONS[from].has(to);
}

/**
 * The one place a forbidden transition is refused. Never silently no-ops.
 */
export function assertTransition(from: MembershipStatus | null, to: MembershipStatus): void {
  if (isTransitionAllowed(from, to)) return;
  const origin = from === null ? 'a new membership (creation)' : from;
  throw new DomainException(
    'MEMBERSHIP_INVALID_TRANSITION',
    `A membership cannot move from ${origin} to ${to}.`,
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

/**
 * `membership.status.correct` is the ONLY caller permitted to bypass
 * assertTransition, and it must supply a reason — enforced both by
 * CorrectMembershipDto and by the MembershipEvent_reason_required CHECK.
 * Exported as a constant so the bypass is a documented decision a reader can
 * grep for, rather than an absent call nobody notices.
 */
export const TRANSITION_BYPASS_REASON_REQUIRED = true as const;
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test --workspace=server -- membership-transitions`
Expected: PASS — twelve accepted pairs, eight rejected pairs each carrying `MEMBERSHIP_INVALID_TRANSITION` at 422, and the coverage meta-test proving all twenty (from, to) pairs are accounted for exactly once.

- [ ] **Step 5: Run the whole server suite and typecheck**

Run: `npm test --workspace=server && npm run typecheck --workspace=server`
Expected: PASS — 34 suites green (29 baseline plus `confirm.dto`, `membership-terms`, `access-verdict`, `membership-transitions`), typecheck exits 0. `npm run lint` remains red with its ~19–27 pre-existing problems; do not fix them here.

- [ ] **Step 6: Commit**

```bash
git add server/src/membership/membership-transitions.ts \
        server/src/membership/membership-transitions.spec.ts
git commit -m "feat(membership): the transition table and assertTransition()

Twelve legal (from, to) pairs including the creation edge; the eight-pair
complement is a 422 MEMBERSHIP_INVALID_TRANSITION, never a silent no-op.

The spelling is MEMBERSHIP_INVALID_TRANSITION, not §5.5.3's
MEMBERSHIP_TRANSITION_INVALID: §7.2 and §7.7 carry the former and the
client switches on that string."
```

---

### Task 8: Plan registry, plan seed and the catalogue module

**Files:**
- Create: `server/src/catalogue/plan-registry.ts`
- Create: `server/src/catalogue/plan-registry.spec.ts`
- Create: `server/src/catalogue/plan.presenter.ts`
- Create: `server/src/catalogue/dto/create-plan.dto.ts`
- Create: `server/src/catalogue/dto/update-plan.dto.ts`
- Create: `server/src/catalogue/dto/list-plans-query.dto.ts`
- Create: `server/src/catalogue/plans.service.ts`
- Create: `server/src/catalogue/plans.controller.ts`
- Create: `server/src/catalogue/catalogue.module.ts`
- Create: `server/test/support/membership-fixtures.ts` (this task creates the file with `seedPlansForTest` only; task 9 appends `openShift`, tasks 11–12 append `makeMember`)
- Modify: `server/prisma/seed.ts:1-8` (imports) and `:116-117` (append the plan pass at the end of `main()`, after the `permissionVersion` bump block)
- Modify: `server/src/app.module.ts:11-12` (the feature-module import block, after `CoachAssignmentsModule`) and `:63-64` (the feature list, after `CoachAssignmentsModule`)
- Test: `server/src/catalogue/plan-registry.spec.ts`
- Test: `server/test/plans.e2e-spec.ts`

**Interfaces:**
- Consumes: `@prisma/client`: `Plan`, `PlanKind` (a runtime object AND a type in the generated client), `Prisma.PlanWhereInput`, `Prisma.TransactionClient`, `PrismaClient` (task 6's migration) · `server/src/common/exceptions/domain.exception.ts`: `class DomainException extends HttpException { constructor(code: DomainErrorCode, message: string, status?: HttpStatus); readonly code: DomainErrorCode }` (Chunk 0) · `server/src/common/exceptions/prisma-error.mapper.ts`: `mapPrismaError(error: unknown): DomainException | null` (Chunk 0, extended in task 6) · `server/src/common/validators/is-centavos.validator.ts`: `IsCentavos(min: number, max: number, options?: ValidationOptions): PropertyDecorator` (task 2) · `server/src/common/dto/pagination-query.dto.ts`: `class PaginationQueryDto { page: number; limit: number }` and `server/src/common/dto/paginate.ts`: `paginationSkipTake(query)`, `paginated<T>(items, total, query)` (Chunk 0) · `server/src/rbac/decorators/require-permission.decorator.ts`: `RequirePermission(key: string)` · `server/src/auth/decorators/public.decorator.ts`: `Public()` · permission keys `plan.read` (all roles, ALL) and `plan.manage` (ADMIN, requires `plan.read`) (task 2) · `DomainErrorCode` admits `'PLAN_NOT_FOUND' | 'PLAN_ARCHIVED'` (task 2) · `server/test/support/db.ts`: `resetDatabase(prisma)` — it TRUNCATEs every table except `Permission`, `RolePermission`, `_prisma_migrations`, so `Plan` is empty at the top of every e2e suite and `seedPlansForTest` is what refills it
- Produces: `server/src/catalogue/plan-registry.ts` exports `interface PlanDefinition { code: string; name: string; description: string; kind: PlanKind; priceCentavos: number; termMonths: number | null; freezable: boolean; guestPassesPerTerm: number; graceDays: number; perks: string[]; sortOrder: number }`, `const PLAN_REGISTRY: readonly PlanDefinition[]` (four rows), `function planShapeError(kind: PlanKind, termMonths: number | null | undefined, freezable: boolean): string | null`, `function assertPlanRegistryValid(registry: readonly PlanDefinition[]): void`, `async function seedPlans(prisma: PrismaClient): Promise<{ created: number; skipped: number }>` · `server/src/catalogue/plan.presenter.ts` exports `interface PublicPlan`, `interface AdminPlan extends PublicPlan`, `toPublicPlan(row: Plan): PublicPlan`, `toAdminPlan(row: Plan): AdminPlan` · `server/src/catalogue/plans.service.ts` exports `class PlansService { listPublic(): Promise<PublicPlan[]>; list(query: ListPlansQueryDto): Promise<PaginatedData<AdminPlan>>; create(dto: CreatePlanDto): Promise<AdminPlan>; update(id: string, dto: UpdatePlanDto): Promise<AdminPlan>; archive(id: string): Promise<AdminPlan>; requireSellable(tx: Prisma.TransactionClient, code: string): Promise<Plan> }` — **`requireSellable` takes the transaction client FIRST**, because every caller (tasks 10, 12, 14, 15) resolves the plan inside the same transaction that writes the Payment · `CreatePlanDto`, `UpdatePlanDto`, `ListPlansQueryDto` · `CatalogueModule` exporting `PlansService` · `server/test/support/membership-fixtures.ts` exports `type PlanCode = 'WALKIN' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL'` and `async function seedPlansForTest(prisma: PrismaClient): Promise<Record<PlanCode, string>>` returning **plan ids keyed by code** (tasks 14, 15 and 17 write `planId: plans.MONTHLY`)

---

- [ ] **Step 1: Write the failing plan-registry test**

```typescript
// server/src/catalogue/plan-registry.spec.ts
import { PlanKind, type PrismaClient } from '@prisma/client';
import {
  PLAN_REGISTRY,
  assertPlanRegistryValid,
  planShapeError,
  seedPlans,
  type PlanDefinition,
} from './plan-registry';

interface PrismaStub {
  plan: { createMany: jest.Mock };
}

function buildPrisma(count: number): PrismaStub {
  return { plan: { createMany: jest.fn().mockResolvedValue({ count }) } };
}

function byCode(code: string): PlanDefinition {
  const found = PLAN_REGISTRY.find((plan) => plan.code === code);
  if (!found) throw new Error(`PLAN_REGISTRY has no ${code}`);
  return found;
}

describe('PLAN_REGISTRY', () => {
  it('publishes exactly the four §5.3.2 plans, in sort order', () => {
    expect(PLAN_REGISTRY.map((plan) => plan.code)).toEqual([
      'WALKIN',
      'MONTHLY',
      'QUARTERLY',
      'ANNUAL',
    ]);
    expect(PLAN_REGISTRY.map((plan) => plan.sortOrder)).toEqual([0, 1, 2, 3]);
  });

  it('carries the confirmed prices as integer centavos', () => {
    expect(byCode('WALKIN').priceCentavos).toBe(9000);
    expect(byCode('MONTHLY').priceCentavos).toBe(80000);
    expect(byCode('QUARTERLY').priceCentavos).toBe(220000);
    expect(byCode('ANNUAL').priceCentavos).toBe(750000);
  });

  it('puts the walk-in price in a Plan row so no client hardcodes ₱90', () => {
    const walkIn = byCode('WALKIN');
    expect(walkIn.kind).toBe(PlanKind.WALK_IN);
    expect(walkIn.termMonths).toBeNull();
    expect(walkIn.freezable).toBe(false);
    expect(walkIn.graceDays).toBe(0);
  });

  // §5.6: the load-bearing entitlement. A monthly member simply renews later,
  // which removes the majority of freeze requests by volume.
  it('makes MONTHLY unfreezable and the two longer terms freezable', () => {
    expect(byCode('MONTHLY').freezable).toBe(false);
    expect(byCode('QUARTERLY').freezable).toBe(true);
    expect(byCode('ANNUAL').freezable).toBe(true);
  });

  it('gives every term plan three grace days and only ANNUAL its guest passes', () => {
    expect(byCode('MONTHLY').graceDays).toBe(3);
    expect(byCode('QUARTERLY').graceDays).toBe(3);
    expect(byCode('ANNUAL').graceDays).toBe(3);
    expect(byCode('MONTHLY').guestPassesPerTerm).toBe(0);
    expect(byCode('QUARTERLY').guestPassesPerTerm).toBe(0);
    expect(byCode('ANNUAL').guestPassesPerTerm).toBe(2);
  });

  it('validates clean', () => {
    expect(() => assertPlanRegistryValid(PLAN_REGISTRY)).not.toThrow();
  });

  it('rejects a duplicate code — the code is the snapshot key and never reused', () => {
    expect(() => assertPlanRegistryValid([byCode('MONTHLY'), byCode('MONTHLY')])).toThrow(
      /duplicate plan code MONTHLY/,
    );
  });
});

describe('planShapeError', () => {
  it('accepts the two legal shapes', () => {
    expect(planShapeError(PlanKind.TERM, 3, true)).toBeNull();
    expect(planShapeError(PlanKind.WALK_IN, null, false)).toBeNull();
  });

  it('refuses a TERM plan with no termMonths', () => {
    expect(planShapeError(PlanKind.TERM, null, false)).toMatch(/termMonths/);
    expect(planShapeError(PlanKind.TERM, undefined, false)).toMatch(/termMonths/);
  });

  it('refuses a TERM plan outside 1..60 months', () => {
    expect(planShapeError(PlanKind.TERM, 0, false)).toMatch(/1 and 60/);
    expect(planShapeError(PlanKind.TERM, 61, false)).toMatch(/1 and 60/);
  });

  it('refuses a WALK_IN plan that carries a term or claims to be freezable', () => {
    expect(planShapeError(PlanKind.WALK_IN, 1, false)).toMatch(/no termMonths/);
    expect(planShapeError(PlanKind.WALK_IN, null, true)).toMatch(/cannot be frozen/);
  });
});

describe('seedPlans', () => {
  it('is CREATE-ONLY: one createMany with skipDuplicates, never an upsert', async () => {
    const prisma = buildPrisma(4);

    const result = await seedPlans(prisma as unknown as PrismaClient);

    expect(prisma.plan.createMany).toHaveBeenCalledTimes(1);
    const args = prisma.plan.createMany.mock.calls[0][0] as {
      data: unknown[];
      skipDuplicates: boolean;
    };
    expect(args.skipDuplicates).toBe(true);
    expect(args.data).toHaveLength(4);
    expect(result).toEqual({ created: 4, skipped: 0 });
  });

  it('reports every row skipped on a re-seed, so a price edit is never reverted', async () => {
    const prisma = buildPrisma(0);

    expect(await seedPlans(prisma as unknown as PrismaClient)).toEqual({ created: 0, skipped: 4 });
  });

  it('validates the registry BEFORE writing anything', async () => {
    const prisma = buildPrisma(4);
    const broken: PlanDefinition[] = [{ ...byCode('MONTHLY'), termMonths: null }];

    await expect(
      seedPlans(prisma as unknown as PrismaClient, broken),
    ).rejects.toThrow(/termMonths/);
    expect(prisma.plan.createMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm test --workspace=server -- plan-registry`
Expected: FAIL — `Cannot find module './plan-registry' from 'src/catalogue/plan-registry.spec.ts'`

- [ ] **Step 3: Write `plan-registry.ts`**

```typescript
// server/src/catalogue/plan-registry.ts
import { PlanKind, type PrismaClient } from '@prisma/client';

/**
 * The published price list, as data.
 *
 * Mirrors the shape of `rbac/permission-registry.ts` — a frozen catalogue plus
 * an assertion plus a seed pass — with one deliberate difference that matters
 * more than the similarity: **this seed is CREATE-ONLY**. The permission
 * catalogue is convergent because permissions are code; prices are business
 * data owned by whoever runs the gym, and a convergent seed re-run on deploy
 * would quietly revert every price change they made.
 *
 * §5.0 decision: the walk-in price lives HERE, in a Plan row with
 * kind = WALK_IN, so no client hardcodes ₱90 and chunk 2's walk-in sale
 * snapshots from the same row every other sale snapshots from.
 *
 * `PlanKind` is imported from `@prisma/client` rather than `@got/shared`
 * on purpose: this module is on `prisma/seed.ts`'s import path, and the seed
 * runs through ts-node with no `@got/shared` build step in front of it. The
 * two enums are proved identical by `enum-parity.spec.ts` (task 1), so nothing
 * is lost by naming the Prisma one here.
 */

export interface PlanDefinition {
  /** Stable machine identifier, snapshotted onto Membership and Payment. */
  code: string;
  name: string;
  description: string;
  kind: PlanKind;
  /** Centavos of PHP. One gym, one location, one currency, so no currency column. */
  priceCentavos: number;
  /** NULL exactly when kind = WALK_IN. 1..60 otherwise. */
  termMonths: number | null;
  freezable: boolean;
  guestPassesPerTerm: number;
  graceDays: number;
  /** Bullet points for the pricing grid. Billing-adjacent copy only. */
  perks: string[];
  sortOrder: number;
}

export const PLAN_REGISTRY: readonly PlanDefinition[] = [
  {
    code: 'WALKIN',
    name: 'Walk-in',
    description: 'One day of access, paid at the counter.',
    kind: PlanKind.WALK_IN,
    priceCentavos: 9000,
    termMonths: null,
    // A single day cannot be paused and has no term to extend.
    freezable: false,
    guestPassesPerTerm: 0,
    graceDays: 0,
    perks: ['Full access for one day', 'No sign-up, no commitment'],
    sortOrder: 0,
  },
  {
    code: 'MONTHLY',
    name: 'Monthly',
    description: 'One month from your join date, renewed on the same day each month.',
    kind: PlanKind.TERM,
    priceCentavos: 80000,
    termMonths: 1,
    // §5.6, deliberately false: a monthly member simply renews later, which
    // removes the majority of freeze requests by volume and is explainable in
    // one sentence at the counter.
    freezable: false,
    guestPassesPerTerm: 0,
    graceDays: 3,
    perks: ['Full gym access', 'Free orientation on your first visit', '3-day grace period'],
    sortOrder: 1,
  },
  {
    code: 'QUARTERLY',
    name: 'Quarterly',
    description: 'Three months at a lower monthly rate, freezable once per term.',
    kind: PlanKind.TERM,
    priceCentavos: 220000,
    termMonths: 3,
    freezable: true,
    guestPassesPerTerm: 0,
    graceDays: 3,
    perks: [
      'Full gym access',
      'Save ₱200 against three monthly terms',
      'One freeze per term, 7 to 90 days',
      '3-day grace period',
    ],
    sortOrder: 2,
  },
  {
    code: 'ANNUAL',
    name: 'Annual',
    description: 'Twelve months at the best rate, with guest passes and freezing.',
    kind: PlanKind.TERM,
    priceCentavos: 750000,
    termMonths: 12,
    freezable: true,
    guestPassesPerTerm: 2,
    graceDays: 3,
    perks: [
      'Full gym access',
      'Save ₱2,100 against twelve monthly terms',
      '2 guest passes per term',
      'One freeze per term, 7 to 90 days',
      '3-day grace period',
    ],
    sortOrder: 3,
  },
];

/**
 * The `Plan_term_matches_kind` CHECK, expressed once in TypeScript.
 *
 * Returns a message rather than throwing, because it has two audiences with
 * two correct reactions: the registry assertion below turns it into a boot-time
 * `Error` (a bad catalogue must never be half-applied), and `PlansService`
 * turns it into a 400. The constraint in the database is the backstop behind
 * both — a 422 from it would be a bug report, not a user path.
 */
export function planShapeError(
  kind: PlanKind,
  termMonths: number | null | undefined,
  freezable: boolean,
): string | null {
  if (kind === PlanKind.TERM) {
    if (termMonths === null || termMonths === undefined) {
      return 'A TERM plan must carry termMonths.';
    }
    if (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 60) {
      return 'termMonths must be a whole number between 1 and 60.';
    }
    return null;
  }

  if (termMonths !== null && termMonths !== undefined) {
    return 'A WALK_IN plan prices a single day and takes no termMonths.';
  }
  if (freezable) {
    return 'A WALK_IN plan cannot be frozen — there is no term to extend.';
  }
  return null;
}

/** Bounds written to match §5.8.2's four Plan CHECKs exactly. */
export function assertPlanRegistryValid(registry: readonly PlanDefinition[]): void {
  const seen = new Set<string>();

  for (const plan of registry) {
    if (seen.has(plan.code)) {
      throw new Error(`Plan registry has a duplicate plan code ${plan.code}`);
    }
    seen.add(plan.code);

    const shape = planShapeError(plan.kind, plan.termMonths, plan.freezable);
    if (shape) throw new Error(`Plan ${plan.code}: ${shape}`);

    if (!Number.isInteger(plan.priceCentavos) || plan.priceCentavos < 0) {
      throw new Error(`Plan ${plan.code}: priceCentavos must be a non-negative integer`);
    }
    if (plan.priceCentavos > 10_000_000) {
      throw new Error(`Plan ${plan.code}: priceCentavos exceeds the ₱100,000 ceiling`);
    }
    if (plan.graceDays < 0 || plan.graceDays > 14) {
      throw new Error(`Plan ${plan.code}: graceDays must be between 0 and 14`);
    }
    if (plan.guestPassesPerTerm < 0 || plan.guestPassesPerTerm > 12) {
      throw new Error(`Plan ${plan.code}: guestPassesPerTerm must be between 0 and 12`);
    }
  }
}

/**
 * Creates any plan whose `code` is not already present, and touches nothing
 * else. `createMany({ skipDuplicates: true })` compiles to
 * INSERT … ON CONFLICT DO NOTHING, so a re-seed is one statement that reports
 * how many rows it declined to write and leaves every hand-edited price alone.
 */
export async function seedPlans(
  prisma: PrismaClient,
  registry: readonly PlanDefinition[] = PLAN_REGISTRY,
): Promise<{ created: number; skipped: number }> {
  assertPlanRegistryValid(registry);

  const { count } = await prisma.plan.createMany({
    data: registry.map((plan) => ({
      code: plan.code,
      name: plan.name,
      description: plan.description,
      kind: plan.kind,
      priceCentavos: plan.priceCentavos,
      termMonths: plan.termMonths,
      freezable: plan.freezable,
      guestPassesPerTerm: plan.guestPassesPerTerm,
      graceDays: plan.graceDays,
      perks: plan.perks,
      sortOrder: plan.sortOrder,
    })),
    skipDuplicates: true,
  });

  return { created: count, skipped: registry.length - count };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm test --workspace=server -- plan-registry`
Expected: PASS — 14 tests green.

- [ ] **Step 5: Commit the registry**

```bash
git add server/src/catalogue/plan-registry.ts \
        server/src/catalogue/plan-registry.spec.ts
git commit -m "feat(catalogue): add the create-only plan registry (spec 5.3.2)

The four published tiers as data — walk-in 9000, monthly 80000, quarterly
220000, annual 750000 centavos — with the walk-in price in a Plan row so no
client hardcodes it.

seedPlans is createMany({ skipDuplicates }), never an upsert: prices are
business data, and a convergent seed re-run on deploy would revert every
price change the owner made."
```

- [ ] **Step 6: Write the failing e2e for routes 5–9**

```typescript
// server/test/plans.e2e-spec.ts
import request from 'supertest';
import type { Server } from 'http';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import { seedPlansForTest } from './support/membership-fixtures';
import { seedPlans } from '../src/catalogue/plan-registry';

jest.setTimeout(120_000);

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface PublicPlanBody {
  code: string;
  name: string;
  description: string | null;
  kind: string;
  priceCentavos: number;
  termMonths: number | null;
  freezable: boolean;
  guestPassesPerTerm: number;
  graceDays: number;
  perks: string[];
  sortOrder: number;
}

interface AdminPlanBody extends PublicPlanBody {
  id: string;
  isActive: boolean;
}

describe('plans (e2e)', () => {
  let ctx: TestApp;
  let server: Server;

  let adminToken: string;
  let frontDeskToken: string;
  let clientToken: string;
  let planIds: Record<'WALKIN' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL', string>;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    planIds = await seedPlansForTest(ctx.prisma);
    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    frontDeskToken = await ctx.fixture.tokenFor('FRONT_DESK', { supabaseId: FIXTURE_IDS.FRONT_DESK });
    clientToken = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
  });

  describe('GET /plans (route 5)', () => {
    it('serves the price list with no token at all', async () => {
      const response = await request(server).get('/api/v1/plans').expect(200);

      const body = response.body as Envelope<PublicPlanBody[]>;
      expect(body.data?.map((plan) => plan.code)).toEqual([
        'WALKIN',
        'MONTHLY',
        'QUARTERLY',
        'ANNUAL',
      ]);
    });

    it('ships integer centavos and never a formatted currency string', async () => {
      const response = await request(server).get('/api/v1/plans').expect(200);

      const plans = (response.body as Envelope<PublicPlanBody[]>).data ?? [];
      const walkIn = plans.find((plan) => plan.code === 'WALKIN');
      expect(walkIn?.priceCentavos).toBe(9000);
      expect(walkIn?.termMonths).toBeNull();
      expect(plans.find((plan) => plan.code === 'ANNUAL')?.priceCentavos).toBe(750000);
      expect(JSON.stringify(plans)).not.toMatch(/₱|PHP/);
    });

    // The uuid is a database identifier. Every purchase path names a plan by
    // `code` — the column snapshotted onto Membership and Payment — so shipping
    // the id to an unauthenticated page invites a client to POST it.
    it('omits the plan id and the isActive flag from the public projection', async () => {
      const response = await request(server).get('/api/v1/plans').expect(200);

      for (const plan of (response.body as Envelope<PublicPlanBody[]>).data ?? []) {
        expect(plan).not.toHaveProperty('id');
        expect(plan).not.toHaveProperty('isActive');
      }
    });

    it('hides an archived plan from the public list', async () => {
      await request(server)
        .post(`/api/v1/admin/plans/${planIds.QUARTERLY}/archive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const response = await request(server).get('/api/v1/plans').expect(200);
      const codes = ((response.body as Envelope<PublicPlanBody[]>).data ?? []).map((p) => p.code);
      expect(codes).toEqual(['WALKIN', 'MONTHLY', 'ANNUAL']);
    });
  });

  describe('GET /admin/plans (route 6)', () => {
    it('paginates the active list for a FRONT_DESK holder of plan.read', async () => {
      const response = await request(server)
        .get('/api/v1/admin/plans')
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .expect(200);

      const body = response.body as Envelope<{ items: AdminPlanBody[]; total: number }>;
      expect(body.data?.total).toBe(4);
      expect(body.data?.items[0].id).toEqual(expect.any(String));
      expect(body.data?.items[0].isActive).toBe(true);
    });

    it('excludes archived plans unless includeInactive=true', async () => {
      await request(server)
        .post(`/api/v1/admin/plans/${planIds.WALKIN}/archive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const hidden = await request(server)
        .get('/api/v1/admin/plans')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect((hidden.body as Envelope<{ total: number }>).data?.total).toBe(3);

      const shown = await request(server)
        .get('/api/v1/admin/plans?includeInactive=true')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect((shown.body as Envelope<{ total: number }>).data?.total).toBe(4);
    });

    it('filters by kind', async () => {
      const response = await request(server)
        .get('/api/v1/admin/plans?kind=WALK_IN')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const items = (response.body as Envelope<{ items: AdminPlanBody[] }>).data?.items ?? [];
      expect(items.map((plan) => plan.code)).toEqual(['WALKIN']);
    });
  });

  describe('POST /admin/plans (route 7)', () => {
    it('creates a plan for an ADMIN', async () => {
      const response = await request(server)
        .post('/api/v1/admin/plans')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          code: 'SEMIANNUAL',
          name: 'Semi-annual',
          description: 'Six months.',
          kind: 'TERM',
          priceCentavos: 420000,
          termMonths: 6,
          freezable: true,
          graceDays: 3,
          guestPassesPerTerm: 1,
          perks: ['Full gym access'],
          sortOrder: 4,
        })
        .expect(201);

      const plan = (response.body as Envelope<AdminPlanBody>).data;
      expect(plan?.code).toBe('SEMIANNUAL');
      expect(plan?.priceCentavos).toBe(420000);
      expect(plan?.isActive).toBe(true);
    });

    it('refuses a FRONT_DESK caller: plan.manage is ADMIN only', async () => {
      await request(server)
        .post('/api/v1/admin/plans')
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .send({ code: 'NOPE', name: 'Nope', kind: 'TERM', priceCentavos: 80000, termMonths: 1 })
        .expect(403);
    });

    it('refuses a CLIENT caller outright', async () => {
      await request(server)
        .post('/api/v1/admin/plans')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ code: 'NOPE', name: 'Nope', kind: 'TERM', priceCentavos: 80000, termMonths: 1 })
        .expect(403);
    });

    it('409s on a duplicate code — the code is the snapshot key and is never reused', async () => {
      await request(server)
        .post('/api/v1/admin/plans')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ code: 'MONTHLY', name: 'Monthly again', kind: 'TERM', priceCentavos: 90000, termMonths: 1 })
        .expect(409);
    });

    it('400s a WALK_IN plan that carries a term', async () => {
      const response = await request(server)
        .post('/api/v1/admin/plans')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ code: 'DAYPASS', name: 'Day pass', kind: 'WALK_IN', priceCentavos: 9000, termMonths: 1 })
        .expect(400);

      expect((response.body as Envelope<never>).error?.message).toMatch(/termMonths/);
    });

    it('400s a TERM plan with no termMonths', async () => {
      await request(server)
        .post('/api/v1/admin/plans')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ code: 'OPEN_ENDED', name: 'Open ended', kind: 'TERM', priceCentavos: 80000 })
        .expect(400);
    });

    it('400s a fractional price — money is integer centavos', async () => {
      await request(server)
        .post('/api/v1/admin/plans')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ code: 'HALFPESO', name: 'Half', kind: 'TERM', priceCentavos: 80000.5, termMonths: 1 })
        .expect(400);
    });
  });

  describe('PATCH /admin/plans/:id (route 8)', () => {
    it('reprices a plan without touching anything already sold', async () => {
      const response = await request(server)
        .patch(`/api/v1/admin/plans/${planIds.MONTHLY}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ priceCentavos: 85000 })
        .expect(200);

      expect((response.body as Envelope<AdminPlanBody>).data?.priceCentavos).toBe(85000);
      const row = await ctx.prisma.plan.findUniqueOrThrow({ where: { code: 'MONTHLY' } });
      expect(row.priceCentavos).toBe(85000);
    });

    it('rejects a code change — the property is not in the DTO at all', async () => {
      await request(server)
        .patch(`/api/v1/admin/plans/${planIds.MONTHLY}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ code: 'MONTHLY_V2' })
        .expect(400);
    });

    it('404s PLAN_NOT_FOUND for an unknown id', async () => {
      const response = await request(server)
        .patch('/api/v1/admin/plans/8f14e45f-ceea-4671-a3ab-9e2a5b3f0000')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ priceCentavos: 85000 })
        .expect(404);

      expect((response.body as Envelope<never>).error?.code).toBe('PLAN_NOT_FOUND');
    });

    it('422s PLAN_ARCHIVED rather than silently editing a retired plan', async () => {
      await request(server)
        .post(`/api/v1/admin/plans/${planIds.QUARTERLY}/archive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const response = await request(server)
        .patch(`/api/v1/admin/plans/${planIds.QUARTERLY}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ priceCentavos: 230000 })
        .expect(422);

      expect((response.body as Envelope<never>).error?.code).toBe('PLAN_ARCHIVED');
    });
  });

  describe('POST /admin/plans/:id/archive (route 9)', () => {
    it('retires a plan instead of deleting it', async () => {
      const response = await request(server)
        .post(`/api/v1/admin/plans/${planIds.ANNUAL}/archive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect((response.body as Envelope<AdminPlanBody>).data?.isActive).toBe(false);
      expect(await ctx.prisma.plan.count()).toBe(4);
    });

    it('is idempotent — a second archive returns the same row, not a 409', async () => {
      await request(server)
        .post(`/api/v1/admin/plans/${planIds.ANNUAL}/archive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const again = await request(server)
        .post(`/api/v1/admin/plans/${planIds.ANNUAL}/archive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect((again.body as Envelope<AdminPlanBody>).data?.isActive).toBe(false);
    });

    it('404s PLAN_NOT_FOUND for an unknown id', async () => {
      const response = await request(server)
        .post('/api/v1/admin/plans/8f14e45f-ceea-4671-a3ab-9e2a5b3f0000/archive')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);

      expect((response.body as Envelope<never>).error?.code).toBe('PLAN_NOT_FOUND');
    });
  });

  describe('the seed is create-only', () => {
    it('re-seeding reverts no price the owner edited', async () => {
      await request(server)
        .patch(`/api/v1/admin/plans/${planIds.MONTHLY}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ priceCentavos: 85000 })
        .expect(200);

      const result = await seedPlans(ctx.prisma);

      expect(result).toEqual({ created: 0, skipped: 4 });
      const row = await ctx.prisma.plan.findUniqueOrThrow({ where: { code: 'MONTHLY' } });
      expect(row.priceCentavos).toBe(85000);
    });

    it('restores a plan the owner deleted outright, without disturbing the rest', async () => {
      await request(server)
        .patch(`/api/v1/admin/plans/${planIds.ANNUAL}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ priceCentavos: 799000 })
        .expect(200);
      await ctx.prisma.plan.delete({ where: { code: 'WALKIN' } });

      const result = await seedPlans(ctx.prisma);

      expect(result).toEqual({ created: 1, skipped: 3 });
      expect(
        (await ctx.prisma.plan.findUniqueOrThrow({ where: { code: 'WALKIN' } })).priceCentavos,
      ).toBe(9000);
      expect(
        (await ctx.prisma.plan.findUniqueOrThrow({ where: { code: 'ANNUAL' } })).priceCentavos,
      ).toBe(799000);
    });
  });
});
```

And create the fixture file the suite imports:

```typescript
// server/test/support/membership-fixtures.ts
import type { PrismaClient } from '@prisma/client';
import { seedPlans } from '../../src/catalogue/plan-registry';

/**
 * Builders for the states the membership e2e suites need.
 *
 * `resetDatabase` TRUNCATEs every table except Permission, RolePermission and
 * _prisma_migrations, so Plan is EMPTY at the top of every suite even though
 * `prisma db seed` created the four rows when the scratch database was built.
 * That is deliberate: these suites repriced and archive plans, and preserving
 * Plan across suites would leak one suite's edits into the next.
 *
 * Task 9 appends `openShift` here; tasks 11–12 append `makeMember`.
 */

export type PlanCode = 'WALKIN' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';

/**
 * Reinstates the four seeded plans and hands back their ids keyed by code, so
 * a fixture can write `planId: plans.MONTHLY` without a second lookup.
 */
export async function seedPlansForTest(prisma: PrismaClient): Promise<Record<PlanCode, string>> {
  await seedPlans(prisma);

  const rows = await prisma.plan.findMany({ select: { code: true, id: true } });
  const byCode = Object.fromEntries(rows.map((row) => [row.code, row.id])) as Record<
    PlanCode,
    string
  >;

  for (const code of ['WALKIN', 'MONTHLY', 'QUARTERLY', 'ANNUAL'] as const) {
    if (!byCode[code]) throw new Error(`seedPlansForTest: plan ${code} was not created`);
  }
  return byCode;
}
```

- [ ] **Step 7: Run the e2e and watch it fail**

Run: `npm run test:e2e --workspace=server -- plans`
Expected: FAIL — `Cannot find module '../src/catalogue/plans.service'` is not yet reachable; the first failure is `Cannot GET /api/v1/plans` rendering a 404 against the expected 200, because no controller is mounted.

- [ ] **Step 8: Write the presenter**

```typescript
// server/src/catalogue/plan.presenter.ts
import type { Plan, PlanKind } from '@prisma/client';

/**
 * The pricing grid's projection. No id, no isActive, no timestamps.
 *
 * `id` is withheld deliberately: every purchase path names a plan by `code` —
 * the column snapshotted onto Membership and Payment — so the uuid buys an
 * unauthenticated page nothing and shipping it invites a client to POST it.
 *
 * Money leaves as an integer number of centavos and nothing else. There is no
 * `priceFormatted`, no `₱`, no locale: rendering is the client's job, and a
 * formatted string on the wire is a second representation of the same number
 * that can disagree with the first.
 */
export interface PublicPlan {
  code: string;
  name: string;
  description: string | null;
  kind: PlanKind;
  priceCentavos: number;
  termMonths: number | null;
  freezable: boolean;
  guestPassesPerTerm: number;
  graceDays: number;
  perks: string[];
  sortOrder: number;
}

/** Everything above plus the two columns an operator manages the list with. */
export interface AdminPlan extends PublicPlan {
  id: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toPublicPlan(row: Plan): PublicPlan {
  return {
    code: row.code,
    name: row.name,
    description: row.description,
    kind: row.kind,
    priceCentavos: row.priceCentavos,
    termMonths: row.termMonths,
    freezable: row.freezable,
    guestPassesPerTerm: row.guestPassesPerTerm,
    graceDays: row.graceDays,
    perks: row.perks,
    sortOrder: row.sortOrder,
  };
}

export function toAdminPlan(row: Plan): AdminPlan {
  return {
    ...toPublicPlan(row),
    id: row.id,
    isActive: row.isActive,
    // Instants, not business dates: these are @db.Timestamptz(3) and travel as
    // full ISO-8601 strings, formatted client-side with an explicit timeZone.
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
```

- [ ] **Step 9: Write the three DTOs**

```typescript
// server/src/catalogue/dto/create-plan.dto.ts
import { PlanKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsCentavos } from '../../common/validators/is-centavos.validator';

/**
 * Every bound here is written to match §5.8.2's Plan CHECKs, so no input the
 * pipe accepts can be rejected by the database.
 *
 * The one rule that is NOT expressible as a per-property bound —
 * `Plan_term_matches_kind`, which couples `kind`, `termMonths` and `freezable`
 * — is checked in `PlansService` with `planShapeError()` and surfaces as a
 * plain 400, matching route 7's contract (its only named failure is the 409 on
 * a duplicate code).
 */
export class CreatePlanDto {
  /**
   * The immutable snapshot key. Upper-case so `Payment.planCode` reads the
   * same everywhere, and bounded so it fits a receipt line.
   */
  @Matches(/^[A-Z][A-Z0-9_]{1,23}$/, {
    message: 'code must be 2-24 upper-case letters, digits or underscores',
  })
  code!: string;

  @IsString()
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsEnum(PlanKind)
  kind!: PlanKind;

  @IsCentavos(0, 10_000_000)
  priceCentavos!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  termMonths?: number;

  @IsOptional()
  @IsBoolean()
  freezable?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(12)
  guestPassesPerTerm?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(14)
  graceDays?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  perks?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;
}
```

```typescript
// server/src/catalogue/dto/update-plan.dto.ts
import { PlanKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsCentavos } from '../../common/validators/is-centavos.validator';

/**
 * Every CreatePlanDto field except `code`.
 *
 * `code` is absent rather than optional on purpose: it is snapshotted onto
 * Membership.planCode and Payment.planCode at every sale, so renaming it would
 * silently orphan every receipt already handed to a member. Because the
 * ValidationPipe runs `forbidNonWhitelisted`, a client that sends `code` gets a
 * 400 naming the property rather than a silently ignored field.
 *
 * `kind` IS editable, and safely so: everything a live membership depends on
 * (termMonths, price, graceDays, guestPassesPerTerm) is copied onto the
 * Membership row at purchase, so no edit here can rewrite what anyone already
 * bought. The service re-runs `planShapeError()` against the MERGED row, so a
 * TERM→WALK_IN flip that would leave a stale termMonths behind is a 400.
 */
export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsEnum(PlanKind)
  kind?: PlanKind;

  @IsOptional()
  @IsCentavos(0, 10_000_000)
  priceCentavos?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  termMonths?: number;

  @IsOptional()
  @IsBoolean()
  freezable?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(12)
  guestPassesPerTerm?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(14)
  graceDays?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  perks?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;
}
```

```typescript
// server/src/catalogue/dto/list-plans-query.dto.ts
import { PlanKind } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListPlansQueryDto extends PaginationQueryDto {
  /**
   * Read off the RAW query object, not off the implicitly converted value:
   * `enableImplicitConversion` coerces by the reflected design type, and for a
   * `boolean` that turns the string 'false' into `true`. `?includeInactive=false`
   * would otherwise mean the opposite of what it says. class-transformer applies
   * custom @Transform functions LAST, with `obj` still holding the untouched
   * query string, which is why this reads `obj`.
   */
  @Transform(({ obj }) => {
    const raw = (obj as Record<string, unknown>)['includeInactive'];
    if (raw === undefined || raw === null || raw === '') return false;
    return raw === true || raw === 'true';
  })
  @IsBoolean()
  includeInactive: boolean = false;

  @IsOptional()
  @IsEnum(PlanKind)
  kind?: PlanKind;
}
```

- [ ] **Step 10: Write `plans.service.ts`**

```typescript
// server/src/catalogue/plans.service.ts
import { BadRequestException, ConflictException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type Plan } from '@prisma/client';
import type { PaginatedData } from '@got/shared';
import { DomainException } from '../common/exceptions/domain.exception';
import { mapPrismaError } from '../common/exceptions/prisma-error.mapper';
import { paginated, paginationSkipTake } from '../common/dto/paginate';
import { PrismaService } from '../prisma/prisma.service';
import { planShapeError } from './plan-registry';
import { toAdminPlan, toPublicPlan, type AdminPlan, type PublicPlan } from './plan.presenter';
import type { CreatePlanDto } from './dto/create-plan.dto';
import type { UpdatePlanDto } from './dto/update-plan.dto';
import type { ListPlansQueryDto } from './dto/list-plans-query.dto';

/**
 * Plans are the only table in this chunk with no member on it, so nothing here
 * is scoped: there is one price list and everyone with `plan.read` sees all of
 * it. That is why `list` takes no `ScopedWhere` while every membership and
 * payment read does.
 */
@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  /** Route 5. Active plans only, in the order the pricing grid renders them. */
  async listPublic(): Promise<PublicPlan[]> {
    const rows = await this.prisma.plan.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { priceCentavos: 'asc' }],
    });
    return rows.map(toPublicPlan);
  }

  /** Route 6. */
  async list(query: ListPlansQueryDto): Promise<PaginatedData<AdminPlan>> {
    const where: Prisma.PlanWhereInput = {
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.kind ? { kind: query.kind } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.plan.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { priceCentavos: 'asc' }],
        ...paginationSkipTake(query),
      }),
      this.prisma.plan.count({ where }),
    ]);

    return paginated(rows.map(toAdminPlan), total, query);
  }

  /** Route 7. */
  async create(dto: CreatePlanDto): Promise<AdminPlan> {
    const freezable = dto.freezable ?? false;
    const shape = planShapeError(dto.kind, dto.termMonths, freezable);
    if (shape) throw new BadRequestException(shape);

    try {
      const row = await this.prisma.plan.create({
        data: {
          code: dto.code,
          name: dto.name,
          description: dto.description ?? null,
          kind: dto.kind,
          priceCentavos: dto.priceCentavos,
          termMonths: dto.termMonths ?? null,
          freezable,
          guestPassesPerTerm: dto.guestPassesPerTerm ?? 0,
          graceDays: dto.graceDays ?? 3,
          perks: dto.perks ?? [],
          sortOrder: dto.sortOrder ?? 0,
        },
      });
      return toAdminPlan(row);
    } catch (error) {
      // Caught OUTSIDE any transaction, so the §4.6(d) rule is not violated.
      // Route 7 names this failure `HTTP_409` and not a domain code: a
      // duplicate code is a collision in the admin's own namespace, not a
      // business outcome any client branches on.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`A plan with code ${dto.code} already exists`);
      }
      const mapped = mapPrismaError(error);
      if (mapped) throw mapped;
      throw error;
    }
  }

  /** Route 8. */
  async update(id: string, dto: UpdatePlanDto): Promise<AdminPlan> {
    const existing = await this.requireById(id);
    if (!existing.isActive) {
      throw new DomainException(
        'PLAN_ARCHIVED',
        `Plan ${existing.code} is archived. Create a replacement rather than editing a retired price.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // The shape rule is checked against the MERGED row, not the patch: a
    // request that only sends `kind: 'WALK_IN'` would otherwise leave the old
    // termMonths behind and be caught by the CHECK as a 422 instead of a 400.
    const kind = dto.kind ?? existing.kind;
    const termMonths = dto.termMonths ?? (dto.kind === undefined ? existing.termMonths : null);
    const freezable = dto.freezable ?? (dto.kind === undefined ? existing.freezable : false);
    const shape = planShapeError(kind, termMonths, freezable);
    if (shape) throw new BadRequestException(shape);

    const row = await this.prisma.plan.update({
      where: { id },
      data: {
        ...(dto.name === undefined ? {} : { name: dto.name }),
        ...(dto.description === undefined ? {} : { description: dto.description }),
        ...(dto.priceCentavos === undefined ? {} : { priceCentavos: dto.priceCentavos }),
        ...(dto.guestPassesPerTerm === undefined
          ? {}
          : { guestPassesPerTerm: dto.guestPassesPerTerm }),
        ...(dto.graceDays === undefined ? {} : { graceDays: dto.graceDays }),
        ...(dto.perks === undefined ? {} : { perks: dto.perks }),
        ...(dto.sortOrder === undefined ? {} : { sortOrder: dto.sortOrder }),
        kind,
        termMonths,
        freezable,
      },
    });
    return toAdminPlan(row);
  }

  /**
   * Route 9. Retire, never delete — every relation is `onDelete: Restrict` and
   * a plan carries the price history of every term ever sold on it.
   *
   * Idempotent: archiving an already-archived plan returns 200 with the
   * existing row, so a double-click in the CRM is harmless.
   */
  async archive(id: string): Promise<AdminPlan> {
    const existing = await this.requireById(id);
    if (!existing.isActive) return toAdminPlan(existing);

    const row = await this.prisma.plan.update({ where: { id }, data: { isActive: false } });
    return toAdminPlan(row);
  }

  /**
   * The one plan lookup every selling path uses.
   *
   * Takes the transaction client FIRST because every caller resolves the plan
   * inside the same transaction that writes the Payment — reading it on the
   * base client would let an admin archive a plan between the read and the
   * write and leave a sale attributed to a plan that was retired mid-sale.
   */
  async requireSellable(tx: Prisma.TransactionClient, code: string): Promise<Plan> {
    const plan = await tx.plan.findUnique({ where: { code } });
    if (!plan) {
      throw new DomainException(
        'PLAN_NOT_FOUND',
        `No plan with code ${code}`,
        HttpStatus.NOT_FOUND,
      );
    }
    if (!plan.isActive) {
      throw new DomainException(
        'PLAN_ARCHIVED',
        `Plan ${code} is archived and cannot be sold`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return plan;
  }

  private async requireById(id: string): Promise<Plan> {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) {
      throw new DomainException('PLAN_NOT_FOUND', 'Plan not found', HttpStatus.NOT_FOUND);
    }
    return plan;
  }
}
```

- [ ] **Step 11: Write `plans.controller.ts`**

```typescript
// server/src/catalogue/plans.controller.ts
import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { PaginatedData } from '@got/shared';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { PlansService } from './plans.service';
import type { AdminPlan, PublicPlan } from './plan.presenter';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { ListPlansQueryDto } from './dto/list-plans-query.dto';

/**
 * Route 5. `@Public()` rather than `plan.read`: the pricing grid is the
 * marketing site's front page and must render before anyone has an account.
 * There is no member data on a Plan row, so there is nothing to scope.
 */
@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @Public()
  async list(): Promise<PublicPlan[]> {
    return this.plans.listPublic();
  }
}

/**
 * Routes 6–9. One `@RequirePermission` key per route — the decorator resolves
 * with `getAllAndOverride`, so a method-level key REPLACES a class-level one
 * rather than ANDing with it, and a class-level `plan.read` here would be
 * silently discarded by the three `plan.manage` methods below.
 *
 * Route 6 is `plan.read`, which every seeded role holds at ALL — including
 * CLIENT. That is deliberate and safe: an AdminPlan is the price list plus its
 * archive flag and carries no member data at all.
 */
@Controller('admin/plans')
export class AdminPlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @RequirePermission('plan.read')
  async list(@Query() query: ListPlansQueryDto): Promise<PaginatedData<AdminPlan>> {
    return this.plans.list(query);
  }

  @Post()
  @RequirePermission('plan.manage')
  async create(@Body() dto: CreatePlanDto): Promise<AdminPlan> {
    return this.plans.create(dto);
  }

  @Patch(':id')
  @RequirePermission('plan.manage')
  async update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdatePlanDto,
  ): Promise<AdminPlan> {
    return this.plans.update(id, dto);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('plan.manage')
  async archive(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<AdminPlan> {
    return this.plans.archive(id);
  }
}
```

- [ ] **Step 12: Write `catalogue.module.ts` and register it**

```typescript
// server/src/catalogue/catalogue.module.ts
import { Module } from '@nestjs/common';
import { AdminPlansController, PlansController } from './plans.controller';
import { PlansService } from './plans.service';

/**
 * §7.8's layout, not §5.11's `billing/`: chunk 2 is written against
 * `catalogue/`, and two directories for one model is how the import graph
 * forks. Anyone reading §5.11 should treat `billing/` as superseded.
 *
 * `PlansService` is exported because MembershipModule (tasks 12, 14, 15) and
 * PaymentsModule (task 10) all call `requireSellable` inside their own
 * transactions.
 */
@Module({
  controllers: [PlansController, AdminPlansController],
  providers: [PlansService],
  exports: [PlansService],
})
export class CatalogueModule {}
```

In `server/src/app.module.ts`, add the import after line 11 (`CoachAssignmentsModule`):

```typescript
import { CatalogueModule } from './catalogue/catalogue.module';
```

and add it to the feature list after line 63 (`CoachAssignmentsModule,`):

```typescript
    CatalogueModule,
```

- [ ] **Step 13: Add the create-only plan pass to `prisma/seed.ts`**

Extend the import block at the top of the file (after line 8):

```typescript
import { seedPlans } from '../src/catalogue/plan-registry';
```

and append this to the end of `main()`, after the `permissionVersion` bump block that ends at line 116:

```typescript
  // The plan pass is CREATE-ONLY and deliberately unlike everything above it.
  // The permission catalogue is convergent because permissions are code; plan
  // prices are business data owned by whoever runs the gym, so an upsert here
  // would silently revert every price change they made the next time anyone
  // deployed. A plan that should no longer sell is archived through
  // POST /admin/plans/:id/archive, never removed from the registry.
  const plans = await seedPlans(prisma);
  console.info(
    `Plans: created ${plans.created}, skipped ${plans.skipped} (create-only — prices are business data).`,
  );
```

- [ ] **Step 14: Re-run the seed so the four plans exist**

Run: `npm run db:seed --workspace=server`
Expected: the permission passes report as before, then `Plans: created 4, skipped 0 (create-only — prices are business data).` Run it a second time and the same line reads `created 0, skipped 4`. **This is mandatory** — without it `GET /plans` returns an empty array on the development database and every sale in tasks 12–15 fails `PLAN_NOT_FOUND` with nothing in the logs to point at.

- [ ] **Step 15: Run the e2e and watch it pass**

Run: `npm run test:e2e --workspace=server -- plans`
Expected: PASS — 21 tests green across the six describes.

- [ ] **Step 16: Run the full unit suite and the typecheck**

Run: `npm test --workspace=server && npm run typecheck --workspace=server`
Expected: PASS — the baseline suites plus `plan-registry`, typecheck exits 0. `npm run lint` remains red with its ~19–27 pre-existing problems; do not fix them here.

- [ ] **Step 17: Commit**

```bash
git add server/src/catalogue/plan.presenter.ts \
        server/src/catalogue/plans.service.ts \
        server/src/catalogue/plans.controller.ts \
        server/src/catalogue/catalogue.module.ts \
        server/src/catalogue/dto/create-plan.dto.ts \
        server/src/catalogue/dto/update-plan.dto.ts \
        server/src/catalogue/dto/list-plans-query.dto.ts \
        server/src/app.module.ts \
        server/prisma/seed.ts \
        server/test/support/membership-fixtures.ts \
        server/test/plans.e2e-spec.ts
git commit -m "feat(catalogue): plan catalogue module and create-only plan seed (routes 5-9)

GET /plans is @Public and ships integer centavos with no plan id and no
formatted currency; /admin/plans reads on plan.read and writes on
plan.manage. requireSellable(tx, code) takes the transaction client first,
so a sale cannot resolve a plan that is archived mid-transaction.

Requires \`npm run db:seed --workspace=server\` — the plan pass is
createMany({ skipDuplicates }), so a re-seed reverts no price."
```

---

### Task 9: Shifts — the cash drawer

**Files:**
- Create: `server/src/payments/shifts.service.ts`
- Create: `server/src/payments/shifts.service.spec.ts`
- Create: `server/src/payments/shift.presenter.ts`
- Create: `server/src/payments/dto/shift.dto.ts`
- Create: `server/src/payments/shifts.controller.ts`
- Create: `server/src/payments/payments.module.ts` (this task creates it holding shifts only; task 10 adds `PaymentsService`/`PaymentsController`, task 17 adds `ReportsService` and `SUMMARY_TRANSPORT`)
- Create: `server/test/payments-shifts.e2e-spec.ts` (this task creates the file with the `shifts` describes; task 10 appends its payments describes and task 17 its `reports` describe. Shifts come first because `Payment.shiftId` is NOT NULL, so nothing can record a payment until a drawer can be opened)
- Modify: `server/test/support/membership-fixtures.ts` (created in task 8 — append `openShift` after `seedPlansForTest`)
- Modify: `server/src/app.module.ts:12-13` (the feature-module import block, after the `CatalogueModule` line task 8 added) and `:64-65` (the feature list, after `CatalogueModule,`)
- Test: `server/src/payments/shifts.service.spec.ts`
- Test: `server/test/payments-shifts.e2e-spec.ts`

**Interfaces:**
- Consumes: `@prisma/client`: `Shift`, `ShiftStatus`, `Prisma.TransactionClient`, `Prisma.PrismaClientKnownRequestError` (task 6's migration; `Shift.openMarker String? @unique` is the sentinel and `Shift_open_marker` / `Shift_close_shape` are its CHECKs) · `server/src/common/time/gym-time.ts`: `gymToday(now: Date, timeZone: string): CivilDate`, `toDateColumn(day: CivilDate): Date`, `civilDateFromPrisma(d: Date): CivilDate`, `type CivilDate` (Chunk 0) · `server/src/config/gym.config.ts`: `GymConfigService.timeZone`, `GymConfigService.shiftVarianceNoteThresholdCentavos` (task 2) · `server/src/common/validators/is-centavos.validator.ts`: `IsCentavos(min, max, options?)` (task 2) · `server/src/common/exceptions/domain.exception.ts`: `DomainException` (Chunk 0) · `server/src/common/exceptions/prisma-error.mapper.ts`: `mapPrismaError` (Chunk 0) · `server/src/common/decorators/idempotent.decorator.ts`: `Idempotent()` — the interceptor requires a **UUID** `Idempotency-Key` header and keys identity on (key, method, concrete path, body hash, caller) (Chunk 0) · `server/src/rbac/decorators/require-permission.decorator.ts`: `RequirePermission` · permission key `shift.manage` (FRONT_DESK + ADMIN, requires `payment.read`) (task 2) · `DomainErrorCode` admits `'SHIFT_NOT_OPEN' | 'SHIFT_ALREADY_OPEN' | 'SHIFT_ALREADY_CLOSED' | 'SHIFT_VARIANCE_REASON_REQUIRED'` (task 2) · `server/test/support/membership-fixtures.ts`: `seedPlansForTest` (task 8)
- Produces: `server/src/payments/shifts.service.ts` exports `const OPEN_MARKER = 'OPEN'`, `interface ShiftClosureFigures { expectedCentavos: number; varianceCentavos: number }`, `function computeClosure(openingFloatCentavos: number, cashRecordedCentavos: number, countedCentavos: number): ShiftClosureFigures`, `function assertVarianceExplained(figures: ShiftClosureFigures, note: string | undefined, thresholdCentavos: number): void`, `class ShiftsService { open(actorId: string, dto: OpenShiftDto): Promise<ShiftView>; current(): Promise<ShiftView | null>; close(actorId: string, id: string, dto: CloseShiftDto): Promise<ShiftClosure>; requireOpenShiftId(tx: Prisma.TransactionClient): Promise<string> }` — **`requireOpenShiftId` is the single source of `SHIFT_NOT_OPEN`**; tasks 10 and 14 call it and never re-derive the rule · `server/src/payments/shift.presenter.ts` exports `interface ShiftView`, `interface ShiftClosure extends ShiftView`, `toShiftView(row: Shift): ShiftView`, `toShiftClosure(row: Shift, expectedCentavos: number, varianceCentavos: number): ShiftClosure` · `OpenShiftDto`, `CloseShiftDto` · `PaymentsModule` exporting `ShiftsService` · `server/test/support/membership-fixtures.ts` additionally exports `async function openShift(prisma: PrismaClient, openedById: string, businessDate: CivilDate): Promise<string>` returning the new shift's id (tasks 14, 15 and 17 call it exactly this way)

---

- [ ] **Step 1: Write the failing shifts test**

```typescript
// server/src/payments/shifts.service.spec.ts
import { HttpStatus, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainException } from '../common/exceptions/domain.exception';
import { civilDateFromPrisma } from '../common/time/gym-time';
import type { GymConfigService } from '../config/gym.config';
import type { PrismaService } from '../prisma/prisma.service';
import {
  OPEN_MARKER,
  ShiftsService,
  assertVarianceExplained,
  computeClosure,
} from './shifts.service';

const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const SHIFT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const GYM = {
  timeZone: 'Asia/Manila',
  shiftVarianceNoteThresholdCentavos: 20_000,
} as unknown as GymConfigService;

interface PrismaMock {
  shift: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    updateMany: jest.Mock;
  };
  payment: { aggregate: jest.Mock };
  $transaction: jest.Mock;
}

function buildPrisma(): PrismaMock {
  const mock: PrismaMock = {
    shift: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
    },
    payment: { aggregate: jest.fn().mockResolvedValue({ _sum: { netCentavos: null } }) },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation(async (fn: (tx: PrismaMock) => Promise<unknown>) =>
    fn(mock),
  );
  return mock;
}

function shiftRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: SHIFT_ID,
    status: 'OPEN',
    openedById: ACTOR_ID,
    openedAt: new Date('2026-08-19T21:00:00.000Z'),
    openingFloatCentavos: 300_000,
    closedById: null,
    closedAt: null,
    countedCentavos: null,
    expectedCentavos: null,
    varianceCentavos: null,
    note: null,
    businessDate: new Date('2026-08-20T00:00:00.000Z'),
    openMarker: OPEN_MARKER,
    createdAt: new Date('2026-08-19T21:00:00.000Z'),
    updatedAt: new Date('2026-08-19T21:00:00.000Z'),
    ...overrides,
  };
}

function build(prisma: PrismaMock): ShiftsService {
  return new ShiftsService(prisma as unknown as PrismaService, GYM);
}

describe('computeClosure', () => {
  it('expects the float plus every recorded cash peso, and reports a clean count as zero', () => {
    // ₱3,000 float, one walk-in at ₱90 and one monthly at ₱800.
    expect(computeClosure(300_000, 89_000, 389_000)).toEqual({
      expectedCentavos: 389_000,
      varianceCentavos: 0,
    });
  });

  it('reports a short drawer as a negative variance and a long one as positive', () => {
    expect(computeClosure(300_000, 89_000, 384_000).varianceCentavos).toBe(-5_000);
    expect(computeClosure(300_000, 89_000, 394_000).varianceCentavos).toBe(5_000);
  });

  it('expects exactly the float on a shift that took no cash', () => {
    expect(computeClosure(300_000, 0, 300_000)).toEqual({
      expectedCentavos: 300_000,
      varianceCentavos: 0,
    });
  });
});

describe('assertVarianceExplained', () => {
  it('passes a variance inside ±₱200 with no note', () => {
    expect(() =>
      assertVarianceExplained({ expectedCentavos: 389_000, varianceCentavos: -20_000 }, undefined, 20_000),
    ).not.toThrow();
  });

  it('demands a note beyond the threshold — the only thing that makes a blind count useful', () => {
    try {
      assertVarianceExplained(
        { expectedCentavos: 389_000, varianceCentavos: -25_000 },
        undefined,
        20_000,
      );
      throw new Error('assertVarianceExplained did not throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainException);
      expect((error as DomainException).code).toBe('SHIFT_VARIANCE_REASON_REQUIRED');
      expect((error as DomainException).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    }
  });

  it('accepts a real note and refuses a whitespace one', () => {
    expect(() =>
      assertVarianceExplained(
        { expectedCentavos: 389_000, varianceCentavos: 25_000 },
        'extra ₱250 from yesterday, logged in the book',
        20_000,
      ),
    ).not.toThrow();
    expect(() =>
      assertVarianceExplained({ expectedCentavos: 389_000, varianceCentavos: 25_000 }, '   ', 20_000),
    ).toThrow(DomainException);
  });
});

describe('ShiftsService.open', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('stamps the GYM-LOCAL business date, not the UTC one', async () => {
    // 16:30 UTC is 00:30 the NEXT day in Manila. A shift opened just after
    // midnight local belongs to the new business day.
    jest.useFakeTimers().setSystemTime(new Date('2026-08-19T16:30:00.000Z'));
    const prisma = buildPrisma();
    prisma.shift.create.mockResolvedValue(shiftRow());

    await build(prisma).open(ACTOR_ID, { openingFloatCentavos: 300_000 });

    const data = prisma.shift.create.mock.calls[0][0].data as { businessDate: Date };
    expect(civilDateFromPrisma(data.businessDate)).toBe('2026-08-20');
  });

  it('keeps a 23:30 Manila open on the same business day', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-19T15:30:00.000Z'));
    const prisma = buildPrisma();
    prisma.shift.create.mockResolvedValue(shiftRow());

    await build(prisma).open(ACTOR_ID, { openingFloatCentavos: 300_000 });

    const data = prisma.shift.create.mock.calls[0][0].data as { businessDate: Date };
    expect(civilDateFromPrisma(data.businessDate)).toBe('2026-08-19');
  });

  it('sets the openMarker sentinel so the database enforces one open drawer', async () => {
    const prisma = buildPrisma();
    prisma.shift.create.mockResolvedValue(shiftRow());

    await build(prisma).open(ACTOR_ID, { openingFloatCentavos: 300_000 });

    const data = prisma.shift.create.mock.calls[0][0].data as { openMarker: string };
    expect(data.openMarker).toBe(OPEN_MARKER);
  });

  it('turns the sentinel unique violation into 409 SHIFT_ALREADY_OPEN', async () => {
    const prisma = buildPrisma();
    prisma.shift.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: '6.19.0',
        meta: { target: ['openMarker'] },
      }),
    );

    try {
      await build(prisma).open(ACTOR_ID, { openingFloatCentavos: 300_000 });
      throw new Error('open did not throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainException);
      expect((error as DomainException).code).toBe('SHIFT_ALREADY_OPEN');
      expect((error as DomainException).getStatus()).toBe(HttpStatus.CONFLICT);
    }
  });
});

describe('ShiftsService.close', () => {
  it('sums only RECORDED CASH payments in this shift', async () => {
    const prisma = buildPrisma();
    prisma.shift.findUnique.mockResolvedValue(shiftRow());
    prisma.payment.aggregate.mockResolvedValue({ _sum: { netCentavos: 89_000 } });
    prisma.shift.updateMany.mockResolvedValue({ count: 1 });
    prisma.shift.findUniqueOrThrow.mockResolvedValue(
      shiftRow({ status: 'CLOSED', openMarker: null, countedCentavos: 389_000 }),
    );

    const result = await build(prisma).close(ACTOR_ID, SHIFT_ID, { countedCentavos: 389_000 });

    expect(prisma.payment.aggregate).toHaveBeenCalledWith({
      _sum: { netCentavos: true },
      where: { shiftId: SHIFT_ID, status: 'RECORDED', method: 'CASH' },
    });
    expect(result.expectedCentavos).toBe(389_000);
    expect(result.varianceCentavos).toBe(0);
  });

  it('clears the sentinel and writes the computed figures in one conditional update', async () => {
    const prisma = buildPrisma();
    prisma.shift.findUnique.mockResolvedValue(shiftRow());
    prisma.payment.aggregate.mockResolvedValue({ _sum: { netCentavos: 89_000 } });
    prisma.shift.updateMany.mockResolvedValue({ count: 1 });
    prisma.shift.findUniqueOrThrow.mockResolvedValue(
      shiftRow({ status: 'CLOSED', openMarker: null, countedCentavos: 384_000 }),
    );

    await build(prisma).close(ACTOR_ID, SHIFT_ID, { countedCentavos: 384_000 });

    const call = prisma.shift.updateMany.mock.calls[0][0] as {
      where: { id: string; status: string };
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: SHIFT_ID, status: 'OPEN' });
    expect(call.data.openMarker).toBeNull();
    expect(call.data.expectedCentavos).toBe(389_000);
    expect(call.data.varianceCentavos).toBe(-5_000);
    expect(call.data.closedById).toBe(ACTOR_ID);
  });

  it('404s an unknown shift', async () => {
    const prisma = buildPrisma();
    prisma.shift.findUnique.mockResolvedValue(null);

    await expect(
      build(prisma).close(ACTOR_ID, SHIFT_ID, { countedCentavos: 300_000 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('409s SHIFT_ALREADY_CLOSED on a closed row', async () => {
    const prisma = buildPrisma();
    prisma.shift.findUnique.mockResolvedValue(shiftRow({ status: 'CLOSED', openMarker: null }));

    try {
      await build(prisma).close(ACTOR_ID, SHIFT_ID, { countedCentavos: 300_000 });
      throw new Error('close did not throw');
    } catch (error) {
      expect((error as DomainException).code).toBe('SHIFT_ALREADY_CLOSED');
      expect((error as DomainException).getStatus()).toBe(HttpStatus.CONFLICT);
    }
  });

  it('409s when the conditional update matches nothing — another staffer closed it first', async () => {
    const prisma = buildPrisma();
    prisma.shift.findUnique.mockResolvedValue(shiftRow());
    prisma.shift.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      build(prisma).close(ACTOR_ID, SHIFT_ID, { countedCentavos: 300_000 }),
    ).rejects.toMatchObject({ code: 'SHIFT_ALREADY_CLOSED' });
    expect(prisma.shift.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('refuses a ₱250 discrepancy with no note, before writing anything', async () => {
    const prisma = buildPrisma();
    prisma.shift.findUnique.mockResolvedValue(shiftRow());
    prisma.payment.aggregate.mockResolvedValue({ _sum: { netCentavos: 89_000 } });

    await expect(
      build(prisma).close(ACTOR_ID, SHIFT_ID, { countedCentavos: 364_000 }),
    ).rejects.toMatchObject({ code: 'SHIFT_VARIANCE_REASON_REQUIRED' });
    expect(prisma.shift.updateMany).not.toHaveBeenCalled();
  });
});

describe('ShiftsService.requireOpenShiftId', () => {
  it('resolves the open drawer through the unique sentinel', async () => {
    const prisma = buildPrisma();
    prisma.shift.findUnique.mockResolvedValue({ id: SHIFT_ID });

    const id = await build(prisma).requireOpenShiftId(
      prisma as unknown as Prisma.TransactionClient,
    );

    expect(id).toBe(SHIFT_ID);
    expect(prisma.shift.findUnique).toHaveBeenCalledWith({
      where: { openMarker: OPEN_MARKER },
      select: { id: true },
    });
  });

  it('422s SHIFT_NOT_OPEN when the drawer is shut — money without a drawer is unreconcilable', async () => {
    const prisma = buildPrisma();
    prisma.shift.findUnique.mockResolvedValue(null);

    try {
      await build(prisma).requireOpenShiftId(prisma as unknown as Prisma.TransactionClient);
      throw new Error('requireOpenShiftId did not throw');
    } catch (error) {
      expect((error as DomainException).code).toBe('SHIFT_NOT_OPEN');
      expect((error as DomainException).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    }
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm test --workspace=server -- shifts.service`
Expected: FAIL — `Cannot find module './shifts.service' from 'src/payments/shifts.service.spec.ts'`

- [ ] **Step 3: Write `shift.presenter.ts`**

```typescript
// server/src/payments/shift.presenter.ts
import type { Shift, ShiftStatus } from '@prisma/client';
import { civilDateFromPrisma } from '../common/time/gym-time';

/**
 * A drawer session as the console sees it.
 *
 * `expectedCentavos` and `varianceCentavos` are deliberately ABSENT from this
 * interface, not merely nullable. §5.7.6: the physical count is submitted
 * BEFORE the expected figure is revealed, because a visible expected total gets
 * back-fitted every single time. Making the field unrepresentable here means
 * there is no route, no query parameter and no accidental spread that can leak
 * it — the only producer is `toShiftClosure`, and the only caller of that is
 * the close handler, which runs after the count has been recorded.
 *
 * `businessDate` is a @db.Date and travels as a yyyy-mm-dd civil date;
 * `openedAt` / `closedAt` are @db.Timestamptz(3) and travel as full ISO-8601
 * instants. Two kinds of temporal value, two wire shapes (R2).
 */
export interface ShiftView {
  id: string;
  status: ShiftStatus;
  businessDate: string;
  openedById: string;
  openedAt: string;
  openingFloatCentavos: number;
  closedById: string | null;
  closedAt: string | null;
  countedCentavos: number | null;
  note: string | null;
}

/** The close response, and the only shape that carries the expected figure. */
export interface ShiftClosure extends ShiftView {
  expectedCentavos: number;
  varianceCentavos: number;
}

export function toShiftView(row: Shift): ShiftView {
  return {
    id: row.id,
    status: row.status,
    businessDate: civilDateFromPrisma(row.businessDate),
    openedById: row.openedById,
    openedAt: row.openedAt.toISOString(),
    openingFloatCentavos: row.openingFloatCentavos,
    closedById: row.closedById,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    countedCentavos: row.countedCentavos,
    note: row.note,
  };
}

/**
 * Takes the two figures as arguments rather than reading the (nullable) columns
 * off the row: the caller has just computed them and knows they are settled,
 * whereas `row.expectedCentavos` is `number | null` and would need a `?? 0`
 * that could silently report a ₱0 expectation as a real one.
 */
export function toShiftClosure(
  row: Shift,
  expectedCentavos: number,
  varianceCentavos: number,
): ShiftClosure {
  return { ...toShiftView(row), expectedCentavos, varianceCentavos };
}
```

- [ ] **Step 4: Write `dto/shift.dto.ts`**

```typescript
// server/src/payments/dto/shift.dto.ts
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { IsCentavos } from '../../common/validators/is-centavos.validator';

/** Route 38. The cash physically in the box when the drawer is opened. */
export class OpenShiftDto {
  /**
   * `Shift_float_nonneg` is `>= 0` with no upper bound; the ₱100,000 ceiling
   * here is tighter than the CHECK on purpose. Tighter is always safe — the
   * rule is that nothing the pipe ACCEPTS may be rejected by the database, not
   * the reverse — and it turns a mis-keyed float (a stray zero on ₱3,000) into
   * a 400 at the counter rather than a wildly wrong variance at close.
   */
  @IsCentavos(0, 10_000_000)
  openingFloatCentavos!: number;
}

/**
 * Route 39. A BLIND count: this DTO carries what the staffer physically
 * counted and nothing else. There is no `expectedCentavos` field to send and
 * no way to ask for one before submitting — that is the entire mechanism.
 */
export class CloseShiftDto {
  @IsCentavos(0, 10_000_000)
  countedCentavos!: number;

  /**
   * Optional to the pipe, mandatory to the service beyond
   * SHIFT_VARIANCE_NOTE_THRESHOLD_CENTAVOS — the same split as `confirm`, and
   * for the same reason: a 400 reading "note should not be empty" tells the
   * console nothing it can act on, whereas SHIFT_VARIANCE_REASON_REQUIRED is a
   * code it can branch on to re-prompt with the variance rendered.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
```

- [ ] **Step 5: Write `shifts.service.ts`**

```typescript
// server/src/payments/shifts.service.ts
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainException } from '../common/exceptions/domain.exception';
import { mapPrismaError } from '../common/exceptions/prisma-error.mapper';
import { gymToday, toDateColumn } from '../common/time/gym-time';
import { GymConfigService } from '../config/gym.config';
import { PrismaService } from '../prisma/prisma.service';
import { toShiftClosure, toShiftView, type ShiftClosure, type ShiftView } from './shift.presenter';
import type { CloseShiftDto, OpenShiftDto } from './dto/shift.dto';

/**
 * The literal the nullable-unique sentinel holds while a drawer is open.
 *
 * `Shift.openMarker String? @unique` plus the `Shift_open_marker` CHECK
 * (`("status" = 'OPEN') = ("openMarker" IS NOT NULL)`) is how "at most one open
 * drawer" is enforced by the database rather than by the UI. It is a real
 * unique index Prisma owns and declares, so a later `migrate dev` will never
 * emit a DROP for it — which is exactly what a partial unique index would have
 * risked (R3).
 */
export const OPEN_MARKER = 'OPEN';

export interface ShiftClosureFigures {
  expectedCentavos: number;
  varianceCentavos: number;
}

/**
 * §5.7.6's arithmetic, pure. `expected = openingFloat + SUM(net)` over RECORDED
 * CASH payments in the shift; `variance = counted − expected`, signed, so a
 * short drawer is negative and a long one positive.
 *
 * GCash is excluded from the expectation because no GCash peso is ever in the
 * box: it is reconciled against the statement by `GET /reports/gcash`.
 */
export function computeClosure(
  openingFloatCentavos: number,
  cashRecordedCentavos: number,
  countedCentavos: number,
): ShiftClosureFigures {
  const expectedCentavos = openingFloatCentavos + cashRecordedCentavos;
  return { expectedCentavos, varianceCentavos: countedCentavos - expectedCentavos };
}

/** Beyond ±SHIFT_VARIANCE_NOTE_THRESHOLD_CENTAVOS the closer must explain it. */
export function assertVarianceExplained(
  figures: ShiftClosureFigures,
  note: string | undefined,
  thresholdCentavos: number,
): void {
  if (Math.abs(figures.varianceCentavos) <= thresholdCentavos) return;
  if (note !== undefined && note.trim().length >= 3) return;

  throw new DomainException(
    'SHIFT_VARIANCE_REASON_REQUIRED',
    `The count is off by ${figures.varianceCentavos} centavos. A difference beyond ` +
      `${thresholdCentavos} centavos needs a written note before the drawer can close.`,
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

/**
 * One cash-drawer session. Roughly ₱12,450/day crosses this counter, mostly in
 * cash, with two or three staff rotating through one drawer — so "is the money
 * in the box equal to what the system says" is the question this model exists
 * to answer, and the reason the owner will or will not trust any revenue figure
 * this system produces.
 */
@Injectable()
export class ShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
  ) {}

  /** Route 38. */
  async open(actorId: string, dto: OpenShiftDto): Promise<ShiftView> {
    const businessDate = gymToday(new Date(), this.gym.timeZone);

    try {
      const row = await this.prisma.shift.create({
        data: {
          openedById: actorId,
          openedAt: new Date(),
          openingFloatCentavos: dto.openingFloatCentavos,
          businessDate: toDateColumn(businessDate),
          openMarker: OPEN_MARKER,
        },
      });
      return toShiftView(row);
    } catch (error) {
      // Caught OUTSIDE any transaction — nothing further runs on a `tx` here,
      // so the 25P02 rule is not in play. Two staffers tapping "open drawer" at
      // once both insert; the sentinel's unique index lets exactly one win.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DomainException(
          'SHIFT_ALREADY_OPEN',
          'A drawer is already open. Close it before opening another.',
          HttpStatus.CONFLICT,
        );
      }
      const mapped = mapPrismaError(error);
      if (mapped) throw mapped;
      throw error;
    }
  }

  /** Route 40. Null is a normal answer — the gym is shut, or nobody has opened yet. */
  async current(): Promise<ShiftView | null> {
    const row = await this.prisma.shift.findUnique({ where: { openMarker: OPEN_MARKER } });
    return row ? toShiftView(row) : null;
  }

  /**
   * Route 39, the blind close.
   *
   * The count arrives in the request; the expectation is computed here and
   * disclosed only in the response. The whole sequence runs in one transaction
   * so the SUM cannot move between being read and being stored, and the write
   * is a CONDITIONAL update its own effect falsifies — `WHERE id = :id AND
   * status = 'OPEN'` reports count 0 rather than closing a drawer twice, and
   * reports it without aborting the transaction.
   */
  async close(actorId: string, id: string, dto: CloseShiftDto): Promise<ShiftClosure> {
    return this.prisma.$transaction(async (tx) => {
      const shift = await tx.shift.findUnique({ where: { id } });
      if (!shift) throw new NotFoundException('Shift not found');
      if (shift.status === 'CLOSED') {
        throw new DomainException(
          'SHIFT_ALREADY_CLOSED',
          'That drawer was already closed.',
          HttpStatus.CONFLICT,
        );
      }

      const cash = await tx.payment.aggregate({
        _sum: { netCentavos: true },
        where: { shiftId: id, status: 'RECORDED', method: 'CASH' },
      });
      const figures = computeClosure(
        shift.openingFloatCentavos,
        cash._sum.netCentavos ?? 0,
        dto.countedCentavos,
      );
      assertVarianceExplained(figures, dto.note, this.gym.shiftVarianceNoteThresholdCentavos);

      const { count } = await tx.shift.updateMany({
        where: { id, status: 'OPEN' },
        data: {
          status: 'CLOSED',
          closedById: actorId,
          closedAt: new Date(),
          countedCentavos: dto.countedCentavos,
          expectedCentavos: figures.expectedCentavos,
          varianceCentavos: figures.varianceCentavos,
          // Releases the sentinel. The Shift_open_marker CHECK requires this to
          // move in lockstep with `status`, so the two cannot disagree.
          openMarker: null,
          ...(dto.note === undefined ? {} : { note: dto.note }),
        },
      });
      if (count === 0) {
        throw new DomainException(
          'SHIFT_ALREADY_CLOSED',
          'That drawer was closed by someone else while you were counting.',
          HttpStatus.CONFLICT,
        );
      }

      const closed = await tx.shift.findUniqueOrThrow({ where: { id } });
      return toShiftClosure(closed, figures.expectedCentavos, figures.varianceCentavos);
    });
  }

  /**
   * The single source of SHIFT_NOT_OPEN.
   *
   * `Payment.shiftId` is NOT NULL and stays that way: an unattributed payment
   * cannot be reconciled, which is the entire point of the model. Attendance
   * without a drawer is reconcilable later; money without a drawer is not, so
   * only money hard-fails here — `POST /checkin` never calls this.
   *
   * Takes the transaction client so the drawer cannot be closed between this
   * check and the Payment insert that follows it, and resolves through the
   * unique sentinel so there is no "which open shift" ordering ambiguity.
   */
  async requireOpenShiftId(tx: Prisma.TransactionClient): Promise<string> {
    const open = await tx.shift.findUnique({
      where: { openMarker: OPEN_MARKER },
      select: { id: true },
    });
    if (!open) {
      throw new DomainException(
        'SHIFT_NOT_OPEN',
        'No cash drawer is open. Open a shift before recording money.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return open.id;
  }
}
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `npm test --workspace=server -- shifts.service`
Expected: PASS — 17 tests green across the five describes.

- [ ] **Step 7: Commit the service**

```bash
git add server/src/payments/shifts.service.ts \
        server/src/payments/shifts.service.spec.ts \
        server/src/payments/shift.presenter.ts \
        server/src/payments/dto/shift.dto.ts
git commit -m "feat(payments): the cash drawer — open, blind close, computed variance (spec 5.7.6)

expected = openingFloat + SUM(net) over RECORDED CASH payments, computed
server-side and disclosed only in the close response: ShiftView cannot
represent the figure at all, so there is no route that leaks it before the
count. Variance beyond SHIFT_VARIANCE_NOTE_THRESHOLD_CENTAVOS demands a note.

requireOpenShiftId(tx) is the single source of SHIFT_NOT_OPEN, resolved
through the openMarker sentinel inside the caller's own transaction."
```

- [ ] **Step 8: Write the failing e2e for routes 38–40**

Append the drawer fixture to the file task 8 created:

```typescript
// server/test/support/membership-fixtures.ts — APPEND after seedPlansForTest.
import { OPEN_MARKER } from '../../src/payments/shifts.service';
import { toDateColumn, type CivilDate } from '../../src/common/time/gym-time';

/**
 * Opens a drawer directly, bypassing route 38.
 *
 * Every fixture that writes a Payment needs one because `Payment.shiftId` is
 * NOT NULL, and going through the HTTP route would make half the membership
 * suites depend on `shift.manage` being granted to whichever role they happen
 * to be exercising. The ₱3,000 float matches what the counter actually starts
 * the day with.
 */
export async function openShift(
  prisma: PrismaClient,
  openedById: string,
  businessDate: CivilDate,
): Promise<string> {
  const shift = await prisma.shift.create({
    data: {
      openedById,
      openedAt: new Date(),
      openingFloatCentavos: 300_000,
      businessDate: toDateColumn(businessDate),
      openMarker: OPEN_MARKER,
    },
  });
  return shift.id;
}
```

Then create the suite:

```typescript
// server/test/payments-shifts.e2e-spec.ts
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Server } from 'http';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import { seedPlansForTest } from './support/membership-fixtures';

jest.setTimeout(120_000);

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface ShiftBody {
  id: string;
  status: string;
  businessDate: string;
  openedById: string;
  openedAt: string;
  openingFloatCentavos: number;
  closedById: string | null;
  closedAt: string | null;
  countedCentavos: number | null;
  note: string | null;
}

interface ClosureBody extends ShiftBody {
  expectedCentavos: number;
  varianceCentavos: number;
}

describe('payments & shifts (e2e)', () => {
  let ctx: TestApp;
  let server: Server;

  let adminToken: string;
  let frontDeskToken: string;
  let clientToken: string;
  let frontDeskId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('shifts (routes 38, 39, 40)', () => {
    beforeEach(async () => {
      await resetDatabase(ctx.prisma);
      await seedPlansForTest(ctx.prisma);
      adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
      frontDeskToken = await ctx.fixture.tokenFor('FRONT_DESK', {
        supabaseId: FIXTURE_IDS.FRONT_DESK,
      });
      clientToken = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
      frontDeskId = await ctx.fixture.userIdFor(FIXTURE_IDS.FRONT_DESK);
    });

    async function openDrawer(token: string, openingFloatCentavos = 300_000): Promise<ShiftBody> {
      const response = await request(server)
        .post('/api/v1/shifts/open')
        .set('Authorization', `Bearer ${token}`)
        .send({ openingFloatCentavos })
        .expect(201);
      return (response.body as Envelope<ShiftBody>).data as ShiftBody;
    }

    it('opens a drawer for FRONT_DESK and attributes it to the opener', async () => {
      const shift = await openDrawer(frontDeskToken);

      expect(shift.status).toBe('OPEN');
      expect(shift.openingFloatCentavos).toBe(300_000);
      expect(shift.openedById).toBe(frontDeskId);
      expect(shift.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(shift.closedAt).toBeNull();
    });

    // The whole mechanism: a visible expected total gets back-fitted every time.
    it('never discloses expectedCentavos on the open response', async () => {
      const shift = await openDrawer(frontDeskToken);

      expect(shift).not.toHaveProperty('expectedCentavos');
      expect(shift).not.toHaveProperty('varianceCentavos');
    });

    it('409s SHIFT_ALREADY_OPEN on a second open — one counter, one drawer', async () => {
      await openDrawer(frontDeskToken);

      const response = await request(server)
        .post('/api/v1/shifts/open')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ openingFloatCentavos: 300_000 })
        .expect(409);

      expect((response.body as Envelope<never>).error?.code).toBe('SHIFT_ALREADY_OPEN');
      expect(await ctx.prisma.shift.count()).toBe(1);
    });

    it('refuses a CLIENT: shift.manage is FRONT_DESK and ADMIN only', async () => {
      await request(server)
        .post('/api/v1/shifts/open')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ openingFloatCentavos: 300_000 })
        .expect(403);

      await request(server)
        .get('/api/v1/shifts/current')
        .set('Authorization', `Bearer ${clientToken}`)
        .expect(403);
    });

    it('400s a fractional or negative float — money is integer centavos', async () => {
      await request(server)
        .post('/api/v1/shifts/open')
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .send({ openingFloatCentavos: 3000.5 })
        .expect(400);

      await request(server)
        .post('/api/v1/shifts/open')
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .send({ openingFloatCentavos: -1 })
        .expect(400);
    });

    it('returns null from /shifts/current when no drawer is open', async () => {
      const response = await request(server)
        .get('/api/v1/shifts/current')
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .expect(200);

      expect((response.body as Envelope<ShiftBody | null>).data).toBeNull();
    });

    it('returns the open drawer from /shifts/current, still without the expected figure', async () => {
      const opened = await openDrawer(frontDeskToken);

      const response = await request(server)
        .get('/api/v1/shifts/current')
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .expect(200);

      const current = (response.body as Envelope<ShiftBody>).data as ShiftBody;
      expect(current.id).toBe(opened.id);
      expect(current).not.toHaveProperty('expectedCentavos');
    });

    it('closes on a blind count and discloses the expected figure only in that response', async () => {
      const shift = await openDrawer(frontDeskToken);

      const response = await request(server)
        .post(`/api/v1/shifts/${shift.id}/close`)
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ countedCentavos: 300_000 })
        .expect(200);

      const closure = (response.body as Envelope<ClosureBody>).data as ClosureBody;
      expect(closure.status).toBe('CLOSED');
      expect(closure.countedCentavos).toBe(300_000);
      // No payments recorded yet, so the expectation is exactly the float.
      expect(closure.expectedCentavos).toBe(300_000);
      expect(closure.varianceCentavos).toBe(0);
      expect(closure.closedAt).not.toBeNull();
    });

    it('releases the sentinel so the next staffer can open a fresh drawer', async () => {
      const first = await openDrawer(frontDeskToken);
      await request(server)
        .post(`/api/v1/shifts/${first.id}/close`)
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ countedCentavos: 300_000 })
        .expect(200);

      const closedRow = await ctx.prisma.shift.findUniqueOrThrow({ where: { id: first.id } });
      expect(closedRow.openMarker).toBeNull();

      const second = await openDrawer(adminToken, 250_000);
      expect(second.id).not.toBe(first.id);
      expect(await ctx.prisma.shift.count()).toBe(2);
    });

    it('422s SHIFT_VARIANCE_REASON_REQUIRED on a ₱250 gap with no note, and writes nothing', async () => {
      const shift = await openDrawer(frontDeskToken);

      const response = await request(server)
        .post(`/api/v1/shifts/${shift.id}/close`)
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ countedCentavos: 275_000 })
        .expect(422);

      expect((response.body as Envelope<never>).error?.code).toBe(
        'SHIFT_VARIANCE_REASON_REQUIRED',
      );
      const row = await ctx.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
      expect(row.status).toBe('OPEN');
      expect(row.countedCentavos).toBeNull();
    });

    it('accepts the same gap with a note, and stores the signed variance', async () => {
      const shift = await openDrawer(frontDeskToken);

      const response = await request(server)
        .post(`/api/v1/shifts/${shift.id}/close`)
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ countedCentavos: 275_000, note: 'paid the water delivery in cash, receipt in book' })
        .expect(200);

      const closure = (response.body as Envelope<ClosureBody>).data as ClosureBody;
      expect(closure.varianceCentavos).toBe(-25_000);
      expect(closure.note).toMatch(/water delivery/);

      const row = await ctx.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
      expect(row.varianceCentavos).toBe(-25_000);
      expect(row.expectedCentavos).toBe(300_000);
    });

    it('accepts a ₱150 gap with no note — inside the ±₱200 threshold', async () => {
      const shift = await openDrawer(frontDeskToken);

      const response = await request(server)
        .post(`/api/v1/shifts/${shift.id}/close`)
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ countedCentavos: 285_000 })
        .expect(200);

      expect((response.body as Envelope<ClosureBody>).data?.varianceCentavos).toBe(-15_000);
    });

    it('409s SHIFT_ALREADY_CLOSED on a second close with a different key', async () => {
      const shift = await openDrawer(frontDeskToken);
      await request(server)
        .post(`/api/v1/shifts/${shift.id}/close`)
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ countedCentavos: 300_000 })
        .expect(200);

      const response = await request(server)
        .post(`/api/v1/shifts/${shift.id}/close`)
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ countedCentavos: 300_000 })
        .expect(409);

      expect((response.body as Envelope<never>).error?.code).toBe('SHIFT_ALREADY_CLOSED');
    });

    it('replays the stored closure verbatim for a repeated Idempotency-Key', async () => {
      const shift = await openDrawer(frontDeskToken);
      const key = randomUUID();

      const first = await request(server)
        .post(`/api/v1/shifts/${shift.id}/close`)
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', key)
        .send({ countedCentavos: 300_000 })
        .expect(200);

      const replay = await request(server)
        .post(`/api/v1/shifts/${shift.id}/close`)
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', key)
        .send({ countedCentavos: 300_000 })
        .expect(200);

      expect(replay.body).toEqual(first.body);
    });

    it('400s a close with no Idempotency-Key header', async () => {
      const shift = await openDrawer(frontDeskToken);

      await request(server)
        .post(`/api/v1/shifts/${shift.id}/close`)
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .send({ countedCentavos: 300_000 })
        .expect(400);
    });

    it('404s an unknown shift id', async () => {
      await request(server)
        .post('/api/v1/shifts/8f14e45f-ceea-4671-a3ab-9e2a5b3f0000/close')
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ countedCentavos: 300_000 })
        .expect(404);
    });

    it('400s a non-uuid shift id before reaching the service', async () => {
      await request(server)
        .post('/api/v1/shifts/not-a-uuid/close')
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ countedCentavos: 300_000 })
        .expect(400);
    });
  });
});
```

- [ ] **Step 9: Run the e2e and watch it fail**

Run: `npm run test:e2e --workspace=server -- payments-shifts`
Expected: FAIL — every request 404s with `Cannot POST /api/v1/shifts/open`, because no controller is mounted yet.

- [ ] **Step 10: Write `shifts.controller.ts`**

```typescript
// server/src/payments/shifts.controller.ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { AuthUser } from '../auth/auth.types';
import { ShiftsService } from './shifts.service';
import type { ShiftClosure, ShiftView } from './shift.presenter';
import { CloseShiftDto, OpenShiftDto } from './dto/shift.dto';

/**
 * Routes 38–40, all on `shift.manage` (FRONT_DESK + ADMIN).
 *
 * Nothing here is scoped: there is exactly one drawer, and a staffer who may
 * manage it may see all of it. That is why no handler takes `@Scope()` — Shift
 * has no `userId`, so `'ownedByUser'` would not even be the right subject.
 *
 * Declaration order matters only in that `@Get('current')` shares no shape
 * with any parameterised GET — there is deliberately no `GET /shifts/:id` in
 * this chunk, because the only reason to fetch a closed shift by id is to read
 * the expected figure, and that is disclosed once, in the close response.
 */
@Controller('shifts')
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Post('open')
  @RequirePermission('shift.manage')
  async open(@CurrentUser() user: AuthUser, @Body() dto: OpenShiftDto): Promise<ShiftView> {
    return this.shifts.open(user.id, dto);
  }

  /**
   * 200, not 201: the close mutates an existing drawer rather than creating a
   * resource. `@Idempotent()` because a double-tapped close on a flaky counter
   * connection must not turn into a 409 the staffer has to reason about — the
   * interceptor replays the stored closure, figures and all.
   */
  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('shift.manage')
  @Idempotent()
  async close(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CloseShiftDto,
  ): Promise<ShiftClosure> {
    return this.shifts.close(user.id, id, dto);
  }

  /** Null is a valid, renderable answer: the drawer is simply shut. */
  @Get('current')
  @RequirePermission('shift.manage')
  async current(): Promise<ShiftView | null> {
    return this.shifts.current();
  }
}
```

- [ ] **Step 11: Write `payments.module.ts` and register it**

```typescript
// server/src/payments/payments.module.ts
import { Module } from '@nestjs/common';
import { ShiftsController } from './shifts.controller';
import { ShiftsService } from './shifts.service';

/**
 * The money module. Shifts land first because `Payment.shiftId` is NOT NULL
 * and stays that way — nothing can record a payment until a drawer can be
 * opened.
 *
 * Task 10 adds PaymentsController/PaymentsService here; task 17 adds
 * ReportsController, ReportsService and the SUMMARY_TRANSPORT provider.
 * `ShiftsService` is exported because MembershipModule's sales and holds
 * services call `requireOpenShiftId(tx)` inside their own transactions.
 */
@Module({
  controllers: [ShiftsController],
  providers: [ShiftsService],
  exports: [ShiftsService],
})
export class PaymentsModule {}
```

In `server/src/app.module.ts`, add the import after the `CatalogueModule` line task 8 introduced (line 12):

```typescript
import { PaymentsModule } from './payments/payments.module';
```

and add it to the feature list immediately after `CatalogueModule,` (line 64):

```typescript
    PaymentsModule,
```

- [ ] **Step 12: Run the e2e and watch it pass**

Run: `npm run test:e2e --workspace=server -- payments-shifts`
Expected: PASS — 17 tests green in the `shifts (routes 38, 39, 40)` describe.

- [ ] **Step 13: Run the full unit suite and the typecheck**

Run: `npm test --workspace=server && npm run typecheck --workspace=server`
Expected: PASS — the baseline suites plus `plan-registry` and `shifts.service`, typecheck exits 0. `npm run lint` remains red with its ~19–27 pre-existing problems; do not fix them here.

- [ ] **Step 14: Commit**

```bash
git add server/src/payments/shifts.controller.ts \
        server/src/payments/payments.module.ts \
        server/src/app.module.ts \
        server/test/support/membership-fixtures.ts \
        server/test/payments-shifts.e2e-spec.ts
git commit -m "feat(payments): wire routes 38-40 — open, blind close and current drawer

POST /shifts/open 409s SHIFT_ALREADY_OPEN from the openMarker sentinel
rather than from a UI check; POST /shifts/:id/close is 200, @Idempotent and
the ONLY response in the system that carries expectedCentavos; GET
/shifts/current returns null when the drawer is shut.

Adds openShift() to the shared fixtures — every membership suite that writes
a Payment needs one, because Payment.shiftId is NOT NULL."
```

---

### Task 10: Payments — record, list, void, idempotency

**Files:**
- Create: `server/src/payments/payments.service.ts`
- Create: `server/src/payments/payments.controller.ts`
- Create: `server/src/payments/payment.presenter.ts`
- Create: `server/src/payments/dto/record-payment.dto.ts`
- Create: `server/src/payments/dto/void-payment.dto.ts`
- Create: `server/src/payments/dto/list-payments-query.dto.ts`
- Create: `server/test/support/membership-fixtures.ts`
- Modify: `server/src/payments/payments.module.ts` (created in task 9 — add `RbacModule` and `CatalogueModule` to `imports`, `PaymentsService` to `providers` and `exports`, `PaymentsController` to `controllers`)
- Test: `server/test/payments-shifts.e2e-spec.ts` (created in task 9 — append the `payments` describe)

**Interfaces:**
- Consumes: `server/src/membership/membership-terms.ts`: `computeAmounts(input: AmountsInput): Amounts`, `interface Amounts { grossCentavos; vatBaseCentavos; discountCentavos; netCentavos; vatExempt }` (task 3) · `server/src/payments/shifts.service.ts`: `ShiftsService.requireOpenShiftId(tx: Prisma.TransactionClient): Promise<string>` throwing 422 `SHIFT_NOT_OPEN` (task 9) · `server/src/catalogue/plans.service.ts`: `PlansService.requireSellable(tx: Prisma.TransactionClient, planCode: string): Promise<Plan>` throwing 404 `PLAN_NOT_FOUND` / 422 `PLAN_ARCHIVED` (task 8) · `server/src/common/validators/is-centavos.validator.ts`: `IsCentavos(min, max, options?)` and `server/src/common/dto/confirm.dto.ts`: `ConfirmDto`, `assertConfirmed` (task 2) · `GymConfigService.timeZone`, `.vatRegistered` (task 2) · `server/src/rbac/permissions.service.ts`: `PermissionsService.getEffectivePermissions(user: PermissionUser)` (Chunk 0) · `server/src/common/idempotency/request-hash.ts`: `hashRequestBody` · `server/src/common/decorators/idempotent.decorator.ts`: `Idempotent()` · `server/src/rbac/scope.util.ts`: `ScopedWhere`, `@Scope('ownedByUser')` · `server/src/common/dto/paginate.ts`: `paginated`, `paginationSkipTake` · `server/src/common/time/gym-time.ts`: `gymToday`, `toDateColumn`, `civilDateFromPrisma`, `asCivilDate` · permission keys `payment.read`, `payment.record`, `payment.discount.statutory`, `payment.discount.grant`, `payment.void` (task 2)
- Produces: `PaymentSummary`, `toPaymentSummary(row: Payment): PaymentSummary` · `RecordPaymentDto`, `VoidPaymentDto`, `ListPaymentsQueryDto` · `PaymentListResult = PaginatedData<PaymentSummary> & { totalCentavos: number; byMethod: { CASH: number; GCASH: number } }` · `CreatePaymentInput` · `PaymentsService { record, list, listForMember, void, createInTx, assertDiscountAllowed }` — `createInTx` is the one INSERT into `Payment` in this codebase, claims `idempotencyKey` with `createMany({ skipDuplicates: true })` and branches on `count === 0`, and is what membership sales (task 12) and the freeze fee (task 14) reuse · `server/test/support/membership-fixtures.ts` exports `TEST_PLANS`, `seedPlansForTest(prisma)`, `openShift(prisma, openedById, today, openingFloatCentavos?)`

**Two adjudications this task makes, both stated so no later task re-opens them:**

1. **Route 34 records a walk-in and nothing else.** `RecordPaymentDto.purpose` is validated as a `PaymentPurpose`, and the service refuses anything but `WALK_IN` with 422 `PAYMENT_SHAPE_INVALID`. A `MEMBERSHIP` payment is written by `createInTx` inside the *same transaction* as the membership row (routes 22/23, task 12) and a `FREEZE_FEE` inside the hold's transaction (route 26, task 14). If route 34 could write either, a term could be paid for without a term being created, and `Payment_purpose_shape` would become a user-facing 422 instead of a backstop. §7.7's error column for route 34 lists `MEMBERSHIP_NOT_FOUND`; the route as built cannot produce it.
2. **§5.7.6's front-desk self-void does not ship in Chunk 1.** Route 35 carries `payment.void`, which §5.11 grants to ADMIN only. `@RequirePermission` resolves with `getAllAndOverride`, so one route cannot carry two keys, and `PermissionsGuard` 403s a FRONT_DESK caller before any handler could apply the "own payment, own open shift" test. The desk-side void lands with the desk console in Chunk 2 as its own route under its own key. Do not widen the `payment.void` grant to make it work here — that would hand FRONT_DESK the ability to void an ADMIN's payment from a closed shift.

---

- [ ] **Step 1: Write the shared e2e fixture builders**

Create `server/test/support/membership-fixtures.ts`:

```typescript
import type { Plan, PrismaClient, Shift } from '@prisma/client';
import { toDateColumn, type CivilDate } from '../../src/common/time/gym-time';

/**
 * Builders for the states every membership and payment e2e suite needs.
 *
 * `resetDatabase` TRUNCATEs everything except Permission, RolePermission and
 * _prisma_migrations, so Plan rows do NOT survive between suites and every
 * suite re-seeds through `seedPlansForTest`.
 *
 * The four rows below are §5.3.2's table restated, deliberately NOT imported
 * from src/catalogue/plan-registry.ts: a fixture that silently followed a
 * price-list edit would make a money assertion mean something different from
 * one run to the next, and these suites assert exact centavos. If §5.3.2's
 * table changes, this file changes with it, in the same commit.
 */
export const TEST_PLANS = [
  {
    code: 'WALKIN',
    name: 'Walk-in',
    kind: 'WALK_IN' as const,
    priceCentavos: 9000,
    termMonths: null,
    freezable: false,
    guestPassesPerTerm: 0,
    graceDays: 0,
    sortOrder: 0,
  },
  {
    code: 'MONTHLY',
    name: 'Monthly',
    kind: 'TERM' as const,
    priceCentavos: 80000,
    termMonths: 1,
    freezable: false,
    guestPassesPerTerm: 0,
    graceDays: 3,
    sortOrder: 1,
  },
  {
    code: 'QUARTERLY',
    name: 'Quarterly',
    kind: 'TERM' as const,
    priceCentavos: 220000,
    termMonths: 3,
    freezable: true,
    guestPassesPerTerm: 0,
    graceDays: 3,
    sortOrder: 2,
  },
  {
    code: 'ANNUAL',
    name: 'Annual',
    kind: 'TERM' as const,
    priceCentavos: 750000,
    termMonths: 12,
    freezable: true,
    guestPassesPerTerm: 2,
    graceDays: 3,
    sortOrder: 3,
  },
];

/** Create-only, exactly like the real seed: a re-run must revert no price. */
export async function seedPlansForTest(prisma: PrismaClient): Promise<Record<string, Plan>> {
  await prisma.plan.createMany({ data: TEST_PLANS, skipDuplicates: true });
  const rows = await prisma.plan.findMany();
  return Object.fromEntries(rows.map((row) => [row.code, row]));
}

/**
 * One open drawer. `openMarker` is the literal string 'OPEN' — the
 * nullable-unique sentinel, so a second call fails on Shift_openMarker_key
 * rather than quietly giving the suite two open shifts.
 */
export async function openShift(
  prisma: PrismaClient,
  openedById: string,
  today: CivilDate,
  openingFloatCentavos = 500_000,
): Promise<Shift> {
  return prisma.shift.create({
    data: {
      openedById,
      openedAt: new Date(`${today}T01:00:00.000Z`),
      openingFloatCentavos,
      businessDate: toDateColumn(today),
      openMarker: 'OPEN',
    },
  });
}
```

- [ ] **Step 2: Write the failing e2e for routes 33–35**

```typescript
// server/test/payments-shifts.e2e-spec.ts — APPEND this describe to the file
// task 9 created. It reuses that file's outer `ctx` (TestApp) and `server`
// (http.Server) and declares everything else itself.
//
// Add to that file's import block:
//   import { randomUUID } from 'node:crypto';
//   import { gymToday } from '../src/common/time/gym-time';
//   import { openShift, seedPlansForTest } from './support/membership-fixtures';

describe('payments (routes 33, 34, 35)', () => {
  const TODAY = gymToday(new Date(), 'Asia/Manila');

  let adminToken: string;
  let deskToken: string;
  let adminId: string;
  let memberId: string;

  /** A fresh key per call: the interceptor rejects anything but a UUID v4. */
  function key(): string {
    return randomUUID();
  }

  function walkIn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      purpose: 'WALK_IN',
      planCode: 'WALKIN',
      grossCentavos: 9000,
      method: 'CASH',
      ...overrides,
    };
  }

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await seedPlansForTest(ctx.prisma);

    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    deskToken = await ctx.fixture.tokenFor('FRONT_DESK', { supabaseId: FIXTURE_IDS.FRONT_DESK });
    await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });

    adminId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
    memberId = await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_A);
  });

  describe('POST /payments', () => {
    beforeEach(async () => {
      await openShift(ctx.prisma, adminId, TODAY);
    });

    it('records a ₱90 walk-in as integer centavos, with no formatted currency anywhere', async () => {
      const response = await request(server)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${deskToken}`)
        .set('Idempotency-Key', key())
        .send(walkIn({ userId: memberId }))
        .expect(201);

      const payment = response.body.data;
      expect(payment.grossCentavos).toBe(9000);
      expect(payment.vatBaseCentavos).toBe(9000);
      expect(payment.discountCentavos).toBe(0);
      expect(payment.netCentavos).toBe(9000);
      expect(payment.vatExempt).toBe(false);
      expect(payment.status).toBe('RECORDED');
      expect(payment.purpose).toBe('WALK_IN');
      expect(payment.membershipId).toBeNull();
      expect(payment.businessDate).toBe(TODAY);
      expect(JSON.stringify(response.body)).not.toMatch(/₱|PHP/);

      const rows = await ctx.prisma.payment.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0].shiftId).not.toBeNull();
      expect(rows[0].recordedById).toBe(await ctx.fixture.userIdFor(FIXTURE_IDS.FRONT_DESK));
    });

    it('records an off-the-street guest with no account at all', async () => {
      const response = await request(server)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${deskToken}`)
        .set('Idempotency-Key', key())
        .send(walkIn())
        .expect(201);

      expect(response.body.data.userId).toBeNull();
    });

    it('replays one key to 200 with the same row and writes exactly one Payment', async () => {
      const idempotencyKey = key();
      const body = walkIn({ userId: memberId });

      const first = await request(server)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${deskToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(body)
        .expect(201);

      const second = await request(server)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${deskToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(body)
        .expect(200);

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(second.body.success).toBe(true);
      // Exactly one envelope on the replay, not a nested one.
      expect(second.body.data.data).toBeUndefined();
      expect(await ctx.prisma.payment.count()).toBe(1);
    });

    it('refuses the same key with a different body: 409, and no second row', async () => {
      const idempotencyKey = key();

      await request(server)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${deskToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(walkIn())
        .expect(201);

      // The case §5.7.5 exists for: returning the ₱90 receipt for an ₱8,000
      // request is worse than no idempotency, because it looks like success.
      const response = await request(server)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${deskToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(walkIn({ planCode: 'MONTHLY', grossCentavos: 80000 }))
        .expect(409);

      expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await ctx.prisma.payment.count()).toBe(1);
    });

    it('rejects a request with no Idempotency-Key header at all', async () => {
      await request(server)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${deskToken}`)
        .send(walkIn())
        .expect(400);
    });

    it('computes the statutory 20% itself — staff never type the amount', async () => {
      const response = await request(server)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${deskToken}`)
        .set('Idempotency-Key', key())
        .send(
          walkIn({
            userId: memberId,
            discountType: 'SENIOR',
            statutoryIdNo: 'OSCA-TAG-114532',
          }),
        )
        .expect(201);

      // GYM_VAT_REGISTERED defaults false, so vatBase is the gross and the
      // whole 20% comes off it: 9000 → 1800 → 7200.
      const payment = response.body.data;
      expect(payment.vatExempt).toBe(false);
      expect(payment.vatBaseCentavos).toBe(9000);
      expect(payment.discountCentavos).toBe(1800);
      expect(payment.netCentavos).toBe(7200);
      expect(payment.statutoryIdNo).toBe('OSCA-TAG-114532');
    });

    it('refuses a SENIOR discount with no OSCA/PWD ID — BIR keeps that record', async () => {
      const response = await request(server)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${deskToken}`)
        .set('Idempotency-Key', key())
        .send(walkIn({ discountType: 'SENIOR' }))
        .expect(422);

      expect(response.body.error.code).toBe('STATUTORY_ID_REQUIRED');
      expect(await ctx.prisma.payment.count()).toBe(0);
    });

    it('refuses FRONT_DESK a GOODWILL discount but allows ADMIN a ₱0 comp', async () => {
      const refused = await request(server)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${deskToken}`)
        .set('Idempotency-Key', key())
        .send(
          walkIn({
            discountType: 'GOODWILL',
            discountCentavos: 9000,
            discountReason: 'apology for the aircon',
          }),
        )
        .expect(403);
      expect(refused.body.error.message).toContain('payment.discount.grant');

      const allowed = await request(server)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', key())
        .send(
          walkIn({
            discountType: 'GOODWILL',
            discountCentavos: 9000,
            discountReason: 'apology for the aircon',
          }),
        )
        .expect(201);

      // netCentavos = 0 is legal exactly because the type is a comp type.
      expect(allowed.body.data.netCentavos).toBe(0);
      expect(allowed.body.data.grossCentavos).toBe(9000);
    });

    it('refuses a discretionary discount with no reason', async () => {
      const response = await request(server)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', key())
        .send(walkIn({ discountType: 'PROMO', discountCentavos: 1000 }))
        .expect(422);

      expect(response.body.error.code).toBe('DISCOUNT_ID_REQUIRED');
    });

    it('refuses GCASH with no reference — an unreconcilable GCash row is worthless', async () => {
      const response = await request(server)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${deskToken}`)
        .set('Idempotency-Key', key())
        .send(walkIn({ method: 'GCASH' }))
        .expect(422);

      expect(response.body.error.code).toBe('GCASH_REFERENCE_REQUIRED');
    });

    it('refuses a gross that disagrees with the price list', async () => {
      const response = await request(server)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${deskToken}`)
        .set('Idempotency-Key', key())
        .send(walkIn({ grossCentavos: 8000 }))
        .expect(422);

      expect(response.body.error.code).toBe('PAYMENT_AMOUNT_MISMATCH');
    });

    it('refuses a MEMBERSHIP purpose: a term is sold through POST /memberships', async () => {
      const response = await request(server)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${deskToken}`)
        .set('Idempotency-Key', key())
        .send(walkIn({ purpose: 'MEMBERSHIP', planCode: 'MONTHLY', grossCentavos: 80000 }))
        .expect(422);

      expect(response.body.error.code).toBe('PAYMENT_SHAPE_INVALID');
    });

    it('refuses a CLIENT outright — no member records their own money', async () => {
      const clientToken = await ctx.fixture.tokenFor('CLIENT', {
        supabaseId: FIXTURE_IDS.CLIENT_A,
      });

      await request(server)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', key())
        .send(walkIn())
        .expect(403);
    });
  });

  it('refuses to record anything with no open drawer', async () => {
    const response = await request(server)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${deskToken}`)
      .set('Idempotency-Key', key())
      .send(walkIn())
      .expect(422);

    expect(response.body.error.code).toBe('SHIFT_NOT_OPEN');
    expect(await ctx.prisma.payment.count()).toBe(0);
  });

  describe('GET /payments and POST /payments/:id/void', () => {
    let cashId: string;

    beforeEach(async () => {
      await openShift(ctx.prisma, adminId, TODAY);

      const cash = await request(server)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${deskToken}`)
        .set('Idempotency-Key', key())
        .send(walkIn({ userId: memberId }))
        .expect(201);
      cashId = cash.body.data.id;

      await request(server)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${deskToken}`)
        .set('Idempotency-Key', key())
        .send(walkIn())
        .expect(201);

      await request(server)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${deskToken}`)
        .set('Idempotency-Key', key())
        .send(walkIn({ method: 'GCASH', reference: 'GC-8842019' }))
        .expect(201);
    });

    it('voids with who and why, and refuses a second void', async () => {
      const voided = await request(server)
        .post(`/api/v1/payments/${cashId}/void`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ confirm: true, reason: 'rang the wrong plan' })
        .expect(200);

      expect(voided.body.data.status).toBe('VOIDED');
      expect(voided.body.data.voidReason).toBe('rang the wrong plan');
      expect(voided.body.data.voidedById).toBe(adminId);
      expect(voided.body.data.voidedAt).not.toBeNull();
      // A void is never a delete: the drawer still has to reconcile.
      expect(await ctx.prisma.payment.count()).toBe(3);

      const again = await request(server)
        .post(`/api/v1/payments/${cashId}/void`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ confirm: true, reason: 'again' })
        .expect(422);
      expect(again.body.error.code).toBe('PAYMENT_ALREADY_VOIDED');
    });

    it('refuses a void with no confirm, and a void from FRONT_DESK', async () => {
      const unconfirmed = await request(server)
        .post(`/api/v1/payments/${cashId}/void`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'oops' })
        .expect(400);
      expect(unconfirmed.body.error.code).toBe('CONFIRMATION_REQUIRED');

      // §5.7.6's desk self-void is deliberately not built in chunk 1: one
      // route cannot carry two permission keys.
      await request(server)
        .post(`/api/v1/payments/${cashId}/void`)
        .set('Authorization', `Bearer ${deskToken}`)
        .send({ confirm: true, reason: 'mine to fix' })
        .expect(403);
    });

    it('404s an unknown payment id rather than leaking that it does not exist', async () => {
      const response = await request(server)
        .post('/api/v1/payments/0b000000-0000-4000-8000-00000000ff01/void')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ confirm: true, reason: 'nothing there' })
        .expect(404);

      expect(response.body.error.code).toBe('PAYMENT_NOT_FOUND');
    });

    it('totals RECORDED money only, split by method', async () => {
      await request(server)
        .post(`/api/v1/payments/${cashId}/void`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ confirm: true, reason: 'rang the wrong plan' })
        .expect(200);

      const response = await request(server)
        .get('/api/v1/payments')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const data = response.body.data;
      expect(data.total).toBe(3);
      expect(data.totalCentavos).toBe(18000);
      expect(data.byMethod).toEqual({ CASH: 9000, GCASH: 9000 });
    });

    it('filters by method and by businessDate range', async () => {
      const byMethod = await request(server)
        .get('/api/v1/payments?method=GCASH')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(byMethod.body.data.items).toHaveLength(1);
      expect(byMethod.body.data.items[0].reference).toBe('GC-8842019');

      const empty = await request(server)
        .get('/api/v1/payments?from=2020-01-01&to=2020-01-31')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(empty.body.data.items).toEqual([]);
      expect(empty.body.data.totalCentavos).toBe(0);
    });

    it('rejects a from= that is a timestamp rather than a civil date', async () => {
      await request(server)
        .get('/api/v1/payments?from=2026-08-19T00:00:00.000Z')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });
  });
});
```

- [ ] **Step 3: Run the e2e and watch it fail**

Run: `npm run test:e2e --workspace=server -- payments-shifts`
Expected: FAIL — `expected 201 "Created", got 404 "Not Found"` on `POST /api/v1/payments` (no `PaymentsController` exists yet).

- [ ] **Step 4: Write the three payment DTOs**

Create `server/src/payments/dto/record-payment.dto.ts`:

```typescript
import { IsEnum, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import { IsISO8601 } from 'class-validator';
import { DiscountType, PaymentMethod, PaymentPurpose } from '@got/shared';
import { IsCentavos } from '../../common/validators/is-centavos.validator';

/**
 * The canonical money DTO for a counter sale.
 *
 * Bounds match the Payment CHECKs character for character (§5.8.5), so there
 * is no input the pipe accepts that the database then rejects — a 422 from a
 * CHECK is a bug report, never a user-facing path.
 *
 * `grossCentavos` is REQUIRED and must equal the plan's list price. Staff do
 * not compute it: the sale sheet echoes back the figure it was quoted, and the
 * server refuses a stale price sheet with PAYMENT_AMOUNT_MISMATCH rather than
 * writing a receipt for a price nobody published.
 *
 * `netCentavos` is OPTIONAL, and that asymmetry is deliberate. For a statutory
 * discount the desk MUST NOT know the net — §5.7.4 requires the server to
 * compute it — so a required net would force the 20% arithmetic back into the
 * client. When it is sent (NONE, or a discretionary discount the operator
 * entered) it is checked against the computed figure.
 */
export class RecordPaymentDto {
  /**
   * WALK_IN only, refused in the service for anything else. A MEMBERSHIP
   * payment is written inside the membership transaction (routes 22, 23) and a
   * FREEZE_FEE inside the hold transaction (route 26); if this route could
   * write either, money could be taken for a term that was never created.
   */
  @IsEnum(PaymentPurpose)
  purpose!: PaymentPurpose;

  /** The immutable snapshot key from the price list, e.g. 'WALKIN'. */
  @IsString()
  @Length(2, 32)
  planCode!: string;

  /** NULL for an off-the-street guest with no account. */
  @IsOptional()
  @IsUUID('4')
  userId?: string;

  @IsCentavos(1, 10_000_000)
  grossCentavos!: number;

  @IsOptional()
  @IsCentavos(0, 10_000_000)
  netCentavos?: number;

  @IsOptional()
  @IsEnum(DiscountType)
  discountType?: DiscountType;

  /** Read for PROMO / STAFF / GUEST_PASS / GOODWILL only; ignored otherwise. */
  @IsOptional()
  @IsCentavos(0, 10_000_000)
  discountCentavos?: number;

  /** Required for SENIOR / PWD. BIR keeps this register separately. */
  @IsOptional()
  @IsString()
  @Length(3, 64)
  statutoryIdNo?: string;

  /** Required for the discretionary types; ≥ 3 chars, matching the CHECK. */
  @IsOptional()
  @IsString()
  @Length(3, 200)
  discountReason?: string;

  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  /** Required for GCASH — the reference the member showed on their screen. */
  @IsOptional()
  @IsString()
  @Length(3, 64)
  reference?: string;

  /** The number staff wrote in the BIR booklet. Free text, never a sequence. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  receiptNo?: string;

  /**
   * A real instant, not a civil date, so IsISO8601 is correct here and
   * IsGymDate is not. Present for the entry staff forgot to make yesterday;
   * the business day is derived from it, never sent separately.
   */
  @IsOptional()
  @IsISO8601()
  receivedAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
```

Create `server/src/payments/dto/void-payment.dto.ts`:

```typescript
import { IsString, Length } from 'class-validator';
import { ConfirmDto } from '../../common/dto/confirm.dto';

/**
 * A void is the only mutation a Payment ever accepts. There is no PATCH, no
 * partial refund and no negative amount: a mistake is voided and re-recorded,
 * which is what an auditor expects and what keeps the daily count reconcilable.
 */
export class VoidPaymentDto extends ConfirmDto {
  /** Length matches MembershipEvent_reason_required's btrim(...) >= 3. */
  @IsString()
  @Length(3, 200)
  reason!: string;
}
```

Create `server/src/payments/dto/list-payments-query.dto.ts`:

```typescript
import { IsEnum, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { DiscountType, PaymentMethod, PaymentStatus } from '@got/shared';
import type { CivilDate } from '../../common/time/gym-time';
import { IsGymDate } from '../../common/validators/is-gym-date.validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

/**
 * `from` / `to` bound `businessDate`, which is a gym-local civil date, so they
 * are IsGymDate and never IsDateString — the latter accepts a full UTC instant,
 * which is precisely how the timezone bug class gets reintroduced.
 */
export class ListPaymentsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsGymDate()
  from?: CivilDate;

  @IsOptional()
  @IsGymDate()
  to?: CivilDate;

  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @IsOptional()
  @IsEnum(DiscountType)
  discountType?: DiscountType;

  @IsOptional()
  @IsUUID('4')
  shiftId?: string;

  @IsOptional()
  @IsUUID('4')
  userId?: string;

  @IsOptional()
  @IsString()
  @Length(2, 32)
  planCode?: string;
}
```

- [ ] **Step 5: Write the payment presenter**

Create `server/src/payments/payment.presenter.ts`:

```typescript
import type { Payment } from '@prisma/client';
import type { DiscountType, PaymentMethod, PaymentPurpose, PaymentStatus } from '@got/shared';
import { civilDateFromPrisma, type CivilDate } from '../common/time/gym-time';

/**
 * The wire shape of a payment.
 *
 * Every money field ends in `Centavos` and is an integer. NO formatted currency
 * string leaves this server, ever: the client composes the peso figure in one
 * place from the integer, so there is one formatting rule instead of one per
 * screen.
 *
 * `businessDate`, `termStartsOn` and `termEndsOn` are @db.Date, so they travel
 * as 'yyyy-mm-dd' civil dates. `receivedAt`, `voidedAt` and `createdAt` are
 * instants and travel as full ISO-8601 strings the client formats with an
 * explicit timeZone (§3.3 rule 3).
 */
export interface PaymentSummary {
  id: string;
  userId: string | null;
  membershipId: string | null;
  purpose: PaymentPurpose;
  status: PaymentStatus;
  planCode: string;
  planName: string;
  grossCentavos: number;
  vatBaseCentavos: number;
  discountType: DiscountType;
  discountCentavos: number;
  netCentavos: number;
  vatExempt: boolean;
  statutoryIdNo: string | null;
  discountReason: string | null;
  termMonths: number | null;
  termStartsOn: CivilDate | null;
  termEndsOn: CivilDate | null;
  method: PaymentMethod;
  reference: string | null;
  receiptNo: string | null;
  receiptIssued: boolean;
  receivedAt: string;
  businessDate: CivilDate;
  shiftId: string;
  recordedById: string;
  voidedAt: string | null;
  voidedById: string | null;
  voidReason: string | null;
  notes: string | null;
}

/**
 * Row → response projection.
 *
 * `idempotencyKey` and `idempotencyHash` are deliberately absent: they are
 * replay-protection mechanism, not information, and shipping the key would
 * invite a client to replay somebody else's.
 *
 * Prisma's enums are string-literal unions and @got/shared's are TS string
 * enums — the same strings, different nominal types — so the boundary takes one
 * cast per enum field. That cast is the whole reason enum-parity.spec.ts exists.
 */
export function toPaymentSummary(row: Payment): PaymentSummary {
  return {
    id: row.id,
    userId: row.userId,
    membershipId: row.membershipId,
    purpose: row.purpose as unknown as PaymentPurpose,
    status: row.status as unknown as PaymentStatus,
    planCode: row.planCode,
    planName: row.planName,
    grossCentavos: row.grossCentavos,
    vatBaseCentavos: row.vatBaseCentavos,
    discountType: row.discountType as unknown as DiscountType,
    discountCentavos: row.discountCentavos,
    netCentavos: row.netCentavos,
    vatExempt: row.vatExempt,
    statutoryIdNo: row.statutoryIdNo,
    discountReason: row.discountReason,
    termMonths: row.termMonths,
    termStartsOn: row.termStartsOn === null ? null : civilDateFromPrisma(row.termStartsOn),
    termEndsOn: row.termEndsOn === null ? null : civilDateFromPrisma(row.termEndsOn),
    method: row.method as unknown as PaymentMethod,
    reference: row.reference,
    receiptNo: row.receiptNo,
    receiptIssued: row.receiptIssued,
    receivedAt: row.receivedAt.toISOString(),
    businessDate: civilDateFromPrisma(row.businessDate),
    shiftId: row.shiftId,
    recordedById: row.recordedById,
    voidedAt: row.voidedAt === null ? null : row.voidedAt.toISOString(),
    voidedById: row.voidedById,
    voidReason: row.voidReason,
    notes: row.notes,
  };
}
```

- [ ] **Step 6: Write PaymentsService**

Create `server/src/payments/payments.service.ts`:

```typescript
import { ForbiddenException, HttpStatus, Injectable } from '@nestjs/common';
import {
  Prisma,
  type DiscountType as PrismaDiscountType,
  type Payment,
  type PaymentMethod as PrismaPaymentMethod,
  type PaymentPurpose as PrismaPaymentPurpose,
  PaymentStatus,
} from '@prisma/client';
import { DiscountType, PaymentMethod, PaymentPurpose, PlanKind } from '@got/shared';
import type { PaginatedData } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { PermissionsService } from '../rbac/permissions.service';
import type { PermissionUser } from '../rbac/rbac.types';
import type { ScopedWhere } from '../rbac/scope.util';
import { DomainException } from '../common/exceptions/domain.exception';
import { mapPrismaError } from '../common/exceptions/prisma-error.mapper';
import { assertConfirmed } from '../common/dto/confirm.dto';
import { hashRequestBody } from '../common/idempotency/request-hash';
import { paginated, paginationSkipTake } from '../common/dto/paginate';
import {
  civilDateFromPrisma,
  gymToday,
  toDateColumn,
  type CivilDate,
} from '../common/time/gym-time';
import type { AuthUser } from '../auth/auth.types';
import { PlansService } from '../catalogue/plans.service';
import { computeAmounts, type Amounts } from '../membership/membership-terms';
import { ShiftsService } from './shifts.service';
import { toPaymentSummary, type PaymentSummary } from './payment.presenter';
import type { RecordPaymentDto } from './dto/record-payment.dto';
import type { VoidPaymentDto } from './dto/void-payment.dto';
import type { ListPaymentsQueryDto } from './dto/list-payments-query.dto';

/** Everything the one Payment INSERT in this codebase needs. Prisma enums. */
export interface CreatePaymentInput {
  userId: string | null;
  membershipId: string | null;
  planId: string;
  planCode: string;
  planName: string;
  purpose: PrismaPaymentPurpose;
  amounts: Amounts;
  discountType: PrismaDiscountType;
  statutoryIdNo: string | null;
  discountReason: string | null;
  termMonths: number | null;
  termStartsOn: CivilDate | null;
  termEndsOn: CivilDate | null;
  method: PrismaPaymentMethod;
  reference: string | null;
  receiptNo: string | null;
  receivedAt: Date;
  businessDate: CivilDate;
  shiftId: string;
  recordedById: string;
  idempotencyKey: string;
  idempotencyHash: string;
  notes: string | null;
}

export type PaymentListResult = PaginatedData<PaymentSummary> & {
  totalCentavos: number;
  byMethod: { CASH: number; GCASH: number };
};

/** Which key a discount type demands, beyond the route's own payment.record. */
const DISCOUNT_PERMISSION: Readonly<Record<DiscountType, string | null>> = {
  [DiscountType.NONE]: null,
  [DiscountType.SENIOR]: 'payment.discount.statutory',
  [DiscountType.PWD]: 'payment.discount.statutory',
  [DiscountType.PROMO]: 'payment.discount.grant',
  [DiscountType.STAFF]: 'payment.discount.grant',
  [DiscountType.GUEST_PASS]: 'payment.discount.grant',
  [DiscountType.GOODWILL]: 'payment.discount.grant',
};

const COMP_TYPES: readonly DiscountType[] = [
  DiscountType.PROMO,
  DiscountType.STAFF,
  DiscountType.GUEST_PASS,
  DiscountType.GOODWILL,
];

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly permissions: PermissionsService,
    private readonly plans: PlansService,
    private readonly shifts: ShiftsService,
  ) {}

  /**
   * The second permission check on a money route, and deliberately NOT a second
   * decorator: `@RequirePermission` resolves with getAllAndOverride, so a
   * method-level key REPLACES a class-level one and a route can carry exactly
   * one. POST /payments carries payment.record; the discount keys are resolved
   * here, against the same PermissionsService the guard uses.
   *
   * SENIOR and PWD sit under payment.discount.statutory, which FRONT_DESK holds
   * at ALL: RA 9994 / RA 10754 make the discount mandatory and refusing it a
   * criminal offence, so it must not need a manager. The discretionary types
   * stay ADMIN-only under payment.discount.grant.
   */
  async assertDiscountAllowed(user: PermissionUser, discountType: DiscountType): Promise<void> {
    const required = DISCOUNT_PERMISSION[discountType];
    if (required === null) return;

    const held = await this.permissions.getEffectivePermissions(user);
    if (!held.some((permission) => permission.key === required)) {
      // Same shape PermissionsGuard throws, so the console branches once.
      throw new ForbiddenException(`Missing required permission: ${required}`);
    }
  }

  async record(
    actor: AuthUser,
    dto: RecordPaymentDto,
    idempotencyKey: string,
    now: Date,
  ): Promise<PaymentSummary> {
    if (dto.purpose !== PaymentPurpose.WALK_IN) {
      throw new DomainException(
        'PAYMENT_SHAPE_INVALID',
        'This endpoint records a walk-in. A membership term is sold through ' +
          'POST /memberships or /memberships/:id/renew, and a freeze fee through ' +
          'POST /memberships/:id/freeze — each writes its Payment inside the same ' +
          'transaction as the row it pays for.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const discountType = dto.discountType ?? DiscountType.NONE;
    await this.assertDiscountAllowed(actor, discountType);
    this.assertDiscountShape(discountType, dto.statutoryIdNo, dto.discountReason);

    const receivedAt = dto.receivedAt === undefined ? now : new Date(dto.receivedAt);
    // Derived, never sent: a client-chosen business day would let one sale be
    // attributed to a till report it was not in.
    const businessDate = gymToday(receivedAt, this.gym.timeZone);

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const plan = await this.plans.requireSellable(tx, dto.planCode);
        if ((plan.kind as unknown as PlanKind) !== PlanKind.WALK_IN) {
          throw new DomainException(
            'PAYMENT_SHAPE_INVALID',
            `${plan.code} is a term plan and is sold through POST /memberships.`,
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }

        if (dto.grossCentavos !== plan.priceCentavos) {
          throw new DomainException(
            'PAYMENT_AMOUNT_MISMATCH',
            `${plan.code} is ${plan.priceCentavos} centavos, not ${dto.grossCentavos}. ` +
              'Reload the price list before ringing this sale.',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }

        const amounts = computeAmounts({
          priceCentavos: plan.priceCentavos,
          discountType,
          vatRegistered: this.gym.vatRegistered,
          ...(dto.discountCentavos === undefined
            ? {}
            : { operatorDiscountCentavos: dto.discountCentavos }),
        });

        if (dto.netCentavos !== undefined && dto.netCentavos !== amounts.netCentavos) {
          throw new DomainException(
            'PAYMENT_AMOUNT_MISMATCH',
            `The collected amount should be ${amounts.netCentavos} centavos, ` +
              `not ${dto.netCentavos}.`,
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }
        if (amounts.netCentavos === 0 && !COMP_TYPES.includes(discountType)) {
          throw new DomainException(
            'PAYMENT_AMOUNT_MISMATCH',
            'A ₱0 collection is only legal as a comp — PROMO, STAFF, GUEST_PASS or GOODWILL.',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }

        if (dto.userId !== undefined) {
          const member = await tx.user.findFirst({
            where: { id: dto.userId, deletedAt: null },
            select: { id: true },
          });
          if (member === null) {
            throw new DomainException(
              'MEMBER_NOT_FOUND',
              'That member does not exist.',
              HttpStatus.NOT_FOUND,
            );
          }
        }

        const shiftId = await this.shifts.requireOpenShiftId(tx);

        return this.createInTx(tx, {
          userId: dto.userId ?? null,
          membershipId: null,
          planId: plan.id,
          planCode: plan.code,
          planName: plan.name,
          purpose: 'WALK_IN',
          amounts,
          discountType: discountType as unknown as PrismaDiscountType,
          statutoryIdNo: dto.statutoryIdNo ?? null,
          discountReason: dto.discountReason ?? null,
          termMonths: null,
          termStartsOn: null,
          termEndsOn: null,
          method: dto.method as unknown as PrismaPaymentMethod,
          reference: dto.reference ?? null,
          receiptNo: dto.receiptNo ?? null,
          receivedAt,
          businessDate,
          shiftId,
          recordedById: actor.id,
          idempotencyKey,
          idempotencyHash: hashRequestBody(dto),
          notes: dto.notes ?? null,
        });
      });

      return toPaymentSummary(row);
    } catch (error) {
      // Caught AFTER the whole $transaction call has rejected, so nothing
      // further touches `tx` and the §4.6(d) rule is not violated.
      const mapped = mapPrismaError(error);
      if (mapped) throw mapped;
      throw error;
    }
  }

  /**
   * The one INSERT into Payment. Membership sales (task 12) and the freeze fee
   * (task 14) reuse it so the GCash rule, the idempotency claim and the money
   * columns exist once.
   *
   * The claim is createMany({ skipDuplicates: true }) — INSERT … ON CONFLICT DO
   * NOTHING — and never a caught P2002, because inside $transaction Postgres
   * aborts on the first statement error and every later statement dies with
   * 25P02. On count === 0 the transaction is still alive and the stored row can
   * be read on the same tx.
   *
   * On the HTTP path @Idempotent() has usually already replayed the request, so
   * this branch mostly serves the INTERNAL callers, whose keys are derived from
   * the row that caused the payment (`freeze:<holdId>`) rather than a header.
   */
  async createInTx(tx: Prisma.TransactionClient, input: CreatePaymentInput): Promise<Payment> {
    if (input.method === 'GCASH' && (input.reference === null || input.reference.trim() === '')) {
      throw new DomainException(
        'GCASH_REFERENCE_REQUIRED',
        'A GCash payment needs the reference from the member’s screen — without it ' +
          'the row cannot be reconciled against the monthly statement.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const { count } = await tx.payment.createMany({
      data: [
        {
          userId: input.userId,
          membershipId: input.membershipId,
          planId: input.planId,
          purpose: input.purpose,
          planCode: input.planCode,
          planName: input.planName,
          grossCentavos: input.amounts.grossCentavos,
          vatBaseCentavos: input.amounts.vatBaseCentavos,
          discountType: input.discountType,
          discountCentavos: input.amounts.discountCentavos,
          netCentavos: input.amounts.netCentavos,
          vatExempt: input.amounts.vatExempt,
          statutoryIdNo: input.statutoryIdNo,
          discountReason: input.discountReason,
          termMonths: input.termMonths,
          termStartsOn: input.termStartsOn === null ? null : toDateColumn(input.termStartsOn),
          termEndsOn: input.termEndsOn === null ? null : toDateColumn(input.termEndsOn),
          method: input.method,
          reference: input.reference,
          receiptNo: input.receiptNo,
          receivedAt: input.receivedAt,
          businessDate: toDateColumn(input.businessDate),
          shiftId: input.shiftId,
          recordedById: input.recordedById,
          idempotencyKey: input.idempotencyKey,
          idempotencyHash: input.idempotencyHash,
          notes: input.notes,
        },
      ],
      skipDuplicates: true,
    });

    const stored = await tx.payment.findUniqueOrThrow({
      where: { idempotencyKey: input.idempotencyKey },
    });

    if (count === 0 && stored.idempotencyHash !== input.idempotencyHash) {
      // A stale 200 for a different body hands back the ₱90 receipt while the
      // desk believes ₱8,000 was recorded — worse than no idempotency at all,
      // because it is silent and looks like success.
      throw new DomainException(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different payment.',
        HttpStatus.CONFLICT,
      );
    }

    return stored;
  }

  async list(
    query: ListPaymentsQueryDto,
    scope: ScopedWhere<Prisma.PaymentWhereInput>,
  ): Promise<PaymentListResult> {
    const filters: Prisma.PaymentWhereInput = {
      ...(query.method ? { method: query.method as unknown as PrismaPaymentMethod } : {}),
      ...(query.status ? { status: query.status as unknown as PaymentStatus } : {}),
      ...(query.discountType
        ? { discountType: query.discountType as unknown as PrismaDiscountType }
        : {}),
      ...(query.shiftId ? { shiftId: query.shiftId } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.planCode ? { planCode: query.planCode } : {}),
      ...(query.from === undefined && query.to === undefined
        ? {}
        : {
            businessDate: {
              ...(query.from === undefined ? {} : { gte: toDateColumn(query.from) }),
              ...(query.to === undefined ? {} : { lte: toDateColumn(query.to) }),
            },
          }),
    };

    // AND, never spread. `scope` can carry a top-level OR (a COACH at OWN
    // reaches assigned members through the user relation) and spreading would
    // clobber it — which is what the ScopedWhere brand makes a compile error.
    const where: Prisma.PaymentWhereInput = { AND: [filters, scope] };
    const recorded: Prisma.PaymentWhereInput = {
      AND: [filters, scope, { status: PaymentStatus.RECORDED }],
    };

    const [rows, total, sum, byMethodRows] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        ...paginationSkipTake(query),
      }),
      this.prisma.payment.count({ where }),
      this.prisma.payment.aggregate({ where: recorded, _sum: { netCentavos: true } }),
      this.prisma.payment.groupBy({
        by: ['method'],
        where: recorded,
        _sum: { netCentavos: true },
        orderBy: { method: 'asc' },
      }),
    ]);

    // A void is not money. Totals cover RECORDED rows only; the voided rows
    // stay in `items` because the drawer still has to explain them.
    const byMethod = { CASH: 0, GCASH: 0 };
    for (const group of byMethodRows) {
      byMethod[group.method] = group._sum.netCentavos ?? 0;
    }

    return {
      ...paginated(rows.map(toPaymentSummary), total, query),
      totalCentavos: sum._sum.netCentavos ?? 0,
      byMethod,
    };
  }

  /**
   * The member's own history, for the keyless /me/payments route (task 11).
   *
   * The cast is the one place in this service a scope is asserted rather than
   * resolved, and it is safe for exactly one reason: the userId is hard-coded
   * from `request.user`, never from a parameter. That is also why CLIENT is
   * granted no payment.read at all — OWN never has to mean two different things
   * depending on who is asking.
   */
  async listForMember(userId: string, query: ListPaymentsQueryDto): Promise<PaymentListResult> {
    return this.list(query, { userId } as ScopedWhere<Prisma.PaymentWhereInput>);
  }

  async void(
    actor: AuthUser,
    id: string,
    dto: VoidPaymentDto,
    now: Date,
  ): Promise<PaymentSummary> {
    assertConfirmed(dto);

    const existing = await this.prisma.payment.findUnique({ where: { id } });
    if (existing === null) {
      throw new DomainException('PAYMENT_NOT_FOUND', 'Payment not found', HttpStatus.NOT_FOUND);
    }
    if (existing.status === PaymentStatus.VOIDED) {
      throw new DomainException(
        'PAYMENT_ALREADY_VOIDED',
        `This payment was already voided on ${civilDateFromPrisma(existing.businessDate)}.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Guarded UPDATE: two simultaneous voids, one winner, and the loser reads
    // count 0 rather than overwriting the first void's reason and actor.
    const claimed = await this.prisma.payment.updateMany({
      where: { id, status: PaymentStatus.RECORDED },
      data: {
        status: PaymentStatus.VOIDED,
        voidedAt: now,
        voidedById: actor.id,
        voidReason: dto.reason,
      },
    });
    if (claimed.count !== 1) {
      throw new DomainException(
        'PAYMENT_ALREADY_VOIDED',
        'This payment was voided by someone else a moment ago.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Voiding does NOT roll back the membership it bought — that is a separate,
    // deliberate cancel (§5.7.6).
    const row = await this.prisma.payment.findUniqueOrThrow({ where: { id } });
    return toPaymentSummary(row);
  }

  /** The service half of Payment_discount_shape, so the CHECK stays a backstop. */
  private assertDiscountShape(
    discountType: DiscountType,
    statutoryIdNo: string | undefined,
    discountReason: string | undefined,
  ): void {
    if (discountType === DiscountType.SENIOR || discountType === DiscountType.PWD) {
      if (statutoryIdNo === undefined || statutoryIdNo.trim() === '') {
        throw new DomainException(
          'STATUTORY_ID_REQUIRED',
          'Enter the OSCA or PWD ID number — BIR keeps that register separately.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      return;
    }

    if (COMP_TYPES.includes(discountType)) {
      if (discountReason === undefined || discountReason.trim().length < 3) {
        throw new DomainException(
          'DISCOUNT_ID_REQUIRED',
          'A discretionary discount needs a reason of at least 3 characters.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    }
  }
}
```

- [ ] **Step 7: Write PaymentsController**

Create `server/src/payments/payments.controller.ts`:

```typescript
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { Scope } from '../rbac/decorators/scope.decorator';
import type { ScopedWhere } from '../rbac/scope.util';
import { Idempotent, IDEMPOTENCY_HEADER } from '../common/decorators/idempotent.decorator';
import { PaymentsService, type PaymentListResult } from './payments.service';
import type { PaymentSummary } from './payment.presenter';
import { RecordPaymentDto } from './dto/record-payment.dto';
import { VoidPaymentDto } from './dto/void-payment.dto';
import { ListPaymentsQueryDto } from './dto/list-payments-query.dto';

type PaymentScope = ScopedWhere<Prisma.PaymentWhereInput>;

/**
 * Routes 33–35.
 *
 * One @RequirePermission key per route. POST /payments carries payment.record
 * only — the discount check is an in-service call against
 * PermissionsService.getEffectivePermissions, because a method-level decorator
 * REPLACES a class-level one and a second key on one route is unrepresentable.
 *
 * Subject 'ownedByUser' is right for Payment: it hangs off User via userId, and
 * notDeletedUserWhere is deliberately NOT applied — Payment has no deletedAt
 * column and buildScopeWhere folds that filter in for subject 'user' only.
 */
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @RequirePermission('payment.read')
  async list(
    @Query() query: ListPaymentsQueryDto,
    @Scope('ownedByUser') scope: PaymentScope,
  ): Promise<PaymentListResult> {
    return this.payments.list(query, scope);
  }

  /**
   * 201 on the first call, 200 on a replay — IdempotencyInterceptor observes the
   * finished body and emits it verbatim, so a replay carries exactly one
   * envelope. The header value is also stored on the Payment as
   * idempotencyKey @unique, which is what protects the INTERNAL callers whose
   * keys never come from a header at all.
   */
  @Post()
  @RequirePermission('payment.record')
  @Idempotent()
  async record(
    @CurrentUser() user: AuthUser,
    @Body() dto: RecordPaymentDto,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey: string,
  ): Promise<PaymentSummary> {
    return this.payments.record(user, dto, idempotencyKey, new Date());
  }

  /**
   * Deliberately NOT @Idempotent(): the RECORDED → VOIDED guarded update is
   * already idempotent in the only way that matters, and a second void is a
   * 422 the console must see rather than a replayed 200 that pretends it worked.
   */
  @Post(':id/void')
  @RequirePermission('payment.void')
  async voidPayment(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: VoidPaymentDto,
  ): Promise<PaymentSummary> {
    return this.payments.void(user, id, dto, new Date());
  }
}
```

- [ ] **Step 8: Wire the module**

```typescript
// server/src/payments/payments.module.ts — task 9 created this with the shifts
// half. Add the four lines marked ← below.
//
// RbacModule is NOT @Global (only PrismaModule and GymConfigModule are), so it
// must be imported explicitly for PaymentsService to inject PermissionsService
// — that is the assertDiscountAllowed dependency. CatalogueModule provides
// PlansService.
//
//   imports: [RbacModule, CatalogueModule],                      // ←
//   controllers: [ShiftsController, PaymentsController],         // ←
//   providers: [ShiftsService, PaymentsService],                 // ←
//   exports: [ShiftsService, PaymentsService],                   // ←
//
// PaymentsService is exported because MembershipModule's sales (task 12) and
// holds (task 14) services call createInTx inside their own transactions, and
// MeModule (task 11) calls listForMember.
```

- [ ] **Step 9: Run the e2e and watch it pass**

Run: `npm run test:e2e --workspace=server -- payments-shifts`
Expected: PASS — including the eighteen new payment cases: the ₱90 walk-in, the guest with no account, the 200 replay with one row, the 409 on a differing body, the missing-header 400, the statutory 1800/7200 computation, `STATUTORY_ID_REQUIRED`, the FRONT_DESK 403 / ADMIN ₱0 comp split, `DISCOUNT_ID_REQUIRED`, `GCASH_REFERENCE_REQUIRED`, `PAYMENT_AMOUNT_MISMATCH`, `PAYMENT_SHAPE_INVALID`, the CLIENT 403, `SHIFT_NOT_OPEN`, the void pair, the 404, the totals, the filters and the timestamp-as-civil-date 400.

- [ ] **Step 10: Run the whole suite and the type check**

Run: `npm test --workspace=server && npm run typecheck --workspace=server`
Expected: PASS, typecheck exits 0. `ts-jest` does not fail on type errors in this repo, so the typecheck is the only thing that proves `CreatePaymentInput`'s Prisma-enum fields and the presenter's shared-enum casts line up.

- [ ] **Step 11: Commit**

```bash
git add server/src/payments/payments.service.ts \
        server/src/payments/payments.controller.ts \
        server/src/payments/payment.presenter.ts \
        server/src/payments/dto/record-payment.dto.ts \
        server/src/payments/dto/void-payment.dto.ts \
        server/src/payments/dto/list-payments-query.dto.ts \
        server/src/payments/payments.module.ts \
        server/test/support/membership-fixtures.ts \
        server/test/payments-shifts.e2e-spec.ts
git commit -m "feat(payments): record, list, void and idempotent money writes (routes 33-35)

createInTx is the only INSERT into Payment in this codebase: it claims
idempotencyKey with createMany({ skipDuplicates: true }) and branches on
count === 0, never on a caught P2002, so the replay path does not die
with 25P02 at exactly the double-tap it exists to handle.

Statutory RA 9994 / RA 10754 discounts are computed by the server and
gated on payment.discount.statutory, which FRONT_DESK holds — refusing
one is a criminal offence, so it must not need a manager. The
discretionary types stay ADMIN-only under payment.discount.grant, and
neither key is a second route decorator: getAllAndOverride means a route
carries exactly one.

Two adjudications, deliberate: route 34 records a WALK_IN only, because a
term must never be paid for without a term being created; and §5.7.6's
front-desk self-void does not ship here, because payment.void is granted
to ADMIN alone and one route cannot carry two keys."
```

---

### Task 11: Membership read surface, verdictFor loader and the /me routes

**Files:**
- Create: `server/src/membership/membership-events.ts`
- Create: `server/src/membership/day-pass.resolver.ts`
- Create: `server/src/membership/membership.presenter.ts`
- Create: `server/src/membership/membership.service.ts`
- Create: `server/src/membership/memberships.controller.ts`
- Create: `server/src/membership/dto/list-memberships-query.dto.ts`
- Create: `server/src/membership/membership.module.ts`
- Create: `server/src/me/me.presenter.ts`
- Create: `server/src/me/me.controller.ts`
- Create: `server/src/me/me.module.ts`
- Modify: `server/src/app.module.ts:6-18` (import block) and `:59-67` (the feature-module list)
- Modify: `server/src/rbac/scope-contract.spec.ts:156` (append two describes at the end of the file)
- Modify: `server/test/support/membership-fixtures.ts` (created in task 10 — add `MemberState` and `makeMember`)
- Test: `server/test/memberships.e2e-spec.ts`

**Interfaces:**
- Consumes: `server/src/membership/access-verdict.ts`: `accessVerdict(subject, today, cfg)`, `AccessSubject`, `AccessResult`, `MembershipSnapshot`, `AccessVerdictConfig` (task 4) · `server/src/common/time/gym-time.ts`: `gymToday`, `toDateColumn`, `civilDateFromPrisma`, `addDays`, `CivilDate` (Chunk 0) · `GymConfigService.timeZone`, `.expiringSoonDays`, `.graceAdmissionsMax` (task 2) · `server/src/payments/payment.presenter.ts`: `toPaymentSummary`, `PaymentSummary` and `server/src/payments/payments.service.ts`: `PaymentsService.listForMember(userId, query)` (task 10) · `server/src/payments/dto/list-payments-query.dto.ts`: `ListPaymentsQueryDto` (task 10) · `server/src/rbac/permissions.service.ts`: `PermissionsService.getEffectivePermissions` · `server/src/rbac/scope.util.ts`: `ScopedWhere`, `@Scope('ownedByUser')` · `server/src/common/dto/paginate.ts`: `paginated`, `paginationSkipTake` · `@prisma/client`: `Membership`, `MembershipEvent`, `MembershipHold`, `HoldStatus`, `MembershipEventType` (task 6) · permission key `membership.read` — FRONT_DESK ALL, COACH OWN, ADMIN ALL, **CLIENT none** (task 2)
- Produces: `writeMembershipEvent(tx, input): Promise<MembershipEvent>` and `writeMembershipEventIfNew(tx, input): Promise<boolean>`, `MembershipEventInput` · `DAY_PASS_RESOLVER`, `interface DayPassResolver { validToday(userId, today): Promise<boolean> }`, `NoDayPassesResolver` · `MembershipListItem`, `MembershipDetail`, `HoldView`, `MembershipEventView`, `toMembershipListItem`, `toMembershipDetail`, `toMembershipSnapshot` · `MembershipService { loadSubject, verdictFor, list, findOne, loadForUpdate, detailById }` · `MemberOverview`, `MyMembership` · `ListMembershipsQueryDto`

**One adjudication:** task 14's file list says `server/test/memberships.e2e-spec.ts` was "created in task 12". It is created **here**, by task 11, and tasks 12–15 append their describes to it. The ordering section is explicit that the read surface lands before every mutating task, and the scope-leak matrix is this task's exit criterion — it cannot live in a file that does not exist yet.

---

- [ ] **Step 1: Add the member-state builder to the shared fixtures**

```typescript
// server/test/support/membership-fixtures.ts — APPEND to the file task 10
// created. Add to its import block:
//   import { randomUUID } from 'node:crypto';
//   import { addDays, toDateColumn, type CivilDate } from '../../src/common/time/gym-time';

/**
 * The six membership states every suite needs, named for what the DOOR does
 * rather than for the status column — which is the whole point of R1.
 *
 * STALE_ACTIVE is the one that earns its keep: the row still reads ACTIVE and
 * endsOn is ten days behind, which is exactly what a three-day scheduler outage
 * leaves behind. Every list projection and every verdict must deny it.
 */
export type MemberState =
  | 'ACTIVE'
  | 'IN_GRACE'
  | 'STALE_ACTIVE'
  | 'EXPIRED'
  | 'FROZEN'
  | 'CANCELLED'
  | 'NONE';

export interface MakeMemberOptions {
  /** Reuse an already-provisioned fixture user; one is minted when absent. */
  userId?: string;
  state: MemberState;
  planCode: string;
  today: CivilDate;
}

export interface MadeMember {
  userId: string;
  membershipId: string | null;
}

export async function makeMember(
  prisma: PrismaClient,
  options: MakeMemberOptions,
): Promise<MadeMember> {
  const userId =
    options.userId ??
    (
      await prisma.user.create({
        data: {
          supabaseId: randomUUID(),
          email: `${randomUUID()}@fixture.test`,
          firstName: 'Fixture',
          lastName: 'Member',
          memberCode: randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase(),
        },
        select: { id: true },
      })
    ).id;

  if (options.state === 'NONE') return { userId, membershipId: null };

  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: options.planCode } });
  const termMonths = plan.termMonths ?? 1;

  // endsOn is the INCLUSIVE last day of access, so each offset below is read as
  // "days from today to the last admitted day".
  const endsOffset: Record<Exclude<MemberState, 'NONE'>, number> = {
    ACTIVE: 20,
    IN_GRACE: -1,
    STALE_ACTIVE: -10,
    EXPIRED: -30,
    FROZEN: 40,
    CANCELLED: -5,
  };
  const status: Record<Exclude<MemberState, 'NONE'>, 'ACTIVE' | 'EXPIRED' | 'FROZEN' | 'CANCELLED'> =
    {
      ACTIVE: 'ACTIVE',
      IN_GRACE: 'EXPIRED',
      STALE_ACTIVE: 'ACTIVE',
      EXPIRED: 'EXPIRED',
      FROZEN: 'FROZEN',
      CANCELLED: 'CANCELLED',
    };

  const endsOn = addDays(options.today, endsOffset[options.state]);
  const startsOn = addDays(endsOn, -(termMonths * 30));

  const membership = await prisma.membership.create({
    data: {
      userId,
      planId: plan.id,
      status: status[options.state],
      planCode: plan.code,
      planName: plan.name,
      planPriceCentavos: plan.priceCentavos,
      termMonths,
      graceDays: plan.graceDays,
      guestPassesPerTerm: plan.guestPassesPerTerm,
      guestPassesRemaining: plan.guestPassesPerTerm,
      startsOn: toDateColumn(startsOn),
      endsOn: toDateColumn(endsOn),
      billingAnchorDay: Number(startsOn.slice(8, 10)),
      joinedOn: toDateColumn(startsOn),
      cancelledOn:
        options.state === 'CANCELLED' ? toDateColumn(addDays(endsOn, 1)) : null,
      purchasedAt: new Date(`${startsOn}T02:00:00.000Z`),
    },
    select: { id: true },
  });

  if (options.state === 'FROZEN') {
    await prisma.membershipHold.create({
      data: {
        membershipId: membership.id,
        status: 'ACTIVE',
        startsOn: toDateColumn(addDays(options.today, -2)),
        endsOn: toDateColumn(addDays(options.today, 12)),
        daysRequested: 15,
        daysApplied: 15,
        activeMembershipId: membership.id,
        reason: 'fixture freeze',
        approvedById: userId,
      },
    });
  }

  return { userId, membershipId: membership.id };
}
```

- [ ] **Step 2: Write the failing e2e for routes 10, 11, 12, 20 and 21**

Create `server/test/memberships.e2e-spec.ts`:

```typescript
import request from 'supertest';
import type { Server } from 'http';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import { gymToday, toDateColumn } from '../src/common/time/gym-time';
import { makeMember, openShift, seedPlansForTest } from './support/membership-fixtures';

jest.setTimeout(120_000);

describe('memberships (e2e)', () => {
  const TODAY = gymToday(new Date(), 'Asia/Manila');

  let ctx: TestApp;
  let server: Server;

  let adminToken: string;
  let deskToken: string;
  let coachAToken: string;
  let clientAToken: string;
  let clientBToken: string;

  let adminId: string;
  let coachAId: string;
  let clientAId: string;
  let clientBId: string;

  let membershipA: string;
  let membershipB: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await seedPlansForTest(ctx.prisma);

    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    deskToken = await ctx.fixture.tokenFor('FRONT_DESK', { supabaseId: FIXTURE_IDS.FRONT_DESK });
    coachAToken = await ctx.fixture.tokenFor('COACH', { supabaseId: FIXTURE_IDS.COACH_A });
    clientAToken = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
    clientBToken = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_B });

    adminId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
    coachAId = await ctx.fixture.userIdFor(FIXTURE_IDS.COACH_A);
    clientAId = await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_A);
    clientBId = await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_B);

    membershipA = (
      await makeMember(ctx.prisma, {
        userId: clientAId,
        state: 'ACTIVE',
        planCode: 'MONTHLY',
        today: TODAY,
      })
    ).membershipId!;

    membershipB = (
      await makeMember(ctx.prisma, {
        userId: clientBId,
        state: 'STALE_ACTIVE',
        planCode: 'MONTHLY',
        today: TODAY,
      })
    ).membershipId!;

    await ctx.prisma.coachAssignment.create({
      data: {
        coachId: coachAId,
        memberId: clientAId,
        activeMemberId: clientAId,
        assignedById: adminId,
      },
    });
  });

  describe('GET /memberships (route 20) — the scope-leak matrix', () => {
    it('FRONT_DESK at ALL sees both members', async () => {
      const response = await request(server)
        .get('/api/v1/memberships')
        .set('Authorization', `Bearer ${deskToken}`)
        .expect(200);

      expect(response.body.data.total).toBe(2);
      expect(response.body.data.items.map((item: { userId: string }) => item.userId).sort()).toEqual(
        [clientAId, clientBId].sort(),
      );
    });

    it('COACH_A at OWN sees only the member assigned to them', async () => {
      const response = await request(server)
        .get('/api/v1/memberships')
        .set('Authorization', `Bearer ${coachAToken}`)
        .expect(200);

      expect(response.body.data.total).toBe(1);
      expect(response.body.data.items[0].userId).toBe(clientAId);
    });

    it('a CLIENT is refused outright — their own data is served by /me/*', async () => {
      await request(server)
        .get('/api/v1/memberships')
        .set('Authorization', `Bearer ${clientAToken}`)
        .expect(403);
    });

    it('projects the door verdict, so the CRM and the desk cannot disagree', async () => {
      const response = await request(server)
        .get('/api/v1/memberships')
        .set('Authorization', `Bearer ${deskToken}`)
        .expect(200);

      const stale = response.body.data.items.find(
        (item: { userId: string }) => item.userId === clientBId,
      );
      // The row still says ACTIVE — the nightly job has not run. The door says
      // no anyway, because endsOn + graceDays says so. That is R1.
      expect(stale.status).toBe('ACTIVE');
      expect(stale.decision).toBe('DENY');
      expect(stale.denialReason).toBe('MEMBERSHIP_EXPIRED');
      expect(stale.daysRemaining).toBe(0);

      const live = response.body.data.items.find(
        (item: { userId: string }) => item.userId === clientAId,
      );
      expect(live.decision).toBe('ALLOW');
      expect(live.allowReason).toBe('MEMBERSHIP_ACTIVE');
    });

    it('filters by status, planCode and expiringWithinDays', async () => {
      const expiring = await request(server)
        .get('/api/v1/memberships?expiringWithinDays=30')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(expiring.body.data.items.map((i: { id: string }) => i.id)).toEqual([membershipA]);

      const byPlan = await request(server)
        .get('/api/v1/memberships?planCode=ANNUAL')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(byPlan.body.data.items).toEqual([]);
    });

    it('searches on the member name and code, not on the membership row', async () => {
      await ctx.prisma.user.update({
        where: { id: clientAId },
        data: { firstName: 'Marisol', memberCode: 'K7QX2M' },
      });

      const byName = await request(server)
        .get('/api/v1/memberships?search=mariso')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(byName.body.data.items.map((i: { id: string }) => i.id)).toEqual([membershipA]);

      const byCode = await request(server)
        .get('/api/v1/memberships?search=K7QX2M')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(byCode.body.data.items.map((i: { id: string }) => i.id)).toEqual([membershipA]);
    });

    it('AND-ing the scope does not widen it when a filter carries its own OR', async () => {
      // `search` builds an OR over the user relation and `scope` builds another
      // over assignment. Spread them together and the coach sees everyone.
      const response = await request(server)
        .get('/api/v1/memberships?search=Fixture')
        .set('Authorization', `Bearer ${coachAToken}`)
        .expect(200);

      expect(response.body.data.items.every((i: { userId: string }) => i.userId === clientAId)).toBe(
        true,
      );
    });
  });

  describe('GET /memberships/:id (route 21)', () => {
    it('404s a membership outside the caller’s scope — never 403', async () => {
      // A 403 would confirm the row exists and turn this into an enumeration
      // oracle for the whole member base.
      const response = await request(server)
        .get(`/api/v1/memberships/${membershipB}`)
        .set('Authorization', `Bearer ${coachAToken}`)
        .expect(404);

      expect(response.body.error.code).toBe('MEMBERSHIP_NOT_FOUND');
    });

    it('404s an id that does not exist, with the same code and status', async () => {
      const response = await request(server)
        .get('/api/v1/memberships/0b000000-0000-4000-8000-00000000ff01')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);

      expect(response.body.error.code).toBe('MEMBERSHIP_NOT_FOUND');
    });

    it('gates `payments` on resolved payment.read, not on the caller’s role', async () => {
      await openShift(ctx.prisma, adminId, TODAY);
      await ctx.prisma.payment.create({
        data: {
          userId: clientAId,
          membershipId: membershipA,
          planId: (await ctx.prisma.plan.findUniqueOrThrow({ where: { code: 'MONTHLY' } })).id,
          purpose: 'MEMBERSHIP',
          planCode: 'MONTHLY',
          planName: 'Monthly',
          grossCentavos: 80000,
          vatBaseCentavos: 80000,
          netCentavos: 80000,
          termMonths: 1,
          termStartsOn: toDateColumn(TODAY),
          termEndsOn: toDateColumn(TODAY),
          method: 'CASH',
          receivedAt: new Date(),
          businessDate: toDateColumn(TODAY),
          shiftId: (await ctx.prisma.shift.findFirstOrThrow()).id,
          recordedById: adminId,
          idempotencyKey: 'fixture-membership-a-payment',
          idempotencyHash: 'f'.repeat(64),
        },
      });

      const desk = await request(server)
        .get(`/api/v1/memberships/${membershipA}`)
        .set('Authorization', `Bearer ${deskToken}`)
        .expect(200);
      expect(desk.body.data.payments).toHaveLength(1);
      expect(desk.body.data.payments[0].netCentavos).toBe(80000);

      // COACH holds membership.read at OWN and no payment.read at all.
      const coach = await request(server)
        .get(`/api/v1/memberships/${membershipA}`)
        .set('Authorization', `Bearer ${coachAToken}`)
        .expect(200);
      expect(coach.body.data.payments).toBeUndefined();
    });

    it('carries the verdict, the running hold and the event timeline', async () => {
      const frozen = await makeMember(ctx.prisma, {
        state: 'FROZEN',
        planCode: 'QUARTERLY',
        today: TODAY,
      });

      const response = await request(server)
        .get(`/api/v1/memberships/${frozen.membershipId!}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.data.status).toBe('FROZEN');
      expect(response.body.data.verdict.decision).toBe('DENY');
      expect(response.body.data.verdict.denialReason).toBe('MEMBERSHIP_FROZEN');
      expect(response.body.data.verdict.offer).toBe('OVERRIDE');
      expect(response.body.data.hold.daysRequested).toBe(15);
      expect(response.body.data.hold.status).toBe('ACTIVE');
      expect(response.body.data.events).toEqual([]);
      expect(JSON.stringify(response.body)).not.toMatch(/₱|PHP/);
    });
  });

  describe('/me routes (10, 11, 12)', () => {
    it('GET /me/membership never 404s: no membership is a renderable state', async () => {
      const none = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_DELETED });
      await ctx.prisma.user.update({
        where: { supabaseId: FIXTURE_IDS.CLIENT_DELETED },
        data: { deletedAt: null },
      });

      const response = await request(server)
        .get('/api/v1/me/membership')
        .set('Authorization', `Bearer ${none}`)
        .expect(200);

      expect(response.body.data.membership).toBeNull();
      expect(response.body.data.verdict.decision).toBe('DENY');
      expect(response.body.data.verdict.denialReason).toBe('NO_MEMBERSHIP');
      expect(response.body.data.verdict.offer).toBe('RENEW');
    });

    it('GET /me/membership returns the caller’s own membership and verdict', async () => {
      const response = await request(server)
        .get('/api/v1/me/membership')
        .set('Authorization', `Bearer ${clientAToken}`)
        .expect(200);

      expect(response.body.data.membership.id).toBe(membershipA);
      expect(response.body.data.membership.planCode).toBe('MONTHLY');
      expect(response.body.data.membership.planPriceCentavos).toBe(80000);
      expect(response.body.data.verdict.decision).toBe('ALLOW');
      // The member's own screen shows no staff attribution.
      expect(response.body.data.membership.events).toEqual([]);
      expect(response.body.data.membership.payments).toBeUndefined();
    });

    it('GET /me/membership needs no permission key and cannot reach anyone else', async () => {
      const response = await request(server)
        .get('/api/v1/me/membership')
        .set('Authorization', `Bearer ${clientBToken}`)
        .expect(200);

      expect(response.body.data.membership.id).toBe(membershipB);
      expect(response.body.data.verdict.decision).toBe('DENY');
    });

    it('GET /me/overview carries the member code, the verdict and the last payment', async () => {
      const response = await request(server)
        .get('/api/v1/me/overview')
        .set('Authorization', `Bearer ${clientAToken}`)
        .expect(200);

      expect(response.body.data.userId).toBe(clientAId);
      expect(response.body.data.firstName).toBe('CLIENT');
      expect(response.body.data.verdict.message).toContain('Monthly');
      expect(response.body.data.lastPayment).toBeNull();
      expect(response.body.data.guestPassesRemaining).toBe(0);
    });

    it('GET /me/payments returns only the caller’s own rows', async () => {
      await openShift(ctx.prisma, adminId, TODAY);
      const shiftId = (await ctx.prisma.shift.findFirstOrThrow()).id;
      const planId = (await ctx.prisma.plan.findUniqueOrThrow({ where: { code: 'WALKIN' } })).id;

      for (const [userId, key] of [
        [clientAId, 'fixture-me-a'],
        [clientBId, 'fixture-me-b'],
      ] as const) {
        await ctx.prisma.payment.create({
          data: {
            userId,
            planId,
            purpose: 'WALK_IN',
            planCode: 'WALKIN',
            planName: 'Walk-in',
            grossCentavos: 9000,
            vatBaseCentavos: 9000,
            netCentavos: 9000,
            method: 'CASH',
            receivedAt: new Date(),
            businessDate: toDateColumn(TODAY),
            shiftId,
            recordedById: adminId,
            idempotencyKey: key,
            idempotencyHash: 'a'.repeat(64),
          },
        });
      }

      const response = await request(server)
        .get('/api/v1/me/payments')
        .set('Authorization', `Bearer ${clientAToken}`)
        .expect(200);

      expect(response.body.data.items).toHaveLength(1);
      expect(response.body.data.items[0].userId).toBe(clientAId);
      expect(response.body.data.items[0].netCentavos).toBe(9000);
      expect(response.body.data.totalCentavos).toBe(9000);
    });
  });
});
```

- [ ] **Step 3: Run the e2e and watch it fail**

Run: `npm run test:e2e --workspace=server -- memberships`
Expected: FAIL — `expected 200 "OK", got 404 "Not Found"` on `GET /api/v1/memberships` (neither `MembershipsController` nor `MeController` exists yet).

- [ ] **Step 4: Write the append-only event writer**

Create `server/src/membership/membership-events.ts`:

```typescript
import {
  Prisma,
  type MembershipEvent,
  type MembershipEventType,
  type MembershipStatus,
} from '@prisma/client';
import { toDateColumn, type CivilDate } from '../common/time/gym-time';

/**
 * The single write path into the append-only transition ledger.
 *
 * Every mutating service logs the same shape through this function, so "why did
 * this membership's endsOn move" is answerable from one table rather than by
 * replaying six services' worth of ad-hoc creates. The table is append-only by
 * a BEFORE UPDATE OR DELETE trigger (§5.8.4), not by convention — this function
 * is the convenience, the trigger is the guarantee.
 *
 * There is deliberately no update and no delete helper here. If one is ever
 * wanted, the trigger will refuse it with restrict_violation, that constraint
 * is deliberately UNMAPPED in CONSTRAINT_ERROR_CODES, and the result is a
 * logged 500 — which is the correct, loud signal for a genuine bug.
 */
export interface MembershipEventInput {
  membershipId: string;
  type: MembershipEventType;
  /** NULL only on the very first event, when there was no prior status. */
  fromStatus: MembershipStatus | null;
  toStatus: MembershipStatus;
  /** Both NULL when the event did not move the term; populated together. */
  previousEndsOn: CivilDate | null;
  newEndsOn: CivilDate | null;
  /** Mandatory for ADJUSTED, STATUS_CORRECTED and CANCELLED (the CHECK). */
  reason: string | null;
  /** NULL means the system did it — the nightly job. A human is always named. */
  actorId: string | null;
  paymentId: string | null;
  batchRef: string | null;
  /**
   * When the change takes effect in the BUSINESS timeline, which a catch-up run
   * sets to the day the transition should have happened rather than the day it
   * was detected. Usually equal to createdAt; never assumed to be.
   */
  effectiveAt: Date;
}

function toData(input: MembershipEventInput): Prisma.MembershipEventCreateManyInput {
  return {
    membershipId: input.membershipId,
    type: input.type,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    previousEndsOn: input.previousEndsOn === null ? null : toDateColumn(input.previousEndsOn),
    newEndsOn: input.newEndsOn === null ? null : toDateColumn(input.newEndsOn),
    reason: input.reason,
    actorId: input.actorId,
    paymentId: input.paymentId,
    batchRef: input.batchRef,
    effectiveAt: input.effectiveAt,
  };
}

/** One row, unconditionally. The ordinary path for every single-row transition. */
export async function writeMembershipEvent(
  tx: Prisma.TransactionClient,
  input: MembershipEventInput,
): Promise<MembershipEvent> {
  return tx.membershipEvent.create({ data: toData(input) });
}

/**
 * The bulk-operation path: one row per (membershipId, batchRef), and a re-run of
 * the same closure credit writes nothing.
 *
 * createMany + skipDuplicates, never a caught P2002: inside $transaction
 * Postgres aborts on the first statement error and every later statement dies
 * with 25P02, so the "already applied" branch of a naive implementation is dead
 * code that 500s at exactly the re-run it was written to handle.
 *
 * Note that @@unique([membershipId, batchRef]) constrains nothing when batchRef
 * is NULL — Postgres unique indexes ignore NULL — which is why ordinary events
 * never collide and why this function refuses a null batchRef outright rather
 * than silently degrading into writeMembershipEvent.
 */
export async function writeMembershipEventIfNew(
  tx: Prisma.TransactionClient,
  input: MembershipEventInput,
): Promise<boolean> {
  if (input.batchRef === null) {
    throw new Error('writeMembershipEventIfNew requires a batchRef — use writeMembershipEvent');
  }

  const { count } = await tx.membershipEvent.createMany({
    data: [toData(input)],
    skipDuplicates: true,
  });
  return count === 1;
}
```

- [ ] **Step 5: Write the day-pass seam**

Create `server/src/membership/day-pass.resolver.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import type { CivilDate } from '../common/time/gym-time';

/**
 * The seam accessVerdict's `dayPassValidToday` boolean is filled from.
 *
 * It exists NOW, returns false NOW, and is swapped in Chunk 2 for a read of
 * today's WALK_IN CheckIn. That is what stops anyone "restoring" the DayPass
 * table the name implies: there is no DayPass model, a walk-in is a CheckIn plus
 * a Payment, and the verdict takes a boolean precisely so this chunk carries no
 * dependency on the attendance schema.
 */
export const DAY_PASS_RESOLVER = Symbol('DAY_PASS_RESOLVER');

export interface DayPassResolver {
  validToday(userId: string, today: CivilDate): Promise<boolean>;
}

/** Chunk 1's implementation. Replaced, not extended, in Chunk 2. */
@Injectable()
export class NoDayPassesResolver implements DayPassResolver {
  async validToday(): Promise<boolean> {
    return false;
  }
}
```

- [ ] **Step 6: Write the membership presenter**

Create `server/src/membership/membership.presenter.ts`:

```typescript
import type { Membership, MembershipEvent, MembershipHold, User } from '@prisma/client';
import type { AccessDecision, AllowReason, DenialReason, MembershipStatus } from '@got/shared';
import { civilDateFromPrisma, type CivilDate } from '../common/time/gym-time';
import type { PaymentSummary } from '../payments/payment.presenter';
import {
  accessVerdict,
  type AccessResult,
  type AccessVerdictConfig,
  type MembershipSnapshot,
} from './access-verdict';

type MemberFields = Pick<User, 'firstName' | 'lastName' | 'memberCode' | 'status'>;

export interface HoldView {
  id: string;
  status: string;
  startsOn: CivilDate;
  endsOn: CivilDate;
  daysRequested: number;
  daysApplied: number;
  reason: string;
  feeWaived: boolean;
  releasedAt: string | null;
}

export interface MembershipEventView {
  id: string;
  type: string;
  fromStatus: MembershipStatus | null;
  toStatus: MembershipStatus;
  previousEndsOn: CivilDate | null;
  newEndsOn: CivilDate | null;
  reason: string | null;
  actorId: string | null;
  paymentId: string | null;
  effectiveAt: string;
}

/**
 * The CRM row.
 *
 * `decision` / `allowReason` / `denialReason` are §5.9.3's mitigation for the
 * one thing that genuinely degrades when the nightly job misses a run: a member
 * reading ACTIVE in the CRM while the door correctly denies them. Every list
 * projects the stored status THROUGH accessVerdict, so the CRM and the desk can
 * never disagree in front of a member.
 */
export interface MembershipListItem {
  id: string;
  userId: string;
  memberCode: string | null;
  firstName: string;
  lastName: string;
  planCode: string;
  planName: string;
  status: MembershipStatus;
  startsOn: CivilDate;
  endsOn: CivilDate;
  graceDays: number;
  cancelRequestedOn: CivilDate | null;
  daysRemaining: number | null;
  decision: AccessDecision;
  allowReason: AllowReason | null;
  denialReason: DenialReason | null;
}

export interface MembershipDetail {
  id: string;
  userId: string;
  memberCode: string | null;
  firstName: string;
  lastName: string;
  planId: string;
  planCode: string;
  planName: string;
  planPriceCentavos: number;
  termMonths: number;
  status: MembershipStatus;
  startsOn: CivilDate;
  endsOn: CivilDate;
  graceDays: number;
  billingAnchorDay: number;
  joinedOn: CivilDate;
  cancelRequestedOn: CivilDate | null;
  cancelledOn: CivilDate | null;
  graceAdmissionsThisTerm: number;
  freezesUsedThisTerm: number;
  guestPassesPerTerm: number;
  guestPassesRemaining: number;
  purchasedAt: string;
  verdict: AccessResult;
  hold: HoldView | null;
  events: MembershipEventView[];
  /** Present only when the caller resolved payment.read. */
  payments?: PaymentSummary[];
}

/**
 * Row (+ its running hold) → the snapshot the pure ladder consumes.
 *
 * planName and planPriceCentavos come off the MEMBERSHIP, never off Plan: the
 * snapshot columns are what freeze the commercial terms of the current term, so
 * an admin editing the price list cannot rewrite what anyone agreed to.
 */
export function toMembershipSnapshot(
  row: Membership,
  hold: MembershipHold | null,
): MembershipSnapshot {
  return {
    status: row.status as unknown as MembershipStatus,
    startsOn: civilDateFromPrisma(row.startsOn),
    endsOn: civilDateFromPrisma(row.endsOn),
    graceDays: row.graceDays,
    graceAdmissionsThisTerm: row.graceAdmissionsThisTerm,
    cancelRequestedOn:
      row.cancelRequestedOn === null ? null : civilDateFromPrisma(row.cancelRequestedOn),
    planName: row.planName,
    planPriceCentavos: row.planPriceCentavos,
    hold:
      hold === null
        ? null
        : { startsOn: civilDateFromPrisma(hold.startsOn), endsOn: civilDateFromPrisma(hold.endsOn) },
  };
}

export function toHoldView(hold: MembershipHold): HoldView {
  return {
    id: hold.id,
    status: hold.status,
    startsOn: civilDateFromPrisma(hold.startsOn),
    endsOn: civilDateFromPrisma(hold.endsOn),
    daysRequested: hold.daysRequested,
    daysApplied: hold.daysApplied,
    reason: hold.reason,
    feeWaived: hold.feeWaived,
    releasedAt: hold.releasedAt === null ? null : hold.releasedAt.toISOString(),
  };
}

export function toMembershipEventView(event: MembershipEvent): MembershipEventView {
  return {
    id: event.id,
    type: event.type,
    fromStatus: event.fromStatus as unknown as MembershipStatus | null,
    toStatus: event.toStatus as unknown as MembershipStatus,
    previousEndsOn:
      event.previousEndsOn === null ? null : civilDateFromPrisma(event.previousEndsOn),
    newEndsOn: event.newEndsOn === null ? null : civilDateFromPrisma(event.newEndsOn),
    reason: event.reason,
    actorId: event.actorId,
    paymentId: event.paymentId,
    effectiveAt: event.effectiveAt.toISOString(),
  };
}

export function toMembershipListItem(
  row: Membership & { user: MemberFields; holds: MembershipHold[] },
  today: CivilDate,
  cfg: AccessVerdictConfig,
): MembershipListItem {
  // dayPassValidToday is false here on purpose: a CRM row answers "what state
  // is this membership in", not "did this person buy a ₱90 pass this morning".
  // The live door verdict (verdictFor) is the only caller that resolves it.
  const verdict = accessVerdict(
    {
      userStatus: row.user.status,
      membership: toMembershipSnapshot(row, row.holds[0] ?? null),
      dayPassValidToday: false,
    },
    today,
    cfg,
  );

  return {
    id: row.id,
    userId: row.userId,
    memberCode: row.user.memberCode,
    firstName: row.user.firstName,
    lastName: row.user.lastName,
    planCode: row.planCode,
    planName: row.planName,
    status: row.status as unknown as MembershipStatus,
    startsOn: civilDateFromPrisma(row.startsOn),
    endsOn: civilDateFromPrisma(row.endsOn),
    graceDays: row.graceDays,
    cancelRequestedOn:
      row.cancelRequestedOn === null ? null : civilDateFromPrisma(row.cancelRequestedOn),
    daysRemaining: verdict.daysRemaining,
    decision: verdict.decision,
    allowReason: verdict.allowReason,
    denialReason: verdict.denialReason,
  };
}

export function toMembershipDetail(
  row: Membership & { user: MemberFields; holds: MembershipHold[]; events: MembershipEvent[] },
  today: CivilDate,
  cfg: AccessVerdictConfig,
  options: { payments: PaymentSummary[] | null; includeEvents: boolean },
): MembershipDetail {
  const hold = row.holds[0] ?? null;
  const verdict = accessVerdict(
    {
      userStatus: row.user.status,
      membership: toMembershipSnapshot(row, hold),
      dayPassValidToday: false,
    },
    today,
    cfg,
  );

  return {
    id: row.id,
    userId: row.userId,
    memberCode: row.user.memberCode,
    firstName: row.user.firstName,
    lastName: row.user.lastName,
    planId: row.planId,
    planCode: row.planCode,
    planName: row.planName,
    planPriceCentavos: row.planPriceCentavos,
    termMonths: row.termMonths,
    status: row.status as unknown as MembershipStatus,
    startsOn: civilDateFromPrisma(row.startsOn),
    endsOn: civilDateFromPrisma(row.endsOn),
    graceDays: row.graceDays,
    billingAnchorDay: row.billingAnchorDay,
    joinedOn: civilDateFromPrisma(row.joinedOn),
    cancelRequestedOn:
      row.cancelRequestedOn === null ? null : civilDateFromPrisma(row.cancelRequestedOn),
    cancelledOn: row.cancelledOn === null ? null : civilDateFromPrisma(row.cancelledOn),
    graceAdmissionsThisTerm: row.graceAdmissionsThisTerm,
    freezesUsedThisTerm: row.freezesUsedThisTerm,
    guestPassesPerTerm: row.guestPassesPerTerm,
    guestPassesRemaining: row.guestPassesRemaining,
    purchasedAt: row.purchasedAt.toISOString(),
    verdict,
    hold: hold === null ? null : toHoldView(hold),
    // The member's own screen gets no staff attribution: every event carries an
    // actorId, and /me has no business knowing which staff member touched the row.
    events: options.includeEvents ? row.events.map(toMembershipEventView) : [],
    ...(options.payments === null ? {} : { payments: options.payments }),
  };
}
```

- [ ] **Step 7: Write the list query DTO**

Create `server/src/membership/dto/list-memberships-query.dto.ts`:

```typescript
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { MembershipStatus } from '@got/shared';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListMembershipsQueryDto extends PaginationQueryDto {
  /** The STORED status. The projected verdict is on every row regardless. */
  @IsOptional()
  @IsEnum(MembershipStatus)
  status?: MembershipStatus;

  /** The renewal call list: endsOn between today and today + n, inclusive. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(90)
  expiringWithinDays?: number;

  @IsOptional()
  @IsString()
  @Length(2, 32)
  planCode?: string;

  /** Matched against the MEMBER — name, member code, email — not the row. */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  search?: string;
}
```

- [ ] **Step 8: Write MembershipService**

Create `server/src/membership/membership.service.ts`:

```typescript
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma, type Membership, type MembershipStatus as PrismaStatus } from '@prisma/client';
import type { PaginatedData } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { DomainException } from '../common/exceptions/domain.exception';
import { paginated, paginationSkipTake } from '../common/dto/paginate';
import { addDays, gymToday, toDateColumn, type CivilDate } from '../common/time/gym-time';
import type { ScopedWhere } from '../rbac/scope.util';
import { toPaymentSummary, type PaymentSummary } from '../payments/payment.presenter';
import {
  accessVerdict,
  type AccessResult,
  type AccessSubject,
  type AccessVerdictConfig,
} from './access-verdict';
import { DAY_PASS_RESOLVER, type DayPassResolver } from './day-pass.resolver';
import {
  toMembershipDetail,
  toMembershipListItem,
  toMembershipSnapshot,
  type MembershipDetail,
  type MembershipListItem,
} from './membership.presenter';
import type { ListMembershipsQueryDto } from './dto/list-memberships-query.dto';

/** The relations every read projection needs, in one place. */
const READ_INCLUDE = {
  user: { select: { firstName: true, lastName: true, memberCode: true, status: true } },
  // The nullable-unique sentinel: at most one row can carry it, so `take: 1`
  // is a statement of fact rather than a truncation.
  holds: { where: { activeMembershipId: { not: null } }, take: 1 },
} as const;

const DETAIL_INCLUDE = {
  ...READ_INCLUDE,
  events: { orderBy: { effectiveAt: 'desc' }, take: 50 },
} as const;

/**
 * The loader half of §5.4.1's split.
 *
 * accessVerdict decides; this service loads, reads the config and owns the
 * transaction — the same split as PermissionsService / PermissionsGuard. Nothing
 * in access-verdict.ts, membership-terms.ts, membership-transitions.ts or
 * membership-freeze-rules.ts may reach a clock, Prisma or GymConfigService; all
 * three arrive here.
 */
@Injectable()
export class MembershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    @Inject(DAY_PASS_RESOLVER) private readonly dayPasses: DayPassResolver,
  ) {}

  private get verdictConfig(): AccessVerdictConfig {
    return {
      expiringSoonDays: this.gym.expiringSoonDays,
      graceAdmissionsMax: this.gym.graceAdmissionsMax,
    };
  }

  /** Everything the ladder needs about one person, on one gym-local day. */
  async loadSubject(userId: string, today: CivilDate): Promise<AccessSubject> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (user === null) {
      throw new DomainException('MEMBER_NOT_FOUND', 'Member not found', HttpStatus.NOT_FOUND);
    }

    const membership = await this.prisma.membership.findUnique({
      where: { userId },
      include: { holds: { where: { activeMembershipId: { not: null } }, take: 1 } },
    });

    return {
      userStatus: user.status,
      membership:
        membership === null ? null : toMembershipSnapshot(membership, membership.holds[0] ?? null),
      dayPassValidToday: await this.dayPasses.validToday(userId, today),
    };
  }

  /**
   * "May this person train today." The live door read, which Chunk 2 calls and
   * then re-evaluates INSIDE its write transaction — verdict-then-write across
   * two round trips is a TOCTOU window a concurrent cancel or freeze walks
   * straight through.
   */
  async verdictFor(userId: string, now: Date): Promise<AccessResult> {
    const today = gymToday(now, this.gym.timeZone);
    return accessVerdict(await this.loadSubject(userId, today), today, this.verdictConfig);
  }

  async list(
    query: ListMembershipsQueryDto,
    scope: ScopedWhere<Prisma.MembershipWhereInput>,
    now: Date,
  ): Promise<PaginatedData<MembershipListItem>> {
    const today = gymToday(now, this.gym.timeZone);

    const filters: Prisma.MembershipWhereInput = {
      ...(query.status ? { status: query.status as unknown as PrismaStatus } : {}),
      ...(query.planCode ? { planCode: query.planCode } : {}),
      ...(query.expiringWithinDays === undefined
        ? {}
        : {
            endsOn: {
              gte: toDateColumn(today),
              lte: toDateColumn(addDays(today, query.expiringWithinDays)),
            },
          }),
      ...(query.search
        ? {
            user: {
              OR: [
                { firstName: { contains: query.search, mode: 'insensitive' as const } },
                { lastName: { contains: query.search, mode: 'insensitive' as const } },
                { memberCode: { contains: query.search, mode: 'insensitive' as const } },
                { email: { contains: query.search, mode: 'insensitive' as const } },
              ],
            },
          }
        : {}),
    };

    // AND, never spread. Both `filters` (search) and `scope` (a COACH at OWN)
    // can carry a top-level OR through the same `user` relation; spreading would
    // let the second silently replace the first and widen the coach's reach to
    // the whole member base. The ScopedWhere brand makes that a compile error.
    const where: Prisma.MembershipWhereInput = { AND: [filters, scope] };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.membership.findMany({
        where,
        include: READ_INCLUDE,
        orderBy: [{ endsOn: 'asc' }, { id: 'asc' }],
        ...paginationSkipTake(query),
      }),
      this.prisma.membership.count({ where }),
    ]);

    const cfg = this.verdictConfig;
    return paginated(
      rows.map((row) => toMembershipListItem(row, today, cfg)),
      total,
      query,
    );
  }

  /**
   * 404 on a scoped miss, never 403 — a 403 confirms the row exists and turns
   * this endpoint into an enumeration oracle for the whole member base.
   */
  async findOne(
    id: string,
    scope: ScopedWhere<Prisma.MembershipWhereInput>,
    now: Date,
    options: { includePayments: boolean },
  ): Promise<MembershipDetail> {
    const today = gymToday(now, this.gym.timeZone);

    const row = await this.prisma.membership.findFirst({
      where: { AND: [{ id }, scope] },
      include: DETAIL_INCLUDE,
    });
    if (row === null) {
      throw new DomainException(
        'MEMBERSHIP_NOT_FOUND',
        'Membership not found',
        HttpStatus.NOT_FOUND,
      );
    }

    const payments = options.includePayments ? await this.paymentsFor(this.prisma, row.id) : null;
    return toMembershipDetail(row, today, this.verdictConfig, {
      payments,
      includeEvents: true,
    });
  }

  /**
   * The read every mutating service takes before it writes.
   *
   * SELECT … FOR UPDATE, deliberately: two staff members renewing and freezing
   * the same membership in the same second would otherwise both read the same
   * endsOn and one increment would vanish. Prisma's fluent API cannot express a
   * row lock, so the lock is one raw statement and the row itself comes back
   * through the typed client.
   */
  async loadForUpdate(tx: Prisma.TransactionClient, membershipId: string): Promise<Membership> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Membership" WHERE "id" = ${membershipId}::uuid FOR UPDATE
    `;
    if (locked.length === 0) {
      throw new DomainException(
        'MEMBERSHIP_NOT_FOUND',
        'Membership not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return tx.membership.findUniqueOrThrow({ where: { id: membershipId } });
  }

  /**
   * The projection every mutating route returns, read on the SAME tx that just
   * wrote — so the response can never show a state the transaction rolled back.
   */
  async detailById(
    tx: Prisma.TransactionClient,
    membershipId: string,
    now: Date,
  ): Promise<MembershipDetail> {
    const today = gymToday(now, this.gym.timeZone);
    const row = await tx.membership.findUnique({
      where: { id: membershipId },
      include: DETAIL_INCLUDE,
    });
    if (row === null) {
      throw new DomainException(
        'MEMBERSHIP_NOT_FOUND',
        'Membership not found',
        HttpStatus.NOT_FOUND,
      );
    }

    return toMembershipDetail(row, today, this.verdictConfig, {
      payments: await this.paymentsFor(tx, membershipId),
      includeEvents: true,
    });
  }

  /** The membership's own money. `toPaymentSummary` is pure, so no DI hop. */
  private async paymentsFor(
    client: Prisma.TransactionClient,
    membershipId: string,
  ): Promise<PaymentSummary[]> {
    const rows = await client.payment.findMany({
      where: { membershipId },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: 24,
    });
    return rows.map(toPaymentSummary);
  }
}
```

- [ ] **Step 9: Write the memberships controller and the membership module**

Create `server/src/membership/memberships.controller.ts`:

```typescript
import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PaginatedData } from '@got/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { Scope } from '../rbac/decorators/scope.decorator';
import { PermissionsService } from '../rbac/permissions.service';
import type { ScopedWhere } from '../rbac/scope.util';
import { MembershipService } from './membership.service';
import type { MembershipDetail, MembershipListItem } from './membership.presenter';
import { ListMembershipsQueryDto } from './dto/list-memberships-query.dto';

type MembershipScope = ScopedWhere<Prisma.MembershipWhereInput>;

/**
 * Routes 20 and 21. Tasks 12–15 append their writes to this controller.
 *
 * Subject 'ownedByUser' is right for Membership: it hangs off User via userId,
 * and notDeletedUserWhere is deliberately NOT applied — Membership has no
 * deletedAt column, and buildScopeWhere folds that filter in for subject 'user'
 * only. A member is soft-deleted on User, and their membership follows because
 * the scope reaches it through that relation.
 */
@Controller('memberships')
export class MembershipsController {
  constructor(
    private readonly memberships: MembershipService,
    private readonly permissions: PermissionsService,
  ) {}

  @Get()
  @RequirePermission('membership.read')
  async list(
    @Query() query: ListMembershipsQueryDto,
    @Scope('ownedByUser') scope: MembershipScope,
  ): Promise<PaginatedData<MembershipListItem>> {
    return this.memberships.list(query, scope, new Date());
  }

  /**
   * `payments` is gated on the caller's RESOLVED payment.read, not on
   * user.role: a role test would hard-code today's grant table into a handler
   * and silently stop agreeing with it the first time a grant is edited. A
   * COACH holds membership.read at OWN and no payment.read at all, so they see
   * the member they coach without their billing history.
   */
  @Get(':id')
  @RequirePermission('membership.read')
  async findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Scope('ownedByUser') scope: MembershipScope,
  ): Promise<MembershipDetail> {
    const held = await this.permissions.getEffectivePermissions(user);
    const includePayments = held.some((permission) => permission.key === 'payment.read');
    return this.memberships.findOne(id, scope, new Date(), { includePayments });
  }
}
```

Create `server/src/membership/membership.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { PaymentsModule } from '../payments/payments.module';
import { MembershipService } from './membership.service';
import { MembershipsController } from './memberships.controller';
import { DAY_PASS_RESOLVER, NoDayPassesResolver } from './day-pass.resolver';

/**
 * RbacModule is imported for PermissionsService (the payments-field gate) —
 * it is not @Global, unlike PrismaModule and GymConfigModule.
 *
 * CatalogueModule and PaymentsModule are imported here rather than in each of
 * tasks 12–15: the sales service needs PlansService and PaymentsService.createInTx,
 * and the holds service needs ShiftsService, so wiring them once now keeps four
 * later tasks from each editing this file's imports.
 *
 * DAY_PASS_RESOLVER is bound to the always-false implementation. Chunk 2 swaps
 * the useClass and changes nothing else.
 */
@Module({
  imports: [RbacModule, CatalogueModule, PaymentsModule],
  controllers: [MembershipsController],
  providers: [MembershipService, { provide: DAY_PASS_RESOLVER, useClass: NoDayPassesResolver }],
  exports: [MembershipService],
})
export class MembershipModule {}
```

- [ ] **Step 10: Write the /me surface**

Create `server/src/me/me.presenter.ts`:

```typescript
import type { UserStatus } from '@prisma/client';
import type { AccessResult } from '../membership/access-verdict';
import type { MembershipDetail } from '../membership/membership.presenter';
import type { PaymentSummary } from '../payments/payment.presenter';

/**
 * The member's own screens.
 *
 * /me/membership NEVER 404s: "no plan on file" is a valid, renderable state with
 * its own verdict message and its own call to action, and a 404 would make the
 * portal's subscription screen throw where it should render a sign-up prompt.
 */
export interface MyMembership {
  membership: MembershipDetail | null;
  verdict: AccessResult;
}

export interface MemberOverview {
  userId: string;
  memberCode: string | null;
  firstName: string;
  lastName: string;
  status: UserStatus;
  membership: MembershipDetail | null;
  verdict: AccessResult;
  guestPassesRemaining: number;
  lastPayment: PaymentSummary | null;
}
```

Create `server/src/me/me.controller.ts`:

```typescript
import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { gymToday } from '../common/time/gym-time';
import { MembershipService } from '../membership/membership.service';
import { toMembershipDetail } from '../membership/membership.presenter';
import { accessVerdict } from '../membership/access-verdict';
import { PaymentsService, type PaymentListResult } from '../payments/payments.service';
import { ListPaymentsQueryDto } from '../payments/dto/list-payments-query.dto';
import type { MemberOverview, MyMembership } from './me.presenter';

/**
 * Routes 10, 11 and 12 — keyless, hard-coded to the caller's own userId,
 * exactly like the existing GET /me.
 *
 * There is deliberately NO @RequirePermission and NO @Scope here. CLIENT is
 * granted none of the membership.* or payment.* keys, so `OWN` never has to
 * mean two different things depending on whether the caller is a member or a
 * coach. AuthGuard is global, so these routes are still authenticated.
 *
 * Nest resolves this alongside UsersController's @Controller('me') — that one
 * owns @Get() and these own their sub-paths, so there is no collision.
 */
@Controller('me')
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly memberships: MembershipService,
    private readonly payments: PaymentsService,
  ) {}

  @Get('overview')
  async overview(@CurrentUser() user: AuthUser): Promise<MemberOverview> {
    const now = new Date();
    const mine = await this.myMembership(user, now);

    const lastPayment = await this.payments.listForMember(user.id, {
      page: 1,
      limit: 1,
    } as ListPaymentsQueryDto);

    return {
      userId: user.id,
      memberCode: mine.membership?.memberCode ?? null,
      firstName: user.firstName,
      lastName: user.lastName,
      status: user.status,
      membership: mine.membership,
      verdict: mine.verdict,
      guestPassesRemaining: mine.membership?.guestPassesRemaining ?? 0,
      lastPayment: lastPayment.items[0] ?? null,
    };
  }

  @Get('membership')
  async membership(@CurrentUser() user: AuthUser): Promise<MyMembership> {
    return this.myMembership(user, new Date());
  }

  @Get('payments')
  async paymentHistory(
    @CurrentUser() user: AuthUser,
    @Query() query: ListPaymentsQueryDto,
  ): Promise<PaymentListResult> {
    return this.payments.listForMember(user.id, query);
  }

  private async myMembership(user: AuthUser, now: Date): Promise<MyMembership> {
    const today = gymToday(now, this.gym.timeZone);
    const subject = await this.memberships.loadSubject(user.id, today);
    const cfg = {
      expiringSoonDays: this.gym.expiringSoonDays,
      graceAdmissionsMax: this.gym.graceAdmissionsMax,
    };
    const verdict = accessVerdict(subject, today, cfg);

    if (subject.membership === null) return { membership: null, verdict };

    const row = await this.prisma.membership.findUniqueOrThrow({
      where: { userId: user.id },
      include: {
        user: { select: { firstName: true, lastName: true, memberCode: true, status: true } },
        holds: { where: { activeMembershipId: { not: null } }, take: 1 },
        events: { orderBy: { effectiveAt: 'desc' }, take: 0 },
      },
    });

    // payments: null and includeEvents: false — the member has /me/payments for
    // their own money, and every event carries an actorId naming a staff member,
    // which is not the member's business.
    return {
      membership: toMembershipDetail(row, today, cfg, { payments: null, includeEvents: false }),
      verdict,
    };
  }
}
```

Create `server/src/me/me.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { MembershipModule } from '../membership/membership.module';
import { PaymentsModule } from '../payments/payments.module';
import { MeController } from './me.controller';

/**
 * The member's own surface, wired over MembershipService and PaymentsService
 * without granting the caller a single permission key. That is the whole design:
 * the identity is hard-coded from request.user, so there is no scope to resolve
 * and no key to get wrong.
 */
@Module({
  imports: [MembershipModule, PaymentsModule],
  controllers: [MeController],
})
export class MeModule {}
```

- [ ] **Step 11: Register the modules in AppModule**

```typescript
// server/src/app.module.ts — add to the import block (lines 6-18), keeping the
// existing order of feature imports:
import { CatalogueModule } from './catalogue/catalogue.module';
import { MembershipModule } from './membership/membership.module';
import { PaymentsModule } from './payments/payments.module';
import { MeModule } from './me/me.module';

// …and to the feature-module list (lines 59-67), after CoachAssignmentsModule
// and before SchedulerModule — SchedulerModule imports MembershipModule for the
// nightly job in task 16, so it stays last:
//
//     AuthModule,
//     UsersModule,
//     RbacModule,
//     CoachAssignmentsModule,
//     CatalogueModule,        // ← task 8 may already have added this
//     PaymentsModule,         // ← task 9 may already have added this
//     MembershipModule,       // ←
//     MeModule,               // ←
//     SchedulerModule,
```

- [ ] **Step 12: Add the scope proofs the type check enforces**

```typescript
// server/src/rbac/scope-contract.spec.ts — APPEND at the end of the file
// (currently line 156). Add to its import block:
//   import type { MembershipListItem } from '../membership/membership.presenter';

/**
 * The chunk-1 half of the contract.
 *
 * ts-jest does NOT fail on type errors in this repo, so `npm test` proves
 * nothing here: `npm run typecheck --workspace=server` is the ONLY thing that
 * makes these @ts-expect-error directives mean anything. Whoever wires CI must
 * run the typecheck, not just the tests.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- only the signature is under test
function listMemberships(_where: ScopedWhere<Prisma.MembershipWhereInput>): MembershipListItem[] {
  return [];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- only the signature is under test
function listPayments(_where: ScopedWhere<Prisma.PaymentWhereInput>): void {
  // Body intentionally empty.
}

describe('Membership and Payment reads are scoped by the same contract', () => {
  it('rejects a bare MembershipWhereInput and every spread of a scope', () => {
    const scope = {} as ScopedWhere<Prisma.MembershipWhereInput>;

    listMemberships(scope);

    // @ts-expect-error — a bare WhereInput is not a ScopedWhere
    listMemberships({ status: 'ACTIVE' });

    // @ts-expect-error — spreading a scoped fragment loses the brand
    listMemberships({ ...scope });

    // @ts-expect-error — and merging a filter into it loses the brand too,
    // which is exactly the `{ ...filters, ...scope }` shape that would clobber
    // a coach's top-level OR and widen the read to the whole member base.
    listMemberships({ ...scope, planCode: 'MONTHLY' });

    expect(typeof listMemberships).toBe('function');
  });

  it('rejects a bare PaymentWhereInput and every spread of a scope', () => {
    const scope = {} as ScopedWhere<Prisma.PaymentWhereInput>;

    listPayments(scope);

    // @ts-expect-error — a bare WhereInput is not a ScopedWhere
    listPayments({ method: 'CASH' });

    // @ts-expect-error — spreading a scoped fragment loses the brand
    listPayments({ ...scope });

    // @ts-expect-error — merging filters into the scope loses it too
    listPayments({ ...scope, status: 'RECORDED' });

    expect(typeof listPayments).toBe('function');
  });
});
```

- [ ] **Step 13: Run the e2e and watch it pass**

Run: `npm run test:e2e --workspace=server -- memberships`
Expected: PASS — the scope-leak matrix (FRONT_DESK sees both, COACH_A sees only its assigned member, COACH_B's member by id is 404 `MEMBERSHIP_NOT_FOUND` and not 403, a CLIENT is 403 on `/memberships`), the stale-status projection, the filters, the search-plus-scope AND-ing, the `payments` gate on resolved `payment.read`, and all five `/me` cases.

- [ ] **Step 14: Run the whole suite and the type check**

Run: `npm test --workspace=server && npm run typecheck --workspace=server && npm run test:e2e --workspace=server`
Expected: PASS, typecheck exits 0. If the typecheck reports TS2578 ("Unused '@ts-expect-error' directive") on any line added in step 12, the `ScopedWhere` brand has been weakened and the fix belongs in `scope.util.ts`, not in deleting the directive.

- [ ] **Step 15: Commit**

```bash
git add server/src/membership/membership-events.ts \
        server/src/membership/day-pass.resolver.ts \
        server/src/membership/membership.presenter.ts \
        server/src/membership/membership.service.ts \
        server/src/membership/memberships.controller.ts \
        server/src/membership/membership.module.ts \
        server/src/membership/dto/list-memberships-query.dto.ts \
        server/src/me/me.presenter.ts \
        server/src/me/me.controller.ts \
        server/src/me/me.module.ts \
        server/src/app.module.ts \
        server/src/rbac/scope-contract.spec.ts \
        server/test/support/membership-fixtures.ts \
        server/test/memberships.e2e-spec.ts
git commit -m "feat(membership): read surface, verdictFor loader and the keyless /me routes

Where accessVerdict meets real rows. MembershipService loads, reads the
config and owns the transaction; the pure ladder decides — the same split
as PermissionsService / PermissionsGuard.

Every list projects the stored status THROUGH accessVerdict, which is
§5.9.3's mitigation for the one thing that genuinely degrades when the
nightly job misses a run: a member reading ACTIVE in the CRM while the
door correctly denies them. The e2e pins it with a row that still says
ACTIVE ten days past its endsOn and is denied anyway.

The /me routes carry no permission key and hard-code the caller's own
userId, which is why CLIENT is granted no membership.read at OWN: OWN
never has to mean two different things depending on who is asking. And
/me/membership never 404s — no plan on file is a renderable state with
its own verdict and its own call to action.

loadForUpdate takes a real SELECT … FOR UPDATE. Tasks 12-16 all mutate
endsOn, and two staff renewing and freezing the same row in the same
second would otherwise lose one increment silently."
```

---

### Task 12: Sell and renew

**Files:**
- Create: `server/src/membership/dto/create-membership.dto.ts`
- Create: `server/src/membership/dto/renew-membership.dto.ts`
- Create: `server/src/membership/membership-sales.service.ts`
- Create: `server/test/support/membership-fixtures.ts`
- Create: `server/test/memberships.e2e-spec.ts`
- Modify: `server/src/membership/memberships.controller.ts` (created in task 11 — add `MembershipSalesService` to the constructor and append routes 22 and 23 after the `findOne` pair; tasks 13 and 14 append after this)
- Modify: `server/src/membership/membership.module.ts` (created in task 11 — add `MembershipSalesService` to `providers`, and `CatalogueModule` + `PaymentsModule` to `imports`)
- Test: `server/test/memberships.e2e-spec.ts`

**Interfaces:**
- Consumes: `server/src/membership/membership-terms.ts` (task 3): `planTerm(current: CurrentTerm | null, today: CivilDate, termMonths: number): PlannedTerm`, `termEndsOn(anchorDay: number, startsOn: CivilDate, termMonths: number): CivilDate`, `computeAmounts(input: AmountsInput): Amounts`, `interface CurrentTerm { status; endsOn; graceDays; billingAnchorDay }`, `interface PlannedTerm { kind: TermKind; startsOn; endsOn; billingAnchorDay }` · `server/src/membership/membership-transitions.ts` (task 5): `assertTransition(from: MembershipStatus | null, to: MembershipStatus): void` · `server/src/common/time/gym-time.ts` (Chunk 0 + task 3): `gymToday`, `asCivilDate`, `civilDateFromPrisma`, `toDateColumn`, `addDays`, `anniversary`, `type CivilDate` · `server/src/users/member-code.util.ts` (Chunk 0): `allocateMemberCode(tx: Prisma.TransactionClient, maxAttempts?: number): Promise<string>` — **it returns a code and writes nothing**; the caller does the `user.update`. `generateMemberCode(): string` · `server/src/common/idempotency/request-hash.ts` (Chunk 0): `hashRequestBody(body: unknown): string` · `server/src/common/decorators/idempotent.decorator.ts` (Chunk 0): `Idempotent()`, `IDEMPOTENCY_HEADER` · `server/src/membership/membership-events.ts` (task 11): `writeMembershipEvent(tx, event: MembershipEventInput): Promise<MembershipEvent>` · `server/src/membership/membership.service.ts` (task 11): `loadForUpdate(tx, membershipId): Promise<Membership>` throwing 404 `MEMBERSHIP_NOT_FOUND`, `detailById(tx, membershipId, now): Promise<MembershipDetail>` · `server/src/membership/membership.presenter.ts` (task 11): `type MembershipDetail` · `server/src/catalogue/plans.service.ts` (task 8): `PlansService.requireSellable(tx, planCode): Promise<Plan>` throwing 404 `PLAN_NOT_FOUND` / 422 `PLAN_ARCHIVED` · `server/src/payments/payments.service.ts` (task 10): `PaymentsService.createInTx(tx, input: CreatePaymentInput): Promise<Payment>` and `PaymentsService.assertDiscountAllowed(actor: AuthUser, discountType: DiscountType): Promise<void>` · `server/src/payments/shifts.service.ts` (task 9): `ShiftsService.requireOpenShiftId(tx): Promise<string>` throwing 422 `SHIFT_NOT_OPEN` · `GymConfigService.timeZone`, `.vatRegistered`, `.graceAdmissionsMax` (task 2) · permission key `membership.sell` (FRONT_DESK + ADMIN, task 2)
- Produces: `CreateMembershipDto` (no `startsOn` — the server decides), `RenewMembershipDto` · `MembershipSalesService { sell(actor, dto, idempotencyKey, now): Promise<MembershipDetail>; renew(actor, membershipId, dto, idempotencyKey, now): Promise<MembershipDetail> }` · `server/test/support/membership-fixtures.ts` exports `type SeededPlanCode = 'WALKIN' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL'`, `type SeededPlanIds = Record<SeededPlanCode, string>`, `type TermPlanCode = Exclude<SeededPlanCode, 'WALKIN'>`, `type MemberState = 'ACTIVE' | 'IN_GRACE' | 'EXPIRED_PAST_GRACE' | 'FROZEN' | 'CANCELLED' | 'NO_MEMBERSHIP'`, `interface MemberFixture { userId: string; membershipId: string | null; memberCode: string | null; email: string }`, `seedPlansForTest(prisma): Promise<SeededPlanIds>`, `makeMember(prisma, options): Promise<MemberFixture>`, `openShift(prisma, openedById, businessDate, openingFloatCentavos?): Promise<string>` — tasks 14, 15, 16 and 17 all import from this file

---

- [ ] **Step 1: Write the shared e2e fixtures every later suite imports**

Create `server/test/support/membership-fixtures.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import {
  HoldStatus,
  MembershipStatus,
  PlanKind,
  Role,
  ShiftStatus,
  UserStatus,
  type PrismaClient,
} from '@prisma/client';
import { generateMemberCode } from '../../src/users/member-code.util';
import {
  addDays,
  anniversary,
  toDateColumn,
  type CivilDate,
} from '../../src/common/time/gym-time';
import { termEndsOn } from '../../src/membership/membership-terms';

/**
 * The membership states every e2e suite in chunk 1 needs, built by direct
 * Prisma writes rather than through the API.
 *
 * Direct writes on purpose: a fixture that sells a membership through
 * POST /memberships would make every freeze, cancel and nightly-job test fail
 * whenever the sale path breaks, and the failure would point at the wrong file.
 *
 * `resetDatabase()` truncates Plan along with everything else, so
 * `seedPlansForTest()` runs in each `beforeEach`, not once in `beforeAll`.
 */

export type SeededPlanCode = 'WALKIN' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
export type TermPlanCode = Exclude<SeededPlanCode, 'WALKIN'>;
export type SeededPlanIds = Record<SeededPlanCode, string>;

/** §5.3.2's table, verbatim. Prices are centavos of PHP. */
const PLAN_ROWS = [
  {
    code: 'WALKIN',
    name: 'Walk-in',
    kind: PlanKind.WALK_IN,
    priceCentavos: 9000,
    termMonths: null,
    freezable: false,
    guestPassesPerTerm: 0,
    graceDays: 0,
    sortOrder: 0,
  },
  {
    code: 'MONTHLY',
    name: 'Monthly',
    kind: PlanKind.TERM,
    priceCentavos: 80000,
    termMonths: 1,
    freezable: false,
    guestPassesPerTerm: 0,
    graceDays: 3,
    sortOrder: 1,
  },
  {
    code: 'QUARTERLY',
    name: 'Quarterly',
    kind: PlanKind.TERM,
    priceCentavos: 220000,
    termMonths: 3,
    freezable: true,
    guestPassesPerTerm: 0,
    graceDays: 3,
    sortOrder: 2,
  },
  {
    code: 'ANNUAL',
    name: 'Annual',
    kind: PlanKind.TERM,
    priceCentavos: 750000,
    termMonths: 12,
    freezable: true,
    guestPassesPerTerm: 2,
    graceDays: 3,
    sortOrder: 3,
  },
];

export async function seedPlansForTest(prisma: PrismaClient): Promise<SeededPlanIds> {
  await prisma.plan.createMany({ data: PLAN_ROWS, skipDuplicates: true });
  const rows = await prisma.plan.findMany({ select: { id: true, code: true } });

  const ids = {} as SeededPlanIds;
  for (const row of rows) {
    ids[row.code as SeededPlanCode] = row.id;
  }
  return ids;
}

/**
 * One open drawer. `openMarker` is the nullable-unique sentinel, and
 * Shift_open_marker makes omitting it a constraint violation rather than a
 * second open shift, so it is set here explicitly.
 */
export async function openShift(
  prisma: PrismaClient,
  openedById: string,
  businessDate: CivilDate,
  openingFloatCentavos = 200000,
): Promise<string> {
  const shift = await prisma.shift.create({
    data: {
      status: ShiftStatus.OPEN,
      openedById,
      openedAt: new Date(),
      openingFloatCentavos,
      businessDate: toDateColumn(businessDate),
      openMarker: 'OPEN',
    },
    select: { id: true },
  });
  return shift.id;
}

export type MemberState =
  | 'ACTIVE'
  | 'IN_GRACE'
  | 'EXPIRED_PAST_GRACE'
  | 'FROZEN'
  | 'CANCELLED'
  | 'NO_MEMBERSHIP';

export interface MakeMemberOptions {
  state: MemberState;
  today: CivilDate;
  /** Defaults to MONTHLY. WALKIN is not a term plan and is deliberately not accepted. */
  planCode?: TermPlanCode;
  firstName?: string;
  lastName?: string;
}

export interface MemberFixture {
  userId: string;
  /** Null only for state 'NO_MEMBERSHIP'. */
  membershipId: string | null;
  memberCode: string | null;
  email: string;
}

/** The fixture freeze's window, in days. Inside MembershipHold_days_bounded's 7..90. */
const FIXTURE_HOLD_DAYS = 14;

/** endsOn relative to `today`, for the three lapsed states. */
const LAPSED_END_OFFSET: Record<'IN_GRACE' | 'EXPIRED_PAST_GRACE' | 'CANCELLED', number> = {
  IN_GRACE: -1,
  EXPIRED_PAST_GRACE: -10,
  CANCELLED: -5,
};

const APPROVER_EMAIL = 'fixture.freeze.approver@got.test';

/** MembershipHold.approvedById is NOT NULL, so a frozen fixture needs a staff row. */
async function freezeApproverId(prisma: PrismaClient): Promise<string> {
  const existing = await prisma.user.findUnique({
    where: { email: APPROVER_EMAIL },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await prisma.user.create({
    data: {
      supabaseId: randomUUID(),
      email: APPROVER_EMAIL,
      firstName: 'Fixture',
      lastName: 'Approver',
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
    },
    select: { id: true },
  });
  return created.id;
}

export async function makeMember(
  prisma: PrismaClient,
  options: MakeMemberOptions,
): Promise<MemberFixture> {
  const email = `member.${randomUUID()}@fixture.test`;
  // A member with no membership has no memberCode either: allocation is lazy,
  // inside the first membership transaction, and route 22's e2e asserts it.
  const memberCode = options.state === 'NO_MEMBERSHIP' ? null : generateMemberCode();

  const user = await prisma.user.create({
    data: {
      supabaseId: randomUUID(),
      email,
      firstName: options.firstName ?? 'Fixture',
      lastName: options.lastName ?? 'Member',
      role: Role.CLIENT,
      status: UserStatus.ACTIVE,
      memberCode,
    },
    select: { id: true },
  });

  if (options.state === 'NO_MEMBERSHIP') {
    return { userId: user.id, membershipId: null, memberCode: null, email };
  }

  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: options.planCode ?? 'MONTHLY' } });
  const termMonths = plan.termMonths ?? 1;
  const { today } = options;

  let startsOn: CivilDate;
  let anchor: number;
  let endsOn: CivilDate;

  if (options.state === 'ACTIVE' || options.state === 'FROZEN') {
    startsOn = today;
    anchor = Number(today.slice(8, 10));
    endsOn = termEndsOn(anchor, startsOn, termMonths);
  } else {
    // Walk the term BACKWARDS from the day the next one would have begun, so
    // termEndsOn(anchor, startsOn, termMonths) reproduces this endsOn exactly
    // and the nightly job's reconcile step reports no mismatch.
    endsOn = addDays(today, LAPSED_END_OFFSET[options.state]);
    const renewalDay = addDays(endsOn, 1);
    anchor = Number(renewalDay.slice(8, 10));
    startsOn = anniversary(anchor, renewalDay, -termMonths);
  }

  const frozen = options.state === 'FROZEN';
  const cancelled = options.state === 'CANCELLED';
  // §5.6.2: the extension is applied when the hold STARTS, so a frozen fixture's
  // endsOn already carries the whole window.
  const membershipEndsOn = frozen ? addDays(endsOn, FIXTURE_HOLD_DAYS) : endsOn;

  const status =
    options.state === 'ACTIVE'
      ? MembershipStatus.ACTIVE
      : frozen
        ? MembershipStatus.FROZEN
        : cancelled
          ? MembershipStatus.CANCELLED
          : MembershipStatus.EXPIRED;

  const membership = await prisma.membership.create({
    data: {
      userId: user.id,
      planId: plan.id,
      status,
      planCode: plan.code,
      planName: plan.name,
      planPriceCentavos: plan.priceCentavos,
      termMonths,
      graceDays: plan.graceDays,
      guestPassesPerTerm: plan.guestPassesPerTerm,
      startsOn: toDateColumn(startsOn),
      endsOn: toDateColumn(membershipEndsOn),
      billingAnchorDay: anchor,
      joinedOn: toDateColumn(startsOn),
      // Membership_cancel_shape: CANCELLED and cancelledOn are biconditional.
      cancelledOn: cancelled ? toDateColumn(endsOn) : null,
      graceAdmissionsThisTerm: 0,
      freezesUsedThisTerm: frozen ? 1 : 0,
      guestPassesRemaining: plan.guestPassesPerTerm,
      purchasedAt: new Date(),
    },
    select: { id: true },
  });

  if (frozen) {
    await prisma.membershipHold.create({
      data: {
        membershipId: membership.id,
        status: HoldStatus.ACTIVE,
        startsOn: toDateColumn(today),
        endsOn: toDateColumn(addDays(today, FIXTURE_HOLD_DAYS - 1)),
        daysRequested: FIXTURE_HOLD_DAYS,
        daysApplied: FIXTURE_HOLD_DAYS,
        // The nullable-unique sentinel: set while ACTIVE, null otherwise.
        activeMembershipId: membership.id,
        reason: 'fixture freeze',
        feeWaived: true,
        approvedById: await freezeApproverId(prisma),
      },
    });
  }

  return { userId: user.id, membershipId: membership.id, memberCode, email };
}
```

- [ ] **Step 2: Write the failing e2e for routes 22 and 23**

Create `server/test/memberships.e2e-spec.ts`. Tasks 13, 14 and 15 each append a `describe` to this file, so the header below is the shared one they rely on:

```typescript
import request from 'supertest';
import type { Server } from 'http';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import {
  makeMember,
  openShift,
  seedPlansForTest,
  type SeededPlanIds,
} from './support/membership-fixtures';
import {
  addDays,
  civilDateFromPrisma,
  gymToday,
  toDateColumn,
} from '../src/common/time/gym-time';
import { termEndsOn } from '../src/membership/membership-terms';

jest.setTimeout(120_000);

/**
 * The real gym-local day, because these routes call `new Date()` server-side and
 * §5.6 refuses a backdated freeze. One gym, one zone: Asia/Manila is written out
 * rather than read from the environment so a mis-set .env.test cannot silently
 * make "today" mean two different days in one assertion.
 *
 * A run that straddles 00:00 Manila can flake. Accepted: the alternative is
 * injecting a clock into every route.
 */
const TODAY = gymToday(new Date(), 'Asia/Manila');
const ANCHOR = Number(TODAY.slice(8, 10));

let ctx: TestApp;
let server: Server;
let plans: SeededPlanIds;
let adminToken: string;
let adminId: string;
let shiftId: string;

beforeAll(async () => {
  ctx = await createTestApp();
  server = ctx.app.getHttpServer() as Server;
});

afterAll(async () => {
  await ctx.close();
});

describe('sell and renew (routes 22, 23)', () => {
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    plans = await seedPlansForTest(ctx.prisma);
    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    adminId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
    shiftId = await openShift(ctx.prisma, adminId, TODAY);
  });

  it('sells a first term, allocating the memberCode lazily inside the transaction', async () => {
    const member = await makeMember(ctx.prisma, { state: 'NO_MEMBERSHIP', today: TODAY });

    const response = await request(server)
      .post('/api/v1/memberships')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-000000000001')
      .send({ userId: member.userId, planCode: 'MONTHLY', method: 'CASH' })
      .expect(201);

    expect(response.body.data.status).toBe('ACTIVE');

    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: member.userId },
      include: { membership: true },
    });
    expect(user.memberCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);

    const membership = user.membership!;
    expect(civilDateFromPrisma(membership.startsOn)).toBe(TODAY);
    expect(civilDateFromPrisma(membership.endsOn)).toBe(termEndsOn(ANCHOR, TODAY, 1));
    expect(civilDateFromPrisma(membership.joinedOn)).toBe(TODAY);
    expect(membership.billingAnchorDay).toBe(ANCHOR);
    expect(membership.planPriceCentavos).toBe(80000);
    expect(membership.graceDays).toBe(3);
    expect(membership.graceAdmissionsThisTerm).toBe(0);
    expect(membership.freezesUsedThisTerm).toBe(0);

    const payment = await ctx.prisma.payment.findFirstOrThrow({
      where: { membershipId: membership.id },
    });
    expect(payment.purpose).toBe('MEMBERSHIP');
    expect(payment.grossCentavos).toBe(80000);
    expect(payment.netCentavos).toBe(80000);
    expect(payment.termMonths).toBe(1);
    expect(civilDateFromPrisma(payment.termStartsOn!)).toBe(TODAY);
    expect(civilDateFromPrisma(payment.termEndsOn!)).toBe(termEndsOn(ANCHOR, TODAY, 1));
    expect(payment.shiftId).toBe(shiftId);
    expect(payment.idempotencyKey).toBe('7c1b0a10-0000-4000-8000-000000000001');

    const events = await ctx.prisma.membershipEvent.findMany({
      where: { membershipId: membership.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'PURCHASED',
      fromStatus: null,
      toStatus: 'ACTIVE',
      previousEndsOn: null,
      newEndsOn: null,
      actorId: adminId,
      paymentId: payment.id,
    });
  });

  it('replays a repeated Idempotency-Key as 200 and writes exactly one Payment', async () => {
    const member = await makeMember(ctx.prisma, { state: 'NO_MEMBERSHIP', today: TODAY });
    const body = { userId: member.userId, planCode: 'QUARTERLY', method: 'CASH' };

    await request(server)
      .post('/api/v1/memberships')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-000000000002')
      .send(body)
      .expect(201);

    const replay = await request(server)
      .post('/api/v1/memberships')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-000000000002')
      .send(body)
      .expect(200);

    expect(replay.body.success).toBe(true);
    expect(await ctx.prisma.payment.count()).toBe(1);
    expect(await ctx.prisma.membershipEvent.count()).toBe(1);
  });

  it('renews before expiry from endsOn + 1, leaving the anchor alone', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    const previousEndsOn = civilDateFromPrisma(before.endsOn);

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/renew`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-000000000003')
      .send({ planCode: 'MONTHLY', method: 'CASH' })
      .expect(201);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('ACTIVE');
    expect(civilDateFromPrisma(after.startsOn)).toBe(addDays(previousEndsOn, 1));
    expect(civilDateFromPrisma(after.endsOn)).toBe(
      termEndsOn(before.billingAnchorDay, addDays(previousEndsOn, 1), 1),
    );
    expect(after.billingAnchorDay).toBe(before.billingAnchorDay);
    expect(civilDateFromPrisma(after.joinedOn)).toBe(civilDateFromPrisma(before.joinedOn));

    const event = await ctx.prisma.membershipEvent.findFirstOrThrow({
      where: { membershipId: member.membershipId!, type: 'RENEWED' },
    });
    expect(civilDateFromPrisma(event.previousEndsOn!)).toBe(previousEndsOn);
    expect(civilDateFromPrisma(event.newEndsOn!)).toBe(civilDateFromPrisma(after.endsOn));
  });

  it('renews inside grace by backdating to endsOn + 1 and keeps full grace', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'IN_GRACE',
      planCode: 'MONTHLY',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/renew`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-000000000004')
      .send({ planCode: 'MONTHLY', method: 'CASH' })
      .expect(201);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('ACTIVE');
    expect(civilDateFromPrisma(after.startsOn)).toBe(TODAY);
    expect(after.billingAnchorDay).toBe(before.billingAnchorDay);
    // First late settlement in this membership's history: grace is untouched.
    expect(after.graceAdmissionsThisTerm).toBe(0);

    const event = await ctx.prisma.membershipEvent.findFirstOrThrow({
      where: { membershipId: member.membershipId!, type: 'RENEWED' },
    });
    expect(event.reason).toBe('in grace');
  });

  it('kills the second term grace when the previous term was also settled late', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'IN_GRACE',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    // §5.4.3: the previous RENEWED event's previousEndsOn was already behind the
    // gym-local day it took effect on — that term ran out and was paid in grace.
    await ctx.prisma.membershipEvent.create({
      data: {
        membershipId: member.membershipId!,
        type: 'RENEWED',
        fromStatus: 'EXPIRED',
        toStatus: 'ACTIVE',
        previousEndsOn: toDateColumn(addDays(TODAY, -40)),
        newEndsOn: toDateColumn(addDays(TODAY, -10)),
        reason: 'in grace',
        actorId: adminId,
        effectiveAt: new Date(`${addDays(TODAY, -38)}T02:00:00.000Z`),
      },
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/renew`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-000000000005')
      .send({ planCode: 'MONTHLY', method: 'CASH' })
      .expect(201);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.graceAdmissionsThisTerm).toBe(3);
  });

  it('reactivates past grace from today, re-anchoring, as REACTIVATED not RENEWED', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'EXPIRED_PAST_GRACE',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/renew`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-000000000006')
      .send({ planCode: 'MONTHLY', method: 'CASH' })
      .expect(201);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('ACTIVE');
    expect(civilDateFromPrisma(after.startsOn)).toBe(TODAY);
    expect(civilDateFromPrisma(after.endsOn)).toBe(termEndsOn(ANCHOR, TODAY, 1));
    expect(after.billingAnchorDay).toBe(ANCHOR);

    expect(
      await ctx.prisma.membershipEvent.count({
        where: { membershipId: member.membershipId!, type: 'REACTIVATED' },
      }),
    ).toBe(1);
    expect(
      await ctx.prisma.membershipEvent.count({
        where: { membershipId: member.membershipId!, type: 'RENEWED' },
      }),
    ).toBe(0);
  });

  it('reactivates a CANCELLED membership and clears cancelledOn', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'CANCELLED',
      planCode: 'QUARTERLY',
      today: TODAY,
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/renew`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-000000000007')
      .send({ planCode: 'QUARTERLY', method: 'CASH' })
      .expect(201);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('ACTIVE');
    expect(after.cancelledOn).toBeNull();
    expect(after.cancelRequestedOn).toBeNull();
    expect(civilDateFromPrisma(after.startsOn)).toBe(TODAY);
    expect(after.billingAnchorDay).toBe(ANCHOR);
  });

  it('refuses to renew a FROZEN membership with 422 MEMBERSHIP_NOT_ACTIVE', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'FROZEN',
      planCode: 'QUARTERLY',
      today: TODAY,
    });

    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/renew`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-000000000008')
      .send({ planCode: 'QUARTERLY', method: 'CASH' })
      .expect(422);

    expect(response.body.error.code).toBe('MEMBERSHIP_NOT_ACTIVE');
    expect(await ctx.prisma.payment.count()).toBe(0);
  });

  it('computes the statutory senior discount and records the OSCA number on the person', async () => {
    const member = await makeMember(ctx.prisma, { state: 'NO_MEMBERSHIP', today: TODAY });

    await request(server)
      .post('/api/v1/memberships')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-000000000009')
      .send({
        userId: member.userId,
        planCode: 'MONTHLY',
        method: 'CASH',
        discountType: 'SENIOR',
        statutoryIdNo: 'OSCA-2019-004412',
      })
      .expect(201);

    // GYM_VAT_REGISTERED is false in .env.test, so vatBase is the gross.
    const payment = await ctx.prisma.payment.findFirstOrThrow({});
    expect(payment.grossCentavos).toBe(80000);
    expect(payment.vatBaseCentavos).toBe(80000);
    expect(payment.discountCentavos).toBe(16000);
    expect(payment.netCentavos).toBe(64000);
    expect(payment.vatExempt).toBe(false);
    expect(payment.statutoryIdNo).toBe('OSCA-2019-004412');

    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: member.userId } });
    expect(user.seniorPwdIdNo).toBe('OSCA-2019-004412');
  });

  it('refuses a SENIOR sale with no ID anywhere — 422 STATUTORY_ID_REQUIRED', async () => {
    const member = await makeMember(ctx.prisma, { state: 'NO_MEMBERSHIP', today: TODAY });

    const response = await request(server)
      .post('/api/v1/memberships')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-00000000000a')
      .send({ userId: member.userId, planCode: 'MONTHLY', method: 'CASH', discountType: 'SENIOR' })
      .expect(422);

    expect(response.body.error.code).toBe('STATUTORY_ID_REQUIRED');
    expect(await ctx.prisma.membership.count()).toBe(0);
  });

  it('refuses a sale with no open drawer — 422 SHIFT_NOT_OPEN, and nothing is written', async () => {
    const member = await makeMember(ctx.prisma, { state: 'NO_MEMBERSHIP', today: TODAY });
    await ctx.prisma.shift.deleteMany({});

    const response = await request(server)
      .post('/api/v1/memberships')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-00000000000b')
      .send({ userId: member.userId, planCode: 'MONTHLY', method: 'CASH' })
      .expect(422);

    expect(response.body.error.code).toBe('SHIFT_NOT_OPEN');
    expect(await ctx.prisma.membership.count()).toBe(0);
    expect(await ctx.prisma.payment.count()).toBe(0);
  });

  it('refuses a second POST /memberships for a member who already has one', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    const response = await request(server)
      .post('/api/v1/memberships')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-00000000000c')
      .send({ userId: member.userId, planCode: 'MONTHLY', method: 'CASH' })
      .expect(409);

    expect(response.body.error.code).toBe('MEMBER_ALREADY_IMPORTED');
    expect(await ctx.prisma.membership.count()).toBe(1);
  });

  it('refuses the walk-in price as a membership plan', async () => {
    const member = await makeMember(ctx.prisma, { state: 'NO_MEMBERSHIP', today: TODAY });

    const response = await request(server)
      .post('/api/v1/memberships')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-00000000000d')
      .send({ userId: member.userId, planCode: 'WALKIN', method: 'CASH' })
      .expect(404);

    expect(response.body.error.code).toBe('PLAN_NOT_FOUND');
  });

  it('refuses a COACH: selling is FRONT_DESK and ADMIN only', async () => {
    const member = await makeMember(ctx.prisma, { state: 'NO_MEMBERSHIP', today: TODAY });
    const coachToken = await ctx.fixture.tokenFor('COACH', { supabaseId: FIXTURE_IDS.COACH_A });

    await request(server)
      .post('/api/v1/memberships')
      .set('Authorization', `Bearer ${coachToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-00000000000e')
      .send({ userId: member.userId, planCode: 'MONTHLY', method: 'CASH' })
      .expect(403);
  });
});
```

- [ ] **Step 3: Run the e2e and watch it fail**

Run: `npm run test:e2e --workspace=server -- memberships`
Expected: FAIL — `expected 201 "Created", got 404 "Not Found"` on `POST /api/v1/memberships` (the route does not exist yet).

- [ ] **Step 4: Write CreateMembershipDto**

```typescript
// server/src/membership/dto/create-membership.dto.ts
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';
import { DiscountType, PaymentMethod } from '@got/shared';
import { IsCentavos } from '../../common/validators/is-centavos.validator';

/**
 * Route 22. The canonical money DTO for this chunk.
 *
 * There is deliberately NO `startsOn` and NO `endsOn`. §5.7.3's four cases are
 * decided by the server from `gymToday()` and the row's own dates; a
 * client-supplied start date is how a desk staffer quietly backdates a term to
 * be generous, which is what comp days (route 29) exist for — visible, reasoned
 * and admin-approved.
 *
 * There is also NO amount field. `grossCentavos` is the plan's list price and
 * the discount is computed (§5.7.4), so no staff member ever types a peso
 * figure and the till cannot disagree with the price list.
 *
 * `discountCentavos` applies ONLY to the discretionary types. For SENIOR and
 * PWD the statute fixes the arithmetic and the service ignores anything sent
 * here — the bound exists so the pipe rejects nonsense before the CHECK does.
 */
export class CreateMembershipDto {
  @IsUUID('4')
  userId!: string;

  @IsString()
  @MaxLength(32)
  planCode!: string;

  @IsOptional()
  @IsEnum(DiscountType)
  discountType?: DiscountType;

  /** Matches Payment_money_consistent's ceiling. Ignored for SENIOR / PWD. */
  @IsOptional()
  @IsCentavos(0, 10_000_000)
  discountCentavos?: number;

  /** The OSCA / PWD ID. Falls back to User.seniorPwdIdNo when omitted. */
  @IsOptional()
  @IsString()
  @Length(3, 64)
  statutoryIdNo?: string;

  /** Required by Payment_discount_shape for PROMO / STAFF / GUEST_PASS / GOODWILL. */
  @IsOptional()
  @IsString()
  @Length(3, 200)
  discountReason?: string;

  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  /** Required when method is GCASH — an unreferenced GCash row cannot be reconciled. */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  reference?: string;

  /** The number staff wrote in the BIR booklet. Free text, never a sequence. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  receiptNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
```

- [ ] **Step 5: Write RenewMembershipDto**

```typescript
// server/src/membership/dto/renew-membership.dto.ts
import {
  IsEnum,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { DiscountType, PaymentMethod } from '@got/shared';
import { IsCentavos } from '../../common/validators/is-centavos.validator';

/**
 * Route 23. CreateMembershipDto's fields minus `userId`, which comes from the
 * membership in the path.
 *
 * Written out in full rather than extended from CreateMembershipDto: TypeScript
 * has no way to REMOVE an inherited property, and `whitelist` +
 * `forbidNonWhitelisted` would then accept a `userId` on a renewal and silently
 * ignore it — a request that looks like it renews member A while renewing B.
 *
 * As on route 22 there is no `startsOn`: §5.7.3's before-expiry / in-grace /
 * post-grace / post-cancel split is the server's decision, and the distinction
 * between RENEWED and REACTIVATED is what churn reporting counts.
 */
export class RenewMembershipDto {
  @IsString()
  @MaxLength(32)
  planCode!: string;

  @IsOptional()
  @IsEnum(DiscountType)
  discountType?: DiscountType;

  @IsOptional()
  @IsCentavos(0, 10_000_000)
  discountCentavos?: number;

  @IsOptional()
  @IsString()
  @Length(3, 64)
  statutoryIdNo?: string;

  @IsOptional()
  @IsString()
  @Length(3, 200)
  discountReason?: string;

  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  receiptNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
```

- [ ] **Step 6: Write MembershipSalesService**

```typescript
// server/src/membership/membership-sales.service.ts
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  DiscountType,
  MembershipEventType,
  MembershipStatus,
  PaymentMethod,
  PaymentPurpose,
  PlanKind,
  type Prisma,
} from '@prisma/client';
import {
  DiscountType as SharedDiscountType,
  MembershipStatus as SharedStatus,
} from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { DomainException } from '../common/exceptions/domain.exception';
import { hashRequestBody } from '../common/idempotency/request-hash';
import {
  civilDateFromPrisma,
  gymToday,
  toDateColumn,
  type CivilDate,
} from '../common/time/gym-time';
import type { AuthUser } from '../auth/auth.types';
import { allocateMemberCode } from '../users/member-code.util';
import { PlansService } from '../catalogue/plans.service';
import { PaymentsService } from '../payments/payments.service';
import { ShiftsService } from '../payments/shifts.service';
import { MembershipService } from './membership.service';
import { assertTransition } from './membership-transitions';
import { writeMembershipEvent } from './membership-events';
import { computeAmounts, planTerm, type CurrentTerm, type PlannedTerm } from './membership-terms';
import type { MembershipDetail } from './membership.presenter';
import type { CreateMembershipDto } from './dto/create-membership.dto';
import type { RenewMembershipDto } from './dto/renew-membership.dto';

/** The money half of both DTOs, which is identical on routes 22 and 23. */
interface SaleInput {
  discountType?: DiscountType;
  discountCentavos?: number;
  statutoryIdNo?: string;
  discountReason?: string;
  method: PaymentMethod;
  reference?: string;
  receiptNo?: string;
  notes?: string;
}

interface SaleContext {
  userId: string;
  membershipId: string;
  plan: { id: string; code: string; name: string; priceCentavos: number };
  termMonths: number;
  term: PlannedTerm;
  today: CivilDate;
  now: Date;
  idempotencyKey: string;
  /** The ID already held on the person, so it is not re-typed at every sale. */
  memberStatutoryIdNo: string | null;
}

/**
 * Transitions 1, 3, 4, 14 and 15 — the whole sell-and-renew surface.
 *
 * Two rules this file exists to hold:
 *
 * 1. The SERVER decides the term. `planTerm()` is pure and already tested
 *    against §5.7.3's four cases; this service does the loading and the
 *    transaction, exactly the PermissionsService / PermissionsGuard split.
 * 2. The membership row, the Payment and the MembershipEvent are ONE
 *    transaction. A sale that writes a term with no money, or money with no
 *    term, is the failure that makes an owner stop trusting the revenue figure.
 *
 * This is also the only place `allocateMemberCode()` is called on the sales
 * path, and it is called LAZILY: staff accounts never need a code, and
 * UserProvisioningService must stay a single upsert on the per-request hot path.
 *
 * Prisma's generated enums are literal unions and @got/shared's are TS enums:
 * same strings, different nominal types, so the pure helpers take one cast at
 * the boundary and the database writes use the Prisma values.
 */
@Injectable()
export class MembershipSalesService {
  private readonly logger = new Logger(MembershipSalesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly memberships: MembershipService,
    private readonly plans: PlansService,
    private readonly payments: PaymentsService,
    private readonly shifts: ShiftsService,
  ) {}

  /** Route 22 — §5.5.2 row 1. */
  async sell(
    actor: AuthUser,
    dto: CreateMembershipDto,
    idempotencyKey: string,
    now: Date,
  ): Promise<MembershipDetail> {
    const today = gymToday(now, this.gym.timeZone);

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: dto.userId, deletedAt: null },
        select: { id: true, memberCode: true, seniorPwdIdNo: true },
      });
      if (!user) {
        throw new DomainException(
          'MEMBER_NOT_FOUND',
          'No member with that id.',
          HttpStatus.NOT_FOUND,
        );
      }

      // One Membership row per member, forever. Checked here as well as by
      // Membership_userId_key so the desk gets the sentence, not the constraint.
      const existing = await tx.membership.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });
      if (existing) {
        throw new DomainException(
          'MEMBER_ALREADY_IMPORTED',
          'This member already has a membership. Renew it at POST /memberships/:id/renew.',
          HttpStatus.CONFLICT,
        );
      }

      const plan = await this.plans.requireSellable(tx, dto.planCode);
      const termMonths = this.requireTermPlan(plan);

      const term = planTerm(null, today, termMonths);
      assertTransition(null, SharedStatus.ACTIVE);

      // Lazily, inside the FIRST membership transaction. allocateMemberCode
      // probes by SELECT and returns a free code; the caller does the write,
      // because a speculative INSERT would abort this transaction (25P02).
      if (!user.memberCode) {
        const memberCode = await allocateMemberCode(tx);
        await tx.user.update({ where: { id: user.id }, data: { memberCode } });
      }

      const membership = await tx.membership.create({
        data: {
          userId: user.id,
          planId: plan.id,
          status: MembershipStatus.ACTIVE,
          planCode: plan.code,
          planName: plan.name,
          planPriceCentavos: plan.priceCentavos,
          termMonths,
          graceDays: plan.graceDays,
          guestPassesPerTerm: plan.guestPassesPerTerm,
          startsOn: toDateColumn(term.startsOn),
          endsOn: toDateColumn(term.endsOn),
          billingAnchorDay: term.billingAnchorDay,
          joinedOn: toDateColumn(term.startsOn),
          graceAdmissionsThisTerm: 0,
          freezesUsedThisTerm: 0,
          guestPassesRemaining: plan.guestPassesPerTerm,
          purchasedAt: now,
        },
        select: { id: true },
      });

      const payment = await this.recordSalePayment(tx, actor, dto, {
        userId: user.id,
        membershipId: membership.id,
        plan,
        termMonths,
        term,
        today,
        now,
        idempotencyKey,
        memberStatutoryIdNo: user.seniorPwdIdNo,
      });

      await writeMembershipEvent(tx, {
        membershipId: membership.id,
        type: MembershipEventType.PURCHASED,
        fromStatus: null,
        toStatus: MembershipStatus.ACTIVE,
        // Nothing moved: there was no previous term. MembershipEvent_dates_paired
        // requires both columns null together.
        previousEndsOn: null,
        newEndsOn: null,
        reason: null,
        actorId: actor.id,
        paymentId: payment.id,
        batchRef: null,
        effectiveAt: now,
      });

      this.logger.log(
        `sold membership=${membership.id} user=${user.id} plan=${plan.code} ` +
          `term=${term.startsOn}..${term.endsOn} actor=${actor.id}`,
      );

      return this.memberships.detailById(tx, membership.id, now);
    });
  }

  /** Route 23 — §5.5.2 rows 3, 4, 14 and 15. */
  async renew(
    actor: AuthUser,
    membershipId: string,
    dto: RenewMembershipDto,
    idempotencyKey: string,
    now: Date,
  ): Promise<MembershipDetail> {
    const today = gymToday(now, this.gym.timeZone);

    return this.prisma.$transaction(async (tx) => {
      const membership = await this.memberships.loadForUpdate(tx, membershipId);

      // §5.5.3. Refused HERE and not in the transition table, because
      // FROZEN -> ACTIVE is legitimate (row 9, early release) and the table
      // cannot tell the two apart. Unfreeze first, so the freeze extension
      // arithmetic never has two writers.
      if (membership.status === MembershipStatus.FROZEN) {
        throw new DomainException(
          'MEMBERSHIP_NOT_ACTIVE',
          'Unfreeze this membership before renewing it.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      const user = await tx.user.findUniqueOrThrow({
        where: { id: membership.userId },
        select: { seniorPwdIdNo: true },
      });

      const plan = await this.plans.requireSellable(tx, dto.planCode);
      const termMonths = this.requireTermPlan(plan);

      const current: CurrentTerm = {
        status: membership.status as unknown as SharedStatus,
        endsOn: civilDateFromPrisma(membership.endsOn),
        graceDays: membership.graceDays,
        billingAnchorDay: membership.billingAnchorDay,
      };
      const term = planTerm(current, today, termMonths);
      assertTransition(membership.status as unknown as SharedStatus, SharedStatus.ACTIVE);

      const graceAdmissions = await this.openingGraceAdmissions(tx, membershipId, term);
      const previousEndsOn = current.endsOn;

      await tx.membership.update({
        where: { id: membershipId },
        data: {
          planId: plan.id,
          status: MembershipStatus.ACTIVE,
          // Snapshots refreshed: the NEW term's commercial terms, not the old.
          planCode: plan.code,
          planName: plan.name,
          planPriceCentavos: plan.priceCentavos,
          termMonths,
          graceDays: plan.graceDays,
          guestPassesPerTerm: plan.guestPassesPerTerm,
          startsOn: toDateColumn(term.startsOn),
          endsOn: toDateColumn(term.endsOn),
          billingAnchorDay: term.billingAnchorDay,
          // Membership_cancel_shape is biconditional, so reactivating from
          // CANCELLED must clear cancelledOn in the same statement.
          cancelRequestedOn: null,
          cancelledOn: null,
          // Per-term counters, all reset (§5.3.3).
          graceAdmissionsThisTerm: graceAdmissions,
          freezesUsedThisTerm: 0,
          guestPassesRemaining: plan.guestPassesPerTerm,
          purchasedAt: now,
        },
      });

      const payment = await this.recordSalePayment(tx, actor, dto, {
        userId: membership.userId,
        membershipId,
        plan,
        termMonths,
        term,
        today,
        now,
        idempotencyKey,
        memberStatutoryIdNo: user.seniorPwdIdNo,
      });

      await writeMembershipEvent(tx, {
        membershipId,
        // A restart is not a renewal, and churn reporting depends on the
        // distinction (§5.7.3).
        type:
          term.kind === 'REACTIVATION'
            ? MembershipEventType.REACTIVATED
            : MembershipEventType.RENEWED,
        fromStatus: membership.status,
        toStatus: MembershipStatus.ACTIVE,
        previousEndsOn,
        newEndsOn: term.endsOn,
        reason: term.kind === 'RENEWAL_IN_GRACE' ? 'in grace' : null,
        actorId: actor.id,
        paymentId: payment.id,
        batchRef: null,
        effectiveAt: now,
      });

      this.logger.log(
        `renewed membership=${membershipId} kind=${term.kind} plan=${plan.code} ` +
          `term=${term.startsOn}..${term.endsOn} grace=${graceAdmissions} actor=${actor.id}`,
      );

      return this.memberships.detailById(tx, membershipId, now);
    });
  }

  /**
   * A WALK_IN plan prices a single day's entry and never creates or extends a
   * membership. Reported as PLAN_NOT_FOUND rather than a new code: from route
   * 22's point of view there IS no term plan with that code, and the message
   * says which mistake was made.
   */
  private requireTermPlan(plan: {
    code: string;
    kind: PlanKind;
    termMonths: number | null;
  }): number {
    if (plan.kind !== PlanKind.TERM || plan.termMonths === null) {
      throw new DomainException(
        'PLAN_NOT_FOUND',
        `${plan.code} prices a single day's entry, not a term — there is no term plan with that code.`,
        HttpStatus.NOT_FOUND,
      );
    }
    return plan.termMonths;
  }

  /**
   * §5.4.3's un-farmable-grace rule.
   *
   * A term settled inside grace opens with NO grace of its own when the term
   * before it was ALSO settled late. Without it a Monthly member trains three
   * free days every cycle, forever.
   *
   * "Settled late" is read off the ledger rather than recomputed: the most
   * recent RENEWED event whose previousEndsOn was already behind the gym-local
   * day that event took effect on.
   */
  private async openingGraceAdmissions(
    tx: Prisma.TransactionClient,
    membershipId: string,
    term: PlannedTerm,
  ): Promise<number> {
    if (term.kind !== 'RENEWAL_IN_GRACE') return 0;

    const previous = await tx.membershipEvent.findFirst({
      where: {
        membershipId,
        type: MembershipEventType.RENEWED,
        previousEndsOn: { not: null },
      },
      orderBy: { effectiveAt: 'desc' },
      select: { previousEndsOn: true, effectiveAt: true },
    });
    if (!previous || previous.previousEndsOn === null) return 0;

    const settledOn = gymToday(previous.effectiveAt, this.gym.timeZone);
    const lapsedThatTimeToo = civilDateFromPrisma(previous.previousEndsOn) < settledOn;
    return lapsedThatTimeToo ? this.gym.graceAdmissionsMax : 0;
  }

  /**
   * The money half, identical on both routes.
   *
   * Every rule checked here is ALSO a CHECK constraint on Payment. The service
   * check is the user-facing path and the constraint is the backstop, so a
   * constraint firing is a bug report rather than a 500 the console cannot
   * branch on.
   */
  private async recordSalePayment(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    input: SaleInput,
    context: SaleContext,
  ): Promise<{ id: string }> {
    const discountType = input.discountType ?? DiscountType.NONE;

    // One @RequirePermission key per route, so the discount split is an
    // in-service check against the caller's resolved permissions, never a
    // second decorator (§5.11).
    await this.payments.assertDiscountAllowed(actor, discountType);

    const statutory =
      discountType === DiscountType.SENIOR || discountType === DiscountType.PWD;
    const statutoryIdNo = statutory
      ? (input.statutoryIdNo?.trim() ?? context.memberStatutoryIdNo?.trim() ?? '')
      : '';
    if (statutory && statutoryIdNo.length === 0) {
      throw new DomainException(
        'STATUTORY_ID_REQUIRED',
        'A senior or PWD discount requires the OSCA / PWD ID number. BIR keeps this register separately.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const discretionary = discountType !== DiscountType.NONE && !statutory;
    const discountReason = discretionary ? (input.discountReason?.trim() ?? '') : '';
    if (discretionary && discountReason.length < 3) {
      throw new DomainException(
        'DISCOUNT_ID_REQUIRED',
        `A ${discountType} discount requires a reason of at least three characters.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const reference = input.reference?.trim() ?? '';
    if (input.method === PaymentMethod.GCASH && reference.length === 0) {
      throw new DomainException(
        'GCASH_REFERENCE_REQUIRED',
        'A GCash payment with no reference cannot be reconciled against the statement.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const amounts = computeAmounts({
      priceCentavos: context.plan.priceCentavos,
      discountType: discountType as unknown as SharedDiscountType,
      vatRegistered: this.gym.vatRegistered,
      // Staff never type an amount for a statutory discount (§5.7.4): the
      // statute fixes it, so anything sent is discarded rather than trusted.
      operatorDiscountCentavos: discretionary ? (input.discountCentavos ?? 0) : 0,
    });

    // Held on the person, not re-typed at every sale (§5.3.1).
    if (statutory && statutoryIdNo !== (context.memberStatutoryIdNo ?? '')) {
      await tx.user.update({
        where: { id: context.userId },
        data: { seniorPwdIdNo: statutoryIdNo },
      });
    }

    // Payment.shiftId is NOT NULL and stays that way: money without a counted
    // drawer is exactly what cannot be reconciled later.
    const shiftId = await this.shifts.requireOpenShiftId(tx);

    return this.payments.createInTx(tx, {
      userId: context.userId,
      membershipId: context.membershipId,
      planId: context.plan.id,
      planCode: context.plan.code,
      planName: context.plan.name,
      purpose: PaymentPurpose.MEMBERSHIP,
      amounts,
      discountType,
      statutoryIdNo: statutory ? statutoryIdNo : null,
      discountReason: discretionary ? discountReason : null,
      termMonths: context.termMonths,
      termStartsOn: context.term.startsOn,
      termEndsOn: context.term.endsOn,
      method: input.method,
      reference: reference.length > 0 ? reference : null,
      receiptNo: input.receiptNo?.trim() ?? null,
      receivedAt: context.now,
      businessDate: context.today,
      shiftId,
      recordedById: actor.id,
      // The header value, stored on the row as well as on IdempotencyRecord.
      // The interceptor's hash over the RAW body is what decides a replay; this
      // one is the row-level fingerprint an auditor reads six months later.
      idempotencyKey: context.idempotencyKey,
      idempotencyHash: hashRequestBody(input),
      notes: input.notes?.trim() ?? null,
    });
  }
}
```

- [ ] **Step 7: Wire routes 22 and 23 and register the provider**

```typescript
// server/src/membership/memberships.controller.ts — extend the imports, the
// constructor and append these two routes after the read pair.
//
// import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
// import { IDEMPOTENCY_HEADER } from '../common/decorators/idempotent.decorator';
// import { Idempotent } from '../common/decorators/idempotent.decorator';
// import { MembershipSalesService } from './membership-sales.service';
// import { CreateMembershipDto } from './dto/create-membership.dto';
// import { RenewMembershipDto } from './dto/renew-membership.dto';
//
//   constructor(
//     private readonly memberships: MembershipService,
//     private readonly sales: MembershipSalesService,   // ← added by this task
//   ) {}

  /**
   * Route 22. `@Idempotent()` is not optional on a money write: the interceptor
   * claims the key BEFORE the handler runs, so a desk staffer double-tapping
   * SELL gets one membership, one Payment and a 200 replay of the first receipt.
   */
  @Post()
  @RequirePermission('membership.sell')
  @Idempotent()
  async sell(
    @CurrentUser() user: AuthUser,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey: string,
    @Body() dto: CreateMembershipDto,
  ): Promise<MembershipDetail> {
    return this.sales.sell(user, dto, idempotencyKey, new Date());
  }

  /** Route 23. The server decides which of §5.7.3's four cases this is. */
  @Post(':id/renew')
  @RequirePermission('membership.sell')
  @Idempotent()
  async renew(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey: string,
    @Body() dto: RenewMembershipDto,
  ): Promise<MembershipDetail> {
    return this.sales.renew(user, id, dto, idempotencyKey, new Date());
  }
```

```typescript
// server/src/membership/membership.module.ts — add to the existing arrays.
// CatalogueModule exports PlansService; PaymentsModule exports PaymentsService
// and ShiftsService. Both are imported here rather than re-provided, or there
// would be two PrismaService-backed copies of the shift sentinel logic.
//
//   imports: [CatalogueModule, PaymentsModule],
//   providers: [..., MembershipSalesService],
```

- [ ] **Step 8: Run the e2e and watch it pass**

Run: `npm run test:e2e --workspace=server -- memberships`
Expected: PASS — fourteen cases green, including the four §5.7.3 renewal cases, the 200 replay with exactly one `Payment`, and the back-to-back in-grace renewal opening at `graceAdmissionsThisTerm: 3`.

- [ ] **Step 9: Run the whole server suite and typecheck**

Run: `npm test --workspace=server && npm run typecheck --workspace=server`
Expected: PASS — no unit suite regressions, typecheck exits 0. `npm run lint` remains red with its ~19–27 pre-existing problems; do not fix them here.

- [ ] **Step 10: Commit**

```bash
git add server/src/membership/membership-sales.service.ts \
        server/src/membership/dto/create-membership.dto.ts \
        server/src/membership/dto/renew-membership.dto.ts \
        server/src/membership/memberships.controller.ts \
        server/src/membership/membership.module.ts \
        server/test/support/membership-fixtures.ts \
        server/test/memberships.e2e-spec.ts
git commit -m "feat(membership): sell and renew, with lazy memberCode allocation (routes 22-23)

Transitions 1, 3, 4, 14 and 15 in one transaction with the Payment and the
MembershipEvent. The server decides the term: before expiry and inside grace
both start at endsOn + 1 with the anchor unchanged, after grace and after
CANCELLED start today, re-anchor, and are REACTIVATED rather than RENEWED.

allocateMemberCode() is called here and nowhere else on the sales path —
lazily, inside the first membership transaction, never at provisioning.

A second in-grace renewal after a term that was also settled late opens with
graceAdmissionsThisTerm = graceAdmissionsMax (spec 5.4.3), so grace cannot be
cycled every month forever."
```

---

### Task 13: Cancellation notice, termination, comp days and admin correction

**Ordering:** task 14 lands **before** this task. `cancel()` on a `FROZEN` membership calls `MembershipHoldsService.clawBackInTx` (§5.5.2 row 10), and a second copy of `endsOn -= unused` is the exact bug §5.6.2 is written to prevent. Apart from that one call the two tasks are independent.

**Files:**
- Create: `server/src/membership/dto/cancellation.dto.ts`
- Create: `server/src/membership/dto/adjust-term.dto.ts`
- Create: `server/src/membership/membership-lifecycle.service.ts`
- Modify: `server/src/membership/memberships.controller.ts` (created in task 11, extended in task 12 — add `MembershipLifecycleService` to the constructor and append routes 24, 25, 28, 29 and 30 after the renew route)
- Modify: `server/src/membership/membership.module.ts` (created in task 11 — add `MembershipLifecycleService` to `providers`)
- Test: `server/test/memberships.e2e-spec.ts` (created in task 12 — append the `cancellation, comp days and correction` describe)

**Interfaces:**
- Consumes: `server/src/membership/membership-transitions.ts` (task 5): `assertTransition(from, to)`, `TRANSITION_BYPASS_REASON_REQUIRED` · `server/src/membership/membership-events.ts` (task 11): `writeMembershipEvent(tx, event)` · `server/src/membership/membership.service.ts` (task 11): `loadForUpdate(tx, membershipId)`, `detailById(tx, membershipId, now)` · `server/src/membership/membership.presenter.ts` (task 11): `type MembershipDetail` · `server/src/membership/membership-holds.service.ts` (task 14): `clawBackInTx(tx, membershipId, today, effectiveAt, actorId): Promise<HoldDelta | null>` — returns `null` when there is no running hold · `server/src/common/dto/confirm.dto.ts` (task 2): `abstract class ConfirmDto { confirm!: true }`, `assertConfirmed(dto): void` throwing 400 `CONFIRMATION_REQUIRED` · `server/src/common/validators/is-gym-date.validator.ts` (Chunk 0): `IsGymDate()` · `server/src/common/time/gym-time.ts`: `gymToday`, `asCivilDate`, `civilDateFromPrisma`, `addDays`, `toDateColumn`, `type CivilDate` · `GymConfigService.timeZone` · permission keys `membership.cancel.request` (FRONT_DESK + ADMIN), `membership.cancel`, `membership.term.adjust`, `membership.status.correct` (all ADMIN-only and dangerous) (task 2)
- Produces: `RequestCancellationDto`, `CancelMembershipDto`, `AdjustTermDto`, `CorrectMembershipDto` · `MembershipLifecycleService { requestCancellation, withdrawCancellation, cancel, adjustTerm, correct }`, each returning `Promise<MembershipDetail>`

**Adjudication carried by this task:** §7.7 route 29 says `AdjustTermDto` takes "±1–30 days"; §5.5.2 row 16 says `endsOn += n, 1 ≤ n ≤ 60`, and task 15's `ExtendAllDto` comment names 1–60 as "the same range AdjustTermDto uses". **1–60, positive only.** Comp days are a credit; taking days away is a correction of a data error and goes through route 30 under `membership.status.correct`, which is the dangerous key that already permits arbitrary dates. One direction per route means the audit trail says which of the two happened.

---

- [ ] **Step 1: Write the failing e2e for routes 24, 25, 28, 29 and 30**

```typescript
// server/test/memberships.e2e-spec.ts — APPEND this describe to the file task 12 created.
describe('cancellation, comp days and correction (routes 24, 25, 28, 29, 30)', () => {
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    plans = await seedPlansForTest(ctx.prisma);
    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    adminId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
    shiftId = await openShift(ctx.prisma, adminId, TODAY);
  });

  it('records notice without ending the term, and a repeat notice writes no second event', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });

    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/cancel-request`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'moving to Cebu for work' })
      .expect(201);

    expect(response.body.data.status).toBe('ACTIVE');

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('ACTIVE');
    expect(civilDateFromPrisma(after.cancelRequestedOn!)).toBe(TODAY);
    expect(after.cancelledOn).toBeNull();
    // Notice given, term honoured to the end.
    expect(civilDateFromPrisma(after.endsOn)).toBe(civilDateFromPrisma(before.endsOn));

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/cancel-request`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'saying it twice' })
      .expect(201);

    expect(
      await ctx.prisma.membershipEvent.count({
        where: { membershipId: member.membershipId!, type: 'CANCELLATION_REQUESTED' },
      }),
    ).toBe(1);
  });

  it('withdraws notice, and refuses a withdrawal when none was given', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    const empty = await request(server)
      .delete(`/api/v1/memberships/${member.membershipId!}/cancel-request`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(422);
    expect(empty.body.error.code).toBe('MEMBERSHIP_INVALID_TRANSITION');

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/cancel-request`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'thinking about it' })
      .expect(201);

    await request(server)
      .delete(`/api/v1/memberships/${member.membershipId!}/cancel-request`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.cancelRequestedOn).toBeNull();
    expect(
      await ctx.prisma.membershipEvent.count({
        where: { membershipId: member.membershipId!, type: 'CANCELLATION_WITHDRAWN' },
      }),
    ).toBe(1);
  });

  it('terminates a membership: cancelledOn is today, endsOn is untouched history', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'QUARTERLY',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });

    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, reason: 'member moved abroad permanently' })
      .expect(201);

    expect(response.body.data.status).toBe('CANCELLED');

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('CANCELLED');
    expect(civilDateFromPrisma(after.cancelledOn!)).toBe(TODAY);
    expect(civilDateFromPrisma(after.endsOn)).toBe(civilDateFromPrisma(before.endsOn));

    const events = await ctx.prisma.membershipEvent.findMany({
      where: { membershipId: member.membershipId!, type: 'CANCELLED' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromStatus: 'ACTIVE',
      toStatus: 'CANCELLED',
      reason: 'member moved abroad permanently',
      actorId: adminId,
    });
  });

  it('refuses an unconfirmed termination with 400 CONFIRMATION_REQUIRED', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: false, reason: 'not really sure' })
      .expect(400);

    expect(response.body.error.code).toBe('CONFIRMATION_REQUIRED');
    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('ACTIVE');
  });

  it('refuses a second termination with 422 MEMBERSHIP_ALREADY_CANCELLED', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'CANCELLED',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, reason: 'terminating it again' })
      .expect(422);

    expect(response.body.error.code).toBe('MEMBERSHIP_ALREADY_CANCELLED');
  });

  it('claws back the running freeze before terminating (row 10): HOLD_RELEASED then CANCELLED', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'FROZEN',
      planCode: 'QUARTERLY',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, reason: 'terminated during a freeze' })
      .expect(201);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('CANCELLED');
    expect(civilDateFromPrisma(after.cancelledOn!)).toBe(TODAY);
    // The fixture hold runs today..today+13 with 14 days already applied.
    // Released on day one: 13 unused days come back off.
    expect(civilDateFromPrisma(after.endsOn)).toBe(
      addDays(civilDateFromPrisma(before.endsOn), -13),
    );

    const hold = await ctx.prisma.membershipHold.findFirstOrThrow({
      where: { membershipId: member.membershipId! },
    });
    expect(hold.status).toBe('COMPLETED');
    expect(hold.daysApplied).toBe(1);
    expect(hold.activeMembershipId).toBeNull();

    const types = (
      await ctx.prisma.membershipEvent.findMany({
        where: { membershipId: member.membershipId! },
        orderBy: { createdAt: 'asc' },
        select: { type: true },
      })
    ).map((event) => event.type);
    expect(types).toEqual(['HOLD_RELEASED', 'CANCELLED']);
  });

  it('adds comp days to an EXPIRED membership without touching the status', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'EXPIRED_PAST_GRACE',
      planCode: 'MONTHLY',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/adjust-term`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, days: 5, reason: 'goodwill — aircon was out all week' })
      .expect(201);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('EXPIRED');
    expect(civilDateFromPrisma(after.endsOn)).toBe(
      addDays(civilDateFromPrisma(before.endsOn), 5),
    );

    const event = await ctx.prisma.membershipEvent.findFirstOrThrow({
      where: { membershipId: member.membershipId!, type: 'ADJUSTED' },
    });
    expect(event.fromStatus).toBe('EXPIRED');
    expect(event.toStatus).toBe('EXPIRED');
    expect(event.reason).toBe('goodwill — aircon was out all week');
    expect(civilDateFromPrisma(event.previousEndsOn!)).toBe(civilDateFromPrisma(before.endsOn));
    expect(civilDateFromPrisma(event.newEndsOn!)).toBe(civilDateFromPrisma(after.endsOn));
    expect(event.batchRef).toBeNull();
  });

  it('refuses comp days on a CANCELLED membership with 422 MEMBERSHIP_INVALID_TRANSITION', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'CANCELLED',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/adjust-term`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, days: 3, reason: 'they asked nicely' })
      .expect(422);

    expect(response.body.error.code).toBe('MEMBERSHIP_INVALID_TRANSITION');
  });

  it('refuses comp days outside 1..60 at the pipe', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/adjust-term`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, days: 61, reason: 'far too generous' })
      .expect(400);

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/adjust-term`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, days: -3, reason: 'taking days back' })
      .expect(400);
  });

  it('corrects a data error, bypassing the transition table the other routes obey', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'EXPIRED_PAST_GRACE',
      planCode: 'QUARTERLY',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });

    // EXPIRED -> FROZEN is refused by assertTransition on every other route.
    // membership.status.correct is the one documented bypass, and it is the
    // reason this test exists.
    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/correct`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        confirm: true,
        status: 'FROZEN',
        endsOn: addDays(TODAY, 20),
        reason: 'keyed against the wrong member on 14 Aug',
      })
      .expect(201);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('FROZEN');
    expect(civilDateFromPrisma(after.endsOn)).toBe(addDays(TODAY, 20));
    expect(after.cancelledOn).toBeNull();

    const event = await ctx.prisma.membershipEvent.findFirstOrThrow({
      where: { membershipId: member.membershipId!, type: 'STATUS_CORRECTED' },
    });
    expect(event.fromStatus).toBe('EXPIRED');
    expect(event.toStatus).toBe('FROZEN');
    expect(event.reason).toBe('keyed against the wrong member on 14 Aug');
    expect(civilDateFromPrisma(event.previousEndsOn!)).toBe(civilDateFromPrisma(before.endsOn));
    expect(civilDateFromPrisma(event.newEndsOn!)).toBe(addDays(TODAY, 20));
  });

  it('keeps cancelledOn biconditional with the status on both directions of a correction', async () => {
    const cancelled = await makeMember(ctx.prisma, {
      state: 'CANCELLED',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    await request(server)
      .post(`/api/v1/memberships/${cancelled.membershipId!}/correct`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, status: 'ACTIVE', reason: 'cancelled the wrong member' })
      .expect(201);

    const revived = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: cancelled.membershipId! },
    });
    expect(revived.status).toBe('ACTIVE');
    expect(revived.cancelledOn).toBeNull();

    const active = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });
    await request(server)
      .post(`/api/v1/memberships/${active.membershipId!}/correct`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, status: 'CANCELLED', reason: 'should have been terminated in July' })
      .expect(201);

    const terminated = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: active.membershipId! },
    });
    expect(terminated.status).toBe('CANCELLED');
    expect(civilDateFromPrisma(terminated.cancelledOn!)).toBe(TODAY);
  });

  it('refuses a correction that changes nothing, and one that inverts the term', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    const empty = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/correct`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, reason: 'no field supplied' })
      .expect(422);
    expect(empty.body.error.code).toBe('MEMBERSHIP_STATE_INVALID');

    const inverted = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/correct`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        confirm: true,
        startsOn: addDays(TODAY, 5),
        endsOn: addDays(TODAY, 1),
        reason: 'endsOn before startsOn',
      })
      .expect(422);
    expect(inverted.body.error.code).toBe('MEMBERSHIP_STATE_INVALID');
  });

  it('refuses FRONT_DESK on every dangerous route, and admits it on notice', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });
    const deskToken = await ctx.fixture.tokenFor('FRONT_DESK', {
      supabaseId: FIXTURE_IDS.FRONT_DESK,
    });

    // membership.cancel.request IS granted to the desk — taking notice is
    // counter work, and the portal promises no lock-in.
    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/cancel-request`)
      .set('Authorization', `Bearer ${deskToken}`)
      .send({ reason: 'member gave notice at the counter' })
      .expect(201);

    for (const [path, body] of [
      ['cancel', { confirm: true, reason: 'terminating now' }],
      ['adjust-term', { confirm: true, days: 3, reason: 'goodwill days' }],
      ['correct', { confirm: true, status: 'EXPIRED', reason: 'fixing a mistake' }],
    ] as const) {
      await request(server)
        .post(`/api/v1/memberships/${member.membershipId!}/${path}`)
        .set('Authorization', `Bearer ${deskToken}`)
        .send(body)
        .expect(403);
    }
  });

  it('404s on a membership that does not exist, never 403', async () => {
    const response = await request(server)
      .post('/api/v1/memberships/00000000-0000-4000-8000-000000000000/cancel')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, reason: 'nothing to terminate' })
      .expect(404);

    expect(response.body.error.code).toBe('MEMBERSHIP_NOT_FOUND');
  });
});
```

- [ ] **Step 2: Run the e2e and watch it fail**

Run: `npm run test:e2e --workspace=server -- memberships`
Expected: FAIL — `expected 201 "Created", got 404 "Not Found"` on `POST /api/v1/memberships/:id/cancel-request` (the route does not exist yet).

- [ ] **Step 3: Write the cancellation DTOs**

```typescript
// server/src/membership/dto/cancellation.dto.ts
import { IsString, Length } from 'class-validator';
import { ConfirmDto } from '../../common/dto/confirm.dto';

/**
 * Route 24 — notice, not termination. `cancelRequestedOn` goes on an otherwise
 * ACTIVE row and the term runs to its end, which is what keeps the portal's
 * "cancel any time, no lock-in" promise honest without contradicting the rule
 * that CANCELLED denies at the door immediately.
 *
 * The reason is required even though CANCELLATION_REQUESTED is not covered by
 * MembershipEvent_reason_required: "why are people leaving" is the single most
 * useful number this table can produce, and an optional field on a counter form
 * is an empty field.
 *
 * Route 25 (withdrawal) takes no body at all, so there is no DTO for it —
 * `forbidNonWhitelisted` means a DELETE with a body would 400 anyway.
 */
export class RequestCancellationDto {
  @IsString()
  @Length(3, 200)
  reason!: string;
}

/**
 * Route 28 — the owner terminating a membership outright, mid-term, with the
 * term's remaining days forfeited. Dangerous, hence `confirm`.
 *
 * The reason is mandatory here in three places at once: this DTO, the service,
 * and MembershipEvent_reason_required's `length(btrim(reason)) >= 3`. The
 * bounds are identical in all three so no input the pipe accepts can be
 * rejected by the database.
 */
export class CancelMembershipDto extends ConfirmDto {
  @IsString()
  @Length(3, 200)
  reason!: string;
}
```

- [ ] **Step 4: Write the adjust and correct DTOs**

```typescript
// server/src/membership/dto/adjust-term.dto.ts
import { IsEnum, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { MembershipStatus } from '@got/shared';
import type { CivilDate } from '../../common/time/gym-time';
import { IsGymDate } from '../../common/validators/is-gym-date.validator';
import { ConfirmDto } from '../../common/dto/confirm.dto';

/**
 * Route 29 — §5.5.2 row 16. Comp days: goodwill, staff error, a closure applied
 * to one member rather than the whole base (that is route 32).
 *
 * POSITIVE ONLY, 1..60. §7.7 says "±1–30" and §5.5.2 says "1 ≤ n ≤ 60"; task
 * 15's ExtendAllDto already fixed 1..60 as the shared bound, and one direction
 * per route is what makes the ledger readable. Taking days away is not a comp,
 * it is a correction of a data error, and it goes through route 30 under
 * membership.status.correct — the dangerous key that already permits arbitrary
 * dates and demands a reason for them.
 */
export class AdjustTermDto extends ConfirmDto {
  @IsInt()
  @Min(1)
  @Max(60)
  days!: number;

  /** Matches MembershipEvent_reason_required's `length(btrim(reason)) >= 3`. */
  @IsString()
  @Length(3, 200)
  reason!: string;
}

/**
 * Route 30 — §5.5.2 row 17. The escape hatch: an admin correcting a row that is
 * simply wrong, and the ONE caller permitted to bypass assertTransition.
 *
 * Every field is optional and the service refuses a request that supplies none
 * of them: a correction that changes nothing is an audit-log entry pretending
 * to be an action.
 *
 * `cancelledOn` is deliberately NOT a field. Membership_cancel_shape makes
 * status = CANCELLED and cancelledOn IS NOT NULL biconditional, so the service
 * derives it from `status` and the pair can never be made to disagree by a
 * typo in a JSON body.
 */
export class CorrectMembershipDto extends ConfirmDto {
  @IsOptional()
  @IsEnum(MembershipStatus)
  status?: MembershipStatus;

  @IsOptional()
  @IsGymDate()
  startsOn?: CivilDate;

  @IsOptional()
  @IsGymDate()
  endsOn?: CivilDate;

  /** Membership_anchor_valid's bounds, exactly. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  billingAnchorDay?: number;

  @IsString()
  @Length(3, 200)
  reason!: string;
}
```

- [ ] **Step 5: Write MembershipLifecycleService**

```typescript
// server/src/membership/membership-lifecycle.service.ts
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { MembershipEventType, MembershipStatus } from '@prisma/client';
import { MembershipStatus as SharedStatus } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { DomainException } from '../common/exceptions/domain.exception';
import { assertConfirmed } from '../common/dto/confirm.dto';
import {
  addDays,
  asCivilDate,
  civilDateFromPrisma,
  gymToday,
  toDateColumn,
  type CivilDate,
} from '../common/time/gym-time';
import type { AuthUser } from '../auth/auth.types';
import { MembershipService } from './membership.service';
import { MembershipHoldsService } from './membership-holds.service';
import { assertTransition, TRANSITION_BYPASS_REASON_REQUIRED } from './membership-transitions';
import { writeMembershipEvent } from './membership-events';
import type { MembershipDetail } from './membership.presenter';
import type {
  CancelMembershipDto,
  RequestCancellationDto,
} from './dto/cancellation.dto';
import type { AdjustTermDto, CorrectMembershipDto } from './dto/adjust-term.dto';

/**
 * Transitions 5, 6, 13, 16 and 17 — everything that changes a membership
 * without money changing hands.
 *
 * Four of the five call assertTransition at the top. The fifth, `correct()`,
 * is the ONE documented bypass (§5.5.3), and it pays for that with a mandatory
 * reason enforced in three places: the DTO, this service, and
 * MembershipEvent_reason_required.
 *
 * Notice and termination are deliberately different operations on different
 * keys. Notice is counter work (membership.cancel.request, FRONT_DESK) and
 * leaves the row ACTIVE with its term intact; termination forfeits the
 * remaining days and belongs to the owner (membership.cancel, ADMIN,
 * dangerous). Collapsing them would put "you lose the rest of the month" in the
 * hands of whoever is on the desk at 19:00.
 *
 * Prisma's generated enums are literal unions and @got/shared's are TS enums:
 * same strings, different nominal types, so assertTransition takes one cast at
 * the boundary and the database writes use the Prisma values.
 */
@Injectable()
export class MembershipLifecycleService {
  private readonly logger = new Logger(MembershipLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly memberships: MembershipService,
    private readonly holds: MembershipHoldsService,
  ) {}

  /** Route 24 — §5.5.2 row 5. */
  async requestCancellation(
    actor: AuthUser,
    membershipId: string,
    dto: RequestCancellationDto,
    now: Date,
  ): Promise<MembershipDetail> {
    const today = gymToday(now, this.gym.timeZone);

    return this.prisma.$transaction(async (tx) => {
      const membership = await this.memberships.loadForUpdate(tx, membershipId);

      if (membership.status === MembershipStatus.CANCELLED) {
        throw new DomainException(
          'MEMBERSHIP_ALREADY_CANCELLED',
          'This membership is already cancelled — there is nothing left to give notice on.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (membership.status !== MembershipStatus.ACTIVE) {
        throw new DomainException(
          'MEMBERSHIP_NOT_ACTIVE',
          `A ${membership.status} membership has no running term to give notice on.`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      assertTransition(SharedStatus.ACTIVE, SharedStatus.ACTIVE);

      // Guarded UPDATE rather than a second refusal: a member who says "I'm
      // cancelling" twice at the counter has not made an error, and a 422 for
      // it would train staff to click through errors. The guard is what makes
      // the second call write no second event.
      const claimed = await tx.membership.updateMany({
        where: { id: membershipId, status: MembershipStatus.ACTIVE, cancelRequestedOn: null },
        data: { cancelRequestedOn: toDateColumn(today) },
      });

      if (claimed.count === 1) {
        await writeMembershipEvent(tx, {
          membershipId,
          type: MembershipEventType.CANCELLATION_REQUESTED,
          fromStatus: MembershipStatus.ACTIVE,
          toStatus: MembershipStatus.ACTIVE,
          // The term does not move: notice is honoured to its end.
          previousEndsOn: null,
          newEndsOn: null,
          reason: dto.reason,
          actorId: actor.id,
          paymentId: null,
          batchRef: null,
          effectiveAt: now,
        });
        this.logger.log(`notice membership=${membershipId} on=${today} actor=${actor.id}`);
      }

      return this.memberships.detailById(tx, membershipId, now);
    });
  }

  /** Route 25 — §5.5.2 row 6. */
  async withdrawCancellation(
    actor: AuthUser,
    membershipId: string,
    now: Date,
  ): Promise<MembershipDetail> {
    const today = gymToday(now, this.gym.timeZone);

    return this.prisma.$transaction(async (tx) => {
      const membership = await this.memberships.loadForUpdate(tx, membershipId);
      const endsOn = civilDateFromPrisma(membership.endsOn);

      // Three ways there is nothing to withdraw, one code. Row 6 is "notice
      // withdrawn BEFORE endsOn": once the term has run out the nightly job has
      // either already flipped the row to CANCELLED or is about to, and
      // un-cancelling is a reactivation (route 23), not a withdrawal.
      if (
        membership.status !== MembershipStatus.ACTIVE ||
        membership.cancelRequestedOn === null ||
        today > endsOn
      ) {
        throw new DomainException(
          'MEMBERSHIP_INVALID_TRANSITION',
          'There is no notice on a running term to withdraw. Reactivate by renewing instead.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      assertTransition(SharedStatus.ACTIVE, SharedStatus.ACTIVE);

      await tx.membership.update({
        where: { id: membershipId },
        data: { cancelRequestedOn: null },
      });

      await writeMembershipEvent(tx, {
        membershipId,
        type: MembershipEventType.CANCELLATION_WITHDRAWN,
        fromStatus: MembershipStatus.ACTIVE,
        toStatus: MembershipStatus.ACTIVE,
        previousEndsOn: null,
        newEndsOn: null,
        reason: 'notice withdrawn',
        actorId: actor.id,
        paymentId: null,
        batchRef: null,
        effectiveAt: now,
      });

      this.logger.log(`notice withdrawn membership=${membershipId} actor=${actor.id}`);
      return this.memberships.detailById(tx, membershipId, now);
    });
  }

  /** Route 28 — §5.5.2 rows 13 and 10. */
  async cancel(
    actor: AuthUser,
    membershipId: string,
    dto: CancelMembershipDto,
    now: Date,
  ): Promise<MembershipDetail> {
    assertConfirmed(dto);
    const today = gymToday(now, this.gym.timeZone);

    return this.prisma.$transaction(async (tx) => {
      const membership = await this.memberships.loadForUpdate(tx, membershipId);

      if (membership.status === MembershipStatus.CANCELLED) {
        throw new DomainException(
          'MEMBERSHIP_ALREADY_CANCELLED',
          'This membership is already cancelled.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      assertTransition(
        membership.status as unknown as SharedStatus,
        SharedStatus.CANCELLED,
      );

      // Row 10: the claw-back runs FIRST and owns both the arithmetic and its
      // HOLD_RELEASED entry, so the terminate-during-freeze path produces the
      // identical ledger to an early release. A second copy of
      // `endsOn -= unused` here is the exact bug §5.6.2 is written to prevent.
      if (membership.status === MembershipStatus.FROZEN) {
        await this.holds.clawBackInTx(tx, membershipId, today, now, actor.id);
      }

      await tx.membership.update({
        where: { id: membershipId },
        data: {
          status: MembershipStatus.CANCELLED,
          // Membership_cancel_shape is biconditional: this column and the
          // status are set together or not at all.
          cancelledOn: toDateColumn(today),
          // endsOn is left exactly where it was. It is history — "what did they
          // pay for" must still be answerable after a termination.
        },
      });

      await writeMembershipEvent(tx, {
        membershipId,
        type: MembershipEventType.CANCELLED,
        fromStatus: membership.status,
        toStatus: MembershipStatus.CANCELLED,
        previousEndsOn: null,
        newEndsOn: null,
        // Mandatory for CANCELLED (§5.8.4). The DTO already enforces the same
        // bound; this is the value the CHECK will see.
        reason: dto.reason,
        actorId: actor.id,
        paymentId: null,
        batchRef: null,
        effectiveAt: now,
      });

      this.logger.log(
        `terminated membership=${membershipId} from=${membership.status} on=${today} ` +
          `actor=${actor.id}`,
      );
      return this.memberships.detailById(tx, membershipId, now);
    });
  }

  /** Route 29 — §5.5.2 row 16. */
  async adjustTerm(
    actor: AuthUser,
    membershipId: string,
    dto: AdjustTermDto,
    now: Date,
  ): Promise<MembershipDetail> {
    assertConfirmed(dto);

    return this.prisma.$transaction(async (tx) => {
      const membership = await this.memberships.loadForUpdate(tx, membershipId);

      // Row 16 applies to ACTIVE, EXPIRED and FROZEN and leaves the status
      // where it is. CANCELLED -> CANCELLED is not in the table, so a comp on a
      // terminated membership is refused here with no extra branch: there is no
      // term to extend, and reactivating is a sale.
      assertTransition(
        membership.status as unknown as SharedStatus,
        membership.status as unknown as SharedStatus,
      );

      const previousEndsOn = civilDateFromPrisma(membership.endsOn);
      const newEndsOn = addDays(previousEndsOn, dto.days);

      await tx.membership.update({
        where: { id: membershipId },
        data: { endsOn: toDateColumn(newEndsOn) },
      });

      await writeMembershipEvent(tx, {
        membershipId,
        type: MembershipEventType.ADJUSTED,
        fromStatus: membership.status,
        toStatus: membership.status,
        previousEndsOn,
        newEndsOn,
        reason: dto.reason,
        actorId: actor.id,
        paymentId: null,
        // batchRef is set only by route 32's bulk closure credit, which is what
        // makes a re-run of THAT a no-op. A single comp has no batch.
        batchRef: null,
        effectiveAt: now,
      });

      this.logger.log(
        `comp membership=${membershipId} days=${dto.days} ${previousEndsOn}->${newEndsOn} ` +
          `actor=${actor.id}`,
      );
      return this.memberships.detailById(tx, membershipId, now);
    });
  }

  /** Route 30 — §5.5.2 row 17. The one bypass. */
  async correct(
    actor: AuthUser,
    membershipId: string,
    dto: CorrectMembershipDto,
    now: Date,
  ): Promise<MembershipDetail> {
    assertConfirmed(dto);
    const today = gymToday(now, this.gym.timeZone);

    // membership.status.correct is the ONLY caller permitted to skip
    // assertTransition. The constant is imported and read rather than the call
    // merely omitted, so a reader who greps TRANSITION_BYPASS_REASON_REQUIRED
    // lands here and finds the reason being enforced instead of finding
    // nothing at all.
    const reason = dto.reason.trim();
    if (TRANSITION_BYPASS_REASON_REQUIRED && reason.length < 3) {
      throw new DomainException(
        'MEMBERSHIP_STATE_INVALID',
        'A status correction bypasses the transition table and requires a reason.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const nothingSupplied =
      dto.status === undefined &&
      dto.startsOn === undefined &&
      dto.endsOn === undefined &&
      dto.billingAnchorDay === undefined;
    if (nothingSupplied) {
      throw new DomainException(
        'MEMBERSHIP_STATE_INVALID',
        'A correction must change at least one of status, startsOn, endsOn or billingAnchorDay.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const membership = await this.memberships.loadForUpdate(tx, membershipId);

      const previousEndsOn = civilDateFromPrisma(membership.endsOn);
      // asCivilDate, not the raw DTO string: IsGymDate checks the shape and
      // this checks the calendar, so '2026-02-31' is refused before it reaches
      // a @db.Date column.
      const startsOn: CivilDate =
        dto.startsOn === undefined
          ? civilDateFromPrisma(membership.startsOn)
          : asCivilDate(dto.startsOn);
      const endsOn: CivilDate =
        dto.endsOn === undefined ? previousEndsOn : asCivilDate(dto.endsOn);

      // Membership_dates_ordered, checked here so the desk gets a sentence
      // rather than a constraint name.
      if (endsOn < startsOn) {
        throw new DomainException(
          'MEMBERSHIP_STATE_INVALID',
          `endsOn ${endsOn} precedes startsOn ${startsOn}.`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      const status =
        dto.status === undefined
          ? membership.status
          : (dto.status as unknown as MembershipStatus);
      const cancelling = status === MembershipStatus.CANCELLED;

      await tx.membership.update({
        where: { id: membershipId },
        data: {
          status,
          startsOn: toDateColumn(startsOn),
          endsOn: toDateColumn(endsOn),
          billingAnchorDay: dto.billingAnchorDay ?? membership.billingAnchorDay,
          // Derived, never taken from the body: Membership_cancel_shape is
          // biconditional and this is the only way the pair cannot disagree.
          // A correction INTO cancelled that already had a date keeps it.
          cancelledOn: cancelling
            ? (membership.cancelledOn ?? toDateColumn(today))
            : null,
          // A row corrected off CANCELLED still carries the notice that led
          // there, and that notice is now wrong too.
          cancelRequestedOn: cancelling ? membership.cancelRequestedOn : null,
        },
      });

      const moved = endsOn !== previousEndsOn || dto.endsOn !== undefined;

      await writeMembershipEvent(tx, {
        membershipId,
        type: MembershipEventType.STATUS_CORRECTED,
        fromStatus: membership.status,
        toStatus: status,
        // MembershipEvent_dates_paired: both or neither. Before and after go in
        // the date columns whenever endsOn was part of the correction.
        previousEndsOn: moved ? previousEndsOn : null,
        newEndsOn: moved ? endsOn : null,
        reason,
        actorId: actor.id,
        paymentId: null,
        batchRef: null,
        effectiveAt: now,
      });

      this.logger.warn(
        `CORRECTED membership=${membershipId} ${membership.status}->${status} ` +
          `term=${startsOn}..${endsOn} actor=${actor.id} reason="${reason}"`,
      );
      return this.memberships.detailById(tx, membershipId, now);
    });
  }
}
```

- [ ] **Step 6: Wire routes 24, 25, 28, 29 and 30 and register the provider**

```typescript
// server/src/membership/memberships.controller.ts — extend the imports, the
// constructor and append these five routes after the renew route task 12 added.
//
// import { Delete } from '@nestjs/common';
// import { MembershipLifecycleService } from './membership-lifecycle.service';
// import { RequestCancellationDto, CancelMembershipDto } from './dto/cancellation.dto';
// import { AdjustTermDto, CorrectMembershipDto } from './dto/adjust-term.dto';
//
//   constructor(
//     private readonly memberships: MembershipService,
//     private readonly sales: MembershipSalesService,
//     private readonly lifecycle: MembershipLifecycleService,   // ← added by this task
//   ) {}

  /** Route 24. FRONT_DESK holds this key: taking notice is counter work. */
  @Post(':id/cancel-request')
  @RequirePermission('membership.cancel.request')
  async requestCancellation(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RequestCancellationDto,
  ): Promise<MembershipDetail> {
    return this.lifecycle.requestCancellation(user, id, dto, new Date());
  }

  /** Route 25. No body: `forbidNonWhitelisted` would 400 one anyway. */
  @Delete(':id/cancel-request')
  @RequirePermission('membership.cancel.request')
  async withdrawCancellation(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<MembershipDetail> {
    return this.lifecycle.withdrawCancellation(user, id, new Date());
  }

  /** Route 28. Dangerous, ADMIN only — this forfeits the rest of a paid term. */
  @Post(':id/cancel')
  @RequirePermission('membership.cancel')
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CancelMembershipDto,
  ): Promise<MembershipDetail> {
    return this.lifecycle.cancel(user, id, dto, new Date());
  }

  /** Route 29. Comp days, 1..60, positive only. */
  @Post(':id/adjust-term')
  @RequirePermission('membership.term.adjust')
  async adjustTerm(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: AdjustTermDto,
  ): Promise<MembershipDetail> {
    return this.lifecycle.adjustTerm(user, id, dto, new Date());
  }

  /** Route 30. The documented bypass of the transition table. */
  @Post(':id/correct')
  @RequirePermission('membership.status.correct')
  async correct(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CorrectMembershipDto,
  ): Promise<MembershipDetail> {
    return this.lifecycle.correct(user, id, dto, new Date());
  }
```

```typescript
// server/src/membership/membership.module.ts — add the provider.
// MembershipHoldsService is already in `providers` from task 14; this service
// injects it for the terminate-during-freeze claw-back (row 10).
//
//   providers: [..., MembershipLifecycleService],
```

- [ ] **Step 7: Run the e2e and watch it pass**

Run: `npm run test:e2e --workspace=server -- memberships`
Expected: PASS — fourteen new cases green, including `['HOLD_RELEASED', 'CANCELLED']` in that order on the frozen termination, the repeat notice writing exactly one `CANCELLATION_REQUESTED`, and the `EXPIRED → FROZEN` correction succeeding where every other route refuses it.

- [ ] **Step 8: Run the whole server suite and typecheck**

Run: `npm test --workspace=server && npm run typecheck --workspace=server`
Expected: PASS — no unit suite regressions, typecheck exits 0. `npm run lint` remains red with its ~19–27 pre-existing problems; do not fix them here.

- [ ] **Step 9: Commit**

```bash
git add server/src/membership/membership-lifecycle.service.ts \
        server/src/membership/dto/cancellation.dto.ts \
        server/src/membership/dto/adjust-term.dto.ts \
        server/src/membership/memberships.controller.ts \
        server/src/membership/membership.module.ts \
        server/test/memberships.e2e-spec.ts
git commit -m "feat(membership): notice, termination, comp days and admin correction (routes 24-25, 28-30)

Transitions 5, 6, 13, 16 and 17. Notice is cancelRequestedOn on an otherwise
ACTIVE row and is counter work; termination forfeits the remaining days and is
ADMIN-only, dangerous and confirm-gated. Terminating during a freeze runs
MembershipHoldsService.clawBackInTx first, so row 10 writes HOLD_RELEASED then
CANCELLED and the arithmetic has exactly one implementation.

AdjustTermDto is 1..60 POSITIVE days, adjudicating §7.7's '±1-30' against
§5.5.2 row 16 and task 15's ExtendAllDto: a comp is a credit, and taking days
away is a correction under membership.status.correct.

correct() is the one documented bypass of assertTransition. It derives
cancelledOn from the target status rather than accepting it, so
Membership_cancel_shape cannot be made to disagree with the row."
```

---

### Task 14: Freeze — holds, claw-back and the freeze fee

**Files:**
- Create: `server/src/membership/membership-freeze-rules.ts`
- Create: `server/src/membership/membership-freeze-rules.spec.ts`
- Create: `server/src/membership/membership-holds.service.ts`
- Create: `server/src/membership/dto/freeze-membership.dto.ts`
- Modify: `server/src/membership/memberships.controller.ts` (created in task 11, extended in tasks 12–13 — add `MembershipHoldsService` to the constructor and append routes 26 and 27 after the `cancel-request` pair)
- Modify: `server/src/membership/membership.module.ts` (created in task 11 — add `MembershipHoldsService` to `providers` and to `exports`, because task 16's nightly job calls its tx helpers)
- Test: `server/src/membership/membership-freeze-rules.spec.ts`
- Test: `server/test/memberships.e2e-spec.ts` (created in task 12 — append the `freeze / unfreeze` describe)

**Interfaces:**
- Consumes: `@prisma/client`: `MembershipHold`, `HoldStatus` (task 6) · `server/src/membership/membership-terms.ts`: `holdDaysRequested`, `holdStartDelta`, `holdClawBackDelta`, `holdCompleteDelta`, `HoldDelta` (task 3) · `server/src/membership/membership-transitions.ts`: `assertTransition` (task 5) · `server/src/membership/membership-events.ts`: `writeMembershipEvent` (task 11) · `server/src/membership/membership.service.ts`: `loadForUpdate`, `detailById` (task 11) · `server/src/payments/payments.service.ts`: `PaymentsService.createInTx` (purpose `FREEZE_FEE`) (task 10); `ShiftsService.requireOpenShiftId` (task 9) · `GymConfigService.freezeMinDays`, `.freezeMaxDays`, `.freezeAnnualCapDays`, `.freezeFeeCentavos`, `.timeZone` (task 2) · permission key `membership.freeze` — ADMIN only, deliberately not `FRONT_DESK` (task 2)
- Produces: `FreezeConfig`, `FreezeRequest`, `assertFreezeAllowed(request, cfg)` throwing `PLAN_NOT_FREEZABLE`, `MEMBERSHIP_NOT_ACTIVE`, `FREEZE_ALREADY_USED_THIS_TERM`, `FREEZE_WINDOW_INVALID`, `MEMBERSHIP_FREEZE_LIMIT`, all at 422 · `FreezeMembershipDto`, `UnfreezeMembershipDto` · `MembershipHoldsService { freeze, unfreeze, activateHoldInTx, completeHoldInTx, clawBackInTx }`

---

- [ ] **Step 1: Write the failing test for the pure freeze-eligibility rules**

```typescript
// server/src/membership/membership-freeze-rules.spec.ts
import { HttpStatus } from '@nestjs/common';
import { MembershipStatus } from '@got/shared';
import { asCivilDate } from '../common/time/gym-time';
import { DomainException } from '../common/exceptions/domain.exception';
import { assertFreezeAllowed, type FreezeConfig, type FreezeRequest } from './membership-freeze-rules';

const CFG: FreezeConfig = { minDays: 7, maxDays: 90, annualCapDays: 90 };
const TODAY = asCivilDate('2026-08-19');

function request(overrides: Partial<FreezeRequest> = {}): FreezeRequest {
  return {
    status: MembershipStatus.ACTIVE,
    planFreezable: true,
    freezesUsedThisTerm: 0,
    startsOn: asCivilDate('2026-09-01'),
    endsOn: asCivilDate('2026-09-14'),
    today: TODAY,
    rollingHoldDaysLast365: 0,
    ...overrides,
  };
}

function codeOf(run: () => void): { code: string; status: number } {
  try {
    run();
  } catch (error) {
    if (!(error instanceof DomainException)) throw error;
    return { code: error.code, status: error.getStatus() };
  }
  throw new Error('expected assertFreezeAllowed to throw');
}

describe('assertFreezeAllowed', () => {
  it('accepts a 14-day hold on a freezable ACTIVE membership', () => {
    expect(() => assertFreezeAllowed(request(), CFG)).not.toThrow();
  });

  it('accepts the exact minimum and the exact maximum window', () => {
    expect(() =>
      assertFreezeAllowed(
        request({ startsOn: asCivilDate('2026-09-01'), endsOn: asCivilDate('2026-09-07') }),
        CFG,
      ),
    ).not.toThrow();
    expect(() =>
      assertFreezeAllowed(
        request({ startsOn: asCivilDate('2026-09-01'), endsOn: asCivilDate('2026-11-29') }),
        CFG,
      ),
    ).not.toThrow();
  });

  it('refuses a non-freezable plan — Monthly renews later instead', () => {
    expect(codeOf(() => assertFreezeAllowed(request({ planFreezable: false }), CFG))).toEqual({
      code: 'PLAN_NOT_FREEZABLE',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
  });

  it.each([MembershipStatus.EXPIRED, MembershipStatus.CANCELLED, MembershipStatus.FROZEN])(
    'refuses a %s membership: you cannot pause a term you have not paid for',
    (status) => {
      expect(codeOf(() => assertFreezeAllowed(request({ status }), CFG)).code).toBe(
        'MEMBERSHIP_NOT_ACTIVE',
      );
    },
  );

  it('refuses a second freeze in one term', () => {
    expect(codeOf(() => assertFreezeAllowed(request({ freezesUsedThisTerm: 1 }), CFG)).code).toBe(
      'FREEZE_ALREADY_USED_THIS_TERM',
    );
  });

  it('refuses a backdated hold — a backdated freeze is a refund with no audit trail', () => {
    expect(
      codeOf(() =>
        assertFreezeAllowed(
          request({ startsOn: asCivilDate('2026-08-18'), endsOn: asCivilDate('2026-09-01') }),
          CFG,
        ),
      ).code,
    ).toBe('FREEZE_WINDOW_INVALID');
  });

  it('accepts a hold scheduled exactly 60 days out and refuses 61', () => {
    expect(() =>
      assertFreezeAllowed(
        request({ startsOn: asCivilDate('2026-10-18'), endsOn: asCivilDate('2026-10-31') }),
        CFG,
      ),
    ).not.toThrow();
    expect(
      codeOf(() =>
        assertFreezeAllowed(
          request({ startsOn: asCivilDate('2026-10-19'), endsOn: asCivilDate('2026-11-01') }),
          CFG,
        ),
      ).code,
    ).toBe('FREEZE_WINDOW_INVALID');
  });

  it('refuses 6 days and 91 days', () => {
    expect(
      codeOf(() =>
        assertFreezeAllowed(
          request({ startsOn: asCivilDate('2026-09-01'), endsOn: asCivilDate('2026-09-06') }),
          CFG,
        ),
      ).code,
    ).toBe('FREEZE_WINDOW_INVALID');
    expect(
      codeOf(() =>
        assertFreezeAllowed(
          request({ startsOn: asCivilDate('2026-09-01'), endsOn: asCivilDate('2026-11-30') }),
          CFG,
        ),
      ).code,
    ).toBe('FREEZE_WINDOW_INVALID');
  });

  it('refuses when the rolling 365-day cap would be exceeded, counting this request', () => {
    expect(() => assertFreezeAllowed(request({ rollingHoldDaysLast365: 76 }), CFG)).not.toThrow();
    expect(codeOf(() => assertFreezeAllowed(request({ rollingHoldDaysLast365: 77 }), CFG))).toEqual({
      code: 'MEMBERSHIP_FREEZE_LIMIT',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm test --workspace=server -- membership-freeze-rules`
Expected: FAIL — `Cannot find module './membership-freeze-rules' from 'src/membership/membership-freeze-rules.spec.ts'`

- [ ] **Step 3: Write the pure rules module**

```typescript
// server/src/membership/membership-freeze-rules.ts
import { HttpStatus } from '@nestjs/common';
import { MembershipStatus } from '@got/shared';
import { DomainException } from '../common/exceptions/domain.exception';
import { addDays, civilDaysBetween, type CivilDate } from '../common/time/gym-time';

/**
 * §5.6's eligibility table, as one pure assertion.
 *
 * No clock, no Prisma, no GymConfigService: `today` is an argument and every
 * bound arrives on `cfg`, so the whole table is testable without a fixture and
 * the service keeps the loading. A reviewer who sees `new Date()` or `this.gym.`
 * in this file should reject the change.
 */

/** Members phone ahead before travelling; beyond this it is a cancellation. */
export const FREEZE_MAX_LEAD_DAYS = 60;

export interface FreezeConfig {
  minDays: number;
  maxDays: number;
  annualCapDays: number;
}

export interface FreezeRequest {
  status: MembershipStatus;
  planFreezable: boolean;
  freezesUsedThisTerm: number;
  /** The requested hold window, inclusive. */
  startsOn: CivilDate;
  endsOn: CivilDate;
  today: CivilDate;
  /** Days already held across holds overlapping [today − 365, today]. */
  rollingHoldDaysLast365: number;
}

export function assertFreezeAllowed(request: FreezeRequest, cfg: FreezeConfig): void {
  if (!request.planFreezable) {
    throw new DomainException(
      'PLAN_NOT_FREEZABLE',
      'This plan cannot be frozen. A monthly member simply renews later.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  if (request.status !== MembershipStatus.ACTIVE) {
    throw new DomainException(
      'MEMBERSHIP_NOT_ACTIVE',
      `A ${request.status} membership cannot be frozen — freeze is a benefit of a current term.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  if (request.freezesUsedThisTerm > 0) {
    throw new DomainException(
      'FREEZE_ALREADY_USED_THIS_TERM',
      'This term has already used its one freeze.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  if (request.startsOn < request.today) {
    throw new DomainException(
      'FREEZE_WINDOW_INVALID',
      'A freeze cannot be backdated. Use comp days for a past absence.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  if (request.startsOn > addDays(request.today, FREEZE_MAX_LEAD_DAYS)) {
    throw new DomainException(
      'FREEZE_WINDOW_INVALID',
      `A freeze may be scheduled at most ${FREEZE_MAX_LEAD_DAYS} days ahead.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  const days = civilDaysBetween(request.startsOn, request.endsOn) + 1;
  if (days < cfg.minDays || days > cfg.maxDays) {
    throw new DomainException(
      'FREEZE_WINDOW_INVALID',
      `A freeze runs ${cfg.minDays}–${cfg.maxDays} days; this one is ${days}.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  if (request.rollingHoldDaysLast365 + days > cfg.annualCapDays) {
    throw new DomainException(
      'MEMBERSHIP_FREEZE_LIMIT',
      `That would total ${request.rollingHoldDaysLast365 + days} frozen days in 365; ` +
        `the cap is ${cfg.annualCapDays}.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm test --workspace=server -- membership-freeze-rules`
Expected: PASS — 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add server/src/membership/membership-freeze-rules.ts \
        server/src/membership/membership-freeze-rules.spec.ts
git commit -m "feat(membership): add pure freeze eligibility rules (spec 5.6)"
```

- [ ] **Step 6: Write the failing e2e for routes 26 and 27**

```typescript
// server/test/memberships.e2e-spec.ts — APPEND this describe to the file task 12 created.
describe('freeze / unfreeze (routes 26, 27)', () => {
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    plans = await seedPlansForTest(ctx.prisma);
    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    adminId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
    await openShift(ctx.prisma, adminId, TODAY);
  });

  it('applies a same-day freeze inside one transaction: status FROZEN and endsOn extended', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'QUARTERLY',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });

    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/freeze`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ startsOn: TODAY, endsOn: addDays(TODAY, 13), reason: 'travelling to Cebu' })
      .expect(200);

    expect(response.body.data.status).toBe('FROZEN');

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(civilDateFromPrisma(after.endsOn)).toBe(
      addDays(civilDateFromPrisma(before.endsOn), 14),
    );
    expect(after.freezesUsedThisTerm).toBe(1);

    const hold = await ctx.prisma.membershipHold.findFirstOrThrow({
      where: { membershipId: member.membershipId! },
    });
    expect(hold.status).toBe('ACTIVE');
    expect(hold.daysApplied).toBe(14);
    expect(hold.activeMembershipId).toBe(member.membershipId);

    const fee = await ctx.prisma.payment.findFirstOrThrow({
      where: { membershipId: member.membershipId!, purpose: 'FREEZE_FEE' },
    });
    expect(fee.netCentavos).toBe(10000);

    const events = await ctx.prisma.membershipEvent.findMany({
      where: { membershipId: member.membershipId!, type: 'HOLD_APPLIED' },
    });
    expect(events).toHaveLength(1);
  });

  it('leaves a future-dated hold SCHEDULED with no status change and no arithmetic', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'ANNUAL',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/freeze`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ startsOn: addDays(TODAY, 10), endsOn: addDays(TODAY, 24), reason: 'work abroad' })
      .expect(200);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('ACTIVE');
    expect(civilDateFromPrisma(after.endsOn)).toBe(civilDateFromPrisma(before.endsOn));

    const hold = await ctx.prisma.membershipHold.findFirstOrThrow({
      where: { membershipId: member.membershipId! },
    });
    expect(hold.status).toBe('SCHEDULED');
    expect(hold.daysApplied).toBe(0);
    expect(hold.activeMembershipId).toBeNull();
  });

  it('refuses a MONTHLY membership with 422 PLAN_NOT_FREEZABLE', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/freeze`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ startsOn: TODAY, endsOn: addDays(TODAY, 13), reason: 'travelling' })
      .expect(422);

    expect(response.body.error.code).toBe('PLAN_NOT_FREEZABLE');
  });

  it('waives the fee for a medical freeze', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'QUARTERLY',
      today: TODAY,
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/freeze`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        startsOn: TODAY,
        endsOn: addDays(TODAY, 20),
        reason: 'medical — knee surgery',
        feeWaived: true,
      })
      .expect(200);

    const fees = await ctx.prisma.payment.findMany({ where: { purpose: 'FREEZE_FEE' } });
    expect(fees).toHaveLength(0);
  });

  it('claws back exactly the unused days on an early release', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'QUARTERLY',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/freeze`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ startsOn: TODAY, endsOn: addDays(TODAY, 29), reason: 'travelling' })
      .expect(200);

    // Released on day one: 29 unused days remain (today..endsOn), 1 day consumed.
    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/unfreeze`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'came home early' })
      .expect(200);

    expect(response.body.data.status).toBe('ACTIVE');

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(civilDateFromPrisma(after.endsOn)).toBe(
      addDays(civilDateFromPrisma(before.endsOn), 1),
    );

    const hold = await ctx.prisma.membershipHold.findFirstOrThrow({
      where: { membershipId: member.membershipId! },
    });
    expect(hold.status).toBe('COMPLETED');
    expect(hold.daysApplied).toBe(1);
    expect(hold.activeMembershipId).toBeNull();
    expect(hold.releasedAt).not.toBeNull();
  });

  it('refuses a second freeze while one is running', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'FROZEN',
      planCode: 'QUARTERLY',
      today: TODAY,
    });

    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/freeze`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ startsOn: TODAY, endsOn: addDays(TODAY, 13), reason: 'again' })
      .expect(422);

    expect(response.body.error.code).toBe('MEMBERSHIP_NOT_ACTIVE');
  });

  it('refuses unfreeze on a membership that is not frozen', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'QUARTERLY',
      today: TODAY,
    });

    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/unfreeze`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(422);

    expect(response.body.error.code).toBe('MEMBERSHIP_NOT_FROZEN');
  });

  it('refuses FRONT_DESK: the "no" belongs to the owner, not the desk', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'QUARTERLY',
      today: TODAY,
    });
    const deskToken = await ctx.fixture.tokenFor('FRONT_DESK', {
      supabaseId: FIXTURE_IDS.FRONT_DESK,
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/freeze`)
      .set('Authorization', `Bearer ${deskToken}`)
      .send({ startsOn: TODAY, endsOn: addDays(TODAY, 13), reason: 'travelling' })
      .expect(403);
  });
});
```

- [ ] **Step 7: Run the e2e and watch it fail**

Run: `npm run test:e2e --workspace=server -- memberships`
Expected: FAIL — `expected 200 "OK", got 404 "Not Found"` on `POST /api/v1/memberships/:id/freeze` (the route does not exist yet).

- [ ] **Step 8: Write the freeze DTOs**

```typescript
// server/src/membership/dto/freeze-membership.dto.ts
import { IsBoolean, IsEnum, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { PaymentMethod } from '@got/shared';
import type { CivilDate } from '../../common/time/gym-time';
import { IsGymDate } from '../../common/validators/is-gym-date.validator';

/**
 * `endsOn` is MANDATORY (§5.6): an open-ended freeze is a cancellation the
 * member never asked for, accruing silent liability.
 *
 * The fields are declared as CivilDate because that is what every consumer
 * takes, but the pipe hands over an unvalidated string — the service still runs
 * `asCivilDate()` on both, which is what rejects '2026-02-31'.
 */
export class FreezeMembershipDto {
  @IsGymDate()
  startsOn!: CivilDate;

  @IsGymDate()
  endsOn!: CivilDate;

  /** Matches MembershipEvent_reason_required's `length(btrim(...)) >= 3`. */
  @IsString()
  @Length(3, 200)
  reason!: string;

  /** Medical freezes are free (§5.6). Everything else pays the fee. */
  @IsOptional()
  @IsBoolean()
  feeWaived?: boolean;

  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  receiptNo?: string;
}

export class UnfreezeMembershipDto {
  @IsOptional()
  @IsString()
  @Length(3, 200)
  reason?: string;
}
```

- [ ] **Step 9: Write MembershipHoldsService**

```typescript
// server/src/membership/membership-holds.service.ts
import { HttpStatus, Injectable } from '@nestjs/common';
import {
  DiscountType,
  HoldStatus,
  MembershipEventType,
  MembershipStatus,
  PaymentMethod,
  PaymentPurpose,
  type Prisma,
} from '@prisma/client';
import { MembershipStatus as SharedStatus } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { DomainException } from '../common/exceptions/domain.exception';
import { hashRequestBody } from '../common/idempotency/request-hash';
import {
  addDays,
  asCivilDate,
  civilDateFromPrisma,
  gymToday,
  toDateColumn,
  type CivilDate,
} from '../common/time/gym-time';
import type { AuthUser } from '../auth/auth.types';
import { PaymentsService } from '../payments/payments.service';
import { ShiftsService } from '../payments/shifts.service';
import { MembershipService } from './membership.service';
import { assertTransition } from './membership-transitions';
import { assertFreezeAllowed } from './membership-freeze-rules';
import { writeMembershipEvent } from './membership-events';
import {
  holdClawBackDelta,
  holdDaysRequested,
  holdStartDelta,
  type HoldDelta,
} from './membership-terms';
import type { MembershipDetail } from './membership.presenter';
import type { FreezeMembershipDto, UnfreezeMembershipDto } from './dto/freeze-membership.dto';

const MS_PER_DAY = 86_400_000;

/**
 * Transitions 7, 8, 9 and 10.
 *
 * The whole point of this file is that `endsOn += daysRequested` exists exactly
 * once (in `activateHoldInTx` and its same-day twin inside `freeze`) and
 * `endsOn -= unused` exists exactly once (in `clawBackInTx`). The nightly job
 * calls these helpers rather than reimplementing the arithmetic — a second copy
 * is precisely the bug §5.6.2 is written to prevent.
 *
 * Prisma's generated enums are literal unions and @got/shared's are TS enums:
 * same strings, different nominal types, so the pure helpers take one cast at
 * the boundary and the database writes use the Prisma values.
 */
@Injectable()
export class MembershipHoldsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly memberships: MembershipService,
    private readonly payments: PaymentsService,
    private readonly shifts: ShiftsService,
  ) {}

  async freeze(
    actor: AuthUser,
    membershipId: string,
    dto: FreezeMembershipDto,
    now: Date,
  ): Promise<MembershipDetail> {
    const today = gymToday(now, this.gym.timeZone);
    const startsOn = asCivilDate(dto.startsOn);
    const endsOn = asCivilDate(dto.endsOn);

    return this.prisma.$transaction(async (tx) => {
      const membership = await this.memberships.loadForUpdate(tx, membershipId);
      const plan = await tx.plan.findUniqueOrThrow({ where: { id: membership.planId } });

      assertFreezeAllowed(
        {
          status: membership.status as unknown as SharedStatus,
          planFreezable: plan.freezable,
          freezesUsedThisTerm: membership.freezesUsedThisTerm,
          startsOn,
          endsOn,
          today,
          rollingHoldDaysLast365: await this.rollingHoldDays(tx, membershipId, today),
        },
        {
          minDays: this.gym.freezeMinDays,
          maxDays: this.gym.freezeMaxDays,
          annualCapDays: this.gym.freezeAnnualCapDays,
        },
      );

      const daysRequested = holdDaysRequested(startsOn, endsOn);
      // §5.6.3: a same-day hold has no window. Deferring it to the nightly job
      // would bank the days while leaving the member ACTIVE — and therefore
      // admitted — for up to a full day. They would get both.
      const sameDay = startsOn === today;

      const hold = await tx.membershipHold.create({
        data: {
          membershipId,
          status: sameDay ? HoldStatus.ACTIVE : HoldStatus.SCHEDULED,
          startsOn: toDateColumn(startsOn),
          endsOn: toDateColumn(endsOn),
          daysRequested,
          daysApplied: sameDay ? daysRequested : 0,
          activeMembershipId: sameDay ? membershipId : null,
          reason: dto.reason,
          feeWaived: dto.feeWaived ?? false,
          approvedById: actor.id,
        },
      });

      if (sameDay) {
        assertTransition(membership.status as unknown as SharedStatus, SharedStatus.FROZEN);

        const previousEndsOn = civilDateFromPrisma(membership.endsOn);
        const newEndsOn = addDays(previousEndsOn, holdStartDelta(daysRequested).endsOnDaysDelta);

        await tx.membership.update({
          where: { id: membershipId },
          data: {
            status: MembershipStatus.FROZEN,
            endsOn: toDateColumn(newEndsOn),
            freezesUsedThisTerm: { increment: 1 },
          },
        });

        await writeMembershipEvent(tx, {
          membershipId,
          type: MembershipEventType.HOLD_APPLIED,
          fromStatus: membership.status,
          toStatus: MembershipStatus.FROZEN,
          previousEndsOn,
          newEndsOn,
          reason: dto.reason,
          actorId: actor.id,
          paymentId: null,
          batchRef: null,
          effectiveAt: now,
        });
      }

      if (!hold.feeWaived && this.gym.freezeFeeCentavos > 0) {
        const fee = this.gym.freezeFeeCentavos;
        const shiftId = await this.shifts.requireOpenShiftId(tx);

        await this.payments.createInTx(tx, {
          userId: membership.userId,
          membershipId,
          planId: membership.planId,
          planCode: membership.planCode,
          planName: membership.planName,
          purpose: PaymentPurpose.FREEZE_FEE,
          amounts: {
            grossCentavos: fee,
            vatBaseCentavos: fee,
            discountCentavos: 0,
            netCentavos: fee,
            vatExempt: false,
          },
          discountType: DiscountType.NONE,
          statutoryIdNo: null,
          discountReason: null,
          termMonths: null,
          termStartsOn: null,
          termEndsOn: null,
          method: dto.method ?? PaymentMethod.CASH,
          reference: dto.reference ?? null,
          receiptNo: dto.receiptNo ?? null,
          receivedAt: now,
          businessDate: today,
          shiftId,
          recordedById: actor.id,
          // The route carries no Idempotency-Key: the hold row is the claim, so
          // its id is the natural key for the fee it caused.
          idempotencyKey: `freeze:${hold.id}`,
          idempotencyHash: hashRequestBody({ holdId: hold.id, purpose: 'FREEZE_FEE', fee }),
          notes: null,
        });
      }

      return this.memberships.detailById(tx, membershipId, now);
    });
  }

  async unfreeze(
    actor: AuthUser,
    membershipId: string,
    dto: UnfreezeMembershipDto,
    now: Date,
  ): Promise<MembershipDetail> {
    const today = gymToday(now, this.gym.timeZone);

    return this.prisma.$transaction(async (tx) => {
      const membership = await this.memberships.loadForUpdate(tx, membershipId);
      if (membership.status !== MembershipStatus.FROZEN) {
        throw new DomainException(
          'MEMBERSHIP_NOT_FROZEN',
          'This membership is not frozen.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      // clawBackInTx owns the arithmetic AND the HOLD_RELEASED event, so the
      // cancel-during-freeze path (row 10) gets the identical ledger entry.
      const delta = await this.clawBackInTx(tx, membershipId, today, now, actor.id);
      if (delta === null) {
        throw new DomainException(
          'MEMBERSHIP_NOT_FROZEN',
          'No running hold to release.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      assertTransition(SharedStatus.FROZEN, SharedStatus.ACTIVE);
      await tx.membership.update({
        where: { id: membershipId },
        data: { status: MembershipStatus.ACTIVE },
      });

      return this.memberships.detailById(tx, membershipId, now);
    });
  }

  /**
   * Nightly step 2. Returns false unless the guarded UPDATE changed exactly one
   * row, so two workers cannot both apply one freeze.
   */
  async activateHoldInTx(
    tx: Prisma.TransactionClient,
    holdId: string,
    _today: CivilDate,
    effectiveAt: Date,
    actorId: string | null,
  ): Promise<boolean> {
    const hold = await tx.membershipHold.findUniqueOrThrow({ where: { id: holdId } });

    const claimed = await tx.membershipHold.updateMany({
      where: { id: holdId, status: HoldStatus.SCHEDULED },
      data: {
        status: HoldStatus.ACTIVE,
        activeMembershipId: hold.membershipId,
        daysApplied: hold.daysRequested,
      },
    });
    if (claimed.count !== 1) return false;

    const membership = await tx.membership.findUniqueOrThrow({ where: { id: hold.membershipId } });
    const previousEndsOn = civilDateFromPrisma(membership.endsOn);
    const newEndsOn = addDays(previousEndsOn, holdStartDelta(hold.daysRequested).endsOnDaysDelta);

    await tx.membership.update({
      where: { id: hold.membershipId },
      data: {
        status: MembershipStatus.FROZEN,
        endsOn: toDateColumn(newEndsOn),
        freezesUsedThisTerm: { increment: 1 },
      },
    });

    await writeMembershipEvent(tx, {
      membershipId: hold.membershipId,
      type: MembershipEventType.HOLD_APPLIED,
      fromStatus: membership.status,
      toStatus: MembershipStatus.FROZEN,
      previousEndsOn,
      newEndsOn,
      reason: hold.reason,
      actorId,
      paymentId: null,
      batchRef: null,
      effectiveAt,
    });

    return true;
  }

  /** Nightly step 1. Pure status flip — the extension was applied at start. */
  async completeHoldInTx(
    tx: Prisma.TransactionClient,
    holdId: string,
    _today: CivilDate,
    effectiveAt: Date,
    actorId: string | null,
  ): Promise<boolean> {
    const hold = await tx.membershipHold.findUniqueOrThrow({ where: { id: holdId } });

    const claimed = await tx.membershipHold.updateMany({
      where: { id: holdId, status: HoldStatus.ACTIVE },
      data: {
        status: HoldStatus.COMPLETED,
        activeMembershipId: null,
        releasedAt: effectiveAt,
        releasedById: actorId,
      },
    });
    if (claimed.count !== 1) return false;

    const membership = await tx.membership.findUniqueOrThrow({ where: { id: hold.membershipId } });
    await tx.membership.update({
      where: { id: hold.membershipId },
      data: { status: MembershipStatus.ACTIVE },
    });

    await writeMembershipEvent(tx, {
      membershipId: hold.membershipId,
      type: MembershipEventType.HOLD_RELEASED,
      fromStatus: membership.status,
      toStatus: MembershipStatus.ACTIVE,
      previousEndsOn: null,
      newEndsOn: null,
      reason: 'completed',
      actorId,
      paymentId: null,
      batchRef: null,
      effectiveAt,
    });

    return true;
  }

  /** Row 9's arithmetic, shared by unfreeze and by cancel-during-freeze. */
  async clawBackInTx(
    tx: Prisma.TransactionClient,
    membershipId: string,
    today: CivilDate,
    effectiveAt: Date,
    actorId: string | null,
  ): Promise<HoldDelta | null> {
    const hold = await tx.membershipHold.findUnique({
      where: { activeMembershipId: membershipId },
    });
    if (!hold) return null;

    const delta = holdClawBackDelta(
      { endsOn: civilDateFromPrisma(hold.endsOn), daysApplied: hold.daysApplied },
      today,
    );

    const claimed = await tx.membershipHold.updateMany({
      where: { id: hold.id, status: HoldStatus.ACTIVE },
      data: {
        status: HoldStatus.COMPLETED,
        activeMembershipId: null,
        releasedAt: effectiveAt,
        releasedById: actorId,
        daysApplied: { increment: delta.daysAppliedDelta },
      },
    });
    if (claimed.count !== 1) return null;

    const membership = await tx.membership.findUniqueOrThrow({ where: { id: membershipId } });
    const previousEndsOn = civilDateFromPrisma(membership.endsOn);
    const newEndsOn = addDays(previousEndsOn, delta.endsOnDaysDelta);

    await tx.membership.update({
      where: { id: membershipId },
      data: { endsOn: toDateColumn(newEndsOn) },
    });

    await writeMembershipEvent(tx, {
      membershipId,
      type: MembershipEventType.HOLD_RELEASED,
      fromStatus: MembershipStatus.FROZEN,
      toStatus: MembershipStatus.ACTIVE,
      previousEndsOn,
      newEndsOn,
      reason: 'early',
      actorId,
      paymentId: null,
      batchRef: null,
      effectiveAt,
    });

    return delta;
  }

  /** Days held across holds overlapping [today − 365, today], cancelled excluded. */
  private async rollingHoldDays(
    tx: Prisma.TransactionClient,
    membershipId: string,
    today: CivilDate,
  ): Promise<number> {
    const windowStart = new Date(toDateColumn(today).getTime() - 365 * MS_PER_DAY);
    const holds = await tx.membershipHold.findMany({
      where: {
        membershipId,
        status: { not: HoldStatus.CANCELLED },
        endsOn: { gte: windowStart },
      },
      select: { daysRequested: true },
    });
    return holds.reduce((total, hold) => total + hold.daysRequested, 0);
  }
}
```

- [ ] **Step 10: Wire routes 26 and 27 and register the provider**

```typescript
// server/src/membership/memberships.controller.ts — add to the constructor and append these routes.
//   constructor(
//     private readonly memberships: MembershipService,
//     private readonly sales: MembershipSalesService,
//     private readonly lifecycle: MembershipLifecycleService,
//     private readonly holds: MembershipHoldsService,   // ← added by this task
//   ) {}

  @Post(':id/freeze')
  @RequirePermission('membership.freeze')
  async freeze(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: FreezeMembershipDto,
  ): Promise<MembershipDetail> {
    return this.holds.freeze(user, id, dto, new Date());
  }

  @Post(':id/unfreeze')
  @RequirePermission('membership.freeze')
  async unfreeze(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UnfreezeMembershipDto,
  ): Promise<MembershipDetail> {
    return this.holds.unfreeze(user, id, dto, new Date());
  }
```

```typescript
// server/src/membership/membership.module.ts — add the provider and export it.
// The nightly job (task 16) calls activateHoldInTx / completeHoldInTx, so this
// service must leave the module rather than being re-implemented there.
//   providers: [..., MembershipHoldsService],
//   exports: [MembershipService, MembershipHoldsService],
```

- [ ] **Step 11: Run the e2e and watch it pass**

Run: `npm run test:e2e --workspace=server -- memberships`
Expected: PASS — including the eight new freeze/unfreeze cases.

- [ ] **Step 12: Commit**

```bash
git add server/src/membership/membership-holds.service.ts \
        server/src/membership/dto/freeze-membership.dto.ts \
        server/src/membership/memberships.controller.ts \
        server/src/membership/membership.module.ts \
        server/test/memberships.e2e-spec.ts
git commit -m "feat(membership): freeze, early release and the freeze fee (routes 26-27)"
```

---

### Task 15: Member import and bulk term extension

**Files:**
- Create: `server/src/membership/membership-import.service.ts`
- Create: `server/src/membership/dto/import-memberships.dto.ts`
- Create: `server/src/membership/admin-memberships.controller.ts`
- Modify: `server/src/membership/membership.module.ts` (created in task 11 — add `AdminMembershipsController` to `controllers` and `MembershipImportService` to `providers`)
- Test: `server/test/memberships.e2e-spec.ts` (created in task 12 — append the `admin import / extend` describe)

**Interfaces:**
- Consumes: `server/src/membership/membership-events.ts`: `writeMembershipEvent`, `writeMembershipEventIfNew` (task 11) · `server/src/membership/membership-terms.ts`: `termEndsOn` (task 3) · `server/src/users/member-code.util.ts`: `allocateMemberCode` (Chunk 0) · `server/src/catalogue/plans.service.ts`: `PlansService.requireSellable` (task 8) · `server/src/common/dto/confirm.dto.ts`: `ConfirmDto`, `assertConfirmed` (task 2) · permission keys `membership.import` and `membership.term.adjust` (task 2); `Idempotent()` · `DomainErrorCode 'MEMBER_ALREADY_IMPORTED'`
- Produces: `ImportMemberRowDto`, `ImportMembershipsDto`, `ExtendAllDto` · `ImportRowError`, `ImportResult` · `MembershipImportService { importMembers, extendAll }` — `importMembers` is idempotent on email (and on phone when email is absent, via a minted placeholder address), creates `User` + `memberCode` + `Membership` with `billingAnchorDay = DOM(startsOn)` and writes `MembershipEvent(IMPORTED)` with **no `Payment` row**; `extendAll` applies row 16 to every `ACTIVE` and `FROZEN` membership in one transaction, one `ADJUSTED` event each carrying `batchRef` through `writeMembershipEventIfNew`, so a re-run reports `affected: 0`

---

- [ ] **Step 1: Write the failing e2e for routes 31 and 32**

```typescript
// server/test/memberships.e2e-spec.ts — APPEND this describe.
describe('admin import / extend (routes 31, 32)', () => {
  const ROWS = [
    {
      email: 'juan.delacruz@example.ph',
      phone: '09171234567',
      firstName: 'Juan',
      lastName: 'Dela Cruz',
      planCode: 'MONTHLY',
      startsOn: '2026-08-01',
      endsOn: '2026-08-31',
      joinedOn: '2024-03-15',
    },
    {
      phone: '09189876543',
      firstName: 'Maria',
      lastName: 'Santos',
      planCode: 'QUARTERLY',
      startsOn: '2026-07-15',
      endsOn: '2026-10-14',
      joinedOn: '2025-01-20',
    },
  ];

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    plans = await seedPlansForTest(ctx.prisma);
    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    adminId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
  });

  it('creates a member, a memberCode and a membership with NO payment row', async () => {
    const response = await request(server)
      .post('/api/v1/admin/memberships/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '3f3d1a2c-0f0a-4a8e-9d31-000000000101')
      .send({ confirm: true, rows: ROWS })
      .expect(201);

    expect(response.body.data).toMatchObject({ created: 2, skipped: 0, errors: [] });

    const juan = await ctx.prisma.user.findUniqueOrThrow({
      where: { email: 'juan.delacruz@example.ph' },
      include: { membership: true },
    });
    expect(juan.memberCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(juan.phone).toBe('09171234567');
    expect(civilDateFromPrisma(juan.membership!.endsOn)).toBe('2026-08-31');
    expect(juan.membership!.billingAnchorDay).toBe(1);
    expect(civilDateFromPrisma(juan.membership!.joinedOn)).toBe('2024-03-15');

    expect(await ctx.prisma.payment.count()).toBe(0);

    const events = await ctx.prisma.membershipEvent.findMany({ where: { type: 'IMPORTED' } });
    expect(events).toHaveLength(2);
    expect(events[0].actorId).toBe(adminId);
  });

  it('is idempotent: re-importing the same payload creates nothing and writes no second event', async () => {
    await request(server)
      .post('/api/v1/admin/memberships/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '3f3d1a2c-0f0a-4a8e-9d31-000000000102')
      .send({ confirm: true, rows: ROWS })
      .expect(201);

    const replay = await request(server)
      .post('/api/v1/admin/memberships/import')
      .set('Authorization', `Bearer ${adminToken}`)
      // A DIFFERENT key, so this is a genuine second request, not a replay.
      .set('Idempotency-Key', '3f3d1a2c-0f0a-4a8e-9d31-000000000103')
      .send({ confirm: true, rows: ROWS })
      .expect(201);

    expect(replay.body.data).toMatchObject({ created: 0, skipped: 2 });
    expect(await ctx.prisma.membership.count()).toBe(2);
    expect(await ctx.prisma.membershipEvent.count({ where: { type: 'IMPORTED' } })).toBe(2);
  });

  it('reports a row that identifies nobody without failing the batch', async () => {
    const response = await request(server)
      .post('/api/v1/admin/memberships/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '3f3d1a2c-0f0a-4a8e-9d31-000000000104')
      .send({
        confirm: true,
        rows: [
          ROWS[0],
          {
            firstName: 'Ghost',
            lastName: 'Row',
            planCode: 'MONTHLY',
            startsOn: '2026-08-01',
            endsOn: '2026-08-31',
            joinedOn: '2026-08-01',
          },
        ],
      })
      .expect(201);

    expect(response.body.data.created).toBe(1);
    expect(response.body.data.errors).toEqual([
      { row: 2, email: null, phone: null, code: 'MEMBER_NOT_FOUND', message: expect.any(String) },
    ]);
  });

  it('refuses an unconfirmed import with 400 CONFIRMATION_REQUIRED', async () => {
    const response = await request(server)
      .post('/api/v1/admin/memberships/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '3f3d1a2c-0f0a-4a8e-9d31-000000000105')
      .send({ confirm: false, rows: ROWS })
      .expect(400);

    expect(response.body.error.code).toBe('CONFIRMATION_REQUIRED');
  });

  it('extends every ACTIVE and FROZEN membership once per batchRef', async () => {
    const active = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });
    const frozen = await makeMember(ctx.prisma, {
      state: 'FROZEN',
      planCode: 'QUARTERLY',
      today: TODAY,
    });
    const expired = await makeMember(ctx.prisma, {
      state: 'EXPIRED_PAST_GRACE',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    const before = await ctx.prisma.membership.findMany({ orderBy: { createdAt: 'asc' } });
    const body = {
      confirm: true,
      days: 3,
      reason: 'Typhoon Egay closure',
      batchRef: 'closure-2026-08-19',
    };

    const first = await request(server)
      .post('/api/v1/admin/memberships/extend')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '3f3d1a2c-0f0a-4a8e-9d31-000000000201')
      .send(body)
      .expect(201);
    expect(first.body.data).toEqual({ affected: 2 });

    const second = await request(server)
      .post('/api/v1/admin/memberships/extend')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '3f3d1a2c-0f0a-4a8e-9d31-000000000202')
      .send(body)
      .expect(201);
    expect(second.body.data).toEqual({ affected: 0 });

    const after = await ctx.prisma.membership.findMany({ orderBy: { createdAt: 'asc' } });
    const endsOnOf = (rows: typeof after, id: string): string =>
      civilDateFromPrisma(rows.find((row) => row.id === id)!.endsOn);

    expect(endsOnOf(after, active.membershipId!)).toBe(
      addDays(endsOnOf(before, active.membershipId!), 3),
    );
    expect(endsOnOf(after, frozen.membershipId!)).toBe(
      addDays(endsOnOf(before, frozen.membershipId!), 3),
    );
    expect(endsOnOf(after, expired.membershipId!)).toBe(
      endsOnOf(before, expired.membershipId!),
    );

    expect(
      await ctx.prisma.membershipEvent.count({
        where: { type: 'ADJUSTED', batchRef: 'closure-2026-08-19' },
      }),
    ).toBe(2);
  });
});
```

- [ ] **Step 2: Run the e2e and watch it fail**

Run: `npm run test:e2e --workspace=server -- memberships`
Expected: FAIL — `expected 201 "Created", got 404 "Not Found"` on `POST /api/v1/admin/memberships/import`

- [ ] **Step 3: Write the import DTOs**

```typescript
// server/src/membership/dto/import-memberships.dto.ts
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { CivilDate } from '../../common/time/gym-time';
import { IsGymDate } from '../../common/validators/is-gym-date.validator';
import { ConfirmDto } from '../../common/dto/confirm.dto';

/**
 * One notebook line. `email` and `phone` are both optional here and at least
 * one is required by the service, which reports the offending row rather than
 * 400-ing the whole 340-row batch — the operator needs the other 339 loaded.
 *
 * Nested rows need @Type AND @ValidateNested: with only one of them, whitelist
 * strips every row to {} and validation passes silently.
 */
export class ImportMemberRowDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[0-9+][0-9\s-]{6,19}$/, { message: 'phone must be a plausible PH number' })
  phone?: string;

  @IsString()
  @Length(1, 80)
  firstName!: string;

  @IsString()
  @Length(1, 80)
  lastName!: string;

  @IsString()
  @MaxLength(32)
  planCode!: string;

  @IsGymDate()
  startsOn!: CivilDate;

  @IsGymDate()
  endsOn!: CivilDate;

  @IsGymDate()
  joinedOn!: CivilDate;
}

export class ImportMembershipsDto extends ConfirmDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ImportMemberRowDto)
  rows!: ImportMemberRowDto[];
}

export class ExtendAllDto extends ConfirmDto {
  /** Row 16's bound, and the same range AdjustTermDto uses. */
  @IsInt()
  @Min(1)
  @Max(60)
  days!: number;

  @IsString()
  @Length(3, 200)
  reason!: string;

  /** The @@unique([membershipId, batchRef]) key that makes a re-run a no-op. */
  @IsString()
  @Length(3, 64)
  batchRef!: string;
}
```

- [ ] **Step 4: Write MembershipImportService**

```typescript
// server/src/membership/membership-import.service.ts
import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { MembershipEventType, MembershipStatus, Role, type Prisma } from '@prisma/client';
import type { DomainErrorCode } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { DomainException } from '../common/exceptions/domain.exception';
import { assertConfirmed } from '../common/dto/confirm.dto';
import {
  addDays,
  asCivilDate,
  civilDateFromPrisma,
  gymToday,
  toDateColumn,
} from '../common/time/gym-time';
import type { AuthUser } from '../auth/auth.types';
import { allocateMemberCode } from '../users/member-code.util';
import { PlansService } from '../catalogue/plans.service';
import { writeMembershipEvent, writeMembershipEventIfNew } from './membership-events';
import type { ImportMemberRowDto, ImportMembershipsDto, ExtendAllDto } from './dto/import-memberships.dto';

/** A 340-row batch is well past Prisma's 5s interactive default. */
const BULK_TRANSACTION_TIMEOUT_MS = 60_000;

export interface ImportRowError {
  row: number;
  email: string | null;
  phone: string | null;
  code: DomainErrorCode;
  message: string;
}

export interface ImportResult {
  created: number;
  skipped: number;
  errors: ImportRowError[];
}

/**
 * §5.5.4 and §5.5.5.
 *
 * This is the ONLY path in the system permitted to create a membership without
 * a Payment. Keying 340 notebook members as fresh sales would fabricate about
 * ₱270,000 of week-one revenue and reset every anniversary.
 *
 * Known, accepted gap: an imported User carries a minted `supabaseId`, because
 * that column is NOT NULL and the member has no auth account yet. Linking the
 * real Supabase account on first login belongs to the member console in Chunk 2;
 * until then a self-registration with the same email collides on User.email.
 */
@Injectable()
export class MembershipImportService {
  private readonly logger = new Logger(MembershipImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly plans: PlansService,
  ) {}

  async importMembers(
    actor: AuthUser,
    dto: ImportMembershipsDto,
    now: Date,
  ): Promise<ImportResult> {
    assertConfirmed(dto);

    let created = 0;
    let skipped = 0;
    const errors: ImportRowError[] = [];

    for (const [index, row] of dto.rows.entries()) {
      try {
        const outcome = await this.importRow(actor, row, now);
        if (outcome === 'created') created += 1;
        else skipped += 1;
      } catch (error) {
        if (!(error instanceof DomainException)) throw error;
        const body = error.getResponse() as { code: DomainErrorCode; message: string };
        errors.push({
          row: index + 1,
          email: row.email ?? null,
          phone: row.phone ?? null,
          code: body.code,
          message: body.message,
        });
      }
    }

    this.logger.log(
      `import actor=${actor.id} rows=${dto.rows.length} created=${created} ` +
        `skipped=${skipped} errors=${errors.length}`,
    );

    return { created, skipped, errors };
  }

  private async importRow(
    actor: AuthUser,
    row: ImportMemberRowDto,
    now: Date,
  ): Promise<'created' | 'skipped'> {
    // One identity key for both cases: when only a phone is on file, a
    // placeholder address is minted so User.email's unique index carries the
    // idempotency for the phone path too.
    const email = row.email
      ? row.email.trim().toLowerCase()
      : row.phone
        ? `${row.phone.replace(/\D/g, '')}@imported.gymofthrones.invalid`
        : null;

    if (email === null) {
      throw new DomainException(
        'MEMBER_NOT_FOUND',
        'This row has neither an email nor a phone, so it identifies no member.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const startsOn = asCivilDate(row.startsOn);
    const endsOn = asCivilDate(row.endsOn);
    const joinedOn = asCivilDate(row.joinedOn);
    if (endsOn < startsOn) {
      throw new DomainException(
        'MEMBERSHIP_STATE_INVALID',
        `endsOn ${endsOn} precedes startsOn ${startsOn}.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const plan = await this.plans.requireSellable(tx, row.planCode);

      // createMany + skipDuplicates, never catch-then-query: a caught P2002
      // aborts the transaction and every later statement dies with 25P02.
      const claim = await tx.user.createMany({
        data: [
          {
            supabaseId: randomUUID(),
            email,
            firstName: row.firstName,
            lastName: row.lastName,
            phone: row.phone ?? null,
            role: Role.CLIENT,
          },
        ],
        skipDuplicates: true,
      });

      const user = await tx.user.findUniqueOrThrow({
        where: { email },
        select: { id: true, memberCode: true },
      });

      if (claim.count === 0) {
        const existing = await tx.membership.findUnique({
          where: { userId: user.id },
          select: { id: true },
        });
        if (existing) return 'skipped';
      }

      if (!user.memberCode) {
        await allocateMemberCode(tx, user.id);
      }

      const membership = await tx.membership.create({
        data: {
          userId: user.id,
          planId: plan.id,
          status: MembershipStatus.ACTIVE,
          planCode: plan.code,
          planName: plan.name,
          planPriceCentavos: plan.priceCentavos,
          termMonths: plan.termMonths ?? 1,
          graceDays: plan.graceDays,
          guestPassesPerTerm: plan.guestPassesPerTerm,
          startsOn: toDateColumn(startsOn),
          endsOn: toDateColumn(endsOn),
          billingAnchorDay: Number(startsOn.slice(8, 10)),
          joinedOn: toDateColumn(joinedOn),
          graceAdmissionsThisTerm: 0,
          freezesUsedThisTerm: 0,
          guestPassesRemaining: plan.guestPassesPerTerm,
          purchasedAt: now,
        },
      });

      await writeMembershipEvent(tx, {
        membershipId: membership.id,
        type: MembershipEventType.IMPORTED,
        fromStatus: null,
        toStatus: MembershipStatus.ACTIVE,
        previousEndsOn: null,
        newEndsOn: null,
        reason: 'imported at go-live',
        actorId: actor.id,
        paymentId: null,
        batchRef: null,
        effectiveAt: now,
      });

      return 'created';
    });
  }

  async extendAll(
    actor: AuthUser,
    dto: ExtendAllDto,
    now: Date,
  ): Promise<{ affected: number }> {
    assertConfirmed(dto);
    const today = gymToday(now, this.gym.timeZone);

    const affected = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const targets = await tx.membership.findMany({
          where: { status: { in: [MembershipStatus.ACTIVE, MembershipStatus.FROZEN] } },
          select: { id: true, status: true, endsOn: true },
        });

        let count = 0;
        for (const membership of targets) {
          const previousEndsOn = civilDateFromPrisma(membership.endsOn);
          const newEndsOn = addDays(previousEndsOn, dto.days);

          // The batchRef claim comes FIRST: if it loses, the extension never
          // runs, so a re-run of the same closure moves no date twice.
          const claimed = await writeMembershipEventIfNew(tx, {
            membershipId: membership.id,
            type: MembershipEventType.ADJUSTED,
            fromStatus: membership.status,
            toStatus: membership.status,
            previousEndsOn,
            newEndsOn,
            reason: dto.reason,
            actorId: actor.id,
            paymentId: null,
            batchRef: dto.batchRef,
            effectiveAt: now,
          });
          if (!claimed) continue;

          await tx.membership.update({
            where: { id: membership.id },
            data: { endsOn: toDateColumn(newEndsOn) },
          });
          count += 1;
        }

        return count;
      },
      { timeout: BULK_TRANSACTION_TIMEOUT_MS },
    );

    this.logger.log(
      `extendAll actor=${actor.id} today=${today} days=${dto.days} ` +
        `batchRef=${dto.batchRef} affected=${affected}`,
    );

    return { affected };
  }
}
```

- [ ] **Step 5: Write the admin controller and register it**

```typescript
// server/src/membership/admin-memberships.controller.ts
import { Body, Controller, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { MembershipImportService, type ImportResult } from './membership-import.service';
import { ExtendAllDto, ImportMembershipsDto } from './dto/import-memberships.dto';

/**
 * Routes 31 and 32. Both are dangerous, both are confirm-gated, both carry
 * @Idempotent() — a half-applied 340-row import re-submitted by a nervous
 * operator is exactly the failure the replay table exists for.
 *
 * One @RequirePermission key per route: `getAllAndOverride` means a method-level
 * decorator REPLACES a class-level one, so nothing may be declared on the class.
 */
@Controller('admin/memberships')
export class AdminMembershipsController {
  constructor(private readonly imports: MembershipImportService) {}

  @Post('import')
  @RequirePermission('membership.import')
  @Idempotent()
  async import(
    @CurrentUser() user: AuthUser,
    @Body() dto: ImportMembershipsDto,
  ): Promise<ImportResult> {
    return this.imports.importMembers(user, dto, new Date());
  }

  @Post('extend')
  @RequirePermission('membership.term.adjust')
  @Idempotent()
  async extend(
    @CurrentUser() user: AuthUser,
    @Body() dto: ExtendAllDto,
  ): Promise<{ affected: number }> {
    return this.imports.extendAll(user, dto, new Date());
  }
}
```

```typescript
// server/src/membership/membership.module.ts — add to the existing arrays.
//   controllers: [MembershipsController, AdminMembershipsController],
//   providers: [..., MembershipImportService],
```

- [ ] **Step 6: Run the e2e and watch it pass**

Run: `npm run test:e2e --workspace=server -- memberships`
Expected: PASS — five new cases green, `created: 2 / skipped: 2 / affected: 2 then 0`.

- [ ] **Step 7: Commit**

```bash
git add server/src/membership/membership-import.service.ts \
        server/src/membership/dto/import-memberships.dto.ts \
        server/src/membership/admin-memberships.controller.ts \
        server/src/membership/membership.module.ts \
        server/test/memberships.e2e-spec.ts
git commit -m "feat(membership): legacy member import and batchRef-idempotent bulk extension (routes 31-32)"
```

---

### Task 16: The nightly job and its manual trigger

**Files:**
- Create: `server/src/membership/membership-nightly.job.ts`
- Create: `server/src/membership/admin-jobs.controller.ts`
- Modify: `server/src/scheduler/scheduler.service.ts:1-5` (imports) and `:28-40` (constructor + `onModuleInit`)
- Modify: `server/src/scheduler/scheduler.module.ts:1-17`
- Modify: `server/src/scheduler/scheduler.service.spec.ts:1-20` (fakes) and `:35-81` (every construction site gains the second job)
- Modify: `server/src/membership/membership.module.ts` (created in task 11 — add `AdminJobsController`, provide and export `MembershipNightlyJob`)
- Test: `server/test/membership-nightly.e2e-spec.ts`

**Interfaces:**
- Consumes: `server/src/scheduler/scheduler.service.ts`: `ScheduledJob`, `SchedulerService.register` (Chunk 0) · `server/src/scheduler/jobs/prune-ephemera.job.ts` — extended, never replaced; its `responseStatus: 0` exclusion untouched · `server/src/membership/membership-holds.service.ts`: `activateHoldInTx`, `completeHoldInTx` (task 14) · `server/src/membership/membership-events.ts`: `writeMembershipEvent` (task 11) · `server/src/membership/membership-terms.ts`: `termEndsOn` (task 3) · `server/src/common/time/gym-time.ts`: `gymToday`, `addDays`, `civilDateFromPrisma`, `toDateColumn` · `server/src/common/dto/confirm.dto.ts`: `ConfirmDto`, `assertConfirmed` (task 2) · `GymConfigService.timeZone`, `.schedulerEnabled`; permission key `job.run` (task 2)
- Produces: `NightlyStepResult`, `NightlyRunResult`, `MembershipNightlyJob implements ScheduledJob { name = 'membershipNightly'; cronExpression = '15 3 * * *'; run(); runFor(today, now) }` — every step a conditional `UPDATE` its own effect falsifies; the only increment is step 2's `endsOn += daysRequested`, guarded by the `SCHEDULED → ACTIVE` flip; step 3 before step 4; step 4 excludes `FROZEN`; step 5 logs and repairs nothing; each event's `effectiveAt` is the day the transition *should* have happened · `POST /admin/jobs/membership-nightly` under `job.run` with `RunJobDto extends ConfirmDto { runFor?: CivilDate }`

---

- [ ] **Step 1: Write the failing e2e for the job**

```typescript
// server/test/membership-nightly.e2e-spec.ts
import request from 'supertest';
import type { Server } from 'http';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import { makeMember, seedPlansForTest } from './support/membership-fixtures';
import { MembershipNightlyJob } from '../src/membership/membership-nightly.job';
import { addDays, asCivilDate, civilDateFromPrisma, toDateColumn } from '../src/common/time/gym-time';

jest.setTimeout(120_000);

const TODAY = asCivilDate('2026-08-19');
const NOW = new Date('2026-08-19T19:15:00.000Z'); // 03:15 Manila on 2026-08-20 is a different day

describe('membership nightly job (route 41, spec 5.9)', () => {
  let ctx: TestApp;
  let server: Server;
  let job: MembershipNightlyJob;
  let adminToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
    job = ctx.app.get(MembershipNightlyJob, { strict: false });
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await seedPlansForTest(ctx.prisma);
    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
  });

  it('expires a lapsed term and is a no-op on a second run', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });
    await ctx.prisma.membership.update({
      where: { id: member.membershipId! },
      data: { endsOn: toDateColumn(addDays(TODAY, -1)) },
    });

    const first = await job.runFor(TODAY, NOW);
    expect(first.steps.find((s) => s.step === 'expireLapsedTerms')).toMatchObject({ changed: 1 });

    const afterFirst = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(afterFirst.status).toBe('EXPIRED');
    expect(civilDateFromPrisma(afterFirst.endsOn)).toBe(addDays(TODAY, -1));

    const second = await job.runFor(TODAY, NOW);
    expect(second.steps.find((s) => s.step === 'expireLapsedTerms')).toMatchObject({ changed: 0 });

    const events = await ctx.prisma.membershipEvent.findMany({ where: { type: 'EXPIRED' } });
    expect(events).toHaveLength(1);
    expect(events[0].actorId).toBeNull();
    expect(events[0].effectiveAt.toISOString().slice(0, 10)).toBe(TODAY);
  });

  it('closes a term under notice before it can be briefly EXPIRED', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });
    const endsOn = addDays(TODAY, -2);
    await ctx.prisma.membership.update({
      where: { id: member.membershipId! },
      data: {
        endsOn: toDateColumn(endsOn),
        cancelRequestedOn: toDateColumn(addDays(TODAY, -10)),
      },
    });

    await job.runFor(TODAY, NOW);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('CANCELLED');
    expect(civilDateFromPrisma(after.cancelledOn!)).toBe(addDays(endsOn, 1));
    expect(await ctx.prisma.membershipEvent.count({ where: { type: 'EXPIRED' } })).toBe(0);
  });

  it('activates a scheduled hold exactly once, extending endsOn day for day', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'QUARTERLY',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    const adminId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
    await ctx.prisma.membershipHold.create({
      data: {
        membershipId: member.membershipId!,
        status: 'SCHEDULED',
        startsOn: toDateColumn(TODAY),
        endsOn: toDateColumn(addDays(TODAY, 13)),
        daysRequested: 14,
        daysApplied: 0,
        reason: 'booked last week',
        approvedById: adminId,
      },
    });

    await job.runFor(TODAY, NOW);
    await job.runFor(TODAY, NOW);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('FROZEN');
    expect(civilDateFromPrisma(after.endsOn)).toBe(
      addDays(civilDateFromPrisma(before.endsOn), 14),
    );
    expect(after.freezesUsedThisTerm).toBe(1);
    expect(await ctx.prisma.membershipEvent.count({ where: { type: 'HOLD_APPLIED' } })).toBe(1);
  });

  it('completes a finished hold with no date arithmetic at all', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'FROZEN',
      planCode: 'QUARTERLY',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    await ctx.prisma.membershipHold.updateMany({
      where: { membershipId: member.membershipId! },
      data: { endsOn: toDateColumn(addDays(TODAY, -1)) },
    });

    await job.runFor(TODAY, NOW);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('ACTIVE');
    expect(civilDateFromPrisma(after.endsOn)).toBe(civilDateFromPrisma(before.endsOn));

    const hold = await ctx.prisma.membershipHold.findFirstOrThrow({
      where: { membershipId: member.membershipId! },
    });
    expect(hold.status).toBe('COMPLETED');
    expect(hold.activeMembershipId).toBeNull();
  });

  it('a three-day catch-up equals three sequential nightly runs', async () => {
    const catchUp = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });
    const sequential = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });
    await ctx.prisma.membership.updateMany({
      where: { id: { in: [catchUp.membershipId!, sequential.membershipId!] } },
      data: { endsOn: toDateColumn(addDays(TODAY, -3)) },
    });
    // Only the sequential member gets a run on each of the three missed days.
    await job.runFor(addDays(TODAY, -2), NOW);
    await job.runFor(addDays(TODAY, -1), NOW);
    await job.runFor(TODAY, NOW);

    const rows = await ctx.prisma.membership.findMany({
      where: { id: { in: [catchUp.membershipId!, sequential.membershipId!] } },
      select: { id: true, status: true, endsOn: true },
    });
    expect(rows[0].status).toBe(rows[1].status);
    expect(civilDateFromPrisma(rows[0].endsOn)).toBe(civilDateFromPrisma(rows[1].endsOn));

    // effectiveAt is the day it SHOULD have happened, not the day it was noticed.
    const expired = await ctx.prisma.membershipEvent.findMany({ where: { type: 'EXPIRED' } });
    expect(expired).toHaveLength(2);
    for (const event of expired) {
      expect(event.effectiveAt.toISOString().slice(0, 10)).toBe(addDays(TODAY, -2));
    }
  });

  it('exposes the manual trigger at route 41 behind job.run and confirm', async () => {
    const unconfirmed = await request(server)
      .post('/api/v1/admin/jobs/membership-nightly')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: false })
      .expect(400);
    expect(unconfirmed.body.error.code).toBe('CONFIRMATION_REQUIRED');

    const response = await request(server)
      .post('/api/v1/admin/jobs/membership-nightly')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, runFor: TODAY })
      .expect(201);

    expect(response.body.data.runFor).toBe(TODAY);
    expect(response.body.data.steps.map((s: { step: string }) => s.step)).toEqual([
      'completeFinishedHolds',
      'activateScheduledHolds',
      'closeTermsUnderNotice',
      'expireLapsedTerms',
      'reconcileHoldArithmetic',
      'emitOwnerSummary',
    ]);

    const deskToken = await ctx.fixture.tokenFor('FRONT_DESK', {
      supabaseId: FIXTURE_IDS.FRONT_DESK,
    });
    await request(server)
      .post('/api/v1/admin/jobs/membership-nightly')
      .set('Authorization', `Bearer ${deskToken}`)
      .send({ confirm: true })
      .expect(403);
  });
});
```

- [ ] **Step 2: Run the e2e and watch it fail**

Run: `npm run test:e2e --workspace=server -- membership-nightly`
Expected: FAIL — `Cannot find module '../src/membership/membership-nightly.job'`

- [ ] **Step 3: Write MembershipNightlyJob**

```typescript
// server/src/membership/membership-nightly.job.ts
import { Injectable, Logger } from '@nestjs/common';
import { HoldStatus, MembershipEventType, MembershipStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import {
  addDays,
  civilDateFromPrisma,
  civilDaysBetween,
  gymToday,
  toDateColumn,
  type CivilDate,
} from '../common/time/gym-time';
import type { ScheduledJob } from '../scheduler/scheduler.service';
import { MembershipHoldsService } from './membership-holds.service';
import { writeMembershipEvent } from './membership-events';
import { termEndsOn } from './membership-terms';

export interface NightlyStepResult {
  step:
    | 'completeFinishedHolds'
    | 'activateScheduledHolds'
    | 'closeTermsUnderNotice'
    | 'expireLapsedTerms'
    | 'reconcileHoldArithmetic'
    | 'emitOwnerSummary';
  matched: number;
  changed: number;
  note: string | null;
}

export interface NightlyRunResult {
  runFor: CivilDate;
  steps: NightlyStepResult[];
}

/**
 * §5.9. 03:15 gym-local: after close, well before the 05:00 rush, off the top of
 * the hour. An optimiser, never a gatekeeper — accessVerdict recomputes from
 * dates, so three missed nights break nothing at the door (§5.9.3).
 *
 * Idempotent structurally, not by convention: every step is a conditional UPDATE
 * whose WHERE clause its own effect falsifies, and the single increment in the
 * whole job (endsOn += daysRequested) is guarded by the SCHEDULED → ACTIVE flip
 * inside MembershipHoldsService.activateHoldInTx. The job calls those helpers
 * rather than copying the arithmetic.
 */
@Injectable()
export class MembershipNightlyJob implements ScheduledJob {
  readonly name = 'membershipNightly';
  readonly cronExpression = '15 3 * * *';

  private readonly logger = new Logger(MembershipNightlyJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly holds: MembershipHoldsService,
  ) {}

  async run(): Promise<void> {
    const now = new Date();
    await this.runFor(gymToday(now, this.gym.timeZone), now);
  }

  async runFor(today: CivilDate, now: Date): Promise<NightlyRunResult> {
    const steps: NightlyStepResult[] = [
      // Order is load-bearing: holds first, so one ending today and one starting
      // today cannot interleave; notice before expiry, so a leaver is never
      // briefly EXPIRED.
      await this.completeFinishedHolds(today, now),
      await this.activateScheduledHolds(today, now),
      await this.closeTermsUnderNotice(today, now),
      await this.expireLapsedTerms(today, now),
      await this.reconcileHoldArithmetic(),
      await this.emitOwnerSummary(today),
    ];

    for (const step of steps) {
      this.logger.log(
        `job=${this.name} runFor=${today} step=${step.step} ` +
          `matched=${step.matched} changed=${step.changed}` +
          (step.note ? ` note="${step.note}"` : ''),
      );
    }

    return { runFor: today, steps };
  }

  /**
   * The instant a transition SHOULD have carried, so a catch-up run produces
   * exactly the state as if the job had run each night.
   */
  private effectiveInstant(dueDay: CivilDate, today: CivilDate, now: Date): Date {
    return dueDay === today ? now : toDateColumn(dueDay);
  }

  private async completeFinishedHolds(today: CivilDate, now: Date): Promise<NightlyStepResult> {
    const due = await this.prisma.membershipHold.findMany({
      where: { status: HoldStatus.ACTIVE, endsOn: { lt: toDateColumn(today) } },
      select: { id: true, endsOn: true },
    });

    let changed = 0;
    for (const hold of due) {
      const dueDay = addDays(civilDateFromPrisma(hold.endsOn), 1);
      const effectiveAt = this.effectiveInstant(dueDay, today, now);
      const applied = await this.prisma.$transaction((tx) =>
        this.holds.completeHoldInTx(tx, hold.id, today, effectiveAt, null),
      );
      if (applied) changed += 1;
    }

    return { step: 'completeFinishedHolds', matched: due.length, changed, note: null };
  }

  private async activateScheduledHolds(today: CivilDate, now: Date): Promise<NightlyStepResult> {
    const due = await this.prisma.membershipHold.findMany({
      where: { status: HoldStatus.SCHEDULED, startsOn: { lte: toDateColumn(today) } },
      select: { id: true, startsOn: true },
    });

    let changed = 0;
    let late = 0;
    for (const hold of due) {
      const dueDay = civilDateFromPrisma(hold.startsOn);
      if (dueDay < today) late += 1;
      const applied = await this.prisma.$transaction((tx) =>
        this.holds.activateHoldInTx(tx, hold.id, today, this.effectiveInstant(dueDay, today, now), null),
      );
      if (applied) changed += 1;
    }

    return {
      step: 'activateScheduledHolds',
      matched: due.length,
      changed,
      // A late activation is a missed run, and the one place this job's failure
      // has a real (if benign) commercial effect.
      note: late > 0 ? `${late} late activation(s) — a run was missed` : null,
    };
  }

  private async closeTermsUnderNotice(today: CivilDate, now: Date): Promise<NightlyStepResult> {
    const due = await this.prisma.membership.findMany({
      where: {
        status: MembershipStatus.ACTIVE,
        cancelRequestedOn: { not: null },
        endsOn: { lt: toDateColumn(today) },
      },
      select: { id: true, endsOn: true },
    });

    let changed = 0;
    for (const membership of due) {
      const dueDay = addDays(civilDateFromPrisma(membership.endsOn), 1);
      const effectiveAt = this.effectiveInstant(dueDay, today, now);

      const applied = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.membership.updateMany({
          where: {
            id: membership.id,
            status: MembershipStatus.ACTIVE,
            cancelRequestedOn: { not: null },
            endsOn: { lt: toDateColumn(today) },
          },
          data: { status: MembershipStatus.CANCELLED, cancelledOn: toDateColumn(dueDay) },
        });
        if (claimed.count !== 1) return false;

        await writeMembershipEvent(tx, {
          membershipId: membership.id,
          type: MembershipEventType.CANCELLED,
          fromStatus: MembershipStatus.ACTIVE,
          toStatus: MembershipStatus.CANCELLED,
          previousEndsOn: null,
          newEndsOn: null,
          reason: 'notice',
          actorId: null,
          paymentId: null,
          batchRef: null,
          effectiveAt,
        });
        return true;
      });
      if (applied) changed += 1;
    }

    return { step: 'closeTermsUnderNotice', matched: due.length, changed, note: null };
  }

  private async expireLapsedTerms(today: CivilDate, now: Date): Promise<NightlyStepResult> {
    // FROZEN is deliberately excluded: a membership frozen with two days left
    // sails past its endsOn mid-freeze, and that is correct.
    const due = await this.prisma.membership.findMany({
      where: {
        status: MembershipStatus.ACTIVE,
        cancelRequestedOn: null,
        endsOn: { lt: toDateColumn(today) },
      },
      select: { id: true, endsOn: true },
    });

    let changed = 0;
    for (const membership of due) {
      const dueDay = addDays(civilDateFromPrisma(membership.endsOn), 1);
      const effectiveAt = this.effectiveInstant(dueDay, today, now);

      const applied = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.membership.updateMany({
          where: {
            id: membership.id,
            status: MembershipStatus.ACTIVE,
            cancelRequestedOn: null,
            endsOn: { lt: toDateColumn(today) },
          },
          data: { status: MembershipStatus.EXPIRED },
        });
        if (claimed.count !== 1) return false;

        await writeMembershipEvent(tx, {
          membershipId: membership.id,
          type: MembershipEventType.EXPIRED,
          fromStatus: MembershipStatus.ACTIVE,
          toStatus: MembershipStatus.EXPIRED,
          previousEndsOn: null,
          newEndsOn: null,
          reason: null,
          actorId: null,
          paymentId: null,
          batchRef: null,
          effectiveAt,
        });
        return true;
      });
      if (applied) changed += 1;
    }

    return { step: 'expireLapsedTerms', matched: due.length, changed, note: null };
  }

  /** Logs mismatches and repairs nothing — a silent repair hides its own cause. */
  private async reconcileHoldArithmetic(): Promise<NightlyStepResult> {
    const rows = await this.prisma.membership.findMany({
      where: { holds: { some: {} } },
      select: {
        id: true,
        billingAnchorDay: true,
        termMonths: true,
        startsOn: true,
        endsOn: true,
        holds: {
          where: { status: { not: HoldStatus.CANCELLED } },
          select: { daysApplied: true },
        },
        events: {
          where: { type: MembershipEventType.ADJUSTED },
          select: { previousEndsOn: true, newEndsOn: true, effectiveAt: true },
        },
      },
    });

    let mismatches = 0;
    for (const row of rows) {
      const startsOn = civilDateFromPrisma(row.startsOn);
      const base = termEndsOn(row.billingAnchorDay, startsOn, row.termMonths);
      const held = row.holds.reduce((sum, hold) => sum + hold.daysApplied, 0);
      const adjusted = row.events
        .filter((event) => event.effectiveAt >= toDateColumn(startsOn))
        .reduce(
          (sum, event) =>
            event.previousEndsOn && event.newEndsOn
              ? sum +
                civilDaysBetween(
                  civilDateFromPrisma(event.previousEndsOn),
                  civilDateFromPrisma(event.newEndsOn),
                )
              : sum,
          0,
        );

      const expected = addDays(base, held + adjusted);
      const actual = civilDateFromPrisma(row.endsOn);
      if (expected !== actual) {
        mismatches += 1;
        this.logger.warn(
          `membership=${row.id} endsOn=${actual} expected=${expected} ` +
            `(term=${base} holdDays=${held} adjustedDays=${adjusted})`,
        );
      }
    }

    return {
      step: 'reconcileHoldArithmetic',
      matched: rows.length,
      changed: 0,
      note: mismatches > 0 ? `${mismatches} mismatch(es) logged, none repaired` : null,
    };
  }

  /** Filled in by task 17, which owns ReportsService and the SummaryTransport. */
  private async emitOwnerSummary(today: CivilDate): Promise<NightlyStepResult> {
    return Promise.resolve({
      step: 'emitOwnerSummary',
      matched: 0,
      changed: 0,
      note: `summary for ${addDays(today, -1)} not yet wired`,
    });
  }
}
```

- [ ] **Step 4: Write the manual trigger controller**

```typescript
// server/src/membership/admin-jobs.controller.ts
import { Body, Controller, Post } from '@nestjs/common';
import { IsOptional } from 'class-validator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { ConfirmDto, assertConfirmed } from '../common/dto/confirm.dto';
import { IsGymDate } from '../common/validators/is-gym-date.validator';
import { GymConfigService } from '../config/gym.config';
import { asCivilDate, gymToday, type CivilDate } from '../common/time/gym-time';
import { MembershipNightlyJob, type NightlyRunResult } from './membership-nightly.job';

/**
 * `runFor` exists so a post-downtime catch-up can be replayed one missed day at
 * a time when an operator wants to watch it, and defaults to gym today.
 */
export class RunJobDto extends ConfirmDto {
  @IsOptional()
  @IsGymDate()
  runFor?: CivilDate;
}

/** Route 41. There is no JobRun table — the job is stateless and date-driven. */
@Controller('admin/jobs')
export class AdminJobsController {
  constructor(
    private readonly job: MembershipNightlyJob,
    private readonly gym: GymConfigService,
  ) {}

  @Post('membership-nightly')
  @RequirePermission('job.run')
  async runNightly(@Body() dto: RunJobDto): Promise<NightlyRunResult> {
    assertConfirmed(dto);
    const now = new Date();
    const today = dto.runFor ? asCivilDate(dto.runFor) : gymToday(now, this.gym.timeZone);
    return this.job.runFor(today, now);
  }
}
```

```typescript
// server/src/membership/membership.module.ts — add to the existing arrays.
//   controllers: [MembershipsController, AdminMembershipsController, AdminJobsController],
//   providers: [..., MembershipNightlyJob],
//   exports: [MembershipService, MembershipHoldsService, MembershipNightlyJob],
```

- [ ] **Step 5: Register the job in the one scheduler**

```typescript
// server/src/scheduler/scheduler.service.ts — imports (lines 1-5) and constructor/init (28-40).
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { GymConfigService } from '../config/gym.config';
import { PruneEphemeraJob } from './jobs/prune-ephemera.job';
import { MembershipNightlyJob } from '../membership/membership-nightly.job';

// …

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly gym: GymConfigService,
    private readonly pruneEphemera: PruneEphemeraJob,
    private readonly membershipNightly: MembershipNightlyJob,
  ) {}

  onModuleInit(): void {
    if (!this.gym.schedulerEnabled) {
      this.logger.warn('SCHEDULER_ENABLED=false — no jobs registered on this instance');
      return;
    }
    this.register(this.pruneEphemera);
    // One registry, one timezone, one switch. A second scheduler would be a
    // second place SCHEDULER_ENABLED has to be honoured.
    this.register(this.membershipNightly);
  }
```

```typescript
// server/src/scheduler/scheduler.module.ts — full replacement.
import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { PruneEphemeraJob } from './jobs/prune-ephemera.job';
import { MembershipModule } from '../membership/membership.module';

/**
 * Hosts the registry-driven jobs. AppModule imports this alongside
 * `ScheduleModule.forRoot()`, which is what provides SchedulerRegistry.
 *
 * MembershipModule is imported for MembershipNightlyJob only; the job lives
 * beside the services whose transactions it reuses, so the arithmetic exists
 * once. PruneEphemeraJob is untouched, including its deliberate refusal to
 * delete IdempotencyRecord rows at responseStatus 0.
 *
 * GymConfigService is NOT listed here — it is provided globally by
 * GymConfigModule (imported once, in AppModule), so a second instance here
 * would shadow the one the e2e harness resolves.
 */
@Module({
  imports: [MembershipModule],
  providers: [SchedulerService, PruneEphemeraJob],
  exports: [SchedulerService],
})
export class SchedulerModule {}
```

- [ ] **Step 6: Update the scheduler unit spec for the second job**

```typescript
// server/src/scheduler/scheduler.service.spec.ts — replace the fakes and every construction site.
import { SchedulerRegistry } from '@nestjs/schedule';
import { SchedulerService } from './scheduler.service';
import type { GymConfigService } from '../config/gym.config';
import type { PruneEphemeraJob } from './jobs/prune-ephemera.job';
import type { MembershipNightlyJob } from '../membership/membership-nightly.job';

function fakeJob(run: jest.Mock = jest.fn().mockResolvedValue(undefined)): PruneEphemeraJob {
  return {
    name: 'pruneEphemera',
    cronExpression: '30 03 * * *',
    run,
  } as unknown as PruneEphemeraJob;
}

function fakeNightly(
  run: jest.Mock = jest.fn().mockResolvedValue(undefined),
): MembershipNightlyJob {
  return {
    name: 'membershipNightly',
    cronExpression: '15 3 * * *',
    run,
  } as unknown as MembershipNightlyJob;
}

function gymConfig(overrides: Partial<GymConfigService> = {}): GymConfigService {
  return {
    timeZone: 'Asia/Manila',
    schedulerEnabled: true,
    ...overrides,
  } as unknown as GymConfigService;
}

describe('SchedulerService', () => {
  let registry: SchedulerRegistry;

  beforeEach(() => {
    registry = new SchedulerRegistry();
  });

  afterEach(() => {
    registry.getCronJobs().forEach((job) => void job.stop());
  });

  it('registers every job with the gym timezone pinned', () => {
    const service = new SchedulerService(registry, gymConfig(), fakeJob(), fakeNightly());

    service.onModuleInit();

    expect(registry.getCronJobs().size).toBe(2);
    for (const name of ['pruneEphemera', 'membershipNightly']) {
      const job = registry.getCronJob(name);
      expect(job).toBeDefined();
      expect((job.cronTime as unknown as { timeZone?: string }).timeZone).toBe('Asia/Manila');
    }
  });

  it('honours a non-default timezone', () => {
    const service = new SchedulerService(
      registry,
      gymConfig({ timeZone: 'Asia/Calcutta' }),
      fakeJob(),
      fakeNightly(),
    );

    service.onModuleInit();

    expect(
      (registry.getCronJob('membershipNightly').cronTime as unknown as { timeZone?: string })
        .timeZone,
    ).toBe('Asia/Calcutta');
  });

  it('registers zero jobs when SCHEDULER_ENABLED is false', () => {
    const service = new SchedulerService(
      registry,
      gymConfig({ schedulerEnabled: false }),
      fakeJob(),
      fakeNightly(),
    );

    service.onModuleInit();

    expect(registry.getCronJobs().size).toBe(0);
  });

  it('logs and does not rethrow when a job raises, so one failure cannot kill the process', async () => {
    const run = jest.fn().mockRejectedValue(new Error('nightly exploded'));
    const service = new SchedulerService(registry, gymConfig(), fakeJob(), fakeNightly(run));
    const error = jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

    service.onModuleInit();
    await registry.getCronJob('membershipNightly').fireOnTick();

    expect(run).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('membershipNightly');
  });
});
```

- [ ] **Step 7: Run both suites and watch them pass**

Run: `npm test --workspace=server -- scheduler` then `npm run test:e2e --workspace=server -- membership-nightly`
Expected: PASS — scheduler unit spec green with two registrations; six nightly e2e cases green, including the double run producing `changed: 0` and one `EXPIRED` event.

- [ ] **Step 8: Commit**

```bash
git add server/src/membership/membership-nightly.job.ts \
        server/src/membership/admin-jobs.controller.ts \
        server/src/membership/membership.module.ts \
        server/src/scheduler/scheduler.service.ts \
        server/src/scheduler/scheduler.service.spec.ts \
        server/src/scheduler/scheduler.module.ts \
        server/test/membership-nightly.e2e-spec.ts
git commit -m "feat(membership): nightly lifecycle job and its manual catch-up trigger (route 41)"
```

---

### Task 17: Reports and the owner's nightly summary

**Files:**
- Create: `server/src/payments/reports.service.ts`
- Create: `server/src/payments/reports.controller.ts`
- Create: `server/src/payments/summary-transport.ts`
- Create: `server/src/payments/summary-transport.spec.ts`
- Create: `server/src/payments/dto/report-range-query.dto.ts`
- Modify: `server/src/payments/payments.module.ts` (created in task 9, extended in task 10 — add `ReportsController`, provide `ReportsService` and `{ provide: SUMMARY_TRANSPORT, useClass: LoggingSummaryTransport }`, export both)
- Modify: `server/src/membership/membership-nightly.job.ts` (created in task 16 — inject `ReportsService` + `SUMMARY_TRANSPORT` and replace `emitOwnerSummary`'s placeholder)
- Modify: `server/src/membership/membership.module.ts` (created in task 11 — import `PaymentsModule` if it is not already imported for `PaymentsService`)
- Test: `server/src/payments/summary-transport.spec.ts`
- Test: `server/test/payments-shifts.e2e-spec.ts` (created in task 10 — append the `reports` describe)
- Test: `server/test/membership-nightly.e2e-spec.ts` (created in task 16 — append the step-6 assertion)

**Interfaces:**
- Consumes: `@prisma/client`: `Payment`, `Shift`, `MembershipEvent` (task 6) · `server/src/common/validators/is-gym-date.validator.ts`: `IsGymDate` (Chunk 0) · `server/src/membership/membership-nightly.job.ts`: `NightlyRunResult`, the step-6 seam (task 16) · permission key `payment.read` (task 2); `GymConfigService.timeZone`
- Produces: `ReportRangeQueryDto` · `StatutoryDiscountRow`, `StatutoryDiscountRegister`, `GcashReferenceRow`, `GcashReferenceList`, `OwnerSummaryPayload` (with `membersNotSeenIn30Days: number | null`, null until Chunk 2) · `ReportsService { statutoryDiscounts, gcashReferences, buildOwnerSummary }` · `SummaryTransport`, `SUMMARY_TRANSPORT`, `LoggingSummaryTransport`

---

- [ ] **Step 1: Write the failing test for the transport**

```typescript
// server/src/payments/summary-transport.spec.ts
import { Logger } from '@nestjs/common';
import { LoggingSummaryTransport } from './summary-transport';
import type { OwnerSummaryPayload } from './reports.service';
import { asCivilDate } from '../common/time/gym-time';

function payload(): OwnerSummaryPayload {
  return {
    businessDate: asCivilDate('2026-08-19'),
    cash: {
      openingFloatCentavos: 200000,
      expectedCentavos: 1245000,
      countedCentavos: 1244000,
      varianceCentavos: -1000,
      countedByName: 'Ana Cruz',
    },
    gcash: { count: 3, totalCentavos: 240000 },
    newMemberships: [{ name: 'Juan Dela Cruz', planCode: 'MONTHLY' }],
    renewals: [{ name: 'Maria Santos', planCode: 'QUARTERLY' }],
    expiringWithinThreeDays: [{ name: 'Pedro Reyes', endsOn: asCivilDate('2026-08-21') }],
    voids: [{ paymentId: 'p1', netCentavos: 9000, reason: 'mis-keyed', byName: 'Ana Cruz' }],
    discounts: [
      { paymentId: 'p2', discountType: 'SENIOR', discountCentavos: 14286, byName: 'Ana Cruz' },
    ],
    freezes: [
      {
        membershipId: 'm1',
        name: 'Luis Tan',
        startsOn: asCivilDate('2026-08-20'),
        endsOn: asCivilDate('2026-09-02'),
        byName: 'Owner',
      },
    ],
    graceAdmissions: 0,
    paymentsWithoutReceiptNo: 2,
    membersNotSeenIn30Days: null,
  };
}

describe('LoggingSummaryTransport', () => {
  it('emits the whole payload as ONE structured line, so a swap to email changes nothing else', async () => {
    const transport = new LoggingSummaryTransport();
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);

    await transport.send(payload());

    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0] as string;
    expect(JSON.parse(line)).toMatchObject({
      businessDate: '2026-08-19',
      cash: { varianceCentavos: -1000, countedByName: 'Ana Cruz' },
      gcash: { count: 3, totalCentavos: 240000 },
      membersNotSeenIn30Days: null,
    });
    expect(line).not.toContain('₱');

    log.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm test --workspace=server -- summary-transport`
Expected: FAIL — `Cannot find module './summary-transport' from 'src/payments/summary-transport.spec.ts'`

- [ ] **Step 3: Write the reports service**

```typescript
// server/src/payments/reports.service.ts
import { Injectable } from '@nestjs/common';
import {
  DiscountType,
  MembershipEventType,
  MembershipStatus,
  PaymentMethod,
  PaymentStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import {
  addDays,
  asCivilDate,
  civilDateFromPrisma,
  toDateColumn,
  type CivilDate,
} from '../common/time/gym-time';
import type { ReportRangeQueryDto } from './dto/report-range-query.dto';

const MS_PER_DAY = 86_400_000;

/**
 * The instant window of one gym-local civil day.
 *
 * Manila is UTC+8 with no DST (§2 context), so one offset probe is exact. A zone
 * with DST would need the offset recomputed at each boundary; that is the only
 * line that would change.
 */
export function gymDayWindow(day: CivilDate, timeZone: string): { start: Date; end: Date } {
  const naive = toDateColumn(day).getTime();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(naive));

  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour') % 24,
    value('minute'),
    value('second'),
  );

  const start = new Date(naive - (asUtc - naive));
  return { start, end: new Date(start.getTime() + MS_PER_DAY) };
}

export interface StatutoryDiscountRow {
  paymentId: string;
  businessDate: CivilDate;
  memberName: string;
  statutoryIdNo: string;
  discountType: 'SENIOR' | 'PWD';
  grossCentavos: number;
  vatBaseCentavos: number;
  discountCentavos: number;
  netCentavos: number;
}

export interface StatutoryDiscountRegister {
  from: CivilDate;
  to: CivilDate;
  rows: StatutoryDiscountRow[];
  totalDiscountCentavos: number;
}

export interface GcashReferenceRow {
  paymentId: string;
  businessDate: CivilDate;
  reference: string;
  netCentavos: number;
  memberName: string | null;
}

export interface GcashReferenceList {
  from: CivilDate;
  to: CivilDate;
  rows: GcashReferenceRow[];
  totalCentavos: number;
}

export interface OwnerSummaryPayload {
  businessDate: CivilDate;
  cash: {
    openingFloatCentavos: number;
    expectedCentavos: number | null;
    countedCentavos: number | null;
    varianceCentavos: number | null;
    countedByName: string | null;
  };
  gcash: { count: number; totalCentavos: number };
  newMemberships: { name: string; planCode: string }[];
  renewals: { name: string; planCode: string }[];
  expiringWithinThreeDays: { name: string; endsOn: CivilDate }[];
  voids: { paymentId: string; netCentavos: number; reason: string; byName: string }[];
  discounts: {
    paymentId: string;
    discountType: DiscountType;
    discountCentavos: number;
    byName: string;
  }[];
  freezes: {
    membershipId: string;
    name: string;
    startsOn: CivilDate;
    endsOn: CivilDate;
    byName: string;
  }[];
  graceAdmissions: number;
  paymentsWithoutReceiptNo: number;
  /** Sourced from CheckIn, which does not exist until Chunk 2. Null here so the
   *  SummaryTransport contract does not change when Chunk 2 fills it in. */
  membersNotSeenIn30Days: number | null;
}

const NAME_SELECT = { select: { firstName: true, lastName: true } } as const;

function fullName(person: { firstName: string; lastName: string } | null): string | null {
  return person ? `${person.firstName} ${person.lastName}` : null;
}

/**
 * The two registers the BIR and the GCash statement need, and the payload the
 * nightly job hands to the transport.
 *
 * Every money figure leaves as an integer of centavos. No formatted currency
 * string is composed anywhere on this side of the wire.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
  ) {}

  async statutoryDiscounts(query: ReportRangeQueryDto): Promise<StatutoryDiscountRegister> {
    const from = asCivilDate(query.from);
    const to = asCivilDate(query.to);

    const payments = await this.prisma.payment.findMany({
      where: {
        status: PaymentStatus.RECORDED,
        discountType: { in: [DiscountType.SENIOR, DiscountType.PWD] },
        businessDate: { gte: toDateColumn(from), lte: toDateColumn(to) },
      },
      include: { user: NAME_SELECT },
      orderBy: [{ businessDate: 'asc' }, { receivedAt: 'asc' }],
    });

    const rows: StatutoryDiscountRow[] = payments.map((payment) => ({
      paymentId: payment.id,
      businessDate: civilDateFromPrisma(payment.businessDate),
      memberName: fullName(payment.user) ?? 'Walk-in guest',
      statutoryIdNo: payment.statutoryIdNo ?? '',
      discountType: payment.discountType === DiscountType.SENIOR ? 'SENIOR' : 'PWD',
      grossCentavos: payment.grossCentavos,
      vatBaseCentavos: payment.vatBaseCentavos,
      discountCentavos: payment.discountCentavos,
      netCentavos: payment.netCentavos,
    }));

    return {
      from,
      to,
      rows,
      totalDiscountCentavos: rows.reduce((sum, row) => sum + row.discountCentavos, 0),
    };
  }

  async gcashReferences(query: ReportRangeQueryDto): Promise<GcashReferenceList> {
    const from = asCivilDate(query.from);
    const to = asCivilDate(query.to);

    const payments = await this.prisma.payment.findMany({
      where: {
        status: PaymentStatus.RECORDED,
        method: PaymentMethod.GCASH,
        businessDate: { gte: toDateColumn(from), lte: toDateColumn(to) },
      },
      include: { user: NAME_SELECT },
      orderBy: [{ businessDate: 'asc' }, { receivedAt: 'asc' }],
    });

    const rows: GcashReferenceRow[] = payments.map((payment) => ({
      paymentId: payment.id,
      businessDate: civilDateFromPrisma(payment.businessDate),
      reference: payment.reference ?? '',
      netCentavos: payment.netCentavos,
      memberName: fullName(payment.user),
    }));

    return {
      from,
      to,
      rows,
      totalCentavos: rows.reduce((sum, row) => sum + row.netCentavos, 0),
    };
  }

  async buildOwnerSummary(businessDate: CivilDate): Promise<OwnerSummaryPayload> {
    const day = toDateColumn(businessDate);
    const { start, end } = gymDayWindow(businessDate, this.gym.timeZone);

    const [shift, payments, events, expiring, freezes] = await Promise.all([
      this.prisma.shift.findFirst({
        where: { businessDate: day },
        orderBy: { openedAt: 'desc' },
        include: { closedBy: NAME_SELECT },
      }),
      this.prisma.payment.findMany({
        where: { businessDate: day },
        include: { user: NAME_SELECT, recordedBy: NAME_SELECT, voidedBy: NAME_SELECT },
      }),
      this.prisma.membershipEvent.findMany({
        where: {
          effectiveAt: { gte: start, lt: end },
          type: {
            in: [
              MembershipEventType.PURCHASED,
              MembershipEventType.RENEWED,
              MembershipEventType.REACTIVATED,
            ],
          },
        },
        include: { membership: { include: { user: NAME_SELECT } } },
      }),
      this.prisma.membership.findMany({
        where: {
          status: MembershipStatus.ACTIVE,
          endsOn: { gte: day, lte: toDateColumn(addDays(businessDate, 3)) },
        },
        include: { user: NAME_SELECT },
        orderBy: { endsOn: 'asc' },
      }),
      this.prisma.membershipHold.findMany({
        where: { createdAt: { gte: start, lt: end } },
        include: { membership: { include: { user: NAME_SELECT } }, approvedBy: NAME_SELECT },
      }),
    ]);

    const recorded = payments.filter((payment) => payment.status === PaymentStatus.RECORDED);
    const gcash = recorded.filter((payment) => payment.method === PaymentMethod.GCASH);
    const named = (event: (typeof events)[number]): string =>
      fullName(event.membership.user) ?? 'Unknown member';

    return {
      businessDate,
      cash: {
        openingFloatCentavos: shift?.openingFloatCentavos ?? 0,
        expectedCentavos: shift?.expectedCentavos ?? null,
        countedCentavos: shift?.countedCentavos ?? null,
        varianceCentavos: shift?.varianceCentavos ?? null,
        countedByName: fullName(shift?.closedBy ?? null),
      },
      gcash: {
        count: gcash.length,
        totalCentavos: gcash.reduce((sum, payment) => sum + payment.netCentavos, 0),
      },
      newMemberships: events
        .filter((event) => event.type === MembershipEventType.PURCHASED)
        .map((event) => ({ name: named(event), planCode: event.membership.planCode })),
      renewals: events
        .filter((event) => event.type !== MembershipEventType.PURCHASED)
        .map((event) => ({ name: named(event), planCode: event.membership.planCode })),
      expiringWithinThreeDays: expiring.map((membership) => ({
        name: fullName(membership.user) ?? 'Unknown member',
        endsOn: civilDateFromPrisma(membership.endsOn),
      })),
      voids: payments
        .filter((payment) => payment.status === PaymentStatus.VOIDED)
        .map((payment) => ({
          paymentId: payment.id,
          netCentavos: payment.netCentavos,
          reason: payment.voidReason ?? '',
          byName: fullName(payment.voidedBy) ?? 'Unknown staff',
        })),
      discounts: recorded
        .filter((payment) => payment.discountType !== DiscountType.NONE)
        .map((payment) => ({
          paymentId: payment.id,
          discountType: payment.discountType,
          discountCentavos: payment.discountCentavos,
          byName: fullName(payment.recordedBy) ?? 'Unknown staff',
        })),
      freezes: freezes.map((hold) => ({
        membershipId: hold.membershipId,
        name: fullName(hold.membership.user) ?? 'Unknown member',
        startsOn: civilDateFromPrisma(hold.startsOn),
        endsOn: civilDateFromPrisma(hold.endsOn),
        byName: fullName(hold.approvedBy) ?? 'Unknown staff',
      })),
      // Chunk 2 increments Membership.graceAdmissionsThisTerm on every GRACE
      // admission and sources this from CheckIn; Chunk 1 admits nobody.
      graceAdmissions: 0,
      paymentsWithoutReceiptNo: recorded.filter((payment) => payment.receiptNo === null).length,
      membersNotSeenIn30Days: null,
    };
  }
}
```

- [ ] **Step 4: Write the transport and the range DTO**

```typescript
// server/src/payments/summary-transport.ts
import { Injectable, Logger } from '@nestjs/common';
import type { OwnerSummaryPayload } from './reports.service';

/**
 * §5.9.4's one-method seam. Email in v1 is a provider swap, not a rewrite —
 * Viber and SMS are the same one method.
 */
export interface SummaryTransport {
  send(payload: OwnerSummaryPayload): Promise<void>;
}

export const SUMMARY_TRANSPORT = 'SUMMARY_TRANSPORT';

/**
 * The v1 implementation: one structured line, machine-readable, with no
 * formatted currency anywhere — a missing line at 03:15 IS the alert until a
 * real transport lands.
 */
@Injectable()
export class LoggingSummaryTransport implements SummaryTransport {
  private readonly logger = new Logger('OwnerSummary');

  send(payload: OwnerSummaryPayload): Promise<void> {
    this.logger.log(JSON.stringify(payload));
    return Promise.resolve();
  }
}
```

```typescript
// server/src/payments/dto/report-range-query.dto.ts
import type { CivilDate } from '../../common/time/gym-time';
import { IsGymDate } from '../../common/validators/is-gym-date.validator';

/**
 * Both bounds are inclusive gym-local civil dates, never @IsDateString(): a full
 * UTC instant arriving here is exactly how the timezone bug class returns, and
 * the columns being filtered are @db.Date.
 */
export class ReportRangeQueryDto {
  @IsGymDate()
  from!: CivilDate;

  @IsGymDate()
  to!: CivilDate;
}
```

- [ ] **Step 5: Run the transport test and watch it pass**

Run: `npm test --workspace=server -- summary-transport`
Expected: PASS

- [ ] **Step 6: Write the reports controller and wire the module**

```typescript
// server/src/payments/reports.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import {
  ReportsService,
  type GcashReferenceList,
  type StatutoryDiscountRegister,
} from './reports.service';
import { ReportRangeQueryDto } from './dto/report-range-query.dto';

/**
 * Routes 36 and 37. Both are staff-wide aggregates rather than per-member reads,
 * so neither carries @Scope: `payment.read` is granted only to FRONT_DESK and
 * ADMIN, both at ALL, and COACH holds no payment key at any scope.
 */
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('statutory-discounts')
  @RequirePermission('payment.read')
  async statutoryDiscounts(
    @Query() query: ReportRangeQueryDto,
  ): Promise<StatutoryDiscountRegister> {
    return this.reports.statutoryDiscounts(query);
  }

  @Get('gcash')
  @RequirePermission('payment.read')
  async gcash(@Query() query: ReportRangeQueryDto): Promise<GcashReferenceList> {
    return this.reports.gcashReferences(query);
  }
}
```

```typescript
// server/src/payments/payments.module.ts — add to the existing arrays.
//   controllers: [PaymentsController, ShiftsController, ReportsController],
//   providers: [
//     PaymentsService,
//     ShiftsService,
//     ReportsService,
//     { provide: SUMMARY_TRANSPORT, useClass: LoggingSummaryTransport },
//   ],
//   exports: [PaymentsService, ShiftsService, ReportsService, SUMMARY_TRANSPORT],
```

- [ ] **Step 7: Write the failing e2e for routes 36 and 37**

```typescript
// server/test/payments-shifts.e2e-spec.ts — APPEND this describe.
describe('reports (routes 36, 37)', () => {
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    plans = await seedPlansForTest(ctx.prisma);
    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    adminId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
    shiftId = await openShift(ctx.prisma, adminId, TODAY);
  });

  it('returns the BIR statutory register with centavo integers and the ID number', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    await ctx.prisma.payment.create({
      data: {
        userId: member.userId,
        membershipId: member.membershipId,
        planId: plans.MONTHLY,
        purpose: 'MEMBERSHIP',
        planCode: 'MONTHLY',
        planName: 'Monthly',
        grossCentavos: 80000,
        vatBaseCentavos: 80000,
        discountType: 'SENIOR',
        discountCentavos: 16000,
        netCentavos: 64000,
        vatExempt: false,
        statutoryIdNo: 'OSCA-2019-004412',
        termMonths: 1,
        termStartsOn: toDateColumn(TODAY),
        termEndsOn: toDateColumn(addDays(TODAY, 30)),
        method: 'CASH',
        receivedAt: new Date(),
        businessDate: toDateColumn(TODAY),
        shiftId,
        recordedById: adminId,
        idempotencyKey: 'report-senior-1',
        idempotencyHash: 'a'.repeat(64),
      },
    });

    const response = await request(server)
      .get(`/api/v1/reports/statutory-discounts?from=${TODAY}&to=${TODAY}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body.data.totalDiscountCentavos).toBe(16000);
    expect(response.body.data.rows).toHaveLength(1);
    expect(response.body.data.rows[0]).toMatchObject({
      discountType: 'SENIOR',
      statutoryIdNo: 'OSCA-2019-004412',
      grossCentavos: 80000,
      netCentavos: 64000,
      businessDate: TODAY,
    });
    expect(JSON.stringify(response.body)).not.toContain('₱');
  });

  it('lists GCash references for statement matching and excludes cash', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'QUARTERLY',
      today: TODAY,
    });

    await ctx.prisma.payment.create({
      data: {
        userId: member.userId,
        membershipId: member.membershipId,
        planId: plans.QUARTERLY,
        purpose: 'MEMBERSHIP',
        planCode: 'QUARTERLY',
        planName: 'Quarterly',
        grossCentavos: 220000,
        vatBaseCentavos: 220000,
        discountCentavos: 0,
        netCentavos: 220000,
        termMonths: 3,
        termStartsOn: toDateColumn(TODAY),
        termEndsOn: toDateColumn(addDays(TODAY, 90)),
        method: 'GCASH',
        reference: 'GC-8842019',
        receivedAt: new Date(),
        businessDate: toDateColumn(TODAY),
        shiftId,
        recordedById: adminId,
        idempotencyKey: 'report-gcash-1',
        idempotencyHash: 'b'.repeat(64),
      },
    });

    const response = await request(server)
      .get(`/api/v1/reports/gcash?from=${TODAY}&to=${TODAY}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body.data.totalCentavos).toBe(220000);
    expect(response.body.data.rows[0].reference).toBe('GC-8842019');
  });

  it('400s on an instant where a civil date is required', async () => {
    await request(server)
      .get('/api/v1/reports/gcash?from=2026-08-19T00:00:00Z&to=2026-08-19')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('refuses a COACH, who holds no payment key at any scope', async () => {
    const coachToken = await ctx.fixture.tokenFor('COACH', { supabaseId: FIXTURE_IDS.COACH_A });
    await request(server)
      .get(`/api/v1/reports/statutory-discounts?from=${TODAY}&to=${TODAY}`)
      .set('Authorization', `Bearer ${coachToken}`)
      .expect(403);
  });
});
```

- [ ] **Step 8: Run the e2e and watch it fail, then pass**

Run: `npm run test:e2e --workspace=server -- payments-shifts`
Expected: FAIL first with `expected 200 "OK", got 404 "Not Found"` if the module wiring in step 6 has not been applied; after step 6 is in place, PASS — four new cases green.

- [ ] **Step 9: Replace the nightly job's step-6 placeholder**

```typescript
// server/src/membership/membership-nightly.job.ts — constructor and emitOwnerSummary.
import { Inject, Injectable, Logger } from '@nestjs/common';
// …
import { ReportsService } from '../payments/reports.service';
import { SUMMARY_TRANSPORT, type SummaryTransport } from '../payments/summary-transport';

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly holds: MembershipHoldsService,
    private readonly reports: ReportsService,
    @Inject(SUMMARY_TRANSPORT) private readonly summary: SummaryTransport,
  ) {}

  /**
   * The job runs at 03:15, so the day that just closed is yesterday. Sending
   * fails loudly rather than silently: a missing summary is the de facto
   * monitor for this whole job.
   */
  private async emitOwnerSummary(today: CivilDate): Promise<NightlyStepResult> {
    const businessDate = addDays(today, -1);
    const payload = await this.reports.buildOwnerSummary(businessDate);
    await this.summary.send(payload);

    return {
      step: 'emitOwnerSummary',
      matched: 1,
      changed: 0,
      note: `summary sent for ${businessDate}`,
    };
  }
```

```typescript
// server/src/membership/membership.module.ts — PaymentsModule must be imported
// (it already is, for PaymentsService in tasks 12 and 14); ReportsService and
// SUMMARY_TRANSPORT now come from its exports. No new import line is needed.
```

- [ ] **Step 10: Assert step 6 in the nightly e2e**

```typescript
// server/test/membership-nightly.e2e-spec.ts — APPEND this test.
it('hands a populated owner summary for YESTERDAY to the transport in one line', async () => {
  const member = await makeMember(ctx.prisma, {
    state: 'ACTIVE',
    planCode: 'MONTHLY',
    today: TODAY,
  });
  expect(member.membershipId).not.toBeNull();

  const result = await job.runFor(TODAY, NOW);
  const step = result.steps.find((s) => s.step === 'emitOwnerSummary');

  expect(step).toMatchObject({ matched: 1, changed: 0 });
  expect(step!.note).toBe(`summary sent for ${addDays(TODAY, -1)}`);
});
```

- [ ] **Step 11: Run both suites and watch them pass**

Run: `npm run test:e2e --workspace=server -- membership-nightly` then `npm run typecheck --workspace=server`
Expected: PASS, and typecheck exits 0.

- [ ] **Step 12: Commit**

```bash
git add server/src/payments/reports.service.ts \
        server/src/payments/reports.controller.ts \
        server/src/payments/summary-transport.ts \
        server/src/payments/summary-transport.spec.ts \
        server/src/payments/dto/report-range-query.dto.ts \
        server/src/payments/payments.module.ts \
        server/src/membership/membership-nightly.job.ts \
        server/test/payments-shifts.e2e-spec.ts \
        server/test/membership-nightly.e2e-spec.ts
git commit -m "feat(payments): statutory and GCash registers plus the owner nightly summary (routes 36-37)"
```

---

### Task 18: Portal subscription screen goes live

**Files:**
- Modify: `client/src/lib/portalData.ts:1-17` (header + type block), `:17-26` (`MembershipState` / `Membership` → the quarantined mock shape), `:109-113` (`SubscriptionData`), `:172-179` (`MEMBERSHIP` const), `:292-368` (`getSubscription`)
- Modify: `client/src/app/portal/subscription/page.tsx:1-208` (full rewrite of the screen against the live payload)
- Modify: `client/src/app/portal/pay/page.tsx:4` and `:15` — `/portal/pay` is rebuilt at §9.11 step 3 and still consumes the mock; it moves to `getPayMock()` / `PayMockData` in this same commit so the tree compiles. Nothing else on that page changes.
- Test: `client/src/lib/portalData.test.ts`

**Interfaces:**
- Consumes: `GET /api/v1/me/overview` → `MemberOverview`; `GET /api/v1/me/membership` → `MyMembership`; `GET /api/v1/me/payments` → `PaginatedData<PaymentSummary>` (task 11) · `GET /api/v1/plans` → `PublicPlan[]` (task 8) · `client/src/lib/api.ts`: `apiFetch`, `ApiError` with `status`/`code` (Chunk 0) · `client/src/lib/gymTime.ts`: the client-side `CivilDate` helpers (Chunk 0) · `@got/shared`: `MembershipStatus`, `PlanKind`, `PaymentMethod`, `PaymentStatus`, `DiscountType`, `AccessDecision`, `AllowReason`, `DenialReason`, `AccessVerdict` (task 1)
- Produces: `getSubscription(): Promise<SubscriptionView>` — a live `apiFetch` call; the `MembershipState` union, the `MEMBERSHIP` mock and the payments mock are deleted in the same commit · `formatCentavos(centavos: number): string` — the ONLY place a peso string is composed, client-side, from an integer the server sent · `/portal/subscription` renders the real four-value `MembershipStatus` vocabulary plus the server's `AccessResult.message`

---

- [ ] **Step 1: Write the failing test**

```typescript
// client/src/lib/portalData.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { apiFetch } from './api';
import { formatCentavos, formatCivilDate, getSubscription } from './portalData';

const MEMBERSHIP = {
  id: 'm1',
  userId: 'u1',
  memberCode: 'K7QX2M',
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  planId: 'p1',
  planCode: 'MONTHLY',
  planName: 'Monthly',
  status: 'ACTIVE',
  startsOn: '2026-08-01',
  endsOn: '2026-08-31',
  graceDays: 3,
  cancelRequestedOn: null,
  decision: 'ALLOW',
  allowReason: 'MEMBERSHIP_ACTIVE',
  denialReason: null,
  daysRemaining: 12,
  planPriceCentavos: 80000,
  termMonths: 1,
  billingAnchorDay: 1,
  joinedOn: '2024-03-15',
  cancelledOn: null,
  graceAdmissionsThisTerm: 0,
  freezesUsedThisTerm: 0,
  guestPassesPerTerm: 0,
  guestPassesRemaining: 0,
  purchasedAt: '2026-08-01T02:14:00.000Z',
  verdict: {
    decision: 'ALLOW',
    verdict: 'ALLOWED',
    allowReason: 'MEMBERSHIP_ACTIVE',
    denialReason: null,
    message: 'Monthly — active until 31 Aug (12 days left). Let them in.',
    relevantDate: '2026-08-31',
    daysRemaining: 12,
    graceDaysRemaining: 0,
    offer: 'NONE',
  },
  hold: null,
  events: [],
};

describe('formatCentavos', () => {
  it('composes the only peso string in the system, from an integer the server sent', () => {
    expect(formatCentavos(80000)).toBe('₱800.00');
    expect(formatCentavos(9000)).toBe('₱90.00');
    expect(formatCentavos(220000)).toBe('₱2,200.00');
    expect(formatCentavos(750000)).toBe('₱7,500.00');
  });

  it('renders a ₱0 comp rather than an empty cell', () => {
    expect(formatCentavos(0)).toBe('₱0.00');
  });

  it('renders sub-peso centavos exactly — 20% of a VAT base is rarely round', () => {
    expect(formatCentavos(14285)).toBe('₱142.85');
  });
});

describe('formatCivilDate', () => {
  it('formats a server civil date with UTC accessors, never the device zone', () => {
    expect(formatCivilDate('2026-08-31')).toBe('31 Aug 2026');
    // 00:00–08:00 Manila is the previous UTC day: the old iso() bug. A civil
    // date must not shift no matter what the browser thinks the time is.
    expect(formatCivilDate('2026-01-01')).toBe('1 Jan 2026');
  });
});

describe('getSubscription', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls the three live endpoints and returns the server verdict verbatim', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ membership: MEMBERSHIP, verdict: MEMBERSHIP.verdict })
      .mockResolvedValueOnce([
        {
          id: 'p1',
          code: 'MONTHLY',
          name: 'Monthly',
          description: null,
          kind: 'TERM',
          priceCentavos: 80000,
          termMonths: 1,
          guestPassesPerTerm: 0,
          perks: [],
          sortOrder: 1,
        },
      ])
      .mockResolvedValueOnce({
        items: [
          {
            id: 'pay1',
            businessDate: '2026-08-01',
            netCentavos: 80000,
            method: 'GCASH',
            status: 'RECORDED',
            reference: 'GC-8842019',
          },
        ],
        page: 1,
        limit: 12,
        total: 1,
        totalPages: 1,
      });

    const data = await getSubscription();

    expect(vi.mocked(apiFetch).mock.calls.map((call) => call[0])).toEqual([
      '/me/membership',
      '/plans',
      '/me/payments?page=1&limit=12',
    ]);
    expect(data.membership?.status).toBe('ACTIVE');
    expect(data.verdict.message).toBe(MEMBERSHIP.verdict.message);
    expect(data.plans[0].priceCentavos).toBe(80000);
    expect(data.payments[0].netCentavos).toBe(80000);
  });

  it('renders "no membership" as a valid state rather than an error', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({
        membership: null,
        verdict: {
          decision: 'DENY',
          verdict: null,
          allowReason: null,
          denialReason: 'NO_MEMBERSHIP',
          message: 'No plan on file. Ask the front desk — Monthly is ₱800.',
          relevantDate: null,
          daysRemaining: null,
          graceDaysRemaining: 0,
          offer: 'RENEW',
        },
      })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ items: [], page: 1, limit: 12, total: 0, totalPages: 0 });

    const data = await getSubscription();

    expect(data.membership).toBeNull();
    expect(data.verdict.denialReason).toBe('NO_MEMBERSHIP');
    expect(data.payments).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm test --workspace=client -- portalData`
Expected: FAIL — `No "formatCentavos" export is defined on the "/src/lib/portalData.ts" mock` / `TypeError: formatCentavos is not a function`

- [ ] **Step 3: Flip `portalData.ts` to the live API**

```typescript
// client/src/lib/portalData.ts — replace the header, the membership/subscription
// types (lines 17-26 and 109-113), the MEMBERSHIP const (172-179) and
// getSubscription (292-368) with the following. Everything else in the file —
// schedule, coaches, progress, announcements — is untouched mock and stays.

import {
  DiscountType,
  MembershipStatus,
  PaymentMethod,
  PaymentStatus,
  PlanKind,
  type AccessDecision,
  type AllowReason,
  type AccessVerdict,
  type CivilDate,
  type DenialReason,
} from '@got/shared';
import { apiFetch } from './api';
import { localCivilDate } from './date';
import { toDateColumn } from './gymTime';

// ── Live contracts (mirror the server presenters; see §5.11) ──────────

export interface PublicPlan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  kind: PlanKind;
  priceCentavos: number;
  termMonths: number | null;
  guestPassesPerTerm: number;
  perks: string[];
  sortOrder: number;
}

export interface AccessResult {
  decision: AccessDecision;
  verdict: AccessVerdict | null;
  allowReason: AllowReason | null;
  denialReason: DenialReason | null;
  message: string;
  relevantDate: CivilDate | null;
  daysRemaining: number | null;
  graceDaysRemaining: number;
  offer: 'NONE' | 'RENEW' | 'UNFREEZE' | 'OVERRIDE' | 'MANAGER';
}

export interface MembershipDetail {
  id: string;
  planCode: string;
  planName: string;
  planPriceCentavos: number;
  termMonths: number;
  status: MembershipStatus;
  startsOn: CivilDate;
  endsOn: CivilDate;
  graceDays: number;
  cancelRequestedOn: CivilDate | null;
  daysRemaining: number | null;
  guestPassesRemaining: number;
  verdict: AccessResult;
}

export interface PaymentSummary {
  id: string;
  businessDate: CivilDate;
  netCentavos: number;
  method: PaymentMethod;
  status: PaymentStatus;
  discountType: DiscountType;
  reference: string | null;
  receiptNo: string | null;
}

export interface SubscriptionView {
  membership: MembershipDetail | null;
  verdict: AccessResult;
  plans: PublicPlan[];
  payments: PaymentSummary[];
}

interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ── Formatting — the client's only job (spec 3.3 rule 1) ─────────────

const PESO = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });

/**
 * The ONE place a peso string is composed, from an integer of centavos the
 * server sent. No response body anywhere carries a formatted currency string,
 * so no screen may invent a second formatting rule.
 */
export function formatCentavos(centavos: number): string {
  return PESO.format(centavos / 100);
}

/**
 * A server civil date, formatted with UTC accessors.
 *
 * A @db.Date arrives as 'yyyy-mm-dd' and means a gym-local business day. Reading
 * it with device-local accessors is the iso() bug: every 00:00–08:00 Manila
 * render would show the previous day.
 */
export function formatCivilDate(day: CivilDate | string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(toDateColumn(day as CivilDate));
}

// ── Live API ─────────────────────────────────────────────────────────

/**
 * §9.11 steps 1 and 2: membership, plans and payments all come from the server.
 * There is no mock branch and no flag — the screen flips fully or not at all.
 */
export async function getSubscription(): Promise<SubscriptionView> {
  const [mine, plans, payments] = await Promise.all([
    apiFetch<{ membership: MembershipDetail | null; verdict: AccessResult }>('/me/membership'),
    apiFetch<PublicPlan[]>('/plans'),
    apiFetch<Paginated<PaymentSummary>>('/me/payments?page=1&limit=12'),
  ]);

  return {
    membership: mine.membership,
    verdict: mine.verdict,
    plans,
    payments: payments.items,
  };
}

// ── Quarantined mock, for the screens that have not flipped yet ──────

/**
 * Consumed ONLY by getDashboard() (§9.11 step 4), getQrData() (step 5) and
 * getPayMock() (step 3). Each of those screens flips in Chunk 2 and deletes its
 * share; nothing here may be imported by a live screen.
 */
export interface MockMembership {
  planName: string;
  priceLabel: string;
  daysRemaining: number;
  daysTotal: number;
  renewsOn: string;
}

const MOCK_MEMBERSHIP: MockMembership = {
  planName: 'Monthly',
  priceLabel: '₱800',
  daysRemaining: 14,
  daysTotal: 30,
  renewsOn: 'Aug 28, 2026',
};

export interface PayMockData {
  plans: PlanOption[];
  payments: PaymentRecord[];
}

/** Kept verbatim from the old getSubscription() mock. Dies at §9.11 step 3. */
export async function getPayMock(): Promise<PayMockData> {
  return delay({
    plans: [
      {
        id: 'walkin',
        name: 'Walk-in',
        price: '₱90',
        perMonth: null,
        saves: null,
        current: false,
        perks: ['Full gym floor access', 'Zero commitment', 'Pay at the door'],
      },
      {
        id: 'monthly',
        name: 'Monthly',
        price: '₱800',
        perMonth: '₱800 / mo',
        saves: null,
        current: true,
        perks: ['Unlimited gym access', 'All group classes', 'Locker & shower'],
      },
      {
        id: 'quarterly',
        name: 'Quarterly',
        price: '₱2,200',
        perMonth: '₱733 / mo',
        saves: 'Save ₱200',
        current: false,
        perks: ['Everything in Monthly', '1 free PT session', 'Priority booking'],
      },
      {
        id: 'annual',
        name: 'Annual',
        price: '₱7,500',
        perMonth: '₱625 / mo',
        saves: 'Save ₱2,100',
        current: false,
        perks: ['Everything in Quarterly', '2 guest passes / month', 'Free member tee'],
      },
    ],
    payments: [
      {
        id: 'p1',
        date: 'Jul 28, 2026',
        amount: '₱800',
        method: 'GCash',
        status: 'paid',
        reference: 'GC-8842019',
      },
      {
        id: 'p2',
        date: 'Jun 28, 2026',
        amount: '₱800',
        method: 'GCash',
        status: 'paid',
        reference: 'GC-8712445',
      },
      {
        id: 'p3',
        date: 'May 28, 2026',
        amount: '₱800',
        method: 'Counter',
        status: 'paid',
        reference: 'CTR-00381',
      },
      {
        id: 'p4',
        date: 'Apr 28, 2026',
        amount: '₱800',
        method: 'GCash',
        status: 'paid',
        reference: 'GC-8501277',
      },
    ],
  });
}

// DashboardData.membership and QrData.membership now read `MockMembership`, and
// their bodies use MOCK_MEMBERSHIP where they used MEMBERSHIP. The
// `MembershipState` union, the `Membership` interface, the `MEMBERSHIP` const
// and the old `SubscriptionData` type are deleted.
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm test --workspace=client -- portalData`
Expected: PASS — 7 tests green.

- [ ] **Step 5: Point `/portal/pay` at the quarantined mock so the tree compiles**

```typescript
// client/src/app/portal/pay/page.tsx:4
import { getPayMock, type PayMockData } from '@/lib/portalData';

// client/src/app/portal/pay/page.tsx:15
  const [data, setData] = useState<PayMockData | null>(null);

// …and line 26's call becomes:
//   void getPayMock().then(setData);
// Nothing else on this screen changes: it is rebuilt at §9.11 step 3, in Chunk 2.
```

- [ ] **Step 6: Rewrite the subscription screen against the live payload**

```tsx
// client/src/app/portal/subscription/page.tsx — full replacement.
'use client';

import { useEffect, useState } from 'react';
import { MembershipStatus, PaymentStatus } from '@got/shared';
import {
  formatCentavos,
  formatCivilDate,
  getSubscription,
  type SubscriptionView,
} from '@/lib/portalData';
import { ApiError } from '@/lib/api';
import { Badge, Card, CardHead, EmptyState, ProgressRing, Skeleton } from '@/components/portal/ui';
import type { BadgeTone } from '@/components/portal/ui';
import { IconArrow } from '@/components/portal/icons';

/**
 * The four-value vocabulary, verbatim. There is no "expiring" status: grace is a
 * date, and how worried to be is the server's AccessResult, not a date the
 * browser re-derives (spec 3.3 rule 1).
 */
const STATUS_LABEL: Record<MembershipStatus, string> = {
  [MembershipStatus.ACTIVE]: 'Active',
  [MembershipStatus.EXPIRED]: 'Expired',
  [MembershipStatus.FROZEN]: 'Frozen',
  [MembershipStatus.CANCELLED]: 'Cancelled',
};

const DECISION_TONE: Record<string, BadgeTone> = {
  ALLOW: 'ok',
  GRACE: 'warn',
  DENY: 'danger',
};

const PAYMENT_TONE: Record<PaymentStatus, BadgeTone> = {
  [PaymentStatus.RECORDED]: 'ok',
  [PaymentStatus.VOIDED]: 'danger',
};

export default function SubscriptionPage() {
  const [data, setData] = useState<SubscriptionView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getSubscription()
      .then(setData)
      .catch((cause: unknown) => {
        setError(
          cause instanceof ApiError
            ? cause.message
            : 'We could not load your membership. Try again in a moment.',
        );
      });
  }, []);

  if (error) {
    return <EmptyState title="Membership unavailable" hint={error} />;
  }

  if (!data) {
    return (
      <div style={{ display: 'grid', gap: 18 }}>
        <Skeleton height={200} />
        <Skeleton height={260} />
      </div>
    );
  }

  const { membership, verdict, plans, payments } = data;
  const tone = DECISION_TONE[verdict.decision] ?? 'neutral';

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <Card>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center' }}>
          <div style={{ flex: '1 1 300px', minWidth: 0 }}>
            <div className="p-card-title">Current plan</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 10 }}>
              <span className="p-h1">{membership?.planName ?? 'No plan'}</span>
              {membership && <Badge tone={tone}>{STATUS_LABEL[membership.status]}</Badge>}
            </div>

            {membership && (
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span
                  style={{
                    fontFamily: 'var(--font-heading)',
                    fontWeight: 800,
                    fontSize: 30,
                    color: 'var(--p-ink)',
                  }}
                >
                  {formatCentavos(membership.planPriceCentavos)}
                </span>
                <span className="p-muted">
                  per {membership.termMonths === 1 ? 'month' : `${membership.termMonths} months`}
                </span>
              </div>
            )}

            {/* The server's sentence, rendered verbatim: one source of truth for
                what happened and what to do, shared with the desk. */}
            <p className="p-muted" style={{ marginTop: 10 }}>
              {verdict.message}
            </p>

            {membership && (
              <p className="p-muted" style={{ marginTop: 4 }}>
                Access runs to {formatCivilDate(membership.endsOn)}
                {membership.cancelRequestedOn
                  ? ` — cancelling, notice given ${formatCivilDate(membership.cancelRequestedOn)}.`
                  : '.'}
              </p>
            )}

            {verdict.offer === 'RENEW' && (
              <button
                type="button"
                className="p-btn p-btn-gold"
                style={{ marginTop: 18, padding: '13px 28px' }}
              >
                Renew at the front desk
                <IconArrow />
              </button>
            )}
          </div>

          {membership && verdict.daysRemaining !== null && (
            <div style={{ marginInline: 'auto', flex: 'none' }}>
              <ProgressRing
                remaining={verdict.daysRemaining}
                total={membership.termMonths * 30}
                size={128}
              />
            </div>
          )}
        </div>
      </Card>

      <div>
        <h2 className="p-h2" style={{ marginBottom: 4 }}>
          Plans
        </h2>
        <p className="p-muted" style={{ marginBottom: 16 }}>
          Longer terms cost less per month. Ask the front desk to switch — it takes effect at your
          next renewal.
        </p>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))',
            gap: 14,
          }}
        >
          {plans.map((plan) => {
            const current = plan.code === membership?.planCode;
            return (
              <Card
                key={plan.id}
                hover={!current}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  borderColor: current ? 'var(--gold)' : undefined,
                  boxShadow: current ? '0 0 0 1px var(--gold), var(--p-shadow)' : undefined,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24 }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: '0.16em',
                      textTransform: 'uppercase',
                      color: 'var(--p-ink3)',
                    }}
                  >
                    {plan.name}
                  </span>
                  {current && <Badge tone="warn">Current</Badge>}
                </div>

                <div
                  style={{
                    fontFamily: 'var(--font-heading)',
                    fontWeight: 800,
                    fontSize: 32,
                    lineHeight: 1,
                    letterSpacing: '-0.02em',
                    color: 'var(--p-ink)',
                  }}
                >
                  {formatCentavos(plan.priceCentavos)}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--gold-dark)', minHeight: 18 }}>
                  {plan.termMonths ? `${plan.termMonths}-month term` : 'Single visit'}
                </div>
              </Card>
            );
          })}
        </div>
      </div>

      <Card padded={false}>
        <CardHead title="Payment history" />
        <div style={{ overflowX: 'auto' }}>
          <table className="p-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Amount</th>
                <th>Method</th>
                <th>Reference</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id}>
                  <td style={{ whiteSpace: 'nowrap', color: 'var(--p-ink)' }}>
                    {formatCivilDate(payment.businessDate)}
                  </td>
                  <td className="p-num" style={{ fontWeight: 600, color: 'var(--p-ink)' }}>
                    {formatCentavos(payment.netCentavos)}
                  </td>
                  <td>{payment.method === 'GCASH' ? 'GCash' : 'Cash'}</td>
                  <td className="p-num" style={{ fontSize: 12.5, color: 'var(--p-ink3)' }}>
                    {payment.reference ?? payment.receiptNo ?? '—'}
                  </td>
                  <td>
                    <Badge tone={PAYMENT_TONE[payment.status]}>
                      {payment.status === PaymentStatus.RECORDED ? 'paid' : 'voided'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
```

- [ ] **Step 7: Run the whole client suite and the typecheck**

Run: `npm test --workspace=client` then `npm run typecheck --workspace=client`
Expected: PASS — 53 pre-existing tests plus the 7 new ones, and typecheck exits 0 (run `npm run dev:client` or `build:client` once first if `.next/types` has not been generated).

- [ ] **Step 8: Commit**

```bash
git add client/src/lib/portalData.ts \
        client/src/lib/portalData.test.ts \
        client/src/app/portal/subscription/page.tsx \
        client/src/app/portal/pay/page.tsx
git commit -m "feat(portal): subscription screen reads the live membership, plans and payments"
```

---

## Exit Criteria

Every item names the command that proves it. Nothing here is satisfied by inspection.

**Schema and migration**

- [ ] The eleven §5.2 enums exist in the Prisma client and are mirrored where §5.2 says: `npm test --workspace=server -- enum-parity` (ten pairs, `PENDING_PRISMA_MIRRORS` down to `CheckInMethod` only).
- [ ] Six tables plus the `User` delta apply from a clean database and seed: `cd server && npx prisma migrate reset --force && npm run db:seed --workspace=server`.
- [ ] No drift: `cd server && npx prisma migrate diff --from-schema-datasource prisma/schema/schema.prisma --to-schema-datamodel prisma/schema --exit-code` exits 0.
- [ ] No partial unique index exists anywhere in this chunk: `cd server && npx prisma db execute --stdin <<< "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexdef ILIKE '%UNIQUE%WHERE%';"` returns no rows.
- [ ] Every §5.8 `CHECK`, the `EXCLUDE`, both nullable-unique sentinels and the append-only trigger are PRESENT in the applied database, and each maps to its §5.8.6 code and status: `npm run test:e2e --workspace=server -- membership-constraints`.
- [ ] The append-only trigger stays unmapped, so it surfaces as a logged 500: same suite, `leaves the trigger UNMAPPED` case, plus `npm test --workspace=server -- prisma-error.mapper`.

**The pure core (§5.12)**

- [ ] `accessVerdict()` answers all eleven §5.4.4 rows with the right decision, reason and offer, both boundary triples, the 23:59/00:01 Manila pair, both self-heals, account-gate-beats-entitlement, entitlement-beats-membership-state and grace exhaustion: `npm test --workspace=server -- access-verdict`.
- [ ] The same file reads no clock, no config and no Prisma runtime import: the three purity assertions in that suite, plus `npx --no-install rg -n "new Date\(|GymConfigService|PrismaService" server/src/membership/{access-verdict,membership-terms,membership-transitions,membership-freeze-rules}.ts` returning nothing.
- [ ] Anniversary billing holds across the Jan-31 four-term table, the leap cycle to 2032, and quarterly/annual from a 31st anchor: `npm test --workspace=server -- "gym-time|membership-terms"`.
- [ ] The four §5.7.3 renewal cases produce the asserted `startsOn`/`endsOn`/`billingAnchorDay`: same suite, plus the route-level proof in `npm run test:e2e --workspace=server -- memberships`.
- [ ] SENIOR/PWD arithmetic is exact to the centavo in both VAT modes and `net = vatBase − discount` in every branch: `npm test --workspace=server -- membership-terms`.
- [ ] All four freeze-arithmetic cases hold and applying twice is unrepresentable: same suite, plus `npm test --workspace=server -- membership-freeze-rules`.
- [ ] `assertTransition` accepts every §5.5.2 row and refuses every §5.5.3 status pair with `MEMBERSHIP_INVALID_TRANSITION` at 422, never a silent no-op: `npm test --workspace=server -- membership-transitions`.

**Routes**

- [ ] Routes 5–9 answer, the public list hides archived plans and carries no operational columns, and a re-seed reverts no price: `npm run test:e2e --workspace=server -- plans`.
- [ ] Routes 10–12 answer keylessly against the caller's own userId and `/me/membership` never 404s: `npm run test:e2e --workspace=server -- memberships`.
- [ ] Routes 20–32 answer, the scope-leak matrix passes (COACH_A sees only assigned, COACH_B's member is 404 not 403, FRONT_DESK at ALL sees both), and the `payments` field is gated on resolved `payment.read`: same suite.
- [ ] Routes 33–40 answer: an idempotent duplicate sale writes one row and returns 200, a same-key different-body request returns 409 `IDEMPOTENCY_KEY_REUSED` with no second row, a sale with no open shift returns 422 `SHIFT_NOT_OPEN`, the blind close discloses `expectedCentavos` only in its response, and a FRONT_DESK caller is refused a `GOODWILL` discount: `npm run test:e2e --workspace=server -- payments-shifts`.
- [ ] Route 41 answers behind `job.run` + `confirm`, and every dangerous route without `confirm` is a 400 `CONFIRMATION_REQUIRED`: `npm run test:e2e --workspace=server -- "membership-nightly|memberships"`.
- [ ] Every business denial is a payload field, never an HTTP error: no route in this chunk returns a non-2xx for an access decision — proven by `accessVerdict` never throwing (its suite) and by no `/memberships` read returning 4xx for a DENY row.

**Behaviour §5 names explicitly**

- [ ] A same-day freeze flips the status AND extends `endsOn` in one transaction; a future-dated one leaves `SCHEDULED` with `daysApplied = 0`: `npm run test:e2e --workspace=server -- memberships`.
- [ ] An early release claws back exactly the unused days; completing on time does no date arithmetic: same suite, plus `npm run test:e2e --workspace=server -- membership-nightly`.
- [ ] A MONTHLY plan is refused with 422 `PLAN_NOT_FREEZABLE`, and `membership.freeze` is refused to FRONT_DESK with 403: same suite.
- [ ] The legacy import writes `User` + `memberCode` + `Membership` + one `IMPORTED` event and **zero** `Payment` rows, and re-importing creates nothing: same suite.
- [ ] A `batchRef` extension moves no `endsOn` twice: same suite (`affected: 2` then `affected: 0`).
- [ ] Running the nightly job twice against one fixture yields identical state and no duplicated events, and a three-day catch-up equals three sequential runs with `effectiveAt` on the day the transition should have happened: `npm run test:e2e --workspace=server -- membership-nightly`.
- [ ] `SCHEDULER_ENABLED=false` registers zero jobs, and both jobs are registered with the gym timezone otherwise: `npm test --workspace=server -- scheduler`.
- [ ] Step 6 hands a fully-populated `OwnerSummaryPayload` to `LoggingSummaryTransport` in one structured line with no peso string: `npm test --workspace=server -- summary-transport` and the step-6 case in the nightly e2e.
- [ ] The BIR statutory register and the GCash list answer over an `IsGymDate`-bounded range and 400 on a full instant: `npm run test:e2e --workspace=server -- payments-shifts`.

**Contract, configuration and hygiene**

- [ ] Seventeen new permission keys seed with a valid transitive `requires` closure, CLIENT holds none of the `membership.*` / `payment.* `/ `shift.*` keys, `membership.freeze` is ADMIN-only, and `payment.discount.grant` is ADMIN-only: `npm test --workspace=server -- permission-registry` and `npm run db:seed --workspace=server`.
- [ ] The four new operating parameters validate at startup and are exposed on `GymConfigService`; no service reads `process.env` at a call site: `npm test --workspace=server -- env.validation` and `npx --no-install rg -n "process\.env\[" server/src --glob '!**/config/**'` returning nothing new.
- [ ] `DomainErrorCode` admits every code this chunk throws, and `shared` builds: `npm run build --workspace=shared`.
- [ ] The `@ts-expect-error` scope proofs hold — a bare `WhereInput` and a spread scope are both compile errors: `npm run typecheck --workspace=server` exits 0 with no `Unused '@ts-expect-error' directive`.
- [ ] No formatted currency string leaves the server: `npx --no-install rg -n "₱|toLocaleString\(|Intl\.NumberFormat" server/src` returns nothing outside comments.
- [ ] `toISOString().slice(0,10)` appears only inside `civilDateFromPrisma`: `npx --no-install rg -n "toISOString\(\)\.slice" server/src` returns exactly one hit, in `common/time/gym-time.ts`.
- [ ] `startDate`, `endDate` and `startedOn` appear nowhere: `npx --no-install rg -n "startDate|endDate|startedOn" server/src server/prisma client/src` returns nothing.
- [ ] No `DayPass` model or table was introduced: `npx --no-install rg -n "model DayPass|dayPass\." server/prisma server/src` returns only the `DayPassResolver` seam and `dayPassValidToday`.
- [ ] `/portal/subscription` renders from the live API with no mock code path left in the file, and the centavos/civil-date formatting is covered: `npm test --workspace=client` and `npx --no-install rg -n "MEMBERSHIP|MembershipState" client/src/app/portal/subscription/page.tsx` returning nothing.
- [ ] The whole tree is green and the baselines held: `npm test --workspace=server && npm run test:e2e --workspace=server && npm test --workspace=client && npm run typecheck --workspace=server` — server unit ≥ 29 suites (baseline 271 tests plus this chunk's), e2e ≥ 37 plus five new suites, client ≥ 53 plus 7, typecheck exit 0. `npm run lint` remains red with its ~19–27 pre-existing problems and no new ones attributable to this chunk.
