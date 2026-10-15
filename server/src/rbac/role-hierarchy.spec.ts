import {
  ROLE_RANK,
  accountActionRefusal,
  assignableRoles,
  canAssignRole,
  canManageAccount,
  inviteRefusal,
  invitableRoles,
  roleChangeRefusal,
  type RoleName,
} from '@got/shared';

/**
 * The role hierarchy, as ONE pure module shared by the API (which enforces
 * it) and the console (which only offers what it would allow).
 *
 * Owner decisions (2026-09-25): the Super Admin is the existing DEV account;
 * only DEV creates, promotes or demotes ADMINs; ADMINs add members, front
 * desk and coaches, never another admin; nobody changes their own role; the
 * last active ADMIN cannot be demoted, suspended or deleted; DEV is never
 * assignable.
 */

const ADMIN_ID = 'admin-1';
const DEV_ID = 'dev-1';
const TARGET_ID = 'target-1';

const actor = (role: RoleName, id = role === 'DEV' ? DEV_ID : ADMIN_ID) => ({ id, role });
const target = (role: RoleName, active = true, id = TARGET_ID) => ({ id, role, active });

describe('ROLE_RANK', () => {
  it('ranks CLIENT < FRONT_DESK = COACH < ADMIN < DEV', () => {
    expect(ROLE_RANK.CLIENT).toBeLessThan(ROLE_RANK.FRONT_DESK);
    expect(ROLE_RANK.FRONT_DESK).toBe(ROLE_RANK.COACH);
    expect(ROLE_RANK.COACH).toBeLessThan(ROLE_RANK.ADMIN);
    expect(ROLE_RANK.ADMIN).toBeLessThan(ROLE_RANK.DEV);
  });
});

describe('canAssignRole', () => {
  it('lets an ADMIN assign only roles strictly below ADMIN', () => {
    expect(canAssignRole('ADMIN', 'CLIENT')).toBe(true);
    expect(canAssignRole('ADMIN', 'FRONT_DESK')).toBe(true);
    expect(canAssignRole('ADMIN', 'COACH')).toBe(true);
    expect(canAssignRole('ADMIN', 'ADMIN')).toBe(false);
  });

  it('lets DEV assign ADMIN — the Super Admin is who manages admins', () => {
    expect(canAssignRole('DEV', 'ADMIN')).toBe(true);
    expect(canAssignRole('DEV', 'COACH')).toBe(true);
  });

  it('never assigns DEV, not even from DEV', () => {
    expect(canAssignRole('DEV', 'DEV')).toBe(false);
    expect(canAssignRole('ADMIN', 'DEV')).toBe(false);
  });

  it('lets nobody below ADMIN assign a staff role', () => {
    expect(canAssignRole('FRONT_DESK', 'COACH')).toBe(false);
    expect(canAssignRole('COACH', 'FRONT_DESK')).toBe(false);
    expect(canAssignRole('CLIENT', 'CLIENT')).toBe(false);
  });
});

describe('assignableRoles / invitableRoles', () => {
  it('offers an ADMIN every role below theirs, and no ADMIN', () => {
    expect(assignableRoles('ADMIN')).toEqual(['CLIENT', 'FRONT_DESK', 'COACH']);
    expect(invitableRoles('ADMIN')).toEqual(['FRONT_DESK', 'COACH']);
  });

  it('offers DEV the ADMIN role too, and never DEV', () => {
    expect(assignableRoles('DEV')).toEqual(['CLIENT', 'FRONT_DESK', 'COACH', 'ADMIN']);
    expect(invitableRoles('DEV')).toEqual(['FRONT_DESK', 'COACH', 'ADMIN']);
  });

  it('offers a front-desk or coach account nothing staff-shaped', () => {
    expect(invitableRoles('FRONT_DESK')).toEqual([]);
    expect(invitableRoles('COACH')).toEqual([]);
    expect(assignableRoles('COACH')).toEqual(['CLIENT']);
  });
});

describe('canManageAccount', () => {
  it('reaches only accounts strictly below the actor', () => {
    expect(canManageAccount('ADMIN', 'COACH')).toBe(true);
    expect(canManageAccount('ADMIN', 'ADMIN')).toBe(false);
    expect(canManageAccount('DEV', 'ADMIN')).toBe(true);
  });

  it('never reaches a DEV account', () => {
    expect(canManageAccount('DEV', 'DEV')).toBe(false);
  });
});

describe('roleChangeRefusal', () => {
  it('refuses changing your own role, first', () => {
    expect(
      roleChangeRefusal({
        actor: actor('DEV'),
        target: target('DEV', true, DEV_ID),
        newRole: 'CLIENT',
        activeAdmins: 1,
      }),
    ).toBe('SELF');
  });

  it('refuses touching a DEV account', () => {
    expect(
      roleChangeRefusal({ actor: actor('DEV'), target: target('DEV'), newRole: 'ADMIN' }),
    ).toBe('DEV_PROTECTED');
  });

  it('refuses an ADMIN promoting somebody to ADMIN', () => {
    expect(
      roleChangeRefusal({ actor: actor('ADMIN'), target: target('COACH'), newRole: 'ADMIN' }),
    ).toBe('ROLE_NOT_ASSIGNABLE');
  });

  it('allows DEV promoting somebody to ADMIN', () => {
    expect(
      roleChangeRefusal({ actor: actor('DEV'), target: target('COACH'), newRole: 'ADMIN' }),
    ).toBeNull();
  });

  it('refuses an ADMIN demoting another ADMIN — the target outranks them', () => {
    expect(
      roleChangeRefusal({
        actor: actor('ADMIN'),
        target: target('ADMIN'),
        newRole: 'CLIENT',
        activeAdmins: 3,
      }),
    ).toBe('TARGET_OUTRANKS');
  });

  it('allows an ADMIN moving a member to coach, and a coach to front desk', () => {
    expect(
      roleChangeRefusal({ actor: actor('ADMIN'), target: target('CLIENT'), newRole: 'COACH' }),
    ).toBeNull();
    expect(
      roleChangeRefusal({ actor: actor('ADMIN'), target: target('COACH'), newRole: 'FRONT_DESK' }),
    ).toBeNull();
  });

  it('refuses assigning DEV, even from DEV', () => {
    expect(
      roleChangeRefusal({
        actor: actor('DEV'),
        target: target('ADMIN'),
        newRole: 'DEV',
        activeAdmins: 2,
      }),
    ).toBe('ROLE_NOT_ASSIGNABLE');
  });

  it('refuses DEV demoting the last active ADMIN', () => {
    expect(
      roleChangeRefusal({
        actor: actor('DEV'),
        target: target('ADMIN'),
        newRole: 'COACH',
        activeAdmins: 1,
      }),
    ).toBe('LAST_ADMIN');
  });

  it('allows DEV demoting an ADMIN while another active ADMIN remains', () => {
    expect(
      roleChangeRefusal({
        actor: actor('DEV'),
        target: target('ADMIN'),
        newRole: 'COACH',
        activeAdmins: 2,
      }),
    ).toBeNull();
  });

  it('does not count a suspended ADMIN as the last active one', () => {
    // The target is not active, so demoting them removes no active admin.
    expect(
      roleChangeRefusal({
        actor: actor('DEV'),
        target: target('ADMIN', false),
        newRole: 'CLIENT',
        activeAdmins: 1,
      }),
    ).toBeNull();
  });

  it('skips the last-admin rule when the count is unknown (the console) — the server has it', () => {
    expect(
      roleChangeRefusal({ actor: actor('DEV'), target: target('ADMIN'), newRole: 'COACH' }),
    ).toBeNull();
  });
});

describe('accountActionRefusal', () => {
  it.each(['suspend', 'delete', 'reactivate', 'restore'] as const)(
    'refuses %s on your own account',
    (action) => {
      expect(
        accountActionRefusal({
          actor: actor('ADMIN'),
          target: target('ADMIN', true, ADMIN_ID),
          action,
        }),
      ).toBe('SELF');
    },
  );

  it.each(['suspend', 'delete'] as const)('refuses %s on a DEV account', (action) => {
    expect(accountActionRefusal({ actor: actor('ADMIN'), target: target('DEV'), action })).toBe(
      'DEV_PROTECTED',
    );
  });

  it.each(['suspend', 'delete', 'reactivate', 'restore'] as const)(
    'refuses an ADMIN %s-ing another ADMIN',
    (action) => {
      expect(
        accountActionRefusal({
          actor: actor('ADMIN'),
          target: target('ADMIN'),
          action,
          activeAdmins: 4,
        }),
      ).toBe('TARGET_OUTRANKS');
    },
  );

  it.each(['suspend', 'delete'] as const)('refuses DEV %s-ing the last active ADMIN', (action) => {
    expect(
      accountActionRefusal({
        actor: actor('DEV'),
        target: target('ADMIN'),
        action,
        activeAdmins: 1,
      }),
    ).toBe('LAST_ADMIN');
  });

  it('allows DEV suspending an ADMIN while another remains', () => {
    expect(
      accountActionRefusal({
        actor: actor('DEV'),
        target: target('ADMIN'),
        action: 'suspend',
        activeAdmins: 2,
      }),
    ).toBeNull();
  });

  it('never applies the last-admin rule to reactivate or restore — they ADD an admin', () => {
    expect(
      accountActionRefusal({
        actor: actor('DEV'),
        target: target('ADMIN', false),
        action: 'reactivate',
        activeAdmins: 0,
      }),
    ).toBeNull();
  });

  it('allows an ADMIN suspending a member, a coach or the front desk', () => {
    for (const role of ['CLIENT', 'COACH', 'FRONT_DESK'] as const) {
      expect(
        accountActionRefusal({ actor: actor('ADMIN'), target: target(role), action: 'suspend' }),
      ).toBeNull();
    }
  });
});

describe('inviteRefusal', () => {
  it('lets an ADMIN invite front desk and coaches', () => {
    expect(inviteRefusal({ inviter: 'ADMIN', role: 'COACH' })).toBeNull();
    expect(inviteRefusal({ inviter: 'ADMIN', role: 'FRONT_DESK' })).toBeNull();
  });

  it('refuses an ADMIN inviting an ADMIN, and lets DEV do it', () => {
    expect(inviteRefusal({ inviter: 'ADMIN', role: 'ADMIN' })).toBe('ROLE_NOT_INVITABLE');
    expect(inviteRefusal({ inviter: 'DEV', role: 'ADMIN' })).toBeNull();
  });

  it('never invites a CLIENT (they register) or a DEV (seed only)', () => {
    expect(inviteRefusal({ inviter: 'DEV', role: 'CLIENT' })).toBe('ROLE_NOT_INVITABLE');
    expect(inviteRefusal({ inviter: 'DEV', role: 'DEV' })).toBe('ROLE_NOT_INVITABLE');
  });

  it('promotes an existing member, and moves front desk to coach', () => {
    expect(inviteRefusal({ inviter: 'ADMIN', role: 'COACH', existing: 'CLIENT' })).toBeNull();
    expect(inviteRefusal({ inviter: 'ADMIN', role: 'COACH', existing: 'FRONT_DESK' })).toBeNull();
  });

  it('refuses an invitation to the role the account already holds', () => {
    expect(inviteRefusal({ inviter: 'ADMIN', role: 'COACH', existing: 'COACH' })).toBe(
      'ALREADY_HAS_ROLE',
    );
  });

  it('refuses an invitation that would demote — an invite only ever promotes', () => {
    expect(inviteRefusal({ inviter: 'DEV', role: 'COACH', existing: 'ADMIN' })).toBe(
      'WOULD_DEMOTE',
    );
    expect(inviteRefusal({ inviter: 'DEV', role: 'ADMIN', existing: 'DEV' })).toBe('WOULD_DEMOTE');
  });
});
