import { Injectable, Logger } from '@nestjs/common';
import type { MemberNoticeKind, Prisma } from '@prisma/client';
import type { MemberNoticeFeedWire, MemberNoticesSeenWire } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { paginated, paginationSkipTake } from '../common/dto/paginate';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { clampSeenUpTo } from '../announcements/announcement-watermark';
import {
  MEMBER_NOTICE_ORDER,
  MEMBER_NOTICE_SELECT,
  toMemberNotice,
} from './member-notice.presenter';

/** What a producer hands in: one notice, for one member. */
export interface MemberNoticeInput {
  userId: string;
  kind: MemberNoticeKind;
  /**
   * One finished line in gym time, e.g. "You're in: Spin, Wed 14 Oct 6:00 pm".
   * Trimmed, and cut to 120 characters with an ellipsis if longer.
   */
  title: string;
  /** Optional detail — the reason staff gave, or what changed. Cut to 1000. */
  body?: string | null;
  /** An in-app path such as `/portal/book?date=2026-10-14`. Never a URL. */
  linkPath?: string | null;
  /** `ClassBooking` or `ClassSession`, together with its id — or neither. */
  subjectType?: string | null;
  subjectId?: string | null;
  /**
   * Unique across the table, e.g. `CLASS_CANCELLED:<sessionId>:<userId>`: a
   * retried request or a double-submitted edit notifies once, because the
   * second write skips the row the first one made.
   */
  dedupeKey?: string | null;
}

/** The CHECK bounds (`MemberNotice_title_sane` / `_body_sane`), in characters, after trimming. */
const TITLE_MAX = 120;
const BODY_MAX = 1000;

/** Every id this app mints is a canonical UUID; anything else fails the uuid column. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Trimmed, then cut to `max` characters with an ellipsis if it was longer.
 *
 * Counted in code points, which is what `char_length` counts: `String.length`
 * counts UTF-16 units, so cutting by it could split an emoji in half. `trim()`
 * removes every space, tab and line break `btrim(x, ' \t\r\n')` would (and
 * more), so the length measured here is the length the CHECK measures.
 *
 * The ellipsis says the line was cut. Without it, a title that ends in a time
 * could arrive reading "6:0" — a wrong time rather than a short one.
 */
function fit(text: string, max: number): string {
  const trimmed = text.trim();
  const chars = Array.from(trimmed);
  if (chars.length <= max) return trimmed;
  const kept = chars.slice(0, max - 1).join('');
  return `${kept.trimEnd()}…`;
}

/**
 * `MemberNotice_link_is_internal`, mirrored: a path inside the app — not an
 * absolute URL, not protocol-relative (`//evil.example`), and no backslash,
 * which browsers normalise into one (`/\evil.example`).
 */
function internalPath(path: string | null | undefined): string | null {
  if (path === null || path === undefined) return null;
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') ? path : null;
}

/**
 * Fits one input to the table, or names why it cannot be written at all.
 *
 * The whole batch travels in ONE INSERT, and Postgres refuses a statement as a
 * whole: one row that broke a CHECK would cost every member in the batch their
 * notice — thirty people not told their class was called off, because one
 * line was blank. So every rule the database would enforce is applied here
 * first, row by row. What can be repaired is: a link that is not an in-app
 * path, or half a subject, is left off and the notice still goes. What cannot
 * — no title, no real recipient — drops that one row and nothing else.
 */
function toRow(input: MemberNoticeInput): Prisma.MemberNoticeCreateManyInput | string {
  if (!UUID_SHAPE.test(input.userId)) return 'its recipient is not a user id';

  const title = fit(input.title, TITLE_MAX);
  if (title === '') return 'its title is blank';

  const body = fit(input.body ?? '', BODY_MAX);
  const subjectType = input.subjectType ?? null;
  const subjectId = input.subjectId ?? null;
  const hasSubject = subjectType !== null && subjectId !== null && UUID_SHAPE.test(subjectId);

  return {
    userId: input.userId,
    kind: input.kind,
    title,
    // A blank body is no body: the CHECK refuses '' and '   ', not NULL.
    body: body === '' ? null : body,
    linkPath: internalPath(input.linkPath),
    subjectType: hasSubject ? subjectType : null,
    subjectId: hasSubject ? subjectId : null,
    dedupeKey: input.dedupeKey ?? null,
  };
}

/**
 * A member's own notices — the personal half of the portal bell.
 *
 * Announcements are one board every member reads; these are written TO one
 * member about something that happened to them: a waitlist place that became
 * a seat, a class called off or moved, a booking the desk made or removed.
 * In-app only — the bell — with no email and no SMS: a default chosen with the
 * class-booking fixes (2026-10-11). A later channel would send the same stored
 * title and body from here, so no producer would need to change.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `notify()` NEVER THROWS, AND THAT IS THE WHOLE CONTRACT.
 *
 * Every producer calls it AFTER its own change has committed — never inside the
 * transaction — as a courtesy about something more important: a seat, a
 * cancellation, a removal. A notice that failed to send costs the member a
 * line in their bell; throwing out of the producer would turn a committed
 * booking into an error response, and the member or the desk would retry a
 * write that already happened. Same discipline as
 * `SystemNotificationsService.raise`: store the important thing, then
 * best-effort the notice.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class MemberNoticesService {
  private readonly logger = new Logger(MemberNoticesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Write a batch of notices in ONE createMany. Best-effort: a failure is
   * logged and swallowed, and the return type is `void` so nobody can write
   * code that assumes the write happened.
   *
   * `skipDuplicates` is what makes a dedupe key work: a notice whose key is
   * already in the table — a retried request, two clicks on Save, two
   * concurrent cancels of one class — is skipped rather than refused, and the
   * rest of the batch still lands. That is the shape CLAUDE.md prescribes over
   * catching a unique violation, which inside a transaction ends in 25P02.
   */
  async notify(inputs: readonly MemberNoticeInput[]): Promise<void> {
    try {
      const data: Prisma.MemberNoticeCreateManyInput[] = [];
      for (const input of inputs) {
        const row = toRow(input);
        if (typeof row === 'string') {
          this.logger.warn(`dropped a ${input.kind} notice: ${row}`);
        } else {
          data.push(row);
        }
      }
      // Nothing to say — no round trip. A class with nobody booked is the
      // common case for a cancellation's fan-out.
      if (data.length === 0) return;

      await this.prisma.memberNotice.createMany({ data, skipDuplicates: true });
    } catch (caught) {
      const kinds = [...new Set(inputs.map((input) => input.kind))].join(', ');
      this.logger.error(
        `could not write ${inputs.length} member notice(s) (${kinds})`,
        caught instanceof Error ? caught.stack : String(caught),
      );
    }
  }

  /**
   * One page of the member's own notices, newest first.
   *
   * ONE transaction for the page, the total and the unread count, so the
   * badge's number and the dots on the rows are read from the same snapshot.
   * Nothing here reads the clock: whether a row is new is its own `readAt`.
   */
  async feed(userId: string, query: PaginationQueryDto): Promise<MemberNoticeFeedWire> {
    const [rows, total, unreadCount] = await this.prisma.$transaction([
      this.prisma.memberNotice.findMany({
        where: { userId },
        select: MEMBER_NOTICE_SELECT,
        orderBy: MEMBER_NOTICE_ORDER,
        ...paginationSkipTake(query),
      }),
      this.prisma.memberNotice.count({ where: { userId } }),
      this.prisma.memberNotice.count({ where: { userId, readAt: null } }),
    ]);

    return { ...paginated(rows.map(toMemberNotice), total, query), unreadCount };
  }

  /**
   * The bell opened: stamp `now` on the caller's unread notices up to `upTo`.
   *
   * `upTo` is the createdAt of the newest notice the member was SHOWN, so a
   * notice written after the bell's GET stays lit. It is clamped to `now` with
   * the announcement bell's own rule, so a skewed or hand-made 2099 cannot
   * reach past the present.
   *
   * MONOTONIC by construction, in one guarded UPDATE: only rows still unread
   * are touched, so a second tab, a replay or an older mark can neither re-
   * stamp a notice already read nor un-read one. The recount comes after the
   * write, so the caller hears about whatever else landed meanwhile.
   */
  async markSeen(
    userId: string,
    upTo: Date,
    now: Date = new Date(),
  ): Promise<MemberNoticesSeenWire> {
    await this.prisma.memberNotice.updateMany({
      where: { userId, readAt: null, createdAt: { lte: clampSeenUpTo(upTo, now) } },
      data: { readAt: now },
    });

    const unreadCount = await this.prisma.memberNotice.count({ where: { userId, readAt: null } });
    return { unreadCount };
  }
}
