import type { UserStatus } from '@prisma/client';
import type { AccessResult } from '../membership/access-verdict';
import type { MembershipDetail } from '../membership/membership.presenter';
import type { PaymentSummary } from '../payments/payment.presenter';

/**
 * The member's own screens.
 *
 * /me/membership NEVER 404s: "no plan on file" is a valid, renderable state with
 * its own verdict message and its own call to action, and a 404 would make the
 * portal's subscription screen throw where it should render a sign-up prompt.
 */
export interface MyMembership {
  membership: MembershipDetail | null;
  verdict: AccessResult;
}

export interface MemberOverview {
  userId: string;
  memberCode: string | null;
  firstName: string;
  lastName: string;
  status: UserStatus;
  membership: MembershipDetail | null;
  verdict: AccessResult;
  guestPassesRemaining: number;
  lastPayment: PaymentSummary | null;
}

/**
 * `GET /me/coach` — the member's own assigned coach, if they have one.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS REPLACED A SCREEN OF INVENTED PEOPLE.
 *
 * `/portal/coach` used to render `COACHES` and `getCoachThread` from
 * `portalData.ts` — fabricated names, fabricated "online" dots and a
 * fabricated message history — in a file whose own header forbids exactly
 * that. A member seeing a coach who does not work here, or a conversation
 * that never happened, is worse than a member seeing nothing.
 *
 * `coach` is NULL when nobody is assigned, and that is a renderable state,
 * not an error: most members have no coach.
 *
 * Deliberately NARROW, and for the same reason `DeskMember` is: this is one
 * member reading about a staff member. Name and photo only — never the
 * coach's email, phone or member list.
 * ─────────────────────────────────────────────────────────────────────────
 */
export interface MyCoach {
  coach: {
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
  } | null;
  /**
   * Staff & Access: what the coach specialises in and a short bio, as an
   * admin wrote it. NULL when there is no coach OR nobody has written one —
   * the page then says nothing rather than rendering an empty card.
   */
  profile: { specializations: string[]; bio: string | null } | null;
  /** When the assignment started. NULL exactly when `coach` is. */
  since: string | null;
  /** That coach's next sessions, so the page is useful without messaging. */
  upcomingClasses: {
    id: string;
    title: string;
    startsAt: string;
    endsAt: string;
    capacity: number;
    bookedCount: number;
  }[];
}
