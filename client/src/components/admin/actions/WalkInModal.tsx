'use client';

import { useState } from 'react';
import { adminApi } from '@/lib/adminApi';
import { ApiError } from '@/lib/api';
import { Modal, ModalError } from '../Modal';
import { GcashFields } from '../GcashFields';
import { ReceiptNoField } from '../ReceiptNoField';
import { ConfirmDialog } from './ConfirmDialog';
import { EMAIL_MAX, EMERGENCY_CONTACT_MAX } from '@got/shared';
import { validateWalkInGuest, walkInSaleProblem } from '@/lib/walkInGuest';
import { saleReference } from '@/lib/paymentReference';
import { NameInput } from '@/components/inputs/NameInput';
import { PhoneInput } from '@/components/inputs/PhoneInput';

/**
 * Sell a day pass at the counter.
 *
 * This is the ONLY walk-in money path on the dashboard, and it is deliberately
 * not paired with a general "record a payment" action. `POST /payments`
 * refuses every purpose except WALK_IN — a membership term is sold through
 * `POST /memberships`, a renewal through `/memberships/:id/renew`, and a
 * freeze fee through `/memberships/:id/freeze`, each writing its Payment
 * inside the same transaction as the row it pays for, so money can never be
 * taken for a term that was never created. A "Record payment" button on this
 * page would therefore be either a duplicate of this one or a guaranteed 422.
 *
 * No price field: the server resolves the walk-in plan and its list price
 * itself, and refuses a stale figure rather than writing a receipt for a price
 * nobody published. There is nothing here for the operator to get wrong.
 */
export function WalkInModal({
  open,
  onClose,
  onSold,
}: {
  open: boolean;
  onClose: () => void;
  onSold: () => void;
}) {
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [method, setMethod] = useState<'CASH' | 'GCASH'>('CASH');
  const [waiverAccepted, setWaiverAccepted] = useState(false);
  const [emergencyContact, setEmergencyContact] = useState('');
  const [reference, setReference] = useState('');
  const [gcashVerified, setGcashVerified] = useState(false);
  const [receiptNo, setReceiptNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const close = (): void => {
    setConfirming(false);
    setGuestName('');
    setGuestEmail('');
    setGuestPhone('');
    setMethod('CASH');
    setReference('');
    setGcashVerified(false);
    setReceiptNo('');
    setWaiverAccepted(false);
    setEmergencyContact('');
    setError(null);
    setBusy(false);
    onClose();
  };

  const guest = validateWalkInGuest({ name: guestName, phone: guestPhone, emergencyContact });
  const saleProblem = walkInSaleProblem({
    guest: true,
    name: guestName,
    email: guestEmail,
    phone: guestPhone,
    emergencyContact,
    waiverAccepted,
    method,
    reference,
  });

  const submit = async (): Promise<void> => {
    if (!guest.ok) {
      setError(guest.problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adminApi.sellWalkIn({
        kind: 'WALK_IN',
        ...guest.fields,
        guestEmail: guestEmail.trim().toLowerCase(),
        method,
        reference: saleReference(method, reference),
        gcashVerified: method === 'GCASH' ? gcashVerified : undefined,
        receiptNo: receiptNo.trim() === '' ? undefined : receiptNo.trim(),
        // The server refuses an account-less walk-in without this — the guest
        // is the one person in the building with no waiver on file otherwise.
        guestWaiverAccepted: waiverAccepted,
      });
      onSold();
      close();
    } catch (caught) {
      // Kept open with the form intact — a failed sale at a counter is
      // retried, not retyped.
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
        title="Sell a walk-in"
        subtitle="A day pass for someone without a membership. The price comes from the plan."
        footer={
          <>
            <button type="button" className="p-btn p-btn-ghost" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="p-btn p-btn-gold"
              // Enabled: a click says what is missing (ModalError below)
              // rather than a disabled button that never explains itself.
              onClick={() => {
                if (saleProblem !== null) {
                  setError(saleProblem);
                  return;
                }
                setError(null);
                setConfirming(true);
              }}
              disabled={busy}
            >
              Take payment
            </button>
          </>
        }
      >
        <div className="a-field">
          <label className="a-field-label" htmlFor="walkin-name">
            Guest name
          </label>
          <NameInput
            id="walkin-name"
            className="a-input"
            value={guestName}
            autoComplete="off"
            placeholder="Who is paying?"
            onChange={setGuestName}
          />
        </div>

        <div className="a-field">
          <label className="a-field-label" htmlFor="walkin-email">
            Email
          </label>
          <input
            id="walkin-email"
            className="a-input"
            type="email"
            value={guestEmail}
            maxLength={EMAIL_MAX}
            inputMode="email"
            autoComplete="off"
            placeholder="Where their member link goes if they join"
            onChange={(event) => setGuestEmail(event.target.value)}
          />
        </div>

        <div className="a-field">
          <label className="a-field-label" htmlFor="walkin-phone">
            Phone <span className="a-field-opt">optional</span>
          </label>
          <PhoneInput
            id="walkin-phone"
            className="a-input"
            value={guestPhone}
            autoComplete="off"
            onChange={setGuestPhone}
          />
        </div>

        <div className="a-field">
          <label className="a-field-label" htmlFor="walkin-emergency">
            Emergency contact <span className="a-field-opt">optional</span>
          </label>
          <input
            id="walkin-emergency"
            className="a-input"
            value={emergencyContact}
            autoComplete="off"
            maxLength={EMERGENCY_CONTACT_MAX}
            placeholder="Name and number, e.g. Maria 0917 000 0000"
            onChange={(event) => setEmergencyContact(event.target.value)}
          />
        </div>

        {/*
          THE GATE. The take-payment button stays disabled until this is ticked,
          because the server refuses the sale without it: a walk-in guest used to
          be the one person on the floor with no record of having been warned
          about anything. Staff read the line to the guest, or hand them the
          phone with /waiver open — either way the acceptance is stamped onto
          this visit with the waiver version.
        */}
        <div className="a-field">
          <label
            className="a-field-label"
            htmlFor="walkin-waiver"
            style={{ display: 'flex', alignItems: 'flex-start', gap: 9, cursor: 'pointer' }}
          >
            <input
              id="walkin-waiver"
              type="checkbox"
              checked={waiverAccepted}
              onChange={(event) => setWaiverAccepted(event.target.checked)}
              style={{ marginTop: 2, width: 15, height: 15, accentColor: 'var(--gold)', flex: 'none' }}
            />
            <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
              The guest has read and accepted the{' '}
              <a href="/waiver" target="_blank" rel="noopener noreferrer">
                liability waiver
              </a>
              . Required before entry.
            </span>
          </label>
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

        <GcashFields
          method={method}
          reference={reference}
          onReference={setReference}
          verified={gcashVerified}
          onVerified={setGcashVerified}
        />

        <ReceiptNoField value={receiptNo} onChange={setReceiptNo} collapsible />

        <ModalError message={error} />
      </Modal>

      <ConfirmDialog
        open={open && confirming}
        title={`Sell a day pass to ${guestName.trim() === '' ? 'this guest' : guestName.trim()}?`}
        consequence={`Takes the walk-in price by ${method === 'CASH' ? 'cash' : 'GCash'} into the open drawer and checks them in straight away. The price comes from the plan.`}
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
