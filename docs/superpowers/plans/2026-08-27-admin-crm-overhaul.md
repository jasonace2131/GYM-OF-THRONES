# Admin CRM Overhaul — A/B/C/D

> Handoff doc. Order is fixed: **A → B → C → D**. A+B ship together, C+D ship together.

## Context

Four defects reported against the admin app:

1. **Setup-card modal renders transparent** — page bleeds through. Root cause: `SetupCardModal` in `client/src/app/admin/stations/page.tsx:265` is hand-rolled and paints `background: var(--p-surface)`, a variable that is **never defined**. Same for `--p-surface2` and `--gold-dark` (9 bare uses found across admin.css/portal.css). A working `Modal.tsx` already exists and was not used.
2. **"PDF" is not a PDF** — the setup card "Print" button is `window.print()` plus an injected `@media print { body > * { display: none } }`. Fragile, no file, no QR at print resolution.
3. **Members page is a read-only database view.** `GET /members` + a 7-column table. No row click, no actions, no bulk, no create. Meanwhile `member.create`, `member.update`, `member.suspend`, `member.delete`, `role.change`, `permission.grant/revoke` are all **defined permission keys granted to ADMIN with no routes behind them**. `User.status` and `User.deletedAt` are read everywhere and written nowhere. Membership/payment write services **already exist** and are simply unwired to this screen.
4. **Table UI is broken on desktop.** `.p-table td` has no desktop padding — only `.p-table[data-stack] td { padding: 13px 18px }` (portal.css:457) and mobile-only rules. The members table has no `data-stack`, so every cell renders at zero padding while `th` keeps `11px 18px`. This is the visual defect in the screenshot.

Outcome: a Members screen staff can actually work from (sell, refund, suspend, message, create), a real PDF setup card, and a table/modal layer that renders correctly.

## Reuse — do not re-invent

| Thing | Path | Note |
|---|---|---|
| `Modal` / `ModalError` | `client/src/components/admin/Modal.tsx` | focus trap, Escape (suppressed while `busy`), scroll lock, full ARIA. Becomes a bottom sheet ≤620px via `.a-modal-*` (admin.css:687-789). |
| `useAdminQuery` / `useDebounced` | `client/src/lib/useAdminQuery.ts` | `{data, loading, error, reload}`, `pollMs` option. |
| `Person`, `StandingBadge`, `DaysLeft`, `Pager`, `DataState` | `client/src/components/admin/` | **`DataState` returns a Card *instead of* children** on loading/error/empty — render the bulk bar OUTSIDE it. |
| `MemberListItem` | `client/src/lib/adminApi.ts` | already carries `role`, `status`, `lastSeenAt`, `allowReason`, `denialReason`, `membership.{id,planCode,startsOn}` — **free drawer content, no new endpoint needed**. |
| `MemberPicker.tsx` | `client/src/components/admin/` | its search logic was lifted from the members page — keep search semantics identical or it drifts. |

---

# A. Modal + CSS variables

**Files:** `client/src/app/admin/admin.css`, `client/src/app/portal/portal.css`, `client/src/app/admin/stations/page.tsx`

- [ ] Define the missing tokens in `admin.css` `:root` next to the existing palette: `--p-surface`, `--p-surface2`, `--gold-dark`. Match the surrounding dark palette — `--p-surface` is the card/modal ground, `--p-surface2` the raised row, `--gold-dark` the pressed/hover gold.
- [ ] Grep both stylesheets for the 9 bare uses; every one must now resolve. `grep -rn "p-surface\|gold-dark" client/src`
- [ ] Delete the module-local `SetupCardModal` markup at `stations/page.tsx:265` and re-express it as `<Modal open title subtitle onClose busy footer>`. Keep the card *body* (QR + credentials) as children; the Print/Close buttons move into `footer`.
- [ ] Remove the injected `@media print` style block — B replaces it.
- [ ] Dedupe while here: `a-pulse` keyframes (admin.css:1124 and :1252) and `.a-scroll` (:371 and :1012) are each defined twice.

**Verify:** open a station setup card — modal is opaque, Escape closes, focus is trapped, focus returns to the trigger, background does not scroll. Resize to 600px — it becomes a bottom sheet.

---

# B. Real PDF setup card

**Files:** `client/src/lib/setupCardPdf.ts` (new), `client/src/app/admin/stations/page.tsx`

**Library: jsPDF** (`jspdf`) — the de-facto client-side PDF generator; MIT, no server round-trip, and the station secret never leaves the browser. QR via the `qrcode` package → `toDataURL()` → `doc.addImage()`.

```
npm i jspdf qrcode -w client
npm i -D @types/qrcode -w client
```

- [ ] `setupCardPdf.ts` exports one function:

```ts
export async function downloadSetupCardPdf(card: {
  stationName: string; stationCode: string; pairingUrl: string;
  code: string; expiresAt: string;
}): Promise<void>
```

  A4 portrait. Gym name header, station name + code, the QR at ~48mm from `await QRCode.toDataURL(card.pairingUrl, { width: 512, margin: 1 })`, the pairing code in a monospace box, the expiry line, and a short "scan this on the tablet" instruction. `doc.save(\`setup-card-${card.stationCode}.pdf\`)`.
- [ ] Button becomes `Download PDF`, `async`, disabled while generating, error surfaced through `ModalError`.
- [ ] `import('jspdf')` dynamically so it stays out of the main admin bundle.

**Verify:** download, open the file, scan the QR with a phone — it must resolve to the same pairing URL the on-screen card shows. Print the PDF; the QR must still scan.

---

# C. Members CRM

The bulk of the work. Screen becomes: **toolbar → table → row-click drawer → bulk bar**.

## C1 — Server: the missing write routes

**Files:** `server/src/users/members.controller.ts`, `server/src/users/members.service.ts`, `server/src/users/dto/*`

`members.controller.ts` is GET-only today. Add, each with the permission key that **already exists and is already granted to ADMIN**:

| Route | Permission | Notes |
|---|---|---|
| `POST /members` | `member.create` | see C2 |
| `PATCH /members/:id` | `member.update` | name, phone, emergency contact |
| `POST /members/:id/suspend` | `member.suspend` | sets `User.status`, requires `reason` |
| `POST /members/:id/reactivate` | `member.suspend` | clears it |
| `DELETE /members/:id` | `member.delete` | soft — sets `deletedAt`; every list/read query must already filter it |
| `POST /members/:id/role` | `role.change` | guard: cannot change your own role |

All keep `@Scope('user')` and the existing **404-not-403** behaviour on a scoped miss (enumeration oracle).

**FRONT_DESK does not hold** `member.create/update/suspend/delete`, `membership.freeze/cancel/term.adjust/status.correct`, `payment.void`, `checkin.void`, `checkin.override`. The drawer must hide (not merely disable) those controls for front desk — drive it off the permission list the client already receives, never off a hardcoded role string.

## C2 — Member creation with a magic link

`User.supabaseId` is **non-nullable**. Only `membership-import.service.ts:140` fabricates UUIDs for legacy rows, and those accounts can never log in. So creation must mint a real Supabase user.

**Decided approach: `generateLink` + Resend SDK.**

- [ ] `server/src/auth/supabase-admin.service.ts` — wraps `supabase.auth.admin.generateLink({ type: 'invite', email })`, returns `{ userId, actionLink }`. Uses `SUPABASE_SERVICE_KEY` (server-only; never a `NEXT_PUBLIC_*` var).
- [ ] `server/src/notifications/email.service.ts` — Resend SDK (`npm i resend -w server`), one `sendMagicLink(to, name, actionLink)`. New env: `RESEND_API_KEY`, `RESEND_FROM`. Add both to `env.validation.ts` as **optional** — an unset key logs a warning and disables sending, exactly like `GEMINI_API_KEY` does in `assistant.service.ts:68`. The gym must still boot without an email bill.
- [ ] `POST /members` flow, in order: validate DTO → `generateLink` → create the `User` row with the returned `supabaseId` inside a transaction → send the email. **If the email send fails the member still exists** — return `{ member, emailSent: false }` and let the UI offer "resend invite". Do not roll back a created member over a mail outage.
- [ ] Optionally assign a plan in the same call (reuse `MembershipService`) so "walk-in signs up and pays" is one submit.

## C3 — Refund vs Void

Today they are indistinguishable at every level. The schema comment reads: *"There is no partial refund and there are no negative amounts — a refund is a void plus a cash-out the gym records in its own books."* That stays true; what is missing is **which one happened**.

**Decided approach: add a `voidKind` column.**

- [ ] `server/prisma/schema/payment.prisma` — `enum PaymentVoidKind { VOID REFUND }`, `voidKind PaymentVoidKind?` on `Payment`.
- [ ] Hand-written migration SQL adding the enum, the column, and the CHECK constraint (**CHECKs only live in migration SQL in this repo**): `voidKind IS NOT NULL` exactly when the payment is voided — i.e. `(voided_at IS NULL) = (void_kind IS NULL)`.
- [ ] `VoidPaymentDto` (`server/src/payments/dto/void-payment.dto.ts`) gains `@IsEnum(PaymentVoidKind) kind!: PaymentVoidKind` — import the enum from the generated Prisma client, **never hand-copy enum members** (that has produced invented values in this repo before).
- [ ] Backfill: existing voided rows → `VOID`.
- [ ] Two buttons in the drawer, not one dropdown: **Void** ("recorded in error — no money moved") and **Refund** ("money returned to the member"). Both take a required reason, 3–200 chars, same as today.

## C4 — Client API surface

**File:** `client/src/lib/adminApi.ts`

Gaps to close: `payments()` does not forward `userId` (the server DTO already supports it); `GET /check-ins` is not wrapped at all; there are no membership action wrappers. Add thin wrappers for: create/update/suspend/reactivate/delete member, assign & replace membership, freeze/cancel, record payment, void/refund payment, member check-in history, post announcement to a member set.

## C5 — The drawer

**Files:** `client/src/components/admin/Drawer.tsx` (new), `client/src/app/admin/admin.css`, `client/src/app/admin/members/page.tsx`

There is **no drawer anywhere in `client/src`** — it must be built. Cheapest correct route: `.a-drawer` reusing the existing `.a-modal-backdrop` with `place-items: stretch end`, a fixed ~460px panel, `transform: translateX` transition. Below 620px it should fall back to the bottom-sheet behaviour the modal already has.

`Drawer.tsx` copies `Modal.tsx`'s focus trap / Escape / scroll-lock / ARIA wholesale — do not ship a drawer with weaker a11y than the modal.

Row click opens it. Contents, in order:

1. **Header** — `<Person>`, `<StandingBadge>`, member code, role chip, ⋯ menu (Edit, Change role, Suspend, Delete).
2. **Membership** — plan, term, `<DaysLeft>`, `allowReason`/`denialReason`. Actions: Assign plan · Replace plan · Freeze · Cancel.
3. **Payments** — recent list, amount from centavos, method, reference, `voidKind` badge where set. Actions: Record payment · Void · Refund.
4. **Attendance** — recent check-ins + the visit count already in the row.
5. **Notes/audit** — whatever the audit log already exposes for this subject.

Every action is a `Modal` over the drawer, and every one calls `reload()` from `useAdminQuery` on success. No optimistic writes.

## C6 — Toolbar + bulk actions

- [ ] Toolbar row above the table: debounced search (`useDebounced`, keep `MemberPicker` semantics), standing filter, plan filter, and a primary **+ New member** button on the right.
- [ ] Checkbox column. Header checkbox = select-all-on-page. Selection is keyed by member id and survives pagination.
- [ ] Contextual bulk bar, rendered **outside `DataState`** (it swaps out children), showing "N selected" + **Suspend / Reactivate** and **Post announcement to selected**, plus Clear.
- [ ] Both bulk actions confirm in a `Modal` listing the affected count before firing, and report per-row failures rather than claiming blanket success.

**Verify (C):** as ADMIN — create a member, confirm the invite email lands and the magic link signs in; assign a plan; record a payment; refund it and confirm the badge reads Refund not Void; void another and confirm it reads Void; suspend, confirm the standing changes, reactivate. As FRONT_DESK — confirm every one of those controls is absent, and that hitting the routes directly returns 403. Then `npx tsc --noEmit` in both workspaces (**ts-jest does not typecheck**) and run the server test suite.

---

# D. Table + UI pass

**Files:** `client/src/app/portal/portal.css`, `client/src/app/admin/admin.css`, the six admin tables

- [ ] **The actual bug first:** give `.p-table td` real desktop padding (`13px 18px`, matching the `data-stack` rule) instead of leaving it to a mobile-only selector. Check all six admin tables afterwards — this rule currently affects every one of them.
- [ ] Row hover + `cursor: pointer` on clickable rows only (`.p-table[data-clickable] tbody tr`), plus a visible `:focus-visible` ring — a row that opens a drawer must be reachable by keyboard.
- [ ] Sticky header on the scroll container (`.a-scroll`, after the dedupe in A).
- [ ] Numeric columns right-aligned and tabular (`font-variant-numeric: tabular-nums`); secondary text one step down in size and muted.
- [ ] Cap row actions at 3 visible icons, everything else in the ⋯ menu.
- [ ] Zebra striping off; a 1px divider is enough at this density.
- [ ] Empty and error states keep using `DataState` — do not introduce a second empty-state pattern.

**Verify (D):** every admin table at 1440 / 1024 / 768 / 390px. No horizontal body scroll; wide tables scroll inside `.a-scroll` only. Tab through a table — focus is visible on every row and control.

---

## Verification gate (before any push)

Repo's standing production gate, in order:

```
clean → build (client + server) → npx tsc --noEmit (both) → npm test
```

Never run `npm run lint` — it is aliased to `eslint --fix` here.

New migration must be applied and `prisma generate` re-run (a missing `prisma generate` is what produced the 195-error Railway build).

---

## Unresolved questions

- [ ] Suspend: block check-in only, or also block portal login?
- [ ] Soft-delete: hide from list entirely, or show under a "Deleted" filter?
- [ ] Invite email: send from a real domain, or Resend's sandbox until DNS is set?
- [ ] Bulk suspend cap — hard limit (e.g. 50/batch) or unlimited?
- [ ] Refund: record the cash-out amount anywhere, or reason text only?
- [ ] Selection survives pagination — also survives a search change, or clear it?
- [ ] `+ New member` — drawer, or full-page form?
