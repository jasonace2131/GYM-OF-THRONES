import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DomainException } from '../common/exceptions/domain.exception';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';
import type { AuditService } from '../audit/audit.service';
import type { ScopedWhere } from '../rbac/scope.util';
import { ChatService, type ChatActor } from './chat.service';
import type { RealtimeBroadcastService } from './realtime-broadcast.service';
import type { PartyRow, ThreadRow } from './chat.presenter';

const NOW = new Date('2026-09-25T02:00:00.000Z'); // 10:00 in Manila
const COACH: ChatActor = { id: 'c0000000-0000-4000-8000-000000000001', role: 'COACH' };
const MEMBER: ChatActor = { id: 'm0000000-0000-4000-8000-000000000001', role: 'CLIENT' };
const STRANGER: ChatActor = { id: 's0000000-0000-4000-8000-000000000001', role: 'CLIENT' };
const THREAD_ID = 't0000000-0000-4000-8000-000000000001';
const SECRET = 'SECRET-BODY-9913';

const party = (id: string, overrides: Partial<PartyRow> = {}): PartyRow => ({
  id,
  supabaseId: `auth-${id}`,
  firstName: id === COACH.id ? 'Ana' : 'Ben',
  lastName: 'Cruz',
  avatarUrl: null,
  dateOfBirth: new Date('1995-03-01T00:00:00.000Z'),
  deletedAt: null,
  ...overrides,
});

const thread = (member: Partial<PartyRow> = {}): ThreadRow => ({
  id: THREAD_ID,
  coachId: COACH.id,
  memberId: MEMBER.id,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  lastMessageAt: null,
  coach: party(COACH.id),
  member: party(MEMBER.id, member),
});

const messageRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'msg-1',
  threadId: THREAD_ID,
  senderId: COACH.id,
  body: SECRET,
  createdAt: new Date(NOW.getTime() - 60_000),
  editedAt: null,
  deletedAt: null,
  ...overrides,
});

describe('ChatService', () => {
  let prisma: {
    user: { findUnique: jest.Mock; findFirst: jest.Mock };
    coachAssignment: { findMany: jest.Mock; findFirst: jest.Mock };
    chatThread: {
      createMany: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      upsert: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
    };
    chatMessage: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
    };
    chatReadState: { upsert: jest.Mock };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let realtime: { publish: jest.Mock };
  let service: ChatService;
  let logs: string[];

  const failure = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => {
        throw new Error('expected a failure');
      },
      (caught: unknown) => caught,
    );

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn(), findFirst: jest.fn() },
      coachAssignment: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({ id: 'assignment' }),
      },
      chatThread: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(thread()),
        upsert: jest.fn().mockResolvedValue(thread()),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
      chatMessage: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        create: jest.fn((args: { data: object }) => ({ ...messageRow(), ...args.data })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      chatReadState: { upsert: jest.fn((args: object) => args) },
      $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    realtime = { publish: jest.fn() };
    service = new ChatService(
      prisma as unknown as PrismaService,
      { timeZone: 'Asia/Manila' } as unknown as GymConfigService,
      audit as unknown as AuditService,
      realtime as unknown as RealtimeBroadcastService,
    );
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logs.push(String(args[0]));
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  describe('listThreads', () => {
    it('opens a thread for every ACTIVE pair — but never for a member under 18', async () => {
      prisma.user.findUnique.mockResolvedValue({ dateOfBirth: null });
      prisma.coachAssignment.findMany.mockResolvedValue([
        { coachId: COACH.id, memberId: MEMBER.id, member: { dateOfBirth: null } },
        {
          coachId: COACH.id,
          memberId: 'minor',
          member: { dateOfBirth: new Date('2012-01-01T00:00:00.000Z') },
        },
      ]);

      await service.listThreads(COACH, NOW);

      expect(prisma.chatThread.createMany).toHaveBeenCalledWith({
        data: [{ coachId: COACH.id, memberId: MEMBER.id }],
        skipDuplicates: true,
      });
    });

    it('writes nothing when the caller has no active pair', async () => {
      prisma.user.findUnique.mockResolvedValue({ dateOfBirth: null });
      await service.listThreads(COACH, NOW);
      expect(prisma.chatThread.createMany).not.toHaveBeenCalled();
    });

    it('returns each thread with its other party, last message, unread count and writability', async () => {
      prisma.user.findUnique.mockResolvedValue({ dateOfBirth: null });
      prisma.coachAssignment.findMany.mockResolvedValue([
        { coachId: COACH.id, memberId: MEMBER.id, member: { dateOfBirth: null } },
      ]);
      prisma.chatThread.findMany.mockResolvedValue([thread()]);
      prisma.$queryRaw
        .mockResolvedValueOnce([messageRow()])
        .mockResolvedValueOnce([{ threadId: THREAD_ID, unread: 3 }]);

      const result = await service.listThreads(MEMBER, NOW);

      expect(result.minor).toBe(false);
      expect(result.threads).toHaveLength(1);
      expect(result.threads[0]).toMatchObject({
        id: THREAD_ID,
        role: 'MEMBER',
        coach: { id: COACH.id, firstName: 'Ana', lastName: 'Cruz', avatarUrl: null },
        writable: true,
        readOnlyReason: null,
        unread: 3,
        lastMessage: { id: 'msg-1', body: SECRET },
      });
      // Never the auth id or a date of birth on the wire.
      expect(JSON.stringify(result)).not.toContain('auth-');
      expect(JSON.stringify(result)).not.toContain('1995');
    });

    it('lists an ended pair as read-only history', async () => {
      prisma.user.findUnique.mockResolvedValue({ dateOfBirth: null });
      prisma.chatThread.findMany.mockResolvedValue([thread()]);

      const result = await service.listThreads(MEMBER, NOW);

      expect(result.threads[0]).toMatchObject({
        writable: false,
        readOnlyReason: 'ASSIGNMENT_ENDED',
      });
    });

    it('tells a minor member that chat is closed to them, and lists nothing', async () => {
      prisma.user.findUnique.mockResolvedValue({
        dateOfBirth: new Date('2010-05-05T00:00:00.000Z'),
      });
      prisma.chatThread.findMany.mockResolvedValue([
        thread({ dateOfBirth: new Date('2010-05-05T00:00:00.000Z') }),
      ]);

      const result = await service.listThreads(MEMBER, NOW);

      expect(result).toEqual({ threads: [], minor: true });
    });
  });

  describe('listMessages', () => {
    it('answers 404 to somebody who is not a participant', async () => {
      await expect(service.listMessages(STRANGER, THREAD_ID, {}, NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('answers 404 for an unknown thread', async () => {
      prisma.chatThread.findUnique.mockResolvedValue(null);
      await expect(service.listMessages(COACH, THREAD_ID, {}, NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("refuses a minor's thread with CHAT_MINOR", async () => {
      prisma.chatThread.findUnique.mockResolvedValue(
        thread({ dateOfBirth: new Date('2012-01-01T00:00:00.000Z') }),
      );
      const caught = await failure(service.listMessages(COACH, THREAD_ID, {}, NOW));
      expect(caught).toBeInstanceOf(DomainException);
      expect(caught).toMatchObject({ code: 'CHAT_MINOR' });
      expect((caught as DomainException).getStatus()).toBe(403);
    });

    it('refuses before AND after together', async () => {
      await expect(
        service.listMessages(COACH, THREAD_ID, { before: 'a', after: 'b' }, NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a cursor from another conversation', async () => {
      prisma.chatMessage.findFirst.mockResolvedValue(null);
      await expect(
        service.listMessages(COACH, THREAD_ID, { after: 'elsewhere' }, NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('catches up with everything after the cursor, oldest first, in this thread only', async () => {
      const cursorAt = new Date('2026-09-25T01:00:00.000Z');
      prisma.chatMessage.findFirst.mockResolvedValue({ id: 'msg-0', createdAt: cursorAt });
      prisma.chatMessage.findMany.mockResolvedValue([
        messageRow({ id: 'msg-1' }),
        messageRow({ id: 'msg-2', deletedAt: NOW }),
      ]);

      const page = await service.listMessages(MEMBER, THREAD_ID, { after: 'msg-0' }, NOW);

      const [args] = prisma.chatMessage.findMany.mock.calls[0] as [
        { where: { AND: [{ threadId: string }, unknown] }; orderBy: unknown },
      ];
      expect(args.where.AND[0]).toEqual({ threadId: THREAD_ID });
      expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
      expect(page.messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2']);
      // A withdrawn message is a tombstone for its participants.
      expect(page.messages[1].body).toBeNull();
      expect(page.hasMore).toBe(false);
    });
  });

  describe('send', () => {
    it('saves first, then rings both participants with the echoed client id', async () => {
      const view = await service.send(
        COACH,
        THREAD_ID,
        { body: 'See you at six.', clientId: 'tmp-1' },
        NOW,
      );

      expect(prisma.chatMessage.create).toHaveBeenCalledWith({
        data: { threadId: THREAD_ID, senderId: COACH.id, body: 'See you at six.', createdAt: NOW },
      });
      expect(prisma.chatThread.update).toHaveBeenCalledWith({
        where: { id: THREAD_ID },
        data: { lastMessageAt: NOW },
      });
      expect(prisma.chatReadState.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { lastReadAt: NOW } }),
      );
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      expect(realtime.publish).toHaveBeenCalledTimes(1);
      const [messages] = realtime.publish.mock.calls[0] as [
        Array<{ topic: string; payload: { clientId: string | null; message: { id: string } } }>,
      ];
      expect(messages.map((m) => m.topic)).toEqual([
        `user:auth-${MEMBER.id}`,
        `user:auth-${COACH.id}`,
      ]);
      expect(messages[0].payload.clientId).toBe('tmp-1');
      expect(messages[0].payload.message.id).toBe(view.id);
    });

    it('does not ring when the save fails', async () => {
      prisma.$transaction.mockRejectedValue(new Error('db down'));
      await expect(service.send(COACH, THREAD_ID, { body: 'hi' }, NOW)).rejects.toThrow('db down');
      expect(realtime.publish).not.toHaveBeenCalled();
    });

    it('refuses a read-only thread with CHAT_READ_ONLY (409) and writes nothing', async () => {
      prisma.coachAssignment.findFirst.mockResolvedValue(null);

      const caught = await failure(service.send(MEMBER, THREAD_ID, { body: 'hello?' }, NOW));

      expect(caught).toMatchObject({ code: 'CHAT_READ_ONLY' });
      expect((caught as DomainException).getStatus()).toBe(409);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(realtime.publish).not.toHaveBeenCalled();
    });

    it('never logs a message body', async () => {
      await service.send(COACH, THREAD_ID, { body: SECRET }, NOW);
      expect(logs.join('\n')).not.toContain(SECRET);
    });
  });

  describe('markRead', () => {
    it('moves the read mark to now, even on a read-only thread', async () => {
      prisma.coachAssignment.findFirst.mockResolvedValue(null);

      await expect(service.markRead(MEMBER, THREAD_ID, NOW)).resolves.toEqual({
        threadId: THREAD_ID,
        lastReadAt: NOW.toISOString(),
      });
      expect(prisma.chatReadState.upsert).toHaveBeenCalledWith({
        where: { threadId_userId: { threadId: THREAD_ID, userId: MEMBER.id } },
        create: { threadId: THREAD_ID, userId: MEMBER.id, lastReadAt: NOW },
        update: { lastReadAt: NOW },
      });
    });
  });

  describe('deleteMessage', () => {
    const stored = (overrides: Record<string, unknown> = {}) => ({
      ...messageRow(overrides),
      thread: thread(),
    });

    it("answers 404 for somebody else's message", async () => {
      prisma.chatMessage.findUnique.mockResolvedValue(stored({ senderId: MEMBER.id }));
      await expect(service.deleteMessage(COACH, 'msg-1', NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses after the ten-minute window', async () => {
      prisma.chatMessage.findUnique.mockResolvedValue(
        stored({ createdAt: new Date(NOW.getTime() - 10 * 60_000 - 1) }),
      );
      const caught = await failure(service.deleteMessage(COACH, 'msg-1', NOW));
      expect(caught).toMatchObject({ code: 'CHAT_DELETE_WINDOW_PASSED' });
      expect(prisma.chatMessage.updateMany).not.toHaveBeenCalled();
    });

    it('soft-deletes, audits without the body, and rings a tombstone', async () => {
      prisma.chatMessage.findUnique.mockResolvedValue(stored());
      prisma.chatMessage.findUniqueOrThrow.mockResolvedValue(messageRow({ deletedAt: NOW }));

      const view = await service.deleteMessage(COACH, 'msg-1', NOW);

      expect(prisma.chatMessage.updateMany).toHaveBeenCalledWith({
        where: { id: 'msg-1', deletedAt: null },
        data: { deletedAt: NOW },
      });
      expect(view.body).toBeNull();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CHAT_MESSAGE_DELETED',
          actorId: COACH.id,
          subjectType: 'ChatMessage',
          subjectId: 'msg-1',
          details: { threadId: THREAD_ID },
        }),
      );
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(SECRET);
      const [messages] = realtime.publish.mock.calls[0] as [
        Array<{ payload: { message: { body: string | null } } }>,
      ];
      expect(messages[0].payload.message.body).toBeNull();
    });
  });

  describe('openWithMember', () => {
    const scope = {
      assignedCoach: { some: { coachId: COACH.id, endedAt: null } },
    } as unknown as ScopedWhere<Prisma.UserWhereInput>;

    it('refuses the caller themselves, and anybody outside the scope, with 404', async () => {
      await expect(service.openWithMember(COACH, COACH.id, scope, NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      prisma.user.findFirst.mockResolvedValue(null);
      await expect(service.openWithMember(COACH, MEMBER.id, scope, NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { AND: [{ id: MEMBER.id }, scope] },
        select: { id: true, dateOfBirth: true },
      });
    });

    it('needs an ACTIVE assignment to the caller even when the scope is ALL', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: MEMBER.id, dateOfBirth: null });
      prisma.coachAssignment.findFirst.mockResolvedValue(null);

      await expect(service.openWithMember(COACH, MEMBER.id, scope, NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.chatThread.upsert).not.toHaveBeenCalled();
    });

    it('refuses a minor with CHAT_MINOR and opens nothing', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: MEMBER.id,
        dateOfBirth: new Date('2011-11-11T00:00:00.000Z'),
      });

      const caught = await failure(service.openWithMember(COACH, MEMBER.id, scope, NOW));

      expect(caught).toMatchObject({ code: 'CHAT_MINOR' });
      expect(prisma.chatThread.upsert).not.toHaveBeenCalled();
    });

    it('opens (or gets) the one thread for the pair', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: MEMBER.id, dateOfBirth: null });

      const view = await service.openWithMember(COACH, MEMBER.id, scope, NOW);

      expect(prisma.chatThread.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { coachId_memberId: { coachId: COACH.id, memberId: MEMBER.id } },
          create: { coachId: COACH.id, memberId: MEMBER.id },
          update: {},
        }),
      );
      expect(view).toMatchObject({ id: THREAD_ID, role: 'COACH', writable: true });
    });
  });

  describe('review', () => {
    it('returns every message, withdrawn ones with their text, and audits the read with its reason', async () => {
      prisma.chatThread.findUnique.mockResolvedValue({
        ...thread(),
        coach: { id: COACH.id, firstName: 'Ana', lastName: 'Cruz' },
        member: { id: MEMBER.id, firstName: 'Ben', lastName: 'Cruz' },
        _count: { messages: 2 },
      });
      prisma.chatMessage.findMany.mockResolvedValue([
        messageRow({ id: 'a' }),
        messageRow({ id: 'b', deletedAt: NOW }),
      ]);
      const admin: ChatActor = { id: 'admin', role: 'ADMIN' };

      const result = await service.review(admin, THREAD_ID, 'Member complaint #12');

      expect(result.messages.map((m) => [m.id, m.body])).toEqual([
        ['a', SECRET],
        ['b', SECRET],
      ]);
      expect(result.messages[1].deletedAt).toBe(NOW.toISOString());
      expect(audit.record).toHaveBeenCalledWith({
        action: 'CHAT_THREAD_REVIEWED',
        actorId: 'admin',
        actorRole: 'ADMIN',
        subjectType: 'ChatThread',
        subjectId: THREAD_ID,
        subjectLabel: 'Ana Cruz ↔ Ben Cruz',
        reason: 'Member complaint #12',
        details: { messageCount: 2 },
      });
    });

    it('answers 404 for an unknown thread and audits nothing', async () => {
      prisma.chatThread.findUnique.mockResolvedValue(null);
      await expect(
        service.review({ id: 'admin', role: 'ADMIN' }, THREAD_ID, 'complaint'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
