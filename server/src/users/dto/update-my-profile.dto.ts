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

/**
 * `PATCH /me/profile` — the caller's own body metrics and medical notes.
 *
 * Every field optional, and an absent field is left alone: only what was sent
 * changes. `null` clears a value (`@IsOptional` skips validation for it).
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
