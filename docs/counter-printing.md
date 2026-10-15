# Counter printing & GCash procedure

> One-time setup for the desk PC, then the day-to-day GCash drill. The slip
> is a **Transaction Slip** — an internal record. The BIR invoice stays the
> booklet until the software is BIR-registered.

## Thermal printer setup (once)

1. Install the **vendor** Windows driver — not "Generic / Text Only"; the slip
   is HTML and needs graphics mode.
2. **Add the `Roll 80 x 297mm` paper size in Printer Properties BEFORE
   testing.** CSS `@page { size }` does *not* create a driver paper size;
   Chrome silently falls back to the nearest one and prints an 80 mm strip
   down an A4 sheet. This is the step that eats a day.
3. Enable **cut after each job** in the driver. The browser cannot command the
   cutter (or a cash drawer) — only raw ESC/POS can, and that is a large step
   up in fragility for no benefit here.
4. Make the thermal printer the machine's **default printer**.
5. Optional: launch Chrome with `--kiosk-printing` (WITHOUT `--kiosk`, so F11
   still works) for a dialog-free counter. This makes "default printer"
   load-bearing — a second installed printer silently eats receipts.
6. One-time verify in the print dialog: margins **None**, headers/footers
   **off**.

Reprints band **REPRINT** automatically; a voided payment prints with a
**VOIDED — NOT A RECORD OF PAYMENT** (or **REFUNDED**) band. The `BIR Invoice
No.` line on the slip is filled when staff typed the booklet number on the
sale; otherwise it prints as a blank rule to copy the number onto by hand.

## GCash at the counter — procedure, not software

- The gym's GCash stays **logged in on the desk device with push
  notifications ON**. Verification is a glance at the notification,
  escalating to opening the **Transactions tab** for anything above the
  configured threshold (`GCASH_VERIFY_THRESHOLD_CENTAVOS`, recommended
  ₱1,000) — the sale form's "Seen in our GCash Transactions tab" tick is that
  attestation, and above the threshold the server refuses without it.
- **Never train a "wait for the text" habit.** GCash discontinued SMS
  confirmations for bank transfers on 25 Oct 2022, and SMS OTP retires fully
  by mid-2026 under a BSP directive.
- **A screenshot is not proof.** GCash's own advisory: if a transaction does
  not appear in your app's history it is not valid, however legitimate the
  screenshot looks — AI tools fake a pixel-perfect one in seconds. The system
  therefore records the reference (duplicates are refused automatically — a
  reused "receipt" is a duplicate reference) and who verified it, never an
  image.
- **Wallet-cap failure mode:** a personal GCash has a ₱100,000 monthly
  incoming cap. A transfer over it is **blocked outright with an error on the
  sender's phone** — at the counter that presents as "my GCash won't send",
  not as a missing payment. If monthly volume approaches the cap, move to
  GCash for Business — which also unlocks the Transactions CSV export a
  future reconciliation report needs.
- **Reconcile monthly at the latest** against the GCash statement; thirty
  days is the practical verification horizon. `GET /reports/gcash` lists the
  period's rows with reference, amount, booklet invoice number and the
  verified flag.

## BIR notes (why the slip says what it says)

- The slip is titled TRANSACTION SLIP and carries "INTERNAL RECORD — NOT A
  BIR-REGISTERED INVOICE" because unregistered software may not issue an
  Invoice/Official Receipt (RA 11976 + RR 7-2024; RR 11-2004 §12 permits
  internal-control documents provided registered invoices are issued).
- Keep issuing the **booklet invoice** for sales, and type its number into
  the sale form (or the payment later) so the register ties the booklet to
  the system row. An SC/PWD sale always gets its own booklet invoice.
- The printed VAT block only appears when `GYM_VAT_REGISTERED=true` — both
  directions are legally load-bearing, so set that flag correctly before the
  first slip prints.
