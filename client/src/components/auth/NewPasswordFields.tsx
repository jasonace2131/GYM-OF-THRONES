'use client';

import { useId } from 'react';
import { normalisePassword } from '@/lib/credentials';
import { passwordRules, passwordStrength } from '@/lib/passwordRules';
import { PasswordInput, type PasswordInputSkin } from './PasswordInput';

/**
 * "New password" + "Confirm", the same on every screen that sets one —
 * Register, Reset password, Join, Invite and My account (owner, 2026-10-26).
 *
 * Under the new password: a four-step strength bar with its word, and the
 * five rules as a checklist that ticks off while the member types. Under the
 * confirmation: whether it matches yet. The rules themselves are
 * `lib/passwordRules.ts`; this only shows them.
 *
 * NOTHING HERE IS ANNOUNCED PER KEYSTROKE. The checklist is the new-password
 * field's description, read when the field is focused; a live region on it
 * would read the whole list again on every letter. The screen's own problem
 * message (`problemId`) is the alert, after a failed save.
 *
 * `showMissing`: after a failed save, the rules still unmet turn from "to do"
 * into "missing", so the member sees exactly what stopped it.
 *
 * `skin`: `auth` for the dark sign-in screens (globals.css), `portal` for My
 * account's sheet (light overrides in portal.css).
 */
export function NewPasswordFields({
  password,
  confirm,
  onPasswordChange,
  onConfirmChange,
  labels,
  showMissing = false,
  skin = 'auth',
  disabled,
  invalid = null,
  problemId,
  names = { password: 'newPassword', confirm: 'confirmPassword' },
  placeholder,
}: {
  password: string;
  confirm: string;
  onPasswordChange: (value: string) => void;
  onConfirmChange: (value: string) => void;
  labels: { password: string; confirm: string };
  showMissing?: boolean;
  skin?: PasswordInputSkin;
  disabled?: boolean;
  /** The field the screen's shown problem belongs to. */
  invalid?: 'password' | 'confirm' | null;
  /** The id of the screen's problem message, linked from the invalid field. */
  problemId?: string;
  names?: { password: string; confirm: string };
  placeholder?: string;
}) {
  const uid = useId();
  const passwordId = `${uid}-password`;
  const confirmId = `${uid}-confirm`;
  const rulesId = `${uid}-rules`;
  const matchId = `${uid}-match`;

  const rules = passwordRules(password);
  const strength = passwordStrength(password);
  const typedConfirm = confirm !== '';
  // Compared as a save compares them, so the hint never disagrees with Save.
  const matches = typedConfirm && normalisePassword(confirm) === normalisePassword(password);

  const fieldClass = skin === 'portal' ? 'pw-field' : 'field';
  const labelClass = skin === 'portal' ? 'a-person-sub' : undefined;
  const linked = (base: string[], field: 'password' | 'confirm'): string | undefined => {
    const ids = invalid === field && problemId !== undefined ? [...base, problemId] : base;
    return ids.length === 0 ? undefined : ids.join(' ');
  };

  return (
    <div className={`pw-fields pw-${skin}`}>
      <div className={fieldClass}>
        <label htmlFor={passwordId} className={labelClass}>
          {labels.password}
        </label>
        <PasswordInput
          id={passwordId}
          name={names.password}
          skin={skin}
          autoComplete="new-password"
          placeholder={placeholder}
          value={password}
          disabled={disabled}
          onChange={(event) => onPasswordChange(event.target.value)}
          aria-describedby={linked([rulesId], 'password')}
          aria-invalid={invalid === 'password' ? true : undefined}
        />
        <div className="pw-strength" data-level={strength.level}>
          <span className="pw-bar" aria-hidden="true">
            <span className="pw-seg" />
            <span className="pw-seg" />
            <span className="pw-seg" />
            <span className="pw-seg" />
          </span>
          <span className="pw-strength-row">
            <span>Password strength</span>
            <b className="pw-strength-label">{strength.label}</b>
          </span>
        </div>
        <ul className="pw-rules" id={rulesId} aria-label="Your password needs">
          {rules.map((rule) => {
            const state = rule.met ? 'met' : showMissing ? 'missing' : 'todo';
            return (
              <li key={rule.key} data-state={state}>
                <span className="pw-rule-icon" aria-hidden="true">
                  {state === 'met' ? <CheckIcon /> : null}
                  {state === 'missing' ? <CrossIcon /> : null}
                </span>
                <span className="pw-rule-text">{rule.label}</span>
                {state === 'todo' ? null : (
                  <span className="pw-sr">{state === 'met' ? ', done' : ', still needed'}</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className={fieldClass}>
        <label htmlFor={confirmId} className={labelClass}>
          {labels.confirm}
        </label>
        <PasswordInput
          id={confirmId}
          name={names.confirm}
          skin={skin}
          autoComplete="new-password"
          placeholder={placeholder}
          value={confirm}
          disabled={disabled}
          onChange={(event) => onConfirmChange(event.target.value)}
          aria-describedby={linked(typedConfirm ? [matchId] : [], 'confirm')}
          aria-invalid={invalid === 'confirm' ? true : undefined}
        />
        {typedConfirm ? (
          <p className="pw-match" id={matchId} data-match={matches}>
            {matches ? <CheckIcon /> : null}
            {matches ? 'Passwords match' : 'Doesn’t match the new password yet'}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 12l5 5 9-10" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3.2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
