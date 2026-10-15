-- Classes and bookings, with an auto-promoting waitlist.

CREATE TYPE "ClassBookingStatus" AS ENUM ('BOOKED', 'WAITLISTED', 'CANCELLED', 'ATTENDED', 'NO_SHOW');

CREATE TABLE "ClassSession" (
    "id"           UUID           NOT NULL,
    "title"        TEXT           NOT NULL,
    "description"  TEXT,
    "coachId"      UUID           NOT NULL,
    "startsAt"     TIMESTAMPTZ(3) NOT NULL,
    "endsAt"       TIMESTAMPTZ(3) NOT NULL,
    "businessDate" DATE           NOT NULL,
    "capacity"     INTEGER        NOT NULL,
    "bookedCount"  INTEGER        NOT NULL DEFAULT 0,
    "cancelledAt"  TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "createdById"  UUID           NOT NULL,
    "createdAt"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ClassSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClassBooking" (
    "id"          UUID                 NOT NULL,
    "sessionId"   UUID                 NOT NULL,
    "userId"      UUID                 NOT NULL,
    "status"      "ClassBookingStatus" NOT NULL DEFAULT 'BOOKED',
    "activeKey"   TEXT,
    "bookedAt"    TIMESTAMPTZ(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promotedAt"  TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "attendedAt"  TIMESTAMPTZ(3),
    "createdAt"   TIMESTAMPTZ(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMPTZ(3)       NOT NULL,

    CONSTRAINT "ClassBooking_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClassSession_businessDate_startsAt_idx" ON "ClassSession" ("businessDate", "startsAt");
CREATE INDEX "ClassSession_coachId_startsAt_idx"      ON "ClassSession" ("coachId", "startsAt" DESC);

-- Promotion order: the earliest waitlisted booking wins a freed seat.
CREATE INDEX "ClassBooking_sessionId_status_bookedAt_idx"
    ON "ClassBooking" ("sessionId", "status", "bookedAt");
CREATE INDEX "ClassBooking_userId_bookedAt_idx" ON "ClassBooking" ("userId", "bookedAt" DESC);

-- "At most one ACTIVE booking per member per session", as a real unique index
-- Prisma owns and will never drop. A partial unique index is drift Prisma
-- emits a DROP INDEX for on the next unrelated `migrate dev` — the same reason
-- CoachAssignment carries `activeMemberId`.
CREATE UNIQUE INDEX "ClassBooking_activeKey_key" ON "ClassBooking" ("activeKey");

ALTER TABLE "ClassSession"
    ADD CONSTRAINT "ClassSession_coachId_fkey"
    FOREIGN KEY ("coachId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassSession"
    ADD CONSTRAINT "ClassSession_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CASCADE on both: a booking has no meaning without its session or its member,
-- and unlike a payment nothing reconciles against it.
ALTER TABLE "ClassBooking"
    ADD CONSTRAINT "ClassBooking_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "ClassSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClassBooking"
    ADD CONSTRAINT "ClassBooking_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClassSession"
    ADD CONSTRAINT "ClassSession_title_sane"
    CHECK (char_length(btrim("title")) BETWEEN 1 AND 80),
    -- A class with no seats is not a class. The upper bound is a typo guard:
    -- 500 is larger than any room this gym has.
    ADD CONSTRAINT "ClassSession_capacity_sane"
    CHECK ("capacity" BETWEEN 1 AND 500),
    -- The counter may never exceed the cap. This is the belt to the booking
    -- write's braces: the conditional UPDATE is what enforces capacity, and
    -- this is what catches any future code path that forgets to use it.
    ADD CONSTRAINT "ClassSession_booked_within_capacity"
    CHECK ("bookedCount" >= 0 AND "bookedCount" <= "capacity"),
    ADD CONSTRAINT "ClassSession_ends_after_starts"
    CHECK ("endsAt" > "startsAt"),
    -- Cancellation is two columns that move together.
    ADD CONSTRAINT "ClassSession_cancel_shape"
    CHECK (("cancelledAt" IS NULL) = ("cancelReason" IS NULL));

ALTER TABLE "ClassBooking"
    -- The sentinel is set exactly while the booking is live. Getting this
    -- wrong in either direction breaks the uniqueness guarantee silently:
    -- a NULL on a live booking lets a member book twice, and a value on a
    -- cancelled one stops them ever booking again.
    ADD CONSTRAINT "ClassBooking_active_key_shape"
    CHECK (
      ("status" IN ('BOOKED', 'WAITLISTED')) = ("activeKey" IS NOT NULL)
    ),
    ADD CONSTRAINT "ClassBooking_active_key_matches"
    CHECK (
      "activeKey" IS NULL OR "activeKey" = "sessionId"::text || ':' || "userId"::text
    ),
    ADD CONSTRAINT "ClassBooking_cancelled_shape"
    CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL)),
    ADD CONSTRAINT "ClassBooking_attended_shape"
    CHECK (("status" = 'ATTENDED') = ("attendedAt" IS NOT NULL));

ALTER TABLE "ClassSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClassBooking" ENABLE ROW LEVEL SECURITY;

DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "ClassSession", "ClassBooking" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "ClassSession", "ClassBooking" FROM authenticated';
  END IF;
END
$rls$;
