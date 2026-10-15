'use client';

import { useState } from 'react';
import { adminApi, type MemberListItem } from '@/lib/adminApi';
import { ApiError } from '@/lib/api';
import { Modal, ModalError } from '../Modal';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * Name, phone, emergency contact — exactly `UpdateMemberDto`'s three fields.
 * Email, role and status are deliberately absent here too: each has its own
 * guarded route so a name edit can never smuggle a privilege change through.
 */
export function EditMemberModal({
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
  const [firstName, setFirstName] = useState(member.firstName);
  const [lastName, setLastName] = useState(member.lastName);
  const [phone, setPhone] = useState(member.phone ?? '');
  const [emergencyContact, setEmergencyContact] = useState(member.emergencyContact ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The form, then the confirmation over the same state. Saving is two
  // clicks on purpose — owner decision: every admin edit is confirmed.
  const [confirming, setConfirming] = useState(false);

  const close = (): void => {
    if (busy) return;
    setError(null);
    setConfirming(false);
    onClose();
  };

  const valid = firstName.trim().length > 0 && lastName.trim().length > 0;

  const submit = async (): Promise<void> => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await adminApi.updateMember(member.userId, {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim() === '' ? undefined : phone.trim(),
        // NOT the same undefined-when-empty treatment as phone: `emergencyContact`
        // is `@Length(0, 200)` server-side specifically so an empty string CLEARS
        // a previously-set contact (`UpdateMemberDto`'s own comment). Sending
        // `undefined` here would leave a stale contact in place with no way for
        // this form to clear it.
        emergencyContact: emergencyContact.trim(),
      });
      onSaved(updated);
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
        title="Edit member"
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
              Save
            </button>
          </>
        }
      >
        <div className="a-field">
          <label className="a-field-label" htmlFor="edit-member-first">
            First name
          </label>
          <input
            id="edit-member-first"
            className="a-input"
            value={firstName}
            autoComplete="off"
            autoFocus
            onChange={(event) => setFirstName(event.target.value)}
          />
        </div>

        <div className="a-field">
          <label className="a-field-label" htmlFor="edit-member-last">
            Last name
          </label>
          <input
            id="edit-member-last"
            className="a-input"
            value={lastName}
            autoComplete="off"
            onChange={(event) => setLastName(event.target.value)}
          />
        </div>

        <div className="a-field">
          <label className="a-field-label" htmlFor="edit-member-phone">
            Phone <span className="a-field-opt">optional</span>
          </label>
          <input
            id="edit-member-phone"
            className="a-input"
            value={phone}
            inputMode="tel"
            autoComplete="off"
            onChange={(event) => setPhone(event.target.value)}
          />
        </div>

        <div className="a-field">
          <label className="a-field-label" htmlFor="edit-member-emergency">
            Emergency contact <span className="a-field-opt">optional</span>
          </label>
          <input
            id="edit-member-emergency"
            className="a-input"
            value={emergencyContact}
            autoComplete="off"
            placeholder="Name, relation, phone — free text"
            onChange={(event) => setEmergencyContact(event.target.value)}
          />
        </div>

        <ModalError message={error} />
      </Modal>

      <ConfirmDialog
        open={open && confirming}
        title={`Save changes to ${member.firstName} ${member.lastName}?`}
        consequence="Updates the name, phone and emergency contact on file. Nothing else about the account changes."
        confirmLabel="Save changes"
        cancelLabel="Keep editing"
        busy={busy}
        error={error}
        onConfirm={() => void submit()}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
      >
        <ul className="a-confirm-facts">
          <li>
            <strong>
              {firstName.trim()} {lastName.trim()}
            </strong>
          </li>
          <li>Phone: {phone.trim() === '' ? 'none' : phone.trim()}</li>
          <li>Emergency contact: {emergencyContact.trim() === '' ? 'none' : emergencyContact.trim()}</li>
        </ul>
      </ConfirmDialog>
    </>
  );
}
