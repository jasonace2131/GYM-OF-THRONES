'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PERMISSIONS, type CheckInRecord } from '@got/shared';
import { Badge, Card, CardHead } from '@/components/portal/ui';
import { DataState, Kpi, Pager, Person } from '@/components/admin/ui';
import { Modal } from '@/components/admin/Modal';
import { WalkInSheet } from '@/components/admin/WalkInSheet';
import { PrintSlipButton } from '@/components/admin/PrintSlipButton';
import { CheckOutConfirm } from '@/components/admin/CheckOutConfirm';
import { NewMemberDrawer } from '@/components/admin/NewMemberDrawer';
import { useCan } from '@/components/rbac/MeProvider';
import { adminApi, duration, gymTime, peso } from '@/lib/adminApi';
import { gymToday } from '@/lib/gymTime';
import { seedFromGuest, type NewMemberSeed } from '@/lib/memberSeed';
import { useAdminQuery } from '@/lib/useAdminQuery';

/**
 * Walk-in management: the day-pass register, the sale, and the conversion.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SALE CREATES THE RECORD; THIS PAGE IS A LEDGER.
 *
 * Every commercial platform researched agrees (Wodify's Drop-Ins FAQ says it
 * verbatim: the page "does NOT allow you to 'create a drop in' record; This
 * will happen when they sign up as a drop-in elsewhere"). Gym of Thrones
 * already matches — the sale IS the check-in — so "new walk-in" here is the
 * existing sale sheet, not a separate registration step. And a day pass stays
 * a sale attached to a PERSON, never an anonymous POS line: the guest record
 * is what the waiver, any RA 9994 discount and the conversion hang off.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CONVERSIONS ARE NOW TRACKED: "Make member" passes the visit id as
 * `fromCheckInId`, and POST /members stamps `CheckIn.convertedToUserId` in
 * the same transaction that creates the account — the same shape
 * `NewMemberSeed.leadId` uses to mark a Lead CONVERTED. That is what the
 * walk-in report's "Converted to members" figure counts. This table does not
 * show a per-row Converted badge yet: `CheckInRecord` does not carry the
 * column, and widening a desk projection needs its own argument.
 *
 * Still not built — a repeat-visit badge ("3rd visit this month"):
 * guestPhone is deliberately never on the wire (DeskMember boundary) and
 * guestName arrives pre-split with a 'Walk-in guest' fallback that collapses
 * every anonymous guest into one bucket, so doing it right is a server
 * groupBy route returning counts only.
 */

const PAGE_SIZE = 20;
const TZ = 'Asia/Manila';
const DAY_MS = 86_400_000;

type Range = 'today' | '7d' | '30d';
type EntryFilter = 'WALK_IN' | 'GUEST_PASS' | 'BOTH';

export default function AdminWalkInsPage() {
  const can = useCan();
  const router = useRouter();

  const [range, setRange] = useState<Range>('today');
  const [entry, setEntry] = useState<EntryFilter>('WALK_IN');
  const [page, setPage] = useState(1);
  // The sale lives in a right-hand Drawer, not beside the table — the
  // Square/Gymdesk register shape: the LEDGER gets the full width (a
  // seven-column table crammed into half a page is a horizontal scrollbar),
  // and "Sell walk-in" opens a focused slide-over. Keyed so every open is a
  // fresh form.
  const [selling, setSelling] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [justSold, setJustSold] = useState<CheckInRecord | null>(null);
  const [converting, setConverting] = useState<NewMemberSeed | null>(null);
  const [convertFetching, setConvertFetching] = useState<string | null>(null);
  // "Check out" means LEAVING the gym here — never paying. The guest has no
  // account, so this register is the one place their visit can be closed
  // by hand; `checkin.close` is the key the route checks.
  const [checkingOut, setCheckingOut] = useState<CheckInRecord | null>(null);
  const canCheckOut = can(PERMISSIONS.CHECKIN_CLOSE);

  // NEVER toISOString().slice(0,10): the gym opens 05:00 Manila, which is
  // 21:00 UTC the previous day — a UTC date is yesterday's register.
  const today = gymToday(new Date(), TZ);
  const from =
    range === 'today'
      ? today
      : gymToday(new Date(Date.now() - (range === '7d' ? 7 : 30) * DAY_MS), TZ);

  const register = useAdminQuery(
    useCallback(
      () =>
        adminApi.checkIns({
          ...(entry === 'BOTH' ? {} : { entryType: entry }),
          from,
          to: today,
          page,
          limit: PAGE_SIZE,
        }),
      [entry, from, today, page],
    ),
    `walkins:${range}:${entry}:${page}`,
  );

  const canKpis = can(PERMISSIONS.PAYMENT_READ);
  const kpiCount = useAdminQuery(
    useCallback(
      () =>
        canKpis
          ? adminApi.checkIns({ entryType: 'WALK_IN', from: today, to: today, limit: 1 })
          : Promise.resolve(null),
      [canKpis, today],
    ),
    `walkins-kpi-count:${today}`,
  );
  const kpiMoney = useAdminQuery(
    useCallback(
      () =>
        canKpis
          ? adminApi.payments({ planCode: 'WALKIN', from: today, to: today, limit: 1 })
          : Promise.resolve(null),
      [canKpis, today],
    ),
    `walkins-kpi-money:${today}`,
  );

  const reloadAll = (): void => {
    register.reload();
    kpiCount.reload();
    kpiMoney.reload();
  };

  const startConvert = (checkInId: string): void => {
    setConvertFetching(checkInId);
    void adminApi
      .checkInGuest(checkInId)
      .then((guest) => setConverting({ ...seedFromGuest(guest), fromCheckInId: checkInId }))
      .catch(() => {
        // A 404 means the visit was voided or is not a guest after all — the
        // drawer still opens, just unseeded, and the operator types.
        setConverting({});
      })
      .finally(() => setConvertFetching(null));
  };

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {canKpis && (
        <div className="a-kpis">
          {/* These two can legitimately disagree: a member already inside who
              buys a day pass gets a Payment but no new CheckIn (the sale
              returns the existing visit), and a GUEST_PASS entry is a CheckIn
              with no Payment at all. Not a bug — do not "fix" it. */}
          <Kpi value={kpiCount.data?.total ?? '—'} label="Walk-ins today" />
          <Kpi
            value={kpiMoney.data === null || kpiMoney.data === undefined ? '—' : peso(kpiMoney.data.totalCentavos)}
            label="Takings today"
          />
          <Kpi
            value={
              kpiMoney.data === null || kpiMoney.data === undefined
                ? '—'
                : peso(kpiMoney.data.byMethod['CASH'] ?? 0)
            }
            label="Cash"
          />
          <Kpi
            value={
              kpiMoney.data === null || kpiMoney.data === undefined
                ? '—'
                : peso(kpiMoney.data.byMethod['GCASH'] ?? 0)
            }
            label="GCash"
          />
        </div>
      )}

      {justSold !== null && (
        <Card style={{ borderColor: 'var(--gold)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <strong>Walk-in recorded.</strong>
            {/* The sale moment is the ONE place copy is false — everything
                else is a reissue and bands REPRINT. No auto-print: without
                --kiosk-printing that is a modal on every ₱90 sale. */}
            {justSold.paymentId !== null && can(PERMISSIONS.PAYMENT_READ) && (
              <PrintSlipButton paymentId={justSold.paymentId} copy={false} label="Print slip" />
            )}
            <button
              type="button"
              className="p-btn p-btn-ghost p-btn-sm"
              style={{ marginLeft: 'auto' }}
              onClick={() => setJustSold(null)}
            >
              Dismiss
            </button>
          </div>
        </Card>
      )}

      {can(PERMISSIONS.CHECKIN_READ) && (
        <Card padded={false}>
          <div style={{ padding: '18px 18px 0' }}>
            <CardHead
              title="Register"
              action={
                can(PERMISSIONS.WALKIN_SELL) ? (
                  <button
                    type="button"
                    className="p-btn p-btn-gold p-btn-sm"
                    onClick={() => {
                      setFormKey((k) => k + 1);
                      setSelling(true);
                    }}
                  >
                    Sell walk-in
                  </button>
                ) : undefined
              }
            />
            {/* Filters on their own row, not squeezed into the header — the
                header keeps one primary action, the toolbar keeps the chips. */}
            <div className="a-toolbar" style={{ paddingBottom: 12, flexWrap: 'wrap' }}>
              {(
                [
                  ['today', 'Today'],
                  ['7d', '7 days'],
                  ['30d', '30 days'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`p-btn p-btn-sm ${range === value ? 'p-btn-gold' : 'p-btn-ghost'}`}
                  onClick={() => {
                    setRange(value);
                    setPage(1);
                  }}
                >
                  {label}
                </button>
              ))}
              <span style={{ width: 10 }} />
              {(
                [
                  ['WALK_IN', 'Walk-ins'],
                  ['GUEST_PASS', 'Guest passes'],
                  ['BOTH', 'Both'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`p-btn p-btn-sm ${entry === value ? 'p-btn-gold' : 'p-btn-ghost'}`}
                  onClick={() => {
                    setEntry(value);
                    setPage(1);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

            <DataState
              loading={register.loading}
              error={register.error}
              empty={(register.data?.items.length ?? 0) === 0}
              emptyTitle="No walk-ins in this range"
              emptyHint="Every sale lands here the moment it is taken Sell walk-in, top right."
              onRetry={register.reload}
            >
              <div className="a-scroll">
                <table className="p-table">
                  <thead>
                    <tr>
                      <th>Person</th>
                      <th>Who</th>
                      <th>In</th>
                      <th>Out</th>
                      <th className="p-num">For</th>
                      <th>Entry</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {register.data?.items.map((row) => (
                      <tr key={row.checkInId}>
                        <td>
                          <Person
                            firstName={row.member.firstName}
                            lastName={row.member.lastName}
                            sub={row.member.memberCode ?? '—'}
                            avatarUrl={row.member.avatarUrl}
                          />
                        </td>
                        <td>
                          <Badge tone={row.member.userId === null ? 'warn' : 'neutral'}>
                            {row.member.userId === null ? 'Guest' : 'Member'}
                          </Badge>
                        </td>
                        <td>{gymTime(row.occurredAt)}</td>
                        <td className="p-muted">
                          {row.endedAt === null ? 'still in' : gymTime(row.endedAt)}
                        </td>
                        <td className="p-num">
                          {/* duration() is typed number, not number|null —
                              the guard matters. */}
                          {row.durationMinutes === null ? '—' : duration(row.durationMinutes)}
                        </td>
                        <td>
                          <Badge tone="neutral">
                            {row.entryType === 'GUEST_PASS' ? 'guest pass' : 'walk-in'}
                          </Badge>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                            {canCheckOut && row.endedAt === null && row.voidedAt === null && (
                              <button
                                type="button"
                                className="p-btn p-btn-ghost p-btn-sm"
                                onClick={() => setCheckingOut(row)}
                              >
                                Check out
                              </button>
                            )}
                            {can(PERMISSIONS.MEMBER_CREATE) && row.member.userId === null && (
                              <button
                                type="button"
                                className="p-btn p-btn-gold p-btn-sm"
                                disabled={convertFetching !== null}
                                onClick={() => startConvert(row.checkInId)}
                              >
                                {convertFetching === row.checkInId ? 'Opening…' : 'Make member'}
                              </button>
                            )}
                            {can(PERMISSIONS.PAYMENT_READ) && row.paymentId !== null && (
                              <PrintSlipButton paymentId={row.paymentId} copy />
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </DataState>

            <div style={{ padding: '0 18px 16px' }}>
              <Pager
                page={page}
                limit={PAGE_SIZE}
                total={register.data?.total ?? 0}
                onPage={setPage}
              />
            </div>
          </Card>
        )}

      {/* A sale is a transaction moment, not a record edit — centre stage,
          dimmed context, one job. The wide modal gives the sale its two
          columns; the sheet renders its own charge bar. Titled "Sell a
          walk-in", never "checkout": on this page "Check out" means the
          guest leaving the gym. */}
      <Modal
        open={selling}
        wide
        title="Sell a walk-in"
        subtitle="The sale checks them in — no QR, staff presence is the identity check."
        onClose={() => setSelling(false)}
      >
        <WalkInSheet
          key={formKey}
          frameless
          onClose={() => setSelling(false)}
          onSold={(record) => {
            setSelling(false);
            setJustSold(record);
            reloadAll();
          }}
        />
      </Modal>

      {converting !== null && (
        <NewMemberDrawer
          seed={converting}
          onClose={() => setConverting(null)}
          onCreated={reloadAll}
          onOpenMember={() => router.push('/admin/members')}
        />
      )}

      <CheckOutConfirm
        visit={checkingOut}
        onClose={() => setCheckingOut(null)}
        onDone={reloadAll}
      />
    </div>
  );
}
