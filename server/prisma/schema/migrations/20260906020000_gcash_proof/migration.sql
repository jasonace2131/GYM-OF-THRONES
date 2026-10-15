-- Hand-written for the same reason every migration since
-- 20260827010000_payment_void_kind has been: `prisma migrate dev` still
-- refuses against the shared dev database over checksum drift on
-- 20260820010000_chunk2_station_attendance and offers only a reset.
--
-- GCASH PROOF SCREENSHOTS, and the member's own claim.
--
-- The Payment model's header says this system "never accepts an upload —
-- including a GCash 'proof' screenshot". That was written about a WALLET
-- CAPTURE: the member's own GCash home or history, carrying their balance,
-- their name and unrelated payments. RA 10173 proportionality rules that out
-- and still does.
--
-- A GCash SEND CONFIRMATION is a different image. It carries the amount, the
-- timestamp, the reference, and the RECIPIENT's name and number — which is the
-- gym's own account. The sender's name and number are not on it. What is left
-- is an ordinary business record of a payment the gym received, kept for the
-- life of that payment (owner decision).
--
-- It is a paper trail, NOT verification. A reference absent from the gym's own
-- Transactions tab is not a payment however good the picture looks, which is
-- why the named staff attestation is untouched by this migration.

CREATE TYPE "GcashSubmissionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- A waiting claim is exactly the thing the notification board exists for: it
-- needs a person to go and look at something, and nothing else will tell them.
ALTER TYPE "SystemNotificationKind" ADD VALUE IF NOT EXISTS 'GCASH_SUBMISSION';

-- ── The image on a payment ───────────────────────────────────────────────

ALTER TABLE "Payment" ADD COLUMN "proofPath" TEXT;

-- A proof only means anything on a GCash row. Cash has no reference to prove
-- and no screenshot to take, and allowing one would invite a photo of a till.
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_proof_gcash_only" CHECK (
    "proofPath" IS NULL OR "method" = 'GCASH'
  );

-- ── The member's claim ───────────────────────────────────────────────────
--
-- NOT a payment, and it must never become one by itself. Approval by a named
-- operator against an open shift is what writes the Payment; this table only
-- ever records that a member said they sent money.

CREATE TABLE "GcashSubmission" (
  "id"                  UUID                    NOT NULL,
  "userId"              UUID                    NOT NULL,
  "status"              "GcashSubmissionStatus" NOT NULL DEFAULT 'PENDING',
  "planCode"            TEXT                    NOT NULL,
  "amountCentavos"      INTEGER                 NOT NULL,
  "reference"           TEXT                    NOT NULL,
  "referenceNormalized" TEXT                    NOT NULL,
  -- Required here, unlike on a counter sale: staff can look at the member's
  -- phone across the desk, and for a remote claim this is the only thing there
  -- is to look at.
  "proofPath"           TEXT                    NOT NULL,
  "submittedAt"         TIMESTAMPTZ(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt"          TIMESTAMPTZ(3),
  "reviewedById"        UUID,
  "rejectReason"        TEXT,
  "paymentId"           UUID,
  "createdAt"           TIMESTAMPTZ(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMPTZ(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "GcashSubmission_pkey" PRIMARY KEY ("id")
);

-- The member's own claims go when the member goes. The staff review does not:
-- Restrict, like every other actor reference, so a leaver cannot be deleted
-- out from under a decision they made about somebody's money.
ALTER TABLE "GcashSubmission"
  ADD CONSTRAINT "GcashSubmission_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GcashSubmission"
  ADD CONSTRAINT "GcashSubmission_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GcashSubmission"
  ADD CONSTRAINT "GcashSubmission_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- One claim per payment. Without this, two approvals racing on one claim could
-- mint two Payments for one transfer — the exact double-count the drawer would
-- then have to explain.
CREATE UNIQUE INDEX "GcashSubmission_paymentId_key"
  ON "GcashSubmission" ("paymentId") WHERE "paymentId" IS NOT NULL;

-- Money is integer centavos and never negative, everywhere. A claim of zero is
-- not a claim.
ALTER TABLE "GcashSubmission"
  ADD CONSTRAINT "GcashSubmission_amount_positive" CHECK ("amountCentavos" > 0);

-- The normalized reference is what every comparison reads, so it may not be
-- blank — a blank one would collide with every other blank one.
ALTER TABLE "GcashSubmission"
  ADD CONSTRAINT "GcashSubmission_reference_present" CHECK (
    length(btrim("reference")) > 0 AND length("referenceNormalized") > 0
  );

-- A reviewer without an instant, or an instant without a reviewer, cannot
-- answer "who decided this and when" — the only reason either column exists.
ALTER TABLE "GcashSubmission"
  ADD CONSTRAINT "GcashSubmission_review_shape" CHECK (
    ("reviewedAt" IS NULL) = ("reviewedById" IS NULL)
  );

-- The three states, each with the shape it must have. PENDING has been decided
-- by nobody; APPROVED points at the Payment it became; REJECTED carries a
-- reason the MEMBER reads, so a blank one is not allowed.
ALTER TABLE "GcashSubmission"
  ADD CONSTRAINT "GcashSubmission_status_shape" CHECK (
    (
      "status" = 'PENDING'
      AND "reviewedAt" IS NULL AND "paymentId" IS NULL AND "rejectReason" IS NULL
    )
    OR (
      "status" = 'APPROVED'
      AND "reviewedAt" IS NOT NULL AND "paymentId" IS NOT NULL AND "rejectReason" IS NULL
    )
    OR (
      "status" = 'REJECTED'
      AND "reviewedAt" IS NOT NULL AND "paymentId" IS NULL
      AND length(btrim("rejectReason")) >= 3
    )
  );

-- At most ONE live claim per reference. A member tapping submit twice, or
-- re-sending the same screenshot next week, produces one row for staff to
-- judge rather than a queue full of the same transfer.
--
-- PENDING only, on purpose: once a claim is rejected the member may legitimately
-- resubmit the same reference with a correction, and a rejected row must not
-- lock them out of doing so.
CREATE UNIQUE INDEX "GcashSubmission_pending_reference_once"
  ON "GcashSubmission" ("referenceNormalized") WHERE "status" = 'PENDING';

-- The review queue: oldest pending first, because a member who submitted on
-- Monday should not wait behind one who submitted this morning.
CREATE INDEX "GcashSubmission_status_submittedAt_idx"
  ON "GcashSubmission" ("status", "submittedAt");

-- "What have I submitted, and what happened to it?"
CREATE INDEX "GcashSubmission_userId_submittedAt_idx"
  ON "GcashSubmission" ("userId", "submittedAt" DESC);

-- The duplicate check against live payments, and what makes a recycled
-- reference findable across both tables.
CREATE INDEX "GcashSubmission_referenceNormalized_idx"
  ON "GcashSubmission" ("referenceNormalized");
