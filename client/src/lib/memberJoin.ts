import type { MemberJoinAccepted, MemberJoinClaim, MemberJoinLookup } from '@got/shared';
import { apiFetch } from './api';

/**
 * The member setup page (`/join/[token]`), everything but the pixels.
 *
 * Like the staff invite page: every dead end says what happened AND what to do
 * next, and a network failure is never dressed up as a dead link.
 */

export interface JoinCopy {
  title: string;
  body: string;
}

export type JoinLookupState = 'loading' | 'ok' | 'dead';
export type JoinStage = 'loading' | 'dead' | 'signed-out' | 'signed-in' | 'signed-in-other';

/**
 * Which face to show. `sessionEmail` is `undefined` while the session is still
 * being read, `null` when nobody is signed in.
 *
 * THE PASSWORD FORM IS ONLY FOR THE MEMBER. A desk PC is usually signed in as
 * staff; if a member's link is opened there, showing the form would let the
 * staff account change its OWN password. So any other session gets the "set up"
 * button, which signs the member in in its place.
 *
 * It fails CLOSED: a link with no email to compare against matches nobody, not
 * even an empty session email.
 */
export function joinStage(input: {
  lookup: JoinLookupState;
  link: MemberJoinLookup | null;
  sessionEmail: string | null | undefined;
}): JoinStage {
  if (input.lookup === 'dead') return 'dead';
  if (input.lookup === 'loading' || input.link === null) return 'loading';
  if (input.link.status !== 'PENDING') return 'dead';
  if (input.sessionEmail === undefined) return 'loading';
  if (input.sessionEmail === null) return 'signed-out';
  const linkEmail = input.link.email?.trim().toLowerCase() ?? '';
  if (linkEmail === '') return 'signed-in-other';
  return input.sessionEmail.trim().toLowerCase() === linkEmail ? 'signed-in' : 'signed-in-other';
}

/** Why the link cannot be used — from the lookup's status, or its error code. */
export function deadJoinCopy(input: {
  status: MemberJoinLookup['status'] | null;
  code: string | null;
}): JoinCopy {
  if (input.status === 'USED' || input.code === 'MEMBER_JOIN_USED') {
    return {
      title: 'Your account is already set up',
      body: 'Sign in with your email and password. Forgot it? Use "Forgot password" on the sign-in page.',
    };
  }
  if (input.status === 'EXPIRED' || input.code === 'MEMBER_JOIN_EXPIRED') {
    return {
      title: 'This link has expired',
      body: 'Setup links last 7 days. Ask the front desk to send you a new one.',
    };
  }
  // Only NO code at all is the network. Any answer from the server — a not-found,
  // or a mangled token the DTO refused (HTTP_400) — means the link is no good.
  if (input.code === null) {
    return {
      title: "We couldn't open this link",
      body: 'This is usually the connection. Reload the page to try again.',
    };
  }
  return {
    title: "This link isn't valid",
    body: 'Check you opened the whole link from your email, or ask the front desk to send you a new one.',
  };
}

/** Why a step failed — the link was fine a moment ago. */
export function joinErrorCopy(code: string | null): JoinCopy {
  switch (code) {
    case 'MEMBER_JOIN_WRONG_ACCOUNT':
      return {
        title: "You're signed in with a different account",
        body: 'Sign out, then open the link from your email again.',
      };
    case 'MEMBER_CREATE_DISABLED':
      return {
        title: 'Account set-up is not available right now',
        body: 'Please let the front desk know.',
      };
    case 'MEMBER_JOIN_STAFF_ACCOUNT':
      return {
        title: 'This link is not for a member account',
        body: 'Staff accounts are set up from Staff & Access. Ask the gym.',
      };
    case 'MEMBER_JOIN_USED':
    case 'MEMBER_JOIN_EXPIRED':
    case 'MEMBER_JOIN_NOT_FOUND':
      return deadJoinCopy({ status: null, code });
    // A password sign-in that never entered its emailed code. /join is not a
    // `?next=` the login page will return to, so the way through is a fresh
    // email-link session: sign out, open the link again.
    case 'LOGIN_CODE_REQUIRED':
      return {
        title: 'Please sign out and open your link again',
        body: 'This browser has a sign-in that was not finished. Tap Sign out below, then open the link from your email again.',
      };
    default:
      return {
        title: 'Something went wrong',
        body: 'Your link is still valid. Try again in a moment.',
      };
  }
}

/**
 * The form's check on a `yyyy-mm-dd` from a date input. `today` is the same
 * shape. Whether the date is old enough to be stored is the server's rule
 * (`asJoinableBirthDate`), not this one.
 */
export function birthDateProblem(value: string, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Enter your date of birth.';
  if (value >= today) return 'Your date of birth must be in the past.';
  const earliest = `${Number(today.slice(0, 4)) - 120}${today.slice(4)}`;
  if (value < earliest) return 'Please check the year of your date of birth.';
  return null;
}

/**
 * The calendar day before a `yyyy-mm-dd`. The date input's `max`: today itself
 * is refused by `birthDateProblem`, so the picker must not offer it.
 */
export function dayBefore(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Whether "Finish" must save the password before `accept`. Supabase refuses a
 * password identical to the current one (`same_password`), so a retry after a
 * failed `accept` must not save the same password again, or the page would
 * report a saved password as unsaved.
 */
export function passwordStep(input: {
  next: string;
  savedPassword: string | null;
}): 'skip' | 'save' {
  return input.savedPassword !== null && input.savedPassword === input.next ? 'skip' : 'save';
}

/** Supabase's refusal of an unchanged password: after a reload, it means the save already happened. */
export function isSamePasswordError(error: { code?: string } | null): boolean {
  return error?.code === 'same_password';
}

/** The setup page's three calls. Separate from `adminApi`: a stranger with a link opens this page. */
export const memberJoinApi = {
  lookup: (token: string): Promise<MemberJoinLookup> =>
    apiFetch<MemberJoinLookup>(`/member-join/lookup?token=${encodeURIComponent(token)}`),

  claimLink: (token: string): Promise<MemberJoinClaim> =>
    apiFetch<MemberJoinClaim>('/member-join/claim-link', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  accept: (token: string, dateOfBirth: string): Promise<MemberJoinAccepted> =>
    apiFetch<MemberJoinAccepted>('/member-join/accept', {
      method: 'POST',
      body: JSON.stringify({ token, dateOfBirth }),
    }),
};
