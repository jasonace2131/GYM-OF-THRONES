import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { DiscountType, PaymentMethod } from '@got/shared';
import { IsCentavos } from '../../common/validators/is-centavos.validator';
import { IsPaymentReference, IsPersonName, IsPhPhone, Trim, TrimOrNull } from '../../common/validators/text.validators';

/** Trims AND lower-cases: `User.email` is a plain (case-sensitive) unique
 *  column, so "Jon@x.com" and "jon@x.com" would otherwise slip past both the
 *  service's own duplicate check and the database constraint as two rows. */
const normalizedEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * `POST /members`'s optional last step — "walk-in signs up and pays" in one
 * submit. Every field here except `planCode` and `method` mirrors
 * `CreateMembershipDto`; there is deliberately no `userId` — the new
 * member's id, not yet known when the client builds this request, is filled
 * in by `MembersService.create` after the `User` row exists.
 */
export class AssignPlanDto {
  @Trim()
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
  @Trim()
  @IsString()
  @Length(3, 64)
  statutoryIdNo?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @Length(3, 200)
  discountReason?: string;

  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @IsOptional()
  @IsPaymentReference()
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

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/**
 * `POST /members` — C2. Role is deliberately absent: every created member is
 * CLIENT, and privilege escalation has its own guarded route
 * (`POST /members/:id/role`), same reasoning as `UpdateMemberDto` keeping
 * email/role/status off the profile edit.
 */
export class CreateMemberDto {
  @IsPersonName('firstName')
  firstName!: string;

  @IsPersonName('lastName')
  lastName!: string;

  @IsEmail()
  @Transform(normalizedEmail)
  @MaxLength(254)
  email!: string;

  /** Same shape as `UpdateMemberDto.phone` / `ImportMemberRowDto.phone`. */
  @IsOptional()
  @IsPhPhone()
  phone?: string | null;

  @IsOptional()
  @TrimOrNull()
  @IsString()
  @Length(1, 200)
  emergencyContact?: string | null;

  /** Optional — see `AssignPlanDto`'s doc comment. */
  @IsOptional()
  @ValidateNested()
  @Type(() => AssignPlanDto)
  plan?: AssignPlanDto;

  /**
   * The enquiry this member came from. Closes the funnel: the lead is marked
   * CONVERTED with `convertedUserId` in the same transaction that creates the
   * account, so "how many enquiries joined" is a real number rather than a
   * guess by name.
   */
  @IsOptional()
  @IsUUID()
  leadId?: string;

  /**
   * The walk-in VISIT this member was converted from — staff pressed "Make
   * member" on a guest's row. Stamps `CheckIn.convertedToUserId`, which is
   * the only way the walk-in report can count conversions.
   *
   * Ignored silently if the visit is not a guest visit: a member's own visit
   * has nothing to convert, and `CheckIn_converted_guest_only` would refuse
   * the write anyway.
   */
  @IsOptional()
  @IsUUID()
  fromCheckInId?: string;
}
