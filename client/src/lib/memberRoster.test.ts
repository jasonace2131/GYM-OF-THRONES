import { describe, expect, it } from 'vitest';
// A TS string enum is NOMINAL — the literal 'FROZEN' is not assignable to it,
// and vitest would never have said so (only `tsc` catches this).
import { MembershipStatus } from '@got/shared';
import {
  PAGE_SIZE,
  STANDING_FILTERS,
  cancellingNote,
  countsParamsFor,
  defaultSortFor,
  emptyRosterState,
  listParamsFor,
  queryKeyFor,
  resolveSort,
  standingFromParam,
  sortFromParam,
  storedStatusNote,
  type RosterState,
} from './memberRoster';
import type { MemberListItem } from './adminApi';

function state(overrides: Partial<RosterState> = {}): RosterState {
  return { ...emptyRosterState, ...overrides };
}

type Membership = MemberListItem['membership'];

function membership(overrides: Partial<NonNullable<Membership>> = {}): Membership {
  return {
    id: 'mem-1',
    planCode: 'MONTHLY',
    planName: 'Monthly',
    status: MembershipStatus.ACTIVE,
    startsOn: '2026-08-01',
    endsOn: '2026-09-14',
    daysRemaining: 12,
    cancelRequestedOn: null,
    ...overrides,
  } as NonNullable<Membership>;
}

describe('STANDING_FILTERS', () => {
  it('opens on All and keeps Deleted last — it is an admin escape hatch, not a standing', () => {
    expect(STANDING_FILTERS[0].value).toBe('');
    expect(STANDING_FILTERS[STANDING_FILTERS.length - 1].value).toBe('DELETED');
  });

  it('offers the five the server understands plus All', () => {
    expect(STANDING_FILTERS.map((chip) => chip.value)).toEqual([
      '',
      'ACTIVE',
      'EXPIRING',
      'EXPIRED',
      'NONE',
      'DELETED',
    ]);
  });
});

/**
 * The sort is DERIVED from the filter so that one click on "Expiring soon"
 * produces the renewal call sheet in call-sheet order — which is what the
 * merged-away Subscriptions screen did for a living.
 */
describe('defaultSortFor', () => {
  it('gives the call sheet its own order for the two standings that are one', () => {
    expect(defaultSortFor('EXPIRING')).toBe('ending');
    expect(defaultSortFor('EXPIRED')).toBe('ending');
  });

  it('leaves every other view newest-first', () => {
    expect(defaultSortFor('')).toBe('recent');
    expect(defaultSortFor('ACTIVE')).toBe('recent');
    expect(defaultSortFor('NONE')).toBe('recent');
    expect(defaultSortFor('DELETED')).toBe('recent');
  });
});

describe('resolveSort', () => {
  it('lets an explicit toggle beat the derived default', () => {
    expect(resolveSort('EXPIRING', 'recent')).toBe('recent');
    expect(resolveSort('', 'ending')).toBe('ending');
  });

  it('falls back to the derived default when nothing is overridden', () => {
    expect(resolveSort('EXPIRING', null)).toBe('ending');
    expect(resolveSort('ACTIVE', null)).toBe('recent');
  });
});

describe('listParamsFor', () => {
  /**
   * DELETED is in the same chip row as the standings but is a DIFFERENT
   * server parameter — `ListMembersQueryDto` treats `standing` and `deleted`
   * as independent, and sending both would ask for deleted members who also
   * have a live plan.
   */
  it('maps the Deleted chip to deleted:true and drops standing entirely', () => {
    const params = listParamsFor(state({ standing: 'DELETED' }));
    expect(params.deleted).toBe(true);
    expect(params.standing).toBeUndefined();
  });

  it('sends a real standing and leaves deleted unset', () => {
    const params = listParamsFor(state({ standing: 'ACTIVE' }));
    expect(params.standing).toBe('ACTIVE');
    expect(params.deleted).toBeUndefined();
  });

  it('turns every empty control into undefined, never an empty string', () => {
    const params = listParamsFor(state());
    expect(params.search).toBeUndefined();
    expect(params.planCode).toBeUndefined();
    expect(params.membershipStatus).toBeUndefined();
    expect(params.standing).toBeUndefined();
  });

  it('forwards the filled controls verbatim', () => {
    const params = listParamsFor(
      state({ search: 'marisol', planCode: 'MONTHLY', membershipStatus: 'FROZEN' }),
    );
    expect(params.search).toBe('marisol');
    expect(params.planCode).toBe('MONTHLY');
    expect(params.membershipStatus).toBe('FROZEN');
  });

  it('carries the page and the shared page size', () => {
    const params = listParamsFor(state({ page: 3 }));
    expect(params.page).toBe(3);
    expect(params.limit).toBe(PAGE_SIZE);
  });

  it('resolves the sort the same way the toggle displays it', () => {
    expect(listParamsFor(state({ standing: 'EXPIRING' })).sort).toBe('ending');
    expect(listParamsFor(state({ standing: 'EXPIRING', sortOverride: 'recent' })).sort).toBe(
      'recent',
    );
  });
});

describe('countsParamsFor', () => {
  /**
   * The tiles count EVERY standing at once, so a standing here would mean
   * "how many active members are active" — and would let the tiles narrow
   * independently of the table under them. There is no page of anything to
   * return either.
   */
  it('never carries standing, page, limit or sort', () => {
    const params = countsParamsFor(state({ standing: 'EXPIRING', page: 4 }));
    expect(params).not.toHaveProperty('standing');
    expect(params).not.toHaveProperty('page');
    expect(params).not.toHaveProperty('limit');
    expect(params).not.toHaveProperty('sort');
  });

  it('DOES carry search, plan and deleted — or the tiles describe a different population', () => {
    const params = countsParamsFor(
      state({ search: 'reyes', planCode: 'ANNUAL', standing: 'DELETED' }),
    );
    expect(params.search).toBe('reyes');
    expect(params.planCode).toBe('ANNUAL');
    expect(params.deleted).toBe(true);
  });

  it('turns empty controls into undefined', () => {
    const params = countsParamsFor(state());
    expect(params.search).toBeUndefined();
    expect(params.planCode).toBeUndefined();
    expect(params.deleted).toBeUndefined();
  });
});

/**
 * `useAdminQuery` refetches on a SERIALISED key, so anything that changes the
 * request must change the key. A filter missing from it shows stale rows with
 * no way to tell.
 */
describe('queryKeyFor', () => {
  const base = state();

  it('changes with every filter', () => {
    const keys = new Set(
      [
        base,
        state({ search: 'ana' }),
        state({ standing: 'EXPIRED' }),
        state({ planCode: 'ANNUAL' }),
        state({ membershipStatus: 'FROZEN' }),
        state({ page: 2 }),
      ].map((s) => queryKeyFor(s)),
    );
    expect(keys.size).toBe(6);
  });

  it('changes with the sort — the same rows in a different order is a different answer', () => {
    expect(queryKeyFor(state({ standing: 'EXPIRING' }))).not.toBe(
      queryKeyFor(state({ standing: 'EXPIRING', sortOverride: 'recent' })),
    );
  });

  it('is stable for identical state', () => {
    expect(queryKeyFor(state({ search: 'ana', page: 2 }))).toBe(
      queryKeyFor(state({ search: 'ana', page: 2 })),
    );
  });
});

/**
 * The stored `MembershipStatus` and the date-derived standing answer
 * different questions, and when they disagree a staffer needs to see both on
 * one row. That is a diagnostic, not a bug.
 */
describe('storedStatusNote', () => {
  it('says nothing when the stored column agrees with the ordinary case', () => {
    expect(storedStatusNote(membership({ status: MembershipStatus.ACTIVE }))).toBeNull();
  });

  it('names the stored column when it is anything else', () => {
    expect(storedStatusNote(membership({ status: MembershipStatus.FROZEN }))).toBe('frozen');
    expect(storedStatusNote(membership({ status: MembershipStatus.CANCELLED }))).toBe('cancelled');
    expect(storedStatusNote(membership({ status: MembershipStatus.EXPIRED }))).toBe('expired');
  });

  it('says nothing at all for a member with no plan', () => {
    expect(storedStatusNote(null)).toBeNull();
  });
});

describe('cancellingNote', () => {
  it('flags a term somebody has given notice on', () => {
    expect(cancellingNote(membership({ cancelRequestedOn: '2026-08-18' }))).toBe('cancelling');
  });

  it('is silent otherwise', () => {
    expect(cancellingNote(membership())).toBeNull();
    expect(cancellingNote(null)).toBeNull();
  });
});

/**
 * The dashboard links in with `?standing=EXPIRING&sort=ending`, and the
 * nightly job's stored notifications link in with `?sort=ending`. Both are
 * untrusted strings by the time they reach this component.
 */
describe('seeding from the URL', () => {
  it('accepts the standings the chip row offers', () => {
    expect(standingFromParam('EXPIRING')).toBe('EXPIRING');
    expect(standingFromParam('DELETED')).toBe('DELETED');
  });

  it('falls back to All for anything it does not recognise', () => {
    expect(standingFromParam('garbage')).toBe('');
    expect(standingFromParam(null)).toBe('');
    expect(standingFromParam('expiring')).toBe('');
  });

  it('accepts a known sort and ignores the rest', () => {
    expect(sortFromParam('ending')).toBe('ending');
    expect(sortFromParam('recent')).toBe('recent');
    expect(sortFromParam('garbage')).toBeNull();
    expect(sortFromParam(null)).toBeNull();
  });
});
