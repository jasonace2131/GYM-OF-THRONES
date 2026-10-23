import type { ConfigService } from '@nestjs/config';
import { SupabaseAdminService } from './supabase-admin.service';
import type { Env } from '../config/env.validation';

const generateLink = jest.fn();
const createUser = jest.fn();
const updateUserById = jest.fn();
const deleteUser = jest.fn();
const signInWithPassword = jest.fn();
const signOut = jest.fn();

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    auth: {
      admin: { generateLink, createUser, updateUserById, deleteUser },
      signInWithPassword,
      signOut,
    },
  })),
}));

function buildConfig(overrides: Partial<Env> = {}): ConfigService<Env, true> {
  const values: Partial<Env> = {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_KEY: 'service-role-key',
    ...overrides,
  };
  return {
    get: (key: keyof Env) => values[key],
  } as unknown as ConfigService<Env, true>;
}

describe('SupabaseAdminService', () => {
  beforeEach(() => {
    generateLink.mockReset();
    createUser.mockReset();
    updateUserById.mockReset();
  });

  describe('enabled', () => {
    it('is disabled when SUPABASE_SERVICE_KEY is unset, and warns rather than crashing', () => {
      const service = new SupabaseAdminService(
        buildConfig({ SUPABASE_SERVICE_KEY: undefined }),
      );
      expect(service.enabled).toBe(false);
    });

    it('is enabled when SUPABASE_SERVICE_KEY is set', () => {
      const service = new SupabaseAdminService(buildConfig());
      expect(service.enabled).toBe(true);
    });
  });

  // ── Staff & Access: the invite page's "Set up my account" ────────────────
  describe('staffInviteAccountLink', () => {
    const REDIRECT = 'https://www.gym-of-thrones.site/invite/abc';

    it('503s with STAFF_INVITE_DISABLED when the service key is unset', async () => {
      const service = new SupabaseAdminService(buildConfig({ SUPABASE_SERVICE_KEY: undefined }));

      await expect(
        service.staffInviteAccountLink('ana@example.com', REDIRECT),
      ).rejects.toMatchObject({ response: { code: 'STAFF_INVITE_DISABLED' }, status: 503 });
      expect(generateLink).not.toHaveBeenCalled();
    });

    it('mints a NEW account with an invite link that returns to the invite page', async () => {
      generateLink.mockResolvedValue({
        data: {
          user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
          properties: { action_link: 'https://project.supabase.co/auth/v1/verify?token=new' },
        },
        error: null,
      });
      const service = new SupabaseAdminService(buildConfig());

      await expect(service.staffInviteAccountLink('ana@example.com', REDIRECT)).resolves.toEqual({
        kind: 'NEW_ACCOUNT',
        actionLink: 'https://project.supabase.co/auth/v1/verify?token=new',
      });
      expect(generateLink).toHaveBeenCalledWith({
        type: 'invite',
        email: 'ana@example.com',
        options: { redirectTo: REDIRECT },
      });
    });

    /**
     * An EXISTING account gets no link at all. A sign-in link for somebody's
     * existing account, handed to whoever holds an invitation token — which
     * the admin who issued it has also seen — would let that admin sign in as
     * the member. The invitee signs in the ordinary way instead.
     */
    it('answers EXISTING_ACCOUNT, with no link, when the address is already registered', async () => {
      generateLink.mockResolvedValue({
        data: null,
        error: { message: 'A user with this email address has already been registered' },
      });
      const service = new SupabaseAdminService(buildConfig());

      await expect(service.staffInviteAccountLink('ana@example.com', REDIRECT)).resolves.toEqual({
        kind: 'EXISTING_ACCOUNT',
      });
      expect(generateLink).toHaveBeenCalledTimes(1);
    });

    it('502s with MEMBER_INVITE_FAILED on any other Supabase error', async () => {
      generateLink.mockResolvedValue({ data: null, error: { message: 'upstream timeout' } });
      const service = new SupabaseAdminService(buildConfig());

      await expect(
        service.staffInviteAccountLink('ana@example.com', REDIRECT),
      ).rejects.toMatchObject({ response: { code: 'MEMBER_INVITE_FAILED' } });
    });
  });

  // ── Counter sign-up ──────────────────────────────────────────────────────
  describe('createAuthUser', () => {
    it('503s with MEMBER_CREATE_DISABLED when the service key is unset', async () => {
      const service = new SupabaseAdminService(buildConfig({ SUPABASE_SERVICE_KEY: undefined }));
      await expect(service.createAuthUser('jon@example.com')).rejects.toMatchObject({
        response: { code: 'MEMBER_CREATE_DISABLED' },
      });
      expect(createUser).not.toHaveBeenCalled();
    });

    it('creates an UNCONFIRMED user and mints no link — the setup link is ours', async () => {
      createUser.mockResolvedValue({
        data: { user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } },
        error: null,
      });
      const service = new SupabaseAdminService(buildConfig());

      await expect(service.createAuthUser('jon@example.com')).resolves.toEqual({
        userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });
      expect(createUser).toHaveBeenCalledWith({ email: 'jon@example.com', email_confirm: false });
      expect(generateLink).not.toHaveBeenCalled();
    });

    it('409s with MEMBER_EMAIL_TAKEN when the address is already registered', async () => {
      createUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'A user with this email address has already been registered' },
      });
      const service = new SupabaseAdminService(buildConfig());
      await expect(service.createAuthUser('jon@example.com')).rejects.toMatchObject({
        response: { code: 'MEMBER_EMAIL_TAKEN' },
      });
    });

    it('502s with MEMBER_INVITE_FAILED on any other Supabase error', async () => {
      createUser.mockResolvedValue({ data: { user: null }, error: { message: 'boom' } });
      const service = new SupabaseAdminService(buildConfig());
      await expect(service.createAuthUser('jon@example.com')).rejects.toMatchObject({
        response: { code: 'MEMBER_INVITE_FAILED' },
      });
    });
  });

  describe('memberJoinSignInLink', () => {
    it('mints a magiclink that returns to the join page, with the account it signs into', async () => {
      generateLink.mockResolvedValue({
        data: {
          user: { id: 'u' },
          properties: { action_link: 'https://project.supabase.co/verify?t=1' },
        },
        error: null,
      });
      const service = new SupabaseAdminService(buildConfig());

      await expect(
        service.memberJoinSignInLink('jon@example.com', 'https://site.test/join/tok'),
      ).resolves.toEqual({ actionLink: 'https://project.supabase.co/verify?t=1', userId: 'u' });
      expect(generateLink).toHaveBeenCalledWith({
        type: 'magiclink',
        email: 'jon@example.com',
        options: { redirectTo: 'https://site.test/join/tok' },
      });
    });

    it('503s with MEMBER_CREATE_DISABLED when the service key is unset', async () => {
      const service = new SupabaseAdminService(buildConfig({ SUPABASE_SERVICE_KEY: undefined }));
      await expect(
        service.memberJoinSignInLink('jon@example.com', 'https://site.test/join/tok'),
      ).rejects.toMatchObject({ response: { code: 'MEMBER_CREATE_DISABLED' } });
    });

    // A public route: Supabase's own wording goes to the log, never to the caller.
    it('502s with MEMBER_INVITE_FAILED and a generic message on a Supabase error', async () => {
      generateLink.mockResolvedValue({ data: null, error: { message: 'boom: internal detail' } });
      const service = new SupabaseAdminService(buildConfig());
      const failure = service.memberJoinSignInLink('jon@example.com', 'https://site.test/join/tok');
      await expect(failure).rejects.toMatchObject({
        response: {
          code: 'MEMBER_INVITE_FAILED',
          message: 'Could not start account set-up. Try again in a moment.',
        },
        status: 502,
      });
    });
  });

  describe('updateAuthEmail', () => {
    it('changes the Supabase address', async () => {
      updateUserById.mockResolvedValue({ data: { user: { id: 'u' } }, error: null });
      const service = new SupabaseAdminService(buildConfig());

      await service.updateAuthEmail('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'new@example.com');
      expect(updateUserById).toHaveBeenCalledWith('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
        email: 'new@example.com',
      });
    });

    it('409s with MEMBER_EMAIL_TAKEN when the new address is registered', async () => {
      updateUserById.mockResolvedValue({
        data: { user: null },
        error: { message: 'A user with this email address has already been registered' },
      });
      const service = new SupabaseAdminService(buildConfig());
      await expect(service.updateAuthEmail('u', 'taken@example.com')).rejects.toMatchObject({
        response: { code: 'MEMBER_EMAIL_TAKEN' },
      });
    });

    it('503s with MEMBER_CREATE_DISABLED when the service key is unset', async () => {
      const service = new SupabaseAdminService(buildConfig({ SUPABASE_SERVICE_KEY: undefined }));
      await expect(service.updateAuthEmail('u', 'new@example.com')).rejects.toMatchObject({
        response: { code: 'MEMBER_CREATE_DISABLED' },
      });
    });
  });

  // ── Account deletion (owner, 2026-10-23) ─────────────────────────────────
  describe('verifyPassword', () => {
    beforeEach(() => {
      signInWithPassword.mockReset();
      signOut.mockReset().mockResolvedValue({ error: null });
    });

    it('is ok for the right password, and ends the probe session at once', async () => {
      signInWithPassword.mockResolvedValue({ data: {}, error: null });
      const service = new SupabaseAdminService(buildConfig());
      await expect(service.verifyPassword('juan@example.com', 'secret12')).resolves.toBe('ok');
      expect(signInWithPassword).toHaveBeenCalledWith({
        email: 'juan@example.com',
        password: 'secret12',
      });
      expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    });

    it('is wrong for a refused credential', async () => {
      signInWithPassword.mockResolvedValue({
        data: {},
        error: { code: 'invalid_credentials', message: 'Invalid login credentials' },
      });
      const service = new SupabaseAdminService(buildConfig());
      await expect(service.verifyPassword('juan@example.com', 'nope')).resolves.toBe('wrong');
    });

    it('is an error when Supabase could not answer', async () => {
      signInWithPassword.mockResolvedValue({
        data: {},
        error: { code: 'unexpected_failure', message: 'boom' },
      });
      const service = new SupabaseAdminService(buildConfig());
      await expect(service.verifyPassword('juan@example.com', 'x')).resolves.toBe('error');
    });
  });

  describe('deleteAccountIdentity', () => {
    it('deletes the Supabase user', async () => {
      deleteUser.mockResolvedValue({ data: {}, error: null });
      const service = new SupabaseAdminService(buildConfig());
      await service.deleteAccountIdentity('u');
      expect(deleteUser).toHaveBeenCalledWith('u');
    });

    it('treats an already-deleted user as done, so a retry is safe', async () => {
      deleteUser.mockResolvedValue({
        data: {},
        error: { status: 404, code: 'user_not_found', message: 'User not found' },
      });
      const service = new SupabaseAdminService(buildConfig());
      await expect(service.deleteAccountIdentity('u')).resolves.toBeUndefined();
    });

    it('throws 502 ACCOUNT_DELETE_FAILED on any other failure', async () => {
      deleteUser.mockResolvedValue({ data: {}, error: { status: 500, message: 'down' } });
      const service = new SupabaseAdminService(buildConfig());
      await expect(service.deleteAccountIdentity('u')).rejects.toMatchObject({
        status: 502,
        response: { code: 'ACCOUNT_DELETE_FAILED' },
      });
    });

    it('503s when the service key is unset', async () => {
      const service = new SupabaseAdminService(buildConfig({ SUPABASE_SERVICE_KEY: undefined }));
      await expect(service.deleteAccountIdentity('u')).rejects.toMatchObject({ status: 503 });
    });
  });
});
