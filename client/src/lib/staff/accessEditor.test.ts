import { describe, expect, it } from 'vitest';
import type { PermissionCatalogue, PermissionDefinitionView } from './roleMatrix';
import {
  canGrant,
  changeCount,
  dangerousGrants,
  definitionsByKey,
  diffDraft,
  fromDraft,
  rowLock,
  toDraft,
  turnOff,
  turnOn,
  visibleGroups,
  type Draft,
} from './accessEditor';

const def = (
  key: string,
  description: string,
  requires: string[] = [],
  isDangerous = false,
): PermissionDefinitionView => ({
  key,
  resource: key.split('.')[0],
  action: key.split('.').pop() ?? '',
  description,
  isDangerous,
  requires,
});

const CATALOGUE: PermissionCatalogue = {
  payment: [
    def('payment.read', 'View payments'),
    def('payment.record', 'Record a payment'),
    def('payment.void', 'Void a recorded payment', ['payment.read', 'payment.record'], true),
    def(
      'payment.amend',
      'Correct a recorded payment',
      ['payment.read', 'payment.record', 'payment.void'],
      true,
    ),
  ],
  member: [def('member.read', 'View members')],
};
const DEFS = definitionsByKey(CATALOGUE);
const SCOPABLE = new Set(['member.read']);

describe('turnOn', () => {
  it('brings every prerequisite along, and says which', () => {
    const { draft, alsoOn } = turnOn({}, 'payment.amend', DEFS, {}, SCOPABLE);
    expect(Object.keys(draft).sort()).toEqual([
      'payment.amend',
      'payment.read',
      'payment.record',
      'payment.void',
    ]);
    expect(alsoOn).toEqual(['payment.read', 'payment.record', 'payment.void']);
  });

  it('starts a scoped key at Own, unless the role defaults it to All', () => {
    expect(turnOn({}, 'member.read', DEFS, {}, SCOPABLE).draft['member.read']).toBe('OWN');
    expect(
      turnOn({}, 'member.read', DEFS, { 'member.read': 'ALL' }, SCOPABLE).draft['member.read'],
    ).toBe('ALL');
    expect(turnOn({}, 'payment.read', DEFS, {}, SCOPABLE).draft['payment.read']).toBe('ALL');
  });
});

describe('turnOff', () => {
  it('takes whatever needs the key along, and says which', () => {
    const start = turnOn({}, 'payment.amend', DEFS, {}, SCOPABLE).draft;
    const { draft, alsoOff } = turnOff(start, 'payment.record', DEFS);
    expect(Object.keys(draft)).toEqual(['payment.read']);
    expect(alsoOff).toEqual(['payment.amend', 'payment.void']);
  });
});

describe('diffDraft', () => {
  it('counts added, removed and changed, and flags dangerous grants', () => {
    const before: Draft = { 'payment.read': 'ALL', 'member.read': 'OWN', 'payment.record': 'ALL' };
    const after: Draft = { 'payment.read': 'ALL', 'member.read': 'ALL', 'payment.void': 'ALL' };
    const change = diffDraft(before, { ...after, 'payment.record': 'ALL' });
    expect(change).toEqual({
      added: [{ key: 'payment.void', scope: 'ALL' }],
      removed: [],
      changed: [{ key: 'member.read', from: 'OWN', to: 'ALL' }],
    });
    expect(changeCount(change)).toBe(2);
    expect(dangerousGrants(change, DEFS)).toEqual(['payment.void']);
  });

  it('round-trips through the wire shape', () => {
    const grants = [
      { key: 'member.read', scope: 'OWN' as const },
      { key: 'payment.read', scope: 'ALL' as const },
    ];
    expect(fromDraft(toDraft(grants))).toEqual(grants);
  });
});

describe('who may switch what', () => {
  const admin: Draft = { 'payment.read': 'ALL', 'member.read': 'ALL' };

  it('lets the caller give what they hold, or the role its own default', () => {
    expect(canGrant('payment.read', 'ALL', admin, {})).toBe(true);
    expect(canGrant('progress.record', 'OWN', admin, {})).toBe(false);
    expect(canGrant('progress.record', 'OWN', admin, { 'progress.record': 'OWN' })).toBe(true);
    expect(canGrant('progress.record', 'ALL', admin, { 'progress.record': 'OWN' })).toBe(false);
  });

  it('locks the access keys on for Admin only, and greys what the caller cannot give', () => {
    expect(rowLock('ADMIN', 'role.permissions.update', true, admin, {})).toBe('locked');
    expect(rowLock('FRONT_DESK', 'role.permissions.update', true, admin, {})).toBeNull();
    expect(rowLock('FRONT_DESK', 'progress.record', false, admin, {})).toBe('not-yours');
    expect(rowLock('FRONT_DESK', 'progress.record', true, admin, {})).toBeNull();
  });
});

describe('visibleGroups', () => {
  it('filters by search, by "turned on" and by "changed"', () => {
    const draft: Draft = { 'payment.read': 'ALL' };
    expect(
      visibleGroups(CATALOGUE, 'void', 'all', draft, new Set()).map((g) => g.rows.length),
    ).toEqual([1]);
    expect(visibleGroups(CATALOGUE, '', 'on', draft, new Set())).toEqual([
      { resource: 'payment', rows: [CATALOGUE.payment[0]] },
    ]);
    expect(visibleGroups(CATALOGUE, '', 'changed', draft, new Set(['member.read']))).toEqual([
      { resource: 'member', rows: CATALOGUE.member },
    ]);
  });
});
