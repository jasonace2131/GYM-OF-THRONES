# Walk-in — Workflow & Test Cases

> Manual QA script. Run against staging or production with the seeded accounts.
> Sign in as `ysa+admin@test.com` (or `ysa+frontdesk@test.com`) unless a case says otherwise.

## The workflow, first

**There is no scheduling.** A walk-in is a point-of-entry sale, by design — the owner's decision was *counter only*: no pre-booking, no online payment, no QR issued in advance. Someone walks in, pays at the counter, trains today. (Pre-book-online-pay-at-counter was considered and declined; it can be built later without touching this flow.)

Three doors into the same sale, all writing the same `POST /front-desk/walk-ins`:

| # | Where | Component | When staff use it |
|---|---|---|---|
| 1 | **Dashboard** (`/admin`) → *Sell walk-in* quick action | `WalkInModal` | Someone off the street at a quiet counter — the fast path |
| 2 | **Attendance** (`/admin/attendance`) → *Sell walk-in* button | `WalkInSheet` | Same sale, but from the floor screen; also offers Senior/PWD discount |
| 3 | **Attendance → the denial rail** → click a denied member | `WalkInSheet` (pre-filled) | A member was denied at the door (expired, cancelled) and converts to a ₱90 day pass on the spot — the commercially load-bearing path. Resolves the denial to `RESOLVED_WALK_IN` |

What every path enforces, server-side:

- **An open shift.** `Payment.shiftId` is NOT NULL — money must land in a counted drawer. No open shift → `SHIFT_NOT_OPEN`.
- **The guest waiver**, for anyone without an account. No tick → `GUEST_WAIVER_REQUIRED` (422). A member converting from a denial is *not* re-asked — theirs is on file from the portal gate.
- **GCash needs a reference** (`Payment_gcash_reference`).
- **Statutory discounts need an ID** and the `payment.discount.statutory` permission (both checked in-service since the Phase 5 fix).
- **No hours gate.** The `GYM_CLOSED` denial applies only to `STATION_QR` self-scans; a staff-recorded walk-in implies the gym is open because staff are standing in it.

Money: list price ₱90 (`WALKIN` plan, editable in Settings → Plans). Promos never apply to walk-ins (owner decision, enforced in `PromotionsService`).

## After the sale — no QR, ever

**The sale IS the check-in.** The payment and the check-in row are written in one
transaction (`method: MANUAL`); the guest appears in *In the gym now* the moment
staff take payment. A guest cannot QR themselves even in principle — the station
flow authenticates a member's phone session, and a guest has no account. Staff
presence replaces the QR as the identity check.

**Check-out**, in order of likelihood:
1. staff hit *Check out* on the attendance screen (`checkin.close`);
2. nobody bothers, and the stale-visit rule closes it (`STALE_CLOSE`, excluded
   from duration stats). An unclosed guest visit is cosmetic, never financial.

**Expired member on a day pass** (denial-rail conversion): they can scan OUT
with their own QR — checkout never evaluates membership, so an expired-mid-
session member can always leave — and a later scan IN runs the ladder, finds
the paid `WALK_IN` row on today's date, and **REOPENS it**: ₱90 buys the day,
not a single admission. One paid day = one visit row, however many times they
step out. The only gates on that re-entry are the daily visit ceiling and the
row not being voided.

**How a walk-in becomes a member**: on Attendance, a guest row (no member
code) shows **Make member** to anyone holding `member.create` (ADMIN). It
pulls the guest's name, phone and emergency contact off the visit — via a
dedicated `member.create`-gated endpoint, because the desk feed deliberately
never carries a guest's phone — into the New member drawer; staff add the
email (asked at the counter), optionally sell a plan, done. Their current
visit stays a guest visit; from the next visit they QR in as a member. A
website enquiry converts the same way from **Leads → Convert**, which also
stamps the lead `CONVERTED` with the new member's id in the same transaction.

---

## Preconditions (once)

- [ ] `seed:accounts` and `db:seed` have run; you can sign in as ADMIN and FRONT_DESK
- [ ] `seed:showcase` has run, so the denial rail has entries and members exist in every standing
- [ ] Know the current WALKIN price from Settings → Plans (assume ₱90 below)

## A. Happy path — stranger off the street, cash

- [ ] A1 · Sign in as ADMIN → Dashboard. *Sell walk-in* button is visible
- [ ] A2 · Open it. **Take payment is disabled** while the waiver box is unticked
- [ ] A3 · The waiver line links to `/waiver`; it opens in a new tab and shows version `2026-09-01`
- [ ] A4 · Enter name `QA Guest`, phone `0917 000 0001`, emergency contact `QA Contact 0917 000 0002`, tick the waiver, method Cash → *Take payment*
- [ ] A5 · Modal closes; dashboard's **In the gym now** gains the guest within one poll (~15s)
- [ ] A6 · Payments (`/admin/payments`): a `RECORDED · CASH · ₱90.00` row, payer **Walk-in guest** (not a UUID)
- [ ] A7 · Revenue (`/admin/revenue`, group by *purpose*): `WALK_IN` bucket grew by ₱90
- [ ] A8 · DB (or drawer close later): the payment sits on today's open shift

## B. The gates — each must refuse, readably

- [ ] B1 · **No open shift**: close the shift (Dashboard → Close shift, count the drawer), retry A4 → error says to open the drawer first, sale not recorded. Reopen the shift after
- [ ] B2 · **Waiver unticked**: button is disabled client-side. Then POST directly (curl/devtools) without `guestWaiverAccepted` → `422 GUEST_WAIVER_REQUIRED`. *The client gate is convenience; the server gate is the control*
- [ ] B3 · **GCash, no reference**: choose GCash, leave reference blank → refused; the sale does not half-record
- [ ] B4 · **Amount drift**: with the sheet open, change the WALKIN price in Settings, then submit → `PAYMENT_AMOUNT_MISMATCH` ("reload the price list"), because ringing a number the member wasn't quoted is worse than refusing

## C. Discounts (WalkInSheet paths only)

- [ ] C1 · As ADMIN, Senior discount + OSCA ID `QA-OSCA-1` → net is **₱64.29** if `GYM_VAT_REGISTERED=true` (90 ÷ 1.12 × 0.8) or **₱72.00** if not — whichever your env says; receipt math on the payments row agrees
- [ ] C2 · Senior with **no ID** → refused with the ID message, not a constraint error
- [ ] C3 · As FRONT_DESK: senior discount works (FRONT_DESK holds `payment.discount.statutory` — RA 9994 makes refusing it an offence, so it must not need a manager)
- [ ] C4 · Try a promo code mentally: there is nowhere to enter one on a walk-in — correct, promos are members-only
- [ ] C5 · Statutory register (`/reports/statutory-discounts.csv` for today) contains C1 with the ID number

## D. Denial → walk-in conversion (path 3)

- [ ] D1 · Produce a denial: check in as an **expired** showcase member via manual check-in, or use an existing rail entry from the seed
- [ ] D2 · Attendance page: the denial shows in the rail with name and reason
- [ ] D3 · Click it → the sheet opens **pre-filled with the member**, no guest fields, **no waiver checkbox** (member's consent is on file)
- [ ] D4 · Take ₱90 cash → member is checked in; the rail entry clears
- [ ] D5 · The denial's outcome is `RESOLVED_WALK_IN` and points at the check-in (visible in the DB, or absent from the unresolved rail)
- [ ] D6 · The member's own portal (`Check-in History`) shows today's visit

## E. Edges

- [ ] E1 · **Already inside**: sell a walk-in to a member who is currently checked in → sale records (they paid), no duplicate open visit; the existing visit stands
- [ ] E2 · **Double-tap Take payment**: exactly one payment row (idempotency key per submit)
- [ ] E3 · **Guest with no name**: allowed — name is optional; the row shows *Walk-in guest*
- [ ] E4 · **FRONT_DESK sees the buttons; a COACH does not**: sign in as `ysa+coach@test.com` → no console at all (routed to the portal); as FRONT_DESK the Sell walk-in action is present
- [ ] E5 · **After 22:00** (or outside the configured hours): the walk-in sale still works — the hours gate is for self-scans only, staff presence is the evidence the gym is open
- [ ] E6 · **Waiver stamp**: the check-in row carries `guestWaiverVersion = 2026-09-01` and `guestWaiverAcceptedAt` (both or neither — `CheckIn_guest_waiver_paired`)

## F. End of day

- [ ] F1 · Close the shift with the counted cash → expected = float + cash walk-ins (GCash excluded — it never entered the drawer); variance matches reality
- [ ] F2 · Daily summary (`/reports/daily-summary`) counts today's walk-ins and their takings

## G. Guest → member conversion

- [ ] G1 · Sell a walk-in with name `QA Convert`, phone and emergency contact, waiver ticked. On Attendance, the guest row shows **Make member** (signed in as ADMIN)
- [ ] G2 · As FRONT_DESK the button is absent (no `member.create`), and `GET /front-desk/check-ins/:id/guest` via devtools → 403
- [ ] G3 · Click Make member → drawer opens prefilled: first/last split from the guest name, phone, emergency contact. Email is empty and required
- [ ] G4 · Enter an email, tick *Sell a plan*, MONTHLY cash → one submit creates account + plan + payment; member appears in Members
- [ ] G5 · The guest's open visit is untouched (still a guest row); tomorrow they QR in with their own code
- [ ] G6 · Try `GET /front-desk/check-ins/:id/guest` with a MEMBER visit's id → 404, never a member's contact
- [ ] G7 · Leads: an open lead shows **Convert** → drawer prefilled with name/email/phone → create → lead row flips CONVERTED and `convertedUserId` points at the member (DB)
- [ ] G8 · Convert the same lead again via API → `409 LEAD_ALREADY_CONVERTED`
- [ ] G9 · Convert with an email that already has an account → `409 MEMBER_EMAIL_TAKEN`; use the member's own drawer (Assign/Replace plan) instead
