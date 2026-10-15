'use client';

import { useState } from 'react';
import { confirmErrorMessage } from '@/lib/confirm';
import { Modal } from '../Modal';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * "Are you sure, and why?" — for N members at once, C6.
 *
 * There is no bulk endpoint (verified — `suspendMember`/`reactivateMember`
 * are per-row, same as every other member write). So this loops the given
 * `run` over `targets` SEQUENTIALLY (a busy counter's connection is one
 * request at a time anyway, and sequential keeps "row 7 of 40 failed" legible
 * rather than a pile of interleaved rejections) and reports which rows
 * failed rather than claiming the whole batch succeeded — the same honesty
 * rule `ReasonActionModal` follows for a single row, just counted.
 *
 * `onDone` fires once, after every row has settled — the caller reloads the
 * list and clears the selection there, exactly once, whether the batch was a
 * clean sweep or partial.
 *
 * The question itself is the shared `ConfirmDialog` — the same look, focus
 * rule and reason field as every single-row confirmation. Only the summary
 * that follows ("38 of 40 succeeded") is this component's own.
 */

/** Mirrors `BULK_CAP` in `admin/members/page.tsx`. That copy disables the
 *  trigger buttons past 50; this one is defense-in-depth so `submit()` itself
 *  refuses an oversized batch even if some future caller forgets to disable
 *  its own button. */
const BULK_CAP = 50;

export interface BulkTarget {
  id: string;
  label: string;
}

interface BulkFailure {
  label: string;
  message: string;
}

export function BulkActionModal({
  open,
  title,
  subtitle,
  confirmLabel,
  cancelLabel = 'Leave them as they are',
  danger = false,
  needsReason = false,
  reasonPlaceholder = 'Why?',
  targets,
  run,
  onClose,
  onDone,
}: {
  open: boolean;
  title: string;
  subtitle: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Suspend needs one reason applied to every row; Reactivate needs none. */
  needsReason?: boolean;
  reasonPlaceholder?: string;
  targets: BulkTarget[];
  run: (id: string, reason: string | undefined) => Promise<void>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // `total` is captured HERE rather than read back off `targets.length` at
  // render time: `onDone` (below) has the caller clear its selection, which
  // shrinks the `targets` prop to `[]` on the next render — reading the prop
  // after that would print "N of 0 succeeded" instead of the real total.
  const [results, setResults] = useState<{
    total: number;
    successCount: number;
    failures: BulkFailure[];
  } | null>(null);

  const oversized = targets.length > BULK_CAP;

  const reset = (): void => {
    setResults(null);
    setBusy(false);
  };

  const close = (): void => {
    if (busy) return;
    reset();
    onClose();
  };

  const submit = async (reason: string | undefined): Promise<void> => {
    if (targets.length === 0 || oversized) return;
    if (needsReason && reason === undefined) return;
    setBusy(true);

    const failures: BulkFailure[] = [];
    let successCount = 0;
    const total = targets.length;

    // One at a time, not `Promise.allSettled` — a busy counter is already
    // waiting on ONE outcome at a time, and a sequential loop keeps the
    // eventual failure list in the same order the rows were selected.
    for (const target of targets) {
      try {
        await run(target.id, needsReason ? reason : undefined);
        successCount += 1;
      } catch (caught) {
        failures.push({ label: target.label, message: confirmErrorMessage(caught) });
      }
    }

    setResults({ total, successCount, failures });
    setBusy(false);
    onDone();
  };

  return (
    <>
      <ConfirmDialog
        open={open && results === null}
        title={title}
        consequence={subtitle}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        tone={danger ? 'danger' : 'default'}
        reason={
          needsReason
            ? { required: true, label: 'Reason', maxLength: 200, placeholder: reasonPlaceholder }
            : undefined
        }
        busy={busy}
        error={
          oversized
            ? `At most ${BULK_CAP} members at once — narrow the selection.`
            : targets.length === 0
              ? 'Nobody is selected.'
              : null
        }
        onConfirm={(reason) => void submit(reason)}
        onClose={close}
      />

      <Modal
        open={open && results !== null}
        onClose={close}
        title={title}
        footer={
          <button type="button" className="p-btn p-btn-gold" onClick={close}>
            Close
          </button>
        }
      >
        {results === null ? null : (
          <div style={{ display: 'grid', gap: 10 }}>
            <p style={{ margin: 0 }}>
              {results.successCount} of {results.total} succeeded.
            </p>
            {results.failures.length > 0 && (
              <div style={{ display: 'grid', gap: 6 }}>
                <strong style={{ fontSize: 12 }}>Failed:</strong>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
                  {results.failures.map((failure, index) => (
                    <li key={`${failure.label}-${index}`} style={{ fontSize: 12.5 }}>
                      {failure.label} — {failure.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
