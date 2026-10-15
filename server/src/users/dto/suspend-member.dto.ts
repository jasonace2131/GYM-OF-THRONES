import { IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * `POST /members/:id/suspend`. `reason` matches every other staff-typed
 * reason in this codebase (`FreezeMembershipDto.reason`,
 * `MembershipEvent.reason`'s `>= 3` CHECK): 3-200 chars, mandatory.
 *
 * `POST /members/:id/reactivate` deliberately has NO dto and no `@Body()`
 * param — it clears the suspension unconditionally, needs no input, and any
 * body sent to it is simply never bound or inspected (not rejected),
 * matching `MembershipsController.withdrawCancellation`.
 */
export class SuspendMemberDto {
  /**
   * Trimmed BEFORE `@Length` runs, same as `UpdateMemberDto`/`CreateMemberDto`
   * — without it `"   "` is a 3-character "reason" that passes validation and
   * lands in the audit trail as a blank suspension note.
   */
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(3, 200)
  reason!: string;
}
