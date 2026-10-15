import { HttpStatus } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Role, UserStatus } from '@prisma/client';
import { StaffInvitationsService } from './staff-invitations.service';
import { hashInvitationToken } from './invitation-token';
import type { AuditService } from '../audit/audit.service';
import type { EmailService } from '../notifications/email.service';
import type { SupabaseAdminService } from '../auth/supabase-admin.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type { Env } from '../config/env.validation';

const NOW = new Date('2026-09-25T04:00:00.000Z');
const IN_A_WEEK = new Date('2026-10-02T04:00:00.000Z');
const ORIGIN = 'https://www.gym-of-thrones.site';
const CORS = `https://gym-of-thrones.site,${ORIGIN}`;

const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEV_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const INVITEE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const INVITATION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function user(overrides: Partial<AuthUser>): AuthUser {
  return {
    id: ADMIN_ID,
    supabaseId: '11111111-1111-4111-8111-111111111111',
    email: 'maria@example.com',
    firstName: 'Maria',
    lastName: 'Santos',
    role: Role.ADMIN,
    status: UserStatus.ACTIVE,
    permissionVersion: 0,
    heightCm: null,
    weightKg: null,
    deletedAt: null,
    ...overrides,
  };
}

const ADMIN = user({});
const DEV = user({ id: DEV_ID, email: 'dev@example.com', firstName: 'Super', role: Role.DEV });
const INVITEE = user({
  id: INVITEE_ID,
  email: 'ana@example.com',
  firstName: 'Ana',
  lastName: 'Cruz',
  role: Role.CLIENT,
});

const person = (id: string, firstName: string) => ({ id, firstName, lastName: 'X' });

/** An invitation row as the include returns it. */
function invitation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: INVITATION_ID,
    email: 'ana@example.com',
    role: Role.COACH,
    tokenHash: 'f'.repeat(64),
    invitedById: ADMIN_ID,
    expiresAt: IN_A_WEEK,
    acceptedAt: null,
    acceptedById: null,
    revokedAt: null,
    revokedById: null,
    createdAt: NOW,
    invitedBy: person(ADMIN_ID, 'Maria'),
    acceptedBy: null,
    revokedBy: null,
    ...overrides,
  };
}

interface Mocks {
  prisma: {
    staffInvitation: Record<
      'findFirst' | 'findUnique' | 'findMany' | 'create' | 'update' | 'updateMany',
      jest.Mock
    >;
    user: Record<'findFirst' | 'findUnique' | 'update', jest.Mock>;
    $transaction: jest.Mock;
  };
  audit: { record: jest.Mock };
  email: { sendStaffInvite: jest.Mock };
  supabase: { staffInviteAccountLink: jest.Mock };
  service: StaffInvitationsService;
}

function build(): Mocks {
  const prisma = {
    staffInvitation: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => Promise<unknown>) =>
    fn(prisma),
  );

  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const email = { sendStaffInvite: jest.fn().mockResolvedValue(undefined) };
  const supabase = { staffInviteAccountLink: jest.fn() };
  const config = {
    get: (key: keyof Env) => (key === 'CORS_ORIGIN' ? CORS : undefined),
  } as unknown as ConfigService<Env, true>;

  const service = new StaffInvitationsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    email as unknown as EmailService,
    supabase as unknown as SupabaseAdminService,
    config,
  );
  return { prisma, audit, email, supabase, service };
}

/** The token a returned link carries. */
const tokenOf = (link: string): string => link.slice(link.lastIndexOf('/') + 1);

describe('StaffInvitationsService', () => {
  let m: Mocks;

  beforeEach(() => {
    m = build();
  });

  describe('create', () => {
    beforeEach(() => {
      m.prisma.staffInvitation.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(invitation({ ...data, id: INVITATION_ID })),
      );
    });

    it('refuses an ADMIN inviting an ADMIN — only the Super Admin does that', async () => {
      await expect(
        m.service.create(ADMIN, { email: 'ana@example.com', role: 'ADMIN' }, ORIGIN, NOW),
      ).rejects.toMatchObject({
        response: { code: 'ROLE_NOT_ASSIGNABLE' },
        status: HttpStatus.FORBIDDEN,
      });
      expect(m.prisma.staffInvitation.create).not.toHaveBeenCalled();
    });

    it('lets DEV invite an ADMIN', async () => {
      const issued = await m.service.create(
        DEV,
        { email: 'ana@example.com', role: 'ADMIN' },
        ORIGIN,
        NOW,
      );
      expect(issued.invitation.role).toBe('ADMIN');
    });

    it('stores the address lowercased, a 7-day expiry, and ONLY the hash of the token in the link', async () => {
      const issued = await m.service.create(
        ADMIN,
        { email: '  Ana@Example.COM ', role: 'COACH' },
        ORIGIN,
        NOW,
      );

      const [[{ data }]] = m.prisma.staffInvitation.create.mock.calls as Array<
        [{ data: Record<string, unknown> }]
      >;
      expect(data).toMatchObject({
        email: 'ana@example.com',
        role: 'COACH',
        invitedById: ADMIN_ID,
        expiresAt: IN_A_WEEK,
        createdAt: NOW,
      });
      expect(issued.link).toMatch(new RegExp(`^${ORIGIN}/invite/[A-Za-z0-9_-]{43}$`));
      expect(data['tokenHash']).toBe(hashInvitationToken(tokenOf(issued.link)));
      expect(JSON.stringify(data)).not.toContain(tokenOf(issued.link));
    });

    it('emails the link to the invitee and says so', async () => {
      const issued = await m.service.create(
        ADMIN,
        { email: 'ana@example.com', role: 'COACH' },
        ORIGIN,
        NOW,
      );

      expect(issued.emailSent).toBe(true);
      expect(m.email.sendStaffInvite).toHaveBeenCalledWith('ana@example.com', {
        roleLabel: 'Coach',
        inviterName: 'Maria Santos',
        link: issued.link,
      });
    });

    it('still returns the link when the email cannot be sent — the admin copies it', async () => {
      m.email.sendStaffInvite.mockRejectedValue(new Error('EmailService is disabled'));

      const issued = await m.service.create(
        ADMIN,
        { email: 'ana@example.com', role: 'COACH' },
        ORIGIN,
        NOW,
      );

      expect(issued.emailSent).toBe(false);
      expect(issued.link).toContain('/invite/');
    });

    it('builds the link on a TRUSTED site only — an unknown Origin falls back to CORS_ORIGIN', async () => {
      const issued = await m.service.create(
        ADMIN,
        { email: 'ana@example.com', role: 'COACH' },
        'https://evil.example',
        NOW,
      );
      expect(issued.link.startsWith('https://gym-of-thrones.site/invite/')).toBe(true);
    });

    it('refuses inviting somebody to the role they already hold', async () => {
      m.prisma.user.findFirst.mockResolvedValue({ role: Role.COACH });

      await expect(
        m.service.create(ADMIN, { email: 'ana@example.com', role: 'COACH' }, ORIGIN, NOW),
      ).rejects.toMatchObject({
        response: { code: 'STAFF_INVITE_ALREADY_HAS_ROLE' },
        status: HttpStatus.CONFLICT,
      });
    });

    it('refuses an invitation that would demote an existing account', async () => {
      m.prisma.user.findFirst.mockResolvedValue({ role: Role.ADMIN });

      await expect(
        m.service.create(DEV, { email: 'ana@example.com', role: 'COACH' }, ORIGIN, NOW),
      ).rejects.toMatchObject({ response: { code: 'STAFF_INVITE_WOULD_DEMOTE' } });
    });

    it('matches an existing account case-insensitively', async () => {
      await m.service.create(ADMIN, { email: 'Ana@Example.com', role: 'COACH' }, ORIGIN, NOW);

      expect(m.prisma.user.findFirst).toHaveBeenCalledWith({
        where: { email: { equals: 'ana@example.com', mode: 'insensitive' } },
        select: { role: true },
      });
    });

    it('refuses a second live invitation for the same address — resend the first', async () => {
      m.prisma.staffInvitation.findFirst.mockResolvedValue(invitation());

      await expect(
        m.service.create(ADMIN, { email: 'ana@example.com', role: 'COACH' }, ORIGIN, NOW),
      ).rejects.toMatchObject({
        response: { code: 'STAFF_INVITE_PENDING' },
        status: HttpStatus.CONFLICT,
      });
      expect(m.prisma.staffInvitation.create).not.toHaveBeenCalled();
    });

    it('supersedes an EXPIRED open invitation in the same transaction, then issues a new one', async () => {
      m.prisma.staffInvitation.findFirst.mockResolvedValue(
        invitation({ expiresAt: new Date('2026-09-20T00:00:00.000Z') }),
      );

      await m.service.create(ADMIN, { email: 'ana@example.com', role: 'COACH' }, ORIGIN, NOW);

      expect(m.prisma.staffInvitation.update).toHaveBeenCalledWith({
        where: { id: INVITATION_ID },
        data: { revokedAt: NOW, revokedById: ADMIN_ID },
      });
      expect(m.prisma.staffInvitation.create).toHaveBeenCalled();
    });

    it('records STAFF_INVITED against the invitation, with the role', async () => {
      await m.service.create(ADMIN, { email: 'ana@example.com', role: 'COACH' }, ORIGIN, NOW);

      expect(m.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'STAFF_INVITED',
          actorId: ADMIN_ID,
          actorRole: Role.ADMIN,
          subjectType: 'StaffInvitation',
          subjectId: INVITATION_ID,
          subjectLabel: 'ana@example.com',
          details: { role: 'COACH' },
        }),
        NOW,
      );
    });
  });

  describe('resend', () => {
    it('404s an unknown invitation', async () => {
      m.prisma.staffInvitation.findUnique.mockResolvedValue(null);

      await expect(m.service.resend(ADMIN, INVITATION_ID, ORIGIN, NOW)).rejects.toMatchObject({
        response: { code: 'STAFF_INVITE_NOT_FOUND' },
        status: HttpStatus.NOT_FOUND,
      });
    });

    it.each([
      ['USED', { acceptedAt: NOW, acceptedById: INVITEE_ID }],
      ['REVOKED', { revokedAt: NOW, revokedById: ADMIN_ID }],
    ])('refuses a %s invitation with 410', async (code, overrides) => {
      m.prisma.staffInvitation.findUnique.mockResolvedValue(invitation(overrides));

      await expect(m.service.resend(ADMIN, INVITATION_ID, ORIGIN, NOW)).rejects.toMatchObject({
        response: { code: `STAFF_INVITE_${code}` },
        status: HttpStatus.GONE,
      });
    });

    it("refuses an ADMIN resending the Super Admin's ADMIN invitation", async () => {
      m.prisma.staffInvitation.findUnique.mockResolvedValue(invitation({ role: Role.ADMIN }));

      await expect(m.service.resend(ADMIN, INVITATION_ID, ORIGIN, NOW)).rejects.toMatchObject({
        response: { code: 'ROLE_NOT_ASSIGNABLE' },
      });
    });

    it('issues a NEW token and a fresh 7 days — the old link dies — even when it had expired', async () => {
      m.prisma.staffInvitation.findUnique
        .mockResolvedValueOnce(invitation({ expiresAt: new Date('2026-09-01T00:00:00.000Z') }))
        .mockResolvedValueOnce(invitation({ expiresAt: IN_A_WEEK }));

      const issued = await m.service.resend(ADMIN, INVITATION_ID, ORIGIN, NOW);

      const [[call]] = m.prisma.staffInvitation.updateMany.mock.calls as Array<
        [{ where: Record<string, unknown>; data: Record<string, unknown> }]
      >;
      expect(call.where).toEqual({ id: INVITATION_ID, acceptedAt: null, revokedAt: null });
      expect(call.data['expiresAt']).toEqual(IN_A_WEEK);
      expect(call.data['tokenHash']).toBe(hashInvitationToken(tokenOf(issued.link)));
      expect(m.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'STAFF_INVITE_RESENT', subjectId: INVITATION_ID }),
        NOW,
      );
    });
  });

  describe('revoke', () => {
    it('marks it revoked by the caller and records STAFF_INVITE_REVOKED', async () => {
      m.prisma.staffInvitation.findUnique.mockResolvedValueOnce(invitation()).mockResolvedValueOnce(
        invitation({
          revokedAt: NOW,
          revokedById: ADMIN_ID,
          revokedBy: person(ADMIN_ID, 'Maria'),
        }),
      );

      const view = await m.service.revoke(ADMIN, INVITATION_ID, NOW);

      expect(m.prisma.staffInvitation.updateMany).toHaveBeenCalledWith({
        where: { id: INVITATION_ID, acceptedAt: null, revokedAt: null },
        data: { revokedAt: NOW, revokedById: ADMIN_ID },
      });
      expect(view.status).toBe('REVOKED');
      expect(m.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'STAFF_INVITE_REVOKED' }),
        NOW,
      );
    });

    it('refuses an invitation already taken up', async () => {
      m.prisma.staffInvitation.findUnique.mockResolvedValue(
        invitation({ acceptedAt: NOW, acceptedById: INVITEE_ID }),
      );

      await expect(m.service.revoke(ADMIN, INVITATION_ID, NOW)).rejects.toMatchObject({
        response: { code: 'STAFF_INVITE_USED' },
      });
      expect(m.prisma.staffInvitation.updateMany).not.toHaveBeenCalled();
    });

    it("refuses an ADMIN revoking the Super Admin's ADMIN invitation", async () => {
      m.prisma.staffInvitation.findUnique.mockResolvedValue(invitation({ role: Role.ADMIN }));

      await expect(m.service.revoke(ADMIN, INVITATION_ID, NOW)).rejects.toMatchObject({
        response: { code: 'ROLE_NOT_ASSIGNABLE' },
      });
    });
  });

  describe('lookup (public)', () => {
    it('finds the invitation by the HASH of the token', async () => {
      m.prisma.staffInvitation.findUnique.mockResolvedValue(invitation());

      await m.service.lookup('raw-token-value', NOW);

      expect(m.prisma.staffInvitation.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tokenHash: hashInvitationToken('raw-token-value') } }),
      );
    });

    it('returns only the role and a masked address', async () => {
      m.prisma.staffInvitation.findUnique.mockResolvedValue(invitation());

      await expect(m.service.lookup('t', NOW)).resolves.toEqual({
        role: 'COACH',
        maskedEmail: 'an***@example.com',
      });
    });

    it('404s an unknown token', async () => {
      m.prisma.staffInvitation.findUnique.mockResolvedValue(null);
      await expect(m.service.lookup('t', NOW)).rejects.toMatchObject({
        response: { code: 'STAFF_INVITE_NOT_FOUND' },
      });
    });

    it.each([
      ['EXPIRED', { expiresAt: NOW }],
      ['REVOKED', { revokedAt: NOW, revokedById: ADMIN_ID }],
      ['USED', { acceptedAt: NOW, acceptedById: INVITEE_ID }],
    ])('410s a dead link as %s, so the page can say which', async (code, overrides) => {
      m.prisma.staffInvitation.findUnique.mockResolvedValue(invitation(overrides));
      await expect(m.service.lookup('t', NOW)).rejects.toMatchObject({
        response: { code: `STAFF_INVITE_${code}` },
        status: HttpStatus.GONE,
      });
    });
  });

  describe('claimLink (public)', () => {
    it('hands back a NEW account link that returns to this invite page', async () => {
      m.prisma.staffInvitation.findUnique.mockResolvedValue(invitation());
      m.supabase.staffInviteAccountLink.mockResolvedValue({
        kind: 'NEW_ACCOUNT',
        actionLink: 'https://project.supabase.co/auth/v1/verify?token=x',
      });

      await expect(m.service.claimLink('tok_123', ORIGIN, NOW)).resolves.toEqual({
        kind: 'REDIRECT',
        url: 'https://project.supabase.co/auth/v1/verify?token=x',
      });
      expect(m.supabase.staffInviteAccountLink).toHaveBeenCalledWith(
        'ana@example.com',
        `${ORIGIN}/invite/tok_123`,
      );
    });

    it('asks an existing account to sign in, and hands out no link for it', async () => {
      m.prisma.staffInvitation.findUnique.mockResolvedValue(invitation());
      m.supabase.staffInviteAccountLink.mockResolvedValue({ kind: 'EXISTING_ACCOUNT' });

      await expect(m.service.claimLink('tok_123', ORIGIN, NOW)).resolves.toEqual({
        kind: 'SIGN_IN',
      });
    });

    it('never touches Supabase for a dead invitation', async () => {
      m.prisma.staffInvitation.findUnique.mockResolvedValue(invitation({ expiresAt: NOW }));

      await expect(m.service.claimLink('tok_123', ORIGIN, NOW)).rejects.toMatchObject({
        response: { code: 'STAFF_INVITE_EXPIRED' },
      });
      expect(m.supabase.staffInviteAccountLink).not.toHaveBeenCalled();
    });

    it('never applies a role', async () => {
      m.prisma.staffInvitation.findUnique.mockResolvedValue(invitation());
      m.supabase.staffInviteAccountLink.mockResolvedValue({ kind: 'EXISTING_ACCOUNT' });

      await m.service.claimLink('tok_123', ORIGIN, NOW);

      expect(m.prisma.user.update).not.toHaveBeenCalled();
      expect(m.prisma.staffInvitation.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('accept', () => {
    beforeEach(() => {
      m.prisma.staffInvitation.findUnique.mockResolvedValue(invitation());
      m.prisma.user.findUnique.mockResolvedValue({
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
        deletedAt: null,
      });
    });

    it('promotes a member to the role ON THE ROW, and marks the invitation taken', async () => {
      await expect(m.service.accept(INVITEE, 'tok', NOW)).resolves.toEqual({
        role: 'COACH',
        changed: true,
      });

      expect(m.prisma.staffInvitation.updateMany).toHaveBeenCalledWith({
        where: { id: INVITATION_ID, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: NOW, acceptedById: INVITEE_ID },
      });
      expect(m.prisma.user.update).toHaveBeenCalledWith({
        where: { id: INVITEE_ID },
        data: { role: Role.COACH },
      });
    });

    it('records STAFF_INVITE_ACCEPTED as the invitee, with the before/after roles', async () => {
      await m.service.accept(INVITEE, 'tok', NOW);

      expect(m.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'STAFF_INVITE_ACCEPTED',
          actorId: INVITEE_ID,
          actorRole: Role.CLIENT,
          subjectType: 'User',
          subjectId: INVITEE_ID,
          details: { role: { before: 'CLIENT', after: 'COACH' }, invitationId: INVITATION_ID },
        }),
        NOW,
      );
    });

    it('refuses somebody signed in with a different address — 403, nothing written', async () => {
      await expect(
        m.service.accept({ ...INVITEE, email: 'someone.else@example.com' }, 'tok', NOW),
      ).rejects.toMatchObject({
        response: { code: 'STAFF_INVITE_EMAIL_MISMATCH' },
        status: HttpStatus.FORBIDDEN,
      });
      expect(m.prisma.user.update).not.toHaveBeenCalled();
    });

    it('matches the address case-insensitively', async () => {
      await expect(
        m.service.accept({ ...INVITEE, email: 'Ana@Example.com' }, 'tok', NOW),
      ).resolves.toMatchObject({ changed: true });
    });

    it('re-checks expiry at acceptance', async () => {
      m.prisma.staffInvitation.findUnique.mockResolvedValue(invitation({ expiresAt: NOW }));

      await expect(m.service.accept(INVITEE, 'tok', NOW)).rejects.toMatchObject({
        response: { code: 'STAFF_INVITE_EXPIRED' },
      });
    });

    it('re-checks the hierarchy against the inviter NOW — a demoted inviter can no longer grant', async () => {
      m.prisma.user.findUnique.mockResolvedValue({
        role: Role.COACH,
        status: UserStatus.ACTIVE,
        deletedAt: null,
      });

      await expect(m.service.accept(INVITEE, 'tok', NOW)).rejects.toMatchObject({
        response: { code: 'ROLE_NOT_ASSIGNABLE' },
      });
      expect(m.prisma.user.update).not.toHaveBeenCalled();
    });

    it('treats an invitation from a deleted inviter as withdrawn', async () => {
      m.prisma.user.findUnique.mockResolvedValue({
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
        deletedAt: NOW,
      });

      await expect(m.service.accept(INVITEE, 'tok', NOW)).rejects.toMatchObject({
        response: { code: 'STAFF_INVITE_REVOKED' },
      });
    });

    it('never demotes: an ADMIN accepting a COACH invitation is refused', async () => {
      await expect(
        m.service.accept({ ...INVITEE, role: Role.ADMIN }, 'tok', NOW),
      ).rejects.toMatchObject({ response: { code: 'STAFF_INVITE_WOULD_DEMOTE' } });
    });

    it('uses up the invitation without a role write when they already hold the role', async () => {
      await expect(m.service.accept({ ...INVITEE, role: Role.COACH }, 'tok', NOW)).resolves.toEqual(
        { role: 'COACH', changed: false },
      );
      expect(m.prisma.staffInvitation.updateMany).toHaveBeenCalled();
      expect(m.prisma.user.update).not.toHaveBeenCalled();
    });

    it('answers a double-click by the same person as done, not as an error', async () => {
      m.prisma.staffInvitation.findUnique.mockResolvedValue(
        invitation({ acceptedAt: NOW, acceptedById: INVITEE_ID }),
      );

      await expect(m.service.accept(INVITEE, 'tok', NOW)).resolves.toEqual({
        role: 'COACH',
        changed: false,
      });
      expect(m.prisma.staffInvitation.updateMany).not.toHaveBeenCalled();
    });

    it('refuses an invitation somebody else already took up', async () => {
      m.prisma.staffInvitation.findUnique.mockResolvedValue(
        invitation({ acceptedAt: NOW, acceptedById: ADMIN_ID }),
      );

      await expect(m.service.accept(INVITEE, 'tok', NOW)).rejects.toMatchObject({
        response: { code: 'STAFF_INVITE_USED' },
      });
    });

    it('loses a race cleanly — the claim updates nothing, so no role is written', async () => {
      m.prisma.staffInvitation.updateMany.mockResolvedValue({ count: 0 });

      await expect(m.service.accept(INVITEE, 'tok', NOW)).rejects.toMatchObject({
        response: { code: 'STAFF_INVITE_USED' },
      });
      expect(m.prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('shows open invitations and anything from the last 30 days, newest first', async () => {
      m.prisma.staffInvitation.findMany.mockResolvedValue([invitation()]);

      const rows = await m.service.list(NOW);

      expect(m.prisma.staffInvitation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { acceptedAt: null, revokedAt: null },
              { createdAt: { gte: new Date('2026-08-26T04:00:00.000Z') } },
            ],
          },
          orderBy: { createdAt: 'desc' },
        }),
      );
      expect(rows[0]).toMatchObject({
        id: INVITATION_ID,
        status: 'PENDING',
        invitedBy: { id: ADMIN_ID, name: 'Maria X' },
      });
      expect(rows[0]).not.toHaveProperty('tokenHash');
    });
  });
});
