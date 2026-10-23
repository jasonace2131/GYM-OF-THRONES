import { randomUUID } from 'node:crypto';
import {
  HoldStatus,
  MembershipStatus,
  PlanKind,
  Role,
  ShiftStatus,
  UserStatus,
  type PrismaClient,
} from '@prisma/client';
import { generateMemberCode } from '../../src/users/member-code.util';
import { addDays, anniversary, toDateColumn, type CivilDate } from '../../src/common/time/gym-time';
import { termEndsOn } from '../../src/membership/membership-terms';

/**
 * The membership states every e2e suite in chunk 1 needs, built by direct
 * Prisma writes rather than through the API.
 *
 * Direct writes on purpose: a fixture that sells a membership through
 * POST /memberships would make every freeze, cancel and nightly-job test fail
 * whenever the sale path breaks, and the failure would point at the wrong file.
 *
 * `resetDatabase()` truncates Plan along with everything else, so
 * `seedPlansForTest()` runs in each `beforeEach`, not once in `beforeAll`.
 */

export type SeededPlanCode = 'WALKIN' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
export type TermPlanCode = Exclude<SeededPlanCode, 'WALKIN'>;
export type SeededPlanIds = Record<SeededPlanCode, string>;

/** §5.3.2's table, verbatim. Prices are centavos of PHP. */
const PLAN_ROWS = [
  {
    code: 'WALKIN',
    name: 'Walk-in',
    kind: PlanKind.WALK_IN,
    priceCentavos: 9000,
    termMonths: null,
    freezable: false,
    guestPassesPerTerm: 0,
    graceDays: 0,
    sortOrder: 0,
  },
  {
    code: 'MONTHLY',
    name: 'Monthly',
    kind: PlanKind.TERM,
    priceCentavos: 80000,
    termMonths: 1,
    freezable: false,
    guestPassesPerTerm: 0,
    graceDays: 3,
    sortOrder: 1,
  },
  {
    code: 'QUARTERLY',
    name: 'Quarterly',
    kind: PlanKind.TERM,
    priceCentavos: 220000,
    termMonths: 3,
    freezable: true,
    guestPassesPerTerm: 0,
    graceDays: 3,
    sortOrder: 2,
  },
  {
    code: 'ANNUAL',
    name: 'Annual',
    kind: PlanKind.TERM,
    priceCentavos: 750000,
    termMonths: 12,
    freezable: true,
    guestPassesPerTerm: 2,
    graceDays: 3,
    sortOrder: 3,
  },
];

export async function seedPlansForTest(prisma: PrismaClient): Promise<SeededPlanIds> {
  await prisma.plan.createMany({ data: PLAN_ROWS, skipDuplicates: true });
  const rows = await prisma.plan.findMany({ select: { id: true, code: true } });

  const ids = {} as SeededPlanIds;
  for (const row of rows) {
    ids[row.code as SeededPlanCode] = row.id;
  }
  return ids;
}

/**
 * One open drawer. `openMarker` is the nullable-unique sentinel, and
 * Shift_open_marker makes omitting it a constraint violation rather than a
 * second open shift, so it is set here explicitly.
 */
export async function openShift(
  prisma: PrismaClient,
  openedById: string,
  businessDate: CivilDate,
  openingFloatCentavos = 200000,
): Promise<string> {
  const shift = await prisma.shift.create({
    data: {
      status: ShiftStatus.OPEN,
      openedById,
      openedAt: new Date(),
      openingFloatCentavos,
      businessDate: toDateColumn(businessDate),
      openMarker: 'OPEN',
    },
    select: { id: true },
  });
  return shift.id;
}

/**
 * The membership states every e2e suite needs.
 *
 * `STALE_ACTIVE` is the odd one out: the row still says ACTIVE and `endsOn` is
 * ten days behind, which is exactly what a missed nightly run leaves behind —
 * route 20/21's tests need it to prove the CRM projects the door verdict
 * rather than the raw column. It is additive to §5.7.3's four sell/renew
 * states, which is why it is not in the brief's own enumeration.
 */
export type MemberState =
  | 'ACTIVE'
  | 'IN_GRACE'
  | 'EXPIRED_PAST_GRACE'
  | 'STALE_ACTIVE'
  | 'FROZEN'
  | 'CANCELLED'
  | 'NO_MEMBERSHIP';

export interface MakeMemberOptions {
  state: MemberState;
  today: CivilDate;
  /** Defaults to MONTHLY. WALKIN is not a term plan and is deliberately not accepted. */
  planCode?: TermPlanCode;
  firstName?: string;
  lastName?: string;
  /**
   * Reuse an already-provisioned fixture user (e.g. one a route-20/21 suite
   * already minted a token for) instead of creating a fresh one. Not part of
   * the brief's own interface — additive, so callers that never pass it are
   * unaffected.
   */
  userId?: string;
}

export interface MemberFixture {
  userId: string;
  /** Null only for state 'NO_MEMBERSHIP'. */
  membershipId: string | null;
  memberCode: string | null;
  email: string;
}

/** The fixture freeze's window, in days. Inside MembershipHold_days_bounded's 7..90. */
const FIXTURE_HOLD_DAYS = 14;

/** endsOn relative to `today`, for the lapsed states. */
const LAPSED_END_OFFSET: Record<
  'IN_GRACE' | 'EXPIRED_PAST_GRACE' | 'CANCELLED' | 'STALE_ACTIVE',
  number
> = {
  IN_GRACE: -1,
  EXPIRED_PAST_GRACE: -10,
  CANCELLED: -5,
  STALE_ACTIVE: -10,
};

const APPROVER_EMAIL = 'fixture.freeze.approver@got.test';

/** MembershipHold.approvedById is NOT NULL, so a frozen fixture needs a staff row. */
async function freezeApproverId(prisma: PrismaClient): Promise<string> {
  const existing = await prisma.user.findUnique({
    where: { email: APPROVER_EMAIL },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await prisma.user.create({
    data: {
      supabaseId: randomUUID(),
      email: APPROVER_EMAIL,
      firstName: 'Fixture',
      lastName: 'Approver',
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
    },
    select: { id: true },
  });
  return created.id;
}

export async function makeMember(
  prisma: PrismaClient,
  options: MakeMemberOptions,
): Promise<MemberFixture> {
  let userId: string;
  let email: string;
  let memberCode: string | null;

  if (options.userId) {
    userId = options.userId;
    const existing = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, memberCode: true },
    });
    email = existing.email;
    memberCode = existing.memberCode;
    // A member with no membership has no memberCode either: allocation is
    // lazy, inside the first membership transaction.
    if (memberCode === null && options.state !== 'NO_MEMBERSHIP') {
      memberCode = generateMemberCode();
      await prisma.user.update({ where: { id: userId }, data: { memberCode } });
    }
  } else {
    email = `member.${randomUUID()}@fixture.test`;
    memberCode = options.state === 'NO_MEMBERSHIP' ? null : generateMemberCode();

    const user = await prisma.user.create({
      data: {
        supabaseId: randomUUID(),
        email,
        firstName: options.firstName ?? 'Fixture',
        lastName: options.lastName ?? 'Member',
        role: Role.CLIENT,
        status: UserStatus.ACTIVE,
        memberCode,
      },
      select: { id: true },
    });
    userId = user.id;
  }

  if (options.state === 'NO_MEMBERSHIP') {
    return { userId, membershipId: null, memberCode: null, email };
  }

  const plan = await prisma.plan.findUniqueOrThrow({
    where: { code: options.planCode ?? 'MONTHLY' },
  });
  const termMonths = plan.termMonths ?? 1;
  const { today } = options;

  let startsOn: CivilDate;
  let anchor: number;
  let endsOn: CivilDate;

  if (options.state === 'ACTIVE' || options.state === 'FROZEN') {
    startsOn = today;
    anchor = Number(today.slice(8, 10));
    endsOn = termEndsOn(anchor, startsOn, termMonths);
  } else {
    // Walk the term BACKWARDS from the day the next one would have begun, so
    // termEndsOn(anchor, startsOn, termMonths) reproduces this endsOn exactly
    // and the nightly job's reconcile step reports no mismatch.
    endsOn = addDays(today, LAPSED_END_OFFSET[options.state]);
    const renewalDay = addDays(endsOn, 1);
    anchor = Number(renewalDay.slice(8, 10));
    startsOn = anniversary(anchor, renewalDay, -termMonths);
  }

  const frozen = options.state === 'FROZEN';
  const cancelled = options.state === 'CANCELLED';
  // §5.6.2: the extension is applied when the hold STARTS, so a frozen fixture's
  // endsOn already carries the whole window.
  const membershipEndsOn = frozen ? addDays(endsOn, FIXTURE_HOLD_DAYS) : endsOn;

  const status =
    options.state === 'ACTIVE' || options.state === 'STALE_ACTIVE'
      ? MembershipStatus.ACTIVE
      : frozen
        ? MembershipStatus.FROZEN
        : cancelled
          ? MembershipStatus.CANCELLED
          : MembershipStatus.EXPIRED;

  const membership = await prisma.membership.create({
    data: {
      userId,
      planId: plan.id,
      status,
      planCode: plan.code,
      planName: plan.name,
      planPriceCentavos: plan.priceCentavos,
      termMonths,
      graceDays: plan.graceDays,
      guestPassesPerTerm: plan.guestPassesPerTerm,
      startsOn: toDateColumn(startsOn),
      endsOn: toDateColumn(membershipEndsOn),
      billingAnchorDay: anchor,
      joinedOn: toDateColumn(startsOn),
      // Membership_cancel_shape: CANCELLED and cancelledOn are biconditional.
      cancelledOn: cancelled ? toDateColumn(endsOn) : null,
      graceAdmissionsThisTerm: 0,
      freezesUsedThisTerm: frozen ? 1 : 0,
      guestPassesRemaining: plan.guestPassesPerTerm,
      purchasedAt: new Date(),
    },
    select: { id: true },
  });

  if (frozen) {
    await prisma.membershipHold.create({
      data: {
        membershipId: membership.id,
        status: HoldStatus.ACTIVE,
        startsOn: toDateColumn(today),
        endsOn: toDateColumn(addDays(today, FIXTURE_HOLD_DAYS - 1)),
        daysRequested: FIXTURE_HOLD_DAYS,
        daysApplied: FIXTURE_HOLD_DAYS,
        // The nullable-unique sentinel: set while ACTIVE, null otherwise.
        activeMembershipId: membership.id,
        reason: 'fixture freeze',
        feeWaived: true,
        approvedById: await freezeApproverId(prisma),
      },
    });
  }

  return { userId, membershipId: membership.id, memberCode, email };
}

/**
 * Gives each already-provisioned member an ACTIVE Monthly membership from
 * `today` — for suites that exercise a member-only feature (Workouts, Ask the
 * Gym, My Coach's chat), whose writes need an active membership since
 * 2026-10-17 (`@RequireActiveMembership`). Seeds the plans first.
 */
export async function makeActiveMembers(
  prisma: PrismaClient,
  userIds: readonly string[],
  today: CivilDate,
): Promise<void> {
  await seedPlansForTest(prisma);
  for (const userId of userIds) {
    await makeMember(prisma, { state: 'ACTIVE', today, userId });
  }
}
