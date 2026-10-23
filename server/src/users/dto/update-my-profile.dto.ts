import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { PROFILE_LIMITS } from '@got/shared';
import { IsPersonName, IsPhPhone } from '../../common/validators/text.validators';

/**
 * `PATCH /me/profile` — the caller's own name, phone, body metrics and medical
 * notes.
 *
 * Every field optional, and an absent field is left alone: only what was sent
 * changes. `null` clears a value (`@IsOptional` skips validation for it) —
 * except a name, which cannot be cleared.
 *
 * Deliberately absent: email. It changes through Supabase's confirmed email
 * change, and `UserProvisioningService` copies it from the verified token —
 * a member must never be able to set `User.email` through this API.
 * `forbidNonWhitelisted` turns any attempt into a 400.
 */
const trimmedOrNull = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const L = PROFILE_LIMITS;

export class UpdateMyProfileDto {
  /**
   * The member's own name (owner, 2026-10-23). Not clearable: `ValidateIf`
   * runs the checks on `null` instead of skipping it the way `@IsOptional`
   * would. `UserProvisioningService` writes names on FIRST SIGHT ONLY, so the
   * next token's (stale) sign-up metadata never overwrites an edit made here.
   */
  @ValidateIf((dto: UpdateMyProfileDto) => dto.firstName !== undefined)
  @IsPersonName('firstName')
  firstName?: string;

  @ValidateIf((dto: UpdateMyProfileDto) => dto.lastName !== undefined)
  @IsPersonName('lastName')
  lastName?: string;

  /** A PH mobile, stored as +639XXXXXXXXX (the shared rule). Blank or null clears it. */
  @IsOptional()
  @IsPhPhone()
  phone?: string | null;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 1 })
  @Min(L.heightCmMin)
  @Max(L.heightCmMax)
  heightCm?: number | null;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 1 })
  @Min(L.weightKgMin)
  @Max(L.weightKgMax)
  weightKg?: number | null;

  /** Injuries, conditions, "no overhead pressing". Trimmed; blank is null. */
  @IsOptional()
  @Transform(trimmedOrNull)
  @IsString()
  @MaxLength(L.medicalNotesMax)
  medicalNotes?: string | null;

  /**
   * The member's opt-in for medical notes in the AI planner. A REAL boolean
   * only: the raw value is taken back from the body (`obj`) because the app's
   * implicit conversion would turn the string "false" into `true`. `null` is
   * refused too — the column is NOT NULL.
   */
  @ValidateIf((dto: UpdateMyProfileDto) => dto.shareMedicalWithPlanner !== undefined)
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj['shareMedicalWithPlanner'])
  @IsBoolean()
  shareMedicalWithPlanner?: boolean;
}
