'use client';

import { useState } from 'react';
import { roleLabel } from '@got/shared';
import { adminApi, type AssignableRole, type MemberListItem } from '@/lib/adminApi';
import { ApiError } from '@/lib/api';
import { useMe } from '@/components/rbac/MeProvider';
import { roleOptionsFor } from '@/lib/staff/staffRules';
import { Modal, ModalError } from '../Modal';
import { ConfirmDialog } from './ConfirmDialog';

export function ChangeRoleModal({
  open,
  member,
  onClose,
  onChanged,
}: {
  open: boolean;
  member: MemberListItem;
  onClose: () => void;
  onChanged: (updated: MemberListItem) => void;
}) {
  // Staff & Access: only the roles the role hierarchy lets THIS caller give —
  // the same `@got/shared` rule the server enforces. An ADMIN is never
  // offered Admin; the Super Admin is, and nobody is offered Super Admin.
  const { me } = useMe();
  const ROLES = roleOptionsFor(me?.role);

  const [role, setRole] = useState<AssignableRole>(
    member.role === 'DEV' ? 'ADMIN' : member.role,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const close = (): void => {
    if (busy) return;
    setError(null);
    setConfirming(false);
    onClose();
  };

  const fullName = `${member.firstName} ${member.lastName}`;
  const fromLabel = roleLabel(member.role);
  const toLabel = roleLabel(role);
  const offered = ROLES.some((option) => option.value === role);

  /**
   * `role.change` is marked dangerous in the permission catalogue, so the
   * confirmation carries a reason and the audit entry records it beside the
   * before/after pair.
   */
  const submit = async (reason: string | undefined): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const updated = await adminApi.changeMemberRole(member.userId, role, reason);
      onChanged(updated);
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
        title="Change role"
        subtitle={`${member.firstName} ${member.lastName} — currently ${fromLabel}.`}
        footer={
          <>
            <button type="button" className="p-btn p-btn-ghost" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="p-btn p-btn-gold"
              onClick={() => setConfirming(true)}
              disabled={busy || role === member.role || !offered}
            >
              Change role
            </button>
          </>
        }
      >
        <div className="a-field">
          <span className="a-field-label">New role</span>
          <div className="a-seg" role="radiogroup" aria-label="New role">
            {ROLES.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={role === option.value}
                className="a-seg-btn"
                data-on={role === option.value || undefined}
                onClick={() => setRole(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <ModalError message={error} />
      </Modal>

      <ConfirmDialog
        open={open && confirming}
        title={`Change ${fullName} to ${toLabel}?`}
        consequence={`${fullName} will have a ${toLabel}'s access instead of a ${fromLabel}'s — every screen and action that role allows, and nothing it does not.`}
        confirmLabel="Change role"
        cancelLabel={`Keep as ${fromLabel}`}
        tone="danger"
        reason={{
          required: true,
          label: 'Reason',
          maxLength: 200,
          placeholder: 'Why is this role changing? Recorded in the audit log.',
        }}
        busy={busy}
        error={error}
        onConfirm={(reason) => void submit(reason)}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
      />
    </>
  );
}
