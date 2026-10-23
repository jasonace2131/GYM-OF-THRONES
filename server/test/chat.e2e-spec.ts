import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Server } from 'http';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import { makeActiveMembers } from './support/membership-fixtures';
import { GymConfigService } from '../src/config/gym.config';
import { gymToday } from '../src/common/time/gym-time';
import { RealtimeBroadcastService } from '../src/chat/realtime-broadcast.service';
import type { BroadcastMessage } from '../src/chat/chat-broadcast';

jest.setTimeout(120_000);

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface MessageView {
  id: string;
  threadId: string;
  senderId: string;
  body: string | null;
  createdAt: string;
  deletedAt: string | null;
}

interface ThreadView {
  id: string;
  role: 'COACH' | 'MEMBER';
  coach: { id: string; firstName: string };
  member: { id: string; firstName: string };
  writable: boolean;
  readOnlyReason: string | null;
  lastMessage: MessageView | null;
  unread: number;
}

const MINOR_SUPABASE_ID = '0a000000-0000-4000-8000-0000000c1c01';
const DEV_SUPABASE_ID = '0a000000-0000-4000-8000-0000000dde02';

/**
 * Coach <-> member chat, end to end (feat/coach-tools).
 *
 * One story, top to bottom: COACH_A is assigned CLIENT_A (an adult) and a
 * MINOR; the thread opens itself; messages go both ways, are paged and caught
 * up, read and withdrawn; strangers get 404s, the minor gets nothing; the
 * assignment ends and the thread turns read-only; an admin reviews it, and the
 * review is audited.
 *
 * The Realtime push is STUBBED at `RealtimeBroadcastService.send`: the e2e
 * harness reads the rest of its env from server/.env, and a real service key
 * there must never make this suite push to a live Supabase project. The stub
 * is also the assertion that the push goes to both participants.
 */
describe('coach-member chat (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let pushes: BroadcastMessage[][];

  let adminToken: string;
  let frontDeskToken: string;
  let coachAToken: string;
  let coachBToken: string;
  let clientAToken: string;
  let clientBToken: string;
  let minorToken: string;
  let devToken: string;

  let coachAId: string;
  let clientAId: string;
  let minorId: string;
  let assignmentId: string;
  let threadId: string;

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const api = (path: string): string => `/api/v1${path}`;

  const assign = async (coachId: string, memberId: string): Promise<string> => {
    const res = await request(server)
      .post(api('/coach-assignments'))
      .set(as(adminToken))
      .send({ coachId, memberId })
      .expect(201);
    return (res.body as Envelope<{ id: string }>).data!.id;
  };

  const threadsOf = async (token: string) => {
    const res = await request(server).get(api('/chat/threads')).set(as(token)).expect(200);
    return (res.body as Envelope<{ threads: ThreadView[]; minor: boolean }>).data!;
  };

  const send = (token: string, body: string, clientId?: string) =>
    request(server)
      .post(api(`/chat/threads/${threadId}/messages`))
      .set(as(token))
      .send(clientId === undefined ? { body } : { body, clientId });

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
    await resetDatabase(ctx.prisma);

    pushes = [];
    jest
      .spyOn(ctx.app.get(RealtimeBroadcastService, { strict: false }), 'send')
      .mockImplementation((messages: BroadcastMessage[]) => {
        pushes.push(messages);
        return Promise.resolve(true);
      });

    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    frontDeskToken = await ctx.fixture.tokenFor('FRONT_DESK', {
      supabaseId: FIXTURE_IDS.FRONT_DESK,
    });
    coachAToken = await ctx.fixture.tokenFor('COACH', {
      supabaseId: FIXTURE_IDS.COACH_A,
      firstName: 'Ana',
      lastName: 'Reyes',
    });
    coachBToken = await ctx.fixture.tokenFor('COACH', { supabaseId: FIXTURE_IDS.COACH_B });
    clientAToken = await ctx.fixture.tokenFor('CLIENT', {
      supabaseId: FIXTURE_IDS.CLIENT_A,
      firstName: 'Carla',
      lastName: 'Diaz',
    });
    clientBToken = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_B });
    minorToken = await ctx.fixture.tokenFor('CLIENT', { supabaseId: MINOR_SUPABASE_ID });
    devToken = await ctx.fixture.tokenFor('DEV', { supabaseId: DEV_SUPABASE_ID });

    coachAId = await ctx.fixture.userIdFor(FIXTURE_IDS.COACH_A);
    clientAId = await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_A);
    minorId = await ctx.fixture.userIdFor(MINOR_SUPABASE_ID);

    // A member's send needs an ACTIVE membership (owner, 2026-10-17); a
    // coach's never does. Every member here is active, so each refusal below
    // is the chat's own, not the membership gate's.
    await makeActiveMembers(
      ctx.prisma,
      [clientAId, await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_B), minorId],
      gymToday(new Date(), ctx.app.get(GymConfigService, { strict: false }).timeZone),
    );

    // Owner decision: under 18 by date of birth — no 1:1 chat.
    const fifteenYearsAgo = new Date();
    fifteenYearsAgo.setUTCFullYear(fifteenYearsAgo.getUTCFullYear() - 15);
    await ctx.prisma.user.update({
      where: { id: minorId },
      data: {
        dateOfBirth: new Date(`${fifteenYearsAgo.toISOString().slice(0, 10)}T00:00:00.000Z`),
      },
    });

    assignmentId = await assign(coachAId, clientAId);
    await assign(coachAId, minorId);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await ctx.close();
  });

  it('opens the thread itself: the member finds it without the coach writing first', async () => {
    const mine = await threadsOf(clientAToken);
    expect(mine.minor).toBe(false);
    expect(mine.threads).toHaveLength(1);
    expect(mine.threads[0]).toMatchObject({
      role: 'MEMBER',
      coach: { id: coachAId, firstName: 'Ana' },
      writable: true,
      readOnlyReason: null,
      lastMessage: null,
      unread: 0,
    });
    threadId = mine.threads[0].id;

    // The coach sees the adult's thread — and none for the minor.
    const coach = await threadsOf(coachAToken);
    expect(coach.threads.map((t) => t.member.id)).toEqual([clientAId]);
    expect(await ctx.prisma.chatThread.count({ where: { memberId: minorId } })).toBe(0);
  });

  it('the coach opens the same thread by member — one thread per pair', async () => {
    const res = await request(server)
      .post(api(`/chat/threads/with/${clientAId}`))
      .set(as(coachAToken))
      .expect(201);
    expect((res.body as Envelope<ThreadView>).data!.id).toBe(threadId);
    expect(await ctx.prisma.chatThread.count()).toBe(1);
  });

  it('saves, then pushes to BOTH participants on their auth-id channels', async () => {
    pushes = [];
    const res = await send(coachAToken, '  See you at six.\nBring water.  ', randomUUID());
    expect(res.status).toBe(201);
    const message = (res.body as Envelope<MessageView>).data!;
    // Trimmed at the edges, line breaks kept.
    expect(message.body).toBe('See you at six.\nBring water.');

    expect(pushes).toHaveLength(1);
    expect(pushes[0].map((m) => m.topic).sort()).toEqual(
      [`user:${FIXTURE_IDS.CLIENT_A}`, `user:${FIXTURE_IDS.COACH_A}`].sort(),
    );
    expect(pushes[0].every((m) => m.private && m.event === 'chat.message')).toBe(true);
    expect(pushes[0][0].payload.message.id).toBe(message.id);
  });

  it('counts it unread for the member until they read it', async () => {
    expect((await threadsOf(clientAToken)).threads[0].unread).toBe(1);
    // The sender has read what they wrote.
    expect((await threadsOf(coachAToken)).threads[0].unread).toBe(0);

    await request(server)
      .post(api(`/chat/threads/${threadId}/read`))
      .set(as(clientAToken))
      .expect(201);
    expect((await threadsOf(clientAToken)).threads[0].unread).toBe(0);
  });

  it('pages oldest-first, and catches up with everything after a cursor', async () => {
    const first = (await send(clientAToken, 'Will do!')).body as Envelope<MessageView>;
    await send(coachAToken, 'Great.');

    const latest = await request(server)
      .get(api(`/chat/threads/${threadId}/messages?limit=2`))
      .set(as(clientAToken))
      .expect(200);
    const page = (latest.body as Envelope<{ messages: MessageView[]; hasMore: boolean }>).data!;
    expect(page.messages.map((m) => m.body)).toEqual(['Will do!', 'Great.']);
    expect(page.hasMore).toBe(true);

    const after = await request(server)
      .get(api(`/chat/threads/${threadId}/messages?after=${first.data!.id}`))
      .set(as(coachAToken))
      .expect(200);
    expect(
      (after.body as Envelope<{ messages: MessageView[] }>).data!.messages.map((m) => m.body),
    ).toEqual(['Great.']);
  });

  it('refuses an empty or a 2001-character message', async () => {
    await send(coachAToken, '   ').expect(400);
    await send(coachAToken, 'x'.repeat(2001)).expect(400);
  });

  it('answers 404 to everyone who is not a participant — and to unknown ids', async () => {
    for (const token of [coachBToken, clientBToken]) {
      await request(server)
        .get(api(`/chat/threads/${threadId}/messages`))
        .set(as(token))
        .expect(404);
      await send(token, 'hello?').expect(404);
    }
    await request(server)
      .get(api(`/chat/threads/${randomUUID()}/messages`))
      .set(as(clientAToken))
      .expect(404);
    // A coach cannot open a thread with somebody they do not coach.
    await request(server)
      .post(api(`/chat/threads/with/${clientAId}`))
      .set(as(coachBToken))
      .expect(404);
  });

  it('keeps the desk and admins out of chat.use routes entirely (403)', async () => {
    await request(server).get(api('/chat/threads')).set(as(frontDeskToken)).expect(403);
    await request(server).get(api('/chat/threads')).set(as(adminToken)).expect(403);
  });

  it('gives a member under 18 no chat at all, and refuses the coach with CHAT_MINOR', async () => {
    const minor = await threadsOf(minorToken);
    expect(minor).toEqual({ threads: [], minor: true });

    const res = await request(server)
      .post(api(`/chat/threads/with/${minorId}`))
      .set(as(coachAToken))
      .expect(403);
    expect((res.body as Envelope<never>).error?.code).toBe('CHAT_MINOR');
    expect(await ctx.prisma.chatThread.count({ where: { memberId: minorId } })).toBe(0);
  });

  it('lets the sender withdraw their own message — once, audited, never the body', async () => {
    const sent = (await send(clientAToken, 'Oops, wrong chat')).body as Envelope<MessageView>;
    const id = sent.data!.id;

    // Not theirs to withdraw.
    await request(server)
      .delete(api(`/chat/messages/${id}`))
      .set(as(coachAToken))
      .expect(404);

    pushes = [];
    const res = await request(server)
      .delete(api(`/chat/messages/${id}`))
      .set(as(clientAToken))
      .expect(200);
    expect((res.body as Envelope<MessageView>).data).toMatchObject({ id, body: null });
    expect(pushes[0][0].payload.message.body).toBeNull();

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'CHAT_MESSAGE_DELETED', subjectId: id },
    });
    expect(JSON.stringify(audit)).not.toContain('wrong chat');

    // The row stays, with its text, for a complaint review.
    const row = await ctx.prisma.chatMessage.findUniqueOrThrow({ where: { id } });
    expect(row.body).toBe('Oops, wrong chat');
    expect(row.deletedAt).not.toBeNull();
  });

  it('refuses a withdrawal after ten minutes with CHAT_DELETE_WINDOW_PASSED', async () => {
    const sent = (await send(coachAToken, 'Old news')).body as Envelope<MessageView>;
    await ctx.prisma.chatMessage.update({
      where: { id: sent.data!.id },
      data: { createdAt: new Date(Date.now() - 11 * 60_000) },
    });
    const res = await request(server)
      .delete(api(`/chat/messages/${sent.data!.id}`))
      .set(as(coachAToken))
      .expect(409);
    expect((res.body as Envelope<never>).error?.code).toBe('CHAT_DELETE_WINDOW_PASSED');
  });

  it('turns the thread read-only when the assignment ends — history stays', async () => {
    await request(server)
      .delete(api(`/coach-assignments/${assignmentId}`))
      .set(as(adminToken))
      .expect(200);

    const res = await send(clientAToken, 'Are you there?').expect(409);
    expect((res.body as Envelope<never>).error?.code).toBe('CHAT_READ_ONLY');

    const mine = await threadsOf(clientAToken);
    expect(mine.threads[0]).toMatchObject({ writable: false, readOnlyReason: 'ASSIGNMENT_ENDED' });
    await request(server)
      .get(api(`/chat/threads/${threadId}/messages`))
      .set(as(clientAToken))
      .expect(200);
    // The coach can no longer open it by member either: the scope is ACTIVE only.
    await request(server)
      .post(api(`/chat/threads/with/${clientAId}`))
      .set(as(coachAToken))
      .expect(404);
  });

  it('lets an admin review a conversation for a complaint — with a reason, audited every time', async () => {
    const list = await request(server)
      .get(api('/admin/chat/threads'))
      .set(as(adminToken))
      .expect(200);
    const rows = (list.body as Envelope<{ items: { id: string }[] }>).data!.items;
    expect(rows.map((r) => r.id)).toEqual([threadId]);
    // The list carries no message text.
    expect(JSON.stringify(list.body)).not.toContain('See you at six');

    await request(server)
      .post(api(`/admin/chat/threads/${threadId}/review`))
      .set(as(adminToken))
      .send({})
      .expect(400);

    const res = await request(server)
      .post(api(`/admin/chat/threads/${threadId}/review`))
      .set(as(adminToken))
      .send({ reason: 'Member complaint #12' })
      .expect(201);
    const review = (
      res.body as Envelope<{ messages: { body: string; deletedAt: string | null }[] }>
    ).data!;
    // Withdrawn messages keep their text here, flagged.
    expect(review.messages.find((m) => m.body === 'Oops, wrong chat')?.deletedAt).not.toBeNull();

    const audits = await ctx.prisma.auditLog.findMany({
      where: { action: 'CHAT_THREAD_REVIEWED', subjectId: threadId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].reason).toBe('Member complaint #12');

    // chat.review is ADMIN's: a coach and the desk cannot use it.
    await request(server).get(api('/admin/chat/threads')).set(as(coachAToken)).expect(403);
    await request(server).get(api('/admin/chat/threads')).set(as(frontDeskToken)).expect(403);
    // DEV reaches it through the catalogue-wide bypass.
    await request(server).get(api('/admin/chat/threads')).set(as(devToken)).expect(200);
  });
});
