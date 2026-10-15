import type { CivilDate } from '../../common/time/gym-time';
import { IsGymDate } from '../../common/validators/is-gym-date.validator';

/**
 * `GET /admin/check-ins/daily` — BOTH bounds are mandatory.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS USED TO SHARE `ReportRangeQueryDto`, AND SHARING IT BECAME UNSAFE.
 *
 * That DTO's bounds went optional when the reports controller gained defaults
 * via `resolveDateWindow`. This endpoint has no such defaulting: it reads
 * `from` and `to` straight into `civilDaysBetween` and `toDateColumn`. With an
 * optional bound and no default, a request sending neither would compute a
 * `NaN` span — which passes both `span < 0` and `span >= MAX_RANGE_DAYS` —
 * and then hand Prisma an Invalid Date. A 500 from an omitted parameter.
 *
 * Its cap is also its own: 90 days, matching `ListMembershipsQueryDto`, not
 * the 366 the reports screen needs. Two endpoints with two contracts get two
 * DTOs; one DTO loosened to fit both would have silently loosened this one.
 * ─────────────────────────────────────────────────────────────────────────
 */
export class DailyCheckInsQueryDto {
  @IsGymDate()
  from!: CivilDate;

  @IsGymDate()
  to!: CivilDate;
}
