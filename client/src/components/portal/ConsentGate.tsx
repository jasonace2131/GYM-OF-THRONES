'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  LEGAL_LABELS,
  LEGAL_ROUTES,
  LEGAL_VERSIONS,
  type LegalDocumentKind,
} from '@got/shared';
import { apiFetch } from '@/lib/api';

/**
 * The one screen a member cannot get past without accepting.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A BLOCKING SCREEN RATHER THAN A BANNER.
 *
 * A dismissible prompt produces members who have used the gym for months
 * without accepting anything, which is the state this whole phase exists to
 * end. The gym's protection is worth nothing if it is opt-out.
 *
 * It is NOT a security control and is not treated as one — a determined
 * member can call the API directly. The server-side value is the record, and
 * the record is written by `POST /me/consent` whether the member reached it
 * from here or not. This screen is what makes the normal path the recorded
 * one.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Each document opens in a NEW TAB. Navigating away in the same tab would
 * unmount the portal and lose the pending state, and — more to the point — a
 * member who has to abandon the screen to read what they are agreeing to will
 * not read it.
 */
export function ConsentGate({
  outstanding,
  onAccepted,
  onSignOut,
}: {
  outstanding: LegalDocumentKind[];
  onAccepted: () => void;
  onSignOut: () => void;
}) {
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // "New" for a first-time member, "updated" for somebody caught by a version
  // bump. The distinction matters: being asked again to accept something you
  // already accepted looks like a bug unless the screen says why.
  const isUpdate = outstanding.length < 3;

  const submit = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      // The server decides the version. Sending one from here would let a
      // client claim acceptance of wording it never rendered.
      await apiFetch('/me/consent', {
        method: 'POST',
        body: JSON.stringify({ kinds: outstanding }),
      });
      onAccepted();
    } catch {
      setSubmitting(false);
      setError('That did not save. Check your connection and try again.');
    }
  };

  return (
    <div className="portal-root">
      <div className="p-consent">
        <div className="p-consent-card">
          <span className="eyebrow">{isUpdate ? 'Updated' : 'Before you start'}</span>
          <h1>{isUpdate ? 'We have updated our terms' : 'A few things to agree to'}</h1>
          <p className="p-consent-lede">
            {isUpdate
              ? 'We have changed the wording below since you last agreed. Please read the updated version and accept it to carry on.'
              : 'Please read these before your first session. They cover the risks of training, how your membership works, and what we do with your information.'}
          </p>

          <ul className="p-consent-docs">
            {outstanding.map((kind) => (
              <li key={kind}>
                <Link href={LEGAL_ROUTES[kind]} target="_blank" rel="noopener noreferrer">
                  <span>{LEGAL_LABELS[kind]}</span>
                  <span className="p-consent-version">v{LEGAL_VERSIONS[kind]}</span>
                </Link>
              </li>
            ))}
          </ul>

          <label className="p-consent-agree">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              disabled={submitting}
            />
            <span>
              I have read and agree to the {outstanding.length === 1 ? 'document' : 'documents'}{' '}
              above.
            </span>
          </label>

          {error !== null && (
            <div role="alert" className="p-consent-error">
              {error}
            </div>
          )}

          <button
            type="button"
            className="p-btn p-btn-gold p-btn-block"
            disabled={!agreed || submitting}
            onClick={() => void submit()}
          >
            {submitting ? 'SAVING…' : 'AGREE AND CONTINUE'}
          </button>

          {/*
            An exit that is not "agree". Consent that cannot be refused is not
            consent — RA 10173 requires it to be freely given, and a screen
            whose only control is the accept button does not clear that bar.
          */}
          <button type="button" className="p-consent-decline" onClick={onSignOut}>
            Not now — sign me out
          </button>
        </div>
      </div>
    </div>
  );
}
