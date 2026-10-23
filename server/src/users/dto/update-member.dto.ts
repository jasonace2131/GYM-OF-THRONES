import { IsOptional, IsString, Length } from 'class-validator';
import { IsPersonName, IsPhPhone, TrimOrNull } from '../../common/validators/text.validators';

/**
 * `PATCH /members/:id` — name, phone, emergency contact. Every field
 * optional, hand-written rather than `PartialType` (matches
 * `UpdateAnnouncementDto`/`UpdatePlanDto`). An empty body is a valid no-op —
 * `forbidNonWhitelisted` still 400s an unknown key.
 *
 * Deliberately absent: email, role, status. Email has no route here at all;
 * role and status each have their own guarded route (`/role`,
 * `/suspend`, `/reactivate`) precisely so a name-and-phone edit can never
 * smuggle a privilege change through the same request.
 */
export class UpdateMemberDto {
  @IsOptional()
  @IsPersonName('firstName')
  firstName?: string;

  @IsOptional()
  @IsPersonName('lastName')
  lastName?: string;

  /** Same shape as `ImportMemberRowDto.phone` — kept identical on purpose. */
  @IsOptional()
  @IsPhPhone()
  phone?: string | null;

  /**
   * Free text, single column — no structured name/phone/relation fields.
   * `Length(0, ...)` rather than `Length(1, ...)`: an empty string is how the
   * client clears a previously-set contact.
   */
  @IsOptional()
  @TrimOrNull()
  @IsString()
  @Length(1, 200)
  emergencyContact?: string | null;
}
