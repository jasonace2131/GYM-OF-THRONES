'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Card, CardHead } from './ui';
import { ApiError } from '@/lib/api';
import { gcashApi, MAX_PROOF_BYTES, type MyGcashSubmission } from '@/lib/gcashApi';
import { formatGymTime } from '@/lib/gymTime';

/**
 * "I have sent the money" — the member's half of a GCash payment.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS DOES NOT PAY FOR ANYTHING, AND THE COPY NEVER PRETENDS IT DOES.
 *
 * The button says "Send for checking", the result says "waiting for the desk",
 * and nothing on the card claims the membership is renewed. That is not
 * timidity: a screen that says "Paid" the instant a member uploads a picture
 * is a screen that will one day let somebody into a gym they have not paid
 * for, and worse, will tell somebody who mistyped a reference that they are
 * fine until the day they are turned away at the door.
 *
 * What it replaces is a trip to the counter. Before this the page said "send
 * the amount, then show the reference number at the desk" — so a member who
 * paid on Sunday night could do nothing until they physically arrived.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const TZ = 'Asia/Manila';

const STATUS: Record<
  MyGcashSubmission['status'],
  { tone: 'warn' | 'ok' | 'danger'; label: string }
> = {
  PENDING: { tone: 'warn', label: 'Waiting for the desk' },
  APPROVED: { tone: 'ok', label: 'Confirmed' },
  REJECTED: { tone: 'danger', label: 'Not found' },
};

function peso(centavos: number): string {
  return `₱${(centavos / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
}

function when(iso: string): string {
  return formatGymTime(iso, TZ, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function GcashClaimCard({
  plans,
  onSubmitted,
}: {
  plans: { code: string; name: string; priceCentavos: number }[];
  onSubmitted?: () => void;
}) {
  const [mine, setMine] = useState<MyGcashSubmission[] | null>(null);
  const [open, setOpen] = useState(false);

  const [planCode, setPlanCode] = useState('');
  const [reference, setReference] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'uploading' | 'submitting'>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    setMine(await gcashApi.mine());
  }, []);

  useEffect(() => {
    void reload().catch(() => setMine([]));
  }, [reload]);

  // Revoke the object URL when it changes or the card unmounts. Without this a
  // member who picks three screenshots leaks three blobs for the session.
  useEffect(() => {
    if (file === null) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const chosen = plans.find((plan) => plan.code === planCode) ?? null;
  const ready = chosen !== null && reference.trim().length >= 6 && file !== null;

  const submit = async (): Promise<void> => {
    if (!ready || chosen === null || file === null) return;
    setError(null);

    try {
      // Upload FIRST. A claim with no image is not reviewable, so a failed
      // upload must stop before a row exists rather than leave staff a
      // submission they cannot judge.
      setBusy('uploading');
      const proofPath = await gcashApi.uploadProof(file);

      setBusy('submitting');
      await gcashApi.submit({
        planCode: chosen.code,
        amountCentavos: chosen.priceCentavos,
        reference: reference.trim(),
        proofPath,
      });

      setOpen(false);
      setReference('');
      setFile(null);
      if (fileRef.current !== null) fileRef.current.value = '';
      await reload();
      onSubmitted?.();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : 'Something went wrong. Try again.',
      );
    } finally {
      setBusy(null);
    }
  };

  const pending = (mine ?? []).filter((row) => row.status === 'PENDING');

  return (
    <Card>
      <CardHead
        title="Already sent it?"
        action={
          pending.length > 0 ? (
            <Badge tone="warn">{pending.length} waiting</Badge>
          ) : (
            <button
              type="button"
              className={`p-btn p-btn-sm ${open ? 'p-btn-ghost' : 'p-btn-gold'}`}
              onClick={() => setOpen(!open)}
            >
              {open ? 'Cancel' : 'Send your receipt'}
            </button>
          )
        }
      />

      <p style={{ margin: '2px 0 0', fontSize: 13.5, lineHeight: 1.6, color: 'var(--p-ink2)' }}>
        Send us the reference number and a screenshot of your GCash receipt, and the front desk will
        confirm it against the gym&rsquo;s own GCash account. You do not need to come in for this
        part.
      </p>

      {open ? (
        <form
          style={{ display: 'grid', gap: 12, marginTop: 16 }}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label style={{ display: 'grid', gap: 5 }}>
            <span className="p-muted" style={{ fontSize: 12, letterSpacing: '0.06em' }}>
              WHAT YOU PAID FOR
            </span>
            <select
              className="a-input"
              value={planCode}
              required
              onChange={(event) => setPlanCode(event.target.value)}
            >
              <option value="">Choose a plan…</option>
              {plans.map((plan) => (
                <option key={plan.code} value={plan.code}>
                  {plan.name} — {peso(plan.priceCentavos)}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'grid', gap: 5 }}>
            <span className="p-muted" style={{ fontSize: 12, letterSpacing: '0.06em' }}>
              REFERENCE NUMBER
            </span>
            <input
              className="a-input"
              value={reference}
              required
              inputMode="numeric"
              placeholder="e.g. 6041 342 312154"
              onChange={(event) => setReference(event.target.value)}
            />
            <span className="p-muted" style={{ fontSize: 12 }}>
              On your receipt next to <strong>Ref No.</strong>
            </span>
          </label>

          <label style={{ display: 'grid', gap: 5 }}>
            <span className="p-muted" style={{ fontSize: 12, letterSpacing: '0.06em' }}>
              SCREENSHOT OF THE RECEIPT
            </span>
            <input
              ref={fileRef}
              className="a-input"
              type="file"
              required
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <span className="p-muted" style={{ fontSize: 12 }}>
              JPEG, PNG or WebP, up to {Math.round(MAX_PROOF_BYTES / 1024 / 1024)}MB.
            </span>
          </label>

          {preview === null ? null : (
            <div
              style={{
                border: '1px solid var(--p-border)',
                borderRadius: 'var(--p-radius)',
                padding: 8,
                display: 'grid',
                justifyItems: 'center',
                background: 'var(--p-paper2)',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a blob:
                  URL from the file the member just picked; next/image cannot
                  optimise one and would only add a proxy hop. */}
              <img
                src={preview}
                alt="Your GCash receipt, as it will be sent"
                style={{ maxHeight: 260, maxWidth: '100%', borderRadius: 6, objectFit: 'contain' }}
              />
            </div>
          )}

          {error === null ? null : (
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--p-danger)', lineHeight: 1.5 }}>
              {error}
            </p>
          )}

          <button type="submit" className="p-btn p-btn-gold" disabled={busy !== null || !ready}>
            {busy === 'uploading'
              ? 'Uploading the image…'
              : busy === 'submitting'
                ? 'Sending…'
                : 'Send for checking'}
          </button>

          <p className="p-muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.55 }}>
            This does not renew your membership on its own. The desk confirms it against the
            gym&rsquo;s GCash account first, and you will see the result here.
          </p>
        </form>
      ) : null}

      {(mine ?? []).length === 0 ? null : (
        <div style={{ display: 'grid', gap: 10, marginTop: 16 }}>
          {(mine ?? []).map((row) => (
            <div
              key={row.id}
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
                flexWrap: 'wrap',
                paddingTop: 10,
                borderTop: '1px solid var(--p-border)',
              }}
            >
              <span style={{ flex: '1 1 180px', minWidth: 0 }}>
                <strong style={{ fontSize: 14 }}>{peso(row.amountCentavos)}</strong>
                <span className="p-muted" style={{ fontSize: 13 }}>
                  {' '}
                  · Ref {row.reference}
                </span>
                <div className="p-muted" style={{ fontSize: 12, marginTop: 2 }}>
                  Sent {when(row.submittedAt)}
                </div>
                {row.status === 'REJECTED' && row.rejectReason !== null ? (
                  <div
                    style={{
                      fontSize: 12.5,
                      marginTop: 4,
                      color: 'var(--p-danger)',
                      lineHeight: 1.5,
                    }}
                  >
                    {row.rejectReason}
                  </div>
                ) : null}
              </span>
              <Badge tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Badge>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
