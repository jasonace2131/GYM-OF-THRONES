import { BadRequestException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  CHAT_DELETE_WINDOW_MINUTES,
  type ChatMessagePage,
  type ChatMessageView,
  type ChatThreadList,
  type ChatThreadView,
  type PaginatedData,
} from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { AuditService } from '../audit/audit.service';
import { DomainException } from '../common/exceptions/domain.exception';
import { paginated, paginationSkipTake } from '../common/dto/paginate';
import { civilDateFromPrisma, gymToday, type CivilDate } from '../common/time/gym-time';
import type { AuthUser } from '../auth/auth.types';
import type { ScopedWhere } from '../rbac/scope.util';
import { isMinor, threadAccess, type ThreadAccess, type ThreadFacts } from './chat-access';
import { chatBroadcastMessages } from './chat-broadcast';
import { clampLimit, pageQuery, shapePage, type PageDirection } from './chat-page';
import {
  CHAT_THREAD_INCLUDE,
  fullName,
  toMessageView,
  toParty,
  toReviewMessage,
  type MessageRow,
  type ReviewMessageView,
  type ThreadRow,
} from './chat.presenter';
import { RealtimeBroadcastService } from './realtime-broadcast.service';
import type {
  ListChatMessagesQueryDto,
  ListReviewThreadsQueryDto,
  SendChatMessageDto,
} from './dto/chat.dto';

/** The two facts about the caller chat may use. `role` only for audit rows. */
export type ChatActor = Pick<AuthUser, 'id' | 'role'>;

type MemberScope = ScopedWhere<Prisma.UserWhereInput>;

/** An inbox longer than this is not an inbox. A coach's caseload is far smaller. */
const THREAD_LIMIT = 200;

/** A review reads the whole conversation, bounded. */
const REVIEW_MESSAGE_LIMIT = 2_000;

const DELETE_WINDOW_MS = CHAT_DELETE_WINDOW_MINUTES * 60_000;

export interface ReviewThreadRow {
  id: string;
  coach: { id: string; firstName: string; lastName: string };
  member: { id: string; firstName: string; lastName: string };
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface ThreadReview {
  thread: ReviewThreadRow;
  messages: ReviewMessageView[];
}

const notFound = (): NotFoundException => new NotFoundException('Conversation not found');

const minorRefusal = (): DomainException =>
  new DomainException(
    'CHAT_MINOR',
    'Coach chat is not available for members under 18. Speak to your coach at the gym, or ask at the front desk.',
    HttpStatus.FORBIDDEN,
  );

const readOnlyRefusal = (): DomainException =>
  new DomainException(
    'CHAT_READ_ONLY',
    'This coaching has ended, so the conversation is read-only.',
    HttpStatus.CONFLICT,
  );

/**
 * Coach <-> member chat.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SAVE FIRST, THEN RING THE DOORBELL.
 *
 * A message is committed to Postgres — with the thread's `lastMessageAt` and
 * the sender's own read mark, in one transaction — and only then pushed over
 * Supabase Realtime, fire-and-forget. A failed push never fails the send; the
 * other side's client catches up through the API.
 *
 * WHO: `threadAccess` (./chat-access) and nothing else — participants only,
 * writable only while the pair's assignment is ACTIVE, never for a minor.
 * Every miss a caller is not entitled to learn about is one 404.
 *
 * LOGGING: none of a message. Bodies are personal data.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeBroadcastService,
  ) {}

  // ── The inbox ───────────────────────────────────────────────────────────

  /**
   * The caller's threads, each with the other party, the last message and an
   * unread count.
   *
   * A THREAD OPENS WHEN A COACH IS ASSIGNED — lazily, here. Any ACTIVE pair
   * the caller is part of that has no thread yet gets one (one idempotent
   * `INSERT … ON CONFLICT DO NOTHING`), so a member reaches their coach's
   * thread from this list without the coach having written first, and no
   * back-fill of existing assignments is needed. Pairs whose member is under
   * 18 get none.
   */
  async listThreads(user: ChatActor, now: Date = new Date()): Promise<ChatThreadList> {
    const today = this.today(now);

    const [caller, activePairs] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: user.id }, select: { dateOfBirth: true } }),
      this.prisma.coachAssignment.findMany({
        where: {
          endedAt: null,
          OR: [{ coachId: user.id }, { memberId: user.id }],
          coach: { deletedAt: null },
          member: { deletedAt: null },
        },
        select: { coachId: true, memberId: true, member: { select: { dateOfBirth: true } } },
      }),
    ]);

    const openable = activePairs.filter(
      (pair) => !isMinor(this.civil(pair.member.dateOfBirth), today),
    );
    if (openable.length > 0) {
      await this.prisma.chatThread.createMany({
        data: openable.map((pair) => ({ coachId: pair.coachId, memberId: pair.memberId })),
        skipDuplicates: true,
      });
    }

    const threads = (await this.prisma.chatThread.findMany({
      where: { OR: [{ coachId: user.id }, { memberId: user.id }] },
      include: CHAT_THREAD_INCLUDE,
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: THREAD_LIMIT,
    })) as ThreadRow[];

    const active = new Set(activePairs.map((pair) => pairKey(pair.coachId, pair.memberId)));
    const views = await this.views(user.id, threads, active, today);

    return { threads: views, minor: isMinor(this.civil(caller?.dateOfBirth ?? null), today) };
  }

  /**
   * A coach opens — or gets — the thread with a member they actively coach.
   * `coachedMember` scope: an ACTIVE assignment to the caller, no self branch.
   */
  async openWithMember(
    user: ChatActor,
    memberId: string,
    scope: MemberScope,
    now: Date = new Date(),
  ): Promise<ChatThreadView> {
    if (memberId === user.id) throw notFound();

    const member = await this.prisma.user.findFirst({
      // ANDed, never spread: a spread would clobber the scope's own keys.
      where: { AND: [{ id: memberId }, scope] },
      select: { id: true, dateOfBirth: true },
    });
    if (member === null) throw notFound();

    // The scope already says this at OWN. At ALL (DEV's bypass) it does not,
    // and a thread is between a member and THEIR coach — so it is asked here.
    if (!(await this.isActivePair(user.id, member.id))) throw notFound();

    const today = this.today(now);
    if (isMinor(this.civil(member.dateOfBirth), today)) throw minorRefusal();

    const thread: ThreadRow = await this.prisma.chatThread.upsert({
      where: { coachId_memberId: { coachId: user.id, memberId: member.id } },
      create: { coachId: user.id, memberId: member.id },
      update: {},
      include: CHAT_THREAD_INCLUDE,
    });

    const [view] = await this.views(
      user.id,
      [thread],
      new Set([pairKey(user.id, member.id)]),
      today,
    );
    if (view === undefined) throw notFound();
    return view;
  }

  // ── One thread ──────────────────────────────────────────────────────────

  async listMessages(
    user: ChatActor,
    threadId: string,
    query: ListChatMessagesQueryDto,
    now: Date = new Date(),
  ): Promise<ChatMessagePage> {
    if (query.before !== undefined && query.after !== undefined) {
      throw new BadRequestException('Pass before or after, not both');
    }
    await this.participantThread(user.id, threadId, now);

    const direction: PageDirection =
      query.after !== undefined ? 'after' : query.before !== undefined ? 'before' : 'latest';
    const cursorId = query.after ?? query.before;

    let cursor: { id: string; createdAt: Date } | null = null;
    if (cursorId !== undefined) {
      cursor = await this.prisma.chatMessage.findFirst({
        where: { id: cursorId, threadId },
        select: { id: true, createdAt: true },
      });
      if (cursor === null)
        throw new BadRequestException('That message is not in this conversation');
    }

    const limit = clampLimit(query.limit);
    const q = pageQuery(direction, cursor, limit);
    const rows = (await this.prisma.chatMessage.findMany({
      where: { AND: [{ threadId }, q.where as Prisma.ChatMessageWhereInput] },
      orderBy: q.orderBy,
      take: q.take,
    })) as MessageRow[];

    const page = shapePage(rows, direction, limit);
    return { messages: page.rows.map(toMessageView), hasMore: page.hasMore };
  }

  /**
   * Save, then broadcast. Throttled per user at the controller.
   */
  async send(
    user: ChatActor,
    threadId: string,
    dto: SendChatMessageDto,
    now: Date = new Date(),
  ): Promise<ChatMessageView> {
    const { thread, access } = await this.participantThread(user.id, threadId, now);
    if (!access.writable) throw readOnlyRefusal();

    // One transaction: the message, the thread's sort key, and the sender's
    // own read mark (you have read what you just wrote). `createdAt` is set
    // explicitly so all three carry the same instant.
    const [message] = await this.prisma.$transaction([
      this.prisma.chatMessage.create({
        data: { threadId, senderId: user.id, body: dto.body, createdAt: now },
      }),
      this.prisma.chatThread.update({ where: { id: threadId }, data: { lastMessageAt: now } }),
      this.prisma.chatReadState.upsert({
        where: { threadId_userId: { threadId, userId: user.id } },
        create: { threadId, userId: user.id, lastReadAt: now },
        update: { lastReadAt: now },
      }),
    ]);

    const view = toMessageView(message);
    // AFTER the commit, and never awaited: see RealtimeBroadcastService.
    this.ring(thread, view, dto.clientId ?? null);
    return view;
  }

  /** Mark everything up to now read. Allowed on a read-only thread too. */
  async markRead(
    user: ChatActor,
    threadId: string,
    now: Date = new Date(),
  ): Promise<{ threadId: string; lastReadAt: string }> {
    await this.participantThread(user.id, threadId, now);
    await this.prisma.chatReadState.upsert({
      where: { threadId_userId: { threadId, userId: user.id } },
      create: { threadId, userId: user.id, lastReadAt: now },
      update: { lastReadAt: now },
    });
    return { threadId, lastReadAt: now.toISOString() };
  }

  /**
   * The sender withdraws their own message, inside ten minutes, while the
   * thread is still writable. A soft delete, audited, and broadcast as a
   * tombstone so the other side's screen drops the text too.
   */
  async deleteMessage(
    user: ChatActor,
    messageId: string,
    now: Date = new Date(),
  ): Promise<ChatMessageView> {
    const message = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      include: { thread: { include: CHAT_THREAD_INCLUDE } },
    });
    // Somebody else's message is as unknown as a missing one.
    if (message === null || message.senderId !== user.id) {
      throw new NotFoundException('Message not found');
    }

    const thread: ThreadRow = message.thread;
    const access = await this.accessTo(user.id, thread, now);
    if (access.kind === 'none') throw new NotFoundException('Message not found');
    if (access.kind === 'minor') throw minorRefusal();
    if (!access.writable) throw readOnlyRefusal();

    if (message.deletedAt !== null) return toMessageView(message);

    if (now.getTime() - message.createdAt.getTime() > DELETE_WINDOW_MS) {
      throw new DomainException(
        'CHAT_DELETE_WINDOW_PASSED',
        `A message can be removed only within ${CHAT_DELETE_WINDOW_MINUTES} minutes of sending it.`,
        HttpStatus.CONFLICT,
      );
    }

    // Guarded: a double-tap deletes once.
    await this.prisma.chatMessage.updateMany({
      where: { id: message.id, deletedAt: null },
      data: { deletedAt: now },
    });
    const updated = await this.prisma.chatMessage.findUniqueOrThrow({ where: { id: message.id } });

    await this.audit.record({
      action: 'CHAT_MESSAGE_DELETED',
      actorId: user.id,
      actorRole: user.role,
      subjectType: 'ChatMessage',
      subjectId: message.id,
      subjectLabel: `${fullName(thread.coach)} ↔ ${fullName(thread.member)}`,
      // Never the body: the log says a message went, not what it said.
      details: { threadId: thread.id },
    });

    const view = toMessageView(updated);
    this.ring(thread, view, null);
    return view;
  }

  // ── Complaint review (chat.review, ADMIN at ALL) ────────────────────────

  /**
   * Who has talked to whom — names, counts and times. No message text, so
   * listing is not itself a review and is not audited; reading one is.
   */
  async listForReview(query: ListReviewThreadsQueryDto): Promise<PaginatedData<ReviewThreadRow>> {
    const where: Prisma.ChatThreadWhereInput = {
      ...(query.memberId === undefined ? {} : { memberId: query.memberId }),
      ...(query.coachId === undefined ? {} : { coachId: query.coachId }),
      // Only threads anybody actually wrote in.
      lastMessageAt: { not: null },
    };

    const [rows, total] = await Promise.all([
      this.prisma.chatThread.findMany({
        where,
        include: {
          coach: { select: { id: true, firstName: true, lastName: true } },
          member: { select: { id: true, firstName: true, lastName: true } },
          _count: { select: { messages: true } },
        },
        orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        ...paginationSkipTake(query),
      }),
      this.prisma.chatThread.count({ where }),
    ]);

    return paginated(
      rows.map((row) => ({
        id: row.id,
        coach: row.coach,
        member: row.member,
        messageCount: row._count.messages,
        lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      total,
      query,
    );
  }

  /**
   * The whole conversation — withdrawn messages included, with their text,
   * because that is what a complaint may turn on. AUDITED, every time, with
   * the reason the admin gave.
   */
  async review(actor: ChatActor, threadId: string, reason: string): Promise<ThreadReview> {
    const thread = await this.prisma.chatThread.findUnique({
      where: { id: threadId },
      include: {
        coach: { select: { id: true, firstName: true, lastName: true } },
        member: { select: { id: true, firstName: true, lastName: true } },
        _count: { select: { messages: true } },
      },
    });
    if (thread === null) throw notFound();

    const messages = (await this.prisma.chatMessage.findMany({
      where: { threadId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: REVIEW_MESSAGE_LIMIT,
    })) as MessageRow[];

    await this.audit.record({
      action: 'CHAT_THREAD_REVIEWED',
      actorId: actor.id,
      actorRole: actor.role,
      subjectType: 'ChatThread',
      subjectId: thread.id,
      subjectLabel: `${fullName(thread.coach)} ↔ ${fullName(thread.member)}`,
      reason,
      details: { messageCount: messages.length },
    });

    return {
      thread: {
        id: thread.id,
        coach: thread.coach,
        member: thread.member,
        messageCount: thread._count.messages,
        lastMessageAt: thread.lastMessageAt?.toISOString() ?? null,
        createdAt: thread.createdAt.toISOString(),
      },
      messages: messages.map(toReviewMessage),
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /**
   * The thread, if the caller is a participant who may read it. Not theirs,
   * unknown, or the other party deleted: one 404. A minor's thread: 403.
   */
  private async participantThread(
    userId: string,
    threadId: string,
    now: Date,
  ): Promise<{
    thread: ThreadRow;
    access: Extract<ThreadAccess, { kind: 'participant' }>;
  }> {
    const thread: ThreadRow | null = await this.prisma.chatThread.findUnique({
      where: { id: threadId },
      include: CHAT_THREAD_INCLUDE,
    });
    if (thread === null) throw notFound();

    const access = await this.accessTo(userId, thread, now);
    if (access.kind === 'none') throw notFound();
    if (access.kind === 'minor') throw minorRefusal();
    return { thread, access };
  }

  private async accessTo(userId: string, thread: ThreadRow, now: Date): Promise<ThreadAccess> {
    // Not a participant: decide before spending a query on the assignment.
    if (userId !== thread.coachId && userId !== thread.memberId) return { kind: 'none' };
    const active = await this.isActivePair(thread.coachId, thread.memberId);
    return threadAccess(this.facts(thread, active), userId, this.today(now));
  }

  private facts(thread: ThreadRow, activeAssignment: boolean): ThreadFacts {
    return {
      coachId: thread.coachId,
      memberId: thread.memberId,
      memberDateOfBirth: this.civil(thread.member.dateOfBirth),
      coachDeleted: thread.coach.deletedAt !== null,
      memberDeleted: thread.member.deletedAt !== null,
      activeAssignment,
    };
  }

  /** The `endedAt: null` sentinel is what ACTIVE means everywhere in RBAC. */
  private async isActivePair(coachId: string, memberId: string): Promise<boolean> {
    const row = await this.prisma.coachAssignment.findFirst({
      where: { coachId, memberId, endedAt: null },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * Thread rows → views, with the last message and the caller's unread count
   * read in two set-based queries rather than two per thread.
   */
  private async views(
    userId: string,
    threads: ThreadRow[],
    activePairs: ReadonlySet<string>,
    today: CivilDate,
  ): Promise<ChatThreadView[]> {
    const usable = threads
      .map((thread) => ({
        thread,
        access: threadAccess(
          this.facts(thread, activePairs.has(pairKey(thread.coachId, thread.memberId))),
          userId,
          today,
        ),
      }))
      .filter(
        (
          entry,
        ): entry is {
          thread: ThreadRow;
          access: Extract<ThreadAccess, { kind: 'participant' }>;
        } => entry.access.kind === 'participant',
      );
    if (usable.length === 0) return [];

    const ids = usable.map((entry) => entry.thread.id);
    const [lastRows, unreadRows] = await Promise.all([
      this.prisma.$queryRaw<MessageRow[]>`
        SELECT DISTINCT ON ("threadId")
               "id", "threadId", "senderId", "body", "createdAt", "editedAt", "deletedAt"
          FROM "ChatMessage"
         WHERE "threadId" = ANY(${ids}::uuid[])
         ORDER BY "threadId", "createdAt" DESC, "id" DESC`,
      this.prisma.$queryRaw<Array<{ threadId: string; unread: number }>>`
        SELECT m."threadId" AS "threadId", count(*)::int AS "unread"
          FROM "ChatMessage" m
          LEFT JOIN "ChatReadState" r
            ON r."threadId" = m."threadId" AND r."userId" = ${userId}::uuid
         WHERE m."threadId" = ANY(${ids}::uuid[])
           AND m."senderId" <> ${userId}::uuid
           AND m."deletedAt" IS NULL
           AND (r."lastReadAt" IS NULL OR m."createdAt" > r."lastReadAt")
         GROUP BY m."threadId"`,
    ]);

    const lastBy = new Map(lastRows.map((row) => [row.threadId, row]));
    const unreadBy = new Map(unreadRows.map((row) => [row.threadId, Number(row.unread)]));

    return usable.map(({ thread, access }) => {
      const last = lastBy.get(thread.id);
      return {
        id: thread.id,
        role: access.role,
        coach: toParty(thread.coach),
        member: toParty(thread.member),
        writable: access.writable,
        readOnlyReason: access.readOnlyReason,
        lastMessage: last === undefined ? null : toMessageView(last),
        lastMessageAt: thread.lastMessageAt?.toISOString() ?? null,
        unread: unreadBy.get(thread.id) ?? 0,
        createdAt: thread.createdAt.toISOString(),
      };
    });
  }

  /** Push to both participants' private channels. Fire-and-forget. */
  private ring(thread: ThreadRow, message: ChatMessageView, clientId: string | null): void {
    this.realtime.publish(
      chatBroadcastMessages([thread.member.supabaseId, thread.coach.supabaseId], {
        threadId: thread.id,
        message,
        clientId,
      }),
    );
  }

  private today(now: Date): CivilDate {
    return gymToday(now, this.gym.timeZone);
  }

  private civil(date: Date | null): CivilDate | null {
    return date === null ? null : civilDateFromPrisma(date);
  }
}

function pairKey(coachId: string, memberId: string): string {
  return `${coachId}:${memberId}`;
}
