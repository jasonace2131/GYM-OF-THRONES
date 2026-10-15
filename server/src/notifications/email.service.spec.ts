import type { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service';
import type { Env } from '../config/env.validation';

const send = jest.fn();

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send },
  })),
}));

function buildConfig(overrides: Partial<Env> = {}): ConfigService<Env, true> {
  const values: Partial<Env> = {
    RESEND_API_KEY: 're_test_key',
    RESEND_FROM: 'Gym of Thrones <hello@example.com>',
    ...overrides,
  };
  return {
    get: (key: keyof Env) => values[key],
  } as unknown as ConfigService<Env, true>;
}

describe('EmailService', () => {
  beforeEach(() => {
    send.mockReset();
  });

  describe('enabled', () => {
    it('is disabled when RESEND_API_KEY is unset', () => {
      const service = new EmailService(buildConfig({ RESEND_API_KEY: undefined }));
      expect(service.enabled).toBe(false);
    });

    it('is disabled when RESEND_FROM is unset, even with an API key', () => {
      const service = new EmailService(buildConfig({ RESEND_FROM: undefined }));
      expect(service.enabled).toBe(false);
    });

    it('is enabled when both are set', () => {
      const service = new EmailService(buildConfig());
      expect(service.enabled).toBe(true);
    });
  });

  // ── Staff & Access ──────────────────────────────────────────────────────
  describe('sendStaffInvite', () => {
    const invite = {
      roleLabel: 'Coach',
      inviterName: 'Maria Santos',
      link: 'https://www.gym-of-thrones.site/invite/abc',
    };

    it('throws, and never calls Resend, when disabled', async () => {
      const service = new EmailService(buildConfig({ RESEND_API_KEY: undefined }));

      await expect(service.sendStaffInvite('ana@example.com', invite)).rejects.toThrow(/disabled/i);
      expect(send).not.toHaveBeenCalled();
    });

    it('names the role in the subject and links to OUR invite page, not a Supabase link', async () => {
      send.mockResolvedValue({ data: { id: 'email_2' }, error: null });
      const service = new EmailService(buildConfig());

      await service.sendStaffInvite('ana@example.com', invite);

      const [[message]] = send.mock.calls as Array<[{ to: string; subject: string; html: string }]>;
      expect(message.to).toBe('ana@example.com');
      expect(message.subject).toContain('Coach');
      expect(message.html).toContain('href="https://www.gym-of-thrones.site/invite/abc"');
      expect(message.html).toContain('7 days');
    });

    it("escapes the inviter's name — it is staff-typed text", async () => {
      send.mockResolvedValue({ data: { id: 'email_2' }, error: null });
      const service = new EmailService(buildConfig());

      await service.sendStaffInvite('ana@example.com', { ...invite, inviterName: '<b>x</b>' });

      const [[{ html }]] = send.mock.calls as Array<[{ html: string }]>;
      expect(html).not.toContain('<b>x</b>');
      expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    });
  });

  // ── Counter sign-up ─────────────────────────────────────────────────────
  describe('sendMemberJoin', () => {
    it('sends our setup link, the plan line, and the 7-day note', async () => {
      send.mockResolvedValue({ data: { id: 'email_3' }, error: null });
      const service = new EmailService(buildConfig());

      await service.sendMemberJoin('ana@example.com', {
        name: 'Ana Cruz',
        link: 'https://site.test/join/tok',
        plan: { name: 'Monthly', endsOn: 'November 14, 2026' },
      });

      const sent = send.mock.calls[0][0];
      expect(sent.to).toBe('ana@example.com');
      expect(sent.subject).toBe('Your Gym of Thrones account is ready');
      expect(sent.html).toContain('href="https://site.test/join/tok"');
      expect(sent.html).toContain('Set up my account');
      expect(sent.html).toContain('Your Monthly plan runs until November 14, 2026.');
      expect(sent.html).toContain('expires in 7 days');
    });

    it('leaves the plan line out when there is no membership', async () => {
      send.mockResolvedValue({ data: { id: 'email_3' }, error: null });
      const service = new EmailService(buildConfig());

      await service.sendMemberJoin('ana@example.com', {
        name: 'Ana Cruz',
        link: 'https://site.test/join/tok',
        plan: null,
      });
      expect(send.mock.calls[0][0].html).not.toContain('plan runs until');
    });

    it('escapes the staff-typed name and the plan name', async () => {
      send.mockResolvedValue({ data: { id: 'email_3' }, error: null });
      const service = new EmailService(buildConfig());

      await service.sendMemberJoin('ana@example.com', {
        name: '<b>Ana</b>',
        link: 'https://site.test/join/tok',
        plan: { name: 'Gold & <i>', endsOn: 'November 14, 2026' },
      });
      const html = send.mock.calls[0][0].html as string;
      expect(html).not.toContain('<b>Ana</b>');
      expect(html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
      expect(html).toContain('Gold &amp; &lt;i&gt;');
    });

    // `escapeAttribute` guards every href in these emails, and this is the one
    // whose link reaches members.
    it('escapes the link so a quote in it cannot close the href attribute', async () => {
      send.mockResolvedValue({ data: { id: 'email_3' }, error: null });
      const service = new EmailService(buildConfig());

      await service.sendMemberJoin('ana@example.com', {
        name: 'Ana Cruz',
        link: 'https://site.test/join/tok"><script>evil</script>',
        plan: null,
      });
      const html = send.mock.calls[0][0].html as string;
      expect(html).not.toContain('<script>');
      expect(html).toContain('&quot;');
      expect(html).toContain('">Set up my account</a>');
    });

    it('ampersand-escapes a multi-parameter link (valid HTML, same URL once parsed)', async () => {
      send.mockResolvedValue({ data: { id: 'email_3' }, error: null });
      const service = new EmailService(buildConfig());

      await service.sendMemberJoin('ana@example.com', {
        name: 'Ana Cruz',
        link: 'https://site.test/join/tok?a=1&b=2',
        plan: null,
      });
      expect(send.mock.calls[0][0].html).toContain('href="https://site.test/join/tok?a=1&amp;b=2"');
    });

    it('throws when outbound email is disabled', async () => {
      const disabled = new EmailService(buildConfig({ RESEND_API_KEY: undefined }));

      await expect(
        disabled.sendMemberJoin('ana@example.com', { name: 'A', link: 'x', plan: null }),
      ).rejects.toThrow(/disabled/);
      expect(send).not.toHaveBeenCalled();
    });

    it('throws when Resend reports an error', async () => {
      send.mockResolvedValue({ data: null, error: { message: 'rate limited' } });
      const service = new EmailService(buildConfig());

      await expect(
        service.sendMemberJoin('ana@example.com', { name: 'A', link: 'x', plan: null }),
      ).rejects.toThrow(/rate limited/);
    });
  });

  // ── Sign-in code ────────────────────────────────────────────────────────
  describe('sendLoginCode', () => {
    it('puts the code in the subject and large in the body, with the expiry line', async () => {
      send.mockResolvedValue({ data: { id: 'email_4' }, error: null });
      const service = new EmailService(buildConfig());

      await service.sendLoginCode('ana@example.com', { name: 'Ana', code: '012345' });

      const sent = send.mock.calls[0][0];
      expect(sent.to).toBe('ana@example.com');
      expect(sent.subject).toBe('Your Gym of Thrones sign-in code: 012345');
      expect(sent.html).toContain('012345');
      expect(sent.html).toContain(
        "It expires in 10 minutes. If you didn't try to sign in, change your password.",
      );
    });

    it('escapes the name', async () => {
      send.mockResolvedValue({ data: { id: 'email_4' }, error: null });
      const service = new EmailService(buildConfig());

      await service.sendLoginCode('ana@example.com', { name: '<b>Ana</b>', code: '123456' });
      const html = send.mock.calls[0][0].html as string;
      expect(html).not.toContain('<b>Ana</b>');
      expect(html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
    });

    it('throws, and never calls Resend, when disabled', async () => {
      const disabled = new EmailService(buildConfig({ RESEND_FROM: undefined }));
      await expect(
        disabled.sendLoginCode('ana@example.com', { name: 'Ana', code: '123456' }),
      ).rejects.toThrow(/disabled/);
      expect(send).not.toHaveBeenCalled();
    });

    it('throws when Resend reports an error', async () => {
      send.mockResolvedValue({ data: null, error: { message: 'daily quota exceeded' } });
      const service = new EmailService(buildConfig());
      await expect(
        service.sendLoginCode('ana@example.com', { name: 'Ana', code: '123456' }),
      ).rejects.toThrow(/daily quota exceeded/);
    });
  });
});
