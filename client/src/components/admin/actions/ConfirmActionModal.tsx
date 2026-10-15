'use client';

import type { ReactNode } from 'react';
import { ConfirmDialog, useConfirmAction, type ConfirmReasonSpec } from './ConfirmDialog';

/**
 * `ConfirmDialog` with its busy and error state held for you — for the
 * actions that are nothing BUT a confirmation: Reactivate, Resend invite,
 * Delete, Archive, and (through `ReasonActionModal`) the reasoned ones.
 *
 * It used to be its own modal with its own look. It is now a thin owner of
 * state around the one dialog, so every confirmation in the console reads
 * the same way — see `ConfirmDialog`'s header for the rules.
 *
 * `onConfirm` does the actual `adminApi` call; this component owns only busy
 * state, the error strip, and closing on success. Every caller still supplies
 * its own `onDone` so the drawer can reload BOTH `useAdminQuery` reload() and
 * its own local snapshot from the response — this component never assumes
 * what "done" means for the caller.
 */
export function ConfirmActionModal({
  open,
  title,
  subtitle,
  confirmLabel,
  cancelLabel,
  danger = false,
  reason,
  onConfirm,
  describeError,
  onClose,
  onDone,
  children,
}: {
  open: boolean;
  /** Names the item and the action. */
  title: string;
  /** The consequence, in one sentence. */
  subtitle: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  reason?: ConfirmReasonSpec;
  onConfirm: (reason?: string) => Promise<void>;
  /**
   * The sentence for a failure. Defaults to the API's own message (anything
   * else reads "Something went wrong."); a caller that throws its own `Error`
   * to report a 200 that did not do the job maps it here.
   */
  describeError?: (caught: unknown) => string;
  onClose: () => void;
  onDone: () => void;
  children?: ReactNode;
}) {
  const { busy, error, run, reset } = useConfirmAction();

  const close = (): void => {
    if (busy) return;
    reset();
    onClose();
  };

  const submit = async (typed?: string): Promise<void> => {
    const ok = await run(() => onConfirm(typed), describeError);
    if (!ok) return;
    onDone();
    reset();
    onClose();
  };

  return (
    <ConfirmDialog
      open={open}
      title={title}
      consequence={subtitle}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      tone={danger ? 'danger' : 'default'}
      reason={reason}
      busy={busy}
      error={error}
      onConfirm={(typed) => void submit(typed)}
      onClose={close}
    >
      {children}
    </ConfirmDialog>
  );
}
