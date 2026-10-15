'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/portal/ui';
import {
  adminApi,
  civilDate,
  gymDateTime,
  peso,
  type PaymentDetail,
} from '@/lib/adminApi';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { Drawer } from './Drawer';
import { PrintSlipButton } from './PrintSlipButton';
import { PERMISSIONS } from '@got/shared';
import { useCan } from '@/components/rbac/MeProvider';
import { Person } from './ui';
import { AmendPaymentModal } from './actions/AmendPaymentModal';
import { ConfirmActionModal } from './actions/ConfirmActionModal';
import { ReasonActionModal } from './actions/ReasonActionModal';

/**
 * One payment, in full — the register's detail panel.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PERMISSION GATING HIDES CONTROLS, IT DOES NOT DISABLE THEM.
 *
 * `MemberDrawer`'s rule, applied here: the caller's own `GET /me` permission
 * list decides which menu items EXIST. A disabled "Edit payment" a front-desk
 * operator can see but never click just advertises a capability they do not
 * have. Every route behind one is permission-checked server-side regardless.
 *
 * THERE IS NO VAT BREAKDOWN IN THIS DRAWER, DELIBERATELY. That rendering is
 * legally load-bearing in both directions (RR 7-2024 D.1 and D.2) and lives
 * only in `receipt.presenter.ts`, which the printed slip renders. A second
 * copy here would be a second thing to get wrong, in a place with no legal
 * review — so the drawer shows gross → discount → net and nothing else.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * ⚠ THE COPY THAT MAKES ARCHIVE HONEST.
 *
 * Archiving a still-RECORDED payment is ALLOWED — a hard block would stop it
 * being a soft delete, which is what was asked for. But an operator who thinks
 * "archive" means "this stops counting" will archive a live sale and then
 * wonder why the day's revenue has not moved. Inform, do not block.
 */
export const ARCHIVE_LIVE_PAYMENT_WARNING =
  'This payment still counts toward revenue, the BIR register and its shift total. ' +
  'Archiving only hides it from this list.';

const ARCHIVE_VOIDED_COPY =
  'Hide this payment from the register. Nothing it counts toward changes, and it can be restored.';

type DrawerAction =
  | { kind: 'amend' }
  | { kind: 'void' }
  | { kind: 'refund' }
  | { kind: 'archive' }
  | { kind: 'unarchive' }
  | null;

export function PaymentDrawer({
  paymentId,
  onClose,
  onOpenPayment,
  onOpenMember,
  reloadList,
}: {
  paymentId: string;
  onClose: () => void;
  /** Follow the amendment chain. The page remounts this drawer on the new id. */
  onOpenPayment: (id: string) => void;
  /** Swap to the member drawer — the two NEVER stack. */
  onOpenMember: (userId: string) => void;
  reloadList: () => void;
}) {
  const can = useCan();

  const [action, setAction] = useState<DrawerAction>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const kebabRef = useRef<HTMLDivElement | null>(null);

  const query = useAdminQuery(
    useCallback(() => adminApi.payment(paymentId), [paymentId]),
    `payment:${paymentId}`,
  );
  const payment: PaymentDetail | null = query.data;

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent): void => {
      if (kebabRef.current?.contains(event.target as Node) === false) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  // Mirrors `Drawer`'s own internal `requestClose`: `<Drawer busy>` governs
  // Escape and the backdrop only, so this hand-rolled X needs the same guard
  // applied explicitly (MemberDrawer.tsx:112-115).
  const requestClose = (): void => {
    if (action !== null) return;
    onClose();
  };

  const isVoided = payment?.status === 'VOIDED';
  const isArchived = payment !== null && payment.archivedAt !== null;

  const menuItems: { key: string; label: string; danger?: boolean; onSelect: () => void }[] = [];
  if (payment !== null) {
    if (!isVoided && can(PERMISSIONS.PAYMENT_AMEND)) {
      menuItems.push({
        key: 'amend',
        label: 'Edit payment',
        onSelect: () => setAction({ kind: 'amend' }),
      });
    }
    if (!isVoided && can(PERMISSIONS.PAYMENT_VOID)) {
      menuItems.push({
        key: 'void',
        label: 'Void',
        danger: true,
        onSelect: () => setAction({ kind: 'void' }),
      });
      menuItems.push({
        key: 'refund',
        label: 'Refund',
        danger: true,
        onSelect: () => setAction({ kind: 'refund' }),
      });
    }
    if (can(PERMISSIONS.PAYMENT_ARCHIVE)) {
      menuItems.push(
        isArchived
          ? {
              key: 'unarchive',
              label: 'Put back on the register',
              onSelect: () => setAction({ kind: 'unarchive' }),
            }
          : { key: 'archive', label: 'Archive', onSelect: () => setAction({ kind: 'archive' }) },
      );
    }
  }

  const label = payment === null ? 'Payment' : `${payment.planName} · ${peso(payment.netCentavos)}`;

  return (
    <>
      <Drawer open label={label} busy={action !== null} onClose={onClose}>
        <div className="a-drawer-head">
          <div className="a-drawer-head-main">
            <div className="a-drawer-row-title" style={{ fontSize: 26, lineHeight: 1.2 }}>
              {payment === null ? '—' : peso(payment.netCentavos, { decimals: true })}
            </div>
            <div className="a-drawer-chips">
              {payment !== null && <Badge tone="neutral">{payment.method}</Badge>}
              {payment !== null && (
                <Badge tone={isVoided ? 'danger' : 'ok'}>{payment.status}</Badge>
              )}
              {payment?.voidKind != null && <Badge tone="danger">{payment.voidKind}</Badge>}
              {isArchived && <Badge tone="warn">Archived</Badge>}
              {payment?.vatExempt === true && <Badge tone="info">VAT-exempt</Badge>}
              {payment !== null && <span className="a-drawer-code">{payment.docNo}</span>}
            </div>
          </div>

          <div className="a-drawer-head-actions">
            {menuItems.length > 0 && (
              <div className="a-kebab" ref={kebabRef}>
                <button
                  type="button"
                  className="a-kebab-btn"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label="Payment actions"
                  onClick={() => setMenuOpen((v) => !v)}
                >
                  ⋯
                </button>
                {menuOpen && (
                  <ul className="a-kebab-menu" role="menu">
                    {menuItems.map((item) => (
                      <li key={item.key} role="none">
                        <button
                          type="button"
                          role="menuitem"
                          className="a-kebab-item"
                          data-danger={item.danger === true || undefined}
                          onClick={() => {
                            setMenuOpen(false);
                            item.onSelect();
                          }}
                        >
                          {item.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <button
              type="button"
              className="a-modal-x"
              onClick={requestClose}
              disabled={action !== null}
              aria-label="Close"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                aria-hidden
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="a-drawer-body">
          {query.loading && <p className="a-drawer-empty">Loading…</p>}
          {query.error !== null && <p className="a-drawer-empty">{query.error}</p>}

          {payment !== null && (
            <>
              {/* ── Money ──────────────────────────────────────────── */}
              <section>
                <div className="a-drawer-section-head">
                  <h3 className="a-drawer-section-title">Money</h3>
                </div>
                <div className="a-drawer-row">
                  <div className="a-drawer-row-main">
                    <div className="a-drawer-row-title">Gross</div>
                  </div>
                  <span className="a-drawer-row-amount">
                    {peso(payment.grossCentavos, { decimals: true })}
                  </span>
                </div>
                <div className="a-drawer-row">
                  <div className="a-drawer-row-main">
                    <div className="a-drawer-row-title">
                      {payment.discountType === 'NONE' ? 'No discount' : payment.discountType}
                    </div>
                    {payment.statutoryIdNo !== null && (
                      <div className="a-drawer-row-sub">ID {payment.statutoryIdNo}</div>
                    )}
                    {payment.discountReason !== null && (
                      <div className="a-drawer-row-sub">{payment.discountReason}</div>
                    )}
                  </div>
                  <span className="a-drawer-row-amount">
                    {payment.discountCentavos === 0
                      ? '—'
                      : `− ${peso(payment.discountCentavos, { decimals: true })}`}
                  </span>
                </div>
                <div className="a-drawer-row">
                  <div className="a-drawer-row-main">
                    <div className="a-drawer-row-title">Net collected</div>
                    {/* The VAT breakdown lives on the printed slip and only
                        there — see this file's header. */}
                    <div className="a-drawer-row-sub">
                      The VAT breakdown is on the printed slip.
                    </div>
                  </div>
                  <span className="a-drawer-row-amount">
                    <strong>{peso(payment.netCentavos, { decimals: true })}</strong>
                  </span>
                </div>
              </section>

              {/* ── Payment ────────────────────────────────────────── */}
              <section>
                <div className="a-drawer-section-head">
                  <h3 className="a-drawer-section-title">Payment</h3>
                  <div className="a-drawer-section-actions">
                    {payment.hasProof && <Badge tone="info">Proof on file</Badge>}
                  </div>
                </div>
                <div className="a-drawer-row">
                  <div className="a-drawer-row-main">
                    <div className="a-drawer-row-title">{payment.method}</div>
                    {payment.reference !== null && (
                      <div className="a-drawer-row-sub">ref {payment.reference}</div>
                    )}
                    {payment.method === 'GCASH' && (
                      <div className="a-drawer-row-sub">
                        {payment.gcashVerified
                          ? `Seen in the gym’s Transactions tab by ${
                              payment.gcashVerifiedByName ?? 'staff'
                            }${
                              payment.gcashVerifiedAt === null
                                ? ''
                                : `, ${gymDateTime(payment.gcashVerifiedAt)}`
                            }`
                          : 'Not verified'}
                      </div>
                    )}
                    <div className="a-drawer-row-sub">
                      {payment.receiptNo === null
                        ? 'No BIR invoice number recorded'
                        : `BIR invoice ${payment.receiptNo}`}
                    </div>
                    <div className="a-drawer-row-sub">
                      {gymDateTime(payment.receivedAt)} · business day{' '}
                      {civilDate(payment.businessDate)}
                    </div>
                  </div>
                </div>
              </section>

              {/* ── Payer ──────────────────────────────────────────── */}
              <section>
                <div className="a-drawer-section-head">
                  <h3 className="a-drawer-section-title">Payer</h3>
                  <div className="a-drawer-section-actions">
                    {payment.userId !== null && (
                      <button
                        type="button"
                        className="p-btn p-btn-ghost p-btn-sm"
                        onClick={() => onOpenMember(payment.userId!)}
                      >
                        Open member record
                      </button>
                    )}
                  </div>
                </div>

                {payment.userId === null ? (
                  /*
                   * `userId === null` IS the definition of an off-the-street
                   * guest. There is no member record to open, so no button is
                   * rendered that could only 404 — and NO PHONE: `guestPhone`
                   * sits behind `member.create` on
                   * GET /front-desk/check-ins/:id/guest and is read only for
                   * the conversion hand-off. `payment.read` is not that key.
                   */
                  <div>
                    <div className="a-drawer-row-title">
                      Walk-in guest
                      {payment.checkIn?.guestName == null
                        ? ' · no name recorded'
                        : ` · ${payment.checkIn.guestName}`}
                    </div>
                    <p className="a-drawer-row-sub">No account on file.</p>
                    {can(PERMISSIONS.MEMBER_CREATE) && (
                      <a className="a-linkish" href="/admin/attendance">
                        Convert this visit on the attendance screen
                      </a>
                    )}
                  </div>
                ) : (
                  <div className="a-drawer-row">
                    <div className="a-drawer-row-main">
                      <Person
                        firstName={(payment.payerName ?? 'Member').split(' ')[0] ?? 'Member'}
                        lastName={(payment.payerName ?? '').split(' ').slice(1).join(' ')}
                        sub={payment.payerMemberCode}
                      />
                    </div>
                  </div>
                )}
              </section>

              {/* ── Paid for ───────────────────────────────────────── */}
              <section>
                <div className="a-drawer-section-head">
                  <h3 className="a-drawer-section-title">Paid for</h3>
                </div>
                <div className="a-drawer-row">
                  <div className="a-drawer-row-main">
                    <div className="a-drawer-row-title">{payment.planName}</div>
                    <div className="a-drawer-row-sub">
                      {payment.purpose} · {payment.planCode}
                    </div>
                    {payment.termStartsOn !== null && payment.termEndsOn !== null && (
                      <div className="a-drawer-row-sub">
                        {civilDate(payment.termStartsOn)} – {civilDate(payment.termEndsOn)}
                      </div>
                    )}
                    {payment.checkIn !== null && (
                      <div className="a-drawer-row-sub">
                        Walk-in visit, {gymDateTime(payment.checkIn.occurredAt)}
                      </div>
                    )}
                  </div>
                </div>
              </section>

              {/* ── Trail ──────────────────────────────────────────── */}
              <section>
                <div className="a-drawer-section-head">
                  <h3 className="a-drawer-section-title">Trail</h3>
                </div>
                <p className="a-drawer-row-sub">
                  Recorded by {payment.recordedByName} at {gymDateTime(payment.receivedAt)}
                </p>
                {payment.voidedAt !== null && (
                  <p className="a-drawer-row-sub">
                    Voided by {payment.voidedByName ?? 'staff'} —{' '}
                    {payment.voidReason ?? 'no reason recorded'}
                    {payment.voidKind === null ? '' : ` — ${payment.voidKind}`}
                  </p>
                )}
                {payment.archivedAt !== null && (
                  <p className="a-drawer-row-sub">
                    Archived by {payment.archivedByName ?? 'staff'} on{' '}
                    {gymDateTime(payment.archivedAt)}
                  </p>
                )}

                {/* The amendment chain, both directions, from one column. */}
                {payment.replacesPaymentId !== null && (
                  <p className="a-drawer-row-sub">
                    <button
                      type="button"
                      className="a-linkish"
                      onClick={() => onOpenPayment(payment.replacesPaymentId!)}
                    >
                      Replaces the earlier payment
                    </button>
                  </p>
                )}
                {payment.replacedByPaymentId !== null && (
                  <p className="a-drawer-row-sub">
                    <button
                      type="button"
                      className="a-linkish"
                      onClick={() => onOpenPayment(payment.replacedByPaymentId!)}
                    >
                      Superseded by the correction
                    </button>
                  </p>
                )}
                {payment.notes !== null && (
                  <p className="a-drawer-row-sub">Notes: {payment.notes}</p>
                )}
              </section>

              <div style={{ paddingTop: 4 }}>
                <PrintSlipButton paymentId={payment.id} copy />
              </div>
            </>
          )}
        </div>
      </Drawer>

      {payment !== null && (
        <AmendPaymentModal
          open={action?.kind === 'amend'}
          payment={payment}
          onClose={() => setAction(null)}
          onAmended={(replacement) => {
            reloadList();
            // The row that was open is now VOIDED and the live money is on a
            // DIFFERENT id. Following it is the only outcome that leaves the
            // operator looking at the payment that still counts.
            onOpenPayment(replacement.id);
          }}
        />
      )}

      <ReasonActionModal
        open={action?.kind === 'void'}
        title="Void this payment?"
        subtitle="No money moved — this marks the payment as recorded in error."
        confirmLabel="Void payment"
        cancelLabel="Keep payment"
        danger
        placeholder="Why is this payment being voided?"
        onConfirm={async (reason) => {
          await adminApi.voidPayment(paymentId, reason, 'VOID');
        }}
        onClose={() => setAction(null)}
        onDone={() => {
          query.reload();
          reloadList();
        }}
      />

      <ReasonActionModal
        open={action?.kind === 'refund'}
        title="Refund this payment?"
        subtitle="Money was returned to the member."
        confirmLabel="Refund payment"
        cancelLabel="Keep payment"
        danger
        placeholder="Why is this payment being refunded?"
        onConfirm={async (reason) => {
          await adminApi.voidPayment(paymentId, reason, 'REFUND');
        }}
        onClose={() => setAction(null)}
        onDone={() => {
          query.reload();
          reloadList();
        }}
      />

      <ConfirmActionModal
        open={action?.kind === 'archive'}
        title="Archive this payment?"
        // INFORM, DO NOT BLOCK — see ARCHIVE_LIVE_PAYMENT_WARNING above.
        subtitle={isVoided ? ARCHIVE_VOIDED_COPY : ARCHIVE_LIVE_PAYMENT_WARNING}
        confirmLabel="Archive"
        cancelLabel="Keep on register"
        onConfirm={async () => {
          await adminApi.archivePayment(paymentId);
        }}
        onClose={() => setAction(null)}
        onDone={() => {
          query.reload();
          reloadList();
        }}
      />

      <ConfirmActionModal
        open={action?.kind === 'unarchive'}
        title="Put this payment back on the register?"
        subtitle="This payment appears in the register again. No figure changes either way."
        confirmLabel="Restore"
        cancelLabel="Keep archived"
        onConfirm={async () => {
          await adminApi.unarchivePayment(paymentId);
        }}
        onClose={() => setAction(null)}
        onDone={() => {
          query.reload();
          reloadList();
        }}
      />
    </>
  );
}
