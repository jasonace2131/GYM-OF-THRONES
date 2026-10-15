import { IsISO8601, Matches } from 'class-validator';

/**
 * An instant with a time and a zone — the shape `toISOString()` writes, which
 * is the shape of every `createdAt` the feed sends.
 *
 * `@IsISO8601` alone is not enough for a value that becomes `new Date(upTo)`:
 * it also passes week dates (`2026-W40`), ordinal dates (`2026-283`) and the
 * basic format (`20261011T031500Z`), none of which `new Date()` can read — and
 * an Invalid Date reaching the query is a 500 with a stack trace in the log
 * for what is plainly a bad request. Every string that passes both checks is
 * one `Date` parses.
 */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * `POST /me/notices/seen`.
 *
 * `upTo` is the createdAt of the NEWEST NOTICE THE MEMBER WAS ACTUALLY SHOWN —
 * never "now". Using now would mark as seen anything written between the
 * bell's GET and this POST: a class cancellation the member never laid eyes on
 * would arrive already read. The server still clamps it to now, so a future
 * value cannot reach past the present.
 *
 * `strict` rejects calendar-impossible dates ('2026-02-30'), which the loose
 * form lets through and `new Date()` would silently roll into March.
 *
 * There is no user field, and there must never be one: the notices are the
 * caller's, from the token. `forbidNonWhitelisted` makes a body that names
 * somebody a 400 rather than a silently ignored key.
 */
export class MarkNoticesSeenDto {
  @IsISO8601({ strict: true })
  @Matches(INSTANT, { message: '$property must be an instant such as 2026-10-11T03:15:00.000Z' })
  upTo!: string;
}
