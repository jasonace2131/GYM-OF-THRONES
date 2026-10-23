import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';
import { DiscountType, PaymentMethod } from '@got/shared';
import { ConfirmDto } from '../../common/dto/confirm.dto';
import { IsCentavos } from '../../common/validators/is-centavos.validator';
import { IsPaymentReference, Trim } from '../../common/validators/text.validators';

/**
 * "Edit payment" — a VOID-AND-RE-RECORD, not a row rewrite.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THERE IS NO TYPED AMOUNT BOX, AND THERE MUST NOT BE ONE.
 *
 * This system has no free-text amount anywhere: `PaymentsService.record()`
 * refuses any `grossCentavos` that is not the plan's list price, and
 * `computeAmounts()` derives the net from the discount. So "fix a wrong
 * amount" is really fix the PLAN, the DISCOUNT or the METHOD — and the amount
 * follows. A typed amount here would be the one place in the register where a
 * figure could be written that no price list ever published.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every omitted field inherits the original. `''` clears `receiptNo` /
 * `notes` — an explicit empty string is how the operator says "there is no
 * booklet number after all", which `undefined` cannot express.
 *
 * `receivedAt` IS DELIBERATELY ABSENT. Money changed hands when it changed
 * hands, and a movable timestamp is a movable business day is a movable till
 * report. The replacement inherits the original's instant, day and shift.
 *
 * Bounds match `RecordPaymentDto` and the Payment CHECKs character for
 * character, so there is no input this pipe accepts that the database then
 * rejects.
 */
export class AmendPaymentDto extends ConfirmDto {
  /** Length matches MembershipEvent_reason_required's btrim(...) >= 3. */
  @Trim()
  @IsString()
  @Length(3, 200)
  reason!: string;

  @IsOptional()
  @IsString()
  @Length(2, 32)
  planCode?: string;

  /**
   * WALK_IN only. A MEMBERSHIP or FREEZE_FEE payment has a NOT NULL payer by
   * `Payment_purpose_shape`, and moving one would detach it from the term it
   * paid for — refused with PAYMENT_PAYER_IMMUTABLE.
   */
  @IsOptional()
  @IsUUID('4')
  userId?: string;

  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @IsOptional()
  @IsPaymentReference({ allowBlank: true })
  reference?: string;

  @IsOptional()
  @IsBoolean()
  gcashVerified?: boolean;

  @IsOptional()
  @IsEnum(DiscountType)
  discountType?: DiscountType;

  @IsOptional()
  @IsCentavos(0, 10_000_000)
  discountCentavos?: number;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(64)
  statutoryIdNo?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(200)
  discountReason?: string;

  /** `''` clears it — the BIR booklet number that turned out not to exist. */
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(64)
  receiptNo?: string;

  /** `''` clears it. */
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
