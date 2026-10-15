'use client';

import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import {
  canSubmit,
  confirmErrorMessage,
  reasonHint,
  reasonToSend,
  runConfirmed,
  type ConfirmReasonSpec,
} from '@/lib/confirm';
import { Modal, ModalError } from '../Modal';

export type { ConfirmReasonSpec } from '@/lib/confirm';

/**
 * The one confirmation every admin edit goes through.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE MODAL, NO TIERS (owner decision, 2026-09-25).
 *
 * Every write in the console asks here first, and they all look the same:
 *
 *   - the TITLE names the item and the action — "Check out Maria Santos?",
 *     never "Are you sure?";
 *   - the CONSEQUENCE is one sentence saying what happens, in the words of
 *     somebody standing at the counter;
 *   - the confirm button carries the VERB ("Change role"), never "Yes" or
 *     "OK", so the second click means something;
 *   - the cancel button names what staying put means ("Keep as Coach");
 *   - focus starts on CANCEL, so an Enter hit by accident does nothing.
 *
 * Where the server already demands a reason the same dialog carries the
 * field, and the confirm button waits for it (`canSubmit` in lib/confirm).
 *
 * Controlled on purpose: `busy` and `error` belong to the caller, because the
 * caller owns the write. `useConfirmAction()` below is the usual way to hold
 * them, and `ConfirmActionModal` wraps both for callers with nothing else to
 * track.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export interface ConfirmDialogProps {
  open: boolean;
  /** Names the item and the action: "Delete “Holiday hours”?" */
  title: string;
  /** One sentence on what happens. */
  consequence: string;
  /** The verb — "Change role", "Check out". Never "Yes". */
  confirmLabel: string;
  /** What not confirming means — "Keep as Coach", "Keep editing". */
  cancelLabel: string;
  tone?: 'default' | 'danger';
  reason?: ConfirmReasonSpec;
  busy: boolean;
  error: string | null;
  onConfirm: (reason?: string) => void;
  onClose: () => void;
  /** Facts that support the consequence — an amount, a list of changed days. Never a form. */
  children?: ReactNode;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  // Unmounted while closed, so a reason typed into a dialog that was then
  // cancelled never leaks into the next one.
  if (!props.open) return null;
  return <ConfirmDialogBody {...props} />;
}

function ConfirmDialogBody({
  title,
  consequence,
  confirmLabel,
  cancelLabel,
  tone = 'default',
  reason: spec,
  busy,
  error,
  onConfirm,
  onClose,
  children,
}: ConfirmDialogProps) {
  const [reason, setReason] = useState('');
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const consequenceId = useId();
  const fieldId = useId();

  const ready = canSubmit(reason, spec, busy);

  const confirm = (): void => {
    if (!ready) return;
    onConfirm(reasonToSend(reason, spec));
  };

  return (
    <Modal
      open
      title={title}
      onClose={onClose}
      busy={busy}
      initialFocus={cancelRef}
      describedBy={consequenceId}
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            className="p-btn p-btn-ghost"
            onClick={onClose}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={tone === 'danger' ? 'p-btn p-btn-danger' : 'p-btn p-btn-gold'}
            onClick={confirm}
            disabled={!ready}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <p className="a-confirm-text" id={consequenceId}>
        {consequence}
      </p>

      {children}

      {spec === undefined ? null : (
        <div className="a-field">
          <label className="a-field-label" htmlFor={fieldId}>
            {spec.label}
            {spec.required ? null : <span className="a-field-opt"> optional</span>}
          </label>
          <textarea
            id={fieldId}
            className="a-textarea"
            rows={3}
            value={reason}
            maxLength={spec.maxLength}
            placeholder={spec.placeholder}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
          />
          <p className="a-field-hint">{reasonHint(reason, spec)}</p>
        </div>
      )}

      <ModalError message={error} />
    </Modal>
  );
}

/**
 * The busy/error pair a `ConfirmDialog` needs, and the one way to run the
 * write behind it. `run` resolves `true` on success and never rejects — see
 * `runConfirmed`. `describe` turns a failure into the sentence shown in the
 * dialog, for callers that map an error code to desk wording.
 */
export function useConfirmAction(): {
  busy: boolean;
  error: string | null;
  run: (
    action: () => Promise<unknown>,
    describe?: (caught: unknown) => string,
  ) => Promise<boolean>;
  reset: () => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    (action: () => Promise<unknown>, describe: (caught: unknown) => string = confirmErrorMessage) =>
      runConfirmed(action, { setBusy, setError }, describe),
    [],
  );
  const reset = useCallback(() => {
    setBusy(false);
    setError(null);
  }, []);

  return { busy, error, run, reset };
}
