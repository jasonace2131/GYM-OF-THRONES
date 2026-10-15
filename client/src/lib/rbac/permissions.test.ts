import { describe, expect, it } from 'vitest';
import { canAll, canAny, hasPermission, type HeldPermission } from './permissions';

const COACH: HeldPermission[] = [
  { key: 'member.read', scope: 'OWN' },
  { key: 'coach.read', scope: 'OWN' },
  { key: 'class.read', scope: 'ALL' },
];

const ADMIN: HeldPermission[] = [
  { key: 'member.read', scope: 'ALL' },
  { key: 'coach.read', scope: 'ALL' },
  { key: 'payment.read', scope: 'ALL' },
];

describe('hasPermission', () => {
  it('matches any grant of the key by default', () => {
    expect(hasPermission(COACH, 'member.read')).toBe(true);
    expect(hasPermission(ADMIN, 'member.read')).toBe(true);
    expect(hasPermission(COACH, 'payment.read')).toBe(false);
  });

  it("treats scope 'ANY' as the default", () => {
    expect(hasPermission(COACH, 'member.read', { scope: 'ANY' })).toBe(true);
    expect(hasPermission(COACH, 'payment.read', { scope: 'ANY' })).toBe(false);
  });

  /**
   * THE COACH CASE. A coach holds member.read at OWN so they can read their
   * own profile; a scope-blind test calls every coach staff. ALL is how a
   * screen that lists everybody says so.
   */
  it("requires an ALL grant for scope 'ALL'", () => {
    expect(hasPermission(COACH, 'member.read', { scope: 'ALL' })).toBe(false);
    expect(hasPermission(ADMIN, 'member.read', { scope: 'ALL' })).toBe(true);
  });

  it("accepts either grant for scope 'OWN' — ALL reaches your own rows too", () => {
    expect(hasPermission(COACH, 'coach.read', { scope: 'OWN' })).toBe(true);
    expect(hasPermission(ADMIN, 'coach.read', { scope: 'OWN' })).toBe(true);
    expect(hasPermission(COACH, 'payment.read', { scope: 'OWN' })).toBe(false);
  });

  /**
   * A grant with no scope counts as ALL. That is the direction safeNext has
   * always leaned: if a presenter ever stops sending scope, staff stay staff
   * rather than every admin being demoted to the member portal.
   */
  it('treats a grant with no scope as ALL', () => {
    expect(hasPermission([{ key: 'member.read' }], 'member.read', { scope: 'ALL' })).toBe(true);
  });

  it('holds when any one of several grants of the key reaches far enough', () => {
    const mixed = [
      { key: 'member.read', scope: 'OWN' },
      { key: 'member.read', scope: 'ALL' },
    ];
    expect(hasPermission(mixed, 'member.read', { scope: 'ALL' })).toBe(true);
  });

  /** Deny while loading: an unresolved permission set holds nothing. */
  it('denies everything while the permission set is null or undefined', () => {
    expect(hasPermission(null, 'member.read')).toBe(false);
    expect(hasPermission(undefined, 'member.read')).toBe(false);
    expect(hasPermission([], 'member.read')).toBe(false);
  });
});

describe('canAll / canAny', () => {
  it('canAll needs every requirement', () => {
    expect(canAll(ADMIN, ['member.read', 'payment.read'])).toBe(true);
    expect(canAll(COACH, ['member.read', 'payment.read'])).toBe(false);
  });

  it('canAny needs one requirement', () => {
    expect(canAny(COACH, ['member.read', 'payment.read'])).toBe(true);
    expect(canAny(COACH, ['payment.read', 'audit.read'])).toBe(false);
  });

  it('accepts a requirement with its own scope', () => {
    expect(canAll(COACH, [{ permission: 'member.read', scope: 'ALL' }])).toBe(false);
    expect(canAll(ADMIN, [{ permission: 'member.read', scope: 'ALL' }, 'coach.read'])).toBe(true);
    expect(canAny(COACH, [{ permission: 'member.read', scope: 'ALL' }, 'class.read'])).toBe(true);
  });

  it('is vacuous on an empty list the way every/some are', () => {
    expect(canAll(COACH, [])).toBe(true);
    expect(canAny(COACH, [])).toBe(false);
  });

  it('denies while loading', () => {
    expect(canAll(null, ['member.read'])).toBe(false);
    expect(canAny(null, ['member.read'])).toBe(false);
  });
});
