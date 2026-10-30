/**
 * A staff-created member's setup link (`/join/<token>`) — counter sign-up.
 *
 * The page is public: it holds nothing but the token from the email.
 */
export type MemberJoinStatus = 'PENDING' | 'USED' | 'EXPIRED';

/**
 * `GET /member-join/lookup?token=` — public.
 *
 * `email` is present only while PENDING. The page compares it with the signed-in
 * session's email before it offers a password form, so a different account
 * signed in on the same computer can never change its own password here. The
 * token already lets its holder into this account, so the address reveals
 * nothing more.
 */
export interface MemberJoinLookup {
  firstName: string;
  status: MemberJoinStatus;
  email?: string;
  /**
   * Present only while PENDING. False when a date of birth is already on file,
   * as it is for every counter sign-up since 2026-10-30: the page does not ask
   * for it again. Read as "ask" when absent.
   */
  needsDateOfBirth?: boolean;
}

/** `POST /member-join/claim-link` — public. Where "Set up my account" goes next. */
export interface MemberJoinClaim {
  url: string;
}

/** `POST /member-join/accept`. `dateOfBirthSaved` is false when no date was saved, e.g. one was already on file or the link was already used. */
export interface MemberJoinAccepted {
  dateOfBirthSaved: boolean;
}
