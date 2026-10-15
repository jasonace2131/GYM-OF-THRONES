# Walk-in and day-pass: the whole journey, end to end

A script for driving the walk-in flow from nothing, written by running it.
Every screen and every message below was observed, not imagined.

Use it two ways: as a defense demo you can rehearse, and as the manual test to
re-run after touching anything in payments, check-in or the walk-in register.

**Cast.** The *guest* is somebody off the street with no account. The
*operator* is whoever is on the desk — FRONT_DESK or ADMIN, since both hold
`walkin.sell`. There is no member portal in this journey until the very end,
which is the point: a walk-in has no app.

---

## Step 0 — Open the drawer. Nothing works without it.

**Operator.** Dashboard → **Open shift** → enter the opening float (say
₱1,000) → **Open shift**.

Skip this and the sale is refused, in those words:

> Open the cash drawer first — money has to land in a counted till.

That is not a validation nicety. Every peso in this system belongs to a
counted shift so the end-of-day count has something to reconcile against, and
the walk-in modal will not let an operator around it.

The topbar pill flips from **Drawer closed** to **Shift open · 5:52 PM**, and
that pill is the fastest way to see the state from any screen.

> **Known friction, worth saying out loud if a panel notices.** The drawer is
> opened from the Dashboard, but the sale happens on Walk-ins. An operator who
> starts their morning on the Walk-ins screen has to go somewhere else to fix
> the error they were just shown. Worth adding an Open shift button to that
> error itself.

---

## Step 1 — The guest arrives. One action sells and admits.

**Guest.** Walks in. Says they want one day. Hands over ₱90.

**Operator.** Walk-ins → **Sell walk-in**. The modal says what it is:

> The sale checks them in — no QR, staff presence is the identity check.

Fill in:

| Field | Notes |
|---|---|
| Guest name | Required |
| Phone | Optional, and the placeholder says *they can decline* |
| Emergency contact | Optional |
| Liability waiver | **Required.** Ticking it records a versioned consent against the visit |
| Payment | Cash or GCash |
| Discount | None, Senior citizen, or PWD |
| BIR invoice no. | Collapsed by default, because a ₱90 sale is under the ₱500 issuance threshold. It force-opens for a Senior or PWD sale, which needs a document regardless |

Press **Charge ₱90**.

There is deliberately no ID Type field and no Duration field. The Data Privacy
Act's minimisation rule does not justify collecting an ID for a ₱90 guest, and
duration is measured from the real check-in and check-out rather than guessed
at the counter.

**What you should see.** A confirmation strip reading *Walk-in recorded* with
a **Print slip** button, the KPI row moving to **1 walk-in / ₱90 takings /
₱90 cash**, and a register row: name, `GUEST`, time in, `still in`,
`WALK-IN`.

---

## Step 2 — Tracking, while they are still in the building

Four places show the same visit, each answering a different question.

| Screen | Answers |
|---|---|
| **Walk-ins** | The day-pass register, filterable Today / 7 days / 30 days and Walk-ins / Guest passes / Both |
| **Dashboard** → Currently in the gym | Who is in the building right now, refreshed every 30 seconds |
| **Attendance** | Every visit, of every kind, over any range |
| **Payments** | The ₱90 itself, against the operator's shift |

The printable **Transaction Slip** carries the line *INTERNAL RECORD — NOT A
BIR-REGISTERED INVOICE*, with a field tying it to the booklet invoice number.
It is not pretending to be an official receipt, and it says so on its face.

---

## Step 3 — The guest becomes a member

This is the step the whole walk-in design exists to make possible, and the one
number a panel is most likely to ask about.

**Operator.** On the guest's register row, press **Make member**.

A drawer opens **pre-filled from the visit** — first name, last name, phone,
emergency contact all carried across. Only the email is blank, because a guest
was never asked for one.

Tick **Sell a plan now** and the plan, method, BIR invoice and discount fields
appear, so the counter can convert and sell in a single pass.

Press **Create member**. Expect:

> Nino Cruz (…) was created.
> The invite email may not have gone out. **[Resend invite]**

That second line is honest rather than defensive: the member row and the
Supabase invite both exist, and the email is best-effort. If the sending
domain is not configured the button is how staff recover, and the member is
never lost to a mail outage.

**Conversion is one guest at a time, on purpose.** The proposal's Figure 17
shows a bulk "Convert to Member" action. Each conversion mints a real account
and sends an invite, so a batch is a batch of half-finished accounts the first
time one address bounces.

---

## Step 4 — How the conversion is tracked

**Operator.** Reports → the walk-in statistics row.

| Tile | After this journey |
|---|---|
| Total walk-ins | 1 |
| Revenue generated | ₱90 |
| Average per day | `<0.1` |
| **Converted to members** | **1** — *from walk-in visits* |

Below it, **Walk-in breakdown by day** gives count, revenue and **peak hour**
per weekday, which is the number that answers "when should we staff the desk".

**Converted to members is a real join, not an estimate.** Creating the member
from the visit stamps `CheckIn.convertedToUserId`, so the count is the number
of guest visits that actually became accounts. Before that column existed the
figure was uncomputable, because a converted guest's rows looked exactly like
any other guest's.

Both **Export CSV** and **Export PDF** carry the same three reports.

> **Average per day reads `<0.1`, not `0`.** One walk-in across a 31-day range
> is a true 0.03, and rounding it to a flat `0` beside a tile reading
> "1 total walk-ins" made two tiles appear to contradict each other. Small is
> now said rather than rounded away.

---

## What to say if a panel asks the hard questions

**"Can a guest check in again the same day without paying?"**
No. The day pass is resolved from a `WALK_IN` visit on today's gym-local
business date, so a second scan finds the existing pass rather than minting a
free entry.

**"What stops staff pocketing the ₱90?"**
The sale cannot happen outside an open shift, the shift is closed with a
counted total, and the variance is recorded. A void is a separate, reasoned
action that lands in the audit log with the operator's name.

**"Where is the guest's personal data?"**
Phone and emergency contact are on the visit and are NOT on the desk feed that
streams to the lobby PC. They travel on one route, gated on `member.create` —
the permission to create the account that data would seed.

**"Why is there no ID scan?"**
Proportionality. A ₱90 day pass does not justify collecting an identity
document, and staff presence is the identity check the modal names.

---

## Re-running this as a test

Everything above is reproducible against the scratch Postgres rather than the
shared database:

```bash
docker start got-chunk0-e2e-v2

cd server
TESTDB=$(grep '^TEST_DATABASE_URL' .env.test | cut -d'"' -f2)
TESTDIRECT=$(grep '^TEST_DIRECT_URL' .env.test | cut -d'"' -f2)
DATABASE_URL="$TESTDB" DIRECT_URL="$TESTDIRECT" npx prisma migrate deploy
DATABASE_URL="$TESTDB" DIRECT_URL="$TESTDIRECT" npx prisma db seed

cd ..
DATABASE_URL="$TESTDB" DIRECT_URL="$TESTDIRECT" PORT=4100 \
  CORS_ORIGIN="http://localhost:3100" npm run dev:server

cd client && NEXT_PUBLIC_API_URL="http://localhost:4100/api/v1" \
  npx next dev --port 3100
```

Two traps, both of which cost time once:

- **The e2e suite truncates every table**, so a scratch database that has run
  `npm run test:e2e` has no plans and the walk-in modal has nothing to sell.
  Re-run `prisma db seed` after any e2e run.
- **A test account signs in against real Supabase Auth** and is provisioned
  locally as CLIENT. To reach the console, promote it in the scratch database:

  ```sql
  UPDATE "User" SET role='ADMIN', "permissionVersion" = "permissionVersion" + 1
  WHERE email='ysa+admin@test.com';
  ```
