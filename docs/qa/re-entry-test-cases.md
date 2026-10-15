# In-and-out re-entry — Workflow & Test Cases

> The "I QRed in but forgot something at home" problem. Manual QA script;
> sign in as a seeded CLIENT with an active plan unless a case says otherwise.

## The rule, first

A scan within **`CHECKIN_REENTRY_GRACE_MINUTES` (default 60)** of your own
QR check-out **reopens the same visit** — same row, `reopenCount + 1`, no
second slot against the daily ceiling (`CHECKIN_MAX_VISITS_PER_DAY`, default
8). Beyond the window it is a legitimate second visit and counts. The window
never crosses a business date, and only a **self-scan** check-out is
reopenable — a desk `Check out` (MANUAL), a `STALE_CLOSE` or the nightly
`AUTO_CLOSE` always leads to a fresh visit.

The full second-scan ladder, for reference:

| Scan, with an open visit | Outcome |
|---|---|
| age < 20 min (`CHECKIN_MIN_SESSION_MINUTES`) | `ALREADY_INSIDE` — a no-op; the card names the exact time checkout unlocks |
| 20 min ≤ age < 3 h, same day | `CHECKED_OUT` — the goodbye card says "Scan again within 60 minutes and it stays one visit" |
| ≥ 3 h (`CHECKIN_STALE_VISIT_HOURS`) or earlier date | old visit `STALE_CLOSE`d + a new one opened (`RECHECKED_IN`) |

| Scan, with no open visit | Outcome |
|---|---|
| own QR check-out within the grace window, same business date | `REOPENED` |
| otherwise | new `CHECKED_IN`, counted against the daily ceiling |

**Member who left WITHOUT scanning out**: their return scan lands in the
20 min–3 h band and reads as a check-out. The goodbye card tells them to scan
again; the second scan reopens. Two taps — the server cannot read intent, and
the pre-flight banner ("scanning again checks you out") is the warning shot.

**Daily-ceiling override is real now**: an ADMIN overriding a
`CHECKIN_DAILY_LIMIT` denial (rail → Override) bypasses exactly that ceiling
for that entry. It used to re-run the same ceiling, deny again, and still mark
the denial resolved. Overriding any *other* denial reason still runs the full
ladder — an expired member's path stays the ₱90 rail conversion.

## A. The grace window

- [ ] A1 · QR in → QR out after 30 min → goodbye card reads "…within 60 minutes and it stays one visit" (not a hardcoded 20)
- [ ] A2 · QR in again after ~40 min away → green card, portal history shows ONE visit; DB row has `reopenCount = 1`, `endedAt` null
- [ ] A3 · Repeat out-and-in twice more within the window → still one row, `reopenCount` climbs; duration keeps accumulating from the original arrival
- [ ] A4 · QR out, wait past 60 min, QR in → a SECOND visit row; both show in history; visit 2 of 8 consumed
- [ ] A5 · Pre-flight: while checked in, open the check-in screen → banner says scanning again checks you out

## B. The edges

- [ ] B1 · Scan twice within 20 min of arrival → `ALREADY_INSIDE`, no accidental checkout, card names the unlock time
- [ ] B2 · Desk `Check out` on the attendance screen, then the member QRs in within 60 min → a NEW visit (a staff close is a decision, not a mistake to undo)
- [ ] B3 · Near closing: QR out at 23:5x, QR in past midnight within the window → a new visit on the new business date, never a reopen of yesterday's row
- [ ] B4 · Membership expires mid-day? A reopen does not re-run the door ladder (same-day only, documented) — but a fresh visit beyond the window does, and denies
- [ ] B5 · Walk-in guest: no QR ever — re-entry is eye contact with the desk; their visit is closed by staff or the stale rule
- [ ] B6 · Expired member on a paid day pass: scan out, scan back in any time today → `REOPENED` on the same paid row (₱90 buys the day)

## C. The ceiling and its override

- [ ] C1 · Drive a member to 8 visits today (seed or repeat A4) → 9th scan is denied `CHECKIN_DAILY_LIMIT`, lands on the rail
- [ ] C2 · As FRONT_DESK there is no override (ADMIN-only, `checkin.override`)
- [ ] C3 · As ADMIN, override with a typed reason → member is IN (`CHECKED_IN`), denial shows OVERRIDDEN and points at the check-in
- [ ] C4 · Override an EXPIRED denial via API → still denied; the rail's walk-in sale is the path
