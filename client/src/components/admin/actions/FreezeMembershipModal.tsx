'use client';

import { useState } from 'react';
import { adminApi, civilDate, type MembershipDetail, type PaymentMethodCode } from '@/lib/adminApi';
import { ApiError } from '@/lib/api';
import { Modal, ModalError } from '../Modal';
import { GcashFields } from '../GcashFields';
import { ReceiptNoField } from '../ReceiptNoField';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * Route 26 — ADMIN only server-side; the drawer just hides the button if the
 * caller lacks `membership.freeze`, the route still enforces it.
 *
 * `endsOn` is mandatory (§5.6): an open-ended freeze reads as a cancellation
 * nobody asked for. Fee fields only appear when the freeze is NOT medical
 * (`feeWaived` off) — a fee-waived freeze has nothing to record a payment
 * method for.
 */
export function FreezeMembershipModal({
  open,
  membershipId,
  memberName,
  onClose,
  onFrozen,
}: {
  open: boolean;
  membershipId: string;
  memberName: string;
  onClose: () => void;
  onFrozen: (detail: MembershipDetail) => void;
}) {
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [reason, setReason] = useState('');
  const [feeWaived, setFeeWaived] = useState(false);
  const [method, setMethod] = useState<PaymentMethodCode>('CASH');
  const [reference, setReference] = useState('');
  const [gcashVerified, setGcashVerified] = useState(false);
  const [receiptNo, setReceiptNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const reset = (): void => {
    setStartsOn('');
    setEndsOn('');
    setReason('');
    setFeeWaived(false);
    setMethod('CASH');
    setReference('');
    setGcashVerified(false);
    setReceiptNo('');
    setError(null);
    setBusy(false);
    setConfirming(false);
  };

  const close = (): void => {
    if (busy) return;
    reset();
    onClose();
  };

  const trimmedReason = reason.trim();
  const valid =
    startsOn !== '' &&
    endsOn !== '' &&
    endsOn >= startsOn &&
    trimmedReason.length >= 3 &&
    trimmedReason.length <= 200;

  const submit = async (): Promise<void> => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const detail = await adminApi.freezeMembership(membershipId, {
        startsOn,
        endsOn,
        reason: trimmedReason,
        feeWaived,
        method: feeWaived ? undefined : method,
        reference: feeWaived || reference.trim() === '' ? undefined : reference.trim(),
        gcashVerified: !feeWaived && method === 'GCASH' ? gcashVerified : undefined,
        receiptNo: feeWaived || receiptNo.trim() === '' ? undefined : receiptNo.trim(),
      });
      onFrozen(detail);
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
        title="Freeze the membership"
        subtitle={`For ${memberName}. The end date is mandatory — an open-ended freeze is a cancellation.`}
        footer={
          <>
            <button type="button" className="p-btn p-btn-ghost" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="p-btn p-btn-gold"
              onClick={() => setConfirming(true)}
              disabled={busy || !valid}
            >
              Freeze
            </button>
          </>
        }
      >
        <div className="a-field">
          <label className="a-field-label" htmlFor="freeze-starts">
            Starts on
          </label>
          <input
            id="freeze-starts"
            className="a-input"
            type="date"
            value={startsOn}
            onChange={(event) => setStartsOn(event.target.value)}
          />
        </div>

        <div className="a-field">
          <label className="a-field-label" htmlFor="freeze-ends">
            Ends on
          </label>
          <input
            id="freeze-ends"
            className="a-input"
            type="date"
            value={endsOn}
            min={startsOn === '' ? undefined : startsOn}
            onChange={(event) => setEndsOn(event.target.value)}
          />
        </div>

        <div className="a-field">
          <label className="a-field-label" htmlFor="freeze-reason">
            Reason
          </label>
          <textarea
            id="freeze-reason"
            className="a-textarea"
            rows={3}
            value={reason}
            placeholder="At least 3 characters"
            onChange={(event) => setReason(event.target.value)}
          />
          <p className="a-field-hint">{trimmedReason.length}/200 characters — at least 3 required.</p>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
          <input
            type="checkbox"
            checked={feeWaived}
            onChange={(event) => setFeeWaived(event.target.checked)}
          />
          Medical freeze — waive the fee
        </label>

        {!feeWaived && (
          <>
            <div className="a-field">
              <span className="a-field-label">Fee method</span>
              <div className="a-seg" role="radiogroup" aria-label="Fee payment method">
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

            <GcashFields
              method={method}
              reference={reference}
              onReference={setReference}
              verified={gcashVerified}
              onVerified={setGcashVerified}
            />

            <ReceiptNoField value={receiptNo} onChange={setReceiptNo} />
          </>
        )}

        <ModalError message={error} />
      </Modal>

      <ConfirmDialog
        open={open && confirming}
        title={`Freeze ${memberName}'s membership?`}
        consequence={
          startsOn === '' || endsOn === ''
            ? 'The membership is frozen for the dates chosen.'
            : `Frozen from ${civilDate(startsOn)} to ${civilDate(endsOn)}. The days frozen are added back to the end of the term.`
        }
        confirmLabel="Freeze membership"
        cancelLabel="Keep editing"
        busy={busy}
        error={error}
        onConfirm={() => void submit()}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
      >
        <ul className="a-confirm-facts">
          <li>Reason: {trimmedReason}</li>
          <li>
            {feeWaived
              ? 'Medical freeze — no fee is taken.'
              : `The freeze fee is taken by ${method === 'CASH' ? 'cash' : 'GCash'}.`}
          </li>
        </ul>
      </ConfirmDialog>
    </>
  );
}
