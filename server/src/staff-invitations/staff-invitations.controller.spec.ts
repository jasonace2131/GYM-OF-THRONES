import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { REQUIRE_PERMISSION_KEY } from '../rbac/decorators/require-permission.decorator';
import { StaffInvitationsController } from './staff-invitations.controller';
import type { StaffInvitationsService } from './staff-invitations.service';
import type { AuthUser } from '../auth/auth.types';

/**
 * The decorators ARE the access control on this controller, and a dropped one
 * fails no behavioural test — so they are asserted directly.
 */
describe('StaffInvitationsController', () => {
  const proto = StaffInvitationsController.prototype;
  const meta = (key: string, name: keyof StaffInvitationsController): unknown =>
    // Reading metadata off the function object, never calling it — `this` is
    // irrelevant here, so unbound-method does not apply.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    Reflect.getMetadata(key, proto[name]);

  it.each(['list', 'create', 'resend', 'revoke'] as const)(
    '%s is gated on staff.invite and is not public',
    (name) => {
      expect(meta(REQUIRE_PERMISSION_KEY, name)).toBe('staff.invite');
      expect(meta(IS_PUBLIC_KEY, name)).toBeUndefined();
    },
  );

  it.each(['lookup', 'claimLink'] as const)(
    '%s is public — the invitee has no session yet — and carries no permission',
    (name) => {
      expect(meta(IS_PUBLIC_KEY, name)).toBe(true);
      expect(meta(REQUIRE_PERMISSION_KEY, name)).toBeUndefined();
    },
  );

  it.each(['accept', 'match'] as const)(
    '%s needs a session but no permission key — the invitation is the authority',
    (name) => {
      expect(meta(IS_PUBLIC_KEY, name)).toBeUndefined();
      expect(meta(REQUIRE_PERMISSION_KEY, name)).toBeUndefined();
    },
  );

  it('match asks the service about the CALLER, with the token from the query', async () => {
    const invitations = { match: jest.fn().mockResolvedValue({ matches: false }) };
    const controller = new StaffInvitationsController(
      invitations as unknown as StaffInvitationsService,
    );
    const caller = { id: 'u1', email: 'maria@example.com' } as AuthUser;

    await expect(controller.match({ token: 'tok' }, caller)).resolves.toEqual({ matches: false });
    expect(invitations.match).toHaveBeenCalledWith(caller, 'tok');
  });

  it('forwards the caller and the Origin header, never a role from the request', async () => {
    const invitations = { create: jest.fn().mockResolvedValue('ok') };
    const controller = new StaffInvitationsController(
      invitations as unknown as StaffInvitationsService,
    );
    const caller = { id: 'u1', role: 'ADMIN' } as AuthUser;

    await controller.create({ email: 'ana@example.com', role: 'COACH' }, caller, 'https://x');

    expect(invitations.create).toHaveBeenCalledWith(
      caller,
      { email: 'ana@example.com', role: 'COACH' },
      'https://x',
    );
  });
});
