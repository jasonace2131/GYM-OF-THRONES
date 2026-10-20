'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CheckInResult, CheckInStatus } from '@got/shared';
import { ApiError, apiFetch } from '@/lib/api';
import { SUBMIT_BACKOFF_MS } from '@/lib/scanner';
import { CheckInScanner } from '@/components/portal/CheckInScanner';
import { CheckInVerdict, clockTime } from '@/components/portal/CheckInVerdict';

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
 * A SECOND SCAN NEVER CHECKS ANYONE OUT BY ITSELF (owner, 2026-10-20). It
 * shows "You're already in." with a gold Check out button and a ghost Stay
 * checked in. Check out calls `POST /checkin/checkout`, which closes the visit
 * only because that scan, moments ago, proved the member is at the gym; Stay
 * records nothing and goes back to the scanner. The pre-flight line — "You're
 * checked in since 6:12 PM — scan again when you leave to check out" — tells
 * them how, before the camera arms.
 */
export default function CheckInPage() {
  const [status, setStatus] = useState<CheckInStatus | null>(null);
  const [result, setResult] = useState<CheckInResult | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const busyRef = useRef(false);

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      setStatus(await apiFetch<CheckInStatus>('/me/check-in-status'));
    } catch {
      // A pre-flight that cannot load is not a reason to block the scan. The
      // member may still be able to check in; they simply do not get the
      // "scan again when you leave" line.
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
            setFailure({
              headline: 'Not checked in yet.',
              message: 'Check-in is unavailable — please see the front desk.',
            });
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

  /**
   * The Check out button. No retry loop, unlike the scan: a refusal here is a
   * decision (not checked in, or the scan is too old), and a repeat tap is
   * already answered by the server with the same card.
   */
  const checkOut = useCallback(
    async (checkInId: string): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      setCheckingOut(true);

      try {
        const outcome = await apiFetch<CheckInResult>('/checkin/checkout', {
          method: 'POST',
          body: JSON.stringify({ checkInId }),
        });
        setResult(outcome);
        setAnnouncement(outcome.display.headline);
      } catch (error) {
        // The server's own words — "Scan the code at the desk again to check
        // out." — tell the member exactly what to do next.
        setResult(null);
        setFailure({
          headline: 'Not checked out.',
          // A 5xx carries a bare INTERNAL_SERVER_ERROR, not words for a member.
          message:
            error instanceof ApiError && error.status < 500
              ? error.message
              : 'Check-out is unavailable — please see the front desk.',
        });
        setAnnouncement('Not checked out.');
      } finally {
        busyRef.current = false;
        setCheckingOut(false);
        void loadStatus();
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
        <FailureCard failure={failure} onRetry={scanAgain} />
      ) : (
        <CheckInVerdict
          result={result!}
          onScanAgain={scanAgain}
          onCheckOut={(checkInId) => void checkOut(checkInId)}
          checkingOut={checkingOut}
        />
      )}
    </div>
  );
}

/**
 * What the member sees before the camera arms: whether they are inside, and
 * how to leave. Naming the exact clock time keeps "am I still checked in?"
 * from becoming a conversation at the desk.
 */
function PreFlight({ status }: { status: CheckInStatus | null }) {
  if (status === null) return null;

  if (status.open !== null) {
    return (
      <div className="ci-preflight">
        <span aria-hidden>●</span>
        <span>
          You’re checked in since <strong>{clockTime(status.open.startedAt)}</strong> — scan again
          when you leave to check out.
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

/** What went wrong, as the card says it. */
interface Failure {
  headline: string;
  message: string;
}

/**
 * ONE catch-all for every non-2xx on the scan route, and the same card for a
 * refused check-out, carrying the server's own message.
 *
 * Five screens for five things that all mean "go to the desk" is five screens
 * nobody reads, and the desk is three metres away.
 */
function FailureCard({ failure, onRetry }: { failure: Failure; onRetry: () => void }) {
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="ci-verdict" data-tone="SEE_DESK">
        <div className="ci-glyph" aria-hidden>
          ·
        </div>
        <h1 className="ci-headline">{failure.headline}</h1>
        <p className="ci-detail">{failure.message}</p>
      </div>
      <div className="ci-actions">
        <button type="button" className="p-btn p-btn-gold p-btn-block" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}
