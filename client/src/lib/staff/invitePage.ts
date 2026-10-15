import { roleLabel } from '@got/shared';

/**
 * The public invite page (`/invite/[token]`), everything but the pixels.
 *
 * The page talks to someone who may never have seen this product: every dead
 * end says what happened AND what to do next, and a network failure is never
 * dressed up as a dead link (or the other way round).
 */

export interface InviteCopy {
  title: string;
  body: string;
}

/** The h1 on every live face; the role goes in the lead sentence instead. */
export const INVITE_HEADLINE = "You're invited";

/** The signed-out lead's first sentence. */
export function inviteRoleSentence(role: string): string {
  return `Gym of Thrones invited you to join as ${roleLabel(role)}.`;
}

/** The signed-in and wrong-account leads, where the invitation is already introduced. */
export function inviteRoleNote(role: string): string {
  return `It is to join Gym of Thrones as ${roleLabel(role)}.`;
}

/** Why the link itself cannot be used — from the lookup's error code. */
export function deadInviteCopy(code: string | null): InviteCopy {
  switch (code) {
    case 'STAFF_INVITE_EXPIRED':
      return {
        title: 'This invitation has expired',
        body: 'Invitations last 7 days. Ask the person who invited you to resend it — you will get a fresh link.',
      };
    case 'STAFF_INVITE_REVOKED':
      return {
        title: 'This invitation was withdrawn',
        body: 'The gym withdrew this invitation. If you still need access, ask them for a new one.',
      };
    case 'STAFF_INVITE_USED':
      return {
        title: 'This invitation has already been used',
        body: 'If that was you, just sign in as usual. If it was not, let the gym know.',
      };
    case 'STAFF_INVITE_NOT_FOUND':
      return {
        title: "This invitation link isn't valid",
        body: 'Check you opened the whole link from your email. If it still does not work, ask the gym to resend it.',
      };
    default:
      return {
        title: "We couldn't open this invitation",
        body: 'This is usually the connection. Reload the page to try again.',
      };
  }
}

/** Why accepting failed — the invitation was fine a moment ago. */
export function acceptErrorCopy(code: string | null, maskedEmail: string): InviteCopy {
  switch (code) {
    case 'STAFF_INVITE_EMAIL_MISMATCH':
      return {
        title: "You're signed in with a different email",
        body: `This invitation is for ${maskedEmail}. Sign out, then sign in with that address to accept it.`,
      };
    case 'ROLE_NOT_ASSIGNABLE':
      return {
        title: 'This invitation can no longer be used',
        body: 'The person who invited you can no longer give this role. Ask them for a new invitation.',
      };
    case 'STAFF_INVITE_WOULD_DEMOTE':
      return {
        title: 'You already have a higher role',
        body: 'Accepting would lower your access, so it was not applied. Ask an admin if your role should change.',
      };
    case 'STAFF_INVITE_EXPIRED':
    case 'STAFF_INVITE_REVOKED':
    case 'STAFF_INVITE_USED':
    case 'STAFF_INVITE_NOT_FOUND':
      return deadInviteCopy(code);
    // apiFetch normally sends this to the login page's code step first; this
    // is the words for the moment before that navigation lands.
    case 'LOGIN_CODE_REQUIRED':
      return {
        title: 'Finish signing in first',
        body: 'Enter the code we emailed you when you signed in, then accept the invitation.',
      };
    default:
      return {
        title: 'Something went wrong',
        body: 'Your invitation is still valid. Try again in a moment.',
      };
  }
}

export type LookupState = 'loading' | 'ok' | 'dead';
export type SessionState = 'checking' | 'signed-out' | 'signed-in';
/**
 * Whether the signed-in account is the invited one, from
 * `GET /staff-invitations/match`. `unknown` is that call failing for any
 * other reason: the page then offers Accept as it always did, and the server
 * still refuses the wrong account there.
 */
export type MatchState = 'checking' | 'match' | 'mismatch' | 'unknown';
export type InviteStage = 'loading' | 'dead' | 'signed-out' | 'wrong-account' | 'signed-in';

/**
 * Which of the page's faces to show. A dead link wins over any session, and a
 * signed-in session waits for the match answer, so an admin opening the link
 * in their own browser never sees an Accept button flash up first.
 */
export function inviteStage(input: {
  lookup: LookupState;
  session: SessionState;
  match: MatchState;
}): InviteStage {
  if (input.lookup === 'dead') return 'dead';
  if (input.lookup === 'loading' || input.session === 'checking') return 'loading';
  if (input.session === 'signed-out') return 'signed-out';
  if (input.match === 'checking') return 'loading';
  return input.match === 'mismatch' ? 'wrong-account' : 'signed-in';
}

/** "Sign in instead", returning here afterwards. */
export function signInHref(token: string): string {
  return `/login?next=${encodeURIComponent(`/invite/${token}`)}`;
}
