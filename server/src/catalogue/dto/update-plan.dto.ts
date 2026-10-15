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
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsCentavos } from '../../common/validators/is-centavos.validator';

/**
 * Every CreatePlanDto field except `code`.
 *
 * `code` is absent rather than optional on purpose: it is snapshotted onto
 * Membership.planCode and Payment.planCode at every sale, so renaming it would
 * silently orphan every receipt already handed to a member. Because the
 * ValidationPipe runs `forbidNonWhitelisted`, a client that sends `code` gets a
 * 400 naming the property rather than a silently ignored field.
 *
 * `kind` IS editable, and safely so: everything a live membership depends on
 * (termMonths, price, graceDays, guestPassesPerTerm) is copied onto the
 * Membership row at purchase, so no edit here can rewrite what anyone already
 * bought. The service re-runs `planShapeError()` against the MERGED row, so a
 * TERM→WALK_IN flip that would leave a stale termMonths behind is a 400.
 */
export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsEnum(PlanKind)
  kind?: PlanKind;

  @IsOptional()
  @IsCentavos(0, 10_000_000)
  priceCentavos?: number;

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
