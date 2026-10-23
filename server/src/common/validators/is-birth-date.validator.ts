import { applyDecorators } from '@nestjs/common';
import { IsString, ValidateBy, type ValidationOptions } from 'class-validator';
import { BIRTH_DATE_MIN, isPlausibleBirthDate } from '@got/shared';

/**
 * The latest calendar date that is "today" anywhere on Earth (UTC+14). A
 * validator has no gym clock, and refusing a birthday that is already today in
 * Manila but not yet in UTC would be wrong; this only ever refuses a date that
 * is in the future everywhere.
 */
export function latestToday(now: number = Date.now()): string {
  return new Date(now + 14 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * A `yyyy-mm-dd` date of birth (owner, 2026-10-23): a real date, not before
 * 1900-01-01, never in the future. No minimum age here.
 */
export function IsBirthDate(options?: ValidationOptions): PropertyDecorator {
  return applyDecorators(
    IsString(options),
    ValidateBy(
      {
        name: 'isBirthDate',
        validator: {
          validate: (value: unknown): boolean =>
            typeof value === 'string' && isPlausibleBirthDate(value, latestToday()),
          defaultMessage: (): string =>
            `$property must be a yyyy-mm-dd date between ${BIRTH_DATE_MIN} and today`,
        },
      },
      options,
    ),
  );
}
