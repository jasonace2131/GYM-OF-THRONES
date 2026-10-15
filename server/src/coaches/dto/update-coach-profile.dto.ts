import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { COACH_PROFILE_LIMITS } from '@got/shared';

/**
 * `PUT /admin/coaches/:id/profile`. Replaces both fields.
 *
 * The same limits the database enforces (`CoachProfile_specializations_shape`,
 * `CoachProfile_bio_shape`), counted after trimming, so a request the DTO
 * accepts is one the CHECKs accept. `bio: null` (or blank) clears it.
 */
export class UpdateCoachProfileDto {
  @Transform(({ value }: { value: unknown }): unknown =>
    Array.isArray(value)
      ? (value as unknown[]).map((v: unknown) => (typeof v === 'string' ? v.trim() : v))
      : value,
  )
  @IsArray()
  @ArrayMaxSize(COACH_PROFILE_LIMITS.specializations)
  @IsString({ each: true })
  @Length(1, COACH_PROFILE_LIMITS.specializationLength, { each: true })
  specializations!: string[];

  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(COACH_PROFILE_LIMITS.bioLength)
  bio?: string | null;
}
