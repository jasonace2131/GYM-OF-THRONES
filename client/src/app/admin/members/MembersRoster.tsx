'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Card } from '@/components/portal/ui';
import { DataState, DaysLeft, Kpi, Pager, Person, StandingBadge } from '@/components/admin/ui';
import { PERMISSIONS } from '@got/shared';
import { usePermission } from '@/components/rbac/MeProvider';
import { MemberDrawer } from '@/components/admin/MemberDrawer';
import { NewMemberDrawer } from '@/components/admin/NewMemberDrawer';
import { BulkActionModal, type BulkTarget } from '@/components/admin/actions/BulkActionModal';
import { adminApi, civilDate, type MemberListItem } from '@/lib/adminApi';
import {
  PAGE_SIZE,
  STANDING_FILTERS,
  STORED_STATUSES,
  cancellingNote,
  countsKeyFor,
  countsParamsFor,
  defaultSortFor,
  emptyRosterState,
  listParamsFor,
  queryKeyFor,
  resolveSort,
  sortFromParam,
  standingFromParam,
  storedStatusNote,
  type MemberSort,
  type RosterState,
  type StandingFilter,
} from '@/lib/memberRoster';
import { useAdminQuery, useDebounced } from '@/lib/useAdminQuery';

/** No bulk endpoint exists — this loops per-row over the network, so a
 *  hard cap keeps a fat-fingered "select all 4,000 members" from becoming a
 *  four-thousand-request click. */
const BULK_CAP = 50;

/**
 * The member roster — EVERYONE with an account, and the state of their term.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS SCREEN ABSORBED `/admin/subscriptions`.
 *
 * There used to be two: a roster that could show a person with no plan, and a
 * subscription monitor that structurally could not. Staff had to know which
 * screen answered which question about the same human being, and the only
 * thing the second one really owned was an ORDER — `endsOn` ascending, the
 * renewal call sheet.
 *
 * That order survives as `sort=ending`, one click away on the "Expiring soon"
 * chip, which derives it. The subscription columns fold into the table below;
 * `startsOn` was cut (a call sheet asks when a term ENDS, and the drawer
 * already shows the full range).
 *
 * Two behaviours changed with the merge and are worth knowing at the counter:
 *   - Search now covers PHONE as well as name/code/email.
 *   - Memberships belonging to soft-deleted members no longer appear. The old
 *     screen listed them, which was a bug in `/memberships`' scoping rather
 *     than a feature.
 * ─────────────────────────────────────────────────────────────────────────
 */
export function MembersRoster() {
  const canCreateMember = usePermission(PERMISSIONS.MEMBER_CREATE);

  // Read ONCE, as the initial state, never as a live binding: this screen owns
  // its filters after mount, and re-syncing from the URL on every render would
  // fight the chip row. `/admin`'s attention rail and the nightly job's stored
  // notifications both land here with filters in the query string.
  const params = useSearchParams();
  const [search, setSearch] = useState('');
  const [standing, setStanding] = useState<StandingFilter>(() =>
    standingFromParam(params.get('standing')),
  );
  const [planCode, setPlanCode] = useState('');
  const [membershipStatus, setMembershipStatus] = useState('');
  const [sortOverride, setSortOverride] = useState<MemberSort | null>(() =>
    sortFromParam(params.get('sort')),
  );
  const [page, setPage] = useState(1);
  const [selectedMember, setSelectedMember] = useState<MemberListItem | null>(null);
  const [newMemberOpen, setNewMemberOpen] = useState(false);

  // Keyed by member id, so toggling never depends on which page a row is on.
  // Storing the row itself (not just the id) is what lets the bulk bar and
  // the bulk-action report show a name for a member selected on a page the
  // caller has since paged away from.
  const [selected, setSelected] = useState<Map<string, MemberListItem>>(new Map());
  const [bulkAction, setBulkAction] = useState<'suspend' | 'reactivate' | null>(null);
  const headerCheckboxRef = useRef<HTMLInputElement | null>(null);

  // A request per keystroke would be a request per keystroke. `useAdminQuery`
  // also drops out-of-order responses, so the table can never settle on
  // results for a prefix of what the box now reads.
  const debounced = useDebounced(search);

  const state: RosterState = useMemo(
    () => ({
      ...emptyRosterState,
      search: debounced,
      standing,
      planCode,
      membershipStatus,
      sortOverride,
      page,
    }),
    [debounced, standing, planCode, membershipStatus, sortOverride, page],
  );

  // Any filter change invalidates a selection made under the OLD result set —
  // keeping it would let a staffer "bulk suspend" rows that are no longer even
  // in view. Two deliberate exclusions: `page`, because selection surviving
  // pagination is a stated requirement, and `sortOverride`, because re-ordering
  // the same rows does not make any of them a different member.
  useEffect(() => {
    setSelected(new Map());
  }, [debounced, standing, planCode, membershipStatus]);

  const query = useAdminQuery(
    useCallback(() => adminApi.members(listParamsFor(state)), [state]),
    queryKeyFor(state),
  );

  /**
   * The KPI tiles, in ONE request where the old Subscriptions screen fired
   * three. They are built from the same `where` the table is, so a tile
   * reading 42 beside a filter showing 39 is structurally impossible.
   */
  const counts = useAdminQuery(
    useCallback(() => adminApi.memberCounts(countsParamsFor(state)), [state]),
    countsKeyFor(state),
  );

  const plansQuery = useAdminQuery(useCallback(() => adminApi.plans(), []), 'members-plan-filter');
  const plans = plansQuery.data?.items ?? [];

  const onFilter = (next: () => void): void => {
    // Any filter change returns to page 1. Staying on page 7 of a narrower
    // result set shows an empty table and reads as "no results".
    setPage(1);
    next();
  };

  /** Picking a standing RESETS the sort override, so one click on "Expiring
   *  soon" gives the call sheet in call-sheet order. An operator who then
   *  prefers newest-first says so, and that choice holds until they change
   *  the chip again. */
  const onStanding = (next: StandingFilter): void => {
    onFilter(() => {
      setStanding(next);
      setSortOverride(null);
    });
  };

  const sort = resolveSort(standing, sortOverride);
  /** Choosing the order this chip ALREADY derives clears the override rather
   *  than storing a redundant one — the two are indistinguishable in effect
   *  (the next chip resets the override anyway) and `null` keeps the query
   *  key stable. */
  const onSort = (next: MemberSort): void => {
    setPage(1);
    setSortOverride(next === defaultSortFor(standing) ? null : next);
  };

  const items = query.data?.items ?? [];
  const pageIds = items.map((row) => row.userId);
  const pageSelectedCount = pageIds.filter((id) => selected.has(id)).length;
  const allPageSelected = pageIds.length > 0 && pageSelectedCount === pageIds.length;
  const somePageSelected = pageSelectedCount > 0 && !allPageSelected;

  useEffect(() => {
    if (headerCheckboxRef.current !== null) {
      headerCheckboxRef.current.indeterminate = somePageSelected;
    }
  }, [somePageSelected]);

  const toggleRow = (row: MemberListItem): void => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(row.userId)) next.delete(row.userId);
      else next.set(row.userId, row);
      return next;
    });
  };

  const toggleAllOnPage = (): void => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (allPageSelected) {
        pageIds.forEach((id) => next.delete(id));
      } else {
        items.forEach((row) => next.set(row.userId, row));
      }
      return next;
    });
  };

  const clearSelection = (): void => setSelected(new Map());

  const bulkTargets: BulkTarget[] = Array.from(selected.values()).map((row) => ({
    id: row.userId,
    label: `${row.firstName} ${row.lastName}`,
  }));
  const overCap = selected.size > BULK_CAP;

  const onBulkDone = (): void => {
    query.reload();
    // The tiles too: suspending twelve members changes the table AND the
    // numbers above it, and a stale tile beside a fresh table is exactly the
    // disagreement this endpoint exists to make impossible.
    counts.reload();
    clearSelection();
  };

  // The checkbox column and the bulk bar are BOTH gated behind this, not
  // just the Suspend/Reactivate buttons inside the bar — a caller who can't
  // act on a selection shouldn't be offered one at all (front desk would
  // otherwise see checkboxes and a Clear-only bar with nothing to clear
  // toward).
  const canBulk = usePermission(PERMISSIONS.MEMBER_SUSPEND);

  /** Straight from `/members/counts`, never a literal: the window is
   *  `MEMBERSHIP_EXPIRING_SOON_DAYS` (1–30) and a hardcoded 7 in this caption
   *  would drift away from the filter the moment anyone changed it. */
  const expiringSoonDays = counts.data?.expiringSoonDays;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* Non-interactive on purpose. `Kpi` renders a `Card`, which is shared
          with the dashboard, and making it clickable raises a keyboard and
          role question this change should not own. The chip row sits directly
          beneath instead — the same filters, one click, 40px away. */}
      <div className="a-kpis">
        <Kpi value={counts.data?.active ?? '—'} label="Active" delta="incl. expiring" />
        <Kpi
          value={counts.data?.expiring ?? '—'}
          label={
            expiringSoonDays === undefined
              ? 'Expiring soon'
              : `Expiring in ${expiringSoonDays} days`
          }
          tone="warn"
          delta="the call sheet"
        />
        <Kpi value={counts.data?.expired ?? '—'} label="Expired" tone="danger" />
      </div>

      <div className="a-toolbar">
        <span className="a-grow">
          <input
            className="a-input"
            type="search"
            value={search}
            placeholder="Search name, member code, email or phone…"
            aria-label="Search members"
            onChange={(event) => onFilter(() => setSearch(event.target.value))}
          />
        </span>

        <select
          className="a-select"
          value={planCode}
          aria-label="Filter by plan"
          disabled={plansQuery.loading}
          onChange={(event) => onFilter(() => setPlanCode(event.target.value))}
        >
          <option value="">All plans</option>
          {plans.map((plan) => (
            <option key={plan.code} value={plan.code}>
              {plan.name}
            </option>
          ))}
        </select>

        {/* The STORED status, and deliberately a separate control from the
            chips below: "expired" as a column value and "expired" as a date
            are different questions, and when they disagree that is a fact
            worth being able to ask about. */}
        <select
          className="a-select"
          value={membershipStatus}
          aria-label="Filter by stored status"
          onChange={(event) => onFilter(() => setMembershipStatus(event.target.value))}
        >
          {STORED_STATUSES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        {canCreateMember && (
          <button
            type="button"
            className="p-btn p-btn-gold"
            style={{ marginLeft: 'auto' }}
            onClick={() => setNewMemberOpen(true)}
          >
            + New member
          </button>
        )}
      </div>

      <div className="a-roster-filters">
        <div className="a-chips" role="group" aria-label="Filter by standing">
          {STANDING_FILTERS.map((chip) => (
            <button
              key={chip.value === '' ? 'all' : chip.value}
              type="button"
              aria-pressed={standing === chip.value}
              onClick={() => onStanding(chip.value)}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <div className="a-seg" role="group" aria-label="Sort">
          <button
            type="button"
            className="a-seg-btn"
            aria-pressed={sort === 'recent'}
            onClick={() => onSort('recent')}
          >
            Newest
          </button>
          <button
            type="button"
            className="a-seg-btn"
            aria-pressed={sort === 'ending'}
            onClick={() => onSort('ending')}
          >
            Ending soonest
          </button>
        </div>
      </div>

      {/* Rendered OUTSIDE `DataState` — it swaps the table out for a loading
          / error / empty Card, and a selection the operator is mid-action on
          must not vanish just because a poll landed. Gated on `canBulk`:
          a caller without `member.suspend` gets no bulk bar at all, not a
          disabled or Clear-only one. */}
      {canBulk && selected.size > 0 && (
        <div className="a-bulk-bar">
          <span className="a-bulk-bar-count">{selected.size} selected</span>

          {overCap && (
            <span className="a-bulk-bar-warn">
              Bulk actions cover up to {BULK_CAP} at a time — narrow the selection.
            </span>
          )}

          <div className="a-bulk-bar-actions">
            <button
              type="button"
              className="p-btn p-btn-danger p-btn-sm"
              disabled={overCap}
              onClick={() => setBulkAction('suspend')}
            >
              Suspend
            </button>
            <button
              type="button"
              className="p-btn p-btn-ghost p-btn-sm"
              disabled={overCap}
              onClick={() => setBulkAction('reactivate')}
            >
              Reactivate
            </button>
            {/* "Post announcement to selected" — CUT. The server has no
                announcement-targeting: `/announcements` is a flat broadcast
                list with no per-recipient audience field anywhere in
                `AnnouncementsService` or its DTOs (verified). Wiring this
                button needs a server-side targeting mechanism that does not
                exist yet — named-missing here rather than built against
                nothing. */}
            <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={clearSelection}>
              Clear
            </button>
          </div>
        </div>
      )}

      <DataState
        loading={query.loading}
        error={query.error}
        empty={items.length === 0}
        emptyTitle="No members match that"
        emptyHint="Try a shorter search, or go back to All."
        onRetry={query.reload}
      >
        <Card padded={false}>
          <div className="a-scroll">
            {/*
             * Seven data columns plus the checkbox, and two of them drop out
             * as the viewport narrows (`a-col-lg` below 1180px, `a-col-md`
             * below 760px). On a phone that leaves Member · Standing · Ends
             * with no sideways drag at all — the old table forced 760px of it
             * on a 390px screen.
             *
             * Everything hidden here is reachable in the drawer: visits and
             * the term's start date were already there, and `phone` and
             * `joinedOn` were ADDED to it for exactly this reason. Hiding a
             * phone number on the screen whose job is ringing people would
             * otherwise be a real loss rather than a responsive one.
             */}
            <table className="p-table a-roster-table" data-clickable>
              <thead>
                <tr>
                  {canBulk && (
                    <th className="a-checkbox-col">
                      <input
                        ref={headerCheckboxRef}
                        type="checkbox"
                        aria-label="Select all on this page"
                        checked={allPageSelected}
                        onChange={toggleAllOnPage}
                      />
                    </th>
                  )}
                  <th>Member</th>
                  <th className="a-col-md">Contact</th>
                  <th className="a-col-md">Plan</th>
                  <th>Standing</th>
                  <th>Ends</th>
                  <th className="p-num a-col-lg">Visits</th>
                  <th className="a-col-lg">Joined</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => {
                  const stored = storedStatusNote(row.membership);
                  const cancelling = cancellingNote(row.membership);
                  return (
                    <tr
                      key={row.userId}
                      tabIndex={0}
                      onClick={() => setSelectedMember(row)}
                      onKeyDown={(event) => {
                        // Row-click's keyboard equivalent — the table itself
                        // is a later polish pass, this just keeps the OPEN
                        // path reachable without a mouse.
                        if (event.key === 'Enter') setSelectedMember(row);
                      }}
                    >
                      {/* The cell below stops BOTH handlers, not just click. The
                          row's own `onKeyDown` opens the drawer on Enter, and a
                          keyboard user tabbing along the checkboxes to build a
                          bulk selection bubbles every keystroke straight into it
                          — the drawer opens mid-select, over the list they were
                          working. Space is covered too: the browser turns it into
                          a `click` on the input, which the click handler stops,
                          and the keydown that produced it stops here. */}
                      {canBulk && (
                        <td
                          className="a-checkbox-col"
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            aria-label={`Select ${row.firstName} ${row.lastName}`}
                            checked={selected.has(row.userId)}
                            onChange={() => toggleRow(row)}
                          />
                        </td>
                      )}
                      <td>
                        <Person
                          firstName={row.firstName}
                          lastName={row.lastName}
                          sub={row.memberCode ?? row.email}
                          avatarUrl={row.avatarUrl}
                        />
                      </td>
                      <td className="a-col-md">
                        <div style={{ fontSize: 13 }}>{row.phone ?? '—'}</div>
                        <div className="a-person-sub">{row.email}</div>
                      </td>
                      <td className="a-col-md">
                        {row.membership === null ? (
                          <span className="p-muted">—</span>
                        ) : (
                          <>
                            <div>{row.membership.planName}</div>
                            {/* The stored column, shown only when it differs
                                from the ordinary case. When it and the door
                                disagree, a staffer can see both on one row —
                                that is a diagnostic, not a bug. */}
                            {stored !== null && <div className="a-person-sub">{stored}</div>}
                          </>
                        )}
                      </td>
                      <td>
                        {/* THE DOOR's decision, not the stored column — every
                            list projects the stored status through accessVerdict
                            so the CRM and the counter cannot disagree in front
                            of a member. `DaysLeft` sits UNDER the badge rather
                            than in a column of its own: it says the same thing
                            at higher resolution, and a tenth column would push
                            this table into sideways scrolling at 1280px. */}
                        <div className="a-standing-cell">
                          <StandingBadge
                            decision={row.decision}
                            daysRemaining={row.membership?.daysRemaining ?? null}
                            hasMembership={row.membership !== null}
                          />
                          {row.membership !== null && (
                            <DaysLeft days={row.membership.daysRemaining} />
                          )}
                        </div>
                      </td>
                      <td>
                        {row.membership === null ? (
                          <span className="p-muted">—</span>
                        ) : (
                          <>
                            {civilDate(row.membership.endsOn)}
                            {cancelling !== null && (
                              <div className="a-person-sub">{cancelling}</div>
                            )}
                          </>
                        )}
                      </td>
                      <td className="p-num a-col-lg">{row.checkInCount}</td>
                      <td className="p-muted a-col-lg">{civilDate(row.joinedOn)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ padding: '0 18px 16px' }}>
            <Pager page={page} limit={PAGE_SIZE} total={query.data?.total ?? 0} onPage={setPage} />
          </div>
        </Card>
      </DataState>

      {selectedMember !== null && (
        <MemberDrawer
          key={selectedMember.userId}
          member={selectedMember}
          onClose={() => setSelectedMember(null)}
          reloadList={query.reload}
        />
      )}

      {newMemberOpen && (
        <NewMemberDrawer
          onClose={() => setNewMemberOpen(false)}
          onCreated={() => {
            query.reload();
            counts.reload();
          }}
          onOpenMember={(member) => setSelectedMember(member)}
        />
      )}

      <BulkActionModal
        open={bulkAction === 'suspend'}
        title="Suspend members"
        subtitle={`This blocks ${bulkTargets.length} member(s) at the door. Portal login is unaffected.`}
        confirmLabel="Suspend"
        danger
        needsReason
        reasonPlaceholder="Why are these members being suspended?"
        targets={bulkTargets}
        run={(id, reason) => adminApi.suspendMember(id, reason!).then(() => undefined)}
        onClose={() => setBulkAction(null)}
        onDone={onBulkDone}
      />

      <BulkActionModal
        open={bulkAction === 'reactivate'}
        title="Reactivate members"
        subtitle={`This clears the suspension on ${bulkTargets.length} member(s) — check-in access is restored immediately.`}
        confirmLabel="Reactivate"
        targets={bulkTargets}
        run={(id) => adminApi.reactivateMember(id).then(() => undefined)}
        onClose={() => setBulkAction(null)}
        onDone={onBulkDone}
      />
    </div>
  );
}
