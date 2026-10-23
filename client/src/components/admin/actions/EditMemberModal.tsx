'use client';

import { useState } from 'react';
import { EMERGENCY_CONTACT_MAX } from '@got/shared';
import { memberEditPatch } from '@/lib/memberEdit';
import { adminApi, type MemberListItem } from '@/lib/adminApi';
import { CharCounter } from '@/components/inputs/CharCounter';
import { NameInput } from '@/components/inputs/NameInput';
import { PhoneInput } from '@/components/inputs/PhoneInput';
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

  // Only a CHANGED field is checked and sent (like the member's own account
  // page): a legacy name with a digit or an old landline never blocks editing
  // something else. A changed phone goes as +639XXXXXXXXX; blank clears.
  const { patch, problem } = memberEditPatch(member, {
    firstName,
    lastName,
    phone,
    emergencyContact,
  });
  const phoneChanged = phone.trim() !== (member.phone ?? '');
  const valid = problem === null && Object.keys(patch).length > 0;

  const submit = async (): Promise<void> => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await adminApi.updateMember(member.userId, patch);
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
          <NameInput
            id="edit-member-first"
            className="a-input"
            value={firstName}
            autoComplete="off"
            autoFocus
            onChange={setFirstName}
          />
        </div>

        <div className="a-field">
          <label className="a-field-label" htmlFor="edit-member-last">
            Last name
          </label>
          <NameInput
            id="edit-member-last"
            className="a-input"
            value={lastName}
            autoComplete="off"
            onChange={setLastName}
          />
        </div>

        <div className="a-field">
          <label className="a-field-label" htmlFor="edit-member-phone">
            Phone <span className="a-field-opt">optional</span>
          </label>
          <PhoneInput
            id="edit-member-phone"
            className="a-input"
            value={phone}
            autoComplete="off"
            onChange={setPhone}
            error={phoneChanged ? undefined : null}
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
            maxLength={EMERGENCY_CONTACT_MAX}
            aria-describedby="edit-member-emergency-count"
            placeholder="Name, relation, phone — free text"
            onChange={(event) => setEmergencyContact(event.target.value)}
          />
          <CharCounter
            id="edit-member-emergency-count"
            value={emergencyContact}
            max={EMERGENCY_CONTACT_MAX}
          />
        </div>

        <ModalError message={error ?? problem} />
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
