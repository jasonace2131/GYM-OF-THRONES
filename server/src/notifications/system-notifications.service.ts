import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { NotificationSeverity, Prisma, SystemNotificationKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DomainException } from '../common/exceptions/domain.exception';
import {
  toSystemNotificationView,
  type NotificationCounts,
  type SystemNotificationView,
} from './notification.presenter';

/** What a producer hands in. `severity` defaults to INFO at the database. */
export interface RaiseNotificationInput {
  kind: SystemNotificationKind;
  severity?: NotificationSeverity;
  title: string;
  body?: string | null;
  /** An in-app path such as `/admin/leads`. Never an external URL. */
  linkPath?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
}

/** Title or body containing the search, any case; no filter without one. */
function matching(search: string | undefined): Prisma.SystemNotificationWhereInput {
  const term = search?.trim() ?? '';
  if (term === '') return {};
  return {
    OR: [
      { title: { contains: term, mode: 'insensitive' } },
      { body: { contains: term, mode: 'insensitive' } },
    ],
  };
}

/** The most one request returns. The panel asks for far fewer per page. */
const PAGE_LIMIT = 100;

/**
 * The system-notification half of the Notifications panel (Figure 22, REQ021).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `raise()` NEVER THROWS, AND THAT IS THE WHOLE CONTRACT.
 *
 * Every producer calls it as a side effect of doing something more important:
 * taking an enquiry, running the nightly job. A notification is a courtesy to
 * whoever is at the counter — losing one costs a reminder, while throwing out
 * of a producer would lose the enquiry or abort the job, which is a real
 * failure caused entirely by the reminder about it.
 *
 * This mirrors the discipline `ContactService.submit` already documents for
 * its own email send: store the important thing, then best-effort the notice.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class SystemNotificationsService {
  private readonly logger = new Logger(SystemNotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Raise one. Best-effort: a failure is logged and swallowed.
   *
   * Callers do not await a result they can act on, so the return type is
   * `void` rather than the row — an id nobody can use is an invitation to
   * write code that assumes the write happened.
   */
  async raise(input: RaiseNotificationInput): Promise<void> {
    try {
      await this.prisma.systemNotification.create({
        data: {
          kind: input.kind,
          ...(input.severity === undefined ? {} : { severity: input.severity }),
          title: input.title,
          body: input.body ?? null,
          linkPath: input.linkPath ?? null,
          subjectType: input.subjectType ?? null,
          subjectId: input.subjectId ?? null,
        },
      });
    } catch (caught) {
      this.logger.error(
        `could not raise ${input.kind} notification: ${input.title}`,
        caught instanceof Error ? caught.stack : String(caught),
      );
    }
  }

  /**
   * The panel's list, one page of it.
   *
   * Three views, picked by the flags:
   *   - inbox (default): everything not archived, newest first;
   *   - `unreadOnly`: the inbox, narrowed to what nobody has ticked as seen;
   *   - `archived`: only what somebody archived, most recently archived first.
   * `includeResolved` is the older "everything" view, kept for any caller that
   * still sends it.
   *
   * The page is `skip`/`take` over the index's own order, so nothing sorts in
   * memory. Totals come from `counts()`, which already counts in the database;
   * the list stays a plain array so a console built before pagination keeps
   * working against this API while the two deploy.
   */
  async list(params: {
    unreadOnly?: boolean;
    includeResolved?: boolean;
    archived?: boolean;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<SystemNotificationView[]> {
    const limit = Math.min(Math.max(params.limit ?? PAGE_LIMIT, 1), PAGE_LIMIT);
    const page = Math.max(params.page ?? 1, 1);

    const view: Prisma.SystemNotificationWhereInput =
      params.archived === true
        ? { resolvedAt: { not: null } }
        : {
            ...(params.unreadOnly === true ? { readAt: null } : {}),
            ...(params.includeResolved === true ? {} : { resolvedAt: null }),
          };
    const where: Prisma.SystemNotificationWhereInput = {
      AND: [view, matching(params.search)],
    };

    const rows = await this.prisma.systemNotification.findMany({
      where,
      orderBy:
        params.archived === true
          ? [{ resolvedAt: 'desc' }, { createdAt: 'desc' }]
          : [{ resolvedAt: 'asc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    });

    return rows.map(toSystemNotificationView);
  }

  /**
   * Counted server-side, never inferred from the length of a truncated page.
   *
   * A list capped at 100 that reports "100 unread" when there are 340 is the
   * kind of number staff stop believing, and once they stop believing one
   * number on a screen they stop believing the screen.
   */
  async counts(search?: string): Promise<NotificationCounts> {
    // Narrowed by the same search as the list, so a tab's number is the size
    // of what that tab shows — the pager reads its total from here.
    const and = (
      where: Prisma.SystemNotificationWhereInput,
    ): Prisma.SystemNotificationWhereInput => ({ AND: [where, matching(search)] });
    const [unread, unresolved, archived] = await this.prisma.$transaction([
      this.prisma.systemNotification.count({ where: and({ readAt: null }) }),
      this.prisma.systemNotification.count({ where: and({ resolvedAt: null }) }),
      this.prisma.systemNotification.count({ where: and({ resolvedAt: { not: null } }) }),
    ]);
    return { unread, unresolved, archived };
  }

  /**
   * Mark one read. Idempotent: the FIRST reader is recorded and a second
   * reader does not overwrite them, so "seen" keeps meaning "seen at that
   * moment by that person" rather than "most recently looked at".
   */
  async markRead(id: string, actorId: string, now: Date = new Date()): Promise<SystemNotificationView> {
    const existing = await this.require(id);
    if (existing.readAt !== null) return existing;

    const row = await this.prisma.systemNotification.update({
      where: { id },
      data: { readAt: now, readById: actorId },
    });
    return toSystemNotificationView(row);
  }

  /**
   * Mark one dealt with.
   *
   * Resolving also marks it read if nobody had — acting on something you never
   * ticked as seen is normal, and leaving it "unread but resolved" would keep
   * it in the Unread filter forever. The database allows resolved-without-read
   * precisely so this is a choice made here rather than a shape forced on
   * every producer.
   *
   * Idempotent, like `markRead`: the first resolver keeps the credit.
   */
  async resolve(id: string, actorId: string, now: Date = new Date()): Promise<SystemNotificationView> {
    const existing = await this.require(id);
    if (existing.resolvedAt !== null) return existing;

    const row = await this.prisma.systemNotification.update({
      where: { id },
      data: {
        resolvedAt: now,
        resolvedById: actorId,
        ...(existing.readAt === null ? { readAt: now, readById: actorId } : {}),
      },
    });
    return toSystemNotificationView(row);
  }

  /**
   * Take one back out of the archive. "Archived by mistake" happens at a busy
   * counter.
   *
   * Clears the archive stamp and leaves the read stamp alone: it was seen, and
   * restoring it does not make that untrue. Idempotent: restoring something
   * that is not archived returns it unchanged.
   */
  async restore(id: string): Promise<SystemNotificationView> {
    const existing = await this.require(id);
    if (existing.resolvedAt === null) return existing;

    const row = await this.prisma.systemNotification.update({
      where: { id },
      data: { resolvedAt: null, resolvedById: null },
    });
    return toSystemNotificationView(row);
  }

  /**
   * Mark everything currently unread as read.
   *
   * The one bulk action the panel offers, because "seen" is the only state a
   * person can honestly claim for a whole column at once. There is deliberately
   * no "resolve all": resolving is a claim that the work was done, and nobody
   * rings back forty leads in one click.
   */
  async markAllRead(actorId: string, now: Date = new Date()): Promise<{ changed: number }> {
    const result = await this.prisma.systemNotification.updateMany({
      where: { readAt: null },
      data: { readAt: now, readById: actorId },
    });
    return { changed: result.count };
  }

  private async require(id: string): Promise<SystemNotificationView> {
    const row = await this.prisma.systemNotification.findUnique({ where: { id } });
    if (row === null) {
      throw new DomainException(
        'NOTIFICATION_NOT_FOUND',
        'That notification does not exist.',
        HttpStatus.NOT_FOUND,
      );
    }
    return toSystemNotificationView(row);
  }
}
