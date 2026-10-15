import {
  PERMISSION_CATALOGUE,
  ROLE_PERMISSIONS,
  assertRequiresClosure,
  assertRequiresKeysExist,
} from './permission-registry';

/**
 * `booking.manage` — the desk adding a member to a class, or taking one out, on
 * their behalf (class-booking fixes, 2026-10-11).
 *
 * Its own file rather than a block in permission-registry.spec.ts, like
 * coach-tools-permissions.spec.ts, so parallel branches that add keys merge
 * without touching the same lines.
 */
describe('class booking keys', () => {
  const byKey = new Map(PERMISSION_CATALOGUE.map((def) => [def.key, def]));
  const holders = (key: string): Array<[string, string]> =>
    Object.entries(ROLE_PERMISSIONS).flatMap(([role, grants]) =>
      grants.filter((g) => g.key === key).map((g) => [role, g.scope] as [string, string]),
    );

  // It reads who is in the class and picks the person from the roster, so it
  // stands on both. Not dangerous: no money, no door, no role moves.
  it('defines booking.manage on top of booking.read and member.read, not dangerous', () => {
    const def = byKey.get('booking.manage');
    expect(def).toBeDefined();
    expect(def?.requires).toEqual(['booking.read', 'member.read']);
    expect(def?.isDangerous).toBe(false);
  });

  it('grants booking.manage to FRONT_DESK and ADMIN at ALL, and to nobody else', () => {
    expect(holders('booking.manage')).toEqual([
      ['FRONT_DESK', 'ALL'],
      ['ADMIN', 'ALL'],
    ]);
  });

  /**
   * The two widenings this key exists to avoid. A coach holds `booking.attend`
   * at ALL — any register, for substitutes — and that must stay "mark", never
   * "add or remove". A member holds `booking.create` at OWN, and the member
   * routes act only on the caller whatever the scope says.
   */
  it('gives COACH and CLIENT no way to add or remove somebody else', () => {
    expect(ROLE_PERMISSIONS.COACH.some((g) => g.key === 'booking.manage')).toBe(false);
    expect(ROLE_PERMISSIONS.CLIENT.some((g) => g.key === 'booking.manage')).toBe(false);
  });

  // Staff are not members here (2026-09-25): giving the desk the member's own
  // booking key would let staff book THEMSELVES through the member route.
  it('leaves booking.create with CLIENT alone, at OWN', () => {
    expect(holders('booking.create')).toEqual([['CLIENT', 'OWN']]);
  });

  it('keeps the requires closure intact with the new key', () => {
    expect(() => assertRequiresKeysExist(PERMISSION_CATALOGUE)).not.toThrow();
    expect(() => assertRequiresClosure(PERMISSION_CATALOGUE, ROLE_PERMISSIONS)).not.toThrow();
  });
});
