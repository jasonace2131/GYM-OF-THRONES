'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Badge, Card } from '@/components/portal/ui';
import { DataState, Kpi, Pager } from '@/components/admin/ui';
import { PrintSlipButton } from '@/components/admin/PrintSlipButton';
import { adminApi, gymDateTime, peso, type MemberListItem } from '@/lib/adminApi';
import { MemberDrawer } from '@/components/admin/MemberDrawer';
import { PaymentDrawer } from '@/components/admin/PaymentDrawer';
import {
  DEFAULT_FILTERS,
  PaymentsToolbar,
  resolvedRange,
  type PaymentsFilters,
  type StatusFilter,
} from '@/components/admin/PaymentsToolbar';
import { RANGE_PRESETS, type RangeKey } from '@/lib/payments/rangePresets';
import { GcashReviewQueue } from '@/components/admin/GcashReviewQueue';
import { useAdminQuery } from '@/lib/useAdminQuery';

const PAGE_SIZE = 20;

/**
 * The payment register.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS SCREEN READS. IT DOES NOT TAKE MONEY.
 *
 * The mockup puts a "Record Payment" form here, and it is deliberately not
 * built on this page. Every payment in this system is `shiftId NOT NULL` —
 * money without a counted drawer is the one thing that cannot be reconciled
 * later — so recording one belongs at the desk console, inside an open shift,
 * attributed to the operator who took the cash. A form on an admin screen that
 * could book a payment against no shift would be a hole in the only financial
 * control the gym has.
 *
 * It DOES correct money, through the drawer: "Edit payment" voids the original
 * and records a corrected replacement in the ORIGINAL's shift, because an
 * amendment moves no money and needs no open drawer.
 *
 * Amounts arrive as INTEGER CENTAVOS and the peso sign is rendered here. No
 * response body anywhere in this system carries a formatted currency string.
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * ONE panel at a time — `PaymentDrawer` and `MemberDrawer` SWAP, never stack.
 *
 * Two open drawers means two focus traps fighting each other and two
 * `body.style.overflow` restores running in an order neither component can
 * predict. For a keyboard user that is a page they cannot get out of.
 */
type View = { kind: 'payment'; id: string } | { kind: 'member'; member: MemberListItem } | null;

const STATUS_VALUES: StatusFilter[] = ['RECORDED', 'VOIDED', 'ALL'];

function readRange(raw: string | null): RangeKey {
  return RANGE_PRESETS.some((preset) => preset.key === raw)
    ? (raw as RangeKey)
    : DEFAULT_FILTERS.range;
}

function readStatus(raw: string | null): StatusFilter {
  return STATUS_VALUES.includes(raw as StatusFilter)
    ? (raw as StatusFilter)
    : DEFAULT_FILTERS.status;
}

function PaymentsPage() {
  const router = useRouter();
  const search = useSearchParams();

  /**
   * THE FILTERS LIVE IN THE URL. A view is then shareable and survives a
   * refresh — a saved view without a saved-view table.
   */
  const filters: PaymentsFilters = useMemo(
    () => ({
      // VALIDATED, never cast. A shared link is user input: `?range=lol` cast
      // straight to `RangeKey` would fall through `presetRange`'s switch and
      // return undefined, and the page would crash reading `.from` off it.
      range: readRange(search.get('range')),
      from: search.get('from') ?? '',
      to: search.get('to') ?? '',
      status: readStatus(search.get('status')),
      method: search.get('method') ?? '',
      planCode: search.get('planCode') ?? '',
      archived: search.get('archived') === 'true',
    }),
    [search],
  );
  // `|| 1` catches NaN and 0; the floor catches `?page=-3`, which the server
  // would turn into a negative `skip` and a 400.
  const page = Math.max(1, Math.floor(Number(search.get('page') ?? '1')) || 1);

  const [view, setView] = useState<View>(null);
  const [openingMember, setOpeningMember] = useState<string | null>(null);

  const push = useCallback(
    (next: PaymentsFilters, nextPage: number): void => {
      const params = new URLSearchParams();
      if (next.range !== DEFAULT_FILTERS.range) params.set('range', next.range);
      if (next.from !== '') params.set('from', next.from);
      if (next.to !== '') params.set('to', next.to);
      if (next.status !== DEFAULT_FILTERS.status) params.set('status', next.status);
      if (next.method !== '') params.set('method', next.method);
      if (next.planCode !== '') params.set('planCode', next.planCode);
      if (next.archived) params.set('archived', 'true');
      if (nextPage !== 1) params.set('page', String(nextPage));
      const qs = params.toString();
      router.replace(qs === '' ? '/admin/payments' : `/admin/payments?${qs}`, { scroll: false });
    },
    [router],
  );

  const range = resolvedRange(filters, new Date());
  const queryKey = [
    range.from,
    range.to,
    filters.status,
    filters.method,
    filters.planCode,
    String(filters.archived),
    String(page),
  ].join('|');

  const query = useAdminQuery(
    useCallback(
      () =>
        adminApi.payments({
          page,
          limit: PAGE_SIZE,
          from: range.from === '' ? undefined : range.from,
          to: range.to === '' ? undefined : range.to,
          status: filters.status === 'ALL' ? undefined : filters.status,
          method: filters.method === '' ? undefined : filters.method,
          planCode: filters.planCode === '' ? undefined : filters.planCode,
          archived: filters.archived ? true : undefined,
        }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [queryKey],
    ),
    `payments:${queryKey}`,
  );

  const openMember = useCallback(async (userId: string): Promise<void> => {
    setOpeningMember(userId);
    try {
      setView({ kind: 'member', member: await adminApi.member(userId) });
    } finally {
      setOpeningMember(null);
    }
  }, []);

  // A drawer left open over a list it is no longer part of is a panel with no
  // row behind it; closing on a filter change keeps the two in step.
  useEffect(() => {
    setView(null);
  }, [queryKey]);

  const byMethod = query.data?.byMethod ?? {};

  return (
    // `minmax(0, 1fr)`: an `auto` column grows to the widest child's
    // min-content — the register table — and pushed the whole page past a
    // phone's width. This way the table scrolls inside its own card.
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 18 }}>
      {view?.kind === 'payment' && (
        <PaymentDrawer
          // A fresh mount per id: following the amendment chain must not
          // leave the previous payment's state behind.
          key={view.id}
          paymentId={view.id}
          onClose={() => setView(null)}
          onOpenPayment={(id) => setView({ kind: 'payment', id })}
          onOpenMember={(userId) => void openMember(userId)}
          reloadList={() => query.reload()}
        />
      )}

      {view?.kind === 'member' && (
        <MemberDrawer
          key={view.member.userId}
          member={view.member}
          onClose={() => setView(null)}
          reloadList={() => query.reload()}
        />
      )}

      {/* Above the register on purpose. A member who paid from home is waiting
          on somebody here, and a queue below the fold is a queue nobody works. */}
      <GcashReviewQueue />

      <div className="a-kpis">
        <Kpi
          value={query.data === null ? '—' : peso(query.data.totalCentavos)}
          label="Total, this filter"
        />
        <Kpi value={query.data?.total ?? '—'} label="Transactions" />
        <Kpi value={byMethod['CASH'] === undefined ? '—' : peso(byMethod['CASH'])} label="Cash" />
        <Kpi
          value={byMethod['GCASH'] === undefined ? '—' : peso(byMethod['GCASH'])}
          label="GCash"
        />
      </div>

      <PaymentsToolbar filters={filters} onChange={(next) => push(next, 1)} />
      <span className="p-muted" style={{ fontSize: 13 }}>
        Payments are recorded at the desk, inside an open shift. Open a row to correct one.
      </span>

      <DataState
        loading={query.loading}
        error={query.error}
        empty={(query.data?.items.length ?? 0) === 0}
        emptyTitle="No payments in this view"
        emptyHint="Widen the date range, or switch Status to All to include voided rows."
        onRetry={query.reload}
      >
        <Card padded={false}>
          <div className="a-scroll">
            <table className="p-table">
              <thead>
                <tr>
                  <th>Payer</th>
                  <th>For</th>
                  <th className="p-num">Gross</th>
                  <th className="p-num">Discount</th>
                  <th className="p-num">Net</th>
                  <th>Method</th>
                  <th>When</th>
                  <th>Status</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {query.data?.items.map((row) => {
                  const payerName = row.userId === null ? 'Walk-in guest' : (row.payerName ?? 'Member');
                  const open = (): void => setView({ kind: 'payment', id: row.id });

                  return (
                    /*
                     * THE ROW IS THE TAP TARGET.
                     *
                     * The payer cell used to be a button inside this row, and a
                     * clickable <tr> containing a button is a nested-interactive
                     * a11y trap — a screen reader announces one control inside
                     * another and neither has a clear name. The payer link moved
                     * INTO the drawer ("Open member record"), so this row has
                     * exactly one action and can carry it honestly.
                     */
                    <tr
                      key={row.id}
                      className="a-row-click"
                      role="button"
                      tabIndex={0}
                      aria-label={`${payerName} · ${peso(row.netCentavos)} · ${gymDateTime(row.receivedAt)}`}
                      onClick={open}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        open();
                      }}
                    >
                      <td>
                        {row.userId === null ? (
                          <span className="p-muted">Walk-in guest</span>
                        ) : (
                          payerName
                        )}
                      </td>
                      <td>
                        {row.planName}
                        {row.reference === null ? null : (
                          <div className="a-person-sub">ref {row.reference}</div>
                        )}
                      </td>
                      <td className="p-num">{peso(row.grossCentavos, { decimals: true })}</td>
                      <td className="p-num">
                        {row.discountCentavos === 0 ? (
                          <span className="p-muted">—</span>
                        ) : (
                          <>
                            {peso(row.discountCentavos, { decimals: true })}
                            {/* Statutory discounts are mandatory under RA 9994 /
                                RA 10754 and refusing one is a criminal offence,
                                so they are labelled rather than buried. */}
                            {row.discountType === 'SENIOR' || row.discountType === 'PWD' ? (
                              <div className="a-person-sub">{row.discountType}</div>
                            ) : null}
                          </>
                        )}
                      </td>
                      <td className="p-num">
                        <strong>{peso(row.netCentavos, { decimals: true })}</strong>
                      </td>
                      <td>
                        <Badge tone={row.method === 'CASH' ? 'warn' : 'info'}>{row.method}</Badge>
                      </td>
                      <td className="p-muted">{gymDateTime(row.receivedAt)}</td>
                      <td>
                        <Badge tone={row.status === 'VOIDED' ? 'danger' : 'ok'}>{row.status}</Badge>
                        {row.voidKind === null ? null : (
                          <div className="a-person-sub">{row.voidKind}</div>
                        )}
                      </td>
                      {/* The one interactive descendant left. Its cell stops the
                          click so printing a slip does not also open the drawer. */}
                      <td onClick={(event) => event.stopPropagation()}>
                        <PrintSlipButton paymentId={row.id} copy />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ padding: '0 18px 16px' }}>
            <Pager
              page={page}
              limit={PAGE_SIZE}
              total={query.data?.total ?? 0}
              onPage={(next) => push(filters, next)}
            />
          </div>
        </Card>
      </DataState>

      {openingMember !== null && (
        <span className="p-muted" style={{ fontSize: 12 }}>
          Opening member record…
        </span>
      )}
    </div>
  );
}

/**
 * `useSearchParams()` opts the route into client-side rendering and `next
 * build` REFUSES a page that reads it outside a Suspense boundary — a rule
 * `next dev` does not enforce, so this is the kind of break that only shows up
 * in the deploy container.
 */
export default function AdminPaymentsPage() {
  return (
    <Suspense fallback={<div className="p-muted">Loading the register…</div>}>
      <PaymentsPage />
    </Suspense>
  );
}
