import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import {
  REQUIRE_PERMISSION_KEY,
  REQUIRE_PERMISSION_SCOPE_KEY,
  RequirePermission,
} from './decorators/require-permission.decorator';
import { PermissionsService } from './permissions.service';
import type { AuthUser } from '../auth/auth.types';

const ACTIVE_USER: AuthUser = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  supabaseId: '11111111-1111-1111-1111-111111111111',
  email: 'juan@example.com',
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  role: 'CLIENT',
  status: 'ACTIVE',
  permissionVersion: 0,
  heightCm: null,
  weightKg: null,
  deletedAt: null,
};

function contextWith(user?: AuthUser): { ctx: ExecutionContext; request: { user?: AuthUser } } {
  const request: { user?: AuthUser } = { user };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
  return { ctx, request };
}

describe('PermissionsGuard', () => {
  let guard: PermissionsGuard;
  let getEffectivePermissions: jest.Mock;
  let isPublic: boolean;
  let requiredKey: string | undefined;
  let requiredScope: 'ALL' | undefined;

  beforeEach(() => {
    isPublic = false;
    requiredKey = undefined;
    requiredScope = undefined;
    getEffectivePermissions = jest.fn().mockResolvedValue([
      { key: 'checkin.self', scope: 'OWN' },
      { key: 'announcement.read', scope: 'ALL' },
    ]);

    const reflector = {
      getAllAndOverride: (key: string) =>
        key === 'isPublic'
          ? isPublic
          : key === REQUIRE_PERMISSION_SCOPE_KEY
            ? requiredScope
            : requiredKey,
    } as unknown as Reflector;

    guard = new PermissionsGuard(reflector, {
      getEffectivePermissions,
    } as unknown as PermissionsService);
  });

  it('allows a route with no @RequirePermission', async () => {
    const { ctx } = contextWith(ACTIVE_USER);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(getEffectivePermissions).not.toHaveBeenCalled();
  });

  it('allows a @Public() route that carries no @RequirePermission', async () => {
    isPublic = true;
    const { ctx } = contextWith(undefined);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(getEffectivePermissions).not.toHaveBeenCalled();
  });

  it('throws when @Public() and @RequirePermission() are on the same route', async () => {
    isPublic = true;
    requiredKey = 'member.delete';
    const { ctx } = contextWith(undefined);
    await expect(guard.canActivate(ctx)).rejects.toThrow(
      "@Public() and @RequirePermission('member.delete') on the same route — remove one",
    );
    expect(getEffectivePermissions).not.toHaveBeenCalled();
  });

  it('allows a user who holds the required permission', async () => {
    requiredKey = 'checkin.self';
    const { ctx } = contextWith(ACTIVE_USER);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(getEffectivePermissions).toHaveBeenCalledWith(ACTIVE_USER);
  });

  it('rejects a user who lacks the required permission', async () => {
    requiredKey = 'member.delete';
    const { ctx } = contextWith(ACTIVE_USER);
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('stashes the matched permission on the request so the handler can scope', async () => {
    requiredKey = 'checkin.self';
    const { ctx, request } = contextWith(ACTIVE_USER);

    await guard.canActivate(ctx);

    expect((request as { permission?: unknown }).permission).toEqual({
      key: 'checkin.self',
      scope: 'OWN',
    });
  });

  it('stashes the widest grant when a key is held at two scopes', async () => {
    requiredKey = 'coach.read';
    getEffectivePermissions.mockResolvedValue([
      { key: 'coach.read', scope: 'OWN' },
      { key: 'coach.read', scope: 'ALL' },
    ]);
    const { ctx, request } = contextWith(ACTIVE_USER);

    await guard.canActivate(ctx);

    expect((request as { permission?: unknown }).permission).toEqual({
      key: 'coach.read',
      scope: 'ALL',
    });
  });

  it('throws if used on a route AuthGuard did not populate', async () => {
    requiredKey = 'checkin.self';
    const { ctx } = contextWith(undefined);
    await expect(guard.canActivate(ctx)).rejects.toThrow(
      '@RequirePermission() used on a route that AuthGuard did not populate',
    );
  });

  // ── Staff & Access: a route that needs the key at ALL ────────────────────
  //
  // The Super Admin's coaching view reads ANY member's progress. A coach holds
  // `progress.read` at OWN, and at OWN the route would still be "allowed" by
  // key alone — so the route states its reach, and an OWN grant is a 403.
  describe('with { scope: "ALL" }', () => {
    it('refuses a caller who holds the key only at OWN', async () => {
      requiredKey = 'checkin.self';
      requiredScope = 'ALL';
      const { ctx } = contextWith(ACTIVE_USER);
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Missing required permission: checkin.self at ALL',
      );
    });

    it('allows a caller who holds the key at ALL, and stashes that grant', async () => {
      requiredKey = 'announcement.read';
      requiredScope = 'ALL';
      const { ctx, request } = contextWith(ACTIVE_USER);

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect((request as { permission?: unknown }).permission).toEqual({
        key: 'announcement.read',
        scope: 'ALL',
      });
    });
  });

  describe('RequirePermission()', () => {
    it('sets only the key when no scope is asked for — every existing route unchanged', () => {
      class Probe {
        handler(): void {}
      }
      const descriptor = Object.getOwnPropertyDescriptor(Probe.prototype, 'handler');
      RequirePermission('member.read')(Probe.prototype, 'handler', descriptor!);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const handler = Probe.prototype.handler;
      expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler)).toBe('member.read');
      expect(Reflect.getMetadata(REQUIRE_PERMISSION_SCOPE_KEY, handler)).toBeUndefined();
    });

    it('records the scope beside the key when one is asked for', () => {
      class Probe {
        handler(): void {}
      }
      const descriptor = Object.getOwnPropertyDescriptor(Probe.prototype, 'handler');
      RequirePermission('progress.read', { scope: 'ALL' })(Probe.prototype, 'handler', descriptor!);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const handler = Probe.prototype.handler;
      expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler)).toBe('progress.read');
      expect(Reflect.getMetadata(REQUIRE_PERMISSION_SCOPE_KEY, handler)).toBe('ALL');
    });
  });
});
