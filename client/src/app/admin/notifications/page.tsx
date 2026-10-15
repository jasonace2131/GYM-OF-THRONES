'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/portal/ui';
import { DataState, Pager, Person } from '@/components/admin/ui';
import { PERMISSIONS } from '@got/shared';
import { usePermission } from '@/components/rbac/MeProvider';
import { SellMembershipModal } from '@/components/admin/actions/SellMembershipModal';
import {
  adminApi,
  civilDate,
  gymDateTime,
  type MembershipAlertItem,
  type SystemNotification,
} from '@/lib/adminApi';
import { useAdminQuery } from '@/lib/useAdminQuery';

/**
 * Notifications — Figure 22 of the proposal, and REQ021.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO COLUMNS, AND ONLY ONE OF THEM IS A TABLE IN THE DATABASE.
 *
 * Expiration Alerts are DERIVED on every load from the memberships themselves
 * (`GET /memberships/alerts`). Storing them would mean a row per member per
 * expiry, a nightly sweep to keep it honest, and a stale "expiring" notice
 * left behind by every renewal. A query cannot go stale. The one thing stored
 * is an archive, and it is pinned to the term's end date, so it cannot go
 * stale either.
 *
 * System Notifications are stored, because nothing else records them: an
 * enquiry that arrived while the email provider was down, a nightly job that
 * threw at 03:15 into a log nobody reads.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * BOTH COLUMNS PAGE ON THE SERVER, AND BOTH SEARCH (owner, 2026-10-08: "it
 * floods the screen"; "always get the pagination first, don't get it all").
 * Every request is one page. System notifications come ten at a time in three
 * tabs — Unread, Inbox and Archived — and "Archive" is the operator's word for
 * the server's resolve. Expiration alerts come eight at a time from
 * `GET /memberships/alerts`, in an Open and an Archived tab; an alert is
 * archived for the CURRENT term, so a renewal brings the next one back.
 *
 * Renew is a REAL action, not a link. It opens the same `SellMembershipModal`
 * the member drawer opens, so renewing from here and renewing from the member
 * record are one code path.
 *
 * The panel a caller cannot use is not fetched at all. `useAdminQuery`'s
 * `enabled` flag exists for exactly this: firing a request guaranteed to 403
 * spends a round trip to render nothing and fills the server log with denials
 * that look like an attack.
 */

const ALERTS_PER_PAGE = 8;
const NOTICES_PER_PAGE = 10;
/** How long typing must pause before a search goes to the server. */
const SEARCH_DEBOUNCE_MS = 300;

type Tab = 'unread' | 'inbox' | 'archived';
type AlertTab = 'open' | 'archived';

const TABS: { key: Tab; label: string }[] = [
  { key: 'unread', label: 'Unread' },
  { key: 'inbox', label: 'Inbox' },
  { key: 'archived', label: 'Archived' },
];

const ALERT_TABS: { key: AlertTab; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'archived', label: 'Archived' },
];

/** `value`, once it has stopped changing for `ms` — one request per pause, not per key. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export default function AdminNotificationsPage() {
  const canReadSystem = usePermission(PERMISSIONS.NOTIFICATION_READ);
  const canResolve = usePermission(PERMISSIONS.NOTIFICATION_RESOLVE);
  // ALL: the expiring list is everybody's memberships, not the caller's own.
  const canReadMemberships = usePermission(PERMISSIONS.MEMBERSHIP_READ, { scope: 'ALL' });
  const canSell = usePermission(PERMISSIONS.MEMBERSHIP_SELL);

  const [tab, setTab] = useState<Tab>('inbox');
  const [noticePage, setNoticePage] = useState(1);
  const [noticeSearch, setNoticeSearch] = useState('');
  const [alertTab, setAlertTab] = useState<AlertTab>('open');
  const [alertPage, setAlertPage] = useState(1);
  const [alertSearch, setAlertSearch] = useState('');
  const [renewing, setRenewing] = useState<MembershipAlertItem | null>(null);

  const alertTerm = useDebounced(alertSearch.trim(), SEARCH_DEBOUNCE_MS);
  const noticeTerm = useDebounced(noticeSearch.trim(), SEARCH_DEBOUNCE_MS);

  // A new search or tab starts at page 1: page 4 of the old results may not
  // exist in the new ones.
  useEffect(() => setAlertPage(1), [alertTerm, alertTab]);
  useEffect(() => setNoticePage(1), [noticeTerm, tab]);

  const config = useAdminQuery(
    useCallback(() => adminApi.gymConfig(), []),
    'gym-config',
  );
  const expiringDays = config.data?.expiringSoonDays ?? null;

  /**
   * ONE PAGE PER REQUEST (owner, 2026-10-08). The server orders ending-soon
   * before lapsed and cuts the page across the two, so nothing here sorts,
   * merges or slices — and the request is the same size however many members
   * have lapsed over the years.
   */
  const alerts = useAdminQuery(
    useCallback(
      () =>
        adminApi.membershipAlerts({
          page: alertPage,
          limit: ALERTS_PER_PAGE,
          search: alertTerm === '' ? undefined : alertTerm,
          archived: alertTab === 'archived' ? true : undefined,
        }),
      [alertPage, alertTerm, alertTab],
    ),
    `notify-alerts:${alertTab}:${alertTerm}:${alertPage}`,
    { enabled: canReadMemberships },
  );

  const system = useAdminQuery(
    useCallback(
      () =>
        adminApi.notifications({
          unreadOnly: tab === 'unread' ? true : undefined,
          archived: tab === 'archived' ? true : undefined,
          search: noticeTerm === '' ? undefined : noticeTerm,
          page: noticePage,
          limit: NOTICES_PER_PAGE,
        }),
      [tab, noticeTerm, noticePage],
    ),
    `notify-system:${tab}:${noticeTerm}:${noticePage}`,
    { enabled: canReadSystem },
  );

  const counts = useAdminQuery(
    useCallback(
      () => adminApi.notificationCounts(noticeTerm === '' ? undefined : noticeTerm),
      [noticeTerm],
    ),
    `notify-counts:${noticeTerm}`,
    { enabled: canReadSystem },
  );

  const alertTotal = alerts.data?.total ?? 0;
  const alertPages = Math.max(1, Math.ceil(alertTotal / ALERTS_PER_PAGE));

  const totals: Record<Tab, number> = {
    unread: counts.data?.unread ?? 0,
    inbox: counts.data?.unresolved ?? 0,
    archived: counts.data?.archived ?? 0,
  };
  const tabTotal = totals[tab];
  const noticePages = Math.max(1, Math.ceil(tabTotal / NOTICES_PER_PAGE));
  // Archived notices are all seen already, so the bulk action has no place
  // there — and under a search it would mark everything, not just the matches.
  const canMarkAll = canResolve && tab !== 'archived' && noticeTerm === '' && totals.unread > 0;

  // Archiving the last row of the last page leaves that page empty; step back
  // to the new last page rather than showing "Nothing here" with rows behind.
  useEffect(() => {
    if (counts.data !== null && noticePage > noticePages) setNoticePage(noticePages);
  }, [counts.data, noticePage, noticePages]);
  useEffect(() => {
    if (alerts.data !== null && alertPage > alertPages) setAlertPage(alertPages);
  }, [alerts.data, alertPage, alertPages]);

  const reloadSystem = (): void => {
    system.reload();
    counts.reload();
  };

  return (
    <div className="a-notify">
      {/* ── Expiration alerts (derived) ── */}
      <section className="p-card a-panel">
        <header className="a-panel-head">
          <div className="a-panel-head-row">
            <h2 className="a-panel-title">Expiration alerts</h2>
            {canReadMemberships ? (
              <div className="a-notify-tabs" role="tablist" aria-label="Which alerts">
                {ALERT_TABS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    role="tab"
                    aria-selected={alertTab === option.key}
                    className="a-notify-tab"
                    onClick={() => setAlertTab(option.key)}
                  >
                    {option.label}
                    {alertTab === option.key && alerts.data !== null ? (
                      <span className="a-notify-tab-n">{alertTotal}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {/* One line, like the panel beside it, so both lists start level. */}
          <p className="a-panel-lede">
            {alertTab === 'archived'
              ? 'Archived for this term. A renewal brings the next one back.'
              : `Ending within ${expiringDays ?? 'a few'} days, or already lapsed. Renewing clears the row.`}
          </p>
          {canReadMemberships ? (
            <SearchField
              id="alert-search"
              label="Search expiration alerts"
              placeholder="Search members"
              value={alertSearch}
              onChange={setAlertSearch}
            />
          ) : null}
        </header>

        {!canReadMemberships ? (
          <PanelNote>Your account cannot read memberships, so this column is hidden.</PanelNote>
        ) : (
          <DataState
            inset
            loading={alerts.loading && alerts.data === null}
            error={alerts.error}
            empty={(alerts.data?.items.length ?? 0) === 0}
            emptyTitle={
              alertTerm !== ''
                ? 'No match'
                : alertTab === 'archived'
                  ? 'Nothing archived'
                  : 'Nobody is due'
            }
            emptyHint={
              alertTerm !== ''
                ? `Nobody here matches “${alertTerm}”.`
                : alertTab === 'archived'
                  ? 'Archived alerts are kept here until the member renews.'
                  : 'Memberships ending in the next week appear here.'
            }
            onRetry={alerts.reload}
          >
            <ul className="a-notify-list" aria-busy={alerts.loading || undefined}>
              {alerts.data?.items.map((row) => (
                <AlertRow
                  key={row.id}
                  row={row}
                  canSell={canSell}
                  canArchive={canResolve}
                  onRenew={() => setRenewing(row)}
                  onChanged={alerts.reload}
                />
              ))}
            </ul>
          </DataState>
        )}

        {canReadMemberships && alertTotal > ALERTS_PER_PAGE ? (
          <footer className="a-panel-foot">
            <span />
            <Pager
              page={Math.min(alertPage, alertPages)}
              limit={ALERTS_PER_PAGE}
              total={alertTotal}
              onPage={setAlertPage}
            />
          </footer>
        ) : null}
      </section>

      {/* ── System notifications (stored) ── */}
      <section className="p-card a-panel">
        <header className="a-panel-head">
          <div className="a-panel-head-row">
            <h2 className="a-panel-title">System notifications</h2>
            {canReadSystem ? (
              <div className="a-notify-tabs" role="tablist" aria-label="Which notifications">
                {TABS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    role="tab"
                    aria-selected={tab === option.key}
                    className="a-notify-tab"
                    onClick={() => setTab(option.key)}
                  >
                    {option.label}
                    {counts.data === null ? null : (
                      <span className="a-notify-tab-n">{totals[option.key]}</span>
                    )}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <p className="a-panel-lede">
            {tab === 'archived'
              ? 'Notices somebody has dealt with. Restore one to put it back in the inbox.'
              : 'Raised by the system itself. Archive a notice once it has been dealt with.'}
          </p>
          {canReadSystem ? (
            <SearchField
              id="notice-search"
              label="Search system notifications"
              placeholder="Search notices"
              value={noticeSearch}
              onChange={setNoticeSearch}
            />
          ) : null}
        </header>

        {!canReadSystem ? (
          <PanelNote>Your account does not have access to the notification board.</PanelNote>
        ) : (
          <DataState
            inset
            loading={system.loading && system.data === null}
            error={system.error}
            empty={(system.data?.length ?? 0) === 0}
            emptyTitle={
              noticeTerm !== ''
                ? 'No match'
                : tab === 'unread'
                  ? 'Nothing unread'
                  : tab === 'archived'
                    ? 'Nothing archived yet'
                    : 'Inbox clear'
            }
            emptyHint={
              noticeTerm !== ''
                ? `No notice here mentions “${noticeTerm}”.`
                : tab === 'archived'
                  ? 'Archived notices are kept here.'
                  : 'New enquiries and nightly job results appear here.'
            }
            onRetry={reloadSystem}
          >
            <ul className="a-notify-list" aria-busy={system.loading || undefined}>
              {system.data?.map((row) => (
                <NotificationRow
                  key={row.id}
                  row={row}
                  canResolve={canResolve}
                  onChanged={reloadSystem}
                />
              ))}
            </ul>
          </DataState>
        )}

        {canReadSystem && (tabTotal > NOTICES_PER_PAGE || canMarkAll) ? (
          <footer className="a-panel-foot">
            {canMarkAll ? (
              <button
                type="button"
                className="p-btn p-btn-ghost p-btn-sm"
                onClick={() => {
                  void adminApi.markAllNotificationsRead().then(reloadSystem);
                }}
              >
                Mark all {totals.unread} as seen
              </button>
            ) : (
              <span />
            )}
            {tabTotal > NOTICES_PER_PAGE ? (
              <Pager
                page={Math.min(noticePage, noticePages)}
                limit={NOTICES_PER_PAGE}
                total={tabTotal}
                onPage={setNoticePage}
              />
            ) : null}
          </footer>
        ) : null}
      </section>

      {renewing !== null ? (
        <SellMembershipModal
          open
          mode="renew"
          userId={renewing.userId}
          membershipId={renewing.id}
          memberName={`${renewing.firstName} ${renewing.lastName}`.trim()}
          onClose={() => setRenewing(null)}
          onSold={() => {
            setRenewing(null);
            alerts.reload();
          }}
        />
      ) : null}
    </div>
  );
}

/** The search box in a panel header. Labelled for a screen reader, cleared with one tap. */
function SearchField({
  id,
  label,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="a-panel-search">
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <svg aria-hidden viewBox="0 0 20 20" width="16" height="16" className="a-panel-search-icon">
        <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="m14 14 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <input
        id={id}
        type="search"
        className="a-panel-search-input"
        placeholder={placeholder}
        value={value}
        maxLength={64}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
      {value === '' ? null : (
        <button
          type="button"
          className="a-panel-search-clear"
          aria-label="Clear search"
          onClick={() => onChange('')}
        >
          ×
        </button>
      )}
    </div>
  );
}

function AlertRow({
  row,
  canSell,
  canArchive,
  onRenew,
  onChanged,
}: {
  row: MembershipAlertItem;
  canSell: boolean;
  canArchive: boolean;
  onRenew: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const archived = row.alertArchivedAt !== null;

  const toggle = async (): Promise<void> => {
    setBusy(true);
    try {
      if (archived) await adminApi.restoreExpiryAlert(row.id);
      else await adminApi.archiveExpiryAlert(row.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="a-alert-row">
      <Person
        firstName={row.firstName}
        lastName={row.lastName}
        sub={`${row.planName} · ends ${civilDate(row.endsOn)}`}
        avatarUrl={null}
      />
      <span className="a-alert-actions">
        <Badge tone={row.decision === 'DENY' ? 'danger' : 'warn'}>
          {row.decision === 'DENY'
            ? 'Lapsed'
            : // Past its end date but still let in: say so, rather than
              // "Ends today" for a term that ended days ago.
              row.decision === 'GRACE'
              ? 'In grace'
              : row.daysRemaining === null
                ? 'Ending'
                : row.daysRemaining <= 0
                  ? 'Ends today'
                  : `${row.daysRemaining}d left`}
        </Badge>
        <span className="a-alert-buttons">
          {canSell ? (
            <button type="button" className="p-btn p-btn-gold p-btn-sm" onClick={onRenew}>
              Renew
            </button>
          ) : null}
          {/* An icon, not a word: a third labelled button squeezed the
              member's name and end date to an ellipsis. Named for a screen
              reader and on hover. */}
          {canArchive ? (
            <button
              type="button"
              className="p-btn p-btn-ghost p-btn-sm a-icon-btn"
              disabled={busy}
              aria-label={`${archived ? 'Restore' : 'Archive'} ${row.firstName} ${row.lastName}`}
              title={archived ? 'Restore' : 'Archive'}
              onClick={() => void toggle()}
            >
              {archived ? <RestoreIcon /> : <ArchiveIcon />}
            </button>
          ) : null}
        </span>
      </span>
    </li>
  );
}

function PanelNote({ children }: { children: ReactNode }) {
  return (
    <div className="a-inset-state">
      <span>{children}</span>
    </div>
  );
}

function NotificationRow({
  row,
  canResolve,
  onChanged,
}: {
  row: SystemNotification;
  canResolve: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const unread = row.readAt === null;
  const archived = row.resolvedAt !== null;

  const act = async (which: 'read' | 'archive' | 'restore'): Promise<void> => {
    setBusy(true);
    try {
      if (which === 'read') await adminApi.markNotificationRead(row.id);
      else if (which === 'archive') await adminApi.resolveNotification(row.id);
      else await adminApi.restoreNotification(row.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="a-notice" data-unread={unread || undefined}>
      {/* The dot is the only unread marker, so it is named for a screen reader. */}
      <span className="a-notice-dot" aria-hidden={!unread}>
        {unread ? <span className="sr-only">Unread</span> : null}
      </span>

      <div className="a-notice-main">
        <div className="a-notice-title">{row.title}</div>
        <div className="a-notice-meta">
          <Badge
            tone={
              row.severity === 'CRITICAL' ? 'danger' : row.severity === 'WARNING' ? 'warn' : 'info'
            }
          >
            {row.severity === 'CRITICAL'
              ? 'Critical'
              : row.severity === 'WARNING'
                ? 'Needs a look'
                : 'Info'}
          </Badge>
          <time dateTime={row.createdAt}>{gymDateTime(row.createdAt)}</time>
          {archived ? <span>· archived {gymDateTime(row.resolvedAt!)}</span> : null}
        </div>
        {row.body === null ? null : <p className="a-notice-body">{row.body}</p>}
      </div>

      <div className="a-notice-actions">
        {/* `Link`, not `<a>`: a full page reload would drop the console shell
            and re-run the `/me` gate for what is a move between two screens of
            the same app. The database guarantees this path is internal. */}
        {row.linkPath === null ? null : (
          <Link className="p-btn p-btn-ghost p-btn-sm" href={row.linkPath}>
            View
          </Link>
        )}
        {canResolve && unread && !archived ? (
          <button
            type="button"
            className="p-btn p-btn-ghost p-btn-sm"
            disabled={busy}
            onClick={() => void act('read')}
          >
            Seen
          </button>
        ) : null}
        {canResolve && !archived ? (
          <button
            type="button"
            className="p-btn p-btn-ghost p-btn-sm"
            disabled={busy}
            onClick={() => void act('archive')}
          >
            Archive
          </button>
        ) : null}
        {canResolve && archived ? (
          <button
            type="button"
            className="p-btn p-btn-ghost p-btn-sm"
            disabled={busy}
            onClick={() => void act('restore')}
          >
            Restore
          </button>
        ) : null}
      </div>
    </li>
  );
}

function ArchiveIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2.5" y="3.5" width="15" height="4" rx="1" />
      <path d="M4 7.5v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-8" />
      <path d="M8 11h4" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.5 10a6.5 6.5 0 1 0 2-4.7" />
      <path d="M3.5 3.5v3.5H7" />
    </svg>
  );
}
