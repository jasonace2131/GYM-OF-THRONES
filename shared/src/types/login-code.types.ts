/**
 * The emailed sign-in code (feat/login-code, 2026-10-15): password, then a
 * 6-digit code, on every sign-in. Spec:
 * docs/superpowers/specs/2026-10-15-login-code-design.md.
 */

/** `POST /auth/login-code` when a code is (or was just) on its way. */
export interface LoginCodePending {
  verified: false;
  /** Masked, e.g. `ju***@gmail.com`. */
  sentTo: string;
  /** ISO instant. Until then "Resend code" counts down. */
  resendAvailableAt: string;
  /** ISO instant the current code stops working. */
  expiresAt: string;
}

/** Either endpoint, once this sign-in is verified. */
export interface LoginCodeVerified {
  verified: true;
}

export type LoginCodeSendResult = LoginCodePending | LoginCodeVerified;

/** `error.details` of `422 LOGIN_CODE_INVALID`. */
export interface LoginCodeInvalidDetails {
  attemptsLeft: number;
}
