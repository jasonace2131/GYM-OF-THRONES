/**
 * The member's announcements watermark — the one rule for "new".
 *
 * A notice is new to a member when it was created AFTER their effective
 * watermark. One timestamp per member (`User.announcementsSeenAt`), no per-item
 * read table: opening the bell moves the watermark to the newest notice the
 * member was shown, and everything at or before it counts as seen.
 *
 * PURE: no clock, no database. The service passes `now` in, so every boundary
 * below is a plain comparison a spec can pin.
 */

/**
 * How far back "new" can reach. A member back after six months is not greeted
 * by every notice posted while they were away — thirty days of news, at most.
 */
export const UNREAD_HORIZON_DAYS = 30;

const DAY_MS = 86_400_000;

export interface WatermarkSubject {
  /** NULL until the member first opens the bell. */
  announcementsSeenAt: Date | null;
  createdAt: Date;
}

/**
 * `max(seenAt ?? createdAt, now − 30 days)`.
 *
 * A NULL watermark reads as the account's creation instant: a brand-new member
 * has seen nothing, but every notice before they joined is history rather than
 * news. Doing this on READ is what lets the column have no default and no
 * backfill, and keeps provisioning — the per-request hot path — free of a
 * write it would otherwise need.
 */
export function effectiveSeenAt(subject: WatermarkSubject, now: Date): Date {
  const stored = subject.announcementsSeenAt ?? subject.createdAt;
  const horizon = now.getTime() - UNREAD_HORIZON_DAYS * DAY_MS;
  return new Date(Math.max(stored.getTime(), horizon));
}

/**
 * `min(upTo, now)`.
 *
 * `upTo` is the createdAt of the newest notice the member was actually shown,
 * so it is in the past. A skewed client clock or a hand-made request carrying
 * 2099 must not pre-mark notices that do not exist yet.
 */
export function clampSeenUpTo(upTo: Date, now: Date): Date {
  return new Date(Math.min(upTo.getTime(), now.getTime()));
}
