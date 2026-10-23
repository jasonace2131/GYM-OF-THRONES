import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import type { AuthUser } from '../auth/auth.types';
import { DomainException } from '../common/exceptions/domain.exception';
import { ActiveMembershipGuard } from './active-membership.guard';
import {
  REQUIRE_ACTIVE_MEMBERSHIP_KEY,
  RequireActiveMembership,
} from './require-active-membership.decorator';
import type { MembershipService } from './membership.service';

function user(role: Role): AuthUser {
  return {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    supabaseId: '11111111-1111-1111-1111-111111111111',
    email: 'juan@example.com',
    firstName: 'Juan',
    lastName: 'Dela Cruz',
    role,
    status: 'ACTIVE',
    permissionVersion: 0,
    heightCm: null,
    weightKg: null,
    deletedAt: null,
  };
}

function contextWith(caller?: AuthUser): ExecutionContext {
  const request = { user: caller };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('ActiveMembershipGuard', () => {
  let required: boolean | undefined;
  let hasActiveMembership: jest.Mock;
  let guard: ActiveMembershipGuard;

  beforeEach(() => {
    required = true;
    hasActiveMembership = jest.fn().mockResolvedValue(true);
    const reflector = {
      getAllAndOverride: (key: string) =>
        key === REQUIRE_ACTIVE_MEMBERSHIP_KEY ? required : undefined,
    } as unknown as Reflector;
    guard = new ActiveMembershipGuard(reflector, {
      hasActiveMembership,
    } as unknown as MembershipService);
  });

  it('does nothing on a route without @RequireActiveMembership — reads stay open', async () => {
    required = undefined;
    await expect(guard.canActivate(contextWith(user('CLIENT')))).resolves.toBe(true);
    expect(hasActiveMembership).not.toHaveBeenCalled();
  });

  it('lets an active member through', async () => {
    await expect(guard.canActivate(contextWith(user('CLIENT')))).resolves.toBe(true);
    expect(hasActiveMembership).toHaveBeenCalledWith('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });

  it('refuses a member without an active membership: 403 MEMBERSHIP_REQUIRED', async () => {
    hasActiveMembership.mockResolvedValue(false);
    const caught = await guard.canActivate(contextWith(user('CLIENT'))).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(DomainException);
    const error = caught as DomainException;
    expect(error.code).toBe('MEMBERSHIP_REQUIRED');
    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.message).toBe('This needs an active membership.');
  });

  it('never asks about staff, who use these routes for their work', async () => {
    hasActiveMembership.mockResolvedValue(false);
    for (const role of ['FRONT_DESK', 'COACH', 'ADMIN', 'DEV'] as const) {
      await expect(guard.canActivate(contextWith(user(role)))).resolves.toBe(true);
    }
    expect(hasActiveMembership).not.toHaveBeenCalled();
  });

  it('throws a configuration error on a gated route AuthGuard did not populate', async () => {
    await expect(guard.canActivate(contextWith(undefined))).rejects.toThrow(
      /@RequireActiveMembership/,
    );
  });

  it('the decorator sets the metadata the guard reads', () => {
    class Probe {
      @RequireActiveMembership()
      route(): void {}
    }
    expect(Reflect.getMetadata(REQUIRE_ACTIVE_MEMBERSHIP_KEY, Probe.prototype.route)).toBe(true);
  });
});
