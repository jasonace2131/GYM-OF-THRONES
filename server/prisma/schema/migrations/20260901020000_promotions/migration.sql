-- ============================================================================
-- Promotions.
--
-- A redeemed promo writes an ordinary Payment with discountType = PROMO. This
-- table only decides WHETHER and BY HOW MUCH; the money arithmetic stays in
-- computeAmounts, where Payment_money_consistent already checks it.
-- ============================================================================

CREATE TYPE "PromotionKind" AS ENUM ('PERCENTAGE', 'FIXED');

CREATE TABLE "Promotion" (
  "id"             UUID           NOT NULL,
  "code"           TEXT           NOT NULL,
  "label"          TEXT           NOT NULL,
  "kind"           "PromotionKind" NOT NULL,
  "value"          INTEGER        NOT NULL,
  "startsOn"       DATE           NOT NULL,
  "endsOn"         DATE           NOT NULL,
  "maxRedemptions" INTEGER,
  "redeemedCount"  INTEGER        NOT NULL DEFAULT 0,
  "planCodes"      TEXT[]         NOT NULL DEFAULT ARRAY[]::TEXT[],
  "isActive"       BOOLEAN        NOT NULL DEFAULT true,
  "createdById"    UUID           NOT NULL,
  "createdAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Promotion_code_key" ON "Promotion"("code");
CREATE INDEX "Promotion_isActive_startsOn_endsOn_idx"
  ON "Promotion"("isActive", "startsOn", "endsOn");

ALTER TABLE "Promotion"
  ADD CONSTRAINT "Promotion_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Promotion"
  -- Same shape as Plan.code: what a member says out loud at a counter, so no
  -- lowercase, no spaces, nothing that sounds the same as something else.
  ADD CONSTRAINT "Promotion_code_shape" CHECK (
    "code" ~ '^[A-Z][A-Z0-9_]{1,23}$'
  ),
  ADD CONSTRAINT "Promotion_label_sane" CHECK (
    char_length(btrim("label")) BETWEEN 1 AND 80
  ),
  ADD CONSTRAINT "Promotion_dates_ordered" CHECK ("endsOn" >= "startsOn"),
  -- PERCENTAGE is basis points: 1..10000 is 0.01%..100%. FIXED is centavos,
  -- capped at the same ceiling as a payment so a promo cannot express a
  -- discount larger than any sale it could apply to.
  ADD CONSTRAINT "Promotion_value_bounded" CHECK (
    ("kind" = 'PERCENTAGE' AND "value" BETWEEN 1 AND 10000) OR
    ("kind" = 'FIXED'      AND "value" BETWEEN 1 AND 10000000)
  ),
  -- Unlimited (NULL) or a real cap. Zero would mean "exists but can never be
  -- redeemed", which is what isActive = false is for and says more clearly.
  ADD CONSTRAINT "Promotion_max_redemptions_sane" CHECK (
    "maxRedemptions" IS NULL OR "maxRedemptions" >= 1
  ),
  -- The counter never runs backwards, and never past its own cap. The
  -- redemption path guards this with a conditional UPDATE; this is the
  -- backstop that makes a bug loud instead of silently over-issuing.
  ADD CONSTRAINT "Promotion_redeemed_within_cap" CHECK (
    "redeemedCount" >= 0 AND
    ("maxRedemptions" IS NULL OR "redeemedCount" <= "maxRedemptions")
  );
