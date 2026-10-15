import type { UserStatus } from '@prisma/client';
import { AccessVerdict, DenialReason, MembershipStatus } from '@got/shared';
import type { AccessDecision, AllowReason } from '@got/shared';
import { addDays, civilDaysBetween, shortDate } from '../common/time/gym-time';
import type { CivilDate } from '../common/time/gym-time';

/**
 * The door ladder. First match wins.
 *
 * PURE: no clock, no database, no config read. `graceDays` is a column on the
 * snapshot, not an env lookup, so the bound exists from the moment the
 * membership is sold rather than from the moment a job notices it lapsed.
 * MembershipService.verdictFor(userId, now) does the loading; this does the
 * deciding — the same split as PermissionsService / PermissionsGuard.
 *
 * R1: dates are the authority and stored status is a materialised convenience.
 * This function never trusts Membership.status alone; step 0 recomputes an
 * effective status from endsOn, cancelRequestedOn and the hold window on every
 * call, which is what makes "the scheduler was down for three days" a boring
 * incident.
 *
 * Staff are NOT special: there is deliberately no `if (role !== CLIENT) return
 * ALLOW`. A coach who trains here gets a comped membership on a ₱0
 * STAFF-discounted payment.
 */

export interface MembershipSnapshot {
  status: MembershipStatus;
  startsOn: CivilDate;
  endsOn: CivilDate;
  graceDays: number;
  graceAdmissionsThisTerm: number;
  cancelRequestedOn: CivilDate | null;
  planName: string;
  planPriceCentavos: number;
  /** The running hold's window, when status === FROZEN. */
  hold: { startsOn: CivilDate; endsOn: CivilDate } | null;
}

export interface AccessSubject {
  userStatus: UserStatus;
  membership: MembershipSnapshot | null;
  /**
   * Chunk 2 resolves this from a WALK_IN CheckIn on the current gym-local
   * business date. A boolean, so this file has no dependency on the attendance
   * schema — and so nobody "restores" the DayPass table the name implies.
   */
  dayPassValidToday: boolean;
}

export interface AccessResult {
  decision: AccessDecision;
  /** Which stored verdict chunk 2 writes on the CheckIn. Null when DENY. */
  verdict: AccessVerdict | null;
  allowReason: AllowReason | null;
  denialReason: DenialReason | null;
  /**
   * One sentence, composed server-side, so every surface stays dumb. Always
   * carries the date or count the staffer needs and always ends in an
   * instruction. It carries NO peso figure: no response body anywhere holds a
   * formatted currency string, and the console renders the price itself from
   * the integer centavos it already has.
   */
  message: string;
  relevantDate: CivilDate | null;
  /** Days left in the term. Clamped to >= 0. Null when there is no term. */
  daysRemaining: number | null;
  /** Days of grace left. 0 unless allowReason === 'MEMBERSHIP_IN_GRACE'. */
  graceDaysRemaining: number;
  offer: 'NONE' | 'RENEW' | 'UNFREEZE' | 'OVERRIDE' | 'MANAGER';
}

export interface AccessVerdictConfig {
  expiringSoonDays: number;
  graceAdmissionsMax: number;
}

function days(n: number): string {
  return `${n} day${n === 1 ? '' : 's'}`;
}

/**
 * Step 0 — the two self-heals for a nightly job that has not run.
 *
 * Exported for booking-eligibility.ts, which asks the same question about a
 * class day instead of today: reusing it is what keeps the door and the
 * timetable agreeing about a frozen member whose hold has ended, or a leaver
 * whose term has run out, while the 03:15 job is late. `today` is any gym day;
 * nothing here assumes it is the current one.
 *
 * It heals only those two. EXPIRED and CANCELLED are never revived here, and a
 * SCHEDULED hold is never applied — that is the booking projection's job, and
 * deliberately not the door's.
 */
export function effectiveStatus(m: MembershipSnapshot, today: CivilDate): MembershipStatus {
  if (m.status === MembershipStatus.FROZEN && m.hold !== null && today > m.hold.endsOn) {
    return MembershipStatus.ACTIVE;
  }
  if (m.status === MembershipStatus.ACTIVE && m.cancelRequestedOn !== null && today > m.endsOn) {
    return MembershipStatus.CANCELLED;
  }
  return m.status;
}

export function accessVerdict(
  subject: AccessSubject,
  today: CivilDate,
  cfg: AccessVerdictConfig,
): AccessResult {
  const m = subject.membership;
  const remaining = m === null ? 0 : Math.max(0, civilDaysBetween(today, m.endsOn));
  const daysRemaining = m === null ? null : remaining;

  const deny = (
    denialReason: DenialReason,
    message: string,
    offer: AccessResult['offer'],
    relevantDate: CivilDate | null,
  ): AccessResult => ({
    decision: 'DENY',
    verdict: null,
    allowReason: null,
    denialReason,
    message,
    relevantDate,
    daysRemaining,
    graceDaysRemaining: 0,
    offer,
  });

  const allow = (
    allowReason: AllowReason,
    message: string,
    offer: AccessResult['offer'],
    relevantDate: CivilDate | null,
  ): AccessResult => ({
    decision: 'ALLOW',
    verdict: AccessVerdict.ALLOWED,
    allowReason,
    denialReason: null,
    message,
    relevantDate,
    daysRemaining,
    graceDaysRemaining: 0,
    offer,
  });

  // 1-2. Account gates are absolute and sit above the day-pass check, so an
  // entitlement can never override a closed account — and the walk-in sale
  // endpoint runs this same ladder, so one cannot be sold to a closed account.
  if (subject.userStatus === 'SUSPENDED') {
    return deny(
      DenialReason.ACCOUNT_SUSPENDED,
      'This account is suspended. Do not let them in — get a manager.',
      'MANAGER',
      null,
    );
  }
  if (subject.userStatus === 'DEACTIVATED') {
    return deny(
      DenialReason.ACCOUNT_DEACTIVATED,
      'This account is deactivated. Do not let them in — get a manager.',
      'MANAGER',
      null,
    );
  }

  const effective = m === null ? null : effectiveStatus(m, today);

  // 3. Inside a running term.
  if (m !== null && effective === MembershipStatus.ACTIVE && today <= m.endsOn) {
    if (m.cancelRequestedOn !== null) {
      return allow(
        'MEMBERSHIP_ENDING',
        `${m.planName} — cancelling on ${shortDate(m.endsOn)}. Let them in.`,
        'NONE',
        m.endsOn,
      );
    }
    if (today === m.endsOn) {
      return allow(
        'MEMBERSHIP_EXPIRES_TODAY',
        `${m.planName} — last day. Let them in, and ask if they want to renew today.`,
        'RENEW',
        m.endsOn,
      );
    }
    if (remaining <= cfg.expiringSoonDays) {
      return allow(
        'MEMBERSHIP_EXPIRING_SOON',
        `${m.planName} — ${days(remaining)} left, ends ${shortDate(m.endsOn)}. Let them in; ask about renewing.`,
        'RENEW',
        m.endsOn,
      );
    }
    return allow(
      'MEMBERSHIP_ACTIVE',
      `${m.planName} — active until ${shortDate(m.endsOn)} (${days(remaining)} left). Let them in.`,
      'NONE',
      m.endsOn,
    );
  }

  // 4. Grace. ACTIVE is included on purpose: it is the window before the
  // nightly job has run. Grace is finite because graceDays lives on the row,
  // whether or not that job ever runs again.
  if (
    m !== null &&
    (effective === MembershipStatus.ACTIVE || effective === MembershipStatus.EXPIRED) &&
    m.cancelRequestedOn === null
  ) {
    const graceEnd = addDays(m.endsOn, m.graceDays);
    if (today <= graceEnd && m.graceAdmissionsThisTerm < cfg.graceAdmissionsMax) {
      const graceDaysRemaining = civilDaysBetween(today, graceEnd);
      const left = cfg.graceAdmissionsMax - m.graceAdmissionsThisTerm;
      return {
        decision: 'GRACE',
        verdict: AccessVerdict.ALLOWED_IN_GRACE,
        allowReason: 'MEMBERSHIP_IN_GRACE',
        denialReason: null,
        message: `Ended ${shortDate(m.endsOn)}. Grace — ${left} of ${cfg.graceAdmissionsMax} admissions left, ${days(graceDaysRemaining)} remaining. Let them in and collect the renewal.`,
        relevantDate: m.endsOn,
        daysRemaining,
        graceDaysRemaining,
        offer: 'RENEW',
      };
    }
    // Grace exhausted or expired: deliberately FALL THROUGH rather than
    // returning here. Step 8 below produces the identical DENY
    // MEMBERSHIP_EXPIRED / offer RENEW, and falling through keeps the day-pass
    // check above every membership denial — which is the whole reason rule 5
    // exists: it stops the desk double-charging someone who already paid for
    // today.
  }

  // 5. An entitlement already paid for beats any membership state below it.
  if (subject.dayPassValidToday) {
    return allow(
      'DAY_PASS_VALID',
      'Day pass for today — already paid. Let them in.',
      'NONE',
      today,
    );
  }

  if (m !== null) {
    // 6.
    if (effective === MembershipStatus.FROZEN) {
      const until = m.hold === null ? null : m.hold.endsOn;
      return deny(
        DenialReason.MEMBERSHIP_FROZEN,
        until === null
          ? 'Frozen. Sell a walk-in, or a manager can end the freeze early.'
          : `Frozen until ${shortDate(until)}. Sell a walk-in, or a manager can end the freeze early.`,
        'OVERRIDE',
        until ?? m.endsOn,
      );
    }
    // 7.
    if (effective === MembershipStatus.CANCELLED) {
      return deny(
        DenialReason.MEMBERSHIP_CANCELLED,
        `Cancelled — the term ended ${shortDate(m.endsOn)}. Start a new plan, or sell a walk-in.`,
        'RENEW',
        m.endsOn,
      );
    }
    // 8.
    return deny(
      DenialReason.MEMBERSHIP_EXPIRED,
      `Ended ${shortDate(m.endsOn)}, grace is over. Renew, or sell a walk-in.`,
      'RENEW',
      m.endsOn,
    );
  }

  // 9.
  return deny(
    DenialReason.NO_MEMBERSHIP,
    'No plan on file. Sell a walk-in, or sign them up.',
    'RENEW',
    null,
  );
}
