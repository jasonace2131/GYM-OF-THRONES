import { PERMISSIONS, isPermissionKey } from '@got/shared';
import { PERMISSION_CATALOGUE } from './permission-registry';

/**
 * `@got/shared`'s PERMISSIONS is the client's copy of the catalogue — the
 * client imports those constants instead of spelling keys as string literals.
 * The registry here stays the single source of truth (the seed reads it), so
 * this spec is what stops the two drifting: a key added to one and not the
 * other fails here, in both directions, before it can ship as a nav item that
 * gates on a key nobody holds.
 */
describe('shared PERMISSIONS constants', () => {
  const catalogueKeys = PERMISSION_CATALOGUE.map((def) => def.key).sort();
  const constantKeys: string[] = Object.values(PERMISSIONS).sort();

  it('names every catalogue key', () => {
    const missing = catalogueKeys.filter((key) => !constantKeys.includes(key));
    expect(missing).toEqual([]);
  });

  it('names nothing the catalogue does not define', () => {
    const extra = constantKeys.filter((key) => !catalogueKeys.includes(key));
    expect(extra).toEqual([]);
  });

  it('has exactly one constant per key', () => {
    expect(new Set(constantKeys).size).toBe(constantKeys.length);
    expect(constantKeys).toEqual(catalogueKeys);
  });

  // One mechanical naming rule, so nobody has to guess a constant's name:
  // `checkin.station_token.issue` is CHECKIN_STATION_TOKEN_ISSUE.
  it('names each constant after its key', () => {
    for (const [name, key] of Object.entries(PERMISSIONS)) {
      expect(name).toBe(key.toUpperCase().replace(/\./g, '_'));
    }
  });

  it('isPermissionKey accepts catalogue keys and rejects anything else', () => {
    for (const key of catalogueKeys) expect(isPermissionKey(key)).toBe(true);
    expect(isPermissionKey('member.raed')).toBe(false);
    expect(isPermissionKey('')).toBe(false);
  });
});
