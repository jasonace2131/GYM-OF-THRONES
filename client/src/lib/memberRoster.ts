import type { MemberListItem } from './adminApi';

/**
 * The member roster's filter logic, as pure functions.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A MODULE AND NOT A HANDFUL OF INLINE TERNARIES.
 *
 * `client/vitest.config.ts` says "nothing here renders React yet", and there
 * is no `@testing-library/*` in `client/package.json` — so a page-level render
 * test is not available to this codebase. Anything expressed inside the
 * component is therefore untested by construction.
 *
 * The decisions worth protecting on this screen are all decisions ABOUT A
 * REQUEST, not about a DOM node: which standing maps to `deleted` rather than
 * `standing`, which filter derives which sort, what an empty select sends,
 * and what makes `useAdminQuery` refetch. All of that lives here, where
 * vitest can already reach it, and the component is left holding nothing but
 * layout and state.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** Rows per page. Shared so `listParamsFor` and the `Pager` cannot disagree. */
export const PAGE_SIZE = 15;

/**
 * The CRM's own filter vocabulary, extended with the ONE value that is not a
 * standing at all.
 *
 * `DELETED` maps to `deleted: true` on the wire and drops `standing`
 * entirely, because `ListMembersQueryDto` treats them as two independent
 * params. It stays in this row anyway: "show me the deleted ones" reads to a
 * staffer as a standing even though the request shape disagrees.
 */
export type StandingFilter = '' | 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'NONE' | 'DELETED';

export type MemberSort = 'recent' | 'ending';

export interface StandingChip {
  value: StandingFilter;
  label: string;
}

export const STANDING_FILTERS: readonly StandingChip[] = [
  { value: '', label: 'All' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'EXPIRING', label: 'Expiring soon' },
  { value: 'EXPIRED', label: 'Expired' },
  // The one the mockup's dropdown does not have and the business most needs:
  // an account with no plan at all is exactly the list a gym rings.
  { value: 'NONE', label: 'No plan' },
  // Last, and visually last: an admin escape hatch rather than a standing.
  { value: 'DELETED', label: 'Deleted' },
];

/** The stored `MembershipStatus` filter — a SECOND control, deliberately not
 *  folded into the chips above. They answer different questions: one is what
 *  the column says, the other is what the date says. */
export const STORED_STATUSES: readonly { value: string; label: string }[] = [
  { value: '', label: 'Any stored status' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'FROZEN', label: 'Frozen' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export interface RosterState {
  search: string;
  standing: StandingFilter;
  planCode: string;
  /** The stored `MembershipStatus`. `''` means "any". */
  membershipStatus: string;
  /**
   * Null until a staffer touches the sort toggle, and reset to null whenever
   * the standing chip changes — so picking "Expiring soon" gives the call
   * sheet in call-sheet order without anybody having to ask for it twice.
   */
  sortOverride: MemberSort | null;
  page: number;
}

export const emptyRosterState: RosterState = {
  search: '',
  standing: '',
  planCode: '',
  membershipStatus: '',
  sortOverride: null,
  page: 1,
};

/**
 * The sort a standing implies.
 *
 * `EXPIRING` and `EXPIRED` are the renewal call sheet — the job the merged-in
 * Subscriptions screen existed to do — and a call sheet is worked in date
 * order. Everything else answers "who joined recently", which is newest-first.
 */
export function defaultSortFor(standing: StandingFilter): MemberSort {
  return standing === 'EXPIRING' || standing === 'EXPIRED' ? 'ending' : 'recent';
}

/** An explicit toggle beats the derived default, until the chip row resets it. */
export function resolveSort(standing: StandingFilter, override: MemberSort | null): MemberSort {
  return override ?? defaultSortFor(standing);
}

/** `''` is a filled-in control that happens to be empty; `undefined` is an
 *  absent one. `qs()` skips both, but the request shape should say which it
 *  means. */
function orUndefined(value: string): string | undefined {
  return value === '' ? undefined : value;
}

export interface MemberListParams {
  page: number;
  limit: number;
  search?: string;
  standing?: string;
  planCode?: string;
  membershipStatus?: string;
  deleted?: boolean;
  sort: MemberSort;
}

export function listParamsFor(state: RosterState): MemberListParams {
  const deleted = state.standing === 'DELETED';
  return {
    page: state.page,
    limit: PAGE_SIZE,
    search: orUndefined(state.search),
    // Never both: `deleted=true&standing=ACTIVE` would ask for soft-deleted
    // members who also hold a live plan, which is not what the chip says.
    standing: deleted ? undefined : orUndefined(state.standing),
    planCode: orUndefined(state.planCode),
    membershipStatus: orUndefined(state.membershipStatus),
    deleted: deleted ? true : undefined,
    sort: resolveSort(state.standing, state.sortOverride),
  };
}

export interface MemberCountsParams {
  search?: string;
  planCode?: string;
  deleted?: boolean;
}

/**
 * The tiles' request. Same population as the table MINUS the standing — the
 * endpoint counts every standing at once, so sending one would mean "how many
 * active members are active" and would let the tiles narrow independently of
 * the rows beneath them. No page or limit either: there is nothing to page.
 */
export function countsParamsFor(state: RosterState): MemberCountsParams {
  return {
    search: orUndefined(state.search),
    planCode: orUndefined(state.planCode),
    deleted: state.standing === 'DELETED' ? true : undefined,
  };
}

/**
 * `useAdminQuery` refetches on a serialised key, so everything that changes
 * the request must appear here — including the sort. The same rows in a
 * different order is a different answer, and a key that ignores it leaves the
 * call sheet sorted by join date with no way to tell.
 */
export function queryKeyFor(state: RosterState): string {
  const p = listParamsFor(state);
  return [
    'members',
    p.page,
    p.search ?? '',
    p.standing ?? '',
    p.planCode ?? '',
    p.membershipStatus ?? '',
    p.deleted === true ? 'del' : '',
    p.sort,
  ].join(':');
}

/** The tiles move with search/plan/deleted but NOT with the standing chip or
 *  the page, so they get a key of their own rather than sharing the table's. */
export function countsKeyFor(state: RosterState): string {
  const p = countsParamsFor(state);
  return ['member-counts', p.search ?? '', p.planCode ?? '', p.deleted === true ? 'del' : ''].join(
    ':',
  );
}

type Membership = MemberListItem['membership'];

/**
 * The quiet sub-line under the Plan cell.
 *
 * The stored `MembershipStatus` is not discarded by this screen's
 * date-derived vocabulary — when the column and the door disagree, a staffer
 * can see both on one row. That is a diagnostic, not a bug. `ACTIVE` is the
 * ordinary case and says nothing, so the line appears only when there is
 * something to notice.
 */
export function storedStatusNote(membership: Membership): string | null {
  if (membership === null) return null;
  if (membership.status === 'ACTIVE') return null;
  return membership.status.toLowerCase();
}

/** The sub-line under the Ends cell. A member already under notice is the one
 *  row on a renewal call sheet nobody should ring about renewing. */
export function cancellingNote(membership: Membership): string | null {
  if (membership === null || membership.cancelRequestedOn === null) return null;
  return 'cancelling';
}

/**
 * URL seeding. `/admin?standing=EXPIRING&sort=ending` is how the dashboard
 * hands over the call sheet, and stored `SystemNotification.linkPath` rows
 * land here with `?sort=ending` — both are untrusted strings by the time this
 * component sees them, so an unrecognised value falls back rather than being
 * forwarded to a server that would 400 it.
 */
export function standingFromParam(raw: string | null): StandingFilter {
  const match = STANDING_FILTERS.find((chip) => chip.value !== '' && chip.value === raw);
  return match?.value ?? '';
}

export function sortFromParam(raw: string | null): MemberSort | null {
  return raw === 'recent' || raw === 'ending' ? raw : null;
}
