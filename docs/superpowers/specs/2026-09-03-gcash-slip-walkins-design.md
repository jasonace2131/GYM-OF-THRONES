# GCash recording + printable slip, and the Walk-ins page

Design doc. Two features, one session. Everything below is checked against the tree at
`E:/ALL PROJECTS/GYM OF THRONES/GYM OF THRONES` — line numbers are from the files as they
stand today.

---

## 0. The three decisions that shape everything else

### 0.1 There is no screenshot column. The proof is the reference plus a named attestation.

The brief asks for "optionally a proof screenshot". **v1 does not store images**, and this is a
decision rather than a deferral. Five facts, each independently sufficient:

1. **GCash's own advisory says the image proves nothing.** Mynt/GCash, on AI-generated fakes:
   *"If a transaction doesn't appear in your app's history, it should not be considered valid,
   even if you receive what may appear to be a legitimate-looking screenshot."* Free tools now
   render a pixel-correct confirmation screen in seconds. The thing that has evidentiary value is
   **"a named member of staff opened the gym's own GCash Transactions tab and saw it"** — and that
   is a boolean plus a user id, not a 1 MB PNG.
2. **The screenshot cannot even identify the payer.** GCash anonymised counterparty names in Send
   Money from ~Sept 2022 and since 2025 masks the recipient's first name on the shareable screen
   (`J****n D.`). The unmasked name exists only inside the gym's own account — i.e. in the same
   place the attestation is made.
3. **RA 10173 proportionality.** Processing must be *"adequate, relevant, suitable, necessary, and
   not excessive"* and permitted *"only if the purpose cannot reasonably be fulfilled by other
   means"*. The reference alone reconciles. The NPC has separately struck down screen-capture-based
   collection as excessive. A wallet screenshot carries the payer's name, partial number, sometimes
   the balance, often unrelated transactions, and frequently EXIF GPS.
4. **This repo has no way to answer "who looked at it".** There is no `AuditLog` table (grep finds
   only a comment at `permissions.service.ts:64` and Phase-4 plans). Storing unaudited financial
   images in a codebase that peppers IPs rather than store them (`env.validation.ts:92-94`,
   `consent.prisma:41-46`) is off-posture.
5. **It reverses a written owner decision and a deleted feature.** Spec decision #9
   (`docs/superpowers/specs/2026-08-18-membership-attendance-design.md:99`): *"No file uploads, no
   proof screenshots, no payment processing."* `payment.prisma:12-13`: *"never accepts an upload"*.
   `client/src/app/portal/pay/page.tsx:18-20` is the tombstone of a GCash upload flow that was
   built and deliberately removed.

There is also no upload infrastructure at all: no `FileInterceptor`/multer wiring, no Supabase
Storage client (`client/src/lib/supabase.ts:24` and `server/src/auth/supabase-admin.service.ts:39`
are both auth-only), no bucket, `main.ts` has no `bodyParser` config so JSON is capped at Express's
100 kb default, and helmet's default `Cross-Origin-Resource-Policy: same-origin` blocks proxied
image bytes between Vercel and Railway.

**If the owner overrules this** (question 3 in *unresolved*), the v2 shape is fully specified in
§7.1 and is a contained addition — no v1 decision has to be undone.

### 0.2 The printed thing is a Transaction Slip, not an invoice, and it must not pretend otherwise.

Under RA 11976 + RR 7-2024 the **Invoice** is now the primary document for a sale of *services*;
the Official Receipt is a supplementary document. Any machine **or software** that issues the
primary invoice must be BIR-registered — no revenue threshold, no small-business exemption. This
CRM is not registered, and registering it as a CAS would pull the gym into RR 11-2025's mandatory
structured e-invoicing the moment it crosses ₱3M.

So the printable:

- **Is titled `TRANSACTION SLIP`.** Not "Invoice", not "Sales Invoice", not "Service Invoice", not
  "Official Receipt" — using any of those on unregistered software is *use of unregistered
  invoices* (₱20,000 first / ₱50,000 second offence, plus Sec. 264 exposure).
- **Carries the legend** `INTERNAL RECORD — NOT A BIR-REGISTERED INVOICE. Ask the counter for your
  BIR Invoice.` Legal basis for existing at all: RR 11-2004 §12 — a register or POS may be used
  *"for internal control purpose, Provided that, duly registered sales invoices or receipts are
  issued for every sale."*
- **Does NOT print** `THIS DOCUMENT IS NOT VALID FOR CLAIM OF INPUT TAX.` The two research briefs
  disagree here and `bir-invoice` is right: that legend belongs only on **BIR-registered
  supplementary documents**, which have their own ATP. Printing it on an unregistered slip falsely
  implies registration.
- **Never prints** a validity/expiry legend (abolished by RR 6-2022), a "Business Style" field
  (RMC 77-2024: not required), or an ATP/OCN/PTU/ACCN/MIN it does not have.
- **Prints `BIR Invoice No.: ____`** — filled from `Payment.receiptNo` when set, a blank rule when
  not. This is the single line that attacks the problem `payment.prisma:63-65` names as the real
  one: *"tying a booklet number to a system row"*.

### 0.3 The slip's number is derived, not sequenced.

`payment.prisma:63-65` deliberately makes `receiptNo` free text and spec §5.10 lists "a `receiptNo`
sequence" as a non-goal. That objection was about the **legal** number, and a counter table for an
**internal** number would be a different question — but v1 does not need one either.

**`docNo = GOT-{businessDate without dashes}-{first 6 hex of payment.id, uppercased}`**
→ `GOT-20260903-A3F1C9`.

Unique by construction, human-quotable over a counter, stable across reprints and across a void
(so "a void keeps its number" holds for free), self-dating, and **zero schema**. It is not
sequential — which is exactly right for a document with no legal sequencing duty. It also cannot
create the gap-explanation problem a sequence creates when a print is abandoned.

Upgrade path, if the app is ever registered as a CAS or loose-leaf: at that point the number must
be a *real BIR serial from an approved range*, so the `DocumentCounter` table would be built to
that spec (`UPDATE … SET seq = seq + 1 RETURNING seq`, never `SELECT MAX … FOR UPDATE`, which locks
nothing on a day with no rows), allocated inside the same transaction as the `Payment`. Building it
now would be building the wrong thing.

---

## 1. Feature 1 — data model

### 1.1 New columns on `Payment`

`server/prisma/schema/payment.prisma` (all nullable, all additive):

```prisma
  // The reference exactly as staff typed it stays in `reference` above, for
  // audit. This is that value with every non-alphanumeric stripped and the
  // rest uppercased, and it is the ONLY thing compared: GCash renders one
  // reference both as 6028871884223 and as 6028 871 884223, so without this
  // the same payment stores as two distinct strings and duplicate detection
  // silently never fires.
  referenceNormalized String?

  // Staff opened the gym's own GCash Transactions tab and saw this payment.
  // Per GCash's own advisory a reference that is not in your account is worth
  // nothing even with a perfect-looking screenshot, so this — not an image —
  // is what turns a claim into a verification. NOT NULL together, and only
  // ever on a GCASH row (Payment_gcash_verified_shape).
  gcashVerifiedAt   DateTime? @db.Timestamptz(3)
  gcashVerifiedById String?   @db.Uuid
  gcashVerifiedBy   User?     @relation("PaymentGcashVerifiedBy", fields: [gcashVerifiedById], references: [id], onDelete: Restrict)
```

`User` gains the reverse relation `paymentsGcashVerified Payment[] @relation("PaymentGcashVerifiedBy")`.

**No index on `gcashVerifiedAt`** — the only query is "unverified GCash rows for a business date",
which the existing `@@index([businessDate, status])` already prunes.

### 1.2 Migration SQL (hand-written; CHECKs have no Prisma representation)

New directory `server/prisma/schema/migrations/2026XXXXXXXXXX_gcash_reference_and_verification/`.

Order matters — **backfill before the CHECK, CHECK before the index**:

```sql
ALTER TABLE "Payment"
  ADD COLUMN "referenceNormalized" TEXT,
  ADD COLUMN "gcashVerifiedAt"     TIMESTAMPTZ(3),
  ADD COLUMN "gcashVerifiedById"   UUID;

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_gcashVerifiedById_fkey"
  FOREIGN KEY ("gcashVerifiedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill BEFORE the CHECK, or every existing GCash row violates it.
UPDATE "Payment"
   SET "referenceNormalized" = upper(regexp_replace("reference", '[^A-Za-z0-9]', '', 'g'))
 WHERE "reference" IS NOT NULL;

-- Biconditional on `reference`, not on `method`: a CASH row is allowed to
-- carry a reference today (nothing forbids it), and if it does, it normalizes
-- too. The unique index below excludes it by predicate, not by this CHECK.
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_reference_normalized_shape" CHECK (
    ("reference" IS NULL) = ("referenceNormalized" IS NULL)
    AND ("referenceNormalized" IS NULL OR "referenceNormalized" ~ '^[A-Z0-9]+$')
  );

-- Same shape as Payment_void_kind_shape: the pair moves together, and an
-- attestation about a GCash transaction on a CASH row is nonsense.
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_gcash_verified_shape" CHECK (
    ("gcashVerifiedAt" IS NULL) = ("gcashVerifiedById" IS NULL)
    AND ("gcashVerifiedAt" IS NULL OR "method" = 'GCASH')
  );

-- THE fraud control. A reused screenshot is, definitionally, a duplicate
-- reference — the one fraud pattern catchable in-database with no payment API.
-- VOIDED excluded so a mis-keyed reference can be voided and re-entered.
-- All-time scope is correct: GCash references do not expire.
-- IF THIS FAILS, the database already holds two live rows with the same
-- normalized reference. Find them, void the wrong one, re-run:
--   SELECT "referenceNormalized", count(*) FROM "Payment"
--    WHERE "method" = 'GCASH' AND "status" <> 'VOIDED'
--      AND "referenceNormalized" IS NOT NULL
--    GROUP BY 1 HAVING count(*) > 1;
CREATE UNIQUE INDEX "Payment_gcash_reference_unique"
    ON "Payment" ("referenceNormalized")
 WHERE "method" = 'GCASH' AND "status" <> 'VOIDED';
```

**Migration blockage.** `20260827010000_payment_void_kind/migration.sql:1-8` records that
`prisma migrate dev` — even `--create-only` — refuses against the shared dev DB because of checksum
drift on `20260820010000_chunk2_station_attendance`, offering only `migrate reset`. Five migrations
have landed since, so the drift may have been cleared. **Try `npx prisma migrate dev` first**; if it
still refuses, hand-write the file with the same header comment that migration carries, and say so
in the commit.

### 1.3 The trap: `createMany({ skipDuplicates: true })` swallows the new index too

This is the sharpest edge in the change and it is invisible if you don't look for it.

`PaymentsService.createInTx` (`payments.service.ts:269-312`) is the **one** `INSERT INTO Payment`,
and it uses `createMany({ skipDuplicates: true })` — which compiles to `ON CONFLICT DO NOTHING`
**with no conflict target**. It therefore suppresses *every* unique violation on the table, not just
`Payment_idempotencyKey_key`. The moment a second unique index exists:

- duplicate reference → `count === 0`, row not inserted
- `findUniqueOrThrow({ idempotencyKey })` → **P2025 → bare 500**, not a usable error.

The fix is a two-line branch, and it is race-safe without any pre-check (a suppressed conflict is
not a statement error, so the transaction is alive and further statements on `tx` are legal — the
§4.6(d) rule is about *caught* violations):

```ts
const { count } = await tx.payment.createMany({ data: [ … ], skipDuplicates: true });

const stored = await tx.payment.findUnique({ where: { idempotencyKey: input.idempotencyKey } });

if (stored === null) {
  // The conflict was NOT on idempotencyKey — the only other unique index on
  // this table is Payment_gcash_reference_unique, so this reference is already
  // recorded against a live payment. Name it: the desk has to tell "I already
  // rang this one" apart from "this member is showing me a recycled receipt".
  const earlier = await tx.payment.findFirst({
    where: { referenceNormalized: input.referenceNormalized, method: 'GCASH',
             status: { not: 'VOIDED' } },
    select: { id: true, businessDate: true, netCentavos: true },
  });
  throw new DomainException('GCASH_REFERENCE_DUPLICATE', …, HttpStatus.CONFLICT);
}
```

The unique index remains as the concurrency backstop; the mapper entry (§1.5) covers the race where
two requests reach the insert at once.

### 1.4 Normalization and validation — deliberately loose

`server/src/payments/payment-reference.ts`:

```ts
export function normalizeGcashReference(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
/** The usual shape. FALSE IS NOT AN ERROR — it drives a hint, never a refusal. */
export function looksLikeGcashReference(normalized: string): boolean {
  return /^\d{13}$/.test(normalized);
}
```

**Do not add `^\d{13}$` as validation.** Real references are 10–13 characters, alphanumeric on older
transaction formats, and 14 digits when the money arrived from a bank over InstaPay
(`FTOB-20190927-000141`, keyed as `20190927000141`). A strict rule refuses legitimate money at the
counter. DTO bounds stay exactly where they are (`RecordPaymentDto` `@Length(3,64)`,
`SellWalkInDto` `@Length(4,64)`) so the "DTO bounds match the CHECKs character for character" rule
(`record-payment.dto.ts:9-11`) still holds — and no length CHECK is added.

The 13-digit expectation is surfaced **in the UI as a non-blocking hint** (§3.3).

### 1.5 Error codes

`shared/src/types/api.types.ts`, beside `GCASH_REFERENCE_REQUIRED` (line 92):

```ts
  // A live GCash payment already carries this reference. The desk must be able
  // to tell "I already recorded this one" apart from "this member is showing
  // me a receipt they already spent", so it is not folded into
  // PAYMENT_SHAPE_INVALID the way Payment_gcash_reference is.
  | 'GCASH_REFERENCE_DUPLICATE'
  // Above GCASH_VERIFY_THRESHOLD_CENTAVOS, staff must confirm they saw the
  // transaction in the gym's own GCash app before the sale saves.
  | 'GCASH_VERIFICATION_REQUIRED'
```

`server/src/common/exceptions/prisma-error.mapper.ts`:

```ts
  Payment_gcash_reference_unique: 'GCASH_REFERENCE_DUPLICATE',
  Payment_reference_normalized_shape: 'PAYMENT_SHAPE_INVALID',
  // Payment_gcash_verified_shape is deliberately ABSENT — same reasoning as
  // Payment_void_kind_shape: the pair is written together in one statement
  // from a boolean DTO field, so no client input can violate it. A 500 with
  // the raw constraint logged is the correct signal for a service bug.
```
plus `Payment_gcash_reference_unique: HttpStatus.CONFLICT` in `CONSTRAINT_STATUSES` — the caller did
not send something malformed, they lost a race.

`server/test/membership-constraints.e2e-spec.ts` must be edited in two places or the suite fails:
the Payment CHECK list at `:320-330` (now 10, comment updated from "— 8") and the unique-index test
at `:353-361`, which gains `Payment_gcash_reference_unique`. Assert the index **predicate**, not
just the name — CLAUDE.md's own rough-edges note explains why (`StationScan_opening_checkin_once`
shipped with the wrong filter and 500'd the counter).

### 1.6 Verification threshold

`GCASH_VERIFY_THRESHOLD_CENTAVOS` — **optional**, and unset is a supported state meaning *never
required* (the `GYM_GCASH_NUMBER` precedent at `env.validation.ts:144-150`). When set, a GCASH
payment whose `netCentavos >= threshold` must arrive with `gcashVerified: true` or `createInTx`
throws `GCASH_VERIFICATION_REQUIRED` (422). The checkbox is **always offered**, only sometimes
required.

Recommended production value ₱1,000 (`100000`): the ₱90 day pass is untouched, a multi-month
membership is not. Thirty seconds of counter friction is wrong for ₱90 and obviously right for
₱12,000, and the fraud literature is explicit that the scam is timed to the busiest moment.

### 1.7 `receiptNo` / `receiptIssued` — recon confirmed, half-true

- **`receiptIssued` IS written**: `payments.service.ts:297` `receiptIssued: input.receiptNo !== null`.
  The comment above it at `:292-296` still asserts it is "WRITTEN BY NOTHING" — that comment
  described the bug the same commit fixed. **Rewrite it**, keeping only the last sentence (the
  derivation argument), and add a unit assertion, since `grep receiptIssued server/test/` returns
  nothing today.
- **`receiptNo` is genuinely unreachable from the client.** It is typed in five `adminApi` request
  bodies (`adminApi.ts:98, 606, 629, 648, 691`) and **no component sets it**, so it is NULL on every
  row in production, `receiptIssued` is `false` on every row, and `buildOwnerSummary`'s
  `paymentsWithoutReceiptNo` (`reports.service.ts:352`) permanently equals the day's whole RECORDED
  count. Wiring it (§3.4) is what makes that counter mean something.
- **The walk-in path cannot carry it at all**: `SellWalkInDto` has no `receiptNo` field and
  `walk-in.service.ts:204` pins `receiptNo: null`. Both are fixed.

No `RECEIPT_PROMPT_THRESHOLD_CENTAVOS` (spec §5.7.6's "prompts above a configurable amount") — it
needs a config channel to the browser that does not exist, and would push a TIN-adjacent setting
into the `@Public()` `GET /config`. The field is simply always available, collapsed on the walk-in
sheet and expanded everywhere else. Marked **v2**.

---

## 2. Feature 1 — routes

### 2.1 `GET /api/v1/payments/:id/receipt` → `ReceiptDoc`

`server/src/payments/payments.controller.ts`, `@RequirePermission('payment.read')`, no `@Scope`
(the id is explicit; the same key already gates the list). No new permission key: printing is
reading, and a `payment.invoice.print` key would be a catalogue entry and two role grants to seed
for no separation of duty.

Ordinary JSON — `TransformInterceptor` wraps it — because **the client renders the HTML**. That
avoids the `@Header` override dance `statutory-discounts.csv` needs (`reports.controller.ts:87-88`)
entirely.

`server/src/payments/receipt.presenter.ts` — a **pure** function `toReceiptDoc(row, seller, now)`
beside its `.spec.ts`, matching the house convention for logic that encodes a statute.

```ts
export interface ReceiptDoc {
  docNo: string;              // GOT-20260903-A3F1C9
  issuedAt: string;           // ISO instant, render time
  seller: {                   // every field nullable; a null line is OMITTED,
    registeredName: string | null;   // never rendered as a placeholder
    tradeName: string | null;
    address: string | null;
    tin: string | null;
    vatRegistered: boolean;   // drives "VAT Reg TIN …" vs "Non-VAT Reg TIN …"
  };
  buyer: { name: string | null; memberCode: string | null };
  line: { description: string; quantity: number; unitCostCentavos: number };
  totals: {
    grossCentavos: number;
    vatableSalesCentavos: number;      // 0 when the sale is VAT-exempt
    vatExemptSalesCentavos: number;    // = vatBaseCentavos when vatExempt
    vatAmountCentavos: number;         // gross − vatBase; 0 when non-VAT
    vatBaseCentavos: number;
    discountCentavos: number;
    netCentavos: number;
  };
  showVatBlock: boolean;      // === GymConfigService.vatRegistered
  discount: null | {
    type: DiscountType;
    label: string;                     // 'Senior citizen (20%)' | 'PWD (20%)' | …
    statutory: boolean;                // SENIOR | PWD
    idNo: string | null;               // OSCA / PWD ID
    reason: string | null;             // discretionary types
    centavos: number;
    vatExemptionCentavos: number | null;  // null unless VAT-registered
  };
  payment: {
    method: 'CASH' | 'GCASH';
    reference: string | null;          // as typed
    referenceTail: string | null;      // last 4, for read-back
    gcashVerified: boolean;
    businessDate: CivilDate;
    receivedAt: string;
  };
  birInvoiceNo: string | null;         // Payment.receiptNo
  status: 'RECORDED' | 'VOIDED';
  voidKind: 'VOID' | 'REFUND' | null;
  voidedAt: string | null;
  voidReason: string | null;
  recordedByName: string;
  notice: string;                      // the fixed BIR legend, server-owned
}
```

**Money rule respected**: every amount is an integer of centavos; the client renders the peso sign.
`notice` is *copy*, not currency — it is legally load-bearing and must change in one place, which is
why it is composed server-side.

**`showVatBlock` is a server decision, not a client one.** Whether a VAT line exists is a function
of `GymConfigService.vatRegistered`. A non-VAT seller printing anything VAT-shaped becomes liable
for the VAT with no input credit **plus a 50% surcharge** (RR 7-2024 D.1). A VAT-registered seller
omitting `VAT-Exempt Sale` on an SC/PWD sale is liable for VAT *as if Sec. 109 did not apply*
(D.2). Both are template-level assertions with unit tests, not conditionals a designer can drop.

**The stored columns are authoritative — never re-run `computeAmounts`.** A repriced plan or a
flipped `GYM_VAT_REGISTERED` would otherwise rewrite a receipt already handed over.
`membership-terms.ts:126-167` rounds once at sale time and stores all three figures; the presenter
derives `vatAmountCentavos = gross − vatBase` so the printed lines foot exactly.

The service query adds `include: { user: …, recordedBy: { select: { firstName, lastName } } }` —
`PaymentSummary` sends `recordedById` as a raw uuid (`payment.presenter.ts:46`) and a slip signed
"Recorded by a3f1c9d2…" is unusable. `reports.service.ts:244` already demonstrates the include.

### 2.2 Seller identity — new config, deliberately NOT on `GET /config`

There is no `GYM_NAME`, `GYM_ADDRESS` or `GYM_TIN` anywhere in the repo; the address exists as four
hard-coded client strings and no TIN exists at all. Five new **optional** env vars
(`env.validation.ts` → `GymConfigService` → **the receipt presenter only**):

| var | example |
|---|---|
| `GYM_REGISTERED_NAME` | exactly as on the BIR COR |
| `GYM_TRADE_NAME` | `Gym of Thrones` |
| `GYM_REGISTERED_ADDRESS` | `4th Floor, JWMGI Building, Taguig City 1630` |
| `GYM_TIN` | `987-654-321-00000` (9 digits + 5-digit branch code) |
| `GCASH_VERIFY_THRESHOLD_CENTAVOS` | unset, or `100000` |

All optional, all `?? null`, all omitted from the slip rather than rendered as a placeholder — the
`gym.config.ts:100-104` pattern, for the same reason ("a plausible-looking wrong value is worse
than an absence"). Three places each: `env.validation.ts`, root `.env.example`, the operator's own
`server/.env`.

**Not added to `toPublicGymConfig`.** A TIN and a registered address on a `@Public()` route is
gratuitous disclosure, and that presenter is an explicit allow-list precisely so adding a field is
a conscious decision to publish (`public-config.presenter.ts:4-14`). The receipt route already
carries `payment.read`.

### 2.3 `CheckInRecord.paymentId`

`shared/src/types/attendance.types.ts` — `CheckInRecord` gains `paymentId: string | null`, and
`desk.presenter.ts`'s `CheckInRecordSource` + `toCheckInRecord` pass it through
(`check-ins-report.service.ts:82` already loads the whole row, so no query changes).

Why it is safe: `CheckInRecord` *contains* a `DeskMember`; it is not itself the lobby projection
(the display feed uses `DeskArrival`). `paymentId` is an opaque uuid, carries no money, and a COACH
— the only holder of `checkin.read` without `payment.read` — cannot fetch anything with it.

Why it is needed: `POST /front-desk/walk-ins` returns a `CheckInRecord` with no payment id at all,
so after ringing a ₱90 day pass the client has **nothing to print** and, for an account-less guest,
no `userId` to re-query `/payments` with either. This is the field that turns "sold" into "print the
slip", and it gives the walk-in register a per-row **Slip** button.

### 2.4 Reports

`GcashReferenceRow` (`reports.service.ts:75-81`) gains `receiptNo: string | null` and
`verified: boolean`. That makes the row the BIR RMC 4-2021 trio (date, amount, reference) plus the
two reconciliation flags, so the bookkeeper can use it as-is.

`OwnerSummaryPayload` gains `gcashUnverified: number` beside the existing
`paymentsWithoutReceiptNo` (`:118` / computed `:352`) — same idea, same place, computed from rows
already fetched at `:242-245`.

**Not in v1:** `/reports/gcash.csv`, a client wrapper for `/reports/gcash`, and the GCash-for-
Business CSV *import* reconciler. `/reports/gcash` and `/reports/statutory-discounts` are already
server-only with no client wrapper — a pre-existing gap. Downloading an authed CSV from the browser
needs blob-fetch plumbing `apiFetch` does not have (`api.ts:65` hardcodes JSON, `:74` always parses
`response.json()`). See §7.2.

---

## 3. Feature 1 — client

### 3.1 The slip is a *document*, not a fourth surface

CLAUDE.md forbids a fourth surface. The slip is not one: no navigation, no session chrome, no
interactivity, no shared tokens — and it is **deliberately isolated** from
`portal.css`/`admin.css`/`desk.css` rather than participating in them. That sentence goes in the
file header so the next reader does not "fix" it by importing `portal.css`.

Three approaches were considered:

| approach | verdict |
|---|---|
| `@media print` on the admin page | **Reject.** The trigger lives in a drawer under `.portal-root .admin-root`; `globals.css` sets `html{background:#0b0b0d}` and a light `body` colour unconditionally, and Chrome's default `print-color-adjust: economy` drops the background but **keeps the light text** → a near-white slip on white paper. `client/src/app/(legal)/legal.css:173` already works around exactly this. And `@page` is per-document, so 80 mm and A4 could never coexist. |
| iframe → a Next `(print)` route | **Reject.** A route group escapes `admin/layout.tsx` but cannot escape the root `app/layout.tsx`, so it inherits `globals.css`, the dark body and `colorScheme:'dark'`; it boots React plus a second auto-refreshing Supabase client before the dialog opens (1–2 s at a counter); and its auth works only by accident of localStorage sharing. |
| **hidden iframe + `srcdoc`** | **Ship.** Total CSS isolation, its own `@page`, no framework boot, no auth question, sub-100 ms dialog. |

### 3.2 Files

```
client/src/lib/receipt/receiptDoc.ts        # ReceiptDoc, mirroring the presenter field for field
client/src/lib/receipt/renderReceipt.ts     # pure: ReceiptDoc → complete <!doctype html> string
client/src/lib/receipt/renderReceipt.test.ts# vitest (client uses *.test.ts, not *.spec.ts)
client/src/lib/receipt/printReceipt.ts      # the hidden-iframe driver
```

**Escaping is the default, not a discipline.** An unescaped member name, `notes` or `discountReason`
in a same-origin `srcdoc` iframe is XSS with reach into the Supabase token in localStorage. Rather
than `react-dom/server` (which drags a server renderer into the admin bundle and depends on Next's
browser export condition resolving the way you hope), use a ten-line tagged template where escaping
happens automatically:

```ts
const esc = (v: unknown): string =>
  String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** Every interpolation is escaped. Nest a fragment with `raw(...)`. */
function html(strings: TemplateStringsArray, ...values: unknown[]): string { … }
function raw(s: string): Raw { … }
```

The test feeds `"><script>alert(1)</script>` through the payer name, `notes`, `discountReason` and
`voidReason` and asserts no raw `<script` survives — plus: the senior/PWD lines, the VAT block on
and off, the VOIDED and REFUNDED bands, the REPRINT band, and centavo formatting (₱90 → `90.00`,
₱1,120 senior VAT-registered → base 1,000.00 / discount 200.00 / due 800.00).

**CSS, inlined in the `srcdoc` document:**

```css
@page { size: 80mm auto; margin: 0; }   /* margin:0 also hides Chrome's URL/date header */
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
.slip {
  width: 72mm;                     /* 80mm paper, 72mm printable at 203 dpi */
  margin: 0 auto; padding: 3mm 0 10mm;   /* bottom pad = feed before the cut */
  font: 11px/1.35 "Courier New", ui-monospace, monospace;   /* no next/font: display:swap can reflow mid-print */
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.slip__totals, .slip__band { break-inside: avoid; page-break-inside: avoid; }
.slip__band { background:#000; color:#fff; text-align:center; font-weight:700; padding:1.5mm 0; }
```

`mm` for widths (the paper is physical), `px` for type. `print-color-adjust: exact` is required or
the black VOIDED band prints as nothing.

**80 mm only.** `renderReceiptHtml(doc, { format: 'THERMAL_80MM' })` keeps the seam — a second
`@page` block is an afternoon's work — but building A4 up front doubles layout QA for a case that
may never arrive. Marked **v2**.

**The driver:**

```ts
export function printReceipt(doc: ReceiptDoc, opts: { copy: boolean }): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  frame.srcdoc = renderReceiptHtml(doc, { copy: opts.copy });
  frame.onload = () => {
    const w = frame.contentWindow;
    if (w === null) return;
    // Cleanup only. afterprint fires on CANCEL too — the browser never tells
    // you whether ink hit paper. Never remove the frame on a setTimeout;
    // Chrome can tear it down mid-spool.
    w.addEventListener('afterprint', () => frame.remove());
    w.focus();          // Safari/Firefox need focus before print()
    w.print();
  };
  document.body.appendChild(frame);
}
```

**Reprint marking, honestly.** Only the first print is the original; every later one bands
**REPRINT**. `copy` is not a trusted flag — it is *derived from where the button is*: the sale
moment (`WalkInSheet`'s just-sold strip) passes `copy: false`; the payments list, member drawer and
walk-in register pass `copy: true`, because a print from there is by definition a reissue. No
schema, no route, and it cannot be wrong in the direction that matters. A server-side
`printCount`/`firstPrintedAt` with an audit row is **v2** — and note the wart when it lands: a slip
whose original was cancelled at the dialog will band the next one REPRINT, which is far cheaper
than a missing one.

**Void bands.** Two different banners, because they mean different things:
`*** VOIDED — NOT A RECORD OF PAYMENT ***` vs `*** REFUNDED ***`, each with the void date and
reason, as inverted black bands. No grey watermark (thermal dithering plus Chrome's economy mode
kills it) and **no strike-through on the amount** — a rule obscures digits at 203 dpi; let the band
carry the meaning.

### 3.3 Two shared field components (kills five copies)

The identical `method === 'GCASH'` conditional block exists five times today
(`WalkInSheet.tsx:174-185`, `actions/WalkInModal.tsx:195-207`, `actions/SellMembershipModal.tsx:196-207`,
`NewMemberDrawer.tsx:334-345`, `actions/FreezeMembershipModal.tsx:181-190`) plus
`RecordPaymentModal.tsx:156-169`. Rather than editing six copies, extract:

`client/src/components/admin/GcashFields.tsx`
- renders nothing unless `method === 'GCASH'`
- reference input, **`required`** (fixes `RecordPaymentModal.tsx:159`, which labels it "optional"
  while the server 422s on blank — a live UI/server disagreement in exactly this field)
- a **non-blocking** hint under the input: the normalized length and, when it is not 13 digits,
  *"not the usual 13-digit shape — check the screen"*. Never a refusal: older references are
  alphanumeric and bank-funded ones are 14 digits.
- **last-4 echo** for read-back at the counter: `…4223`
- a checkbox **"Seen in our GCash Transactions tab"** → `gcashVerified`, with the sub-line
  *"GCash's own advice: a reference that isn't in your app isn't a payment."*

`client/src/components/admin/ReceiptNoField.tsx`
- an optional `BIR invoice no.` text input, `maxLength={32}`
- `collapsible` prop: collapsed behind a `＋ BIR invoice no.` toggle on the walk-in sheet (a ₱90 sale
  is below the ₱500 issuance threshold and usually gets no booklet invoice), expanded by default on
  membership/record-payment forms, and **auto-expanded with an amber sub-line** when the discount is
  SENIOR or PWD: *"a discounted sale always needs its own BIR invoice"* — RR 7-2010 / RR 5-2017
  require a per-transaction document and a logbook row regardless of the ₱500 rule.

### 3.4 Where the slip is printed from

`client/src/components/admin/PrintSlipButton.tsx` — one component:
`{ paymentId, copy, label? }` → `adminApi.paymentReceipt(id)` → `printReceipt(doc, { copy })`, with
busy state and an inline error. Gated by the caller on `held.has('payment.read')`.

Mounted at:
- `client/src/app/admin/payments/page.tsx` — a new `<th />` after `:102` and `<td>` after `:153`
  (there is no Actions column today). `copy: true`.
- `client/src/components/admin/MemberDrawer.tsx:400-417` — into the existing
  `a-drawer-row-actions` div beside Void/Refund. `copy: true`.
- `client/src/app/admin/walk-ins/page.tsx` — per row where `paymentId !== null`. `copy: true`.
- The walk-in page's just-sold strip. `copy: false`.

**No auto-print on sale.** With `--kiosk-printing` a dialog-free print is silent and correct;
without it, every ₱90 sale would throw a modal. The page shows a gold strip *"Walk-in recorded —
[Print slip]"* instead, and the runbook documents `--kiosk-printing` for gyms that want the
automatic behaviour.

---

## 4. Feature 2 — `/admin/walk-ins`

### 4.1 Nav

`client/src/components/admin/nav.ts` — one item in the **Members** group, immediately after
Attendance (insert after `:70`):

```ts
{ href: '/admin/walk-ins', label: 'Walk-ins', icon: IconScan, permission: 'walkin.sell' },
```

**`walkin.sell`, not `checkin.read`.** The alternative would put the page in a COACH's sidebar
(COACH holds `checkin.read` at OWN), and a coach has no business with the day-pass register.
`walkin.sell` is the catalogue's one composite key (`permission-registry.ts:139-141`,
`requires: ['payment.record','checkin.create']`), granted at ALL to FRONT_DESK (`:234`) and ADMIN
(`:278`) — exactly the two roles whose job this is, both of whom also hold `checkin.read` and
`payment.read`.

The page then gates **in-page** via `useAdminMe()`: the sale card on `walkin.sell`, the register on
`checkin.read`, the KPI strip on `payment.read`, the Make-member button on `member.create`. Hiding
is not a control — every route behind these is checked server-side — but a caller whose grants have
been edited must not be shown a panel that can only 403.

`PRIMARY_HREFS` (`nav.ts:133`) is **unchanged**: the phone bottom bar stays at four, and Walk-ins
lands in `MoreSheet` automatically. Nothing asserts `ADMIN_NAV` anywhere, so this breaks no test.

### 4.2 The structural rule every commercial platform agrees on

Wodify's Drop-Ins page FAQ, verbatim: *"the Drop Ins page does NOT allow you to 'create a drop in'
record; This will happen when they sign up as a drop-in elsewhere."* The sale creates the record;
the page is a **register plus a detail affordance**. Gym of Thrones already matches this — the sale
*is* the check-in — so the page is a ledger, and the "New walk-in" control is the existing sale
form, not a separate registration step.

Also load-bearing: Mindbody's `Walk-In Sale` button sells **only products and gift cards**, never
services, because *"pricing options need to be linked to a specific client's account."* A ₱90 day
pass is a service. **Do not model it as an anonymous POS line** — the existing guest record is what
the sale, the waiver and any RA 9994 discount hang off, and that is also what makes the statutory
discount auditable to a named person, which the statute effectively requires.

### 4.3 Layout

```
/admin/walk-ins
├─ KPI strip (payment.read)     Walk-ins today · Takings today · Cash · GCash
├─ [ just-sold strip ]          "Walk-in recorded — Print slip"   (transient, after a sale)
├─ Sale card (walkin.sell)      <WalkInSheet> mounted standalone, always open
└─ Register card (checkin.read)
     toolbar: Today | 7 days | 30 days   ·   Walk-ins | Guest passes | Both
     table:   Person · Who · In · Out · For · Entry · Actions
     pager
   <NewMemberDrawer>            conditional, seeded
```

**KPIs, all sourced (no fake tiles):**
- *Walk-ins today* — `adminApi.checkIns({ entryType:'WALK_IN', from: today, to: today, limit: 1 }).total`
- *Takings / Cash / GCash* — `adminApi.payments({ planCode:'WALKIN', from: today, to: today, limit: 1 })`
  → `totalCentavos` and `byMethod`, already computed over RECORDED rows only
  (`payments.service.ts:357-387`).

`today = gymToday(new Date(), 'Asia/Manila')` from `client/src/lib/gymTime.ts:23` — **not**
`toISOString().slice(0,10)`. The gym opens 05:00 Manila = 21:00 UTC the previous day.

> **Footnote to write into the page** (or someone will "fix" it): the two counters can legitimately
> disagree. A member already inside who buys a day pass gets a `Payment` but no new `CheckIn` — the
> `count === 0` branch in `walk-in.service.ts:374-379` returns the existing visit — and a GUEST_PASS
> entry is a `CheckIn` with **no** `Payment` at all.

**Columns**, every one readable off `CheckInRecord`:

| column | source |
|---|---|
| Person | `<Person firstName lastName sub={memberCode ?? '—'} avatarUrl>` |
| Who | `member.userId === null ? Badge 'Guest' : Badge 'Member'` |
| In | `gymTime(occurredAt)` |
| Out | `endedAt === null ? 'still in' : gymTime(endedAt)` |
| For | `durationMinutes === null ? '—' : duration(durationMinutes)` — **the guard matters**, `duration()` (`adminApi.ts:964`) is typed `number`, not `number \| null` |
| Entry | `Badge` WALK_IN / GUEST_PASS |
| Actions | **Make member** (`member.create` && `userId === null`) · **Slip** (`payment.read` && `paymentId !== null`) |

Page scaffold copies `client/src/app/admin/payments/page.tsx:29-166` exactly: `PAGE_SIZE = 20`,
`.a-kpis`, `.a-toolbar`, `DataState` → `Card padded={false}` → `.a-scroll > table.p-table` →
`Pager` in `div{padding:'0 18px 16px'}`, and a cache key that encodes every filter
(`` `walkins:${range}:${entryType}:${page}` ``).

### 4.4 Two things the brief asked for that are cut, and why

**"Converted?" filter/column — cut.** There is **no link** from a guest `CheckIn` to the member
account that was later created from it. `NewMemberDrawer` mints a fresh `User` with no
back-reference. A "Converted" column would be a fabricated one, and *"the CRM shows nothing it
cannot source"*. The v2 shape is cheap and reuses an existing pattern: `CheckIn.convertedToUserId`,
written by `POST /members` when a `fromCheckInId` is passed — exactly how `NewMemberSeed.leadId`
already marks a `Lead` CONVERTED server-side. That also unlocks the two numbers owners actually ask
for (conversion rate, average visits before converting) and it is impossible to compute today.

**Repeat-visitor badge ("3rd visit") — cut to v2**, despite being the one thing none of the seven
researched platforms ships. It is not doable client-side at any quality: `guestPhone` is
deliberately never on the wire (`desk.presenter.ts:225-232`, and `DeskMember` is a privacy
boundary), and `guestName` arrives pre-split with a `'Walk-in guest'` fallback that collapses every
anonymous guest into one bucket. Doing it right is a new server route —
`checkIn.groupBy({ by: ['guestPhone'], where: { entryType:'WALK_IN', guestPhone: { not: null },
businessDate: { gte } } })`, pruned by the existing `@@index([businessDate])` — returning **counts
and a label only, never the raw phone**, plus its DTO and a presenter that respects the boundary.
The spec already asks for it twice and it has never been built (design doc `:2989`, `:636`).

### 4.5 Reuse, exactly

- **The sale form is `WalkInSheet` unchanged in shape.** `denial` is already optional
  (`WalkInSheet.tsx:28-37`), so it mounts standalone; pass it the same way the attendance page does
  — by spread, never `denial={undefined}`: `{...(denial === null ? {} : { denial })}`
  (`attendance/page.tsx:199`).
  - Two small props: `onSold` widens to `(record: CheckInRecord) => void` (both existing call sites
    pass zero-arg arrows, which stay assignable — **no changes needed at `attendance/page.tsx:201`
    or `admin/page.tsx:636`**), and an optional `closeLabel?: string` so the always-open card on
    this page reads **Clear** rather than the hardcoded **Cancel**.
  - Also worth fixing while in there: `WalkInSheet` has no `guestEmergencyContact` field (only
    `WalkInModal.tsx:37` does), so a guest sold through the sheet converts with a blank emergency
    contact. Add it, matching `WalkInModal.tsx:131-143`.
  - And its doc comment at `:25-26` claims it echoes `netCentavos` for a price cross-check while the
    submit body never sends it — the server's `PAYMENT_AMOUNT_MISMATCH` guard
    (`walk-in.service.ts:179-186`) is dead code from this client. Send it, or correct the comment.
- **Convert-to-member is `startConvert` from `attendance/page.tsx:61-83`, verbatim** — including the
  `.catch(() => setConverting({}))` fallback (a 404 means the visit was voided or is not a guest;
  the drawer still opens, unseeded). The one-string-to-two-fields name split now exists in two
  places (`attendance/page.tsx:70-75`, `leads/page.tsx:69-80`) and a third copy is a smell, so
  export `seedFromGuest(guest): NewMemberSeed` from `NewMemberDrawer.tsx` and use it from both the
  new page **and** the attendance page.
- **One-step conversion, not Wodify's drop-in → lead → client chain.** Gym of Thrones has no lead
  pipeline for guests and adding one is scope creep; Gymdesk's single `Convert to member` with
  prefill is the model, and it is what the attendance screen already does.
- `NewMemberDrawer` mounts conditionally (`converting !== null &&`), which is what makes its
  `useState`-from-props seeding correct — a re-open with a different seed remounts
  (`NewMemberDrawer.tsx:30-35`).

---

## 5. Client API surface

`client/src/lib/adminApi.ts`:

```ts
// widen the existing params object — the server DTO already accepts all of these
payments: (params: { page?; limit?; method?; from?; to?; userId?;
                     planCode?: string; status?: 'RECORDED' | 'VOIDED' }) => …

paymentReceipt: (id: string): Promise<ReceiptDoc> =>
  apiFetch<ReceiptDoc>(`/payments/${id}/receipt`),

// sellWalkIn body gains:   receiptNo?: string; gcashVerified?: boolean;
// recordPayment body gains: gcashVerified?: boolean;
// (sellMembership / renewMembership / freezeMembership already type receiptNo —
//  they gain gcashVerified only)
```

`PaymentSummary` in `adminApi.ts:219-255` mirrors the presenter field for field and **stays
unchanged** — no proof path, no normalized reference. That type is the shared wire shape for the
permission-gated staff list **and** for `/me/payments` and `/me/overview`'s `lastPayment`
(`me.controller.ts:110-116`, which carry **no `@RequirePermission` by design**, see the comment at
`:40-43`). Anything added to it ships to every member's own portal. The receipt fields travel only
on `ReceiptDoc`, behind `payment.read` — the same narrower-projection-for-the-more-exposed-surface
move `DeskMember` makes.

---

## 6. Counter procedure (docs, not code)

`docs/counter-printing.md`:

1. Install the **vendor** Windows driver — not Generic/Text Only; HTML needs graphics mode.
2. **Add the `Roll 80 x 297mm` paper size in Printer Properties before testing.** CSS `@page { size }`
   does *not* create a driver paper size; Chrome falls back to the nearest one and silently prints
   an 80 mm strip down an A4 sheet. This is the step that eats a day.
3. Enable *cut after each job* in the driver — the browser cannot command the cutter (or a cash
   drawer); only raw ESC/POS can, and that is a large step up in fragility for no benefit here.
4. Make the thermal printer the machine's **default**.
5. Optional: launch Chrome with `--kiosk-printing` (without `--kiosk`, so F11 still works) for a
   dialog-free counter. This makes "default printer" load-bearing — a second installed printer
   silently eats receipts.
6. One-time verify: margins **None**, headers/footers **off**.
7. **GCash procedure, and it is procedure not software:** the gym's GCash stays logged in on the desk
   device with push notifications on. Verification is a glance at the notification, escalating to
   opening the Transactions tab above the threshold. **SMS confirmations no longer exist** — GCash
   discontinued them for bank transfers on 25 Oct 2022 and SMS OTP retires fully by mid-2026 under a
   BSP directive — so nobody should build or be trained on a "wait for the text" habit.
8. **Wallet-cap failure mode:** on a personal GCash the ₱100,000 monthly incoming cap causes a
   transfer to be **blocked outright with an error on the sender's phone**. At the counter that
   presents as *"my GCash won't send"*, not as a missing payment. If monthly volume approaches it,
   move to GCash for Business — which also closes the BIR receipt gap and unlocks the Transactions
   CSV export the v2 reconciler needs.
9. Reconcile **monthly at the latest**. Thirty days is the practical horizon — it is the same window
   Meta's own GCash receipt verifier enforces.

`docs/superpowers/specs/2026-08-18-membership-attendance-design.md` gets an amendment note under
decision #9: uploads remain forbidden; the attestation and the unique reference are what replaced
them; §5.7.6's threshold prompt is still unbuilt and why.

---

## 7. Explicitly v2

**7.1 Proof screenshots.** If the owner overrules §0.1: private Supabase Storage bucket
`payment-proofs` (`@supabase/supabase-js` 2.112.3 is already a server dependency and bundles
`storage-js`, so **no new runtime dep**); a new `SupabaseStorageService` sibling to
`SupabaseAdminService` copying its optional-key warn-and-disable + 503 pattern verbatim
(`supabase-admin.service.ts:39-51, 91-96`); `POST /payments/:id/proof` with
`FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 2*1024*1024, files: 1 } })`
(multer 2.2.0 already hoists via `@nestjs/platform-express`; `@types/multer` is the one devDep to
add); **magic-byte sniffing, never multer's `mimetype`**, and re-encode to strip EXIF; store the
object **key**, never a URL, as `Payment.proofPath` with a `Payment_proof_shape` CHECK and a
`proofPath IS NULL OR method = 'GCASH'` companion; read as `GET /payments/:id/proof` → 60-second
signed URL behind `payment.read`; render with plain `<img>` (there are no `images.remotePatterns` in
`next.config.ts`, which is already a latent bug for `avatarUrl` at `ui.tsx:74`).
**Do NOT add `@Idempotent()`** — `IdempotencyInterceptor` hashes `request.body`
(`idempotency.interceptor.ts:98`), and on multipart the file lives on `request.file` and is invisible
to the hash, so two different screenshots under one key would hash identically and the second would
replay the first. Client uploads need a separate helper: `api.ts:65` hardcodes
`Content-Type: application/json`, and the browser must set its own multipart boundary. And it needs
the `AuditLog` table first.

**7.2 GCash reconciliation as a control, not a list.** Import the GCash for Business Transactions
CSV export, match on normalized reference **plus amount**, and flag three buckets: system rows with
no GCash-side match (candidate fake screenshot), GCash-side rows with no system row (unrecorded
income — a BIR exposure), and amount mismatches. Match on **business date with a tolerance**, not an
exact timestamp: GCash→GCash is instant but bank→GCash over InstaPay lands minutes to hours later,
and a strict matcher would generate false "missing payment" alerts. Normalize the CSV's PHT
timestamps through the existing `GYM_TIMEZONE` path. Needs `/reports/gcash.csv`, a client wrapper,
and blob-download plumbing `apiFetch` does not have.

**7.3 The ₱500 daily-aggregate invoice.** A non-VAT seller owes **one** invoice at end of day for the
aggregate of sub-₱500 sales once they total ₱500 — three ₱90 walk-ins trips it. Surface it on the
shift-close screen: *"16 walk-ins under ₱500 totalling ₱1,440 — one aggregate invoice due."* It falls
straight out of the existing `@@index([businessDate, status])` and is the one genuine BIR obligation
this design does not surface. Always invoice an SC/PWD sale individually, never folded into the
aggregate.

**7.4 SC/PWD discount logbook as a first-class report.** RR 5-2017 makes it mandatory: name, OSCA/PWD
ID, gross, discount, date, **invoice number**. `/reports/statutory-discounts.csv` is 90% of it and
already exists — it needs the `receiptNo` column and a client download.

**7.5** `CheckIn.convertedToUserId` (§4.4) · repeat-guest groupBy route (§4.4) · A4 format (§3.2) ·
server-side `printCount`/`firstPrintedAt` + an `AuditLog` row per print (§3.2) ·
`RECEIPT_PROMPT_THRESHOLD_CENTAVOS` (§1.7) · widening the admin payments filters to the full
`ListPaymentsQueryDto` (status, discountType, shiftId, planCode, date range — all accepted by the
server, none reachable from the UI).

---

## 8. Verification

Standard gate from CLAUDE.md, in order, with dev servers stopped:
`rm -rf client/.next shared/dist server/dist server/tsconfig.build.tsbuildinfo` → build shared →
`prisma:generate` → build server → `ls server/dist/main.js` → build client → typecheck server →
typecheck client → `npm test --workspace=server` → `npm test --workspace=client`.
**Never `npm run lint`** — the server script is `eslint --fix` and rewrites unrelated files.

E2E: `npm run test:e2e --workspace=server` needs its own database built with `migrate deploy` +
`db seed`, **never `db push`** (which skips the hand-written SQL where every CHECK lives).

New tests: `payment-reference.spec.ts` (normalization, grouping equivalence, the 13-digit
predicate), `receipt.presenter.spec.ts` (VAT block on/off, senior maths at both VAT settings,
`vatAmount = gross − vatBase` foots, void/refund, null seller lines omitted),
`renderReceipt.test.ts` (escaping + bands + peso formatting), and additions to
`membership-constraints.e2e-spec.ts` (two new CHECKs by name, the new unique index by name **and
predicate**, plus a raw-insert duplicate-reference rejection using the existing
`insert('Payment', row)` → `.rejects.toThrow(/Payment_gcash_reference_unique/)` pattern).
