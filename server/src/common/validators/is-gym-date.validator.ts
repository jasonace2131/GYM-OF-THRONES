import { applyDecorators } from '@nestjs/common';
import { Matches } from 'class-validator';

/**
 * A gym-local civil date, `yyyy-mm-dd`.
 *
 * Deliberately NOT `@IsDateString()`: that accepts a full timestamp, and a
 * timestamp arriving where a civil date is meant is exactly how the UTC+8 bug
 * gets reintroduced. If it has a time in it, it is not a gym date.
 *
 * Shape only. Calendar validity ('2026-02-31') is the service's problem, via
 * `asCivilDate()` from common/time/gym-time.ts — splitting shape from meaning
 * keeps the 400 from the pipe about what the client sent.
 */
export const IsGymDate = (): PropertyDecorator =>
  applyDecorators(
    Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '$property must be a yyyy-mm-dd date' }),
  );
