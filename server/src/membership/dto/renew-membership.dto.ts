import { IsBoolean, IsEnum, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { DiscountType, PaymentMethod } from '@got/shared';
import { IsCentavos } from '../../common/validators/is-centavos.validator';

/**
 * Route 23. CreateMembershipDto's fields minus `userId`, which comes from the
 * membership in the path.
 *
 * Written out in full rather than extended from CreateMembershipDto: TypeScript
 * has no way to REMOVE an inherited property, and `whitelist` +
 * `forbidNonWhitelisted` would then accept a `userId` on a renewal and silently
 * ignore it — a request that looks like it renews member A while renewing B.
 *
 * As on route 22 there is no `startsOn`: §5.7.3's before-expiry / in-grace /
 * post-grace / post-cancel split is the server's decision, and the distinction
 * between RENEWED and REACTIVATED is what churn reporting counts.
 */
export class RenewMembershipDto {
  @IsString()
  @MaxLength(32)
  planCode!: string;

  @IsOptional()
  @IsEnum(DiscountType)
  discountType?: DiscountType;

  @IsOptional()
  @IsCentavos(0, 10_000_000)
  discountCentavos?: number;

  @IsOptional()
  @IsString()
  @Length(3, 64)
  statutoryIdNo?: string;

  @IsOptional()
  @IsString()
  @Length(3, 200)
  discountReason?: string;

  /** A promo code, instead of a hand-keyed discount. See CreateMembershipDto. */
  @IsOptional()
  @IsString()
  @Length(2, 24)
  promoCode?: string;

  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  reference?: string;

  @IsOptional()
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
  @IsString()
  @MaxLength(500)
  notes?: string;
}
