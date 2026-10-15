'use client';

import { useState } from 'react';

/**
 * A delete that asks once, in place.
 *
 * Deleting a member's reading is irreversible and audited, so one stray tap
 * must not do it — but a modal for a one-line history row is heavier than the
 * decision. The button turns into "Delete? Yes / No" where it stood.
 */
export function ConfirmDelete({
  label,
  onConfirm,
  disabled = false,
}: {
  /** What is being deleted, for the screen reader: "the reading for 24 Sep 2026". */
  label: string;
  onConfirm: () => Promise<void>;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!asking) {
    return (
      <button
        type="button"
        className="p-btn p-btn-ghost p-btn-sm"
        disabled={disabled}
        aria-label={`Delete ${label}`}
        onClick={() => setAsking(true)}
      >
        Delete
      </button>
    );
  }

  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <span style={{ fontSize: 12.5, color: 'var(--p-danger)', fontWeight: 600 }}>Delete?</span>
      <button
        type="button"
        className="p-btn p-btn-dark p-btn-sm"
        disabled={busy}
        aria-label={`Yes, delete ${label}`}
        onClick={() => {
          setBusy(true);
          void onConfirm().finally(() => {
            setBusy(false);
            setAsking(false);
          });
        }}
      >
        {busy ? 'Deleting…' : 'Yes'}
      </button>
      <button
        type="button"
        className="p-btn p-btn-ghost p-btn-sm"
        disabled={busy}
        onClick={() => setAsking(false)}
      >
        No
      </button>
    </span>
  );
}
