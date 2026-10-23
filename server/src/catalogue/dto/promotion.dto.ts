import { Transform, type TransformFnParams } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PromotionKind } from '@prisma/client';
import { IsGymDate } from '../../common/validators/is-gym-date.validator';
import type { CivilDate } from '../../common/time/gym-time';

const upper = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

const trimmed = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Every bound here mirrors a CHECK in the promotions migration, so a bad
 * value is refused with a readable message instead of surfacing as a
 * constraint violation the counter cannot act on.
 */
export class CreatePromotionDto {
  /** Said out loud at a counter, so uppercase and unambiguous. */
  @Transform(upper)
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,23}$/, {
    message: 'A code is 2–24 characters: capitals, digits and underscores, starting with a letter.',
  })
  code!: string;

  @Transform(trimmed)
  @IsString()
  @Length(1, 80)
  label!: string;

  @IsEnum(PromotionKind)
  kind!: PromotionKind;

  /**
   * PERCENTAGE: basis points (2000 = 20%). FIXED: centavos.
   *
   * One column for two units is a deliberate trade — the alternative is two
   * nullable columns and a CHECK tying each to a kind, which is more shape to
   * get wrong for no gain. The bound below covers whichever is meant; the
   * per-kind range is enforced by `Promotion_value_bounded` in SQL.
   */
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  value!: number;

  @IsGymDate()
  startsOn!: CivilDate;

  @IsGymDate()
  endsOn!: CivilDate;

  /** Omit for unlimited. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  maxRedemptions?: number;

  /** Empty or omitted means every TERM plan. Walk-ins are never eligible. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @Length(1, 24, { each: true })
  planCodes?: string[];
}

/**
 * `code` and `kind` are absent, not optional.
 *
 * The code is what a member was told and what a redeemed payment's reason
 * names; changing it would rewrite history that already went out on posters.
 * The kind decides how `value` is read, so changing one without the other
 * silently reinterprets 2000 from "20%" to "₱20".
 */
/**
 * `POST /promotions/quote` — price a code against a plan before the sale.
 * A class, not an inline type: an inline `@Body()` type is never validated.
 */
export class QuotePromotionDto {
  @Transform(upper)
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,23}$/, {
    message: 'A code is 2–24 characters: capitals, digits and underscores, starting with a letter.',
  })
  code!: string;

  /** Same bounds as every other sale DTO's `planCode`. */
  @Transform(trimmed)
  @IsString()
  @Length(2, 32)
  planCode!: string;
}

export class UpdatePromotionDto {
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(1, 80)
  label?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  value?: number;

  @IsOptional()
  @IsGymDate()
  startsOn?: CivilDate;

  @IsOptional()
  @IsGymDate()
  endsOn?: CivilDate;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  maxRedemptions?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @Length(1, 24, { each: true })
  planCodes?: string[];

  /** Archiving, and un-archiving — neither deletes redemption history. */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
