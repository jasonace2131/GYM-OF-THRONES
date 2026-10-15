import { describe, expect, it } from 'vitest';
import {
  accountActionAvailability,
  countActiveAdmins,
  roleChangeAvailability,
  roleOptionsFor,
  toRoleName,
} from './staffRules';

const ADMIN = { id: 'admin-1', role: 'ADMIN' };
const DEV = { id: 'dev-1', role: 'DEV' };

const row = (
  role: string,
  overrides: Partial<{ id: string; status: string; deletedAt: string | null }> = {},
) => ({
  id: 'target-1',
  role,
  status: 'ACTIVE',
  deletedAt: null,
  ...overrides,
});

describe('toRoleName', () => {
  it('narrows a known role and refuses anything else', () => {
    expect(toRoleName('COACH')).toBe('COACH');
    expect(toRoleName('SUPERUSER')).toBeNull();
    expect(toRoleName(undefined)).toBeNull();
  });
});

describe('countActiveAdmins', () => {
  it('counts ADMIN rows that are active and not deleted', () => {
    expect(
      countActiveAdmins([
        row('ADMIN', { id: 'a' }),
        row('ADMIN', { id: 'b', status: 'SUSPENDED' }),
        row('ADMIN', { id: 'c', deletedAt: '2026-09-01T00:00:00.000Z' }),
        row('DEV', { id: 'd' }),
        row('COACH', { id: 'e' }),
      ]),
    ).toBe(1);
  });
});

describe('roleChangeAvailability', () => {
  it('is hidden without role.change', () => {
    expect(roleChangeAvailability(ADMIN, row('COACH'), { canChange: false })).toEqual({
      state: 'hidden',
    });
  });

  it('is enabled for an ADMIN on a coach', () => {
    expect(roleChangeAvailability(ADMIN, row('COACH'), { canChange: true })).toEqual({
      state: 'enabled',
    });
  });

  it('is DISABLED WITH A REASON on your own row', () => {
    const result = roleChangeAvailability(ADMIN, row('ADMIN', { id: ADMIN.id }), {
      canChange: true,
    });
    expect(result.state).toBe('disabled');
    expect(result).toHaveProperty('reason', expect.stringMatching(/your own/i));
  });

  it('is HIDDEN for an ADMIN on another ADMIN — they can never do it', () => {
    expect(roleChangeAvailability(ADMIN, row('ADMIN'), { canChange: true })).toEqual({
      state: 'hidden',
    });
  });

  it('is hidden on the Super Admin account', () => {
    expect(roleChangeAvailability(DEV, row('DEV'), { canChange: true })).toEqual({
      state: 'hidden',
    });
  });

  it('is DISABLED WITH A REASON on the last active admin', () => {
    const result = roleChangeAvailability(DEV, row('ADMIN'), { canChange: true, activeAdmins: 1 });
    expect(result.state).toBe('disabled');
    expect(result).toHaveProperty('reason', expect.stringMatching(/last active admin/i));
  });

  it('is enabled for DEV on an admin while another admin remains', () => {
    expect(roleChangeAvailability(DEV, row('ADMIN'), { canChange: true, activeAdmins: 2 })).toEqual(
      { state: 'enabled' },
    );
  });

  it('is hidden while the caller is unknown — fail closed', () => {
    expect(roleChangeAvailability(null, row('COACH'), { canChange: true })).toEqual({
      state: 'hidden',
    });
  });
});

describe('accountActionAvailability', () => {
  it('disables suspend on your own row, with a reason', () => {
    const result = accountActionAvailability(ADMIN, row('ADMIN', { id: ADMIN.id }), 'suspend', {
      allowed: true,
    });
    expect(result.state).toBe('disabled');
  });

  it('hides suspend for an ADMIN on another ADMIN', () => {
    expect(accountActionAvailability(ADMIN, row('ADMIN'), 'suspend', { allowed: true })).toEqual({
      state: 'hidden',
    });
  });

  it('disables suspend and delete on the last active admin, for the Super Admin', () => {
    for (const action of ['suspend', 'delete'] as const) {
      const result = accountActionAvailability(DEV, row('ADMIN'), action, {
        allowed: true,
        activeAdmins: 1,
      });
      expect(result.state).toBe('disabled');
      expect(result).toHaveProperty('reason', expect.stringMatching(/last active admin/i));
    }
  });

  it('never disables reactivate for the last-admin reason — it adds an admin', () => {
    expect(
      accountActionAvailability(DEV, row('ADMIN', { status: 'SUSPENDED' }), 'reactivate', {
        allowed: true,
        activeAdmins: 0,
      }),
    ).toEqual({ state: 'enabled' });
  });

  it('is hidden without the permission', () => {
    expect(accountActionAvailability(ADMIN, row('CLIENT'), 'delete', { allowed: false })).toEqual({
      state: 'hidden',
    });
  });
});

describe('roleOptionsFor', () => {
  it('offers an ADMIN member, front desk and coach — never admin', () => {
    expect(roleOptionsFor('ADMIN').map((o) => o.value)).toEqual(['CLIENT', 'FRONT_DESK', 'COACH']);
  });

  it('offers the Super Admin admin too, and never Super Admin', () => {
    expect(roleOptionsFor('DEV').map((o) => o.value)).toEqual([
      'CLIENT',
      'FRONT_DESK',
      'COACH',
      'ADMIN',
    ]);
  });

  it('labels roles in the console words', () => {
    expect(roleOptionsFor('DEV').map((o) => o.label)).toEqual([
      'Member',
      'Front desk',
      'Coach',
      'Admin',
    ]);
  });

  it('offers nothing to an unknown caller', () => {
    expect(roleOptionsFor(null)).toEqual([]);
  });
});
