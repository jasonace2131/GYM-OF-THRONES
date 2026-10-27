import { normalisePassword } from '@/lib/credentials';

/**
 * The one password rule every screen that SETS a password follows: Register,
 * Reset password, Join, Invite and My account's Change password (owner,
 * 2026-10-26). Sign-in and the delete-account confirmation only CHECK a
 * password, so they never apply it — an older password that predates the rule
 * keeps working until its owner changes it (owner's choice).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SUPABASE IS THE REAL GATE; THIS IS THE CHECKLIST.
 *
 * The API never sets a password — Supabase Auth does, straight from the
 * browser. A rule enforced only here can be skipped by calling Supabase
 * directly, so the project's Auth settings must carry the same requirement
 * ("Lowercase, uppercase letters, digits and symbols"). The symbol list below
 * is Supabase's own, so a character this page counts as special is one
 * Supabase counts too; when they still disagree, `passwordRefusalMessage`
 * turns its `weak_password` into these same words.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** The floor reset-password, join and invite have always used. */
export const PASSWORD_MIN = 8;

/** Supabase Auth's symbol set for "digits and symbols". */
const SYMBOLS = '!@#$%^&*()_+-=[]{};\':"|<>?,./`~\\';

/** The length at which a password that meets every rule reads as Strong. */
const STRONG_LENGTH = 12;

export type PasswordRuleKey = 'length' | 'lower' | 'upper' | 'number' | 'symbol';

export interface PasswordRule {
  key: PasswordRuleKey;
  /** The checklist line. */
  label: string;
  met: boolean;
}

/** How each rule reads inside "Your password still needs …". */
const NEEDS: Record<PasswordRuleKey, string> = {
  length: `at least ${PASSWORD_MIN} characters`,
  lower: 'a lowercase letter',
  upper: 'an uppercase letter',
  number: 'a number',
  symbol: 'a special character',
};

export function passwordRules(raw: string): PasswordRule[] {
  const password = normalisePassword(raw);
  return [
    {
      key: 'length',
      label: `At least ${PASSWORD_MIN} characters`,
      met: password.length >= PASSWORD_MIN,
    },
    { key: 'lower', label: 'A lowercase letter (a–z)', met: /[a-z]/.test(password) },
    { key: 'upper', label: 'An uppercase letter (A–Z)', met: /[A-Z]/.test(password) },
    { key: 'number', label: 'A number (0–9)', met: /[0-9]/.test(password) },
    {
      key: 'symbol',
      label: 'A special character, like ! @ # $ %',
      met: Array.from(password).some((char) => SYMBOLS.includes(char)),
    },
  ];
}

export function meetsPasswordRules(raw: string): boolean {
  return passwordRules(raw).every((rule) => rule.met);
}

export type PasswordStrengthLevel = 0 | 1 | 2 | 3 | 4;

const STRENGTH_LABELS = ['Not started', 'Weak', 'Fair', 'Good', 'Strong'] as const;

/**
 * The bar under the field. Every rule met is only Good; Strong also needs
 * length, because length is what actually slows a guess down.
 */
export function passwordStrength(raw: string): {
  level: PasswordStrengthLevel;
  label: (typeof STRENGTH_LABELS)[number];
} {
  const password = normalisePassword(raw);
  const met = passwordRules(password).filter((rule) => rule.met).length;
  let level: PasswordStrengthLevel;
  if (password === '') level = 0;
  else if (met < 5) level = met <= 2 ? 1 : 2;
  else level = password.length >= STRONG_LENGTH ? 4 : 3;
  return { level, label: STRENGTH_LABELS[level] };
}

/** "a, b and c". */
function listInWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The first thing stopping a new password from being saved, or null. The
 * rules come before the match, so the member fixes the password before
 * retyping it.
 */
export function newPasswordProblem(next: string, confirm: string): string | null {
  const password = normalisePassword(next);
  if (password === '') return 'Choose a password.';
  const missing = passwordRules(password)
    .filter((rule) => !rule.met)
    .map((rule) => NEEDS[rule.key]);
  if (missing.length > 0) return `Your password still needs ${listInWords(missing)}.`;
  if (password !== normalisePassword(confirm)) return 'The two passwords do not match.';
  return null;
}

/**
 * Supabase's refusal of a password, in the member's words. Its own text for
 * `weak_password` lists Supabase's internals ("should contain at least one
 * character of each: abcdefghijklmnopqrstuvwxyz, ..."), not what to type.
 */
export function passwordRefusalMessage(error: { code?: string; message: string }): string {
  if (error.code === 'weak_password') {
    return `Choose a stronger password: at least ${PASSWORD_MIN} characters, with a lowercase and an uppercase letter, a number and a special character.`;
  }
  if (error.code === 'same_password') {
    return 'Choose a password different from your current one.';
  }
  return error.message;
}
