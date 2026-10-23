import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  HoldStatus,
  Prisma,
  type Membership,
  type MembershipStatus as PrismaStatus,
  type Role,
} from '@prisma/client';
import type { MemberAccess, PaginatedData } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { DomainException } from '../common/exceptions/domain.exception';
import { paginated, paginationSkipTake } from '../common/dto/paginate';
import { addDays, gymToday, toDateColumn, type CivilDate } from '../common/time/gym-time';
import type { ScopedWhere } from '../rbac/scope.util';
import { toPaymentSummary, type PaymentSummary } from '../payments/payment.presenter';
import {
  accessVerdict,
  type AccessResult,
  type AccessSubject,
  type AccessVerdictConfig,
} from './access-verdict';
import type { BookingSubject } from './booking-eligibility';
import { hasActiveMembership, isMembershipGated, memberAccess } from './membership-gate';
import { DAY_PASS_RESOLVER, type DayPassResolver } from './day-pass.resolver';
import {
  toBookingSubject,
  toMembershipDetail,
  toMembershipListItem,
  toMembershipSnapshot,
  type MembershipDetail,
  type MembershipListItem,
} from './membership.presenter';
import type { ListMembershipsQueryDto } from './dto/list-memberships-query.dto';

/** The relations every read projection needs, in one place. */
export const READ_INCLUDE = {
  user: { select: { firstName: true, lastName: true, memberCode: true, status: true } },
  // The nullable-unique sentinel: at most one row can carry it, so `take: 1`
  // is a statement of fact rather than a truncation.
  holds: { where: { activeMembershipId: { not: null } }, take: 1 },
} as const;

const DETAIL_INCLUDE = {
  ...READ_INCLUDE,
  events: { orderBy: { effectiveAt: 'desc' }, take: 50 },
} as const;

/**
 * The membership as a BOOKING reads it: the running hold AND every booked one.
 *
 * A second include on purpose, never a widening of the door's. READ_INCLUDE
 * and loadSubjectAndRow keep only the running hold, and five callers (check-in
 * twice, /me, the assistant, the check-ins report) plus every presenter read
 * `holds[0]` as THAT hold — a SCHEDULED one sorted ahead of it would freeze a
 * member at the door on a day they are not frozen.
 *
 * Filtered by STATUS, never by window: an early release marks a hold
 * COMPLETED and leaves its endsOn in place, so a window test would keep a
 * member frozen after a manager let them back in. toBookingSubject splits by
 * the same statuses, so an include that loads more cannot change an answer.
 *
 * `satisfies`, not `as const`: Prisma's `in` takes a mutable array, which a
 * const assertion would make readonly.
 */
export const BOOKING_MEMBERSHIP_INCLUDE = {
  holds: {
    where: { status: { in: [HoldStatus.SCHEDULED, HoldStatus.ACTIVE] } },
    // Windows of SCHEDULED and ACTIVE holds never overlap
    // (MembershipHold_no_overlap), so start order is a total order here.
    orderBy: { startsOn: 'asc' },
  },
} satisfies Prisma.MembershipInclude;

/**
 * A user as the booking ladder reads them — the `BookingSubjectRow`
 * toBookingSubject maps. Soft-deleted users are excluded by each query's
 * `where`, not here: a select cannot filter its own root.
 */
export const BOOKING_SUBJECT_SELECT = {
  id: true,
  status: true,
  membership: { include: BOOKING_MEMBERSHIP_INCLUDE },
} satisfies Prisma.UserSelect;

/**
 * The loader half of §5.4.1's split.
 *
 * accessVerdict decides; this service loads, reads the config and owns the
 * transaction — the same split as PermissionsService / PermissionsGuard. Nothing
 * in access-verdict.ts, membership-terms.ts, membership-transitions.ts or
 * membership-freeze-rules.ts may reach a clock, Prisma or GymConfigService; all
 * three arrive here.
 */
@Injectable()
export class MembershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    @Inject(DAY_PASS_RESOLVER) private readonly dayPasses: DayPassResolver,
  ) {}

  private get verdictConfig(): AccessVerdictConfig {
    return {
      expiringSoonDays: this.gym.expiringSoonDays,
      graceAdmissionsMax: this.gym.graceAdmissionsMax,
    };
  }

  /**
   * Everything the ladder needs about one person, on one gym-local day.
   *
   * `client` defaults to the pooled Prisma service and is overridden by
   * `POST /checkin`, which must read the subject INSIDE its write transaction
   * (§5.4.5): verdict-then-write across two round trips is a TOCTOU window a
   * concurrent cancel or freeze walks straight through, and passing the
   * transaction client is the whole of what closes it.
   */
  async loadSubject(
    userId: string,
    today: CivilDate,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<AccessSubject> {
    return (await this.loadSubjectAndRow(userId, today, client)).subject;
  }

  /**
   * The same load, plus the membership's own id and stored status.
   *
   * `AccessSubject` deliberately carries neither: it is the PURE ladder's
   * input and a row id has no business in a decision. But the check-in write
   * path needs both — `CheckIn.membershipId` and `membershipStatusAtTime` are
   * columns on the row it is about to insert, and a grace admission increments
   * `graceAdmissionsThisTerm` on that same membership. Returning them here
   * costs nothing; re-reading the row inside the transaction would cost a
   * statement on a pooled connection the design is trying to hold briefly.
   */
  async loadSubjectAndRow(
    userId: string,
    today: CivilDate,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<{
    subject: AccessSubject;
    membershipId: string | null;
    storedStatus: PrismaStatus | null;
  }> {
    const user = await client.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (user === null) {
      throw new DomainException('MEMBER_NOT_FOUND', 'Member not found', HttpStatus.NOT_FOUND);
    }

    const membership = await client.membership.findUnique({
      where: { userId },
      include: { holds: { where: { activeMembershipId: { not: null } }, take: 1 } },
    });

    return {
      subject: {
        userStatus: user.status,
        membership:
          membership === null
            ? null
            : toMembershipSnapshot(membership, membership.holds[0] ?? null),
        dayPassValidToday: await this.dayPasses.validToday(userId, today, client),
      },
      membershipId: membership?.id ?? null,
      storedStatus: membership?.status ?? null,
    };
  }

  /**
   * Everything the BOOKING ladder (booking-eligibility.ts) needs about one
   * person, for a class on any day.
   *
   * Null for a missing or soft-deleted user — never loadSubjectAndRow's 404.
   * A booking path asks about somebody it already holds a row for, and the
   * caller decides what an absent member means; a throw from here, mid-way
   * through another member's cancellation, would roll that back instead.
   *
   * No day pass is resolved: a walk-in buys today's floor, and day passes do
   * not count for a class (owner, 2026-10-11).
   *
   * `client` as loadSubject's: a booking that claims a seat passes its own
   * transaction, so the check runs on the connection that writes the seat and
   * the gap between them is as short as it can be. It is not zero — nothing
   * here locks the Membership row, so a freeze can still commit in it — and
   * that is accepted: a seat held by a plan that lapses later is left for the
   * door to decide on the day (owner, 2026-10-11), and so is this one.
   */
  async loadBookingSubject(
    userId: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<BookingSubject | null> {
    const row = await client.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: BOOKING_SUBJECT_SELECT,
    });
    return row === null ? null : toBookingSubject(row);
  }

  /**
   * The same for many people in ONE query — a waitlist promotion asks about
   * everybody queued for a class at once, not one round trip per place.
   *
   * Keyed by user id. A missing or soft-deleted user is simply absent, so
   * `get` returns undefined and the caller skips them; nothing throws.
   * Duplicate ids are read once, and an empty list costs no query at all.
   */
  async loadBookingSubjects(
    userIds: readonly string[],
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<Map<string, BookingSubject>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();

    const rows = await client.user.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: BOOKING_SUBJECT_SELECT,
    });
    return new Map(rows.map((row) => [row.id, toBookingSubject(row)]));
  }

  /**
   * "Does this member have an ACTIVE membership today" — the gate on the
   * member-only features (membership-gate.ts). The booking subject and the
   * booking rule, judged on the gym's today: one definition of "active".
   */
  async hasActiveMembership(userId: string, now: Date = new Date()): Promise<boolean> {
    const today = gymToday(now, this.gym.timeZone);
    return hasActiveMembership(await this.loadBookingSubject(userId), today);
  }

  /**
   * `GET /me`'s `memberAccess`. Staff are answered without a query: the gate
   * never asks about them.
   */
  async memberAccessFor(
    user: { id: string; role: Role },
    now: Date = new Date(),
  ): Promise<MemberAccess> {
    if (!isMembershipGated(user.role)) return 'FULL';
    const today = gymToday(now, this.gym.timeZone);
    return memberAccess(user.role, await this.loadBookingSubject(user.id), today);
  }

  /** The ladder's configuration, exposed so an in-transaction caller can run it. */
  get accessConfig(): AccessVerdictConfig {
    return this.verdictConfig;
  }

  /**
   * "May this person train today." The live door read, which Chunk 2 calls and
   * then re-evaluates INSIDE its write transaction — verdict-then-write across
   * two round trips is a TOCTOU window a concurrent cancel or freeze walks
   * straight through.
   */
  async verdictFor(userId: string, now: Date): Promise<AccessResult> {
    const today = gymToday(now, this.gym.timeZone);
    return accessVerdict(await this.loadSubject(userId, today), today, this.verdictConfig);
  }

  async list(
    query: ListMembershipsQueryDto,
    scope: ScopedWhere<Prisma.MembershipWhereInput>,
    now: Date,
  ): Promise<PaginatedData<MembershipListItem>> {
    const today = gymToday(now, this.gym.timeZone);

    const filters: Prisma.MembershipWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.planCode ? { planCode: query.planCode } : {}),
      ...(query.expiringWithinDays === undefined
        ? {}
        : {
            endsOn: {
              gte: toDateColumn(today),
              lte: toDateColumn(addDays(today, query.expiringWithinDays)),
            },
          }),
      ...(query.search
        ? {
            user: {
              OR: [
                { firstName: { contains: query.search, mode: 'insensitive' as const } },
                { lastName: { contains: query.search, mode: 'insensitive' as const } },
                { memberCode: { contains: query.search, mode: 'insensitive' as const } },
                { email: { contains: query.search, mode: 'insensitive' as const } },
              ],
            },
          }
        : {}),
    };

    // AND, never spread. Both `filters` (search) and `scope` (a COACH at OWN)
    // can carry a top-level OR through the same `user` relation; spreading would
    // let the second silently replace the first and widen the coach's reach to
    // the whole member base. The ScopedWhere brand makes that a compile error.
    const where: Prisma.MembershipWhereInput = { AND: [filters, scope] };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.membership.findMany({
        where,
        include: READ_INCLUDE,
        orderBy: [{ endsOn: 'asc' }, { id: 'asc' }],
        ...paginationSkipTake(query),
      }),
      this.prisma.membership.count({ where }),
    ]);

    const cfg = this.verdictConfig;
    return paginated(
      rows.map((row) => toMembershipListItem(row, today, cfg)),
      total,
      query,
    );
  }

  /**
   * 404 on a scoped miss, never 403 — a 403 confirms the row exists and turns
   * this endpoint into an enumeration oracle for the whole member base.
   */
  async findOne(
    id: string,
    scope: ScopedWhere<Prisma.MembershipWhereInput>,
    now: Date,
    options: { includePayments: boolean },
  ): Promise<MembershipDetail> {
    const today = gymToday(now, this.gym.timeZone);

    const row = await this.prisma.membership.findFirst({
      where: { AND: [{ id }, scope] },
      include: DETAIL_INCLUDE,
    });
    if (row === null) {
      throw new DomainException(
        'MEMBERSHIP_NOT_FOUND',
        'Membership not found',
        HttpStatus.NOT_FOUND,
      );
    }

    const payments = options.includePayments ? await this.paymentsFor(this.prisma, row.id) : null;
    return toMembershipDetail(row, today, this.verdictConfig, {
      payments,
      includeEvents: true,
    });
  }

  /**
   * The read every mutating service takes before it writes.
   *
   * SELECT … FOR UPDATE, deliberately: two staff members renewing and freezing
   * the same membership in the same second would otherwise both read the same
   * endsOn and one increment would vanish. Prisma's fluent API cannot express a
   * row lock, so the lock is one raw statement and the row itself comes back
   * through the typed client.
   */
  async loadForUpdate(tx: Prisma.TransactionClient, membershipId: string): Promise<Membership> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Membership" WHERE "id" = ${membershipId}::uuid FOR UPDATE
    `;
    if (locked.length === 0) {
      throw new DomainException(
        'MEMBERSHIP_NOT_FOUND',
        'Membership not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return tx.membership.findUniqueOrThrow({ where: { id: membershipId } });
  }

  /**
   * The projection every mutating route returns, read on the SAME tx that just
   * wrote — so the response can never show a state the transaction rolled back.
   */
  async detailById(
    tx: Prisma.TransactionClient,
    membershipId: string,
    now: Date,
  ): Promise<MembershipDetail> {
    const today = gymToday(now, this.gym.timeZone);
    const row = await tx.membership.findUnique({
      where: { id: membershipId },
      include: DETAIL_INCLUDE,
    });
    if (row === null) {
      throw new DomainException(
        'MEMBERSHIP_NOT_FOUND',
        'Membership not found',
        HttpStatus.NOT_FOUND,
      );
    }

    return toMembershipDetail(row, today, this.verdictConfig, {
      payments: await this.paymentsFor(tx, membershipId),
      includeEvents: true,
    });
  }

  /** The membership's own money. `toPaymentSummary` is pure, so no DI hop. */
  private async paymentsFor(
    client: Prisma.TransactionClient,
    membershipId: string,
  ): Promise<PaymentSummary[]> {
    const rows = await client.payment.findMany({
      where: { membershipId },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: 24,
    });
    return rows.map(toPaymentSummary);
  }
}
