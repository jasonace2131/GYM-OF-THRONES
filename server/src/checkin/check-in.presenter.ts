import {
  AccessVerdict,
  DenialReason,
  denialMemberCopy,
  type CheckInDisplay,
  type CheckInMembershipSummary,
  type CheckInNextStep,
  type CheckInOutcome,
  type CheckInTone,
} from '@got/shared';
import { gymClockTime, shortDate, type CivilDate } from '../common/time/gym-time';
import type { AccessResult, MembershipSnapshot } from '../membership/access-verdict';

/**
 * Everything the member's phone and the desk feed render, composed here and
 * nowhere else.
 *
 * PURE. No clock, no Prisma, no config service — `now` and `timeZone` arrive as
 * parameters, exactly like `accessVerdict()`. That is what lets the copy rules
 * below be tested as rules rather than sampled through a database.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SPLIT THIS FILE EXISTS TO ENFORCE.
 *
 * A denial produces TWO messages that travel in TWO DIFFERENT HTTP RESPONSES:
 * `memberMessage` to the member's handset, `staffMessage` to the desk feed
 * (§6.9). The desk needs "STOP — expired 11 days. Do not admit."; the member
 * standing in a queue must never be shown why their account was suspended.
 * Because they leave on separate responses, the member's body is STRUCTURALLY
 * incapable of leaking the staff reason — it is not a field anyone forgot to
 * strip, it is a field that was never there.
 *
 * Two consequences that look like copy notes and are not:
 *
 *   - `detail` is body size, NEVER display size. What the queue behind the
 *     member can read from a metre away is a server decision, and a client
 *     rendering `detail` large is a review rejection.
 *   - `tone` is the ENTIRE rendering contract. Four values, and every surface
 *     maps tone to colour + word + glyph with no branching on
 *     `denial.reason`. A client that switched on DenialReason for colour
 *     renders a blank card the first time the enum gains a value.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * TWO RULINGS recorded here rather than rediscovered:
 *
 * 1. §6.5.3 puts the plan line in `subhead` and §9.4 puts the member's name and
 *    arrival time there, with the plan "below the fold, quiet". §9.4 is the
 *    specific rendering pass for the handset and both agree the phone shows
 *    both lines, so: `subhead` is identity + time, `detail` is plan +
 *    valid-until. Nothing is dropped; only the order is settled.
 *
 * 2. §6.5.3 and §9.4 both show a peso figure in `detail`. §5.4 forbids one
 *    anywhere in a response body — prices are integer centavos on the wire and
 *    every surface renders its own currency — and §5 is final. No peso string
 *    is composed here. The desk console already holds the plan price and
 *    renders it itself; a "₱800" baked into a server string goes stale the day
 *    the owner changes it and ships in the next release instead of the next
 *    request.
 */

/** 24 characters or fewer each — one fixation, per §9.4. */
const HEADLINES = {
  WELCOME: "You're in.",
  ALREADY_INSIDE: "You're already in.",
  GRACE: "You're in — see desk.",
  GOODBYE: 'Checked out.',
  /**
   * Neutral and IDENTICAL for every denial reason. The reason lives in
   * `detail`, at body size, one arm's length from one pair of eyes.
   *
   * Banned on this surface, permanently: DENIED, REJECTED, INVALID, FAILED,
   * UNAUTHORIZED, ACCESS DENIED, EXPIRED MEMBER. Machine words for a machine
   * audience — a member is in public and has just been refused by a machine,
   * and they remember a humiliating screen far longer than they remember the
   * gym.
   */
  SEE_DESK: 'Not checked in yet.',
} as const;

export interface CheckInPresentationInput {
  outcome: CheckInOutcome;
  /**
   * The ladder's result. NULL for `CHECKED_OUT` only — membership is never
   * evaluated on the way out (§6.5.2 step 2), because a member whose term
   * expired mid-session must still be able to check out.
   */
  verdict: AccessResult | null;
  firstName: string;
  membership: MembershipSnapshot | null;
  /** The instant this outcome happened, as the server stamped it. */
  occurredAt: Date;
  timeZone: string;
  /** `CHECKED_OUT` only. */
  sessionMinutes: number | null;
  /** `ALREADY_INSIDE` only. */
  checkOutAvailableAt: Date | null;
  /**
   * How long after a check-out a scan reopens the same visit — the re-entry
   * grace with the min-session as its floor. Rendered on the GOODBYE card;
   * a number baked into the copy went stale the day the env became tunable.
   */
  reopenWindowMinutes: number;
}

export interface CheckInPresentation {
  display: CheckInDisplay;
  nextStep: CheckInNextStep | null;
  /** `DENIED` only — §9.5's dignity mapping, applied server-side. */
  memberMessage: string | null;
  /** The desk feed's copy. Directive, blunt, and never sent to a handset. */
  staffMessage: string;
}

export function presentCheckIn(input: CheckInPresentationInput): CheckInPresentation {
  const tone = toneFor(input.outcome, input.verdict);
  const time = gymClockTime(input.occurredAt, input.timeZone);
  const identity = `${input.firstName} · ${time}`;

  switch (tone) {
    case 'GOODBYE': {
      const spent = formatDuration(input.sessionMinutes ?? 0);
      return {
        display: {
          tone,
          headline: HEADLINES.GOODBYE,
          subhead: `${spent} today.`,
          // One line serving both recoveries — the mistaken scan AND the
          // stepping-out member — on the card that PRECEDES the mistake, not
          // on a help page. Within the window a scan reopens the same visit.
          detail: `Heading back in? Scan again within ${input.reopenWindowMinutes} minutes and it stays one visit.`,
        },
        nextStep: null,
        memberMessage: null,
        staffMessage: `Checked out after ${spent}.`,
      };
    }

    case 'SEE_DESK': {
      // A DENIED outcome always carries a verdict; the fallback exists so this
      // function is total, not because the branch is reachable.
      const reason = input.verdict?.denialReason ?? DenialReason.NO_MEMBERSHIP;
      const memberMessage = denialMemberCopy(reason, relevantShortDate(input.verdict));
      return {
        display: {
          tone,
          headline: HEADLINES.SEE_DESK,
          subhead: identity,
          detail: memberMessage,
        },
        nextStep: nextStepFor(reason),
        memberMessage,
        staffMessage: input.verdict?.message ?? 'Refused at the door. Check the account.',
      };
    }

    case 'GRACE': {
      const membership = input.membership;
      const graceLeft = input.verdict?.graceDaysRemaining ?? 0;
      const window = graceLeft === 0 ? 'today only' : `for ${plural(graceLeft, 'more day')}`;
      const detail =
        membership === null
          ? 'Your plan has ended — settle at the desk.'
          : `Your ${membership.planName} ended ${shortDate(membership.endsOn)}. ` +
            `You can train ${window} — settle at the desk.`;
      return {
        display: { tone, headline: HEADLINES.GRACE, subhead: identity, detail },
        // The grace admission IS the collection prompt, and the member carries
        // it to the counter — nobody at the desk saw it happen.
        nextStep: { kind: 'RENEW_AT_DESK', label: 'Settle at the desk' },
        memberMessage: null,
        staffMessage: input.verdict?.message ?? 'In grace. Let them in and collect the renewal.',
      };
    }

    case 'WELCOME':
    default: {
      const alreadyInside = input.outcome === 'ALREADY_INSIDE';
      return {
        display: {
          tone: 'WELCOME',
          headline: alreadyInside ? HEADLINES.ALREADY_INSIDE : HEADLINES.WELCOME,
          subhead: alreadyInside ? `Since ${time}.` : identity,
          detail: alreadyInside
            ? checkOutLine(input.checkOutAvailableAt, input.timeZone)
            : planLine(input.membership),
        },
        nextStep: null,
        memberMessage: null,
        staffMessage: input.verdict?.message ?? 'Let them in.',
      };
    }
  }
}

/**
 * The tone ladder, and the one thing it must never do: `GRACE` is decided by
 * the STORED VERDICT, not by the outcome. A grace admission checked in, so its
 * outcome is `CHECKED_IN` like any other — collapsing the two would render a
 * grace entry green and silently drop the collection prompt that is the only
 * reason grace is finite.
 */
export function toneFor(outcome: CheckInOutcome, verdict: AccessResult | null): CheckInTone {
  if (outcome === 'DENIED') return 'SEE_DESK';
  if (outcome === 'CHECKED_OUT') return 'GOODBYE';
  if (verdict?.verdict === AccessVerdict.ALLOWED_IN_GRACE) return 'GRACE';
  return 'WELCOME';
}

/**
 * Informational only. Owner decision 9 forbids the portal POSTing a purchase,
 * so nothing here is ever a button that takes money — every kind routes to a
 * human at a counter.
 */
export function nextStepFor(reason: DenialReason): CheckInNextStep {
  switch (reason) {
    case DenialReason.NO_MEMBERSHIP:
      return { kind: 'WALK_IN_AT_DESK', label: 'Ask the desk about today' };
    case DenialReason.MEMBERSHIP_EXPIRED:
    case DenialReason.MEMBERSHIP_CANCELLED:
      return { kind: 'RENEW_AT_DESK', label: 'Renew at the desk' };
    default:
      return { kind: 'SEE_DESK', label: 'See the front desk' };
  }
}

/** The compact membership the portal refreshes from without a second call. */
export function toCheckInMembershipSummary(
  membership: MembershipSnapshot | null,
  verdict: AccessResult,
): CheckInMembershipSummary {
  return {
    planName: membership?.planName ?? null,
    status: membership?.status ?? null,
    endsOn: membership?.endsOn ?? null,
    daysRemaining: verdict.daysRemaining,
    decision: verdict.decision,
  };
}

/** '1 h 26 m', '48 m', '0 m'. Never '1.43 hours'. */
export function formatDuration(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return hours === 0 ? `${rest} m` : `${hours} h ${rest} m`;
}

function planLine(membership: MembershipSnapshot | null): string | null {
  if (membership === null) return null;
  return `${membership.planName} · valid until ${shortDate(membership.endsOn)}`;
}

/**
 * Naming the exact clock time is the whole fix. "Try again later" generates a
 * conversation at the desk every single time (§9.4).
 */
function checkOutLine(availableAt: Date | null, timeZone: string): string {
  if (availableAt === null) return 'Scan again later to check out.';
  return `Scan again after ${gymClockTime(availableAt, timeZone)} to check out.`;
}

function relevantShortDate(verdict: AccessResult | null): string | null {
  const day: CivilDate | null | undefined = verdict?.relevantDate;
  return day === null || day === undefined ? null : shortDate(day);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
