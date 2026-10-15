# Member Portal — Design & Build Reference

**Date:** 2026-08-16
**Status:** Approved, building
**Reference:** `screenshots/reference/Member Portal.dc.html` — used as information architecture, not as visual design.

---

## Decisions

| Decision | Choice |
|---|---|
| Theme | Light app (`#f5f4f2`) with a dark sidebar (`#111`). Marketing site stays dark. |
| Scope | Shell + four core screens: Dashboard, Schedule, Subscription, QR. Five more deferred. |
| Check-in | Member scans a QR displayed at the counter — matches the auth spec, not the wireframe. |
| Habit features | Consistency heatmap and streak counter included. |
| Visual treatment | Same design language as the landing page, dialled down. |
| Data | Mock, behind an async seam. |

---

## 1. Why light, next to a dark marketing site

A dark marketing page and a light application is a deliberate split: the public page sells in one visit, the portal is a tool someone opens daily. The portal also carries the dense material — a calendar grid, four data tables, payment history — which is materially easier to scan on white.

Continuity comes from the gold (`#c9922a`, unchanged), Outfit headings, and the same button and card language. It reads as the same product in a different room.

---

## 2. Routing and shell

Real routes, not the `useState` switching the landing page uses — the portal needs deep links, browser back, and per-page auth.

```
/portal              → redirect to /portal/dashboard
/portal/dashboard
/portal/schedule
/portal/subscription
/portal/qr
```

`app/portal/layout.tsx` owns the shell — sidebar, top bar, and the auth guard — so navigating between pages never re-renders navigation. Deferred routes (`/checkins`, `/pay`, `/progress`, `/coach`, `/announcements`, `/book`) drop into the same shell untouched.

**Auth guard.** No Supabase session redirects to `/`. Renders a neutral loading state while the session resolves rather than flashing the portal.

---

## 3. Token isolation

`globals.css` sets dark tokens on `:root` and a dark `body`. Those would apply to the portal.

Rather than modify it — which risks regressing the landing page — the portal namespaces its own tokens under a single `.portal-root` wrapper in `portal.css`:

```css
.portal-root {
  --p-paper:   #ffffff;
  --p-paper2:  #f5f4f2;
  --p-paper3:  #ebe9e5;
  --p-ink:     #1a1a1a;
  --p-ink2:    #4a4a4a;
  --p-ink3:    #82807c;
  --p-sidebar: #111114;
  --p-border:  rgba(26, 26, 26, 0.1);
  /* gold tokens inherit from globals.css unchanged */
}

/* Without this the dark body shows through on overscroll. */
body:has(.portal-root) {
  background: var(--p-paper2);
}
```

Nothing in `globals.css` changes.

---

## 4. Data seam

No backend exists for memberships, classes, check-ins or payments — only auth. Everything is mock, but the *shape* of the seam is what matters.

`lib/portalData.ts` exports **async functions returning typed data**:

```ts
export async function getDashboard(): Promise<DashboardData>;
export async function getWeekSchedule(weekOffset: number): Promise<DaySchedule[]>;
export async function getSubscription(): Promise<SubscriptionData>;
export async function getCheckInHistory(weeks: number): Promise<CheckInDay[]>;
```

Async from the start is the entire point: when real endpoints land, the bodies become `apiFetch(...)` calls and **no call site changes**. Returning plain objects now would force a rewrite of every screen later. The types become the API contract.

---

## 5. Screens

### Dashboard

Departs from the wireframe's four-equal-tiles opening, which gives "your membership expires in 14 days" the same weight as "you did 23 check-ins" — one is revenue, the other is trivia.

1. **Status band** — greeting, membership state, next class, and the primary actions (`CHECK IN`, `BOOK A CLASS`), with a days-remaining ring on the right.
2. **Renewal urgency escalates.** Neutral above 7 days, gold at 4–7, and loud below 4. A static tile reads identically at 14 days and at 1, which is precisely when it should not.
3. **Consistency heatmap** — 12 weeks, one square per day, intensity by visit count. Plus a streak figure. `187 all-time check-ins` is a number nobody feels; a wall of squares with a gap in it is legible instantly, and gyms are a habit business.
4. Secondary stats, upcoming classes, announcements.

The raw check-in table moves to the deferred Check-in History screen, where someone auditing visits will look for it.

### Class Schedule

Weekly grid: time axis, positioned class blocks, per-slot `available` / `booked` / `full` states, week navigation, booking modal. Desktop-primary.

### My Subscription

Current plan, days remaining with the same urgency treatment, renew CTA, upgrade options, payment history.

### My QR

Per the auth spec, the member **scans a code displayed at the counter** — the screen is a large scan action plus recent check-ins and a how-it-works panel. No personal QR is displayed, because the member's identity comes from their own JWT and no permanent bearer credential should ever be shown in public.

---

## 6. Mobile

The wireframe has no mobile layout — it is a fixed 240px sidebar and a desktop grid.

This matters more than it looks. The portal is used *at the gym*, on a phone, one-handed: checking in, glancing at today's class, showing status. A desktop-only portal is a portal that mostly goes unused.

- Under 900px the sidebar becomes a **bottom tab bar** with the four core destinations.
- Tables become stacked cards.
- The week grid becomes a day view with day-swiping, rather than a squeezed seven-column grid.
- Dashboard and QR are designed mobile-first; Schedule and Subscription are desktop-first and adapt.

---

## 7. Components

Extracted because the deferred screens reuse all of them:

`PortalShell` · `Sidebar` · `MobileTabBar` · `TopBar` · `StatusBand` · `Kpi` · `Card` · `Badge` · `ProgressRing` · `DataTable` · `ConsistencyHeatmap` · `ClassBlock` · `EmptyState`

---

## 8. Deferred

Check-in History, Pay / GCash, My Progress, Message Coach, Book a Coach, Announcements. All additive — they mount into the existing shell and reuse the components above without changing them.

## 9. Out of scope

Real data of any kind. Booking a class, renewing, and checking in are UI-complete but non-functional until their backend modules exist. Buttons that would mutate state are wired to local mock state so the interaction can be seen and judged.
