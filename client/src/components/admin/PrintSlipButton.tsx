'use client';

import { useState } from 'react';
import { adminApi } from '@/lib/adminApi';
import { ApiError } from '@/lib/api';
import { printReceipt } from '@/lib/receipt/printReceipt';

/**
 * Fetch the slip's data, render it into a hidden iframe, open the print
 * dialog. Callers gate on `held.has('payment.read')` — printing is reading.
 *
 * `copy` is NOT a trusted flag; it is derived from WHERE the button sits. A
 * print from a list or a drawer is by definition a reissue, so it bands
 * REPRINT; only the just-sold strip passes copy:false. That cannot be wrong
 * in the direction that matters and needs no schema. (A server-side
 * printCount + an audit row per print is v2 — and needs the AuditLog table
 * that does not exist.)
 */
export function PrintSlipButton({
  paymentId,
  copy,
  label = 'Slip',
}: {
  paymentId: string;
  copy: boolean;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const print = async (): Promise<void> => {
    setBusy(true);
    setError(false);
    try {
      const doc = await adminApi.paymentReceipt(paymentId);
      printReceipt(doc, { copy });
    } catch (caught) {
      void (caught instanceof ApiError);
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className="p-btn p-btn-ghost p-btn-sm"
      disabled={busy}
      title={error ? 'Could not load the slip — try again' : undefined}
      onClick={() => void print()}
    >
      {busy ? 'Loading…' : error ? 'Retry slip' : label}
    </button>
  );
}
