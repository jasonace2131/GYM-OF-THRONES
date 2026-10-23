import type { ConfigService } from '@nestjs/config';
import { MemberJoinService } from './member-join.service';
import { hashInvitationToken } from '../staff-invitations/invitation-token';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';
import type { SupabaseAdminService } from '../auth/supabase-admin.service';
import type { EmailService } from '../notifications/email.service';
import type { Env } from '../config/env.validation';

const NOW = new Date('2026-10-14T04:00:00.000Z');
const MEMBER_ID = '11111111-1111-4111-8111-111111111111';
const STAFF_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'T'.repeat(43);
const SUPABASE_ID = '33333333-3333-4333-8333-333333333333';

function buildPrisma() {
  return {
    user: { findUnique: jest.fn(), updateMany: jest.fn() },
    memberJoinLink: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      createMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

function member(over: Record<string, unknown> = {}) {
  return {
    id: MEMBER_ID,
    email: 'ana@example.com',
    firstName: 'Ana',
    lastName: 'Cruz',
    role: 'CLIENT',
    lastSeenAt: null,
    deletedAt: null,
    membership: {
      planName: 'Monthly',
      endsOn: new Date('2026-11-14T00:00:00.000Z'),
      status: 'ACTIVE',
    },
    ...over,
  };
}

function link(over: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    userId: MEMBER_ID,
    tokenHash: hashInvitationToken(TOKEN),
    issuedAt: new Date('2026-10-14T00:00:00.000Z'),
    expiresAt: new Date('2026-10-21T00:00:00.000Z'),
    usedAt: null,
    user: {
      firstName: 'Ana',
      email: 'ana@example.com',
      role: 'CLIENT',
      supabaseId: SUPABASE_ID,
      deletedAt: null,
      dateOfBirth: null,
    },
    ...over,
  };
}

describe('MemberJoinService', () => {
  let prisma: ReturnType<typeof buildPrisma>;
  let supabaseAdmin: { memberJoinSignInLink: jest.Mock };
  let email: { sendMemberJoin: jest.Mock };
  let service: MemberJoinService;

  beforeEach(() => {
    prisma = buildPrisma();
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
    supabaseAdmin = { memberJoinSignInLink: jest.fn() };
    email = { sendMemberJoin: jest.fn().mockResolvedValue(undefined) };
    service = new MemberJoinService(
      prisma as unknown as PrismaService,
      { timeZone: 'Asia/Manila' } as unknown as GymConfigService,
      { get: () => 'https://site.test' } as unknown as ConfigService<Env, true>,
      supabaseAdmin as unknown as SupabaseAdminService,
      email as unknown as EmailService,
    );
  });

  describe('issue', () => {
    it('creates the first link, and emails our /join/<token> link with the plan line', async () => {
      prisma.user.findUnique.mockResolvedValue(member());
      prisma.memberJoinLink.updateMany.mockResolvedValue({ count: 0 });
      prisma.memberJoinLink.createMany.mockResolvedValue({ count: 1 });

      const sent = await service.issue(
        { userId: MEMBER_ID, issuedById: STAFF_ID, requestOrigin: undefined },
        NOW,
      );

      expect(sent).toBe(true);
      const created = prisma.memberJoinLink.createMany.mock.calls[0][0].data[0];
      expect(created).toMatchObject({ userId: MEMBER_ID, issuedById: STAFF_ID, issuedAt: NOW });
      expect(created.expiresAt).toEqual(new Date('2026-10-21T04:00:00.000Z'));
      expect(created.tokenHash).toMatch(/^[0-9a-f]{64}$/);

      const [to, input] = email.sendMemberJoin.mock.calls[0];
      expect(to).toBe('ana@example.com');
      expect(input.name).toBe('Ana Cruz');
      expect(input.link).toMatch(/^https:\/\/site\.test\/join\/[A-Za-z0-9_-]{43}$/);
      // The emailed token is the one whose hash was stored.
      expect(hashInvitationToken(input.link.split('/join/')[1])).toBe(created.tokenHash);
      expect(input.plan).toEqual({ name: 'Monthly', endsOn: 'November 14, 2026' });
    });

    it('ROTATES an unused link in place — a new hash and expiry, the old link dead', async () => {
      prisma.user.findUnique.mockResolvedValue(member());
      prisma.memberJoinLink.updateMany.mockResolvedValue({ count: 1 });

      await service.issue(
        { userId: MEMBER_ID, issuedById: STAFF_ID, requestOrigin: undefined },
        NOW,
      );

      expect(prisma.memberJoinLink.updateMany).toHaveBeenCalledWith({
        where: { userId: MEMBER_ID, usedAt: null },
        data: expect.objectContaining({ issuedAt: NOW, issuedById: STAFF_ID }),
      });
      const rotated = prisma.memberJoinLink.updateMany.mock.calls[0][0].data;
      expect(rotated.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(rotated.tokenHash).not.toBe(link().tokenHash);
      expect(rotated.expiresAt).toEqual(new Date('2026-10-21T04:00:00.000Z'));
      // The emailed token is the NEW one.
      const emailed = email.sendMemberJoin.mock.calls[0][1].link.split('/join/')[1];
      expect(hashInvitationToken(emailed)).toBe(rotated.tokenHash);
      expect(prisma.memberJoinLink.createMany).not.toHaveBeenCalled();
    });

    it('refuses a member who has signed in before — never a link into an active account', async () => {
      prisma.user.findUnique.mockResolvedValue(member({ lastSeenAt: new Date() }));

      await expect(
        service.issue({ userId: MEMBER_ID, issuedById: STAFF_ID, requestOrigin: undefined }, NOW),
      ).rejects.toMatchObject({ response: { code: 'MEMBER_ALREADY_SIGNED_IN' }, status: 409 });
      expect(prisma.memberJoinLink.updateMany).not.toHaveBeenCalled();
      expect(email.sendMemberJoin).not.toHaveBeenCalled();
    });

    it.each(['COACH', 'FRONT_DESK'])(
      'refuses a %s account — staff are set up from Staff & Access, never by a member link',
      async (role) => {
        // Even a never-signed-in one: otherwise a desk login could point a staff
        // account's link at its own inbox and claim the account.
        prisma.user.findUnique.mockResolvedValue(member({ role }));

        await expect(
          service.issue({ userId: MEMBER_ID, issuedById: STAFF_ID, requestOrigin: undefined }, NOW),
        ).rejects.toMatchObject({ response: { code: 'MEMBER_JOIN_STAFF_ACCOUNT' }, status: 409 });
        expect(prisma.memberJoinLink.updateMany).not.toHaveBeenCalled();
        expect(prisma.memberJoinLink.createMany).not.toHaveBeenCalled();
        expect(email.sendMemberJoin).not.toHaveBeenCalled();
      },
    );

    it('refuses a deleted member as not found', async () => {
      prisma.user.findUnique.mockResolvedValue(member({ deletedAt: new Date() }));
      await expect(
        service.issue({ userId: MEMBER_ID, issuedById: STAFF_ID, requestOrigin: undefined }, NOW),
      ).rejects.toMatchObject({ response: { code: 'MEMBER_NOT_FOUND' } });
    });

    it('never revives a USED link', async () => {
      prisma.user.findUnique.mockResolvedValue(member());
      prisma.memberJoinLink.updateMany.mockResolvedValue({ count: 0 });
      prisma.memberJoinLink.createMany.mockResolvedValue({ count: 0 });

      await expect(
        service.issue({ userId: MEMBER_ID, issuedById: STAFF_ID, requestOrigin: undefined }, NOW),
      ).rejects.toMatchObject({ response: { code: 'MEMBER_JOIN_USED' } });
      expect(email.sendMemberJoin).not.toHaveBeenCalled();
    });

    it('leaves the plan line out when the membership has ended or there is none', async () => {
      prisma.user.findUnique.mockResolvedValue(
        member({
          membership: {
            planName: 'Monthly',
            endsOn: new Date('2026-10-01T00:00:00.000Z'),
            status: 'EXPIRED',
          },
        }),
      );
      prisma.memberJoinLink.updateMany.mockResolvedValue({ count: 1 });
      await service.issue(
        { userId: MEMBER_ID, issuedById: STAFF_ID, requestOrigin: undefined },
        NOW,
      );
      expect(email.sendMemberJoin.mock.calls[0][1].plan).toBeNull();

      prisma.user.findUnique.mockResolvedValue(member({ membership: null }));
      await service.issue(
        { userId: MEMBER_ID, issuedById: STAFF_ID, requestOrigin: undefined },
        NOW,
      );
      expect(email.sendMemberJoin.mock.calls[1][1].plan).toBeNull();
    });

    it('answers false, not a throw, when the email fails — the link already exists', async () => {
      prisma.user.findUnique.mockResolvedValue(member());
      prisma.memberJoinLink.updateMany.mockResolvedValue({ count: 1 });
      email.sendMemberJoin.mockRejectedValue(new Error('Resend is down'));

      await expect(
        service.issue({ userId: MEMBER_ID, issuedById: STAFF_ID, requestOrigin: undefined }, NOW),
      ).resolves.toBe(false);
    });
  });

  describe('lookup', () => {
    it('answers PENDING with the first name and the full email', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(link());
      await expect(service.lookup(TOKEN, NOW)).resolves.toEqual({
        firstName: 'Ana',
        status: 'PENDING',
        email: 'ana@example.com',
      });
      expect(prisma.memberJoinLink.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tokenHash: hashInvitationToken(TOKEN) } }),
      );
    });

    it('answers USED and EXPIRED without the email', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(link({ usedAt: NOW }));
      await expect(service.lookup(TOKEN, NOW)).resolves.toEqual({
        firstName: 'Ana',
        status: 'USED',
      });

      prisma.memberJoinLink.findUnique.mockResolvedValue(
        link({ expiresAt: new Date('2026-10-14T04:00:00.000Z') }),
      );
      await expect(service.lookup(TOKEN, NOW)).resolves.toEqual({
        firstName: 'Ana',
        status: 'EXPIRED',
      });
    });

    it('404s for an unknown token and for a deleted member', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(null);
      await expect(service.lookup(TOKEN, NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_JOIN_NOT_FOUND' },
        status: 404,
      });

      prisma.memberJoinLink.findUnique.mockResolvedValue(
        link({
          user: { firstName: 'Ana', email: 'ana@example.com', deletedAt: NOW, dateOfBirth: null },
        }),
      );
      await expect(service.lookup(TOKEN, NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_JOIN_NOT_FOUND' },
      });
    });
  });

  describe('claimLink', () => {
    it('mints a magic link that returns to THIS join page', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(link());
      supabaseAdmin.memberJoinSignInLink.mockResolvedValue({
        actionLink: 'https://project.supabase.co/verify?t=1',
        userId: SUPABASE_ID,
      });

      await expect(service.claimLink(TOKEN, undefined, NOW)).resolves.toEqual({
        url: 'https://project.supabase.co/verify?t=1',
      });
      expect(supabaseAdmin.memberJoinSignInLink).toHaveBeenCalledWith(
        'ana@example.com',
        `https://site.test/join/${TOKEN}`,
      );
    });

    it('refuses a used link (410 USED) and an expired one (410 EXPIRED) without touching Supabase', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(link({ usedAt: NOW }));
      await expect(service.claimLink(TOKEN, undefined, NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_JOIN_USED' },
        status: 410,
      });

      prisma.memberJoinLink.findUnique.mockResolvedValue(
        link({ expiresAt: new Date('2026-10-13T00:00:00.000Z') }),
      );
      await expect(service.claimLink(TOKEN, undefined, NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_JOIN_EXPIRED' },
        status: 410,
      });
      expect(supabaseAdmin.memberJoinSignInLink).not.toHaveBeenCalled();
    });

    it.each(['COACH', 'FRONT_DESK', 'ADMIN'])(
      'refuses a %s account (409) without touching Supabase — promoted before finishing setup',
      async (role) => {
        prisma.memberJoinLink.findUnique.mockResolvedValue(
          link({
            user: {
              firstName: 'Ana',
              email: 'ana@example.com',
              role,
              supabaseId: SUPABASE_ID,
              deletedAt: null,
              dateOfBirth: null,
            },
          }),
        );
        await expect(service.claimLink(TOKEN, undefined, NOW)).rejects.toMatchObject({
          response: { code: 'MEMBER_JOIN_STAFF_ACCOUNT' },
          status: 409,
        });
        expect(supabaseAdmin.memberJoinSignInLink).not.toHaveBeenCalled();
      },
    );

    /**
     * Supabase mints a link for whichever account holds the address. If that is
     * not this member's own (an imported member's fabricated id, or the two
     * emails drifting apart), the link would sign somebody else in: refuse it.
     */
    it('refuses (404), with no url, when the minted link is for another account', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(link());
      supabaseAdmin.memberJoinSignInLink.mockResolvedValue({
        actionLink: 'https://project.supabase.co/verify?t=someone-else',
        userId: '44444444-4444-4444-8444-444444444444',
      });

      await expect(service.claimLink(TOKEN, undefined, NOW)).rejects.toMatchObject({
        response: {
          code: 'MEMBER_JOIN_NOT_FOUND',
          message: "This setup link isn't valid. Ask the front desk to send a new one.",
        },
        status: 404,
      });
    });
  });

  describe('accept', () => {
    it('marks the link used and stores a joinable birth date', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(link());
      prisma.memberJoinLink.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.accept(MEMBER_ID, TOKEN, '1995-03-02', NOW)).resolves.toEqual({
        dateOfBirthSaved: true,
      });
      expect(prisma.memberJoinLink.updateMany).toHaveBeenCalledWith({
        where: { id: 'link-1', usedAt: null },
        data: { usedAt: NOW },
      });
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: MEMBER_ID, dateOfBirth: null },
        data: { dateOfBirth: new Date('1995-03-02T00:00:00.000Z') },
      });
    });

    it('refuses another signed-in account (403) before writing anything', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(link());
      await expect(service.accept(STAFF_ID, TOKEN, '1995-03-02', NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_JOIN_WRONG_ACCOUNT' },
        status: 403,
      });
      expect(prisma.memberJoinLink.updateMany).not.toHaveBeenCalled();
    });

    it('refuses another account on a USED link (403), not the idempotent answer', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(link({ usedAt: NOW }));
      await expect(service.accept(STAFF_ID, TOKEN, '1995-03-02', NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_JOIN_WRONG_ACCOUNT' },
        status: 403,
      });
      expect(prisma.memberJoinLink.updateMany).not.toHaveBeenCalled();
    });

    it('is idempotent for the same member — a double submit is not an error', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(link({ usedAt: NOW }));
      await expect(service.accept(MEMBER_ID, TOKEN, '1995-03-02', NOW)).resolves.toEqual({
        dateOfBirthSaved: false,
      });
      expect(prisma.memberJoinLink.updateMany).not.toHaveBeenCalled();
    });

    /**
     * Expiry gates the CLAIM, not the member's own finish. By the time accept
     * runs they are signed in through this link and their password is saved; a
     * 410 here would strand them, because staff cannot resend to a member who
     * has signed in.
     */
    it('finishes an EXPIRED link for its own member, and marks it used', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(
        link({ expiresAt: new Date('2026-10-13T00:00:00.000Z') }),
      );
      prisma.memberJoinLink.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.accept(MEMBER_ID, TOKEN, '1995-03-02', NOW)).resolves.toEqual({
        dateOfBirthSaved: true,
      });
      expect(prisma.memberJoinLink.updateMany).toHaveBeenCalledWith({
        where: { id: 'link-1', usedAt: null },
        data: { usedAt: NOW },
      });
    });

    it('still refuses another account on an EXPIRED link (403)', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(
        link({ expiresAt: new Date('2026-10-13T00:00:00.000Z') }),
      );
      await expect(service.accept(STAFF_ID, TOKEN, '1995-03-02', NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_JOIN_WRONG_ACCOUNT' },
        status: 403,
      });
      expect(prisma.memberJoinLink.updateMany).not.toHaveBeenCalled();
    });

    it("stores a child's birth date — there is no minimum age (owner, 2026-10-23)", async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(link());
      prisma.memberJoinLink.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.accept(MEMBER_ID, TOKEN, '2015-01-01', NOW)).resolves.toEqual({
        dateOfBirthSaved: true,
      });
    });

    it('does not store a date in the future, and still finishes', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(link());
      prisma.memberJoinLink.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.accept(MEMBER_ID, TOKEN, '2027-01-01', NOW)).resolves.toEqual({
        dateOfBirthSaved: false,
      });
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('a lost race (count 0) is the same idempotent answer, not a 500', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(link());
      prisma.memberJoinLink.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.accept(MEMBER_ID, TOKEN, '1995-03-02', NOW)).resolves.toEqual({
        dateOfBirthSaved: false,
      });
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });
  });
});
