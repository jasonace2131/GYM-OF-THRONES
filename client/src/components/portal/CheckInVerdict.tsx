import Link from 'next/link';
import type { CheckInResult, CheckInTone } from '@got/shared';

/**
 * The card `/portal/checkin` shows after a scan, and after a confirmed
 * check-out.
 *
 * Lifted out of the page so its buttons can be asserted on rendered markup;
 * the page still owns every request. It reads `display.tone` for colour and
 * never `denial.reason` — see the page's header for why.
 */

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

export interface CheckInVerdictProps {
  result: CheckInResult;
  onScanAgain: () => void;
  /** The Check out button on an `ALREADY_INSIDE` card; receives the visit id. */
  onCheckOut: (checkInId: string) => void;
  /** True while `POST /checkin/checkout` is in flight. */
  checkingOut: boolean;
}

export function CheckInVerdict({
  result,
  onScanAgain,
  onCheckOut,
  checkingOut,
}: CheckInVerdictProps) {
  const { display, session, nextStep, denial } = result;

  // A second scan never checks out by itself (owner, 2026-10-20): it offers
  // the check-out, and the member confirms it here. The SERVER decides when to
  // offer it — only on the member's own scan of a current code, which it then
  // accepts as proof they are at the gym — so this reads its flag and infers
  // nothing. `=== true` because a replayed snapshot from before the flag
  // existed carries no such field.
  const offersCheckOut = result.checkOutOffered === true && result.checkIn !== null;

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

        {offersCheckOut ? (
          <>
            <button
              type="button"
              className="p-btn p-btn-gold p-btn-block"
              disabled={checkingOut}
              onClick={() => onCheckOut(result.checkIn!.id)}
            >
              {checkingOut ? 'Checking out…' : 'Check out'}
            </button>
            {/* Records nothing: back to the scanner, still checked in. */}
            <button
              type="button"
              className="p-btn p-btn-ghost p-btn-block"
              disabled={checkingOut}
              onClick={onScanAgain}
            >
              Stay checked in
            </button>
          </>
        ) : (
          <button type="button" className="p-btn p-btn-ghost p-btn-block" onClick={onScanAgain}>
            {result.outcome === 'CHECKED_OUT' ? 'Check in again' : 'Scan again'}
          </button>
        )}
      </div>

      {/* NO AUTO-DISMISS. The member may be pocketing the phone and want a
          second look; three seconds is not a decision to make for them. */}
    </div>
  );
}

/** An instant as a gym-local wall-clock time. */
export function clockTime(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}
