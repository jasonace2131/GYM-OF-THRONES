import { IsBoolean, IsEnum, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { PaymentMethod } from '@got/shared';
import type { CivilDate } from '../../common/time/gym-time';
import { IsGymDate } from '../../common/validators/is-gym-date.validator';
import { IsPaymentReference, Trim } from '../../common/validators/text.validators';

/**
 * `endsOn` is MANDATORY (§5.6): an open-ended freeze is a cancellation the
 * member never asked for, accruing silent liability.
 *
 * The fields are declared as CivilDate because that is what every consumer
 * takes, but the pipe hands over an unvalidated string — the service still runs
 * `asCivilDate()` on both, which is what rejects '2026-02-31'.
 */
export class FreezeMembershipDto {
  @IsGymDate()
  startsOn!: CivilDate;

  @IsGymDate()
  endsOn!: CivilDate;

  /** Matches MembershipEvent_reason_required's `length(btrim(...)) >= 3`. */
  @Trim()
  @IsString()
  @Length(3, 200)
  reason!: string;

  /** Medical freezes are free (§5.6). Everything else pays the fee. */
  @IsOptional()
  @IsBoolean()
  feeWaived?: boolean;

  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @IsOptional()
  @IsPaymentReference({ allowBlank: true })
  reference?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(32)
  receiptNo?: string;

  /**
   * Staff opened the gym's own GCash Transactions tab and saw this payment.
   * Per GCash's own advisory a reference absent from your account is worth
   * nothing even with a perfect-looking screenshot, so this is what turns a
   * claim into a verification. A boolean is enough; there is deliberately no
   * image.
   */
  @IsOptional()
  @IsBoolean()
  gcashVerified?: boolean;
}

export class UnfreezeMembershipDto {
  @IsOptional()
  @Trim()
  @IsString()
  @Length(3, 200)
  reason?: string;
}
