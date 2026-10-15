# Gym of Thrones — Admin Dashboard Redesign

**Date:** 2026-08-24
**Status:** Approved for planning
**Scope:** `/admin` (the CRM dashboard) and the one new endpoint it needs. Nothing else on `/admin/*` changes.
**Builds on:** `docs/superpowers/specs/2026-08-18-membership-attendance-design.md` (chunks 0–2 shipped). Every endpoint this document consumes exists and was verified live against a running server on 2026-08-24, except `GET /admin/check-ins/daily`, which §5 specifies.

The dashboard is the first screen a gym admin opens and the one they glance at fifty times a shift. Today it fails that job in two directions at once: it decorates numbers that need no decoration, and it shows a card of advice that no endpoint produced. This document replaces it with a command centre whose every pixel is either an operational fact or a control that changes one.

The redesign is deliberately **one page plus one endpoint**. The remaining admin surfaces — Members, Subscriptions, Payments, Attendance, Coaches, Stations, Settings — and the business workflow that connects them are a larger arc that gets its own spec. Widening this one would produce a document nobody finishes reading and a branch nobody can review.

---

## 1. Why this exists

### 1.1 What is wrong with the current page

`client/src/app/admin/page.tsx` is 453 lines. The defects are not stylistic preferences; each one costs the operator something.

| Defect | Evidence | What it costs |
|---|---|---|
| **Decoration outweighs information** | Ten tinted icon chips — `a-qa-icon--{green,blue,amber,purple,rose,teal}` and `a-kpi-icon--{green,blue,amber,warn,danger,muted}` | Colour is spent on decoration, so when the *denials* tile turns red it reads as one more colour rather than as an alarm. A palette that is always loud cannot get louder. |
| **Emoji in a staff console** | `page.tsx:107` (`👋`), `page.tsx:440` (`💡`) | The console is projected on a back-office monitor and shown to prospective franchisees. Emoji reads as unfinished. |
| **A card sourced from nothing** | `page.tsx:440` — the "Quick tip" panel is a hard-coded string | Directly violates the CRM rule in `CLAUDE.md`: *"Every tile, column and toggle on `/admin` is backed by a real endpoint, or it is cut."* It is the only element on the page a reader cannot trace to data, which is exactly how a screen loses the benefit of the doubt on the numbers that *are* real. |
| **Quick Actions are not actions** | Six `<Link>`s to `/admin/{attendance,members,payments,stations,subscriptions,coaches}` | Every one duplicates a sidebar link two inches away. The row occupies the most valuable band on the page and saves nobody a click. |
| **The headline number is delayed on purpose** | `page.tsx:82-95` — a `setInterval` counts "in the gym now" up from zero in 30 ms steps | The one number an admin wants in under a second takes up to 600 ms to arrive, and it animates again on every refetch. |
| **No time dimension anywhere** | No chart on the page; no endpoint returns a series | "87 check-ins today" is unreadable without "and 62 last Monday". The admin cannot tell a good day from a bad one. |
| **Shift state is invisible** | `/shifts/current` exists and is called by nothing on this page | The drawer stays open overnight because nothing on the screen the operator actually looks at says it is open. |

### 1.2 What already exists and is good

Worth naming, because the redesign builds on it rather than replacing it.

- **`useAdminQuery`** (`client/src/lib/useAdminQuery.ts`) already solves stale-response ordering with a monotonic sequence guard and keeps previous data on screen during refetch. Every panel below uses it unchanged.
- **`adminApi`** (`client/src/lib/adminApi.ts`) is the typed read surface, one function per endpoint. New calls are added here, never inline in a component.
- **`portal.css`** owns the tokens. The CRM is `.portal-root .admin-root`; `admin.css` adds only CRM-specific pieces. This redesign adds to `admin.css` and touches `portal.css` **not at all**.
- **`CheckIn.businessDate`** is a `@db.Date` column holding the gym-local civil date, carrying `@@index([businessDate])` and the comment *"Nightly report / whole-gym queries by gym-local day."* §5 is cheap because of that decision.

### 1.3 Owner decisions recorded 2026-08-24

| # | Decision |
|---|---|
| 1 | The calendar shows **renewals and expiries**, not classes. There is no class/session/booking model and this redesign does not add one. |
| 2 | Quick actions become **real actions in modals**, not navigation. *(Amended during implementation: three actions, not four — see §6.)* |
| 3 | A **check-ins-per-day endpoint is in scope** so the attendance trend is real. |
| 4 | The **gold/warm-neutral design system stays**. The reference's layout is adopted; its lavender palette is not. `CLAUDE.md`'s "do not start a fourth design system" holds. |
| 5 | The "Needs you" queue is a **full-width band** under the KPI row, not a right-rail panel. |
| 6 | **Reuse before adding.** Where a capability exists it is extended or extracted, never re-implemented. This is why the member search is lifted out of the Members page rather than written again (§6.1), why polling is an argument to `useAdminQuery` rather than a new hook (§4.1), and why only three functions are added to `adminApi` (§6). |
| 7 | **Scope is the dashboard.** Chunk 2 is in flight in a separate session and owns the desk console. No file under `client/src/app/desk/` is touched and no `/front-desk/*` endpoint is added (§12). |

---

## 2. Design principles

Four rules. Each exists because the current page breaks it.

**2.1 — Nothing renders that no endpoint produced.** Restating the `CLAUDE.md` rule because this redesign is where it was broken. If a panel cannot name its endpoint, it is cut and listed in §11 as missing. This is why there is no "revenue target", no "member satisfaction", and no tip card.

**2.2 — Icons appear in exactly two places.** The sidebar rail, and inside a button whose label already says the same thing. **KPI tiles get no icon at all.** An icon next to the number "342" tells the reader nothing the word "Members" did not, and six of them side by side turn a data row into a sticker album.

**2.3 — Colour is a signal, never a finish.** The palette is warm neutral: `--p-paper` `#ffffff`, `--p-paper2` `#f5f4f2`, ink `#1a1a1a`/`#4a4a4a`/`#82807c`. Gold `#c9922a` marks the single primary action and today's date. The semantic four — `--p-ok` `#1a6637`, `--p-warn` `#8a6018`, `--p-danger` `#8c1a14`, `--p-info` `#1a3a8c` — appear **only** on a value that is genuinely good, expiring, wrong, or informational. A tile with nothing to say is black on white.

**2.4 — The page answers three questions, in this order.** *What needs me right now* → *how is today going* → *what is coming*. Layout order follows that and nothing is placed for balance.

---

## 3. Layout

```
┌──────────┬────────────────────────────────────────────────────────────┐
│ SIDEBAR  │ TOPBAR   Dashboard    [Shift open · 8:02 AM]  Admin ▸ AT   │
│ (dark,   ├────────────────────────────────────────────────────────────┤
│  icons   │ Good afternoon      [Check-in] [Walk-in] [Open/Close shift]│
│  live    │ Monday, 24 August 2026                                     │
│  here)   ├────────────────────────────────────────────────────────────┤
│          │ ┌────────┐┌────────┐┌────────┐┌────────┐                   │
│          │ │  14    ││  87    ││  342   ││ ₱18,450│   KPI row         │
│          │ │IN GYM  ││TODAY   ││ACTIVE  ││TODAY ₱ │   no icons        │
│          │ └────────┘└────────┘└────────┘└────────┘                   │
│          ├────────────────────────────────────────────────────────────┤
│          │ NEEDS YOU · 3 items          (full-width band, decision 5) │
│          │ [2 denied scans →][9 expiring →][3 long sessions →]        │
│          ├──────────────────────────────────┬─────────────────────────┤
│          │ Check-ins · last 30 days         │ RENEWALS  Aug 2026      │
│          │ ┌──────────────────────────────┐ │ ┌─────────────────────┐ │
│          │ │      area chart (gold)       │ │ │  month grid, dots   │ │
│          │ └──────────────────────────────┘ │ └─────────────────────┘ │
│          │                                  │                         │
│          │ Currently in the gym             │ Expiring this week      │
│          │ ┌──────────────────────────────┐ │ ┌─────────────────────┐ │
│          │ │ table · live from SSE        │ │ │ 3 rows + All →      │ │
│          │ └──────────────────────────────┘ │ └─────────────────────┘ │
│          │                                  │ Recent payments         │
│          │                                  │ ┌─────────────────────┐ │
│          │                                  │ │ 3 rows + All →      │ │
│          │                                  │ └─────────────────────┘ │
└──────────┴──────────────────────────────────┴─────────────────────────┘
```

Grid is `minmax(0, 1fr) 306px`. Below 1100 px the rail drops beneath the main column; below 760 px the KPI row becomes 2×2 and the "Needs you" band stacks vertically. `minmax(0, …)` rather than `1fr` on the main column is deliberate — a bare `1fr` lets the widest table set the column width and pushes the rail off-screen.

**The topbar is shared.** Shift state belongs to `admin/layout.tsx`, not to this page, so it is visible on Members and Payments too. That is the only file outside the dashboard this redesign touches.

---

## 4. Every element and the endpoint behind it

The table is the contract. A panel with no row here does not ship.

| # | Element | Source | Permission | Notes |
|---|---|---|---|---|
| 1 | In the gym now | `GET /front-desk/today` → `counters.inGym` | `checkin.read` | Rendered immediately. The count-up animation is deleted. |
| 2 | Check-ins today | `GET /front-desk/today` → `counters.today`, `counters.manualToday` | `checkin.read` | Delta vs the same weekday last week comes from element 6's series — same-weekday, not yesterday, because a gym's Monday never resembles its Sunday. |
| 3 | Active members | `GET /members?standing=ACTIVE&limit=1` → `total` | `member.read` | `limit=1` — only `total` is read. |
| 4 | Revenue today | `GET /payments?from=<today>&to=<today>` → `totalCentavos` | `payment.read` | **Not "expiring".** Expiring is an *action*, and it already has a slot in the Needs-you band (5b) fed by the same request — putting it in both meant the same number twice, six inches apart. A KPI tile should report a *state*; money taken today is one, and `ListPaymentsQueryDto` already accepts `from`/`to` as gym-local civil dates. |
| 5 | Needs you — denied scans | `GET /front-desk/today` → `counters.needsYou` | `checkin.read` | Links to `/admin/attendance`. |
| 5b | Needs you — expiring | `GET /memberships?expiringWithinDays=7&limit=8` | `membership.read` | Now the **only** place this number appears. Same response feeds element 9. Links to `/admin/subscriptions`. |
| 5c | Needs you — long sessions | element 7's `items`, filtered `durationMinutes > 180` | `checkin.read` | `ActiveCheckIn.durationMinutes` is non-nullable, so the filter is total. Filtered on the client rather than inventing a query parameter — but see the `limit` note on element 7, which exists *because* of this row. |
| 6 | Check-ins chart | **`GET /admin/check-ins/daily?from&to`** — §5 | `checkin.read` | The only new endpoint. |
| 7 | Currently in the gym | `GET /front-desk/check-ins/active?limit=50` | `checkin.read` | **`limit=50`, not `5`.** The table shows the first five and links to `/admin/attendance` for the rest, but element 5c counts long sessions across the whole floor — and a `limit=5` fetch would report "0 long sessions" whenever the five most recent arrivals happen to be fresh, which is precisely when someone has been inside for four hours. `/admin/attendance` already fetches this endpoint at `limit=50`, so the size is proven. |
| 8 | Renewals calendar | `GET /memberships?expiringWithinDays=90&limit=100` (page 2 when `total > 100`) | `membership.read` | §7. Ninety days is the DTO's hard `@Max(90)`; **100 is `PAGINATION_DEFAULTS.MAX_LIMIT`** (`shared/src/constants/routes.ts:29`). |
| 9 | Expiring this week | element 5b's `items` | `membership.read` | Same response as the Needs-you row; fetched once. |
| 10 | Recent payments | `GET /payments?limit=6` | `payment.read` | |
| 11 | Shift pill + Close shift | `GET /shifts/current`, `POST /shifts/:id/close` | `shift.manage` | |
| 12 | Manual check-in | `POST /front-desk/check-ins` | `checkin.create` | §6 |
| 13 | Sell walk-in | `POST /front-desk/walk-ins` | `walkin.sell` | §6 |
| 14 | ~~Record payment~~ | **cut** — `POST /payments` is WALK_IN-only | — | See §6 amendment |

**Every element degrades on its own permission.** The dashboard's floor is `member.read` (what `admin/layout.tsx` already gates on). A FRONT_DESK account holds `checkin.*`, `payment.*` and `member.read` but not `membership.read`, so for them elements 4, 8 and 9 are absent — not empty, not erroring, **absent**. The permission set comes from `GET /me`, never from `role`; the reason is in `CLAUDE.md` and is not re-litigated here.

**Eight requests fire on mount** for an ADMIN: `front-desk/today`, `members`, `memberships?7`, `memberships?90`, `check-ins/active`, `payments?today`, `check-ins/daily`, `shifts/current`. A FRONT_DESK account holds no `membership.read`, so two of them are never issued and the mount costs six. The `default` throttle bucket is 100/60 s per user, so a full mount spends 8% of budget.

### 4.1 Refreshing — the page must not freeze on mount

Without this section the redesign fails its own premise. `useAdminQuery` fetches on `[key, nonce]` and has **no interval**; nothing in `client/src/` opens an `EventSource`. As the rest of this document was originally written, "In the gym now: 14" would be correct at 9:02 AM and still read 14 at noon — a command centre that is a screenshot.

**Poll, using the hook that already exists.** `useAdminQuery` gains one optional argument, `pollMs`, that re-runs the existing fetch path on an interval. No new hook, no new dependency, no new failure mode — `reload()` and the sequence guard already handle a re-entrant fetch correctly, which is exactly why polling belongs in this hook rather than beside it.

| Element | Interval | Why |
|---|---|---|
| 1, 2, 5a, 5c, 7 (`front-desk/today`, `check-ins/active`) | **30 s** | The live floor. Two requests per 30 s is 4 of the 100/60 s budget. |
| 10, 11 (`payments?today`, `shifts/current`) | **60 s** | Money and drawer state change at human speed. |
| 3, 4, 5b, 6, 8, 9 | **mount only** | The 90-day membership scan and the 30-day chart do not change within a shift. `reload()` after a successful modal covers the rest. |

**Polling pauses when the tab is hidden** (`document.visibilityState`) and resumes with an immediate fetch on focus. Without that, a console left open on a back-office monitor overnight burns ~2,900 requests and returns stale data to nobody.

**SSE is deliberately not used, for now.** `GET /front-desk/stream` exists server-side and is the better long-term answer, but **no client code consumes it** — `admin/attendance/page.tsx:19` mentions it in a comment and that is the entire client-side footprint. Building a reconnecting `EventSource` consumer, with backoff and auth, is net-new infrastructure that belongs with the desk console (chunk 2), not smuggled into a dashboard redesign. When that consumer lands, elements 1/2/5a/5c/7 swap their `pollMs` for a subscription and nothing else on this page changes. **Until then, no copy on this page may claim to be "live from the stream."**

---

## 5. New endpoint — `GET /api/v1/admin/check-ins/daily`

The one piece of backend work.

### 5.1 Contract

```
GET /api/v1/admin/check-ins/daily?from=2026-07-26&to=2026-08-24
@RequirePermission('checkin.read')
```

Query is **`ReportRangeQueryDto`, reused verbatim** (`server/src/payments/dto/report-range-query.dto.ts`): both bounds are inclusive gym-local civil dates validated by `@IsGymDate()`. Its existing header comment already states the reason — *"a full UTC instant arriving here is exactly how the timezone bug class returns, and the columns being filtered are `@db.Date`"* — and that applies here word for word.

Response:

```ts
interface DailyCheckIns {
  days: {
    date: CivilDate;   // 'YYYY-MM-DD', gym-local
    total: number;     // admitted visits, voids excluded
    selfScan: number;  // method = STATION_QR
    staff: number;     // method IN (MEMBER_CODE, MANUAL)
    denied: number;    // CheckInDenial rows on the same businessDate
  }[];
}
```

### 5.2 Four correctness requirements

**Group on `businessDate`, never on `occurredAt`.** `businessDate` is `@db.Date` and already holds the gym-local civil date; `occurredAt` is `@db.Timestamptz(3)`. Bucketing on the timestamp splits a Manila day at 08:00 local and produces a chart that is wrong by roughly a third of an evening every single day. The index `@@index([businessDate])` exists for exactly this query.

**Exclude voided rows.** `CheckIn.voidedAt IS NULL`. A voided check-in is a correction of a mistake; leaving it in the count means the chart disagrees with `/front-desk/today`, and the two are on screen together.

**Zero-fill the gaps.** A day with no check-ins must return `{ total: 0 }`, not be omitted. An absent day makes the chart interpolate a straight line across a closed holiday and draw attendance the gym never had. Fill in the service from the requested range, not in the SQL — the range is already validated and bounded, and a generated-series join is more machinery than the problem deserves.

**Cap the range at 90 days.** Matching `ListMembershipsQueryDto`'s `@Max(90)`, enforced in the service with a `BadRequestException` carrying a domain code. Without a cap, `from=1970-01-01` is a full table scan any authenticated staff account can trigger.

### 5.3 Placement

`AdminModule` — `server/src/admin/`. It joins `/admin/stations` and `/admin/plans` as an admin-only read surface. It does **not** go in `FrontDeskModule`: everything there is keyed to *now* and is consumed by the desk console, and a historical aggregate would drag reporting concerns into a module whose whole point is the live counter.

### 5.4 Tests

Unit (`*.spec.ts`, mocked Prisma): zero-fill produces an entry per day across a gap; a voided check-in is excluded; `to` before `from` is a 400; a 91-day range is a 400; `selfScan + staff === total`.

E2E (`test/*.e2e-spec.ts`, real database): a check-in written at 23:30 Manila on the 24th lands on the 24th and not the 25th — the assertion that fails if anyone ever "optimises" the grouping onto `occurredAt`. Per `CLAUDE.md`, the e2e database is built with `migrate deploy` then `db seed`, never `db push`.

---

## 6. Quick actions

Four buttons under the greeting. Each opens a focused modal over an endpoint that already exists; none navigates away.

**AMENDED DURING IMPLEMENTATION, 2026-08-24.** This section originally listed
four actions, the first being a general "Record payment" over `POST /payments`.
That action cannot exist. `payments.service.ts:126` refuses every purpose
except `WALK_IN`, and refuses again at line 149 if the plan is not a `WALK_IN`
plan — because a membership term is sold through `POST /memberships`, a renewal
through `/memberships/:id/renew`, and a freeze fee through
`/memberships/:id/freeze`, each writing its `Payment` **inside the same
transaction as the row it pays for**, so money can never be taken for a term
that was never created. A "Record payment" button here would therefore have
been either a duplicate of "Sell walk-in" or a guaranteed 422. It is cut, and
selling or renewing a term stays on `/admin/subscriptions`, where the plan and
term fields it genuinely needs already belong.

| Action | Endpoint | `adminApi` | Fields | Permission |
|---|---|---|---|---|
| Manual check-in | `POST /front-desk/check-ins` | `manualCheckIn` — **exists** | member picker **or** member code | `checkin.create` |
| Sell walk-in | `POST /front-desk/walk-ins` | `sellWalkIn` — **exists** | guest name, phone, method, GCash ref | `walkin.sell` |
| Open / close shift | `POST /shifts/open`, `POST /shifts/:id/close` | `openShift` **exists**, **add `closeShift`** | float or counted cash, note | `shift.manage` |

**Almost every client function already existed.** `adminApi.manualCheckIn`,
`sellWalkIn`, `checkOut`, `voidCheckIn`, `currentShift` and `openShift` were
all written and typed; what was missing was any UI that called them. Only
`closeShift` and `checkInsDaily` were added.

**The shift action is one control in two states**, decided by `/shifts/current`
and polled — so the button reflects the drawer even when somebody else opened
it at the other terminal. Rendering "Open shift" and "Close shift" side by side
would put a permanently disabled button on the page.

**A denial is not an error.** `POST /front-desk/check-ins` returns 200 for
every business outcome including refusal, so the manual check-in modal renders
the verdict rather than throwing it. It maps `display.tone` — a closed
four-value union — straight to colour, and branches on `denial.reason` nowhere,
because a client that switched on that enum would render a blank card the first
time it gained a value.

### 6.1 `MemberPicker` — an extraction, not an invention

Two modals need "find a member". That capability **already works** in `client/src/app/admin/members/page.tsx`: a `type="search"` input, `useDebounced` from `useAdminQuery.ts`, and `adminApi.members({ search })`. The work is to lift that into `client/src/components/admin/MemberPicker.tsx` and have the Members page consume the extraction, so there is one search behaviour rather than two that drift.

It adds only what a picker needs and a list page does not: keyboard selection (↑/↓/Enter/Escape), a chosen-member chip with a clear button, and `onSelect(member)`. It does **not** get its own fetching logic, its own debounce, or its own types.

### 6.2 Modal shell and accessibility

There is no shared modal today; `admin/stations/page.tsx` and `portal/schedule/page.tsx` each hand-roll one. `components/admin/Modal.tsx` is extracted from the stations implementation — the more complete of the two — and both call sites move onto it.

The shell owns what every one of these gets wrong when hand-rolled: `role="dialog"` + `aria-modal="true"` + `aria-labelledby` pointing at the title, focus moved to the first field on open and **restored to the invoking button on close**, focus trapped within the dialog while open, Escape closes (and is suppressed while a submit is in flight so a slow network cannot lose typed input), the trigger disabled during submit so a double-click cannot fire two writes, and `overflow: hidden` on the body while open. Below 620 px it is a bottom sheet rather than a centred card.

**A button the caller lacks permission for is not rendered.** Same rule as §4, same reason.

**`Idempotency-Key` is already handled and must not be re-handled.** `apiFetch` mints one on every POST (`client/src/lib/api.ts`). A modal that generates its own key would produce two mechanisms that can disagree — the exact failure `CLAUDE.md` describes for `/checkin`. Modals call `adminApi`, `adminApi` calls `apiFetch`, and the key is nobody else's business.

**Success closes the modal and reloads only the affected panels** via the `reload()` already returned by `useAdminQuery` — recording a payment refreshes payments and the shift pill, and leaves the chart and calendar alone. A blanket page refetch would restart every request including the 90-day membership scan.

**Failure keeps the modal open** with the server's `error.message` inline and the form state intact. The one branch worth special-casing is `ApiError.status === 403`, which means the grant table disagrees with what was rendered — that message says so plainly rather than showing a validation error.

---

## 7. The renewals calendar

A month grid built from `GET /memberships?expiringWithinDays=90&limit=100`, bucketed client-side by `endsOn`.

- Each day carries a dot when at least one membership ends that day: `--p-warn` for a term ending in the future, `--p-danger` for one already past its grace. Today is the gold chip.
- Clicking a day filters the "Expiring this week" panel below to that date and retitles it. It does **not** navigate — the point is to answer "who do I call today" without losing the rest of the page.
- Month back/forward moves within the fetched 90-day window only. Arrows outside it are disabled rather than triggering a fetch that the DTO's `@Max(90)` would reject anyway.
- **`limit=100`, not 200.** `PAGINATION_DEFAULTS.MAX_LIMIT` is 100 (`shared/src/constants/routes.ts:29`), so a request for 200 is either rejected or clamped — and a silent clamp is exactly the "calendar quietly omits members" failure this bullet exists to prevent. The calendar needs the whole window, so `adminApi.memberships` is called for page 1 and, only when `total > 100`, page 2. Ninety days of expiries exceeding 200 would mean a membership base several times the size this gym has; if it ever happens the panel says "showing the first 200" rather than drawing an incomplete month.

**Why this and not classes.** There is no `Class`, `Session`, or `Booking` model in `prisma/schema/`, and no endpoint returns anything schedulable. A calendar of classes would be the tip card again, at four times the size. Renewals are the highest-value date-keyed data the system actually holds, and the "renewal call sheet" is a real recurring job.

---

## 8. Files

| File | Change |
|---|---|
| `server/src/admin/check-ins-daily.controller.ts` | new — §5 |
| `server/src/admin/check-ins-daily.service.ts` | new — grouping, zero-fill, range cap |
| `server/src/admin/admin.module.ts` | register both |
| `server/src/admin/check-ins-daily.service.spec.ts` | new — §5.4 unit |
| `server/test/check-ins-daily.e2e-spec.ts` | new — §5.4 e2e |
| `shared/src/types/…` | `DailyCheckIns` — consumed by both sides, so it belongs here |
| `client/src/lib/adminApi.ts` | add **only** `checkInsDaily` and `closeShift`. `manualCheckIn`, `sellWalkIn`, `checkOut`, `voidCheckIn`, `currentShift`, `openShift` already exist and are used as-is |
| `client/src/lib/useAdminQuery.ts` | add optional `pollMs` + visibility pause (§4.1). No new hook |
| `client/src/components/admin/MemberPicker.tsx` | new — **extracted** from `admin/members/page.tsx` (§6.1); that page then consumes it |
| `client/src/components/admin/Modal.tsx` | new — **written, not extracted.** The two existing overlays are a backdrop plus a card with no focus management, Escape or ARIA; the only reusable part was the backdrop (§6.2) |
| `client/src/components/admin/ShiftPill.tsx` | new — drawer state in the topbar of every admin page |
| `client/src/app/admin/page.tsx` | rewritten |
| `client/src/components/admin/dashboard/` | new — `KpiRow`, `NeedsYou`, `CheckInsChart`, `RenewalsCalendar`, `InGymTable`, `ExpiringList`, `RecentPayments` |
| `client/src/components/admin/actions/` | new — `RecordPaymentModal`, `ManualCheckInModal`, `WalkInModal`, `CloseShiftModal`, shared `Modal` |
| `client/src/app/admin/layout.tsx` | shift pill in the topbar; **and the fix in §10** |
| `client/src/app/admin.css` | dashboard styles rewritten; the ten `--{colour}` chip rules deleted |

The current page is one 453-line file holding markup for six panels. Extracting each panel is not tidying: `CheckInsChart` and `RenewalsCalendar` both carry real logic (scale computation, month bucketing) that wants its own unit test, and neither is testable while it is a fragment inside a page component.

**The chart is hand-rolled SVG.** No charting library. One area path with a gold gradient fill, a stroke, and a focus dot is ~40 lines against `client/`'s current zero chart dependencies, and Recharts would add ~90 kB to a bundle for one sparkline.

**It must be readable, not just shaped.** A trend line you cannot query is decoration with extra steps. On hover or focus the chart snaps a crosshair to the nearest day and shows date, total, and the self-scan/staff split. Keyboard: ←/→ move the focus dot, and the whole figure carries an `aria-label` naming the range, the total, and the peak day — so the one fact a screen reader user needs does not depend on reading an SVG path. Touch taps behave as hover. Without this the panel is cut, because §2.1 applies to comprehension as much as to sourcing.

---

## 9. Loading, empty, error

`DataState` (`client/src/components/admin/ui.tsx`) already renders these and is reused unchanged.

- **Loading:** skeletons at the panel's real height. `useAdminQuery` keeps previous data through a refetch, so this is first-load only and the page never strobes.
- **Empty is written for the case, never "No data".** "No one in the gym right now." / "Nothing expiring in the next seven days — this list is the renewal call sheet, empty is good." / "No check-ins recorded in this range."
- **Error is per panel with a retry.** One failing endpoint degrades one card. The current code already gets this right and it is preserved.
- **"Needs you" with nothing in it renders as a single calm line** — "Nothing needs you right now" — and keeps its slot. A band that vanishes makes the page jump on every poll, and its absence is indistinguishable from its not having loaded.

---

## 10. One defect fixed in passing

`client/src/app/admin/layout.tsx:72`:

```ts
} catch {
  if (!cancelled) setGate('anonymous');   // any /me failure ⇒ "signed out"
}
```

`anonymous` triggers `router.replace('/login?next=…')`. So any transient `/me` failure — a dev-server restart, a dropped Wi-Fi frame, a 429 — logs a valid staff session out and bounces them to a login page that then signs them straight back in. This was diagnosed on 2026-08-24 while chasing a reported login loop; the API was healthy and every request in the network tab was a 200.

`portal/layout.tsx` already handles the same case correctly and says why in its own comment: *"a failed profile read is a network blip, not an authorisation problem."* The admin shell must agree with it.

**Fix:** distinguish the causes. `ApiError.status === 401` is genuinely anonymous → redirect. `403` → `forbidden`, which the shell already renders. Anything else is a network or server failure → a new `unreachable` gate showing "Could not reach the server" with a Retry button, and **no redirect**. This is in scope because the shift pill puts a new request in that same `resolve()` path, and shipping the redesign without it would make the loop easier to hit, not harder.

---

## 11. Out of scope, and named

Per §2.1, what is missing is stated rather than faked.

- **Classes, sessions, bookings.** No model, no endpoint. Nothing on the dashboard implies they exist.
- **Notes / reminders.** The reference has "My Notes"; there is no table for it. A notes feature is a real feature with a real schema, not a dashboard widget.
- **Revenue trend chart.** `/payments?from&to` makes it sourceable, but two charts on one screen is one more than the page needs. `/reports/gcash` and `/reports/statutory-discounts` also remain unsurfaced. Both are candidates for the Payments page in the next spec.
- **Coach utilisation, retention, churn, LTV.** No aggregate endpoint returns any of them. They are not stubbed.
- **Configurable layout / drag-to-reorder tiles.** YAGNI for a single-location gym with one admin.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| `check-ins/daily` is slow once the table is large | Grouped on the indexed `businessDate`; range hard-capped at 90 days. The service issues **two** queries — one `groupBy` on `CheckIn`, one on `CheckInDenial` (which carries its own `businessDate` and `@@index([businessDate])`) — and the unit spec asserts that count, so an N+1 introduced later fails a test rather than a production dashboard. |
| **Collision with chunk 2, which is in flight in another session** | `client/src/app/desk/` currently holds only the station display, and `docs/superpowers/plans/` has no chunk-2 plan — the staff desk console is being built elsewhere, and it owns manual check-in and walk-in sales too. This spec touches **no file under `client/src/app/desk/`** and adds no new `/front-desk/*` endpoint. The overlap is `MemberPicker`: if chunk 2 has already built a member search, this spec's extraction is dropped and that component is imported instead. **Check before implementing §6.1.** |
| Eight requests on mount feels heavy | 8 of 100/60 s. If it becomes a problem the fix is a composite `/admin/dashboard` endpoint, deliberately **not** built now — it would couple seven independent panels into one failure domain and one cache key. |
| The 90-day membership fetch is the largest payload on the page | Capped at `MAX_LIMIT` 100 per page, at most two pages, mount-only (never polled). It is the one request that would benefit from a projection; if it bites, a `fields=` parameter is the answer, not a shorter window. |
| Modals grow into a form framework | Four modals, one shared `Modal` shell, no abstraction beyond it until a fifth exists. |
| Chart is misread as real during development | Ships wired to the live endpoint from the first commit. There is no fixture mode. |

---

## 13. Definition of done

1. `npm run build` green from the repo root; `npm run lint` and `npm run typecheck --workspace=client` clean.
2. `npm test --workspace=server` green, including the new `check-ins-daily` unit spec.
3. `npm run test:e2e --workspace=server` green, including the 23:30-Manila business-date assertion.
4. `grep -rP "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" client/src/app/admin client/src/components/admin` returns nothing. **This currently fails on a third file** — `admin/stations/page.tsx:419` closes its hand-rolled modal with a `✕` (U+2715, inside that range). That is not scope creep: §6.2 moves stations onto the shared `Modal`, whose close button replaces it. If the extraction is skipped, this check must be scoped to the files actually changed rather than quietly deleted.
5. Every panel in §4 renders from a live call — verified signed in as `ysa+admin@test.com`, and again as `ysa+frontdesk@test.com`, where elements 4, 8 and 9 are absent rather than broken.
6. Killing the API mid-session leaves the console showing "Could not reach the server" with a Retry — **not** a redirect to `/login` (§10).
7. **The page is not frozen.** With the dashboard open, a check-in recorded elsewhere appears in "Currently in the gym" within 30 s without a manual refresh, and the counters move with it (§4.1).
8. **Polling stops when the tab is hidden** and refetches immediately on focus — verified in the Network panel, not assumed.
9. Every modal closes on Escape, traps focus while open, and returns focus to the button that opened it (§6.2). The chart is readable by keyboard alone (§8).
