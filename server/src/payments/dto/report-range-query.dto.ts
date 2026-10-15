import { IsIn, IsOptional } from 'class-validator';
import type { CivilDate } from '../../common/time/gym-time';
import { IsGymDate } from '../../common/validators/is-gym-date.validator';
import type { RevenueGroup } from '../reports.service';

/**
 * Both bounds are inclusive gym-local civil dates, never @IsDateString(): a full
 * UTC instant arriving here is exactly how the timezone bug class returns, and
 * the columns being filtered are @db.Date.
 *
 * SHAPE ONLY. Both bounds are now optional, and their MEANING — defaults, the
 * reversed-window refusal and the width cap — is checked by `resolveDateWindow`
 * in `common/time/date-window.ts`. So a 400 from the pipe is about what was
 * sent and a DATE_RANGE_INVALID is about what it means.
 */
export class ReportRangeQueryDto {
  @IsOptional()
  @IsGymDate()
  from?: CivilDate;

  @IsOptional()
  @IsGymDate()
  to?: CivilDate;
}

/**
 * `GET /reports/revenue`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS SUBCLASS EXISTS BECAUSE THE ENDPOINT WAS REJECTING EVERY REAL REQUEST.
 *
 * `main.ts` runs the global ValidationPipe with `forbidNonWhitelisted: true`,
 * so a query property no DTO declares is a 400 — not an ignored extra. The
 * controller validated `@Query()` against the bare range DTO while separately
 * reading `@Query('groupBy')`, and the client always sends `groupBy`. Verified
 * against a running server on 2026-09-22:
 *
 *   GET /api/v1/reports/revenue?from=…&to=…&groupBy=month
 *   → 400 {"code":"HTTP_400","message":"property groupBy should not exist"}
 *
 * Declaring it here is the fix. Reading a query parameter the DTO does not
 * list is the shape of the bug, so do not reintroduce a second `@Query('x')`
 * alongside a validated `@Query()`.
 * ─────────────────────────────────────────────────────────────────────────
 */
export class RevenueQueryDto extends ReportRangeQueryDto {
  @IsOptional()
  @IsIn(['month', 'plan', 'method', 'purpose'])
  groupBy?: RevenueGroup;
}

/**
 * `GET /reports/daily-summary`.
 *
 * The controller used to cast an unvalidated `@Query('date')` string straight
 * to CivilDate, so `?date=garbage` reached `toDateColumn` and went into a
 * Prisma query as an Invalid Date — a 500 from a typo. `@IsGymDate()` is the
 * same rule every other date-bearing query on this controller already used.
 */
export class DailySummaryQueryDto {
  @IsOptional()
  @IsGymDate()
  date?: CivilDate;
}
