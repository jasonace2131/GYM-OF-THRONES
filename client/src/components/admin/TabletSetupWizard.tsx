'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { adminApi, type AdminStation, type IssuedStationCredential } from '@/lib/adminApi';
import { ApiError } from '@/lib/api';
import { Card, CardHead } from '@/components/portal/ui';
import { ConfirmDialog } from './actions/ConfirmDialog';

/**
 * Setting up a check-in tablet, for somebody who has never done it before.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE OLD FLOW ASSUMED YOU ALREADY KNEW THE MODEL.
 *
 * It offered "Provision a tablet" and "New key version" — two pieces of
 * vocabulary a new front-desk hire has no way to decode — collected the label
 * through `window.prompt`, showed a key once, and then stopped. Nothing said
 * what to do with the key, and nothing ever confirmed it had worked. The
 * person was left holding a secret and a question.
 *
 * This asks one thing per screen, in the order the physical job happens, and
 * ENDS BY WATCHING THE TABLET CONNECT. That last part is the whole design: the
 * step that used to require faith now resolves by itself, so nobody has to
 * know what "working" looks like in order to recognise it.
 * ═══════════════════════════════════════════════════════════════════════════
 */

type Step = 'NAME' | 'CONNECT' | 'DONE';

const POLL_MS = 3000;

export function TabletSetupWizard({
  station,
  onFinished,
  onCancel,
}: {
  station: AdminStation;
  onFinished: () => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<Step>('NAME');
  const [label, setLabel] = useState('Front desk tablet');
  const [issued, setIssued] = useState<IssuedStationCredential | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState(false);
  // Issuing the key is the one write in this wizard, so it is confirmed.
  const [confirming, setConfirming] = useState(false);

  // Built from the browser's own origin, so it is right in development, on a
  // preview deploy and in production without anybody configuring a URL.
  const deskUrl = useMemo(
    () => (typeof window === 'undefined' ? '/desk/station' : `${window.location.origin}/desk/station`),
    [],
  );

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setIssued(await adminApi.issueStationCredential(station.id, label.trim()));
      setConfirming(false);
      setStep('CONNECT');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not set up the tablet.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Watches for the tablet's first token request.
   *
   * `lastUsedAt` turning non-null is the only honest proof the key reached the
   * tablet and the tablet reached the API. Anything else — a spinner, a
   * "probably fine" — asks the person to guess.
   */
  useEffect(() => {
    if (step !== 'CONNECT' || issued === null) return;

    let cancelled = false;
    const id = issued.credential.id;

    const poll = async (): Promise<void> => {
      try {
        const stations = await adminApi.stations();
        const mine = stations
          .find((s) => s.id === station.id)
          ?.credentials.find((c) => c.id === id);

        if (!cancelled && mine?.lastUsedAt != null) {
          setConnected(true);
          setStep('DONE');
          return;
        }
      } catch {
        // A blip while polling is not worth showing. The screen already tells
        // the person what to do, and the next tick retries.
      }
      if (!cancelled) timer.current = setTimeout(() => void poll(), POLL_MS);
    };

    const timer: { current: ReturnType<typeof setTimeout> | null } = { current: null };
    void poll();

    return () => {
      cancelled = true;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [step, issued, station.id]);

  return (
    <Card style={{ borderColor: 'var(--gold)' }}>
      <CardHead
        title={
          step === 'NAME'
            ? 'Set up a tablet — step 1 of 3'
            : step === 'CONNECT'
              ? 'Set up a tablet — step 2 of 3'
              : 'All done'
        }
        action={
          step === 'DONE' ? null : (
            <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={onCancel}>
              Cancel
            </button>
          )
        }
      />

      {step === 'NAME' ? (
        <form
          className="a-sheet"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            setConfirming(true);
          }}
        >
          <p style={{ margin: 0, fontSize: 14.5, color: 'var(--p-ink2)', lineHeight: 1.6 }}>
            Give the tablet a name so you can tell it apart later. Where it sits is usually the
            most useful name.
          </p>

          <label>
            <span className="a-person-sub">TABLET NAME</span>
            <input
              className="a-input"
              value={label}
              required
              minLength={2}
              maxLength={60}
              autoFocus
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>

          {error === null ? null : (
            <p style={{ color: 'var(--p-danger)', fontSize: 14, margin: 0 }}>{error}</p>
          )}

          <button
            type="submit"
            className="p-btn p-btn-gold"
            disabled={busy || label.trim().length < 2}
          >
            {busy ? 'Setting up…' : 'Next'}
          </button>

          <ConfirmDialog
            open={confirming}
            title={`Create a key for “${label.trim()}”?`}
            consequence={`A new tablet key for ${station.name} is created and shown once. It works until you disconnect it on this page.`}
            confirmLabel="Create key"
            cancelLabel="Back"
            busy={busy}
            error={error}
            onConfirm={() => void create()}
            onClose={() => {
              if (!busy) setConfirming(false);
            }}
          />
        </form>
      ) : null}

      {step === 'CONNECT' && issued !== null ? (
        <div style={{ display: 'grid', gap: 16 }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
              <strong>On the tablet</strong>, open this page:
            </p>
            <div className="a-secret" style={{ fontSize: 15 }}>
              {deskUrl}
            </div>
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--p-ink3)' }}>
              Or point the tablet&rsquo;s camera at this square to open it:
            </p>
            <UrlQr url={deskUrl} />
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
              <strong>Then paste this key</strong> when the tablet asks for it:
            </p>
            <div className="a-secret">{issued.secret}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="p-btn p-btn-gold p-btn-sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(issued.secret).then(() => setCopied(true));
                }}
              >
                {copied ? 'Copied' : 'Copy key'}
              </button>
              <button
                type="button"
                className="p-btn p-btn-ghost p-btn-sm"
                onClick={() => window.print()}
              >
                Print this page
              </button>
            </div>
            {/* Stated plainly, because the consequence is real and the recovery
                is cheap. Vague warnings make people hoard secrets in notes
                apps; a named recovery makes them relax. */}
            <p style={{ margin: 0, fontSize: 13, color: 'var(--p-ink3)', lineHeight: 1.55 }}>
              This key is only shown once. If you lose it, come back here and set the tablet up
              again — it takes a minute and nothing breaks.
            </p>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 14px',
              borderRadius: 10,
              background: 'var(--p-surface2)',
              border: '1px solid var(--p-border)',
            }}
          >
            <Pulse />
            <span style={{ fontSize: 14, color: 'var(--p-ink2)' }}>
              Waiting for the tablet to connect… you can leave this open.
            </span>
          </div>
        </div>
      ) : null}

      {step === 'DONE' ? (
        <div style={{ display: 'grid', gap: 14, justifyItems: 'start' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: 17,
              fontWeight: 600,
              color: 'var(--p-ok, #2f7d4f)',
            }}
          >
            <span aria-hidden style={{ fontSize: 22 }}>
              ✓
            </span>
            The tablet is connected.
          </div>

          <p style={{ margin: 0, fontSize: 14.5, color: 'var(--p-ink2)', lineHeight: 1.6 }}>
            {connected ? `“${label.trim()}” ` : 'It '}
            is showing the check-in code now. Members can scan it with their phones. You do not
            need to do anything else.
          </p>

          <button type="button" className="p-btn p-btn-gold" onClick={onFinished}>
            Done
          </button>
        </div>
      ) : null}
    </Card>
  );
}

/** A quiet breathing dot, so "waiting" reads as working rather than stuck. */
function Pulse() {
  return (
    <>
      <span
        aria-hidden
        style={{
          width: 9,
          height: 9,
          borderRadius: '50%',
          background: 'var(--gold)',
          flexShrink: 0,
          animation: 'gotPulse 1.4s ease-in-out infinite',
        }}
      />
      <style>{`
        @keyframes gotPulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }
        @media (prefers-reduced-motion: reduce) {
          @keyframes gotPulse { 0%,100% { opacity: .7 } 50% { opacity: .7 } }
        }
      `}</style>
    </>
  );
}

/**
 * A QR of the SETUP URL — not a check-in token.
 *
 * Typing a URL on a tablet keyboard is the single most error-prone step of
 * this job, so the tablet's own camera does it instead. Uses the `qrcode`
 * library rather than our hand-written encoder because that one is fixed at
 * version 2 for the 38-character token and a URL is longer than it can hold.
 */
function UrlQr({ url }: { url: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    void QRCode.toCanvas(canvas, url, {
      width: 168,
      margin: 2,
      color: { dark: '#000000', light: '#FFFFFF' },
    });
  }, [url]);

  return (
    <canvas
      ref={canvasRef}
      width={168}
      height={168}
      style={{ background: '#FFFFFF', borderRadius: 8, alignSelf: 'start' }}
      aria-label="QR code that opens the check-in screen"
    />
  );
}
