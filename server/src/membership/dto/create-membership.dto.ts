import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import { DiscountType, PaymentMethod } from '@got/shared';
import { IsCentavos } from '../../common/validators/is-centavos.validator';
import { IsPaymentReference, Trim } from '../../common/validators/text.validators';

/**
 * Route 22. The canonical money DTO for this chunk.
 *
 * There is deliberately NO `startsOn` and NO `endsOn`. §5.7.3's four cases are
 * decided by the server from `gymToday()` and the row's own dates; a
 * client-supplied start date is how a desk staffer quietly backdates a term to
 * be generous, which is what comp days (route 29) exist for — visible, reasoned
 * and admin-approved.
 *
 * There is also NO amount field. `grossCentavos` is the plan's list price and
 * the discount is computed (§5.7.4), so no staff member ever types a peso
 * figure and the till cannot disagree with the price list.
 *
 * `discountCentavos` applies ONLY to the discretionary types. For SENIOR and
 * PWD the statute fixes the arithmetic and the service ignores anything sent
 * here — the bound exists so the pipe rejects nonsense before the CHECK does.
 */
export class CreateMembershipDto {
  @IsUUID('4')
  userId!: string;

  @IsString()
  @MaxLength(32)
  planCode!: string;

  @IsOptional()
  @IsEnum(DiscountType)
  discountType?: DiscountType;

  /** Matches Payment_money_consistent's ceiling. Ignored for SENIOR / PWD. */
  @IsOptional()
  @IsCentavos(0, 10_000_000)
  discountCentavos?: number;

  /** The OSCA / PWD ID. Falls back to User.seniorPwdIdNo when omitted. */
  @IsOptional()
  @Trim()
  @IsString()
  @Length(3, 64)
  statutoryIdNo?: string;

  /** Required by Payment_discount_shape for PROMO / STAFF / GUEST_PASS / GOODWILL. */
  @IsOptional()
  @Trim()
  @IsString()
  @Length(3, 200)
  discountReason?: string;

  /**
   * A promo code, instead of a hand-keyed discount.
   *
   * Mutually exclusive with `discountType` in practice: supplying one makes
   * the sale a PROMO and computes the amount from the campaign, so a caller
   * cannot use a code AND name their own discount. Statutory always wins —
   * a senior presenting a promo code gets the RA 9994 entitlement, which is
   * worth more and is a legal right rather than an offer.
   */
  @IsOptional()
  @Trim()
  @IsString()
  @Length(2, 24)
  promoCode?: string;

  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  /** Required when method is GCASH — an unreferenced GCash row cannot be reconciled. */
  @IsOptional()
  @IsPaymentReference()
  reference?: string;

  /** The number staff wrote in the BIR booklet. Free text, never a sequence. */
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

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
