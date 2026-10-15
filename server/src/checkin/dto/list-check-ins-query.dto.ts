import { IsBoolean, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { CheckInEntryType, CheckInMethod } from '@prisma/client';
import { Transform, type TransformFnParams } from 'class-transformer';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { IsGymDate } from '../../common/validators/is-gym-date.validator';
import type { CivilDate } from '../../common/time/gym-time';

/**
 * Route 53's filters.
 *
 * Dates are CIVIL DATES over `businessDate`, never instants over `occurredAt`.
 * The gym opens at 05:00 Manila, which is 21:00 UTC the previous day — an
 * instant range would put the busiest hour of every morning in the wrong day's
 * report, and the totals would disagree with the daily figures staff already
 * see on the dashboard.
 */
export class ListCheckInsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsGymDate()
  from?: CivilDate;

  @IsOptional()
  @IsGymDate()
  to?: CivilDate;

  /** One member's history. Staff-side, so it takes an id rather than a code. */
  @IsOptional()
  @IsUUID('4')
  userId?: string;

  @IsOptional()
  @IsUUID('4')
  stationId?: string;

  /**
   * Validated against the PRISMA ENUM, never a list typed out here.
   *
   * The first draft of this file invented `OFFLINE_QUEUED` as a method and
   * three denial reasons that do not exist, while missing three that do. A
   * hand-copied enum is a second source of truth that is wrong the moment
   * anybody adds a value.
   */
  @IsOptional()
  @IsEnum(CheckInMethod, { message: 'method is not a check-in method' })
  method?: CheckInMethod;

  @IsOptional()
  @IsEnum(CheckInEntryType, { message: 'entryType is not a check-in entry type' })
  entryType?: CheckInEntryType;

  /**
   * Voided visits are EXCLUDED by default.
   *
   * A void is a correction — staff establishing a visit did not happen — so a
   * report that silently counted them would overstate attendance. They are
   * available on request because a dispute needs to see the corrected row, not
   * an absence.
   */
  @IsOptional()
  @Transform(({ value }: TransformFnParams): unknown =>
    value === 'true' || value === true ? true : value === 'false' || value === false ? false : value,
  )
  @IsBoolean()
  includeVoided?: boolean;

  /** Open visits only — who is in the building over a historical range. */
  @IsOptional()
  @Transform(({ value }: TransformFnParams): unknown =>
    value === 'true' || value === true ? true : value === 'false' || value === false ? false : value,
  )
  @IsBoolean()
  openOnly?: boolean;
}
