'use client';

import { useCallback, useState } from 'react';
import type { CheckInRecord, DeskDenial } from '@got/shared';
import { ApiError } from '@/lib/api';
import { adminApi, peso, type DiscountTypeCode } from '@/lib/adminApi';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { isPlausibleEmail } from '@/lib/guestEmail';
import { saleAmounts } from '@/lib/payments/discount';
import { useVatRegistered } from './DiscountEntry';
import { Card, CardHead } from '@/components/portal/ui';
import { GcashFields } from './GcashFields';
import { ReceiptNoField } from './ReceiptNoField';
import { ConfirmDialog } from './actions/ConfirmDialog';

/**
 * The walk-in sale.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS WHAT A DENIAL CONVERTS INTO, AND THE WINDOW IS ABOUT NINETY SECONDS.
 *
 * When it opens from a denial card the member is ALREADY IDENTIFIED and the
 * `denialId` rides along — so the sale both admits them and closes the funnel
 * in one action. Every field that can be pre-filled is pre-filled, because the
 * cost of this sheet is measured against a person standing at a counter who
 * has just been told no.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE PRICE IS READ FROM THE PLAN, NOT TYPED. The server recomputes it and
 * refuses a mismatch, so a stale sheet cannot ring a different number than the
 * one the member was quoted. `netCentavos` here is the console SAYING what it
 * displayed — a cross-check, not an instruction.
 */
export function WalkInSheet({
  denial,
  onSold,
  onClose,
  closeLabel = 'Cancel',
  frameless = false,
}: {
  /** Pre-fills the member and closes the funnel. Absent for someone off the street. */
  denial?: DeskDenial;
  /** The sold entry — carries `paymentId` so the caller can offer the slip. */
  onSold: (record: CheckInRecord) => void;
  onClose: () => void;
  /** The always-open card on /admin/walk-ins reads "Clear", not "Cancel". */
  closeLabel?: string;
  /**
   * Render without the Card shell — for mounting inside a `Drawer`, whose
   * panel already frames the content. A Card inside a drawer double-frames.
   */
  frameless?: boolean;
}) {
  const [method, setMethod] = useState<'CASH' | 'GCASH'>('CASH');
  const [reference, setReference] = useState('');
  const [gcashVerified, setGcashVerified] = useState(false);
  const [receiptNo, setReceiptNo] = useState('');
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [guestEmergencyContact, setGuestEmergencyContact] = useState('');
  const [discountType, setDiscountType] = useState('');
  const [statutoryIdNo, setStatutoryIdNo] = useState('');
  const [waiverAccepted, setWaiverAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Money moves on confirm: the Charge button asks first, with the amount.
  const [confirming, setConfirming] = useState(false);

  const plans = useAdminQuery(
    useCallback(() => adminApi.plans(), []),
    'walkin-plan',
  );
  const walkInPlan = plans.data?.items.find((p) => p.code === 'WALKIN');

  const statutory = discountType === 'SENIOR' || discountType === 'PWD';
  const forMember = denial !== undefined;

  /*
   * The total the member actually pays, worked out here with the shared
   * arithmetic the server saves with (owner, 2026-10-08: the price has to
   * change when a discount is applied). Used to read "before statutory
   * discount" with the real figure left to the server.
   */
  const price = walkInPlan === undefined ? null : walkInPlan.priceCentavos;
  const vatRegistered = useVatRegistered();
  const amounts = saleAmounts({
    priceCentavos: price,
    discountType: discountType as DiscountTypeCode | '',
    vatRegistered,
    operatorDiscountCentavos: 0,
  });
  const due = amounts === null ? null : amounts.netCentavos;
  // Whole pesos print without centavos, so ₱72 sits beside ₱90 rather than ₱90.00.
  const money = (centavos: number): string => peso(centavos, { decimals: centavos % 100 !== 0 });
  const dueLabel = due === null ? null : money(due);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const record = await adminApi.sellWalkIn({
        kind: 'WALK_IN',
        method,
        ...(method === 'GCASH' ? { reference, gcashVerified } : {}),
        ...(receiptNo.trim() === '' ? {} : { receiptNo: receiptNo.trim() }),
        // The console saying what it displayed — the server refuses a
        // mismatch, so a stale sheet cannot ring a number the member was
        // never quoted. The headline is the NET now, discount included, and
        // the server compares against net.
        ...(due === null ? {} : { netCentavos: due }),
        ...(forMember
          ? { userId: denial.member.userId ?? undefined, denialId: denial.denialId }
          : {
              guestName,
              guestEmail: guestEmail.trim().toLowerCase(),
              ...(guestPhone === '' ? {} : { guestPhone }),
              ...(guestEmergencyContact.trim() === ''
                ? {}
                : { guestEmergencyContact: guestEmergencyContact.trim() }),
              // Required by the server for anyone without an account — see
              // WalkInModal. A member resolved from a denial already accepted
              // theirs in the portal, so it is not asked for again.
              guestWaiverAccepted: waiverAccepted,
            }),
        ...(discountType === '' ? {} : { discountType }),
        ...(statutory ? { statutoryIdNo } : {}),
      });
      setConfirming(false);
      onSold(record);
      onClose();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.code === 'SHIFT_NOT_OPEN'
            ? 'Open the cash drawer first — money has to land in a counted till.'
            : caught.code === 'PAYMENT_AMOUNT_MISMATCH'
              ? 'The price list changed since this sheet opened. Close it and start again.'
              : caught.message
          : 'Something went wrong.',
      );
    } finally {
      setBusy(false);
    }
  };

  const who = forMember
    ? `${denial.member.firstName} ${denial.member.lastName}`
    : guestName.trim() === ''
      ? 'this guest'
      : guestName.trim();
  const how = method === 'CASH' ? 'cash' : 'GCash';

  /*
   * THE VIEW IS A CHECKOUT, NOT A FORM. Hierarchy: the money (total + one
   * big Charge button) anchors a persistent footer. Fitts: the two per-sale
   * choices — method, discount — are large one-tap targets, never dropdowns.
   * Gestalt: two labelled zones, WHO left, PAYMENT right, one column under
   * 680px. Consent renders as a bordered box because a waiver is a legal
   * act, not another input. State and the submit path above are untouched —
   * this block is presentation only.
   */
  const body = (
    <form
      className="a-sheet"
      onSubmit={(event) => {
        event.preventDefault();
        // The form's own `required` checks have passed; the write waits for
        // the confirmation below.
        setError(null);
        setConfirming(true);
      }}
    >
      <div className="a-co-grid">
        <section className="a-co-section">
          <span className="a-co-label">{forMember ? 'Member' : 'Who’s training'}</span>

          {forMember ? (
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>
                {denial.member.firstName} {denial.member.lastName}
              </div>
              <span className="a-person-sub">
                {denial.member.memberCode ?? 'member'} · converting a denial — waiver on file
              </span>
            </div>
          ) : (
            <>
              <label>
                <span className="a-person-sub">GUEST NAME</span>
                <input
                  className="a-input"
                  value={guestName}
                  required
                  minLength={2}
                  onChange={(event) => setGuestName(event.target.value)}
                />
              </label>
              <label>
                <span className="a-person-sub">EMAIL</span>
                <input
                  className="a-input"
                  type="email"
                  value={guestEmail}
                  required
                  autoComplete="off"
                  inputMode="email"
                  onChange={(event) => setGuestEmail(event.target.value)}
                  placeholder="where their member link goes if they join"
                />
              </label>
              <label>
                <span className="a-person-sub">PHONE OPTIONAL</span>
                <input
                  className="a-input"
                  value={guestPhone}
                  onChange={(event) => setGuestPhone(event.target.value)}
                  placeholder="they can decline"
                />
              </label>
              <label>
                <span className="a-person-sub">EMERGENCY CONTACT OPTIONAL</span>
                <input
                  className="a-input"
                  value={guestEmergencyContact}
                  onChange={(event) => setGuestEmergencyContact(event.target.value)}
                  placeholder="name and number"
                />
              </label>

              <label className="a-co-consent">
                <input
                  type="checkbox"
                  checked={waiverAccepted}
                  onChange={(event) => setWaiverAccepted(event.target.checked)}
                  style={{ marginTop: 2, width: 15, height: 15, accentColor: 'var(--gold)', flex: 'none' }}
                />
                <span style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--p-ink2)' }}>
                  The guest has read and accepted the{' '}
                  <a href="/waiver" target="_blank" rel="noopener noreferrer">
                    liability waiver
                  </a>
                  . Required before entry.
                </span>
              </label>
            </>
          )}
        </section>

        <section className="a-co-section">
          <span className="a-co-label">Payment</span>

          <div className="a-seg" role="group" aria-label="Payment method">
            {(['CASH', 'GCASH'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={method === option}
                onClick={() => setMethod(option)}
              >
                {option === 'CASH' ? 'Cash' : 'GCash'}
              </button>
            ))}
          </div>

          <span className="a-person-sub">DISCOUNT</span>
          <div className="a-chips" role="group" aria-label="Discount">
            {(
              [
                ['', 'None'],
                ['SENIOR', 'Senior citizen'],
                ['PWD', 'PWD'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={label}
                type="button"
                aria-pressed={discountType === value}
                onClick={() => setDiscountType(value)}
              >
                {label}
              </button>
            ))}
          </div>

          <GcashFields
            method={method}
            reference={reference}
            onReference={setReference}
            verified={gcashVerified}
            onVerified={setGcashVerified}
          />

          {statutory ? (
            <label>
              <span className="a-person-sub">{discountType === 'SENIOR' ? 'OSCA ID' : 'PWD ID'}</span>
              <input
                className="a-input"
                value={statutoryIdNo}
                required
                onChange={(event) => setStatutoryIdNo(event.target.value)}
              />
            </label>
          ) : null}

          <ReceiptNoField value={receiptNo} onChange={setReceiptNo} collapsible highlight={statutory} />
        </section>
      </div>

      {error === null ? null : (
        <p role="alert" style={{ color: 'var(--p-danger)', fontSize: 14, margin: 0 }}>
          {error}
        </p>
      )}

      <div className="a-co-foot">
        <div className="a-co-total">
          <span className="a-person-sub">
            {statutory ? 'TOTAL · LESS 20% DISCOUNT' : 'TOTAL · TODAY ONLY'}
          </span>
          <strong>{dueLabel ?? '—'}</strong>
          {statutory && amounts !== null ? (
            <span className="a-person-sub">
              {money(amounts.grossCentavos)} less{' '}
              {money(amounts.grossCentavos - amounts.netCentavos)}
              {amounts.vatExempt ? ' (VAT-exempt)' : ''}
            </span>
          ) : null}
        </div>
        <button
          type="submit"
          className="p-btn p-btn-gold"
          disabled={
            busy ||
            (!forMember &&
              (!waiverAccepted || guestName.trim().length < 2 || !isPlausibleEmail(guestEmail)))
          }
        >
          {busy ? 'Recording…' : dueLabel === null ? 'Take payment' : `Charge ${dueLabel}`}
        </button>
      </div>

      <ConfirmDialog
        open={confirming}
        title={`Sell a day pass to ${who}?`}
        consequence={
          dueLabel === null
            ? `Takes the walk-in price by ${how} and checks ${who} in now.`
            : statutory
              ? `Takes ${dueLabel} — the day pass less the 20% ${discountType === 'SENIOR' ? 'senior citizen' : 'PWD'} discount — by ${how} and checks ${who} in now.`
              : `Takes ${dueLabel} by ${how} and checks ${who} in now.`
        }
        confirmLabel={dueLabel === null ? 'Take payment' : `Charge ${dueLabel}`}
        cancelLabel="Back to the sale"
        busy={busy}
        error={error}
        onConfirm={() => void submit()}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
      />
    </form>
  );

  if (frameless) return body;

  return (
    <Card style={{ borderColor: 'var(--gold)' }}>
      <CardHead
        title={forMember ? `Walk-in for ${denial.member.firstName}` : 'Walk-in'}
        action={
          <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={onClose}>
            {closeLabel}
          </button>
        }
      />
      {body}
    </Card>
  );
}
