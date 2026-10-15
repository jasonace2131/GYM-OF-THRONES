import { IsBoolean, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Values are HUNDREDTHS of `unit` — 100.5 kg is 10050 — for the same
 * integer-not-float reason money is centavos.
 *
 * The ±100,000,000 bound is not a real-world limit, it is an overflow guard:
 * the columns are INTEGER, and a client sending 2^31 would fail at the
 * database as a 500 rather than at the pipe as a 400.
 */
const VALUE = { min: -100_000_000, max: 100_000_000 } as const;

export class CreateGoalDto {
  @Transform(trimmed)
  @IsString()
  @Length(1, 80)
  name!: string;

  /** A short label: "kg", "reps", "visits", "km". */
  @Transform(trimmed)
  @IsString()
  @Length(1, 12)
  unit!: string;

  @IsInt()
  @Min(VALUE.min)
  @Max(VALUE.max)
  startHundredths!: number;

  @IsInt()
  @Min(VALUE.min)
  @Max(VALUE.max)
  targetHundredths!: number;
}

export class UpdateGoalDto {
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(1, 80)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(VALUE.min)
  @Max(VALUE.max)
  currentHundredths?: number;

  @IsOptional()
  @IsInt()
  @Min(VALUE.min)
  @Max(VALUE.max)
  targetHundredths?: number;

  /**
   * `false` must CLEAR the achieved timestamp, so the service branches on
   * `undefined` rather than on truthiness — a member who ticked a goal by
   * mistake has to be able to untick it.
   */
  @IsOptional()
  @IsBoolean()
  achieved?: boolean;
}
