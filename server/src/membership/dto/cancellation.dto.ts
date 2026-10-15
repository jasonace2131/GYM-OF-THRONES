import { IsString, Length } from 'class-validator';
import { ConfirmDto } from '../../common/dto/confirm.dto';

/**
 * Route 24 — notice, not termination. `cancelRequestedOn` goes on an otherwise
 * ACTIVE row and the term runs to its end, which is what keeps the portal's
 * "cancel any time, no lock-in" promise honest without contradicting the rule
 * that CANCELLED denies at the door immediately.
 *
 * The reason is required even though CANCELLATION_REQUESTED is not covered by
 * MembershipEvent_reason_required: "why are people leaving" is the single most
 * useful number this table can produce, and an optional field on a counter form
 * is an empty field.
 *
 * Route 25 (withdrawal) takes no body at all, so there is no DTO for it —
 * `forbidNonWhitelisted` means a DELETE with a body would 400 anyway.
 */
export class RequestCancellationDto {
  @IsString()
  @Length(3, 200)
  reason!: string;
}

/**
 * Route 28 — the owner terminating a membership outright, mid-term, with the
 * term's remaining days forfeited. Dangerous, hence `confirm`.
 *
 * The reason is mandatory here in three places at once: this DTO, the service,
 * and MembershipEvent_reason_required's `length(btrim(reason)) >= 3`. The
 * bounds are identical in all three so no input the pipe accepts can be
 * rejected by the database.
 */
export class CancelMembershipDto extends ConfirmDto {
  @IsString()
  @Length(3, 200)
  reason!: string;
}
