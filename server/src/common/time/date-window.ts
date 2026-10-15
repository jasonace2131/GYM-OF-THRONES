import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../exceptions/domain.exception';
import { asCivilDate, civilDaysBetween, type CivilDate } from './gym-time';

/**
 * A from/to window of gym days, with defaults and a width cap.
 *
 * The DTO only checks shape (yyyy-mm-dd); meaning is checked here, so a 400
 * from the pipe is about what was sent and this one is about what it means.
 * `maxDays` counts the days BETWEEN from and to: from=1st, to=15th is 14.
 */
export function resolveDateWindow(
  params: { from?: string; to?: string },
  defaults: { from: CivilDate; to: CivilDate },
  maxDays: number,
): { from: CivilDate; to: CivilDate } {
  let from: CivilDate;
  let to: CivilDate;
  try {
    from = params.from === undefined ? defaults.from : asCivilDate(params.from);
    to = params.to === undefined ? defaults.to : asCivilDate(params.to);
  } catch {
    throw new DomainException(
      'DATE_RANGE_INVALID',
      'That is not a real calendar date.',
      HttpStatus.BAD_REQUEST,
    );
  }

  const span = civilDaysBetween(from, to);
  if (span < 0) {
    throw new DomainException(
      'DATE_RANGE_INVALID',
      'The start date must be on or before the end date.',
      HttpStatus.BAD_REQUEST,
    );
  }
  if (span > maxDays) {
    throw new DomainException(
      'DATE_RANGE_INVALID',
      `Ask for at most ${maxDays} days at a time.`,
      HttpStatus.BAD_REQUEST,
    );
  }
  return { from, to };
}
