'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminApi, peso, type PaymentMethodCode, type PaymentSummary } from '@/lib/adminApi';
import { ApiError } from '@/lib/api';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { Modal, ModalError } from '../Modal';
import { GcashFields } from '../GcashFields';
import { ReceiptNoField } from '../ReceiptNoField';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * `POST /payments`, and only for what that route actually accepts.
 *
 * `PaymentsService.record` throws `PAYMENT_SHAPE_INVALID` for any `purpose`
 * other than `WALK_IN` — a membership term is sold through `POST /memberships`
 * and a freeze fee inside `POST /memberships/:id/freeze`, each writing its
 * Payment in the same transaction as the row it pays for. So this modal is a
 * walk-in / day-pass sale FOR this member, attributed to their account —
 * `admin/payments/page.tsx` deliberately has no such form for exactly this
 * reason (see its own doc comment); the drawer's version is scoped to one
 * member and does not pretend to be a general "record any payment" tool.
 *
 * No price field: `grossCentavos` must equal the plan's list price
 * server-side, so it is taken from the selected plan rather than typed.
 */
export function RecordPaymentModal({
  open,
  userId,
  memberName,
  onClose,
  onRecorded,
}: {
  open: boolean;
  userId: string;
  memberName: string;
  onClose: () => void;
  onRecorded: (payment: PaymentSummary) => void;
}) {
  const plansQuery = useAdminQuery(useCallback(() => adminApi.plans(), []), 'record-payment-plans');
  const plans = (plansQuery.data?.items ?? []).filter((p) => p.kind === 'WALK_IN' && p.isActive);

  const [planCode, setPlanCode] = useState('');
  const [method, setMethod] = useState<PaymentMethodCode>('CASH');
  const [reference, setReference] = useState('');
  const [gcashVerified, setGcashVerified] = useState(false);
  const [receiptNo, setReceiptNo] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (open && planCode === '' && plans.length > 0) setPlanCode(plans[0]!.code);
  }, [open, plans, planCode]);

  const selectedPlan = plans.find((p) => p.code === planCode) ?? null;

  const reset = (): void => {
    setPlanCode('');
    setMethod('CASH');
    setReference('');
    setGcashVerified(false);
    setReceiptNo('');
    setNotes('');
    setError(null);
    setBusy(false);
    setConfirming(false);
  };

  const close = (): void => {
    if (busy) return;
    reset();
    onClose();
  };

  const valid = selectedPlan !== null;

  const submit = async (): Promise<void> => {
    if (selectedPlan === null) return;
    setBusy(true);
    setError(null);
    try {
      const payment = await adminApi.recordPayment({
        purpose: 'WALK_IN',
        planCode: selectedPlan.code,
        userId,
        grossCentavos: selectedPlan.priceCentavos,
        method,
        reference: reference.trim() === '' ? undefined : reference.trim(),
        gcashVerified: method === 'GCASH' ? gcashVerified : undefined,
        receiptNo: receiptNo.trim() === '' ? undefined : receiptNo.trim(),
        notes: notes.trim() === '' ? undefined : notes.trim(),
      });
      onRecorded(payment);
      reset();
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
        title="Record a payment"
        subtitle={`A walk-in / day-pass sale for ${memberName}. Term plans are sold through Assign plan.`}
        footer={
          <>
            <button type="button" className="p-btn p-btn-ghost" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="p-btn p-btn-gold"
              onClick={() => setConfirming(true)}
              disabled={busy || !valid || plansQuery.loading}
            >
              Take payment
            </button>
          </>
        }
      >
        <div className="a-field">
          <label className="a-field-label" htmlFor="record-pay-plan">
            Plan
          </label>
          <select
            id="record-pay-plan"
            className="a-select"
            style={{ width: '100%' }}
            value={planCode}
            disabled={plansQuery.loading || plans.length === 0}
            onChange={(event) => setPlanCode(event.target.value)}
          >
            {plans.length === 0 && <option value="">— no walk-in plans available —</option>}
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
            {(['CASH', 'GCASH'] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={method === option}
                className="a-seg-btn"
                data-on={method === option || undefined}
                onClick={() => setMethod(option)}
              >
                {option === 'CASH' ? 'Cash' : 'GCash'}
              </button>
            ))}
          </div>
        </div>

        {/* The reference is REQUIRED — this modal used to say "optional" while
            the server 422s on blank. GcashFields owns the field now. */}
        <GcashFields
          method={method}
          reference={reference}
          onReference={setReference}
          verified={gcashVerified}
          onVerified={setGcashVerified}
        />

        <ReceiptNoField value={receiptNo} onChange={setReceiptNo} />

        <div className="a-field">
          <label className="a-field-label" htmlFor="record-pay-notes">
            Notes <span className="a-field-opt">optional</span>
          </label>
          <input
            id="record-pay-notes"
            className="a-input"
            value={notes}
            autoComplete="off"
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>

        <ModalError message={error ?? plansQuery.error} />
      </Modal>

      <ConfirmDialog
        open={open && confirming}
        title={`Take ${selectedPlan === null ? 'this payment' : peso(selectedPlan.priceCentavos)} from ${memberName}?`}
        consequence={`Records a ${selectedPlan?.name ?? 'walk-in'} sale by ${method === 'CASH' ? 'cash' : 'GCash'} against ${memberName}'s account, in the open drawer.`}
        confirmLabel="Take payment"
        cancelLabel="Keep editing"
        busy={busy}
        error={error}
        onConfirm={() => void submit()}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
      />
    </>
  );
}
