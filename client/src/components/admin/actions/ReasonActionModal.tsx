'use client';

import { ConfirmActionModal } from './ConfirmActionModal';

/**
 * "Are you sure, and why?" — the shape shared by Suspend, Cancel, Void and
 * Refund. All four routes take the exact same DTO shape server-side
 * (`@IsString() @Length(3, 200) reason!: string`, matching
 * `MembershipEvent_reason_required`'s own CHECK), so one bound covers all
 * four rather than four copies that could drift out of sync.
 *
 * Now the same `ConfirmDialog` as every other confirmation, with its reason
 * field switched on — one look everywhere, and the confirm button waits for
 * a reason the server will accept.
 */
export function ReasonActionModal({
  open,
  title,
  subtitle,
  confirmLabel,
  cancelLabel,
  danger = false,
  placeholder = 'Why?',
  onConfirm,
  onClose,
  onDone,
}: {
  open: boolean;
  title: string;
  subtitle: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  placeholder?: string;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <ConfirmActionModal
      open={open}
      title={title}
      subtitle={subtitle}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      danger={danger}
      reason={{ required: true, label: 'Reason', maxLength: 200, placeholder }}
      // `canSubmit` keeps the button disabled until a 3–200 character reason
      // exists, so `reason` is always defined by the time this runs.
      onConfirm={(reason) => onConfirm(reason ?? '')}
      onClose={onClose}
      onDone={onDone}
    />
  );
}
