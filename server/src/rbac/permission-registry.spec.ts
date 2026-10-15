import type { PermissionDefinition } from './permission-registry';
import {
  PERMISSION_CATALOGUE,
  ROLE_PERMISSIONS,
  assertRequiresClosure,
  assertRequiresKeysExist,
  deriveResourceAction,
} from './permission-registry';

describe('deriveResourceAction', () => {
  it('splits a two-part key on its only dot', () => {
    expect(deriveResourceAction('member.read')).toEqual({ resource: 'member', action: 'read' });
  });

  it('splits a three-part key on the first and last dot', () => {
    expect(deriveResourceAction('checkin.station_token.issue')).toEqual({
      resource: 'checkin',
      action: 'issue',
    });
  });
});

describe('PERMISSION_CATALOGUE', () => {
  const keys = new Set(PERMISSION_CATALOGUE.map((p) => p.key));

  it('has no duplicate keys', () => {
    expect(keys.size).toBe(PERMISSION_CATALOGUE.length);
  });

  it('every requires entry points at a real catalogue key', () => {
    for (const def of PERMISSION_CATALOGUE) {
      for (const req of def.requires) {
        expect(keys.has(req)).toBe(true);
      }
    }
  });

  // `define()` throws on a dotless key at module load, so this asserts the
  // invariant holds rather than the throw itself — a violation would take
  // down every suite that imports the registry.
  it('every key is dotted, so resource and action are distinct', () => {
    for (const def of PERMISSION_CATALOGUE) {
      expect(def.key).toContain('.');
      expect(def.resource).not.toBe(def.key);
    }
  });

  it('resource/action match what deriveResourceAction produces from the key', () => {
    for (const def of PERMISSION_CATALOGUE) {
      expect(deriveResourceAction(def.key)).toEqual({ resource: def.resource, action: def.action });
    }
  });
});

describe('ROLE_PERMISSIONS', () => {
  const catalogueKeys = new Set(PERMISSION_CATALOGUE.map((p) => p.key));

  it('does not seed DEV — it bypasses the catalogue entirely', () => {
    expect(Object.keys(ROLE_PERMISSIONS)).not.toContain('DEV');
  });

  it('every granted key exists in the catalogue', () => {
    for (const grants of Object.values(ROLE_PERMISSIONS)) {
      for (const grant of grants) {
        expect(catalogueKeys.has(grant.key)).toBe(true);
      }
    }
  });

  it('grants no role the same key twice', () => {
    for (const grants of Object.values(ROLE_PERMISSIONS)) {
      const grantKeys = grants.map((g) => g.key);
      expect(new Set(grantKeys).size).toBe(grantKeys.length);
    }
  });

  // CoachAssignmentsService.end() is unscoped-by-id-safe today only because
  // no role holds coach.update at OWN — see the fix-wave report's §4 for the
  // full argument. The obvious next grant (COACH at OWN, mirroring
  // coach.read) would let any coach end any assignment row by id. This test
  // exists so that widening trips a test failure instead of shipping silently.
  it('grants coach.update only at ALL, never at OWN', () => {
    for (const grants of Object.values(ROLE_PERMISSIONS)) {
      const grant = grants.find((g) => g.key === 'coach.update');
      if (grant) {
        expect(grant.scope).toBe('ALL');
      }
    }
  });

  /**
   * Owner decision: only the member's ASSIGNED coach records their progress —
   * not admins, not the desk. `OWN` is what makes "assigned" true: the routes
   * resolve it through the `coachedMember` scope, which has no self branch.
   *
   * A grant at ALL, or to any other role, is exactly the widening this test
   * exists to trip: an ADMIN holding `progress.record` at ALL could write any
   * member's weight history with no assignment at all. (D1: an ADMIN who is
   * assigned as a coach through the API still cannot record — the key, not
   * the assignment, is what opens the route.)
   */
  // `progress.self` is excluded: it is the member's OWN "My Progress" nav key,
  // opens no route, and reaches nobody else's record — see the self-service
  // keys below.
  it('grants progress.* only to COACH and only at OWN', () => {
    for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
      const progress = grants.filter(
        (g) => g.key.startsWith('progress.') && g.key !== 'progress.self',
      );
      if (role === 'COACH') {
        expect(progress).toEqual([
          { key: 'progress.read', scope: 'OWN' },
          { key: 'progress.record', scope: 'OWN' },
        ]);
      } else {
        expect(progress).toEqual([]);
      }
    }
  });

  it('defines progress.read on top of coach.read, and progress.record on top of progress.read', () => {
    const byKey = new Map(PERMISSION_CATALOGUE.map((def) => [def.key, def]));
    expect(byKey.get('progress.read')?.requires).toEqual(['coach.read']);
    expect(byKey.get('progress.record')?.requires).toEqual(['progress.read']);
    expect(byKey.get('progress.read')?.isDangerous).toBe(false);
    expect(byKey.get('progress.record')?.isDangerous).toBe(false);
  });
});

/**
 * The 2026-09-25 roles round: four keys, decided by the owner.
 *
 * - `revenue.read` takes Revenue away from the front desk while Reports stays
 *   exactly as it is. It sits ON TOP of `payment.read` (the desk keeps that —
 *   `shift.manage`, Payments, the GCash queue and receipts all hang off it).
 * - The three `*.self` keys are the member's own portal sections. CLIENT holds
 *   them at OWN; coaches, the desk and admins do not, so those sections leave
 *   their portal nav. They gate navigation and page guards only — the /me/*
 *   routes behind them stay keyless.
 */
describe('roles round keys', () => {
  const byKey = new Map(PERMISSION_CATALOGUE.map((def) => [def.key, def]));
  const holders = (key: string): Array<[string, string]> =>
    Object.entries(ROLE_PERMISSIONS).flatMap(([role, grants]) =>
      grants.filter((g) => g.key === key).map((g) => [role, g.scope] as [string, string]),
    );

  it('defines revenue.read on top of payment.read, not dangerous', () => {
    const def = byKey.get('revenue.read');
    expect(def).toBeDefined();
    expect(def?.requires).toEqual(['payment.read']);
    expect(def?.isDangerous).toBe(false);
  });

  it('grants revenue.read to ADMIN at ALL and to nobody else', () => {
    expect(holders('revenue.read')).toEqual([['ADMIN', 'ALL']]);
  });

  it('keeps payment.read on FRONT_DESK — shift.manage and the till depend on it', () => {
    expect(ROLE_PERMISSIONS.FRONT_DESK.find((g) => g.key === 'payment.read')).toEqual({
      key: 'payment.read',
      scope: 'ALL',
    });
  });

  it.each(['membership.self', 'progress.self', 'coach.self'])(
    'defines %s with no prerequisite and grants it to CLIENT at OWN only',
    (key) => {
      const def = byKey.get(key);
      expect(def).toBeDefined();
      expect(def?.requires).toEqual([]);
      expect(def?.isDangerous).toBe(false);
      expect(holders(key)).toEqual([['CLIENT', 'OWN']]);
    },
  );

  it('keeps the requires closure intact with the new keys', () => {
    expect(() => assertRequiresKeysExist(PERMISSION_CATALOGUE)).not.toThrow();
    expect(() => assertRequiresClosure(PERMISSION_CATALOGUE, ROLE_PERMISSIONS)).not.toThrow();
  });
});

describe('assertRequiresKeysExist', () => {
  it('accepts the shipped catalogue', () => {
    expect(() => assertRequiresKeysExist(PERMISSION_CATALOGUE)).not.toThrow();
  });

  it('throws when a requires entry names no catalogue key', () => {
    const catalogue: PermissionDefinition[] = [
      {
        key: 'member.read',
        resource: 'member',
        action: 'read',
        description: 'View member profiles',
        isDangerous: false,
        requires: [],
      },
      {
        key: 'member.update',
        resource: 'member',
        action: 'update',
        description: 'Edit a member profile',
        isDangerous: false,
        // Typo: the real key is member.read. Silently ignored before this.
        requires: ['member.raed'],
      },
    ];
    expect(() => assertRequiresKeysExist(catalogue)).toThrow('member.raed');
  });
});

describe('assertRequiresClosure', () => {
  const catalogue: PermissionDefinition[] = [
    {
      key: 'coach.read',
      resource: 'coach',
      action: 'read',
      description: 'View coach assignments',
      isDangerous: false,
      requires: [],
    },
    {
      key: 'coach.assign',
      resource: 'coach',
      action: 'assign',
      description: 'Assign a member to a coach',
      isDangerous: false,
      requires: ['coach.read'],
    },
    {
      key: 'coach.transfer',
      resource: 'coach',
      action: 'transfer',
      description: 'Move a member between coaches',
      isDangerous: false,
      requires: ['coach.assign'],
    },
  ];

  it('accepts the shipped catalogue and its shipped grants', () => {
    expect(() => assertRequiresClosure(PERMISSION_CATALOGUE, ROLE_PERMISSIONS)).not.toThrow();
  });

  it('accepts a role holding a key together with its prerequisite', () => {
    const grants = {
      CLIENT: [],
      FRONT_DESK: [],
      COACH: [],
      ADMIN: [
        { key: 'coach.read', scope: 'ALL' as const },
        { key: 'coach.assign', scope: 'ALL' as const },
      ],
    };
    expect(() => assertRequiresClosure(catalogue, grants)).not.toThrow();
  });

  it('throws when a role holds a key but not its direct prerequisite', () => {
    const grants = {
      CLIENT: [],
      FRONT_DESK: [{ key: 'coach.assign', scope: 'ALL' as const }],
      COACH: [],
      ADMIN: [],
    };
    expect(() => assertRequiresClosure(catalogue, grants)).toThrow(
      'FRONT_DESK is granted "coach.assign" but not its prerequisite "coach.read"',
    );
  });

  it('throws when the missing prerequisite is one hop further out', () => {
    // coach.transfer -> coach.assign is held; coach.assign -> coach.read is not.
    const grants = {
      CLIENT: [],
      FRONT_DESK: [],
      COACH: [
        { key: 'coach.transfer', scope: 'OWN' as const },
        { key: 'coach.assign', scope: 'OWN' as const },
      ],
      ADMIN: [],
    };
    expect(() => assertRequiresClosure(catalogue, grants)).toThrow(
      'COACH is granted "coach.assign" but not its prerequisite "coach.read"',
    );
  });
});

describe('chunk 1 permission keys', () => {
  const byKey = new Map(PERMISSION_CATALOGUE.map((def) => [def.key, def]));

  const expected: ReadonlyArray<[string, boolean, string[]]> = [
    ['plan.read', false, []],
    ['plan.manage', false, ['plan.read']],
    // Gained `member.read` when `/admin/subscriptions` merged into
    // `/admin/members`: the only screen that renders a membership is now the
    // member roster, so the two keys travel together. Metadata for the
    // permissions admin screen — `requires` is not enforced at grant time.
    ['membership.read', false, ['member.read']],
    ['membership.sell', false, ['membership.read', 'payment.record']],
    ['membership.cancel.request', false, ['membership.read']],
    ['membership.freeze', false, ['membership.read']],
    ['membership.cancel', true, ['membership.read']],
    ['membership.term.adjust', true, ['membership.read']],
    ['membership.status.correct', true, ['membership.read']],
    ['membership.import', true, ['membership.read', 'member.create']],
    ['payment.read', false, []],
    ['payment.record', false, []],
    ['payment.discount.statutory', false, ['payment.record']],
    ['payment.discount.grant', false, ['payment.record']],
    ['payment.void', true, ['payment.read', 'payment.record']],
    ['shift.manage', false, ['payment.read']],
    ['job.run', true, []],
  ];

  it.each(expected)('%s carries its dangerous flag and requires', (key, isDangerous, requires) => {
    const def = byKey.get(key);
    expect(def).toBeDefined();
    expect(def?.isDangerous).toBe(isDangerous);
    expect(def?.requires).toEqual(requires);
  });

  it('adds exactly seventeen keys', () => {
    expect(expected).toHaveLength(17);
    for (const [key] of expected) expect(byKey.has(key)).toBe(true);
  });

  // The member's own membership and payment history is served by keyless
  // /me/* routes with a hard-coded userId, exactly like GET /me — so OWN never
  // has to mean two different things depending on the caller's role.
  //
  // `membership.self` is the one exception and gates no route: it is the nav
  // key that decides who sees "My Subscription" and "Pay / GCash" in the
  // portal. The /me/* routes behind those screens stay keyless.
  it('grants CLIENT no membership.* or payment.* key at all, bar the membership.self nav key', () => {
    for (const grant of ROLE_PERMISSIONS.CLIENT) {
      if (grant.key === 'membership.self') continue;
      expect(grant.key.startsWith('membership.')).toBe(false);
      expect(grant.key.startsWith('payment.')).toBe(false);
      expect(grant.key.startsWith('shift.')).toBe(false);
    }
  });

  it('grants plan.read to every seeded role at ALL', () => {
    for (const grants of Object.values(ROLE_PERMISSIONS)) {
      expect(grants.find((g) => g.key === 'plan.read')).toEqual({ key: 'plan.read', scope: 'ALL' });
    }
  });

  it('grants membership.read to COACH only at OWN', () => {
    expect(ROLE_PERMISSIONS.COACH.find((g) => g.key === 'membership.read')?.scope).toBe('OWN');
    expect(ROLE_PERMISSIONS.FRONT_DESK.find((g) => g.key === 'membership.read')?.scope).toBe('ALL');
    expect(ROLE_PERMISSIONS.ADMIN.find((g) => g.key === 'membership.read')?.scope).toBe('ALL');
  });

  // §5.6: this is the load-bearing rule — it moves the "no" off the desk and
  // onto the owner. FRONT_DESK holding it would make every freeze a one-tap yes.
  it('grants membership.freeze to ADMIN only, never FRONT_DESK', () => {
    expect(ROLE_PERMISSIONS.FRONT_DESK.some((g) => g.key === 'membership.freeze')).toBe(false);
    expect(ROLE_PERMISSIONS.ADMIN.some((g) => g.key === 'membership.freeze')).toBe(true);
  });

  it('grants the discretionary discount key to ADMIN only, the statutory one to FRONT_DESK too', () => {
    expect(ROLE_PERMISSIONS.FRONT_DESK.some((g) => g.key === 'payment.discount.statutory')).toBe(
      true,
    );
    expect(ROLE_PERMISSIONS.FRONT_DESK.some((g) => g.key === 'payment.discount.grant')).toBe(false);
    expect(ROLE_PERMISSIONS.ADMIN.some((g) => g.key === 'payment.discount.grant')).toBe(true);
  });

  it('keeps the requires closure intact for every seeded role', () => {
    expect(() => assertRequiresClosure(PERMISSION_CATALOGUE, ROLE_PERMISSIONS)).not.toThrow();
    expect(() => assertRequiresKeysExist(PERMISSION_CATALOGUE)).not.toThrow();
  });

  /**
   * An amend can RAISE a figure; a void can only remove one. So amend is
   * strictly more than void, and `requires: ['payment.void']` is what makes
   * `assertRequiresClosure` fail the seed loudly if a role is ever given the
   * correction without the reversal that underlies it.
   */
  describe('payment.amend and payment.archive', () => {
    const byKey = new Map(PERMISSION_CATALOGUE.map((def) => [def.key, def]));

    it('defines payment.amend as dangerous and requiring read + record + void', () => {
      const def = byKey.get('payment.amend');
      expect(def).toBeDefined();
      expect(def?.isDangerous).toBe(true);
      expect([...(def?.requires ?? [])].sort()).toEqual([
        'payment.read',
        'payment.record',
        'payment.void',
      ]);
    });

    // Not dangerous: it hides a row, it does not move a number. No report,
    // shift closure or BIR register reads `archivedAt`.
    it('defines payment.archive as not dangerous and requiring only payment.read', () => {
      const def = byKey.get('payment.archive');
      expect(def).toBeDefined();
      expect(def?.isDangerous).toBe(false);
      expect(def?.requires).toEqual(['payment.read']);
    });

    it('satisfies assertRequiresKeysExist and assertRequiresClosure with both keys present', () => {
      expect(() => assertRequiresKeysExist(PERMISSION_CATALOGUE)).not.toThrow();
      expect(() => assertRequiresClosure(PERMISSION_CATALOGUE, ROLE_PERMISSIONS)).not.toThrow();
    });

    /**
     * FRONT_DESK gets neither, for the same reason they do not get
     * `payment.void`: the desk's correction path is "void it and ring it
     * again in the open drawer", which reconciles because the money is in
     * front of them.
     */
    it('grants both to ADMIN at ALL and to FRONT_DESK not at all', () => {
      for (const key of ['payment.amend', 'payment.archive']) {
        expect(ROLE_PERMISSIONS.ADMIN.find((g) => g.key === key)).toEqual({ key, scope: 'ALL' });
        expect(ROLE_PERMISSIONS.FRONT_DESK.some((g) => g.key === key)).toBe(false);
        expect(ROLE_PERMISSIONS.COACH.some((g) => g.key === key)).toBe(false);
        expect(ROLE_PERMISSIONS.CLIENT.some((g) => g.key === key)).toBe(false);
      }
    });
  });
});

// ── Staff & Access (feat/staff-access) ──────────────────────────────────────
/**
 * Two keys, both ADMIN-only. DEV reaches both through its catalogue-wide
 * bypass, which is what makes the Super Admin the only account that can
 * invite another ADMIN: the key lets an ADMIN invite at all, and the role
 * hierarchy (`@got/shared`'s role-hierarchy) decides WHICH roles.
 *
 * `progress.read` stays COACH-at-OWN only (the progress block above): the
 * Super Admin's read-only coaching view reaches it at ALL through the DEV
 * bypass, never through a grant.
 */
describe('staff & access keys', () => {
  const byKey = new Map(PERMISSION_CATALOGUE.map((def) => [def.key, def]));
  const holders = (key: string): Array<[string, string]> =>
    Object.entries(ROLE_PERMISSIONS).flatMap(([role, grants]) =>
      grants.filter((g) => g.key === key).map((g) => [role, g.scope] as [string, string]),
    );

  it('defines staff.invite as dangerous, on top of member.read and role.change', () => {
    const def = byKey.get('staff.invite');
    expect(def).toBeDefined();
    expect(def?.isDangerous).toBe(true);
    expect([...(def?.requires ?? [])].sort()).toEqual(['member.read', 'role.change']);
  });

  it('defines coach.profile.update on top of coach.read, not dangerous', () => {
    const def = byKey.get('coach.profile.update');
    expect(def).toBeDefined();
    expect(def?.isDangerous).toBe(false);
    expect(def?.requires).toEqual(['coach.read']);
  });

  it.each(['staff.invite', 'coach.profile.update'])(
    'grants %s to ADMIN at ALL and to nobody else',
    (key) => {
      expect(holders(key)).toEqual([['ADMIN', 'ALL']]);
    },
  );

  it('keeps the requires closure intact with the new keys', () => {
    expect(() => assertRequiresKeysExist(PERMISSION_CATALOGUE)).not.toThrow();
    expect(() => assertRequiresClosure(PERMISSION_CATALOGUE, ROLE_PERMISSIONS)).not.toThrow();
  });
});
// ── end Staff & Access ──────────────────────────────────────────────────────
