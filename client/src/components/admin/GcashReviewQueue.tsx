'use client';

import { useCallback, useState } from 'react';
import { Badge } from '@/components/portal/ui';
import { DataState } from '@/components/admin/ui';
import { useAdminQuery } from '@/lib/useAdminQuery';
import {
  gcashApi,
  type GcashSubmissionForReview,
  type GcashSubmissionStatus,
} from '@/lib/gcashApi';
import { gymDateTime, peso } from '@/lib/adminApi';
import { ConfirmDialog, useConfirmAction } from './actions/ConfirmDialog';

/**
 * Members saying they paid by GCash, waiting on somebody to check.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * APPROVING IS A LINK, NOT A SALE, and this screen is built to make that
 * obvious rather than to hide it.
 *
 * The order staff must follow is: find the reference in the gym's OWN GCash
 * Transactions tab, record the payment through the ordinary counter flow, then
 * come back and approve. Approve then finds that payment by its reference and
 * ties the claim to it. Pressing Approve before the payment exists fails with
 * a message saying exactly that, so the wrong order is a corrected mistake
 * rather than money conjured from a member's screenshot.
 *
 * That is owner decision #9 holding: every peso still lands in a counted till
 * against an open shift, entered by a person who saw it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ───────────────────────────────────────────────────────────────────────────
 * BUILT FOR A MONDAY MORNING, NOT FOR A DEMO WITH ONE ROW.
 *
 * This was a stack of cards, one per claim, each about 230px tall for five
 * short facts and a thumbnail too small to read. At fourteen waiting it made
 * the page 4,300px long and pushed the payment register — the actual subject
 * of this screen — below three and a half thousand pixels of queue. Nothing
 * told you how many there were, or how long the oldest had sat.
 *
 * So: compact rows, the count and the oldest wait in the header, and a bounded
 * scroll box so the queue can never bury the register however many arrive. One
 * row opens at a time to show the receipt at a size somebody can actually read
 * a reference off — because the job here is comparing that reference against
 * the GCash app, and a thumbnail nobody can read is a control nobody performs.
 * ───────────────────────────────────────────────────────────────────────────
 */

const HOUR_MS = 3_600_000;

/** Past this, a claim is late enough that the member is probably wondering. */
const STALE_HOURS = 24;

function waitedHours(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / HOUR_MS;
}

/** "3 days", "5h", "just now" — the number that decides what to work next. */
function waited(iso: string): string {
  const hours = waitedHours(iso);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function GcashReviewQueue() {
  const [status, setStatus] = useState<GcashSubmissionStatus>('PENDING');
  const [openId, setOpenId] = useState<string | null>(null);

  const queue = useAdminQuery(
    useCallback(() => gcashApi.queue(status), [status]),
    `gcash-queue:${status}`,
    // A member can submit at any moment and the desk should not have to
    // remember to refresh. Ninety seconds is well under the time it takes
    // somebody to walk in and ask why nothing happened.
    { pollMs: 90_000 },
  );

  const rows = queue.data ?? [];
  // Oldest first from the server, so the head of the list is the longest wait.
  const oldest = rows[0];
  const overdue = oldest !== undefined && waitedHours(oldest.submittedAt) >= STALE_HOURS;

  return (
    <section className="p-card a-panel">
      <header className="a-panel-head">
        <div className="a-panel-head-row">
          <h2 className="a-panel-title">GCash submissions</h2>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* The workload, before any scrolling. Without this you cannot
                  tell fourteen waiting from one until you scroll and count. */}
            {status === 'PENDING' && rows.length > 0 ? (
              <Badge tone={overdue ? 'danger' : 'warn'}>
                {rows.length} waiting
                {oldest === undefined ? '' : ` · oldest ${waited(oldest.submittedAt)}`}
              </Badge>
            ) : null}
            {(['PENDING', 'APPROVED', 'REJECTED'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={`p-btn p-btn-sm ${status === value ? 'p-btn-gold' : 'p-btn-ghost'}`}
                onClick={() => {
                  setStatus(value);
                  setOpenId(null);
                }}
              >
                {value === 'PENDING' ? 'Waiting' : value === 'APPROVED' ? 'Confirmed' : 'Refused'}
              </button>
            ))}
          </div>
        </div>
        <p className="a-panel-lede">
          Members who paid by GCash without coming in. Find the reference in the gym&rsquo;s GCash
          Transactions tab, record the payment as usual, then approve to link the two. Oldest first.
        </p>
      </header>

      <DataState
        inset
        loading={queue.loading}
        error={queue.error}
        empty={rows.length === 0}
        emptyTitle={status === 'PENDING' ? 'Nothing waiting' : 'Nothing here'}
        emptyHint="Submissions from the member portal appear here."
        onRetry={queue.reload}
      >
        {/*
          BOUNDED, so a busy Monday cannot push the payment register off the
          screen. About eight rows before it scrolls in place — enough to see
          the shape of the workload without the queue taking over the page.
        */}
        <div style={{ maxHeight: 460, overflowY: 'auto' }}>
          <table className="p-table">
            <thead>
              <tr>
                <th>Member</th>
                <th className="p-num">Claimed</th>
                <th>Reference</th>
                <th>Waiting</th>
                <th aria-label="Receipt" />
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <SubmissionRow
                  key={row.id}
                  row={row}
                  expanded={openId === row.id}
                  onToggle={() => setOpenId(openId === row.id ? null : row.id)}
                  onDone={() => {
                    setOpenId(null);
                    queue.reload();
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      </DataState>
    </section>
  );
}

function SubmissionRow({
  row,
  expanded,
  onToggle,
  onDone,
}: {
  row: GcashSubmissionForReview;
  expanded: boolean;
  onToggle: () => void;
  onDone: () => void;
}) {
  // Approve and Refuse both go through the console's one confirmation; the
  // refusal's reason is asked for inside it, because the member reads it.
  const [asking, setAsking] = useState<'approve' | 'refuse' | null>(null);
  const { busy, error, run, reset } = useConfirmAction();

  const confirm = (reason: string | undefined): void => {
    if (asking === 'refuse' && reason === undefined) return;
    const write =
      asking === 'refuse'
        ? () => gcashApi.reject(row.id, reason ?? '')
        : () => gcashApi.approve(row.id);
    void run(write).then((ok) => {
      if (!ok) return;
      reset();
      setAsking(null);
      onDone();
    });
  };

  const who = `${row.member.firstName} ${row.member.lastName}`;

  // The claimed amount against the plan's list price. A short payment is a
  // conversation, not a validation error, so it is flagged rather than blocked.
  const short =
    row.planPriceCentavos !== null && row.amountCentavos < row.planPriceCentavos
      ? row.planPriceCentavos - row.amountCentavos
      : 0;

  const stale = waitedHours(row.submittedAt) >= STALE_HOURS;
  const open = expanded;

  return (
    <>
      <tr>
        <td>
          <strong>
            {row.member.firstName} {row.member.lastName}
          </strong>
          <div className="a-person-sub">{row.planName ?? row.planCode}</div>
        </td>

        <td className="p-num">
          {peso(row.amountCentavos, { decimals: true })}
          {short > 0 ? (
            <div className="a-person-sub" style={{ color: 'var(--p-danger)' }}>
              short {peso(short, { decimals: true })}
            </div>
          ) : null}
        </td>

        <td>
          {/* Selectable in one gesture: staff paste this straight into the
              GCash app's search, and a number they retype by eye is a number
              they will eventually mistype. */}
          <strong className="p-num" style={{ userSelect: 'all', fontSize: 13.5 }}>
            {row.reference}
          </strong>
        </td>

        <td
          className={stale ? undefined : 'p-muted'}
          style={stale ? { color: 'var(--p-danger)', fontWeight: 600 } : undefined}
        >
          {waited(row.submittedAt)}
        </td>

        <td>
          <button
            type="button"
            className="p-btn p-btn-ghost p-btn-sm"
            onClick={onToggle}
            aria-expanded={expanded}
          >
            {expanded ? 'Hide' : 'Receipt'}
          </button>
        </td>

        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
          {row.status !== 'PENDING' ? (
            <Badge tone={row.status === 'APPROVED' ? 'ok' : 'danger'}>
              {row.status === 'APPROVED' ? 'Linked' : 'Refused'}
            </Badge>
          ) : (
            <span style={{ display: 'inline-flex', gap: 6 }}>
              <button
                type="button"
                className="p-btn p-btn-gold p-btn-sm"
                disabled={busy}
                onClick={() => setAsking('approve')}
              >
                Approve
              </button>
              <button
                type="button"
                className="p-btn p-btn-ghost p-btn-sm"
                disabled={busy}
                onClick={() => {
                  // The receipt opens behind the question, so it is right
                  // there to check again after "Keep waiting".
                  if (!expanded) onToggle();
                  setAsking('refuse');
                }}
              >
                Refuse
              </button>
            </span>
          )}

          {/* Inside the cell, not beside the rows: a dialog is a <div>, and a
              <div> may not be a child of <tbody>. */}
          <ConfirmDialog
            open={asking !== null}
            title={
              asking === 'refuse'
                ? `Refuse ${who}'s GCash claim?`
                : `Approve ${who}'s GCash payment?`
            }
            consequence={
              asking === 'refuse'
                ? `The ${peso(row.amountCentavos, { decimals: true })} claim (ref ${row.reference}) is marked refused, and ${row.member.firstName} sees your reason in their portal.`
                : `Links the ${peso(row.amountCentavos, { decimals: true })} claim (ref ${row.reference}) to the payment already recorded under that reference. Record the payment first — approving before it exists fails.`
            }
            confirmLabel={asking === 'refuse' ? 'Refuse it' : 'Approve'}
            cancelLabel="Keep waiting"
            tone={asking === 'refuse' ? 'danger' : 'default'}
            reason={
              asking === 'refuse'
                ? {
                    required: true,
                    label: 'Reason — the member reads this',
                    maxLength: 300,
                    placeholder: 'e.g. No payment with that reference in our GCash history',
                  }
                : undefined
            }
            busy={busy}
            error={error}
            onConfirm={confirm}
            onClose={() => {
              if (busy) return;
              reset();
              setAsking(null);
            }}
          />
        </td>
      </tr>

      {open ? (
        <tr>
          <td colSpan={6} style={{ background: 'var(--p-paper2)' }}>
            <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              {/* The receipt at a size somebody can read the reference off,
                  which is the whole job this row exists for. */}
              {row.proofUrl === null ? (
                <div
                  className="a-person-sub"
                  style={{
                    width: 200,
                    height: 300,
                    display: 'grid',
                    placeItems: 'center',
                    textAlign: 'center',
                    border: '1px dashed var(--p-border-2)',
                    borderRadius: 8,
                  }}
                >
                  image unavailable
                </div>
              ) : (
                <a href={row.proofUrl} target="_blank" rel="noreferrer" title="Open full size">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a
                      short-lived signed Supabase URL. `next/image` would need
                      the host allow-listed and would proxy a link that expires
                      in two minutes. */}
                  <img
                    src={row.proofUrl}
                    alt={`GCash receipt for reference ${row.reference}`}
                    style={{
                      width: 200,
                      maxHeight: 380,
                      objectFit: 'contain',
                      background: 'var(--p-paper)',
                      borderRadius: 8,
                      border: '1px solid var(--p-border)',
                      display: 'block',
                    }}
                  />
                </a>
              )}

              <div style={{ flex: '1 1 260px', display: 'grid', gap: 10, minWidth: 0 }}>
                <div className="a-person-sub">
                  Sent {gymDateTime(row.submittedAt)}
                  {row.reviewedAt === null ? '' : ` · reviewed ${gymDateTime(row.reviewedAt)}`}
                  {row.member.memberCode === null ? '' : ` · ${row.member.memberCode}`}
                </div>

                {row.status === 'REJECTED' && row.rejectReason !== null ? (
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--p-danger)', lineHeight: 1.5 }}>
                    Refused: {row.rejectReason}
                  </p>
                ) : null}

              </div>
            </div>
          </td>
        </tr>
      ) : null}

    </>
  );
}
