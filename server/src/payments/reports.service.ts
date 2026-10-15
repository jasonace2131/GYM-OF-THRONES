import { Injectable } from '@nestjs/common';
import {
  DiscountType,
  MembershipEventType,
  MembershipStatus,
  PaymentMethod,
  PaymentStatus,
} from '@prisma/client';
import { REPORT_DEFAULT_RANGE_DAYS, REPORT_MAX_RANGE_DAYS } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import {
  addDays,
  civilDateFromPrisma,
  gymToday,
  toDateColumn,
  type CivilDate,
} from '../common/time/gym-time';
import { resolveDateWindow } from '../common/time/date-window';

/**
 * What a ranged report actually receives.
 *
 * `string`, not `CivilDate`, and deliberately: `@IsGymDate()` checks the
 * SHAPE (`yyyy-mm-dd`) and nothing else, so `2026-02-31` reaches this service
 * having passed the pipe. Typing the parameter as `CivilDate` would claim a
 * guarantee the validator does not make and would hide the reason
 * `resolveDateWindow` exists. `ReportRangeQueryDto` is assignable to it.
 */
export interface ReportWindowQuery {
  from?: string;
  to?: string;
}

const MS_PER_DAY = 86_400_000;

/**
 * The instant window of one gym-local civil day.
 *
 * Manila is UTC+8 with no DST (§2 context), so one offset probe is exact. A zone
 * with DST would need the offset recomputed at each boundary; that is the only
 * line that would change.
 */
export function gymDayWindow(day: CivilDate, timeZone: string): { start: Date; end: Date } {
  const naive = toDateColumn(day).getTime();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(naive));

  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour') % 24,
    value('minute'),
    value('second'),
  );

  const start = new Date(naive - (asUtc - naive));
  return { start, end: new Date(start.getTime() + MS_PER_DAY) };
}

export interface StatutoryDiscountRow {
  paymentId: string;
  businessDate: CivilDate;
  memberName: string;
  statutoryIdNo: string;
  discountType: 'SENIOR' | 'PWD';
  grossCentavos: number;
  vatBaseCentavos: number;
  discountCentavos: number;
  netCentavos: number;
}

export interface StatutoryDiscountRegister {
  from: CivilDate;
  to: CivilDate;
  rows: StatutoryDiscountRow[];
  totalDiscountCentavos: number;
}

/**
 * The walk-in half of the Reports screen.
 *
 * A day pass is the gym's highest-volume sale and its cheapest conversion
 * lead, and neither fact was visible anywhere: revenue reports group by
 * purpose, which says WALK_IN earned X, but not how many people that was,
 * when they came, or how many came back as members.
 *
 * `converted` is only answerable because CheckIn.convertedToUserId exists —
 * before it, a converted guest's rows were indistinguishable from any other
 * guest's.
 */
export interface WalkInStatsReport {
  from: CivilDate;
  to: CivilDate;
  totalWalkIns: number;
  revenueCentavos: number;
  /** Over the days in range, not over days that had a walk-in. */
  averagePerDay: number;
  converted: number;
  byDay: {
    /** 'Monday' … 'Sunday', gym-local. */
    weekday: string;
    count: number;
    revenueCentavos: number;
    /** Busiest clock hour for this weekday, e.g. '6:00 PM'. Null if none. */
    peakHour: string | null;
  }[];
}

export interface GcashReferenceRow {
  paymentId: string;
  businessDate: CivilDate;
  reference: string;
  netCentavos: number;
  memberName: string | null;
  // BIR RMC 4-2021 recognises an electronic payment receipt on the trio
  // date + amount + reference; with receiptNo and the verification flag this
  // row is something the bookkeeper can hand over as-is.
  receiptNo: string | null;
  verified: boolean;
}

export interface GcashReferenceList {
  from: CivilDate;
  to: CivilDate;
  rows: GcashReferenceRow[];
  totalCentavos: number;
}

export interface OwnerSummaryPayload {
  businessDate: CivilDate;
  cash: {
    openingFloatCentavos: number;
    expectedCentavos: number | null;
    countedCentavos: number | null;
    varianceCentavos: number | null;
    countedByName: string | null;
  };
  gcash: { count: number; totalCentavos: number };
  newMemberships: { name: string; planCode: string }[];
  renewals: { name: string; planCode: string }[];
  expiringWithinThreeDays: { name: string; endsOn: CivilDate }[];
  voids: { paymentId: string; netCentavos: number; reason: string; byName: string }[];
  discounts: {
    paymentId: string;
    discountType: DiscountType;
    discountCentavos: number;
    byName: string;
  }[];
  freezes: {
    membershipId: string;
    name: string;
    startsOn: CivilDate;
    endsOn: CivilDate;
    byName: string;
  }[];
  graceAdmissions: number;
  paymentsWithoutReceiptNo: number;
  /** GCash rows nobody attested to seeing in the gym's own app. */
  gcashUnverified: number;
  /** Sourced from CheckIn, which does not exist until Chunk 2. Null here so the
   *  SummaryTransport contract does not change when Chunk 2 fills it in. */
  membersNotSeenIn30Days: number | null;
}

const NAME_SELECT = { select: { firstName: true, lastName: true } } as const;

function fullName(person: { firstName: string; lastName: string } | null): string | null {
  return person ? `${person.firstName} ${person.lastName}` : null;
}

/**
 * The two registers the BIR and the GCash statement need, and the payload the
 * nightly job hands to the transport.
 *
 * Every money figure leaves as an integer of centavos. No formatted currency
 * string is composed anywhere on this side of the wire.
 */
export type RevenueGroup = 'month' | 'plan' | 'method' | 'purpose';

export interface RevenueReport {
  from: CivilDate;
  to: CivilDate;
  groupBy: RevenueGroup;
  series: { key: string; label: string; centavos: number; count: number; discountCentavos: number }[];
  totalCentavos: number;
  totalCount: number;
  totalDiscountCentavos: number;
}

/**
 * The five event types that count as membership MOVEMENT.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY ABSENT, AND WHY.
 *
 * HOLD_APPLIED / HOLD_RELEASED are the same member on the same plan with the
 * clock paused; STATUS_CORRECTED and ADJUSTED are somebody fixing a mistake;
 * CANCELLATION_REQUESTED / CANCELLATION_WITHDRAWN are notice, not departure —
 * the term is still live and still paid for, and CANCELLED records the day it
 * actually ends; IMPORTED is a migration artefact and never a sale.
 *
 * Counting any of them as activity inflates every figure on the panel, and
 * the inflation is invisible because each row looks individually plausible.
 * ─────────────────────────────────────────────────────────────────────────
 */
export const REPORTABLE_MEMBERSHIP_EVENTS = [
  MembershipEventType.PURCHASED,
  MembershipEventType.RENEWED,
  MembershipEventType.REACTIVATED,
  MembershipEventType.CANCELLED,
  MembershipEventType.EXPIRED,
] as const;

export type ReportableMembershipEvent = (typeof REPORTABLE_MEMBERSHIP_EVENTS)[number];

/**
 * One movement in a member's life, as of the day it happened.
 *
 * `planCode` / `planName` / `netCentavos` come from the joined PAYMENT, not
 * from `membership` — see `membershipActivity`'s column-at-the-time note.
 */
export interface MembershipActivityRow {
  eventId: string;
  membershipId: string;
  /** The gym-local day of `effectiveAt`, not its UTC date. */
  businessDate: CivilDate;
  effectiveAt: string;
  type: ReportableMembershipEvent;
  memberName: string;
  memberCode: string | null;
  planCode: string;
  planName: string;
  /** Null when no money caused this event (an EXPIRED, most CANCELLEDs). */
  netCentavos: number | null;
  /** Where the event left the term. Null when it did not move it. */
  newEndsOn: CivilDate | null;
}

export interface MembershipActivityReport {
  from: CivilDate;
  to: CivilDate;
  items: MembershipActivityRow[];
  total: number;
  /** True when the window held more rows than the ceiling returns. */
  truncated: boolean;
  counts: Record<ReportableMembershipEvent, number>;
  revenueCentavos: number;
}

/**
 * The ceiling on one membership-activity read.
 *
 * No pagination: the client slices for display and hands the WHOLE array to
 * the CSV and PDF exports, which is the entire reason the panel exists. A
 * ceiling plus an honest `truncated` flag is the version that cannot lie; a
 * page parameter would mean the export quietly shipping page one.
 */
const MEMBERSHIP_ACTIVITY_LIMIT = 2000;

export interface RecurringReport {
  asOf: CivilDate;
  activeMembers: number;
  mrrCentavos: number;
  arpuCentavos: number;
  renewedLast30: number;
  lapsedLast30: number;
  churnRate: number | null;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
  ) {}

  /**
   * The one place a report's window is decided.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * EVERY RANGED REPORT GOES THROUGH HERE. There is no second copy.
   *
   * These methods each used to open with a bare `asCivilDate(query.from)`
   * pair, which gave four separate behaviours for the same question: both
   * bounds mandatory, a reversed window returning an empty report instead of
   * a refusal, `2026-02-31` throwing a RangeError into the 500 handler, and —
   * the one that matters — NO WIDTH CAP. `walkInStats` does an uncapped
   * `findMany` over CheckIn and reduces in JS, so before this the size of one
   * request's heap allocation was set by a date field a staffer could mistype.
   * ─────────────────────────────────────────────────────────────────────────
   *
   * `now` is a parameter rather than a `new Date()` here, matching
   * `MembershipsController.list`, so every default is testable without
   * freezing the clock.
   */
  private window(query: ReportWindowQuery, now: Date): { from: CivilDate; to: CivilDate } {
    const today = gymToday(now, this.gym.timeZone);
    return resolveDateWindow(
      query,
      { from: addDays(today, -REPORT_DEFAULT_RANGE_DAYS), to: today },
      REPORT_MAX_RANGE_DAYS,
    );
  }

  async statutoryDiscounts(
    query: ReportWindowQuery,
    now: Date,
  ): Promise<StatutoryDiscountRegister> {
    const { from, to } = this.window(query, now);

    const payments = await this.prisma.payment.findMany({
      where: {
        status: PaymentStatus.RECORDED,
        discountType: { in: [DiscountType.SENIOR, DiscountType.PWD] },
        businessDate: { gte: toDateColumn(from), lte: toDateColumn(to) },
      },
      include: { user: NAME_SELECT },
      orderBy: [{ businessDate: 'asc' }, { receivedAt: 'asc' }],
    });

    const rows: StatutoryDiscountRow[] = payments.map((payment) => ({
      paymentId: payment.id,
      businessDate: civilDateFromPrisma(payment.businessDate),
      memberName: fullName(payment.user) ?? 'Walk-in guest',
      statutoryIdNo: payment.statutoryIdNo ?? '',
      discountType: payment.discountType === DiscountType.SENIOR ? 'SENIOR' : 'PWD',
      grossCentavos: payment.grossCentavos,
      vatBaseCentavos: payment.vatBaseCentavos,
      discountCentavos: payment.discountCentavos,
      netCentavos: payment.netCentavos,
    }));

    return {
      from,
      to,
      rows,
      totalDiscountCentavos: rows.reduce((sum, row) => sum + row.discountCentavos, 0),
    };
  }

  /**
   * Walk-in statistics — Figure 21's third panel.
   *
   * Counts VISITS, not payments, and the two legitimately differ: a member
   * already inside who buys a day pass gets a Payment but no new CheckIn,
   * and a GUEST_PASS entry is a CheckIn with no Payment at all. So the count
   * comes from CheckIn and the money from the joined Payment.
   *
   * Voided visits are excluded everywhere. `averagePerDay` divides by the
   * days IN RANGE rather than days that happened to have a walk-in — a
   * quiet Tuesday is data, not a missing row.
   */
  async walkInStats(query: ReportWindowQuery, now: Date): Promise<WalkInStatsReport> {
    const { from, to } = this.window(query, now);

    const visits = await this.prisma.checkIn.findMany({
      where: {
        entryType: 'WALK_IN',
        voidedAt: null,
        businessDate: { gte: toDateColumn(from), lte: toDateColumn(to) },
      },
      select: {
        occurredAt: true,
        businessDate: true,
        convertedToUserId: true,
        // A voided payment must not count as revenue even though the visit
        // stands — the member was let in, the money was reversed.
        payment: { select: { netCentavos: true, status: true } },
      },
    });

    const weekdayOf = new Intl.DateTimeFormat('en-PH', {
      timeZone: this.gym.timeZone,
      weekday: 'long',
    });
    const hourOf = new Intl.DateTimeFormat('en-PH', {
      timeZone: this.gym.timeZone,
      hour: 'numeric',
      hour12: true,
    });

    const days = new Map<
      string,
      { count: number; revenueCentavos: number; hours: Map<string, number> }
    >();
    let revenueCentavos = 0;
    let converted = 0;

    for (const visit of visits) {
      const earned =
        visit.payment !== null && visit.payment.status === PaymentStatus.RECORDED
          ? visit.payment.netCentavos
          : 0;
      revenueCentavos += earned;
      if (visit.convertedToUserId !== null) converted += 1;

      const weekday = weekdayOf.format(visit.occurredAt);
      const bucket = days.get(weekday) ?? {
        count: 0,
        revenueCentavos: 0,
        hours: new Map<string, number>(),
      };
      bucket.count += 1;
      bucket.revenueCentavos += earned;
      const hour = hourOf.format(visit.occurredAt);
      bucket.hours.set(hour, (bucket.hours.get(hour) ?? 0) + 1);
      days.set(weekday, bucket);
    }

    // Monday first: a week that starts on Sunday reads as an American
    // calendar to a Philippine audience.
    const order = [
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ];

    const byDay = order
      .filter((weekday) => days.has(weekday))
      .map((weekday) => {
        const bucket = days.get(weekday) as {
          count: number;
          revenueCentavos: number;
          hours: Map<string, number>;
        };
        let peakHour: string | null = null;
        let best = 0;
        for (const [hour, count] of bucket.hours) {
          if (count > best) {
            best = count;
            peakHour = hour;
          }
        }
        return {
          weekday,
          count: bucket.count,
          revenueCentavos: bucket.revenueCentavos,
          peakHour,
        };
      });

    const spanDays =
      Math.round(
        (toDateColumn(to).getTime() - toDateColumn(from).getTime()) / MS_PER_DAY,
      ) + 1;

    return {
      from,
      to,
      totalWalkIns: visits.length,
      revenueCentavos,
      averagePerDay: spanDays > 0 ? Math.round((visits.length / spanDays) * 10) / 10 : 0,
      converted,
      byDay,
    };
  }

  async gcashReferences(query: ReportWindowQuery, now: Date): Promise<GcashReferenceList> {
    const { from, to } = this.window(query, now);

    const payments = await this.prisma.payment.findMany({
      where: {
        status: PaymentStatus.RECORDED,
        method: PaymentMethod.GCASH,
        businessDate: { gte: toDateColumn(from), lte: toDateColumn(to) },
      },
      include: { user: NAME_SELECT },
      orderBy: [{ businessDate: 'asc' }, { receivedAt: 'asc' }],
    });

    const rows: GcashReferenceRow[] = payments.map((payment) => ({
      paymentId: payment.id,
      businessDate: civilDateFromPrisma(payment.businessDate),
      reference: payment.reference ?? '',
      netCentavos: payment.netCentavos,
      memberName: fullName(payment.user),
      receiptNo: payment.receiptNo,
      verified: payment.gcashVerifiedAt !== null,
    }));

    return {
      from,
      to,
      rows,
      totalCentavos: rows.reduce((sum, row) => sum + row.netCentavos, 0),
    };
  }

  async buildOwnerSummary(businessDate: CivilDate): Promise<OwnerSummaryPayload> {
    const day = toDateColumn(businessDate);
    const { start, end } = gymDayWindow(businessDate, this.gym.timeZone);

    const thirtyDaysAgo = new Date(start.getTime() - 30 * 86_400_000);

    const [shift, payments, events, expiring, freezes, graceToday, lapsing] = await Promise.all([
      this.prisma.shift.findFirst({
        where: { businessDate: day },
        orderBy: { openedAt: 'desc' },
        include: { closedBy: NAME_SELECT },
      }),
      this.prisma.payment.findMany({
        where: { businessDate: day },
        include: { user: NAME_SELECT, recordedBy: NAME_SELECT, voidedBy: NAME_SELECT },
      }),
      this.prisma.membershipEvent.findMany({
        where: {
          effectiveAt: { gte: start, lt: end },
          type: {
            in: [
              MembershipEventType.PURCHASED,
              MembershipEventType.RENEWED,
              MembershipEventType.REACTIVATED,
            ],
          },
        },
        include: { membership: { include: { user: NAME_SELECT } } },
      }),
      this.prisma.membership.findMany({
        where: {
          status: MembershipStatus.ACTIVE,
          endsOn: { gte: day, lte: toDateColumn(addDays(businessDate, 3)) },
        },
        include: { user: NAME_SELECT },
        orderBy: { endsOn: 'asc' },
      }),
      this.prisma.membershipHold.findMany({
        where: { createdAt: { gte: start, lt: end } },
        include: { membership: { include: { user: NAME_SELECT } }, approvedBy: NAME_SELECT },
      }),

      // Admissions on the grace ladder today. `verdict` is the ladder's own
      // output, so this counts what actually happened at the door rather than
      // re-deriving it from dates that may since have moved.
      this.prisma.checkIn.count({
        where: { businessDate: day, verdict: 'ALLOWED_IN_GRACE', voidedAt: null },
      }),

      /*
       * Members drifting away.
       *
       * A live term and no visit in thirty days: still paying, not coming,
       * and the single most recoverable churn signal a gym has. `lastSeenAt`
       * is null for somebody who has never visited at all, which counts —
       * they are the most at risk of never starting.
       */
      this.prisma.user.count({
        where: {
          deletedAt: null,
          status: 'ACTIVE',
          membership: { status: 'ACTIVE', endsOn: { gte: day } },
          OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: thirtyDaysAgo } }],
        },
      }),
    ]);

    const recorded = payments.filter((payment) => payment.status === PaymentStatus.RECORDED);
    const gcash = recorded.filter((payment) => payment.method === PaymentMethod.GCASH);
    const named = (event: (typeof events)[number]): string =>
      fullName(event.membership.user) ?? 'Unknown member';

    return {
      businessDate,
      cash: {
        openingFloatCentavos: shift?.openingFloatCentavos ?? 0,
        expectedCentavos: shift?.expectedCentavos ?? null,
        countedCentavos: shift?.countedCentavos ?? null,
        varianceCentavos: shift?.varianceCentavos ?? null,
        countedByName: fullName(shift?.closedBy ?? null),
      },
      gcash: {
        count: gcash.length,
        totalCentavos: gcash.reduce((sum, payment) => sum + payment.netCentavos, 0),
      },
      newMemberships: events
        .filter((event) => event.type === MembershipEventType.PURCHASED)
        .map((event) => ({ name: named(event), planCode: event.membership.planCode })),
      renewals: events
        .filter((event) => event.type !== MembershipEventType.PURCHASED)
        .map((event) => ({ name: named(event), planCode: event.membership.planCode })),
      expiringWithinThreeDays: expiring.map((membership) => ({
        name: fullName(membership.user) ?? 'Unknown member',
        endsOn: civilDateFromPrisma(membership.endsOn),
      })),
      voids: payments
        .filter((payment) => payment.status === PaymentStatus.VOIDED)
        .map((payment) => ({
          paymentId: payment.id,
          netCentavos: payment.netCentavos,
          reason: payment.voidReason ?? '',
          byName: fullName(payment.voidedBy) ?? 'Unknown staff',
        })),
      discounts: recorded
        .filter((payment) => payment.discountType !== DiscountType.NONE)
        .map((payment) => ({
          paymentId: payment.id,
          discountType: payment.discountType,
          discountCentavos: payment.discountCentavos,
          byName: fullName(payment.recordedBy) ?? 'Unknown staff',
        })),
      freezes: freezes.map((hold) => ({
        membershipId: hold.membershipId,
        name: fullName(hold.membership.user) ?? 'Unknown member',
        startsOn: civilDateFromPrisma(hold.startsOn),
        endsOn: civilDateFromPrisma(hold.endsOn),
        byName: fullName(hold.approvedBy) ?? 'Unknown staff',
      })),
      // Chunk 2 shipped, so this is real now: a check-in admitted on the
      // grace ladder rather than on a live term. It was hardcoded 0 for as
      // long as the note above outlived the chunk it described.
      graceAdmissions: graceToday,
      // Until the client wired receiptNo, this permanently equalled the day's
      // whole RECORDED count — every form can now send it, so it means
      // something.
      paymentsWithoutReceiptNo: recorded.filter((payment) => payment.receiptNo === null).length,
      gcashUnverified: recorded.filter(
        (payment) => payment.method === 'GCASH' && payment.gcashVerifiedAt === null,
      ).length,
      // Members with a live term who have not been seen in 30 days — the
      // people about to lapse quietly. Also hardcoded (as null) until now.
      membersNotSeenIn30Days: lapsing,
    };
  }
  /**
   * Revenue over time — the report this system could not produce.
   *
   * ═════════════════════════════════════════════════════════════════════════
   * THE INDEXES FOR THIS ALREADY EXISTED. NOTHING QUERIED THEM.
   *
   * `payment.prisma` annotates its own indexes with "which plan was this
   * member on in March, revenue per term", and every aggregation in the
   * codebase was either one shift, one day, or one page of a filtered list.
   * The dashboard's revenue tile is TODAY only. There was no way to answer
   * "how did September compare to August", which is the first question
   * anybody running a gym asks.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * VOIDED rows are excluded, not netted to zero. A voided payment did not
   * happen — including it at zero would make the transaction count wrong
   * while the money stayed right, and the count is what tells you whether a
   * quiet month was fewer sales or cheaper ones.
   */
  async revenue(
    range: ReportWindowQuery,
    groupBy: RevenueGroup,
    now: Date,
  ): Promise<RevenueReport> {
    const { from, to } = this.window(range, now);

    const rows = await this.prisma.payment.findMany({
      where: {
        businessDate: { gte: toDateColumn(from), lte: toDateColumn(to) },
        status: PaymentStatus.RECORDED,
      },
      select: {
        businessDate: true,
        netCentavos: true,
        planCode: true,
        planName: true,
        method: true,
        purpose: true,
        discountCentavos: true,
      },
    });

    const buckets = new Map<string, { label: string; centavos: number; count: number; discountCentavos: number }>();

    for (const row of rows) {
      const day = civilDateFromPrisma(row.businessDate);
      const key =
        groupBy === 'month'
          ? day.slice(0, 7)
          : groupBy === 'plan'
            ? row.planCode
            : groupBy === 'method'
              ? row.method
              : row.purpose;

      const label = groupBy === 'plan' ? row.planName : key;
      const bucket = buckets.get(key) ?? { label, centavos: 0, count: 0, discountCentavos: 0 };
      bucket.centavos += row.netCentavos;
      bucket.discountCentavos += row.discountCentavos;
      bucket.count += 1;
      buckets.set(key, bucket);
    }

    const series = [...buckets.entries()]
      .map(([key, value]) => ({ key, ...value }))
      // Chronological for a time series; largest-first for a breakdown, which
      // is what makes a plan or method list readable at a glance.
      .sort((a, b) => (groupBy === 'month' ? a.key.localeCompare(b.key) : b.centavos - a.centavos));

    return {
      from,
      to,
      groupBy,
      series,
      totalCentavos: series.reduce((sum, row) => sum + row.centavos, 0),
      totalCount: series.reduce((sum, row) => sum + row.count, 0),
      totalDiscountCentavos: series.reduce((sum, row) => sum + row.discountCentavos, 0),
    };
  }

  /**
   * The numbers an owner asks for by name: recurring revenue, average spend,
   * and how many members are leaving.
   *
   * MRR is NORMALISED, not summed: an annual plan is not twelve times a
   * monthly one in the month it is sold. Every live membership contributes
   * its own price divided by its term, so a quarter sold today shows as a
   * third of its value each month rather than a spike and two empty months.
   */
  async recurring(today: CivilDate): Promise<RecurringReport> {
    const day = toDateColumn(today);
    const thirtyDaysAgo = toDateColumn(addDays(today, -30));

    const [live, expiredRecently, renewedRecently] = await Promise.all([
      this.prisma.membership.findMany({
        where: { status: MembershipStatus.ACTIVE, endsOn: { gte: day } },
        select: { planPriceCentavos: true, termMonths: true },
      }),
      this.prisma.membership.count({
        where: { endsOn: { gte: thirtyDaysAgo, lt: day }, status: { not: MembershipStatus.ACTIVE } },
      }),
      this.prisma.membershipEvent.count({
        where: { type: MembershipEventType.RENEWED, effectiveAt: { gte: new Date(thirtyDaysAgo) } },
      }),
    ]);

    const mrrCentavos = live.reduce(
      (sum, m) => sum + Math.round(m.planPriceCentavos / Math.max(1, m.termMonths)),
      0,
    );

    const lapsed = expiredRecently + renewedRecently;

    return {
      asOf: today,
      activeMembers: live.length,
      mrrCentavos,
      // Average revenue per member per month. Zero members is not an error,
      // it is a new gym — guard rather than divide.
      arpuCentavos: live.length === 0 ? 0 : Math.round(mrrCentavos / live.length),
      renewedLast30: renewedRecently,
      lapsedLast30: expiredRecently,
      // Of everyone whose term came up in the last 30 days, the share that
      // did not renew. Null rather than 0 when nothing came up: "no churn"
      // and "nothing to churn" are different facts.
      churnRate: lapsed === 0 ? null : Number((expiredRecently / lapsed).toFixed(4)),
    };
  }

  /**
   * Membership MOVEMENT in a window — the panel `/admin/reports` could not have.
   *
   * ═════════════════════════════════════════════════════════════════════════
   * WHY THIS IS NOT A FILTERED MEMBERSHIP LIST.
   *
   * `membership.prisma` opens with the constraint that makes one impossible:
   * "Exactly one row per member for the life of the account: renewals mutate
   * this row rather than inserting a second one", and `userId` is `@unique`.
   * `startsOn`/`endsOn` therefore describe only the CURRENT term. A from/to
   * over them answers "who was a member in March" with "whoever's current
   * term happens to straddle March" — a wrong answer that looks right, which
   * is the only kind that survives review.
   *
   * `MembershipEvent` is append-only, immutable by trigger (§5.8.4), and
   * carries `effectiveAt`. Its `@@index([type, effectiveAt])` was shipped
   * annotated "How many memberships expired last month — without a table
   * scan." The index existed. The query never did. This is it.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * ── THE WINDOW IS BUILT IN INSTANTS, AND THAT IS THE WHOLE TRICK ──
   * `effectiveAt` is `@db.Timestamptz(3)`, NOT `@db.Date`. `toDateColumn` —
   * correct for every other range in this file — would compare an instant
   * against 00:00 UTC, which is 8 AM in Manila. Every event between midnight
   * and 8 AM gym-local would fall out of its own day and into the next, and
   * the gym opens at 05:00. `gymDayWindow` is the only correct source of
   * these two bounds; a UTC regression hides in exactly this line.
   *
   * ── COLUMN AT THE TIME ──
   * `planCode`, `planName` and the money come from the joined PAYMENT. The
   * membership row's snapshot is the CURRENT plan, so reading a March renewal
   * off it prints today's plan name against a six-month-old event. The
   * snapshot is the FALLBACK, for the events no money caused (EXPIRED, and
   * most CANCELLEDs). A VOIDED payment still names the plan — the sale
   * happened and was reversed — but contributes zero revenue, the same rule
   * `walkInStats` applies to a voided day pass.
   */
  async membershipActivity(
    query: ReportWindowQuery,
    now: Date,
  ): Promise<MembershipActivityReport> {
    const { from, to } = this.window(query, now);

    // Instants, not date columns. See the header — this is the line.
    const start = gymDayWindow(from, this.gym.timeZone).start;
    const end = gymDayWindow(to, this.gym.timeZone).end;

    const rows = await this.prisma.membershipEvent.findMany({
      where: {
        type: { in: [...REPORTABLE_MEMBERSHIP_EVENTS] },
        effectiveAt: { gte: start, lt: end },
      },
      // Newest first, with `id` as the tiebreak: a nightly catch-up run
      // writes a batch sharing an `effectiveAt` to the millisecond, and
      // without a second key their order differs between identical requests.
      orderBy: [{ effectiveAt: 'desc' }, { id: 'desc' }],
      take: MEMBERSHIP_ACTIVITY_LIMIT,
      select: {
        id: true,
        membershipId: true,
        type: true,
        effectiveAt: true,
        newEndsOn: true,
        membership: {
          select: {
            planCode: true,
            planName: true,
            user: { select: { firstName: true, lastName: true, memberCode: true } },
          },
        },
        payment: {
          select: { netCentavos: true, status: true, planCode: true, planName: true },
        },
      },
    });

    const counts: Record<ReportableMembershipEvent, number> = {
      PURCHASED: 0,
      RENEWED: 0,
      REACTIVATED: 0,
      CANCELLED: 0,
      EXPIRED: 0,
    };
    let revenueCentavos = 0;

    const items: MembershipActivityRow[] = rows.map((row) => {
      const type = row.type as ReportableMembershipEvent;
      counts[type] += 1;

      if (row.payment !== null && row.payment.status === PaymentStatus.RECORDED) {
        revenueCentavos += row.payment.netCentavos;
      }

      return {
        eventId: row.id,
        membershipId: row.membershipId,
        businessDate: gymToday(row.effectiveAt, this.gym.timeZone),
        effectiveAt: row.effectiveAt.toISOString(),
        type,
        memberName: fullName(row.membership.user) ?? 'Unknown member',
        memberCode: row.membership.user.memberCode,
        planCode: row.payment?.planCode ?? row.membership.planCode,
        planName: row.payment?.planName ?? row.membership.planName,
        netCentavos: row.payment === null ? null : row.payment.netCentavos,
        newEndsOn: row.newEndsOn === null ? null : civilDateFromPrisma(row.newEndsOn),
      };
    });

    return {
      from,
      to,
      items,
      total: items.length,
      // `===`, not `>=`: `take` cannot return more. Saying "there may be
      // more" is the honest reading of hitting the ceiling exactly, and the
      // client prints it on every export footnote rather than shipping a
      // truncated file that looks complete.
      truncated: rows.length === MEMBERSHIP_ACTIVITY_LIMIT,
      counts,
      revenueCentavos,
    };
  }
}
