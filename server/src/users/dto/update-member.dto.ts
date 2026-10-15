import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

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
const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class UpdateMemberDto {
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(1, 80)
  firstName?: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(1, 80)
  lastName?: string;

  /** Same shape as `ImportMemberRowDto.phone` — kept identical on purpose. */
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Matches(/^[0-9+][0-9\s-]{6,19}$/, { message: 'phone must be a plausible PH number' })
  phone?: string;

  /**
   * Free text, single column — no structured name/phone/relation fields.
   * `Length(0, ...)` rather than `Length(1, ...)`: an empty string is how the
   * client clears a previously-set contact.
   */
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(0, 200)
  emergencyContact?: string;
}
