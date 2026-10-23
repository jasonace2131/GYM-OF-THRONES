import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import { IsISO8601 } from 'class-validator';
import { DiscountType, PaymentMethod, PaymentPurpose } from '@got/shared';
import { IsCentavos } from '../../common/validators/is-centavos.validator';
import { IsPaymentReference, Trim } from '../../common/validators/text.validators';

/**
 * The canonical money DTO for a counter sale.
 *
 * Bounds match the Payment CHECKs character for character (§5.8.5), so there
 * is no input the pipe accepts that the database then rejects — a 422 from a
 * CHECK is a bug report, never a user-facing path.
 *
 * `grossCentavos` is REQUIRED and must equal the plan's list price. Staff do
 * not compute it: the sale sheet echoes back the figure it was quoted, and the
 * server refuses a stale price sheet with PAYMENT_AMOUNT_MISMATCH rather than
 * writing a receipt for a price nobody published.
 *
 * `netCentavos` is OPTIONAL, and that asymmetry is deliberate. For a statutory
 * discount the desk MUST NOT know the net — §5.7.4 requires the server to
 * compute it — so a required net would force the 20% arithmetic back into the
 * client. When it is sent (NONE, or a discretionary discount the operator
 * entered) it is checked against the computed figure.
 */
export class RecordPaymentDto {
  /**
   * WALK_IN only, refused in the service for anything else. A MEMBERSHIP
   * payment is written inside the membership transaction (routes 22, 23) and a
   * FREEZE_FEE inside the hold transaction (route 26); if this route could
   * write either, money could be taken for a term that was never created.
   */
  @IsEnum(PaymentPurpose)
  purpose!: PaymentPurpose;

  /** The immutable snapshot key from the price list, e.g. 'WALKIN'. */
  @IsString()
  @Length(2, 32)
  planCode!: string;

  /** NULL for an off-the-street guest with no account. */
  @IsOptional()
  @IsUUID('4')
  userId?: string;

  @IsCentavos(1, 10_000_000)
  grossCentavos!: number;

  @IsOptional()
  @IsCentavos(0, 10_000_000)
  netCentavos?: number;

  @IsOptional()
  @IsEnum(DiscountType)
  discountType?: DiscountType;

  /** Read for PROMO / STAFF / GUEST_PASS / GOODWILL only; ignored otherwise. */
  @IsOptional()
  @IsCentavos(0, 10_000_000)
  discountCentavos?: number;

  /** Required for SENIOR / PWD. BIR keeps this register separately. */
  @IsOptional()
  @Trim()
  @IsString()
  @Length(3, 64)
  statutoryIdNo?: string;

  /** Required for the discretionary types; ≥ 3 chars, matching the CHECK. */
  @IsOptional()
  @Trim()
  @IsString()
  @Length(3, 200)
  discountReason?: string;

  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  /** Required for GCASH — the reference the member showed on their screen. */
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

  /**
   * A real instant, not a civil date, so IsISO8601 is correct here and
   * IsGymDate is not. Present for the entry staff forgot to make yesterday;
   * the business day is derived from it, never sent separately.
   */
  @IsOptional()
  @IsISO8601()
  receivedAt?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
