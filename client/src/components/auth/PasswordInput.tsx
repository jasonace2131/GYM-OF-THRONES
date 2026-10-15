'use client';

import { useState, type ComponentPropsWithoutRef } from 'react';

/**
 * A password field with the industry-standard reveal toggle.
 *
 * A drop-in for `<input className="input" type="password" />` — every other
 * prop passes straight through, so `autoComplete`, `required`, `minLength`
 * and the field's id keep working exactly as they did.
 *
 * THREE THINGS HERE ARE LOAD-BEARING, AND EACH IS A BUG IF DROPPED:
 *
 * 1. `type="button"` on the toggle. A <button> inside a <form> defaults to
 *    type="submit" — without this, clicking the eye submits the login form
 *    with whatever is typed so far. It is the classic way this pattern ships
 *    broken, and it fails silently in the direction of "the site logged me in
 *    before I finished typing".
 *
 * 2. The background, border and colour are stated explicitly. These auth
 *    screens are outside the portal and the admin console, so they never load
 *    tailwind.css and never get the Preflight-substitute reset in it. A
 *    <button> with no background rule paints the user agent's `buttonface`
 *    grey and a 2px outset ridge — which is exactly what turned every
 *    calendar day cell into a filled grey box before that reset existed.
 *
 * 3. Revealed state is local and unpersisted. It resets on navigation and on
 *    remount, is never written to storage, and is per-field: revealing a
 *    password does not reveal the confirmation beside it. The toggle exists
 *    so somebody can check their own typing, not so a browser can remember a
 *    password was once on screen.
 *
 * `aria-pressed` carries the state to a screen reader and the label changes
 * with it, so the control announces as a toggle rather than as two different
 * buttons that swap places.
 */
type PasswordInputProps = Omit<ComponentPropsWithoutRef<'input'>, 'type'>;

export function PasswordInput({ className, ...inputProps }: PasswordInputProps) {
  const [revealed, setRevealed] = useState(false);
  const action = revealed ? 'Hide password' : 'Show password';

  return (
    <div className="input-reveal">
      <input
        {...inputProps}
        type={revealed ? 'text' : 'password'}
        className={className === undefined ? 'input' : `input ${className}`}
      />
      <button
        type="button"
        className="input-reveal-btn"
        onClick={() => setRevealed((shown) => !shown)}
        aria-label={action}
        aria-pressed={revealed}
        title={action}
      >
        {revealed ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  );
}

/* aria-hidden because the button already carries the label — without it a
   screen reader announces the graphic a second time with no extra meaning. */
function EyeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10.6 5.2A10.2 10.2 0 0 1 12 5c6.5 0 10 7 10 7a18.6 18.6 0 0 1-2.4 3.4" />
      <path d="M6.6 6.6A18.5 18.5 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="m2 2 20 20" />
    </svg>
  );
}
