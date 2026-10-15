import {
  PERMISSION_CATALOGUE,
  ROLE_PERMISSIONS,
  assertRequiresClosure,
  assertRequiresKeysExist,
} from './permission-registry';

/**
 * The coach-tools keys (feat/coach-tools), as the owner approved them.
 *
 * Their own file rather than a block in permission-registry.spec.ts, so the
 * parallel roles-round branches that also add keys merge without touching the
 * same lines.
 */
describe('coach tools keys', () => {
  const byKey = new Map(PERMISSION_CATALOGUE.map((def) => [def.key, def]));
  const holders = (key: string): Array<[string, string]> =>
    Object.entries(ROLE_PERMISSIONS).flatMap(([role, grants]) =>
      grants.filter((g) => g.key === key).map((g) => [role, g.scope] as [string, string]),
    );

  it.each([
    // The chat itself. OWN for both sides: the subject is always the caller,
    // and a thread is theirs only as its coach or its member.
    [
      'chat.use',
      [],
      [
        ['CLIENT', 'OWN'],
        ['COACH', 'OWN'],
      ],
    ],
    // Reading a conversation somebody else had, for a complaint. ADMIN at ALL,
    // and every read is audited with a reason.
    ['chat.review', [], [['ADMIN', 'ALL']]],
    // Saving a member's plan is a coach act on an ASSIGNED member.
    ['workout.manage', ['coach.read'], [['COACH', 'OWN']]],
    // Suggesting one reads that member's goals and measurements to build the
    // prompt, so it stands on progress.read as well as on the save.
    ['workout.suggest', ['workout.manage', 'progress.read'], [['COACH', 'OWN']]],
    // The member's own "My workout plan" card.
    ['workout.self', [], [['CLIENT', 'OWN']]],
  ] as Array<[string, string[], Array<[string, string]>]>)(
    '%s requires %j and is granted to exactly %j',
    (key, requires, grants) => {
      const def = byKey.get(key);
      expect(def).toBeDefined();
      expect(def?.requires).toEqual(requires);
      expect(def?.isDangerous).toBe(false);
      expect(holders(key)).toEqual(grants);
    },
  );

  it('keeps the requires closure intact with the new keys', () => {
    expect(() => assertRequiresKeysExist(PERMISSION_CATALOGUE)).not.toThrow();
    expect(() => assertRequiresClosure(PERMISSION_CATALOGUE, ROLE_PERMISSIONS)).not.toThrow();
  });

  it('gives FRONT_DESK none of them — the desk is not a party to a coaching conversation', () => {
    const keys = ['chat.use', 'chat.review', 'workout.suggest', 'workout.manage', 'workout.self'];
    expect(ROLE_PERMISSIONS.FRONT_DESK.filter((g) => keys.includes(g.key))).toEqual([]);
  });
});
