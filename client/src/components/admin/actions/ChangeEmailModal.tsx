'use client';

import { useState } from 'react';
import { adminApi, type MemberListItem } from '@/lib/adminApi';
import { ApiError } from '@/lib/api';
import { isPlausibleEmail } from '@/lib/guestEmail';
import { Modal, ModalError } from '../Modal';
import { ConfirmDialog } from './ConfirmDialog';
import { EMAIL_MAX } from '@got/shared';

/**
 * Correct a mistyped email on a member who has never signed in — the counter's
 * fix when the setup link went to the wrong inbox. The server refuses it for
 * anybody who has signed in (their login address is theirs to change) and sends
 * the setup link to the new address on success.
 */
export function ChangeEmailModal({
  open,
  member,
  onClose,
  onSaved,
}: {
  open: boolean;
  member: MemberListItem;
  onClose: () => void;
  onSaved: (updated: MemberListItem) => void;
}) {
  const [email, setEmail] = useState(member.email);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sent, setSent] = useState<boolean | null>(null);

  const next = email.trim().toLowerCase();
  const valid = isPlausibleEmail(next) && next !== member.email;

  const close = (): void => {
    if (busy) return;
    setError(null);
    setConfirming(false);
    setSent(null);
    setEmail(member.email);
    onClose();
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await adminApi.changeMemberEmail(member.userId, next);
      onSaved(result.member);
      setSent(result.emailSent);
      setConfirming(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open={open && !confirming}
        onClose={close}
        busy={busy}
        title="Change email"
        subtitle="For a member who has never signed in. The setup link goes to the new address."
        footer={
          sent === null ? (
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
                Save
              </button>
            </>
          ) : (
            <button type="button" className="p-btn p-btn-gold" onClick={close}>
              Done
            </button>
          )
        }
      >
        {sent === null ? (
          <div className="a-field">
            <label className="a-field-label" htmlFor="change-email-input">
              Email
            </label>
            <input
              id="change-email-input"
              className="a-input"
              type="email"
              value={email}
              maxLength={EMAIL_MAX}
              inputMode="email"
              autoComplete="off"
              autoFocus
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
        ) : (
          <p style={{ margin: 0 }}>
            {sent
              ? `The setup link was sent to ${next}.`
              : `The email is saved, but the setup link may not have gone out. Use "Resend invite" to try again.`}
          </p>
        )}
        <ModalError message={confirming ? null : error} />
      </Modal>

      <ConfirmDialog
        open={open && confirming}
        title={`Change ${member.firstName} ${member.lastName}'s email?`}
        consequence="Their setup link goes to the new address, and the old link stops working."
        confirmLabel="Change email"
        cancelLabel="Keep editing"
        busy={busy}
        error={error}
        onConfirm={() => void submit()}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
      >
        <ul className="a-confirm-facts">
          <li>From: {member.email}</li>
          <li>
            To: <strong>{next}</strong>
          </li>
        </ul>
      </ConfirmDialog>
    </>
  );
}
