import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { IsGymDate } from '../../common/validators/is-gym-date.validator';
import type { CivilDate } from '../../common/time/gym-time';

/**
 * Bounds match the `BodyMeasurement_*_sane` CHECKs in the migration exactly, so
 * nothing the pipe accepts can be rejected by the database.
 *
 * These are not validation for its own sake. A typo of 7240 instead of 72400
 * rescales the entire trend chart and reads back to the member as a
 * catastrophic weight loss — the bound is what turns that into a 400 naming
 * the field.
 */
export class RecordMeasurementDto {
  /** Defaults to today in the gym's zone. Supplied to backfill a missed day. */
  @IsOptional()
  @IsGymDate()
  businessDate?: CivilDate;

  /** 72.4 kg is 72400. */
  @IsOptional()
  @IsInt()
  @Min(20_000)
  @Max(400_000)
  weightGrams?: number;

  /** 175.0 cm is 1750. */
  @IsOptional()
  @IsInt()
  @Min(500)
  @Max(2500)
  heightMm?: number;

  /** 18.5% is 185. */
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(700)
  bodyFatPermille?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/**
 * A coach's correction to one recorded day.
 *
 * NULLABLE, unlike the POST: here an explicit `null` CLEARS the field and an
 * absent key leaves it alone. That is the only way to take back a reading
 * typed into the wrong box without deleting the whole day. `@IsOptional()`
 * skips validation for both null and undefined, so the bounds below apply only
 * to a real number. The service refuses a patch that would leave the day with
 * no reading at all (MEASUREMENT_EMPTY), exactly as the CHECK would.
 *
 * No `businessDate`: a reading filed under the wrong day is deleted and
 * recorded again, which keeps the one-row-per-day key out of a PATCH.
 */
export class UpdateMeasurementDto {
  @IsOptional()
  @IsInt()
  @Min(20_000)
  @Max(400_000)
  weightGrams?: number | null;

  @IsOptional()
  @IsInt()
  @Min(500)
  @Max(2500)
  heightMm?: number | null;

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(700)
  bodyFatPermille?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}
