import { PlanKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  MinLength,
  Min,
} from 'class-validator';
import { IsCentavos } from '../../common/validators/is-centavos.validator';
import { Trim, TrimOrNull } from '../../common/validators/text.validators';

/**
 * Every bound here is written to match §5.8.2's Plan CHECKs, so no input the
 * pipe accepts can be rejected by the database.
 *
 * The one rule that is NOT expressible as a per-property bound —
 * `Plan_term_matches_kind`, which couples `kind`, `termMonths` and `freezable`
 * — is checked in `PlansService` with `planShapeError()` and surfaces as a
 * plain 400, matching route 7's contract (its only named failure is the 409 on
 * a duplicate code).
 */
export class CreatePlanDto {
  /**
   * The immutable snapshot key. Upper-case so `Payment.planCode` reads the
   * same everywhere, and bounded so it fits a receipt line.
   */
  @Matches(/^[A-Z][A-Z0-9_]{1,23}$/, {
    message: 'code must be 2-24 upper-case letters, digits or underscores',
  })
  code!: string;

  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @TrimOrNull()
  @IsString()
  @MaxLength(300)
  description?: string | null;

  @IsEnum(PlanKind)
  kind!: PlanKind;

  @IsCentavos(0, 10_000_000)
  priceCentavos!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  termMonths?: number;

  @IsOptional()
  @IsBoolean()
  freezable?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(12)
  guestPassesPerTerm?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(14)
  graceDays?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  perks?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;
}
