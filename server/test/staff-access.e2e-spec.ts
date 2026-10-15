import request from 'supertest';
import type { Server } from 'http';
import type {
  IssuedStaffInvitation,
  StaffInvitationView,
  StaffInviteAccepted,
  StaffInviteClaim,
  StaffInvitationLookup,
} from '@got/shared';
import { createTestApp, type TestApp } from './support/test-app';
import { resetDatabase } from './support/db';
import { EmailService } from '../src/notifications/email.service';
import { SupabaseAdminService } from '../src/auth/supabase-admin.service';

jest.setTimeout(180_000);

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

const IDS = {
  ADMIN: '60000000-0000-4000-8000-0000000000a1',
  ADMIN_2: '60000000-0000-4000-8000-0000000000a2',
  DEV: '60000000-0000-4000-8000-0000000000de',
  COACH: '60000000-0000-4000-8000-0000000000c1',
  CLIENT: '60000000-0000-4000-8000-0000000000e1',
  INVITEE: '60000000-0000-4000-8000-0000000000f1',
} as const;

/**
 * Staff & Access, end to end: invitations, the role hierarchy on member
 * routes, coach profiles, and the Super Admin's read-only coaching view.
 *
 * EmailService and SupabaseAdminService are STUBBED. Whatever keys the
 * machine running this suite has configured, it must never send a real email
 * or create a real Supabase account.
 */
describe('Staff & Access (e2e)', () => {
  let ctx: TestApp;
  let server: Server;

  const email = {
    enabled: true,
    sendStaffInvite: jest.fn().mockResolvedValue(undefined),
    sendMemberJoin: jest.fn().mockResolvedValue(undefined),
    sendLeadNotification: jest.fn().mockResolvedValue(undefined),
  };
  const supabase = {
    enabled: true,
    staffInviteAccountLink: jest.fn(),
    createAuthUser: jest.fn(),
    updateAuthEmail: jest.fn(),
    memberJoinSignInLink: jest.fn(),
    deleteUser: jest.fn(),
  };

  let adminToken: string;
  let devToken: string;
  let adminId: string;

  const as = (token: string) => ({
    get: (path: string) => request(server).get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) =>
      request(server).post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object = {}) =>
      request(server).put(path).set('Authorization', `Bearer ${token}`).send(body),
  });

  const invite = async (
    token: string,
    body: { email: string; role: string },
  ): Promise<{ status: number; body: Envelope<IssuedStaffInvitation> }> => {
    const res = await as(token).post('/api/v1/staff-invitations', body);
    return { status: res.status, body: res.body as Envelope<IssuedStaffInvitation> };
  };

  const tokenOf = (link: string): string => link.slice(link.lastIndexOf('/') + 1);

  beforeAll(async () => {
    ctx = await createTestApp({
      overrides: [
        { provide: EmailService, useValue: email },
        { provide: SupabaseAdminService, useValue: supabase },
      ],
    });
    server = ctx.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    jest.clearAllMocks();
    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: IDS.ADMIN });
    devToken = await ctx.fixture.tokenFor('DEV', { supabaseId: IDS.DEV });
    adminId = await ctx.fixture.userIdFor(IDS.ADMIN);
  });

  // ── Invitations ───────────────────────────────────────────────────────────

  describe('invitations', () => {
    it('refuses an ADMIN inviting an ADMIN, and lets the Super Admin do it', async () => {
      const byAdmin = await invite(adminToken, { email: 'boss@fixture.test', role: 'ADMIN' });
      expect(byAdmin.status).toBe(403);
      expect(byAdmin.body.error?.code).toBe('ROLE_NOT_ASSIGNABLE');

      const byDev = await invite(devToken, { email: 'boss@fixture.test', role: 'ADMIN' });
      expect(byDev.status).toBe(201);
      expect(byDev.body.data?.invitation.role).toBe('ADMIN');
    });

    it('invite a coach → look up → accept: the role comes from the invitation row', async () => {
      const issued = await invite(adminToken, { email: 'New.Coach@fixture.test', role: 'COACH' });
      expect(issued.status).toBe(201);
      const link = issued.body.data!.link;
      expect(link).toContain('/invite/');
      expect(issued.body.data!.emailSent).toBe(true);
      expect(email.sendStaffInvite).toHaveBeenCalledWith(
        'new.coach@fixture.test',
        expect.objectContaining({ roleLabel: 'Coach', link }),
      );

      const token = tokenOf(link);
      const lookup = await request(server).get(`/api/v1/staff-invitations/lookup?token=${token}`);
      expect(lookup.status).toBe(200);
      expect((lookup.body as Envelope<StaffInvitationLookup>).data).toEqual({
        role: 'COACH',
        maskedEmail: 'ne***@fixture.test',
      });

      const inviteeToken = await ctx.fixture.tokenFor('CLIENT', {
        supabaseId: IDS.INVITEE,
        email: 'new.coach@fixture.test',
      });
      const accepted = await as(inviteeToken).post('/api/v1/staff-invitations/accept', { token });
      expect(accepted.status).toBe(200);
      expect((accepted.body as Envelope<StaffInviteAccepted>).data).toEqual({
        role: 'COACH',
        changed: true,
      });

      const me = await as(inviteeToken).get('/api/v1/me');
      expect((me.body as Envelope<{ role: string }>).data?.role).toBe('COACH');

      const list = await as(adminToken).get('/api/v1/staff-invitations');
      const rows = (list.body as Envelope<StaffInvitationView[]>).data!;
      expect(rows[0]).toMatchObject({ status: 'ACCEPTED', email: 'new.coach@fixture.test' });
      expect(JSON.stringify(rows)).not.toContain('tokenHash');

      const audit = await ctx.prisma.auditLog.findMany({ orderBy: { occurredAt: 'asc' } });
      expect(audit.map((row) => row.action)).toEqual(['STAFF_INVITED', 'STAFF_INVITE_ACCEPTED']);
      expect(audit[1].details).toMatchObject({ role: { before: 'CLIENT', after: 'COACH' } });

      // Used up: the same link answers 410 now.
      const again = await request(server).get(`/api/v1/staff-invitations/lookup?token=${token}`);
      expect(again.status).toBe(410);
      expect((again.body as Envelope<unknown>).error?.code).toBe('STAFF_INVITE_USED');
    });

    it('refuses acceptance by somebody signed in with another address', async () => {
      const issued = await invite(adminToken, { email: 'ana@fixture.test', role: 'COACH' });
      const other = await ctx.fixture.tokenFor('CLIENT', {
        supabaseId: IDS.CLIENT,
        email: 'someone.else@fixture.test',
      });

      const res = await as(other).post('/api/v1/staff-invitations/accept', {
        token: tokenOf(issued.body.data!.link),
      });
      expect(res.status).toBe(403);
      expect((res.body as Envelope<unknown>).error?.code).toBe('STAFF_INVITE_EMAIL_MISMATCH');
    });

    it('allows one live invitation per address — the second is 409', async () => {
      await invite(adminToken, { email: 'ana@fixture.test', role: 'COACH' });
      const second = await invite(adminToken, { email: 'ana@fixture.test', role: 'FRONT_DESK' });
      expect(second.status).toBe(409);
      expect(second.body.error?.code).toBe('STAFF_INVITE_PENDING');
    });

    it('revoke kills the link', async () => {
      const issued = await invite(adminToken, { email: 'ana@fixture.test', role: 'COACH' });
      const id = issued.body.data!.invitation.id;

      const revoked = await as(adminToken).post(`/api/v1/staff-invitations/${id}/revoke`);
      expect(revoked.status).toBe(200);

      const lookup = await request(server).get(
        `/api/v1/staff-invitations/lookup?token=${tokenOf(issued.body.data!.link)}`,
      );
      expect(lookup.status).toBe(410);
      expect((lookup.body as Envelope<unknown>).error?.code).toBe('STAFF_INVITE_REVOKED');
    });

    it('resend issues a new link and the old one stops working', async () => {
      const issued = await invite(adminToken, { email: 'ana@fixture.test', role: 'COACH' });
      const id = issued.body.data!.invitation.id;

      const resent = await as(adminToken).post(`/api/v1/staff-invitations/${id}/resend`);
      expect(resent.status).toBe(200);
      const newLink = (resent.body as Envelope<IssuedStaffInvitation>).data!.link;
      expect(newLink).not.toBe(issued.body.data!.link);

      const old = await request(server).get(
        `/api/v1/staff-invitations/lookup?token=${tokenOf(issued.body.data!.link)}`,
      );
      expect(old.status).toBe(404);
      const fresh = await request(server).get(
        `/api/v1/staff-invitations/lookup?token=${tokenOf(newLink)}`,
      );
      expect(fresh.status).toBe(200);
    });

    it('claim-link: a new address gets an account link, an existing one is asked to sign in', async () => {
      const issued = await invite(adminToken, { email: 'ana@fixture.test', role: 'COACH' });
      const token = tokenOf(issued.body.data!.link);

      supabase.staffInviteAccountLink.mockResolvedValueOnce({
        kind: 'NEW_ACCOUNT',
        actionLink: 'https://project.supabase.co/auth/v1/verify?token=x',
      });
      const fresh = await request(server)
        .post('/api/v1/staff-invitations/claim-link')
        .send({ token });
      expect(fresh.status).toBe(200);
      expect((fresh.body as Envelope<StaffInviteClaim>).data).toEqual({
        kind: 'REDIRECT',
        url: 'https://project.supabase.co/auth/v1/verify?token=x',
      });
      expect(supabase.staffInviteAccountLink).toHaveBeenCalledWith(
        'ana@fixture.test',
        expect.stringMatching(new RegExp(`/invite/${token}$`)),
      );

      supabase.staffInviteAccountLink.mockResolvedValueOnce({ kind: 'EXISTING_ACCOUNT' });
      const existing = await request(server)
        .post('/api/v1/staff-invitations/claim-link')
        .send({ token });
      expect((existing.body as Envelope<StaffInviteClaim>).data).toEqual({ kind: 'SIGN_IN' });

      // It never applied a role.
      const invitation = await ctx.prisma.staffInvitation.findFirstOrThrow();
      expect(invitation.acceptedAt).toBeNull();
    });

    it('is closed to the front desk', async () => {
      const desk = await ctx.fixture.tokenFor('FRONT_DESK', { supabaseId: IDS.CLIENT });
      const res = await invite(desk, { email: 'ana@fixture.test', role: 'COACH' });
      expect(res.status).toBe(403);
    });
  });

  // ── The role hierarchy on the member routes ─────────────────────────────

  describe('role hierarchy', () => {
    let coachId: string;

    beforeEach(async () => {
      await ctx.fixture.tokenFor('COACH', { supabaseId: IDS.COACH });
      coachId = await ctx.fixture.userIdFor(IDS.COACH);
    });

    it('refuses an ADMIN promoting somebody to ADMIN; the Super Admin may', async () => {
      const byAdmin = await as(adminToken).post(`/api/v1/members/${coachId}/role`, {
        role: 'ADMIN',
        reason: 'covering the owner',
      });
      expect(byAdmin.status).toBe(403);
      expect((byAdmin.body as Envelope<unknown>).error?.code).toBe('ROLE_NOT_ASSIGNABLE');

      const byDev = await as(devToken).post(`/api/v1/members/${coachId}/role`, {
        role: 'ADMIN',
        reason: 'covering the owner',
      });
      expect(byDev.status).toBe(200);
    });

    it('protects the last active ADMIN from demotion, suspension and deletion', async () => {
      const demote = await as(devToken).post(`/api/v1/members/${adminId}/role`, {
        role: 'COACH',
        reason: 'stepping down',
      });
      expect(demote.status).toBe(409);
      expect((demote.body as Envelope<unknown>).error?.code).toBe('LAST_ADMIN_PROTECTED');

      const suspend = await as(devToken).post(`/api/v1/members/${adminId}/suspend`, {
        reason: 'stepping down',
      });
      expect(suspend.status).toBe(409);

      const remove = await request(server)
        .delete(`/api/v1/members/${adminId}`)
        .set('Authorization', `Bearer ${devToken}`);
      expect(remove.status).toBe(409);
    });

    it('lets the Super Admin demote an ADMIN once another is active', async () => {
      await ctx.fixture.tokenFor('ADMIN', { supabaseId: IDS.ADMIN_2 });

      const demote = await as(devToken).post(`/api/v1/members/${adminId}/role`, {
        role: 'COACH',
        reason: 'stepping down',
      });
      expect(demote.status).toBe(200);
    });

    it('refuses an ADMIN suspending another ADMIN', async () => {
      await ctx.fixture.tokenFor('ADMIN', { supabaseId: IDS.ADMIN_2 });
      const otherAdmin = await ctx.fixture.userIdFor(IDS.ADMIN_2);

      const res = await as(adminToken).post(`/api/v1/members/${otherAdmin}/suspend`, {
        reason: 'a disagreement',
      });
      expect(res.status).toBe(403);
      expect((res.body as Envelope<unknown>).error?.code).toBe('ROLE_TARGET_OUTRANKS');
    });

    it('lists staff only with staff=true', async () => {
      await ctx.fixture.tokenFor('CLIENT', { supabaseId: IDS.CLIENT });
      const res = await as(adminToken).get('/api/v1/members?staff=true&limit=50');
      const roles = (res.body as Envelope<{ items: Array<{ role: string }> }>).data!.items.map(
        (item) => item.role,
      );
      expect(roles).not.toContain('CLIENT');
      expect(roles).toEqual(expect.arrayContaining(['ADMIN', 'DEV', 'COACH']));
    });

    it('draws the role matrix from the seeded grants', async () => {
      const res = await as(adminToken).get('/api/v1/admin/permissions/roles');
      const data = (res.body as Envelope<Record<string, Array<{ key: string; scope: string }>>>)
        .data!;
      expect(data['ADMIN']).toEqual(
        expect.arrayContaining([{ key: 'staff.invite', scope: 'ALL' }]),
      );
      expect(data).not.toHaveProperty('DEV');
    });
  });

  // ── Coach profiles and the Super Admin coaching view ──────────────────────

  describe('coach profiles and the coaching view', () => {
    let coachToken: string;
    let coachId: string;
    let clientToken: string;
    let clientId: string;

    beforeEach(async () => {
      coachToken = await ctx.fixture.tokenFor('COACH', { supabaseId: IDS.COACH });
      coachId = await ctx.fixture.userIdFor(IDS.COACH);
      clientToken = await ctx.fixture.tokenFor('CLIENT', { supabaseId: IDS.CLIENT });
      clientId = await ctx.fixture.userIdFor(IDS.CLIENT);
      await as(adminToken).post('/api/v1/coach-assignments', { coachId, memberId: clientId });
    });

    it('an admin writes a profile; the coach reads it; the member sees it on My Coach', async () => {
      const put = await as(adminToken).put(`/api/v1/admin/coaches/${coachId}/profile`, {
        specializations: ['Strength', 'Mobility'],
        bio: 'Ten years coaching.',
      });
      expect(put.status).toBe(200);

      const own = await as(coachToken).get(`/api/v1/coaches/${coachId}/profile`);
      expect((own.body as Envelope<{ specializations: string[] }>).data?.specializations).toEqual([
        'Strength',
        'Mobility',
      ]);

      const mine = await as(clientToken).get('/api/v1/me/coach');
      expect((mine.body as Envelope<{ profile: unknown }>).data?.profile).toEqual({
        specializations: ['Strength', 'Mobility'],
        bio: 'Ten years coaching.',
      });

      const audit = await ctx.prisma.auditLog.findFirst({
        where: { action: 'COACH_PROFILE_UPDATED' },
      });
      expect(audit?.subjectId).toBe(coachId);
    });

    it('refuses the coach editing their own profile, and six specializations', async () => {
      const byCoach = await as(coachToken).put(`/api/v1/admin/coaches/${coachId}/profile`, {
        specializations: ['Strength'],
      });
      expect(byCoach.status).toBe(403);

      const six = await as(adminToken).put(`/api/v1/admin/coaches/${coachId}/profile`, {
        specializations: ['a', 'b', 'c', 'd', 'e', 'f'],
      });
      expect(six.status).toBe(400);
    });

    it('opens any caseload to an ADMIN, and none to a coach (OWN is not ALL)', async () => {
      const admin = await as(adminToken).get(`/api/v1/admin/coaches/${coachId}/caseload`);
      expect(admin.status).toBe(200);
      expect(
        (admin.body as Envelope<{ members: Array<{ userId: string }> }>).data?.members.map(
          (m) => m.userId,
        ),
      ).toEqual([clientId]);

      const coach = await as(coachToken).get(`/api/v1/admin/coaches/${coachId}/caseload`);
      expect(coach.status).toBe(403);
    });

    it("shows a member's progress to the Super Admin only", async () => {
      const path = `/api/v1/admin/members/${clientId}/progress`;
      expect((await as(adminToken).get(path)).status).toBe(403);
      expect((await as(coachToken).get(path)).status).toBe(403);

      const dev = await as(devToken).get(path);
      expect(dev.status).toBe(200);
      expect((dev.body as Envelope<{ member: { id: string } }>).data?.member.id).toBe(clientId);
    });
  });
});
