'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { CheckInResult, CheckInStatus, CheckInTone } from '@got/shared';
import { ApiError, apiFetch } from '@/lib/api';
import { SUBMIT_BACKOFF_MS } from '@/lib/scanner';
import { CheckInScanner } from '@/components/portal/CheckInScanner';

/**
 * `/portal/checkin` — the member scans the counter.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE VERDICT UI READS EXACTLY ONE FIELD: `display.tone`.
 *
 * Four values, mapped to colour + word + glyph + field geometry. NOTHING here
 * branches on `denial.reason` — a client that switched on it for colour would
 * render a blank card the first time the enum gained a value, in a member's
 * hand, at the counter. The server composes every string; this screen stays
 * dumb on purpose.
 *
 * `headline` may be rendered large. `detail` MAY NOT — that is a structural
 * guarantee about what the queue behind the member can read from a metre away,
 * not a copy note.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE PRE-FLIGHT LINE IS THE POINT OF THIS PAGE'S TOP HALF. "You're checked in
 * since 6:12 PM — scanning again checks you out" is the single thing that
 * prevents the most common accidental action in a second-scan design, and it
 * costs nothing on the critical path because it happens BEFORE the camera
 * arms rather than during the scan.
 */
export default function CheckInPage() {
  const [status, setStatus] = useState<CheckInStatus | null>(null);
  const [result, setResult] = useState<CheckInResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const busyRef = useRef(false);

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      setStatus(await apiFetch<CheckInStatus>('/me/check-in-status'));
    } catch {
      // A pre-flight that cannot load is not a reason to block the scan. The
      // member may still be able to check in; they simply do not get the
      // "scanning again checks you out" warning.
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void loadStatus(), 0);
    return () => window.clearTimeout(id);
  }, [loadStatus]);

  const submit = useCallback(
    async (stationToken: string): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setFailure(null);

      // Retry twice with backoff, INSIDE the token's own validity window.
      // This covers a flaky connection, which is the common case. It does not
      // pretend to cover an absent one, and it deliberately does not queue: a
      // queued station token has EXPIRED by the time it flushes, and honouring
      // a stale one would widen the relay window from a minute to the queue's
      // TTL — which is the one thing the token must never have.
      const attempts = [0, ...SUBMIT_BACKOFF_MS];

      for (let attempt = 0; attempt < attempts.length; attempt += 1) {
        if (attempts[attempt] > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, attempts[attempt]));
        }
        try {
          const outcome = await apiFetch<CheckInResult>('/checkin', {
            method: 'POST',
            body: JSON.stringify({ stationToken }),
          });
          setResult(outcome);
          setAnnouncement(outcome.display.headline);
          busyRef.current = false;
          setBusy(false);
          void loadStatus();
          return;
        } catch (error) {
          const last = attempt === attempts.length - 1;
          // A 4xx is a decision, not a blip — retrying a rejected token just
          // burns the member's rate limit and delays the card.
          const decided = error instanceof ApiError && error.status < 500;
          if (decided || last) {
            // ONE catch-all for every non-2xx. Five error screens for five
            // things that mean the same thing to a member standing at a
            // counter is five screens nobody reads.
            setFailure('Check-in is unavailable — please see the front desk.');
            setAnnouncement('Check-in is unavailable.');
            busyRef.current = false;
            setBusy(false);
            return;
          }
        }
      }
    },
    [loadStatus],
  );

  const scanAgain = useCallback(() => {
    setResult(null);
    setFailure(null);
    setAnnouncement('');
  }, []);

  // Centred in the page column: a 560px strip pinned to the sidebar edge left
  // the rest of a laptop screen empty (owner, 2026-10-15).
  return (
    <div style={{ display: 'grid', gap: 18, maxWidth: 560, marginInline: 'auto' }}>
      {/* Only the HEADLINE goes in the live region, and it is `polite`, never
          `assertive` — including for a denial. An assertive region on a screen
          reader in a public lobby reads the refusal aloud to the queue. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {result === null && failure === null ? (
        <>
          <PreFlight status={status} />
          <CheckInScanner
            paused={busy}
            onPayload={(payload) => void submit(payload)}
            // A low-vision member cannot frame a code from a preview they
            // cannot see, so this is the only feedback that reaches them.
            onDecodeAnnounce={() => setAnnouncement('Code found. Checking you in.')}
          />
          {busy ? (
            <p className="p-muted" style={{ margin: 0, textAlign: 'center' }}>
              Checking you in…
            </p>
          ) : null}
        </>
      ) : failure !== null ? (
        <FailureCard message={failure} onRetry={scanAgain} />
      ) : (
        <Verdict result={result!} onScanAgain={scanAgain} />
      )}
    </div>
  );
}

/**
 * The line that prevents the accidental check-out.
 *
 * Naming the exact clock time is the whole fix: "try again later" generates a
 * conversation at the desk every single time.
 */
function PreFlight({ status }: { status: CheckInStatus | null }) {
  if (status === null) return null;

  if (status.open !== null) {
    return (
      <div className="ci-preflight">
        <span aria-hidden>●</span>
        <span>
          You’re checked in since <strong>{clockTime(status.open.startedAt)}</strong> — scanning
          again checks you out.
        </span>
      </div>
    );
  }

  const plan = status.membership.planName;
  return (
    <div className="ci-preflight">
      <span aria-hidden>○</span>
      <span>
        {plan === null
          ? 'No plan on file — the desk can set you up.'
          : `${plan}${status.membership.daysRemaining === null ? '' : ` · ${status.membership.daysRemaining} days left`}`}
      </span>
    </div>
  );
}

const TONE_GLYPH: Record<CheckInTone, string> = {
  WELCOME: '✓',
  // THE SAME TICK as WELCOME. The door opened, and a different glyph would
  // say otherwise to someone who was just let in.
  GRACE: '✓',
  GOODBYE: '→',
  // Not a cross, not a warning triangle. A neutral dot: this is a card, not
  // an alarm.
  SEE_DESK: '·',
};

function Verdict({ result, onScanAgain }: { result: CheckInResult; onScanAgain: () => void }) {
  const { display, session, nextStep, denial } = result;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="ci-verdict" data-tone={display.tone}>
        <div className="ci-glyph" aria-hidden>
          {TONE_GLYPH[display.tone]}
        </div>
        <h1 className="ci-headline">{display.headline}</h1>
        <p className="ci-subhead">{display.subhead}</p>
        {display.detail === null ? null : <p className="ci-detail">{display.detail}</p>}

        {session !== null ? (
          <p className="ci-detail">
            {clockTime(session.startedAt)} → {clockTime(session.endedAt)}
          </p>
        ) : null}
      </div>

      <div className="ci-actions">
        {/* Never a price the member can pay in-app: owner decision 9 forbids
            the portal POSTing a purchase. Informational, and it routes to a
            human at a counter. */}
        {nextStep !== null && nextStep.kind !== 'NONE' ? (
          <span className="p-badge p-badge-warn" style={{ justifySelf: 'center' }}>
            {nextStep.label}
          </span>
        ) : null}

        {denial !== null ? (
          <Link href="/portal/dashboard" className="p-btn p-btn-gold p-btn-block">
            Show this to the desk
          </Link>
        ) : null}

        <button type="button" className="p-btn p-btn-ghost p-btn-block" onClick={onScanAgain}>
          {result.outcome === 'CHECKED_OUT' ? 'Check in again' : 'Scan again'}
        </button>
      </div>

      {/* NO AUTO-DISMISS. The member may be pocketing the phone and want a
          second look; three seconds is not a decision to make for them. */}
    </div>
  );
}

/**
 * ONE catch-all for every non-2xx on this route.
 *
 * Five screens for five things that all mean "go to the desk" is five screens
 * nobody reads, and the desk is three metres away.
 */
function FailureCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="ci-verdict" data-tone="SEE_DESK">
        <div className="ci-glyph" aria-hidden>
          ·
        </div>
        <h1 className="ci-headline">Not checked in yet.</h1>
        <p className="ci-detail">{message}</p>
      </div>
      <div className="ci-actions">
        <button type="button" className="p-btn p-btn-gold p-btn-block" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}

/** An instant as a gym-local wall-clock time. */
function clockTime(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}
