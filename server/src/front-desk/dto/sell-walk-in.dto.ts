import { Transform, type TransformFnParams } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';
import { DiscountType, PaymentMethod } from '@got/shared';
import { IsCentavos } from '../../common/validators/is-centavos.validator';
import { IsPaymentReference, IsPersonName, IsPhPhone, Trim } from '../../common/validators/text.validators';

/**
 * Route 49 — `POST /front-desk/walk-ins`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE ROUTE, TWO SALES, AND THE DIFFERENCE IS NOT COSMETIC.
 *
 *   WALK_IN     money changes hands. A `Payment` plus a `CheckIn`.
 *   GUEST_PASS  no money at all. A host member's `guestPassesRemaining` is
 *               decremented and a `CheckIn` is written with NO `Payment` —
 *               which is precisely why `Payment_amount_positive` never has to
 *               be relaxed for a ₱0 row.
 *
 * They share a route because they are the same gesture at the counter — "let
 * this person in who is not a member" — and splitting them would put two
 * buttons where staff sees one decision.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THERE IS NO `DayPass` MODEL and none is introduced. A walk-in is a sale plus
 * an entry; entitlement for the rest of the gym-local business date is derived
 * from that `CheckIn` row, which is what `dayPassValidToday` reads. A second
 * entitlement table would be a second place to ask "may this person train
 * today", and the two would disagree.
 */
export class SellWalkInDto {
  @IsIn(['WALK_IN', 'GUEST_PASS'])
  kind!: 'WALK_IN' | 'GUEST_PASS';

  /**
   * A RETURNING walk-in with an account, or a member buying a day when their
   * plan cannot admit them. Absent for someone off the street.
   */
  @IsOptional()
  @IsUUID('4')
  userId?: string;

  /**
   * Required for `GUEST_PASS`: the member whose allowance is being spent.
   *
   * A guest pass belongs to a HOST, not to the guest — that is what makes it
   * finite and what makes running out a conversation with the member rather
   * than with a stranger.
   */
  @IsOptional()
  @IsUUID('4')
  hostMembershipId?: string;

  /**
   * WALK-INS ARE NOT ANONYMOUS.
   *
   * A returning walk-in is matched on phone, and the sale sheet can then show
   * what they have spent — which is the whole of what turns a repeat walk-in
   * into a membership conversation. Staff may decline on the member's behalf
   * with one tap, and that is a real choice rather than a hidden default: an
   * unskippable field at a busy counter gets filled with `09171234567`.
   */
  @IsOptional()
  @IsPhPhone()
  guestPhone?: string | null;

  @IsOptional()
  @IsPersonName('guestName', 2)
  guestName?: string;

  /**
   * The guest's email (owner, 2026-10-14: a walk-in must give a name and an
   * email). It is how a day pass becomes a membership later — "Make member"
   * arrives pre-filled with it, and the setup link goes there.
   *
   * Optional HERE, required by the service for anybody without an account,
   * exactly like `guestWaiverAccepted`. Trimmed and lower-cased on the way in,
   * because CheckIn_guest_email_sane refuses any other spelling.
   */
  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  guestEmail?: string;

  /**
   * The guest accepted the liability waiver at the counter.
   *
   * ─────────────────────────────────────────────────────────────────────
   * A WALK-IN USED TO SIGN NOTHING AT ALL.
   *
   * The person least familiar with the equipment — no induction, no
   * membership, possibly their first time in any gym — was the one person
   * with no record of having been warned about anything. Members accepted a
   * waiver in the portal; guests walked past the whole mechanism because
   * they have no account to attach a ConsentRecord to.
   *
   * Boolean rather than a version string for the same reason
   * AcceptConsentDto has no version: the SERVER decides which wording that
   * means, and stamps `LEGAL_VERSIONS.WAIVER` on the row. A client that
   * could name the version could claim assent to wording never shown.
   *
   * Optional in the DTO, REQUIRED by the service for a guest without an
   * account — an existing member ringing a walk-in has already accepted it
   * in the portal and is not asked twice.
   * ─────────────────────────────────────────────────────────────────────
   */
  @IsOptional()
  @IsBoolean()
  guestWaiverAccepted?: boolean;

  /** Who to call if this guest is hurt. Free text, staff-typed, one field. */
  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @Length(2, 200)
  guestEmergencyContact?: string;

  /** `WALK_IN` only. Cash or a typed GCash reference — nothing is processed. */
  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  /** Required by the payment path when `method` is GCASH. */
  @IsOptional()
  @IsPaymentReference()
  reference?: string;

  /**
   * Staff opened the gym's own GCash Transactions tab and saw this payment.
   * Per GCash's own advisory a reference absent from your account is worth
   * nothing even with a perfect-looking screenshot, so this is what turns a
   * claim into a verification. A boolean, deliberately — there is no image.
   */
  @IsOptional()
  @IsBoolean()
  gcashVerified?: boolean;

  /**
   * The number staff wrote in the BIR-registered booklet, when they did.
   * This DTO was the only sale path without one — which meant the ₱90 day
   * pass, the highest-volume sale, could never carry a booklet number.
   * Bounds match RecordPaymentDto character for character.
   */
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(32)
  receiptNo?: string;

  /**
   * STATUTORY DISCOUNTS ARE A ROUTINE DESK TRANSACTION, NOT A MANAGER
   * OVERRIDE. RA 9994 and RA 10754 both name workout gyms: 20% plus VAT
   * exemption is mandatory and refusing it is a criminal offence. The desk
   * must be able to ring one without finding a manager, so `SENIOR` and `PWD`
   * sit behind `payment.discount.statutory`, which FRONT_DESK holds.
   */
  @IsOptional()
  @IsEnum(DiscountType)
  discountType?: DiscountType;

  /** The OSCA or PWD ID number. Required by the payment path for either. */
  @IsOptional()
  @Trim()
  @IsString()
  @Length(3, 64)
  statutoryIdNo?: string;

  /**
   * The denial this sale is answering.
   *
   * A denial is a member at a counter who wants to train and cannot — the
   * highest-intent sales moment the gym gets, and it lasts about ninety
   * seconds. Passing the id here is what closes the funnel: the denial moves
   * to `RESOLVED_WALK_IN` and points at the entry that converted it, so
   * "how many refusals turned into money" is a query rather than a guess.
   */
  @IsOptional()
  @IsUUID('4')
  denialId?: string;

  /**
   * Echoed back for a price cross-check, in CENTAVOS.
   *
   * The server computes the real figure from the plan and the discount; this
   * is the console saying what it showed the member. A mismatch means the
   * price list moved under a sheet that was already open, and the sale is
   * refused rather than silently ringing a different number than the one the
   * member was quoted.
   */
  @IsOptional()
  @IsCentavos(0, 10_000_000)
  netCentavos?: number;

  @IsOptional()
  @IsBoolean()
  identityConfirmed?: boolean;
}
