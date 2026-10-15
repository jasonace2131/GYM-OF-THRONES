'use client';

import { useState } from 'react';

/**
 * The GCash half of every sale form, extracted from six hand-rolled copies.
 *
 * Renders nothing unless the method is GCASH. What it fixes along the way:
 * RecordPaymentModal used to label the reference "optional" while the server
 * 422s on blank — a live UI/server disagreement in exactly this field. It is
 * `required` here, once, for everyone.
 *
 * The 13-digit hint NEVER blocks: older references are alphanumeric and a
 * bank-funded arrival carries a 14-digit InstaPay reference, so a strict rule
 * refuses real money at the counter. The hint is a prompt to glance at the
 * screen, nothing more.
 */

const normalize = (raw: string): string => raw.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function GcashFields({
  method,
  reference,
  onReference,
  verified,
  onVerified,
}: {
  method: string;
  reference: string;
  onReference: (value: string) => void;
  verified: boolean;
  onVerified: (value: boolean) => void;
}) {
  const [touched, setTouched] = useState(false);
  if (method !== 'GCASH') return null;

  const normalized = normalize(reference);
  const looksUsual = /^\d{13}$/.test(normalized);
  const tail = normalized.length >= 4 ? normalized.slice(-4) : null;

  return (
    <>
      <label>
        <span className="a-person-sub">GCASH REFERENCE</span>
        <input
          className="a-input"
          value={reference}
          required
          placeholder="from the member’s screen"
          onChange={(event) => {
            setTouched(true);
            onReference(event.target.value);
          }}
        />
        {touched && normalized.length > 0 ? (
          <span style={{ display: 'block', fontSize: 12, marginTop: 4, color: 'var(--p-ink3)' }}>
            {normalized.length} characters{tail === null ? '' : ` · read back “…${tail}”`}
            {looksUsual ? '' : ' — not the usual 13-digit shape, check the screen'}
          </span>
        ) : null}
      </label>

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={verified}
          onChange={(event) => onVerified(event.target.checked)}
          style={{ marginTop: 2, width: 15, height: 15, accentColor: 'var(--gold)', flex: 'none' }}
        />
        <span style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--p-ink2)' }}>
          Seen in our GCash Transactions tab.
          <span style={{ display: 'block', fontSize: 12, color: 'var(--p-ink3)' }}>
            GCash’s own advice: a reference that isn’t in your app isn’t a payment.
          </span>
        </span>
      </label>
    </>
  );
}
