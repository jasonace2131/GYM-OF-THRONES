import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** One weekday. Mirrors the CHECK constraints exactly. */
export class DayHoursDto {
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @Matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, { message: 'Use a 24-hour time like 05:00.' })
  opensAt!: string;

  @Matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, { message: 'Use a 24-hour time like 22:00.' })
  closesAt!: string;

  @IsBoolean()
  isClosed!: boolean;
}

/**
 * The whole week at once, never one day at a time.
 *
 * A per-day PATCH would let the seven rows drift into a state nobody
 * intended — Tuesday saved, Wednesday lost to a dropped connection, and an
 * hours table that half-agrees with itself. Replacing the set makes the
 * screen's contents and the database's contents the same thing.
 */
export class ReplaceOpeningHoursDto {
  @IsArray()
  @ArrayMinSize(7)
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => DayHoursDto)
  days!: DayHoursDto[];
}
