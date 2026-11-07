import { ADMIN_LOCKED_PERMISSIONS, canEditRoleAccess, editableAccessRoles } from '@got/shared';
import { PERMISSION_CATALOGUE, ROLE_PERMISSIONS } from './permission-registry';
import type { PermissionGrant } from './permission-registry';
import {
  SCOPABLE_PERMISSION_KEYS,
  applyOverrides,
  checkRoleAccess,
  closeOverPrerequisites,
  diffGrants,
  overridesFor,
  type RoleAccessCheck,
} from './role-access';

const g = (key: string, scope: 'OWN' | 'ALL' = 'ALL'): PermissionGrant => ({ key, scope });
const ALL_AT_ALL = PERMISSION_CATALOGUE.map((def) => g(def.key));
const keysOf = (grants: PermissionGrant[]): string[] => grants.map((grant) => grant.key);

const check = (over: Partial<RoleAccessCheck>): ReturnType<typeof checkRoleAccess> =>
  checkRoleAccess({
    role: 'FRONT_DESK',
    before: ROLE_PERMISSIONS.FRONT_DESK,
    defaults: ROLE_PERMISSIONS.FRONT_DESK,
    desired: ROLE_PERMISSIONS.FRONT_DESK,
    catalogue: PERMISSION_CATALOGUE,
    actorHeld: ROLE_PERMISSIONS.ADMIN,
    confirm: false,
    ...over,
  });

describe('who may edit which role (owner, 2026-11-07)', () => {
  it('an Admin edits Front desk and Coach; the Super Admin also Admin and Member', () => {
    expect(editableAccessRoles('ADMIN')).toEqual(['FRONT_DESK', 'COACH']);
    expect(editableAccessRoles('DEV')).toEqual(['FRONT_DESK', 'COACH', 'ADMIN', 'CLIENT']);
    expect(editableAccessRoles('FRONT_DESK')).toEqual([]);
    expect(editableAccessRoles('COACH')).toEqual([]);
    expect(editableAccessRoles('CLIENT')).toEqual([]);
  });

  it('nobody edits the Super Admin, and an Admin never edits Admin or Member', () => {
    expect(canEditRoleAccess('DEV', 'DEV')).toBe(false);
    expect(canEditRoleAccess('ADMIN', 'ADMIN')).toBe(false);
    expect(canEditRoleAccess('ADMIN', 'CLIENT')).toBe(false);
  });
});

describe('ADMIN_LOCKED_PERMISSIONS', () => {
  it('are all real keys that ADMIN holds by default', () => {
    const admin = new Set(keysOf(ROLE_PERMISSIONS.ADMIN));
    for (const key of ADMIN_LOCKED_PERMISSIONS) expect(admin.has(key)).toBe(true);
  });

  it('are closed under prerequisites, so keeping them on never breaks a rule', () => {
    const locked = new Set(ADMIN_LOCKED_PERMISSIONS);
    for (const def of PERMISSION_CATALOGUE.filter((d) => locked.has(d.key))) {
      for (const req of def.requires) expect(locked.has(req)).toBe(true);
    }
  });
});

describe('SCOPABLE_PERMISSION_KEYS', () => {
  it('holds exactly the keys some role holds at OWN by default', () => {
    const own = new Set(
      Object.values(ROLE_PERMISSIONS)
        .flat()
        .filter((grant) => grant.scope === 'OWN')
        .map((grant) => grant.key),
    );
    expect([...SCOPABLE_PERMISSION_KEYS].sort()).toEqual([...own].sort());
    expect(SCOPABLE_PERMISSION_KEYS.has('payment.void')).toBe(false);
  });
});

describe('defaults + differences', () => {
  const defaults = [g('a.read'), g('b.read', 'OWN'), g('c.read')];

  it('stores only what differs, and laying it back over the defaults gives the set', () => {
    const desired = [g('a.read'), g('b.read', 'ALL'), g('d.read')];
    const overrides = overridesFor(defaults, desired);
    expect(overrides).toEqual([
      { key: 'b.read', scope: 'ALL' },
      { key: 'c.read', scope: null },
      { key: 'd.read', scope: 'ALL' },
    ]);
    expect(applyOverrides(defaults, overrides)).toEqual(desired);
  });

  it('stores nothing when the set is the defaults', () => {
    expect(overridesFor(defaults, [...defaults].reverse())).toEqual([]);
  });

  it('a permission added to the code later arrives with its default', () => {
    const overrides = overridesFor(defaults, [g('a.read')]);
    const nextDeploy = [...defaults, g('e.read')];
    expect(keysOf(applyOverrides(nextDeploy, overrides))).toEqual(['a.read', 'e.read']);
  });
});

describe('diffGrants', () => {
  it('names what was added, removed and changed in reach', () => {
    expect(diffGrants([g('a.x'), g('b.x', 'OWN')], [g('b.x', 'ALL'), g('c.x')])).toEqual({
      added: [g('c.x')],
      removed: ['a.x'],
      changed: [{ key: 'b.x', from: 'OWN', to: 'ALL' }],
    });
  });
});

describe('closeOverPrerequisites (the seed, fail-closed)', () => {
  it('drops a key whose prerequisite is gone, and whatever needed that key', () => {
    const live = ROLE_PERMISSIONS.ADMIN.filter((grant) => grant.key !== 'payment.read');
    const { kept, dropped } = closeOverPrerequisites(PERMISSION_CATALOGUE, live);
    expect(dropped).toContain('payment.void');
    expect(keysOf(kept)).not.toContain('payment.void');
    expect(keysOf(kept)).toContain('member.read');
  });

  it('leaves every default set alone', () => {
    for (const grants of Object.values(ROLE_PERMISSIONS)) {
      expect(closeOverPrerequisites(PERMISSION_CATALOGUE, grants).dropped).toEqual([]);
    }
  });
});

describe('checkRoleAccess', () => {
  it('lets an unchanged set through', () => {
    expect(check({})).toBeNull();
  });

  it('refuses a key that does not exist', () => {
    expect(check({ desired: [...ROLE_PERMISSIONS.FRONT_DESK, g('made.up')] })).toEqual({
      code: 'UNKNOWN_PERMISSION',
      keys: ['made.up'],
    });
  });

  it('refuses Own on a key the app does not scope', () => {
    const desired = ROLE_PERMISSIONS.FRONT_DESK.map((grant) =>
      grant.key === 'payment.read' ? g('payment.read', 'OWN') : grant,
    );
    expect(check({ desired })).toEqual({ code: 'SCOPE_NOT_SUPPORTED', keys: ['payment.read'] });
  });

  it('refuses a key without its prerequisites', () => {
    const desired = [g('payment.void')];
    expect(check({ desired })?.code).toBe('PREREQUISITE_MISSING');
  });

  it('refuses turning off a locked key for Admin, and only for Admin', () => {
    const withoutEditor = ROLE_PERMISSIONS.ADMIN.filter(
      (grant) => grant.key !== 'role.permissions.update',
    );
    expect(
      check({
        role: 'ADMIN',
        before: ROLE_PERMISSIONS.ADMIN,
        defaults: ROLE_PERMISSIONS.ADMIN,
        desired: withoutEditor,
        actorHeld: ALL_AT_ALL,
      }),
    ).toEqual({ code: 'LOCKED', keys: ['role.permissions.update'] });
  });

  it('refuses handing out a key the caller does not hold', () => {
    const actorHeld = ROLE_PERMISSIONS.ADMIN.filter((grant) => grant.key !== 'payment.void');
    const desired = [...ROLE_PERMISSIONS.FRONT_DESK, g('payment.void')];
    expect(check({ desired, actorHeld, confirm: true })).toEqual({
      code: 'ESCALATION',
      keys: ['payment.void'],
    });
  });

  it('lets a role keep a key the caller lacks: keeping is not handing out', () => {
    const actorHeld = ROLE_PERMISSIONS.ADMIN.filter(
      (grant) => grant.key !== ROLE_PERMISSIONS.FRONT_DESK[0].key,
    );
    expect(check({ actorHeld })).toBeNull();
  });

  it('lets a role get its own default back even when the caller lacks the key', () => {
    const coachOnly = ROLE_PERMISSIONS.COACH.find(
      (grant) => !keysOf(ROLE_PERMISSIONS.ADMIN).includes(grant.key),
    );
    expect(coachOnly).toBeDefined();
    const before = ROLE_PERMISSIONS.COACH.filter((grant) => grant.key !== coachOnly?.key);
    expect(
      check({
        role: 'COACH',
        before,
        defaults: ROLE_PERMISSIONS.COACH,
        desired: ROLE_PERMISSIONS.COACH,
        confirm: true,
      }),
    ).toBeNull();
  });

  it('asks for confirmation before granting a dangerous key', () => {
    const desired = [...ROLE_PERMISSIONS.FRONT_DESK, g('payment.void')];
    expect(check({ desired })).toEqual({ code: 'CONFIRM_REQUIRED', keys: ['payment.void'] });
    expect(check({ desired, confirm: true })).toBeNull();
  });

  it('removing a dangerous key needs no confirmation', () => {
    const before = ROLE_PERMISSIONS.ADMIN;
    const desired = before.filter((grant) => grant.key !== 'payment.amend');
    expect(
      check({ role: 'ADMIN', before, defaults: before, desired, actorHeld: ALL_AT_ALL }),
    ).toBeNull();
  });
});
