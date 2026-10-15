import { DENIAL_MEMBER_COPY, DenialReason, denialMemberCopy } from '@got/shared';
import { civilDaysBetween, type CivilDate } from '@/lib/gymTime';
import type { AccessResult, MembershipDetail } from '@/lib/portalData';
import { dayMonth } from './dashboardView';

/**
 * The dashboard's status band, decided in ONE place from the server's verdict.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * KEYED ON THE REASON, NEVER ON A DAY COUNT.
 *
 * `accessVerdict()` on the server is the only place "expiring soon", "grace"
 * and "last day" are decided (`allowReason` / `denialReason`). The screen this
 * replaces re-derived them from `daysRemaining <= 7` — a second threshold that
 * would drift from the door's the day anyone tuned MEMBERSHIP_EXPIRING_SOON_DAYS.
 *
 * AND NEVER THE DESK'S WORDS. `verdict.message` is written for staff ("Do not
 * let them in — get a manager"); the member's copy is `denialMemberCopy()`
 * from @got/shared, which the check-in screen already uses, so the two
 * surfaces cannot contradict each other in front of the same person.
 * ─────────────────────────────────────────────────────────────────────────
 */

export type StatusTone = 'ok' | 'warn' | 'danger' | 'neutral';

export interface StatusCta {
  label: string;
  href: string;
}

export interface MembershipStatusView {
  tone: StatusTone;
  /** The status pill: "Monthly · Active". Carries the state in WORDS. */
  badge: string;
  /** One sentence for the member, or null when there is nothing to say. */
  line: string | null;
  primaryCta: StatusCta | null;
  secondaryCta: StatusCta | null;
  /** The days-left ring, only while a running term has days to count. */
  ring: { remaining: number; total: number; tone: StatusTone } | null;
  /** The quiet date line: "Active until 4 Oct". */
  untilLabel: string | null;
}

const CHECK_IN: StatusCta = { label: 'Check in', href: '/portal/checkin' };
const BOOK: StatusCta = { label: 'Book a class', href: '/portal/schedule' };
const RENEW: StatusCta = { label: 'Renew', href: '/portal/subscription' };
const CHOOSE_PLAN: StatusCta = { label: 'Choose a plan', href: '/portal/subscription' };
const VIEW_PLAN: StatusCta = { label: 'View my plan', href: '/portal/subscription' };

const days = (n: number): string => `${n} day${n === 1 ? '' : 's'}`;

export function membershipStatusView(
  membership: MembershipDetail | null,
  verdict: AccessResult,
): MembershipStatusView {
  const plan = membership?.planName ?? null;
  const ends = membership === null ? null : dayMonth(membership.endsOn);
  const relevant = verdict.relevantDate === null ? null : dayMonth(verdict.relevantDate);

  const ring = (tone: StatusTone): MembershipStatusView['ring'] =>
    membership === null || verdict.daysRemaining === null
      ? null
      : {
          remaining: verdict.daysRemaining,
          // Inclusive of both ends: a term that starts and ends on one day is
          // one day long. Only ever the ring's denominator.
          total: Math.max(
            1,
            civilDaysBetween(membership.startsOn as CivilDate, membership.endsOn as CivilDate) + 1,
          ),
          tone,
        };

  switch (verdict.allowReason) {
    case 'MEMBERSHIP_ACTIVE':
      return {
        tone: 'ok',
        badge: `${plan} · Active`,
        line: null,
        primaryCta: CHECK_IN,
        secondaryCta: BOOK,
        ring: ring('ok'),
        untilLabel: `Active until ${ends}`,
      };

    case 'MEMBERSHIP_EXPIRING_SOON':
      return {
        tone: 'warn',
        badge: `${plan} · Ends soon`,
        line: `Your plan ends ${ends} — ${days(verdict.daysRemaining ?? 0)} left. Renew at the front desk to keep training without a gap.`,
        primaryCta: CHECK_IN,
        secondaryCta: RENEW,
        ring: ring('warn'),
        untilLabel: `Ends ${ends}`,
      };

    case 'MEMBERSHIP_EXPIRES_TODAY':
      return {
        tone: 'warn',
        badge: `${plan} · Last day`,
        line: 'Today is the last day of your plan. Renew at the front desk to keep training.',
        primaryCta: CHECK_IN,
        secondaryCta: RENEW,
        // "0 days left" on the day that is still paid for reads as already over.
        ring: null,
        untilLabel: 'Ends today',
      };

    case 'MEMBERSHIP_ENDING':
      return {
        tone: 'neutral',
        badge: `${plan} · Ending`,
        line: `Your plan won't renew — it ends ${ends}.`,
        primaryCta: CHECK_IN,
        secondaryCta: BOOK,
        ring: ring('neutral'),
        untilLabel: `Ends ${ends}`,
      };

    case 'MEMBERSHIP_IN_GRACE': {
      const ended = relevant ?? ends;
      return {
        tone: 'warn',
        badge: `${plan} · Grace period`,
        line:
          verdict.graceDaysRemaining > 0
            ? `Your plan ended ${ended}. You're in a grace period for ${verdict.graceDaysRemaining} more ${verdict.graceDaysRemaining === 1 ? 'day' : 'days'} — renew at the front desk to keep training.`
            : `Your plan ended ${ended}, and today is the last day of your grace period — renew at the front desk to keep training.`,
        primaryCta: CHECK_IN,
        secondaryCta: RENEW,
        ring: null,
        untilLabel: `Ended ${ended}`,
      };
    }

    case 'DAY_PASS_VALID':
      return {
        tone: 'ok',
        badge: 'Day pass · Today',
        line: 'Your day pass is valid until closing today.',
        primaryCta: CHECK_IN,
        secondaryCta: CHOOSE_PLAN,
        ring: null,
        untilLabel: null,
      };

    case null:
      break;
  }

  const reason = verdict.denialReason;
  switch (reason) {
    case DenialReason.NO_MEMBERSHIP:
      return refused(
        'neutral',
        'No active plan',
        denialMemberCopy(reason, null),
        CHOOSE_PLAN,
        null,
      );

    case DenialReason.MEMBERSHIP_EXPIRED:
      return refused(
        'danger',
        `${plan ?? 'Plan'} · Expired`,
        denialMemberCopy(reason, relevant),
        RENEW,
        relevant === null ? null : `Ended ${relevant}`,
      );

    case DenialReason.MEMBERSHIP_FROZEN:
      return refused(
        'neutral',
        `${plan ?? 'Plan'} · Paused`,
        denialMemberCopy(reason, relevant),
        VIEW_PLAN,
        relevant === null ? null : `Paused until ${relevant}`,
      );

    case DenialReason.MEMBERSHIP_CANCELLED:
      return refused(
        'neutral',
        `${plan ?? 'Plan'} · Ended`,
        denialMemberCopy(reason, relevant),
        CHOOSE_PLAN,
        null,
      );

    default:
      // ACCOUNT_SUSPENDED, ACCOUNT_DEACTIVATED and anything else: vague on
      // purpose, and never enriched — no plan, no reason, no date.
      return refused(
        'neutral',
        'See the front desk',
        reason === null ? null : DENIAL_MEMBER_COPY[reason],
        null,
        null,
      );
  }
}

function refused(
  tone: StatusTone,
  badge: string,
  line: string | null,
  primaryCta: StatusCta | null,
  untilLabel: string | null,
): MembershipStatusView {
  return { tone, badge, line, primaryCta, secondaryCta: null, ring: null, untilLabel };
}

const SELF_SERVICE_PATH = '/portal/subscription';

/**
 * The status band for someone who cannot manage a plan themselves.
 *
 * My Subscription is behind `membership.self`, which only CLIENT holds, so a
 * coach or staff member following "Renew" or "Choose a plan" would land on the
 * "not available for your role" card. Those buttons go; any other button moves
 * up to take the primary slot.
 */
export function withoutSelfService(
  view: MembershipStatusView,
  canSelfServe: boolean,
): MembershipStatusView {
  if (canSelfServe) return view;
  const keep = [view.primaryCta, view.secondaryCta].filter(
    (cta): cta is StatusCta => cta !== null && cta.href !== SELF_SERVICE_PATH,
  );
  return { ...view, primaryCta: keep[0] ?? null, secondaryCta: keep[1] ?? null };
}
