'use client';

import { useCallback, useState } from 'react';
import {
  adminApi,
  peso,
  type DiscountTypeCode,
  type PaymentDetail,
  type PaymentMethodCode,
  type PaymentSummary,
} from '@/lib/adminApi';
import { ApiError } from '@/lib/api';
import { useAdminQuery } from '@/lib/useAdminQuery';
import {
  amendBody,
  draftProblem,
  initialDraft,
  previewAmounts,
  type AmendDraft,
} from '@/lib/payments/amendDraft';
import { Modal, ModalError } from '../Modal';
import { GcashFields } from '../GcashFields';
import { ReceiptNoField } from '../ReceiptNoField';
import { ConfirmDialog } from './ConfirmDialog';
import {
  DiscountAmountField,
  EMPTY_DISCOUNT,
  PriceSummary,
  type DiscountInput,
} from '../DiscountEntry';
import { isDiscretionary, parseDiscount } from '@/lib/payments/discount';

/** What the discount box shows on open: the original's peso discount, if it had one. */
function initialDiscount(payment: PaymentDetail): DiscountInput {
  return isDiscretionary(payment.discountType) && payment.discountCentavos > 0
    ? { mode: 'AMOUNT', input: String(payment.discountCentavos / 100) }
    : EMPTY_DISCOUNT;
}

/**
 * "Edit payment" — the operator-facing name for a VOID-AND-RE-RECORD.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THERE IS NO AMOUNT BOX, AND THERE MUST NOT BE ONE.
 *
 * This system has no free-text amount anywhere: `PaymentsService.record()`
 * refuses any gross that is not the plan's list price, and `computeAmounts()`
 * derives the net from the discount. So "fix a wrong amount" is really fix the
 * PLAN, the DISCOUNT or the METHOD — and the amount follows, computed by the
 * SAME shared function the server writes the row with. The preview below is
 * that function's output, not a second arithmetic.
 *
 * WHAT THE OPERATOR IS AGREEING TO. One transaction voids the row they opened
 * and writes a corrected one in its place. Both stay in the register, linked,
 * because the alternative — an UPDATE — rewrites a figure a member may be
 * holding a printed slip for.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const DISCOUNT_OPTIONS: { value: DiscountTypeCode; label: string }[] = [
  { value: 'NONE', label: 'No discount' },
  { value: 'SENIOR', label: 'Senior citizen (20%)' },
  { value: 'PWD', label: 'PWD (20%)' },
  { value: 'PROMO', label: 'Promo' },
  { value: 'STAFF', label: 'Staff' },
  { value: 'GUEST_PASS', label: 'Guest pass' },
  { value: 'GOODWILL', label: 'Goodwill' },
];

const STATUTORY: DiscountTypeCode[] = ['SENIOR', 'PWD'];
const DISCRETIONARY: DiscountTypeCode[] = ['PROMO', 'STAFF', 'GUEST_PASS', 'GOODWILL'];

/**
 * ⚠ SAID OUT LOUD IN THE UI, not only in a code comment.
 *
 * A closed shift's expected / counted / variance figures are SNAPSHOTS taken
 * at close and are never recomputed. After a correction they no longer equal
 * openingFloat + SUM(net) over the shift's current rows — which is right: they
 * record what was expected when the drawer was physically counted. This is
 * already true of a plain void; amend does not introduce it. An operator who
 * is not told this will report the mismatch as a bug.
 */
export const CLOSED_SHIFT_NOTICE =
  'This payment belongs to a closed shift. The correction does not change that shift’s counted figures.';

export function AmendPaymentModal({
  open,
  payment,
  onClose,
  onAmended,
}: {
  open: boolean;
  payment: PaymentDetail;
  onClose: () => void;
  /** The REPLACEMENT — a different id from the row that was opened. */
  onAmended: (replacement: PaymentSummary) => void;
}) {
  const [draft, setDraft] = useState<AmendDraft>(() => initialDraft(payment));
  const [discount, setDiscount] = useState<DiscountInput>(() => initialDiscount(payment));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The preview above the form is the first look; this is the second, and
  // the one that actually writes (owner decision: every edit is confirmed).
  const [confirming, setConfirming] = useState(false);

  const plansQuery = useAdminQuery(useCallback(() => adminApi.plans(), []), 'amend-plans');
  const plans = (plansQuery.data?.items ?? []).filter((plan) => plan.isActive);

  const set = <K extends keyof AmendDraft>(key: K, value: AmendDraft[K]): void =>
    setDraft((previous) => ({ ...previous, [key]: value }));

  /*
   * The price the preview runs on: the NEWLY SELECTED plan's when the plan
   * changed, else the original's own gross.
   *
   * Never re-read from the plan when the code is unchanged — a plan that has
   * been repriced since the sale would silently reprice a correction that was
   * only meant to fix the method, and the server deliberately does not
   * re-resolve it either.
   */
  const selected = plans.find((plan) => plan.code === draft.planCode) ?? null;
  const priceCentavos =
    draft.planCode === payment.planCode || selected === null
      ? payment.grossCentavos
      : selected.priceCentavos;

  /*
   * The discount in centavos is DERIVED from the box (owner, 2026-10-08), never
   * typed. Only the discretionary four carry an operator figure; for NONE and
   * SENIOR/PWD the original's is left as it was, which the server ignores for
   * those types, so nothing changes that the operator did not change.
   */
  const parsedDiscount = parseDiscount(discount.mode, discount.input, priceCentavos);
  const effective: AmendDraft = {
    ...draft,
    discountCentavos: isDiscretionary(draft.discountType)
      ? parsedDiscount.kind === 'ok'
        ? parsedDiscount.centavos
        : 0
      : payment.discountCentavos,
  };

  const preview = previewAmounts(effective, { priceCentavos }, payment.vatRegistered);
  const body = amendBody(payment, effective);
  const problem =
    parsedDiscount.kind === 'invalid' && isDiscretionary(draft.discountType)
      ? parsedDiscount.message
      : draftProblem(effective);
  const canSave = body !== null && problem === null;

  const close = (): void => {
    if (busy) return;
    setDraft(initialDraft(payment));
    setDiscount(initialDiscount(payment));
    setError(null);
    setConfirming(false);
    onClose();
  };

  const submit = async (): Promise<void> => {
    if (body === null || problem !== null) return;
    setBusy(true);
    setError(null);
    try {
      const replacement = await adminApi.amendPayment(payment.id, body);
      onAmended(replacement);
      setBusy(false);
      setConfirming(false);
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open={open && !confirming}
        onClose={close}
        busy={busy}
        wide
        title="Edit payment"
        subtitle="This voids the original and records a corrected payment in its place. Both stay in the register, linked."
        footer={
          <>
            <button type="button" className="p-btn p-btn-ghost" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="p-btn p-btn-gold"
              onClick={() => setConfirming(true)}
              disabled={busy || !canSave}
            >
              Save correction
            </button>
          </>
        }
      >
        <div className="a-field">
          <label className="a-field-label" htmlFor="amend-plan">
            Plan
          </label>
          <select
            id="amend-plan"
            className="a-select"
            style={{ width: '100%' }}
            value={draft.planCode}
            disabled={plansQuery.loading}
            onChange={(event) => set('planCode', event.target.value)}
          >
            {/* The original's plan is always offered, even if it has since been
                archived — otherwise amending an old sale would silently move it
                onto a plan nobody sold it on. */}
            {plans.every((plan) => plan.code !== payment.planCode) && (
              <option value={payment.planCode}>{payment.planName} (as sold)</option>
            )}
            {plans.map((plan) => (
              <option key={plan.code} value={plan.code}>
                {plan.name} — {peso(plan.priceCentavos)}
              </option>
            ))}
          </select>
        </div>

        <div className="a-field">
          <span className="a-field-label">Method</span>
          <div className="a-seg" role="radiogroup" aria-label="Payment method">
            {(['CASH', 'GCASH'] as PaymentMethodCode[]).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={draft.method === option}
                className="a-seg-btn"
                data-on={draft.method === option || undefined}
                onClick={() => set('method', option)}
              >
                {option === 'CASH' ? 'Cash' : 'GCash'}
              </button>
            ))}
          </div>
        </div>

        <GcashFields
          method={draft.method}
          reference={draft.reference}
          onReference={(value) => set('reference', value)}
          verified={draft.gcashVerified}
          onVerified={(value) => set('gcashVerified', value)}
        />

        <div className="a-field">
          <label className="a-field-label" htmlFor="amend-discount">
            Discount
          </label>
          <select
            id="amend-discount"
            className="a-select"
            style={{ width: '100%' }}
            value={draft.discountType}
            onChange={(event) => set('discountType', event.target.value as DiscountTypeCode)}
          >
            {DISCOUNT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {/* Statutory discounts are computed, never typed: RA 9994 / RA 10754
              put the 20% on the VAT-exclusive base and the server owns that
              arithmetic. */}
          {STATUTORY.includes(draft.discountType) && (
            <p className="a-field-hint">
              The 20% is computed from the list price — it is never typed.
            </p>
          )}
        </div>

        {STATUTORY.includes(draft.discountType) && (
          <div className="a-field">
            <label className="a-field-label" htmlFor="amend-statutory-id">
              OSCA / PWD ID number
            </label>
            <input
              id="amend-statutory-id"
              className="a-input"
              value={draft.statutoryIdNo}
              maxLength={64}
              autoComplete="off"
              onChange={(event) => set('statutoryIdNo', event.target.value)}
            />
            <p className="a-field-hint">BIR keeps that register separately.</p>
          </div>
        )}

        {DISCRETIONARY.includes(draft.discountType) && (
          <>
            <DiscountAmountField
              id="amend-discount-amount"
              value={discount}
              onChange={setDiscount}
              priceCentavos={priceCentavos}
              parsed={parsedDiscount}
            />
            <div className="a-field">
              <label className="a-field-label" htmlFor="amend-discount-reason">
                Discount reason
              </label>
              <input
                id="amend-discount-reason"
                className="a-input"
                value={draft.discountReason}
                maxLength={200}
                autoComplete="off"
                onChange={(event) => set('discountReason', event.target.value)}
              />
            </div>
          </>
        )}

        {/* The money, before and after, from the shared computeAmounts. */}
        <PriceSummary
          itemName={selected?.name ?? payment.planName}
          amounts={preview}
          discountType={draft.discountType}
          wasCentavos={payment.netCentavos}
        />

        <ReceiptNoField value={draft.receiptNo} onChange={(value) => set('receiptNo', value)} />

        <div className="a-field">
          <label className="a-field-label" htmlFor="amend-notes">
            Notes <span className="a-field-opt">optional</span>
          </label>
          <input
            id="amend-notes"
            className="a-input"
            value={draft.notes}
            maxLength={500}
            autoComplete="off"
            onChange={(event) => set('notes', event.target.value)}
          />
        </div>

        <div className="a-field">
          <label className="a-field-label" htmlFor="amend-reason">
            Why is this being corrected?
          </label>
          <textarea
            id="amend-reason"
            className="a-textarea"
            rows={2}
            value={draft.reason}
            maxLength={200}
            placeholder="e.g. rang the day pass instead of the monthly"
            onChange={(event) => set('reason', event.target.value)}
          />
          <p className="a-field-hint">
            Recorded on both rows and in the audit trail. At least 3 characters.
          </p>
        </div>

        {/* Not a blocker — the amend is legitimate either way. It exists so a
            mismatch the operator will see later is not a surprise. */}
        <p className="a-field-hint">{CLOSED_SHIFT_NOTICE}</p>

        {body === null && problem === null && (
          <p className="a-field-hint">Change something above before saving.</p>
        )}

        <ModalError message={error ?? (draft.reason === '' ? null : problem) ?? plansQuery.error} />
      </Modal>

      <ConfirmDialog
        open={open && confirming}
        title={`Correct this ${peso(payment.netCentavos, { decimals: true })} payment?`}
        consequence={
          `Voids the original and records a corrected ` +
          `${preview === null ? '' : `${peso(preview.netCentavos, { decimals: true })} `}` +
          `payment in its place. Both stay in the register, linked.`
        }
        confirmLabel="Save correction"
        cancelLabel="Keep editing"
        busy={busy}
        error={error}
        onConfirm={() => void submit()}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
      >
        <ul className="a-confirm-facts">
          <li>Reason: {draft.reason.trim()}</li>
        </ul>
      </ConfirmDialog>
    </>
  );
}
