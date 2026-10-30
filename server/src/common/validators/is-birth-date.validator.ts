import { applyDecorators } from '@nestjs/common';
import { IsString, ValidateBy, type ValidationOptions } from 'class-validator';
import { BIRTH_DATE_MAX_YEARS, isPlausibleBirthDate } from '@got/shared';

/**
 * The latest calendar date that is "today" anywhere on Earth (UTC+14). A
 * validator has no gym clock, and refusing a birthday that is already today in
 * Manila but not yet in UTC would be wrong; this only ever refuses a date that
 * is in the future everywhere.
 *
 * The 120-year bound is measured from this day too, so it is never looser
 * than the database's, which is measured from its own (UTC) CURRENT_DATE.
 */
export function latestToday(now: number = Date.now()): string {
  return new Date(now + 14 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * A `yyyy-mm-dd` date of birth (owner, 2026-10-23): a real date, less than 120
 * years ago, never in the future. The minimum account age (12, owner
 * 2026-10-30) is not checked here; see `auth/minimum-age.ts`.
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
            '$property must be a real yyyy-mm-dd date, not in the future and less than ' +
            `${BIRTH_DATE_MAX_YEARS} years ago`,
        },
      },
      options,
    ),
  );
}
