'use client';

import { useState } from 'react';

/**
 * The "BIR invoice no." input — the number staff wrote in the registered
 * booklet, tied here to the system row so the reconciliation the schema
 * comments call the real problem is a lookup, not a shoebox.
 *
 * `collapsible` hides it behind a toggle on the walk-in forms: a ₱90 sale is
 * below the ₱500 issuance threshold and usually gets no booklet invoice.
 * `highlight` (statutory discount) force-expands it with the amber line —
 * RR 7-2010 / RR 5-2017 require a per-transaction document and a logbook row
 * for every SC/PWD sale, regardless of the ₱500 rule.
 */
export function ReceiptNoField({
  value,
  onChange,
  collapsible = false,
  highlight = false,
}: {
  value: string;
  onChange: (value: string) => void;
  collapsible?: boolean;
  highlight?: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const open = !collapsible || opened || highlight || value !== '';

  if (!open) {
    return (
      <button
        type="button"
        className="p-btn p-btn-ghost p-btn-sm"
        style={{ justifySelf: 'start' }}
        onClick={() => setOpened(true)}
      >
        ＋ BIR invoice no.
      </button>
    );
  }

  return (
    <label>
      <span className="a-person-sub">BIR INVOICE NO. (FROM THE BOOKLET)</span>
      <input
        className="a-input"
        value={value}
        maxLength={32}
        placeholder="optional"
        onChange={(event) => onChange(event.target.value)}
      />
      {highlight ? (
        <span style={{ display: 'block', fontSize: 12, marginTop: 4, color: 'var(--p-warn, #b8860b)' }}>
          A discounted sale always needs its own BIR invoice.
        </span>
      ) : null}
    </label>
  );
}
