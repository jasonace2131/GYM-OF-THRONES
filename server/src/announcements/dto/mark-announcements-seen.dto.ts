import { IsISO8601 } from 'class-validator';

/**
 * `POST /me/announcements/seen`.
 *
 * `upTo` is the createdAt of the NEWEST NOTICE THE MEMBER WAS ACTUALLY SHOWN —
 * never "now". Using now would silently mark as seen anything posted between
 * the bell's GET and this POST: a notice the member never laid eyes on would
 * arrive already read. The server still clamps it to now
 * (`clampSeenUpTo`), so a future value cannot pre-read tomorrow's notices.
 *
 * `strict` rejects calendar-impossible dates ('2026-02-30'), which the loose
 * form lets through and `new Date()` would silently roll into March.
 */
export class MarkAnnouncementsSeenDto {
  @IsISO8601({ strict: true })
  upTo!: string;
}
