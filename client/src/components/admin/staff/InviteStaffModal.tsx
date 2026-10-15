'use client';

import { useState } from 'react';
import {
  invitableRoles,
  roleLabel,
  type InvitableRole,
  type IssuedStaffInvitation,
} from '@got/shared';
import { staffApi } from '@/lib/staffApi';
import { confirmErrorMessage } from '@/lib/confirm';
import { toRoleName } from '@/lib/staff/staffRules';
import { useMe } from '@/components/rbac/MeProvider';
import { Modal, ModalError } from '../Modal';
import { ConfirmDialog } from '../actions/ConfirmDialog';

/** What each role is for, in one line — shown under the picker. */
const ROLE_HINT: Record<InvitableRole, string> = {
  FRONT_DESK: 'Check-ins, walk-ins, selling memberships and taking payments at the counter.',
  COACH: 'Their own clients, classes and registers — from the coach dashboard.',
  ADMIN: 'The whole console, including staff, money corrections and settings.',
};

/**
 * Invite somebody to join as staff: an address and a role.
 *
 * The roles offered come from `invitableRoles(me.role)` — the same
 * `@got/shared` rule the server enforces — so an ADMIN is offered front desk
 * and coach, and only the Super Admin sees Admin. Confirmed like every other
 * console write, then the link comes back ONCE for the caller to copy.
 */
export function InviteStaffModal({
  open,
  onClose,
  onIssued,
}: {
  open: boolean;
  onClose: () => void;
  onIssued: (issued: IssuedStaffInvitation) => void;
}) {
  const { me } = useMe();
  const actorRole = toRoleName(me?.role);
  const roles = actorRole === null ? [] : invitableRoles(actorRole);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InvitableRole | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const chosen = role ?? roles[0] ?? null;
  const address = email.trim();
  // The server's own `@IsEmail` is the real check; this only stops the
  // obvious slip before a confirmation dialog is shown for it.
  const plausible = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);

  const reset = (): void => {
    setEmail('');
    setRole(null);
    setError(null);
    setConfirming(false);
  };

  const close = (): void => {
    if (busy) return;
    reset();
    onClose();
  };

  const submit = async (): Promise<void> => {
    if (chosen === null || !plausible) return;
    setBusy(true);
    setError(null);
    try {
      const issued = await staffApi.invite({ email: address, role: chosen });
      setBusy(false);
      reset();
      onIssued(issued);
    } catch (caught) {
      setError(confirmErrorMessage(caught));
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open={open && !confirming}
        onClose={close}
        busy={busy}
        title="Invite staff"
        subtitle="They get an email with a link that works for 7 days. You also get the link, to send yourself."
        footer={
          <>
            <button type="button" className="p-btn p-btn-ghost" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="p-btn p-btn-gold"
              onClick={() => {
                setError(null);
                setConfirming(true);
              }}
              disabled={busy || chosen === null || !plausible}
            >
              Send invitation
            </button>
          </>
        }
      >
        <div className="a-field">
          <label className="a-field-label" htmlFor="invite-staff-email">
            Email
          </label>
          <input
            id="invite-staff-email"
            className="a-input"
            type="email"
            value={email}
            autoComplete="off"
            autoFocus
            placeholder="name@example.com"
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        <div className="a-field">
          <span className="a-field-label">Role</span>
          {roles.length === 0 ? (
            <p className="a-field-hint">Your account cannot invite staff.</p>
          ) : (
            <>
              <div className="a-seg" role="radiogroup" aria-label="Role">
                {roles.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={chosen === option}
                    className="a-seg-btn"
                    data-on={chosen === option || undefined}
                    onClick={() => setRole(option)}
                  >
                    {roleLabel(option)}
                  </button>
                ))}
              </div>
              {chosen === null ? null : <p className="a-field-hint">{ROLE_HINT[chosen]}</p>}
              {actorRole === 'ADMIN' ? (
                <p className="a-field-hint">Only the Super Admin can invite another admin.</p>
              ) : null}
            </>
          )}
        </div>

        <ModalError message={error} />
      </Modal>

      <ConfirmDialog
        open={open && confirming}
        title={`Invite ${address} as ${chosen === null ? '' : roleLabel(chosen)}?`}
        consequence={`When they accept, ${address} gets ${chosen === null ? '' : roleLabel(chosen)} access. If they already have a member account, it is promoted.`}
        confirmLabel="Send invitation"
        cancelLabel="Back"
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
