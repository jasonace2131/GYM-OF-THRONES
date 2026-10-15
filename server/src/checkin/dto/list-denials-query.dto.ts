import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { DenialOutcome, DenialReason } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { IsGymDate } from '../../common/validators/is-gym-date.validator';
import type { CivilDate } from '../../common/time/gym-time';

/**
 * Route 55's filters.
 *
 * The one report that answers "how many people did the door turn away, and
 * why" — which is the number that tells an owner whether the grace window is
 * set right and whether the station is misbehaving.
 */
export class ListDenialsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsGymDate()
  from?: CivilDate;

  @IsOptional()
  @IsGymDate()
  to?: CivilDate;

  @IsOptional()
  @IsUUID('4')
  userId?: string;

  @IsOptional()
  @IsUUID('4')
  stationId?: string;

  /**
   * Validated against the PRISMA ENUM. Typing the values out by hand produced
   * three reasons that do not exist (`GRACE_EXHAUSTED`, `DUPLICATE_SCAN`,
   * `DAILY_LIMIT_REACHED`) and omitted three that do — which would have 400'd
   * every filter staff actually needed.
   */
  @IsOptional()
  @IsEnum(DenialReason, { message: 'reason is not a denial reason' })
  reason?: DenialReason;

  @IsOptional()
  @IsEnum(DenialOutcome, { message: 'outcome is not a denial outcome' })
  outcome?: DenialOutcome;
}
