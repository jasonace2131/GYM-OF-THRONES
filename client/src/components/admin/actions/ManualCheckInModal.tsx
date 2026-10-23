'use client';

import { useState } from 'react';
import type { CheckInResult, CheckInTone } from '@got/shared';
import { adminApi, type MemberListItem } from '@/lib/adminApi';
import { ApiError } from '@/lib/api';
import { Modal, ModalError } from '../Modal';
import { MemberPicker } from '../MemberPicker';
import { ConfirmDialog } from './ConfirmDialog';
import { MEMBER_CODE_LENGTH } from '@got/shared';
import { CODE_HINT, filterCodeTyping } from '@/lib/codeInput';

/**
 * Record a check-in for somebody who cannot self-scan — a flat battery, a
 * forgotten phone, a member who has never used the code.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A DENIAL IS NOT AN ERROR HERE.
 *
 * `POST /front-desk/check-ins` returns 200 for every business outcome,
 * including refusal: the payload carries the verdict. So a denied member must
 * be RENDERED, not thrown — `apiFetch` only throws when `success` is false,
 * and an expired membership is a successful call with an unhappy answer.
 * Treating it as an error would show "something went wrong" to an operator
 * whose actual next step is "your plan ended on the 2nd, want a day pass?".
 * ─────────────────────────────────────────────────────────────────────────
 */
export function ManualCheckInModal({
  open,
  onClose,
  onRecorded,
}: {
  open: boolean;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const [member, setMember] = useState<MemberListItem | null>(null);
  const [memberCode, setMemberCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckInResult | null>(null);
  const [confirming, setConfirming] = useState(false);

  const reset = (): void => {
    setMember(null);
    setMemberCode('');
    setError(null);
    setResult(null);
    setBusy(false);
    setConfirming(false);
  };

  const close = (): void => {
    reset();
    onClose();
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await adminApi.manualCheckIn(
        member !== null ? { userId: member.userId } : { memberCode: memberCode.trim() },
      );
      setResult(outcome);
      setConfirming(false);
      // Refresh the floor regardless of verdict: a denial is a row the desk
      // needs to see in "Needs you" just as much as an admission is one the
      // in-gym table needs.
      onRecorded();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  // A member code is exactly MEMBER_CODE_LENGTH characters from the code alphabet.
  const canSubmit = member !== null || memberCode.trim().length === MEMBER_CODE_LENGTH;

  return (
    <>
      <Modal
        open={open && !confirming}
        onClose={close}
        busy={busy}
        title="Manual check-in"
        subtitle="For a member who cannot scan the counter code themselves."
        footer={
          result === null ? (
            <>
              <button type="button" className="p-btn p-btn-ghost" onClick={close} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="p-btn p-btn-gold"
                onClick={() => setConfirming(true)}
                disabled={busy || !canSubmit}
              >
                Record check-in
              </button>
            </>
          ) : (
            <>
              <button type="button" className="p-btn p-btn-ghost" onClick={reset}>
                Check in someone else
              </button>
              <button type="button" className="p-btn p-btn-gold" onClick={close}>
                Done
              </button>
            </>
          )
        }
      >
        {result === null ? (
          <>
            <MemberPicker value={member} onSelect={setMember} autoFocus />

            {member === null && (
              <>
                <div className="a-or">or</div>
                <div className="a-field">
                  <label className="a-field-label" htmlFor="manual-member-code">
                    Member code
                  </label>
                  <input
                    id="manual-member-code"
                    className="a-input"
                    value={memberCode}
                    maxLength={MEMBER_CODE_LENGTH}
                    placeholder="e.g. 65EDYM"
                    autoComplete="off"
                    aria-describedby="manual-member-code-hint"
                    onChange={(event) =>
                      setMemberCode(filterCodeTyping(event.target.value, MEMBER_CODE_LENGTH))
                    }
                  />
                  <p id="manual-member-code-hint" className="a-field-hint">
                    {memberCode.length}/{MEMBER_CODE_LENGTH} · {CODE_HINT}
                  </p>
                </div>
              </>
            )}

            <ModalError message={error} />
          </>
        ) : (
          <CheckInVerdict result={result} />
        )}
      </Modal>

      <ConfirmDialog
        open={open && confirming}
        title={
          member !== null
            ? `Check in ${member.firstName} ${member.lastName}?`
            : `Check in member ${memberCode.trim()}?`
        }
        consequence="Records a desk check-in in your name, now. The server decides whether they are admitted, and the answer shows here."
        confirmLabel="Check in"
        cancelLabel="Back"
        busy={busy}
        error={error}
        onConfirm={() => void submit()}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
      />
    </>
  );
}

/**
 * The 200-with-a-verdict payload, rendered as the answer it is.
 *
 * TONE MAPS TO COLOUR AND NOTHING ELSE BRANCHES. `CheckInTone` is a closed
 * four-value union the server computes precisely so that no client has to
 * switch on `denial.reason` — a client that did would render a blank card the
 * first time that enum gained a value. GOODBYE is deliberately not green: a
 * check-out must never read as an admission.
 *
 * The three strings come from the server already written. `detail` is rendered
 * at body size, never larger, for the same reason it is on the member's phone.
 */
const TONE: Record<CheckInTone, { tone: string; word: string }> = {
  WELCOME: { tone: 'ok', word: 'Admitted' },
  GRACE: { tone: 'warn', word: 'Admitted on grace' },
  GOODBYE: { tone: 'info', word: 'Checked out' },
  SEE_DESK: { tone: 'danger', word: 'Not admitted' },
};

function CheckInVerdict({ result }: { result: CheckInResult }) {
  const { tone, word } = TONE[result.display.tone];

  return (
    <div className="a-verdict" data-tone={tone}>
      <div className="a-verdict-head">{word}</div>
      <p className="a-verdict-msg">{result.display.headline}</p>
      <p className="a-verdict-sub">{result.display.subhead}</p>
      {result.display.detail !== null && (
        <p className="a-verdict-detail">{result.display.detail}</p>
      )}
      {result.outcome === 'DENIED' && (
        <p className="a-verdict-next">
          A day pass is the usual next step — use <strong>Sell walk-in</strong>.
        </p>
      )}
    </div>
  );
}
