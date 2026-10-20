import { beforeEach, describe, expect, it, vi } from 'vitest';

const { probe, createClient, main } = vi.hoisted(() => {
  const probe = { signInWithPassword: vi.fn(), signOut: vi.fn() };
  return {
    probe,
    createClient: vi.fn(() => ({ auth: probe })),
    main: { signInWithPassword: vi.fn(), updateUser: vi.fn() },
  };
});
vi.mock('@supabase/supabase-js', () => ({ createClient }));
vi.mock('@/lib/supabase', () => ({ supabase: { auth: main } }));

import { updateEmail, updatePassword, verifyCurrentPassword } from './accountAuth';

describe('accountAuth', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
    vi.clearAllMocks();
    probe.signOut.mockResolvedValue({ error: null });
  });

  describe('verifyCurrentPassword', () => {
    it('checks on a separate, non-persisted client — never the signed-in one', async () => {
      probe.signInWithPassword.mockResolvedValue({ data: { session: {} }, error: null });
      await expect(verifyCurrentPassword('juan@example.com', 'secret')).resolves.toBe('ok');

      expect(main.signInWithPassword).not.toHaveBeenCalled();
      const [, , options] = createClient.mock.calls[0] as unknown as [
        string,
        string,
        { auth: Record<string, unknown> },
      ];
      expect(options.auth).toMatchObject({
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      });
      expect(probe.signInWithPassword).toHaveBeenCalledWith({
        email: 'juan@example.com',
        password: 'secret',
      });
    });

    it('revokes the check session straight away', async () => {
      probe.signInWithPassword.mockResolvedValue({ data: { session: {} }, error: null });
      await verifyCurrentPassword('juan@example.com', 'secret');
      expect(probe.signOut).toHaveBeenCalledWith({ scope: 'local' });
    });

    it('says "wrong" for bad credentials', async () => {
      probe.signInWithPassword.mockResolvedValue({
        data: { session: null },
        error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' },
      });
      await expect(verifyCurrentPassword('juan@example.com', 'nope')).resolves.toBe('wrong');
      expect(probe.signOut).not.toHaveBeenCalled();
    });

    it('says "error" for anything else, such as a rate limit', async () => {
      probe.signInWithPassword.mockResolvedValue({
        data: { session: null },
        error: { code: 'over_request_rate_limit', status: 429, message: 'Too many' },
      });
      await expect(verifyCurrentPassword('juan@example.com', 'secret')).resolves.toBe('error');
    });

    it('still says "ok" when revoking the check session fails', async () => {
      probe.signInWithPassword.mockResolvedValue({ data: { session: {} }, error: null });
      probe.signOut.mockRejectedValue(new Error('network'));
      await expect(verifyCurrentPassword('juan@example.com', 'secret')).resolves.toBe('ok');
    });
  });

  it("updatePassword changes the signed-in session's password", async () => {
    main.updateUser.mockResolvedValue({ data: {}, error: null });
    await expect(updatePassword('new-password')).resolves.toEqual({ error: null });
    expect(main.updateUser).toHaveBeenCalledWith({ password: 'new-password' });
  });

  it('updateEmail asks Supabase for the change, returning to the account page', async () => {
    main.updateUser.mockResolvedValue({ data: {}, error: null });
    await expect(updateEmail('new@example.com')).resolves.toEqual({ error: null });
    expect(main.updateUser).toHaveBeenCalledWith(
      { email: 'new@example.com' },
      { emailRedirectTo: `${window.location.origin}/portal/account` },
    );
  });
});
