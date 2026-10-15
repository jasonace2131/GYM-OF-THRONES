-- CreateEnum
CREATE TYPE "CoachAssignmentStatus" AS ENUM ('ACTIVE', 'ENDED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "memberCode" TEXT;

-- CreateTable
CREATE TABLE "CoachAssignment" (
    "id" UUID NOT NULL,
    "coachId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "status" "CoachAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "activeMemberId" UUID,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMPTZ(3),
    "assignedById" UUID NOT NULL,
    "endedById" UUID,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CoachAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "key" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "CoachAssignment_activeMemberId_key" ON "CoachAssignment"("activeMemberId");

-- CreateIndex
CREATE INDEX "CoachAssignment_coachId_status_idx" ON "CoachAssignment"("coachId", "status");

-- CreateIndex
CREATE INDEX "CoachAssignment_memberId_startedAt_idx" ON "CoachAssignment"("memberId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "IdempotencyRecord_createdAt_idx" ON "IdempotencyRecord"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_memberCode_key" ON "User"("memberCode");

-- AddForeignKey
ALTER TABLE "CoachAssignment" ADD CONSTRAINT "CoachAssignment_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachAssignment" ADD CONSTRAINT "CoachAssignment_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachAssignment" ADD CONSTRAINT "CoachAssignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachAssignment" ADD CONSTRAINT "CoachAssignment_endedById_fkey" FOREIGN KEY ("endedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written: Prisma models no CHECK constraint, so these live only here.
-- Names are load-bearing — CONSTRAINT_ERROR_CODES maps them to domain codes.
ALTER TABLE "CoachAssignment"
  ADD CONSTRAINT "CoachAssignment_not_self"
    CHECK ("coachId" <> "memberId"),
  ADD CONSTRAINT "CoachAssignment_active_marker"
    CHECK ("activeMemberId" IS NULL OR "activeMemberId" = "memberId"),
  ADD CONSTRAINT "CoachAssignment_active_marker_agrees"
    CHECK (("status" = 'ACTIVE') = ("activeMemberId" IS NOT NULL)),
  ADD CONSTRAINT "CoachAssignment_end_shape"
    CHECK (("status" = 'ACTIVE' AND "endedAt" IS NULL)
        OR ("status" = 'ENDED'  AND "endedAt" IS NOT NULL));
