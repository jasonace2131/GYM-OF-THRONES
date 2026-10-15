/**
 * The emailed sign-in code's rules (spec "Code rules"). The CHECKs in
 * migration 20261015000000_login_verification hard-code 5 for both
 * MAX_ATTEMPTS and MAX_SENDS_PER_SIGN_IN — change them together.
 */
export const LOGIN_CODE_TTL_MS = 10 * 60_000;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
export const LOGIN_CODE_RESEND_COOLDOWN_MS = 60_000;
export const LOGIN_CODE_MAX_SENDS_PER_SIGN_IN = 5;
export const LOGIN_CODE_MAX_SENDS_PER_HOUR = 10;
export const LOGIN_CODE_HOUR_MS = 60 * 60_000;
