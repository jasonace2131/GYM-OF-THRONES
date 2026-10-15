import { Controller, Get, Header, Query } from '@nestjs/common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import {
  ReportsService,
  type GcashReferenceList,
  type MembershipActivityReport,
  type RecurringReport,
  type OwnerSummaryPayload,
  type RevenueReport,
  type StatutoryDiscountRegister,
  type WalkInStatsReport,
} from './reports.service';
import {
  DailySummaryQueryDto,
  ReportRangeQueryDto,
  RevenueQueryDto,
} from './dto/report-range-query.dto';
import { MembershipActivityQueryDto } from './dto/membership-activity-query.dto';
import { GymConfigService } from '../config/gym.config';
import { gymToday } from '../common/time/gym-time';


/**
 * Routes 36 and 37. Both are staff-wide aggregates rather than per-member reads,
 * so neither carries @Scope: `payment.read` is granted only to FRONT_DESK and
 * ADMIN, both at ALL, and COACH holds no payment key at any scope.
 * `revenue.read` (revenue and recurring) is ADMIN only, at ALL.
 */
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly gym: GymConfigService,
  ) {}

  @Get('statutory-discounts')
  @RequirePermission('payment.read')
  async statutoryDiscounts(
    @Query() query: ReportRangeQueryDto,
  ): Promise<StatutoryDiscountRegister> {
    return this.reports.statutoryDiscounts(query, new Date());
  }

  @Get('gcash')
  @RequirePermission('payment.read')
  async gcash(@Query() query: ReportRangeQueryDto): Promise<GcashReferenceList> {
    return this.reports.gcashReferences(query, new Date());
  }

  /**
   * The day's whole picture — and it was already being computed.
   *
   * `buildOwnerSummary` has existed since chunk 1: cash position, GCash,
   * new versus renewed memberships, expiries, voids, discounts with the
   * staff who applied them, freezes. The nightly job hands it to
   * `LoggingSummaryTransport`, which JSON.stringifies it to the logger.
   * Nobody has ever read it. This is one route over work already done.
   */
  @Get('daily-summary')
  @RequirePermission('payment.read')
  async dailySummary(@Query() query: DailySummaryQueryDto): Promise<OwnerSummaryPayload> {
    // `?date=` is validated now. It used to be an unvalidated string cast
    // straight to CivilDate, so `?date=garbage` reached `toDateColumn` and
    // went into a Prisma query as an Invalid Date — a 500 from a typo.
    return this.reports.buildOwnerSummary(query.date ?? gymToday(new Date(), this.gym.timeZone));
  }

  /**
   * Revenue over time. `groupBy` defaults to month — the usual question.
   *
   * ONE DTO, and `groupBy` is declared on it. The previous shape — a
   * validated `@Query()` against a DTO that did not list `groupBy`, plus a
   * separate `@Query('groupBy')` — met the global pipe's
   * `forbidNonWhitelisted: true` and returned
   * `400 property groupBy should not exist` for every request the client
   * actually sent. Confirmed against a running server on 2026-09-22.
   *
   * `revenue.read`, not `payment.read` (owner decision, 2026-09-25): the front
   * desk keeps Reports, peso figures included, but not Revenue.
   */
  @Get('revenue')
  @RequirePermission('revenue.read')
  async revenue(@Query() query: RevenueQueryDto): Promise<RevenueReport> {
    return this.reports.revenue(query, query.groupBy ?? 'month', new Date());
  }

  /** Walk-in statistics: volume, takings, peak hours and conversions. */
  @Get('walk-ins')
  @RequirePermission('payment.read')
  async walkIns(@Query() query: ReportRangeQueryDto): Promise<WalkInStatsReport> {
    return this.reports.walkInStats(query, new Date());
  }

  /**
   * Membership movement in a window: purchases, renewals, reactivations,
   * cancellations and expiries, read from the append-only MembershipEvent log.
   *
   * `payment.read`, not a key of its own — it matches the nav gate on
   * `/admin/reports` (`client/src/components/admin/nav.ts`), so the whole
   * screen stays behind one permission rather than rendering with one panel
   * silently 403ing.
   */
  @Get('memberships')
  @RequirePermission('payment.read')
  async memberships(
    @Query() query: MembershipActivityQueryDto,
  ): Promise<MembershipActivityReport> {
    return this.reports.membershipActivity(query, new Date());
  }

  /**
   * MRR, ARPU, churn. No range — these describe right now. Part of Revenue,
   * so `revenue.read` like the route above.
   */
  @Get('recurring')
  @RequirePermission('revenue.read')
  async recurring(): Promise<RecurringReport> {
    return this.reports.recurring(gymToday(new Date(), this.gym.timeZone));
  }

  /**
   * The statutory register as a file, because BIR asks for it on paper.
   *
   * CSV rather than XLSX: no dependency, opens in Excel and Sheets, and a
   * BIR register is a flat list of rows — the one shape CSV is actually good
   * at. Money is written in PESOS here, not centavos: this file is read by a
   * person and an accountant, and it is the only place in the system where
   * a formatted amount is correct.
   */
  @Get('statutory-discounts.csv')
  @RequirePermission('payment.read')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="statutory-discounts.csv"')
  async statutoryCsv(@Query() query: ReportRangeQueryDto): Promise<string> {
    const register = await this.reports.statutoryDiscounts(query, new Date());

    const header = 'Date,Member,ID number,Type,Gross,VAT base,Discount,Net';
    const lines = register.rows.map((row) =>
      [
        row.businessDate,
        csvCell(row.memberName),
        csvCell(row.statutoryIdNo ?? ''),
        row.discountType,
        pesos(row.grossCentavos),
        pesos(row.vatBaseCentavos),
        pesos(row.discountCentavos),
        pesos(row.netCentavos),
      ].join(','),
    );

    return [header, ...lines, '', `Total discount,${pesos(register.totalDiscountCentavos)}`].join(CRLF);
  }
}

/** CSV wants CRLF per RFC 4180, and a literal one in source is fragile. */
const CRLF = String.fromCharCode(13, 10);

/** Two decimals, no separators — a spreadsheet must parse it as a number. */
function pesos(centavos: number): string {
  return (centavos / 100).toFixed(2);
}

/**
 * A CSV cell.
 *
 * The leading-character guard is the one that matters: a member named
 * `=cmd|...` is a formula-injection payload the moment the file opens in
 * Excel, and the names in this column are staff-typed free text.
 */
function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}
