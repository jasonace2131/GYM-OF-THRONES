import { IsEnum, IsString, Length } from 'class-validator';
import { PaymentVoidKind } from '@prisma/client';
import { ConfirmDto } from '../../common/dto/confirm.dto';
import { Trim } from '../../common/validators/text.validators';

/**
 * A void is the only mutation a Payment ever accepts. There is no PATCH, no
 * partial refund and no negative amount: a mistake is voided and re-recorded,
 * which is what an auditor expects and what keeps the daily count reconcilable.
 *
 * `kind` tells apart the two reasons a payment ends up VOIDED: VOID ("recorded
 * in error — no money moved") and REFUND ("money returned to the member").
 * Imported from the generated Prisma client rather than hand-copied — this
 * repo has been burned by an invented enum member before.
 */
export class VoidPaymentDto extends ConfirmDto {
  /** Length matches MembershipEvent_reason_required's btrim(...) >= 3. */
  @Trim()
  @IsString()
  @Length(3, 200)
  reason!: string;

  @IsEnum(PaymentVoidKind)
  kind!: PaymentVoidKind;
}
