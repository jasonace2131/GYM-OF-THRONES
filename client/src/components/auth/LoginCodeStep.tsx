'use client';

import { isCompleteCode, normaliseCodeInput, resendLabel } from '@/lib/loginCode';

export interface LoginCodeStepProps {
  /** Masked address, or null when the first send failed. */
  sentTo: string | null;
  code: string;
  error: string | null;
  verifying: boolean;
  resending: boolean;
  resendSecondsLeft: number;
  onCodeChange: (code: string) => void;
  onVerify: () => void;
  onResend: () => void;
  onSwitchAccount: () => void;
}

/**
 * The second step of signing in: the 6-digit code from the email. Purely
 * presentational — LoginPage owns the state and the calls.
 */
export function LoginCodeStep({
  sentTo,
  code,
  error,
  verifying,
  resending,
  resendSecondsLeft,
  onCodeChange,
  onVerify,
  onResend,
  onSwitchAccount,
}: LoginCodeStepProps) {
  const verifyBlocked = verifying || !isCompleteCode(code);
  // .btn-ghost has no disabled look of its own, so a counting-down Resend
  // would otherwise read as a live button that ignores the tap.
  const resendBlocked = resending || resendSecondsLeft > 0;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onVerify();
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 18 }}
    >
      <p style={{ fontSize: 14.5, lineHeight: 1.6, color: 'var(--text-2)', margin: 0 }}>
        {sentTo === null ? (
          "We couldn't email you a code yet."
        ) : (
          <>
            We emailed a 6-digit code to <strong>{sentTo}</strong>. It works for 10 minutes.
          </>
        )}
      </p>

      <div className="field">
        <label htmlFor="login-code">Sign-in code</label>
        <input
          id="login-code"
          className="input"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          placeholder="123456"
          value={code}
          onChange={(e) => onCodeChange(normaliseCodeInput(e.target.value))}
          // maxLength cuts a pasted "123 456" to "123 45" BEFORE onChange runs,
          // so a paste is read from the clipboard and normalised here instead.
          onPaste={(e) => {
            e.preventDefault();
            onCodeChange(normaliseCodeInput(e.clipboardData.getData('text')));
          }}
          autoFocus
          required
          // letter-spacing is added after every glyph, the last one included,
          // so centred text sits half a spacing left of centre. An equal
          // text-indent on the left balances it, and moves only the text, so
          // the input's outer size is unchanged.
          style={{ fontSize: 22, letterSpacing: '0.4em', textIndent: '0.4em', textAlign: 'center' }}
        />
      </div>

      {error && (
        <div
          role="alert"
          style={{
            padding: '11px 14px',
            borderRadius: 7,
            border: '1px solid rgba(255,90,70,.4)',
            background: 'rgba(255,90,70,.1)',
            color: '#ff9d92',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {error}
        </div>
      )}

      <button type="submit" disabled={verifyBlocked} className="btn btn-gold btn-block btn-auth">
        {verifying ? 'VERIFYING…' : 'VERIFY'}
      </button>

      <button
        type="button"
        disabled={resendBlocked}
        onClick={onResend}
        className="btn btn-ghost btn-block"
        style={{
          padding: 13,
          fontSize: 13.5,
          letterSpacing: '0.06em',
          opacity: resendBlocked ? 0.6 : 1,
          cursor: resendBlocked ? 'not-allowed' : 'pointer',
        }}
      >
        {resending ? 'Sending…' : resendLabel(resendSecondsLeft)}
      </button>

      <button
        type="button"
        onClick={onSwitchAccount}
        style={{
          alignSelf: 'center',
          background: 'none',
          border: 0,
          padding: 0,
          color: 'var(--gold)',
          fontSize: 12.5,
          cursor: 'pointer',
        }}
      >
        Use a different account
      </button>
    </form>
  );
}
