import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { CivilDate } from '../../common/time/gym-time';
import { IsGymDate } from '../../common/validators/is-gym-date.validator';
import { ConfirmDto } from '../../common/dto/confirm.dto';

/**
 * One notebook line. `email` and `phone` are both optional here and at least
 * one is required by the service, which reports the offending row rather than
 * 400-ing the whole 340-row batch — the operator needs the other 339 loaded.
 *
 * Nested rows need @Type AND @ValidateNested: with only one of them, whitelist
 * strips every row to {} and validation passes silently.
 */
export class ImportMemberRowDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[0-9+][0-9\s-]{6,19}$/, { message: 'phone must be a plausible PH number' })
  phone?: string;

  @IsString()
  @Length(1, 80)
  firstName!: string;

  @IsString()
  @Length(1, 80)
  lastName!: string;

  @IsString()
  @MaxLength(32)
  planCode!: string;

  @IsGymDate()
  startsOn!: CivilDate;

  @IsGymDate()
  endsOn!: CivilDate;

  @IsGymDate()
  joinedOn!: CivilDate;
}

export class ImportMembershipsDto extends ConfirmDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ImportMemberRowDto)
  rows!: ImportMemberRowDto[];
}

export class ExtendAllDto extends ConfirmDto {
  /** Row 16's bound, and the same range AdjustTermDto uses. */
  @IsInt()
  @Min(1)
  @Max(60)
  days!: number;

  @IsString()
  @Length(3, 200)
  reason!: string;

  /** The @@unique([membershipId, batchRef]) key that makes a re-run a no-op. */
  @IsString()
  @Length(3, 64)
  batchRef!: string;
}
