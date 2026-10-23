import { IsEnum, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { MembershipStatus } from '@got/shared';
import type { CivilDate } from '../../common/time/gym-time';
import { IsGymDate } from '../../common/validators/is-gym-date.validator';
import { ConfirmDto } from '../../common/dto/confirm.dto';
import { Trim } from '../../common/validators/text.validators';

/**
 * Route 29 — §5.5.2 row 16. Comp days: goodwill, staff error, a closure applied
 * to one member rather than the whole base (that is route 32).
 *
 * POSITIVE ONLY, 1..60. §7.7 says "±1–30" and §5.5.2 says "1 ≤ n ≤ 60"; task
 * 15's ExtendAllDto already fixed 1..60 as the shared bound, and one direction
 * per route is what makes the ledger readable. Taking days away is not a comp,
 * it is a correction of a data error, and it goes through route 30 under
 * membership.status.correct — the dangerous key that already permits arbitrary
 * dates and demands a reason for them.
 */
export class AdjustTermDto extends ConfirmDto {
  @IsInt()
  @Min(1)
  @Max(60)
  days!: number;

  /** Matches MembershipEvent_reason_required's `length(btrim(reason)) >= 3`. */
  @Trim()
  @IsString()
  @Length(3, 200)
  reason!: string;
}

/**
 * Route 30 — §5.5.2 row 17. The escape hatch: an admin correcting a row that is
 * simply wrong, and the ONE caller permitted to bypass assertTransition.
 *
 * Every field is optional and the service refuses a request that supplies none
 * of them: a correction that changes nothing is an audit-log entry pretending
 * to be an action.
 *
 * `cancelledOn` is deliberately NOT a field. Membership_cancel_shape makes
 * status = CANCELLED and cancelledOn IS NOT NULL biconditional, so the service
 * derives it from `status` and the pair can never be made to disagree by a
 * typo in a JSON body.
 */
export class CorrectMembershipDto extends ConfirmDto {
  @IsOptional()
  @IsEnum(MembershipStatus)
  status?: MembershipStatus;

  @IsOptional()
  @IsGymDate()
  startsOn?: CivilDate;

  @IsOptional()
  @IsGymDate()
  endsOn?: CivilDate;

  /** Membership_anchor_valid's bounds, exactly. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  billingAnchorDay?: number;

  @Trim()
  @IsString()
  @Length(3, 200)
  reason!: string;
}
