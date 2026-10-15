import { Injectable } from '@nestjs/common';
import type { AnnouncementsSeen, MemberAnnouncementFeed } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { paginated, paginationSkipTake } from '../common/dto/paginate';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { AUTHOR_SELECT, MEMBER_FEED_ORDER, toMemberAnnouncement } from './announcement.presenter';
import { clampSeenUpTo, effectiveSeenAt } from './announcement-watermark';

/** How many pinned notices travel with every page of the feed. */
export const PINNED_MAX = 5;

/**
 * The member's own view of the noticeboard: the same notices everyone reads,
 * plus what is NEW to this member.
 *
 * "New" is a watermark, not a read table — one timestamp per member
 * (`User.announcementsSeenAt`), moved only by opening the bell. Reading a
 * notice on the dashboard deliberately does not move it (owner decision): the
 * bell is the inbox, and the dashboard is the reading room.
 */
@Injectable()
export class MemberAnnouncementsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One read of the member, then ONE transaction for the page, the total, the
   * pinned strip and the unread count — so the count on the badge and the dots
   * on the rows are computed against the same snapshot of the board.
   */
  async feed(
    userId: string,
    query: PaginationQueryDto,
    now: Date,
  ): Promise<MemberAnnouncementFeed> {
    const floor = await this.floorFor(userId, now);

    const [rows, total, pinned, unreadCount] = await this.prisma.$transaction([
      this.prisma.announcement.findMany({
        include: { author: AUTHOR_SELECT },
        orderBy: MEMBER_FEED_ORDER,
        ...paginationSkipTake(query),
      }),
      this.prisma.announcement.count(),
      this.prisma.announcement.findMany({
        where: { isPinned: true },
        include: { author: AUTHOR_SELECT },
        orderBy: MEMBER_FEED_ORDER,
        take: PINNED_MAX,
      }),
      this.prisma.announcement.count({ where: { createdAt: { gt: floor } } }),
    ]);

    return {
      ...paginated(
        rows.map((row) => toMemberAnnouncement(row, floor)),
        total,
        query,
      ),
      pinned: pinned.map((row) => toMemberAnnouncement(row, floor)),
      unreadCount,
    };
  }

  /**
   * Moves the watermark to `upTo` — forwards only.
   *
   * The guard is in the WHERE of a single UPDATE rather than a read-then-write,
   * so two tabs opening the bell at once cannot interleave and drag it back.
   * Two branches, because the EFFECTIVE watermark of a member who never opened
   * the bell is their createdAt: writing a mark older than that would rewind
   * it and re-light notices from before they joined.
   *
   * The re-read comes after the write, so a concurrent newer mark is what the
   * caller is told about, not the one this request lost to.
   */
  async markSeen(userId: string, upTo: Date, now: Date): Promise<AnnouncementsSeen> {
    const mark = clampSeenUpTo(upTo, now);

    await this.prisma.user.updateMany({
      where: {
        id: userId,
        OR: [
          { announcementsSeenAt: null, createdAt: { lt: mark } },
          { announcementsSeenAt: { lt: mark } },
        ],
      },
      data: { announcementsSeenAt: mark },
    });

    const floor = await this.floorFor(userId, now);
    const unreadCount = await this.prisma.announcement.count({
      where: { createdAt: { gt: floor } },
    });

    return { seenAt: floor.toISOString(), unreadCount };
  }

  private async floorFor(userId: string, now: Date): Promise<Date> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { announcementsSeenAt: true, createdAt: true },
    });
    return effectiveSeenAt(user, now);
  }
}
