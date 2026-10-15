import type { UserStatus } from '@prisma/client';
import { DenialReason, MembershipStatus } from '@got/shared';
import { addDays } from '../common/time/gym-time';
import type { CivilDate } from '../common/time/gym-time';
import { effectiveStatus } from './access-verdict';
import type { MembershipSnapshot } from './access-verdict';

/**
 * May this member book a class on `classDay`. First match wins.
 *
 * Owner, 2026-10-11: a member may book a class, or join its waitlist, only if
 * their plan is active ON THE CLASS DAY. Grace days and day passes do not
 * count, and a suspended or deactivated account is refused outright.
 *
 * PURE, like access-verdict.ts beside it: no clock, no database, no config.
 * `classDay` is the session's gym-local `businessDate`, an argument; the
 * loading lives in MembershipService.loadBookingSubject(s). The same split as
 * accessVerdict / verdictFor, and the same purity spec guards it.
 *
 * In one sentence: eligible exactly when the door would ALLOW the member on
 * `classDay` as somebody inside their term — not on grace, not on a day pass —
 * with the freezes already booked applied the way the nightly job will apply
 * them. Running accessVerdict on a later day is NOT the same question, for
 * three reasons:
 *   - SCHEDULED holds. The door ignores one until the job activates it
 *     (access-verdict.spec, "does NOT honour a SCHEDULED hold"), because at
 *     the counter its days have not been credited yet. A class is days or
 *     weeks ahead: a class inside a booked freeze is refused, and every freeze
 *     that starts within the term pushes its end out by its length, which is
 *     exactly what activation will write to endsOn.
 *   - Grace and the day pass, which the owner excluded. Grace is a door
 *     courtesy bounded by admissions a booking never consumes, and a day pass
 *     is a walk-in for today only.
 *   - The desk's message, which is staff copy ("Let them in"). This returns a
 *     reason and a date; the member's sentence is `bookingRefusalCopy`.
 *
 * Never tests `startsOn`. An early renewal moves it to the first day of the
 * NEXT term while the member is still inside the current one (planTerm's
 * RENEWAL_BEFORE_EXPIRY), so `classDay >= startsOn` would refuse a member
 * half-way through a term they have paid for. The door never reads it either.
 */

/** A booked freeze that has not started yet (MembershipHold, status SCHEDULED). */
export interface ScheduledHold {
  /** First frozen day, inclusive. */
  startsOn: CivilDate;
  /** Last frozen day, inclusive. */
  endsOn: CivilDate;
  /**
   * What activation will add to Membership.endsOn (`holdStartDelta`). Read as
   * stored, never recomputed from the window, so the projection adds exactly
   * what the nightly job will.
   */
  daysRequested: number;
}

export interface BookingSubject {
  userStatus: UserStatus;
  /**
   * The membership as the DOOR sees it: `hold` is the running hold only,
   * exactly as toMembershipSnapshot builds it for accessVerdict.
   */
  membership: MembershipSnapshot | null;
  /**
   * Every SCHEDULED hold on the membership, in any order; empty without one.
   *
   * Loaded by STATUS, never by window: an early release marks a hold
   * COMPLETED and leaves its endsOn where it was, so a released hold's window
   * can still cover days that are no longer frozen. There can be more than
   * one: a term's single freeze is counted when a hold activates, not when it
   * is booked.
   */
  scheduledHolds: readonly ScheduledHold[];
  /**
   * Membership.planCode — the immutable code snapshotted at sale, which picks
   * the booking window (`bookingWindowDaysFor`). Null without a membership.
   * The ladder never reads it: how far ahead is a separate question from
   * whether at all.
   */
  planCode: string | null;
}

export interface BookingEligibility {
  eligible: boolean;
  /**
   * Why not; null when eligible. Phrase it for the member with
   * `bookingRefusalCopy`, never with the door's AccessResult.message.
   */
  reason: DenialReason | null;
  /**
   * The day the refusal is about, for the member copy and the error details:
   *   - MEMBERSHIP_FROZEN — the last day of the pause covering the class
   *     (through any freeze that follows it without a gap); null when the
   *     running hold's row is missing and nothing says when it thaws.
   *   - MEMBERSHIP_EXPIRED / MEMBERSHIP_CANCELLED — the last day the plan
   *     covers, when the class falls after it. Null when the plan has ended
   *     outright: a CANCELLED row, or an EXPIRED one whose old end date is not
   *     before the class.
   *   - every other reason, and an eligible result — null.
   * It may lie in the past. Only the caller knows today, so the caller names
   * it in the copy only while it is today or later (`bookingRefusalCopy`).
   */
  relevantDate: CivilDate | null;
  /**
   * The last day this membership lets its holder book: its end date,
   * projected through the freezes already booked — what Membership.endsOn will
   * read once the job has applied them. Freezes inside it are still refused
   * day by day, and the account gates still apply.
   *
   * Null when it lets them book no day at all: no membership, an EXPIRED or
   * CANCELLED one, or one FROZEN with no running hold on file to say when it
   * thaws. A termination leaves endsOn behind as history ("what did they pay
   * for"), not as cover, which is why a CANCELLED row is null rather than its
   * endsOn.
   *
   * The same whatever `classDay` is asked about: it describes the plan, not
   * the class. An ACTIVE row the nightly job has not yet expired reports its
   * end date even once that is behind today.
   */
  coversUntil: CivilDate | null;
}

interface Refusal {
  reason: DenialReason;
  relevantDate: CivilDate | null;
}

/**
 * The ladder: the account gates, then whether there is a plan at all, then the
 * plan as it will stand ON `classDay` (refusalOnClassDay). First match wins.
 *
 * `classDay` is the session's gym-local `businessDate` — never its start
 * instant, which for a 06:00 Manila class is the previous UTC day.
 */
export function bookingEligibility(
  subject: BookingSubject,
  classDay: CivilDate,
): BookingEligibility {
  const m = subject.membership;
  // Sorted once here, so neither the loader's order nor a caller's can change
  // an answer.
  const holds = [...subject.scheduledHolds].sort(byStartsOn);
  const coversUntil = m === null ? null : coverEndsOn(m, holds);

  const refuse = (reason: DenialReason, relevantDate: CivilDate | null): BookingEligibility => ({
    eligible: false,
    reason,
    relevantDate,
    coversUntil,
  });

  // 1-2. Account gates, above everything, as at the door. The reason stays
  // vague in the copy (§9.5): why an account has a note is between the member
  // and management.
  if (subject.userStatus === 'SUSPENDED') return refuse(DenialReason.ACCOUNT_SUSPENDED, null);
  if (subject.userStatus === 'DEACTIVATED') return refuse(DenialReason.ACCOUNT_DEACTIVATED, null);

  // 3.
  if (m === null) return refuse(DenialReason.NO_MEMBERSHIP, null);

  // 4-9.
  const refusal = refusalOnClassDay(m, holds, classDay);
  return refusal === null
    ? { eligible: true, reason: null, relevantDate: null, coversUntil }
    : refuse(refusal.reason, refusal.relevantDate);
}

/**
 * The membership half of the ladder, on the class day.
 *
 * A switch with no default, over every MembershipStatus: the return type is
 * not undefined, so a fifth status is a compile error (TS2366) here rather
 * than silently falling into one of the branches below.
 */
function refusalOnClassDay(
  m: MembershipSnapshot,
  holds: readonly ScheduledHold[],
  classDay: CivilDate,
): Refusal | null {
  const projectedEnd = projectedEndsOn(m.endsOn, holds);

  // R1, as at the door: the stored status is a convenience, so the door's two
  // self-heals are re-run — judged on the class day, and against the
  // PROJECTED end. The projection matters for a leaver: notice given, a freeze
  // booked inside the term, and the job will push their last day out by the
  // freeze's length before it ever closes the term. The stored endsOn would
  // turn them away from classes they have paid for.
  switch (effectiveStatus({ ...m, endsOn: projectedEnd }, classDay)) {
    case MembershipStatus.ACTIVE: {
      // 4. A booked freeze covering the class day. Only SCHEDULED holds are
      // asked: on an effectively ACTIVE row the running hold has either ended
      // before the class (the FROZEN self-heal) or belongs to a row a manager
      // corrected to ACTIVE by hand, which the door admits — so does this.
      const pause = holds.find((hold) => hold.startsOn <= classDay && classDay <= hold.endsOn);
      if (pause !== undefined) {
        return {
          reason: DenialReason.MEMBERSHIP_FROZEN,
          relevantDate: pauseEndsOn(pause.endsOn, holds),
        };
      }
      // 5. Inside the projected term: eligible.
      if (classDay <= projectedEnd) return null;
      // 6. After it. Notice given means a new plan, not a renewal, so the
      // reason says so. (Notice on a row still stored ACTIVE never arrives
      // here — the CANCELLED self-heal caught it — but a FROZEN row under
      // notice heals to ACTIVE first and does.)
      return {
        reason:
          m.cancelRequestedOn === null
            ? DenialReason.MEMBERSHIP_EXPIRED
            : DenialReason.MEMBERSHIP_CANCELLED,
        relevantDate: projectedEnd,
      };
    }

    case MembershipStatus.FROZEN:
      // 7. The running hold still covers the class day. With its row missing
      // nothing says when it thaws, so no date — the door says a plain
      // "Frozen." for the same row.
      return {
        reason: DenialReason.MEMBERSHIP_FROZEN,
        relevantDate: m.hold === null ? null : pauseEndsOn(m.hold.endsOn, holds),
      };

    case MembershipStatus.CANCELLED:
      // 8. Two roads here. A row STORED as cancelled was terminated, or closed
      // under notice by the job: the plan has ended, and a termination leaves
      // endsOn behind as history, not cover — so no date ("Your plan has
      // ended"). Otherwise it is the self-heal: notice given, and the class
      // falls after the last day the plan covers.
      return {
        reason: DenialReason.MEMBERSHIP_CANCELLED,
        relevantDate: m.status === MembershipStatus.CANCELLED ? null : projectedEnd,
      };

    case MembershipStatus.EXPIRED:
      // 9. Never bookable, whatever endsOn says. The door admits an EXPIRED
      // row only on grace or a day pass, neither of which counts for a
      // booking, and nothing but a sale revives one. Its endsOn can still lie
      // ahead — comp days on a lapsed membership move the date and leave the
      // status (route 29) — and then "ends {date}, before this class" would be
      // false, so the date is named only when the class falls after it.
      return {
        reason: DenialReason.MEMBERSHIP_EXPIRED,
        relevantDate: classDay > m.endsOn ? m.endsOn : null,
      };
  }
}

/**
 * Where the term will end once the booked freezes have been applied.
 *
 * Each freeze that starts on or before the running end adds its length, in
 * start order — the order the nightly job activates them in. A freeze that
 * starts after the term has run out adds no day anyone can book: activation
 * would stretch endsOn across (at most) its own frozen window and no further.
 * Such a hold should not exist, but nothing stops staff booking one past the
 * term's end today.
 *
 * Equivalent, on every day that is not itself frozen, to the per-day reading
 * "endsOn plus the freezes starting on or before that day"
 * (booking-eligibility.spec proves it over a grid). Computed once rather than
 * per day so the end date the member is told is the one the plan really has.
 */
function projectedEndsOn(endsOn: CivilDate, holds: readonly ScheduledHold[]): CivilDate {
  let end = endsOn;
  for (const hold of holds) {
    if (hold.startsOn > end) break;
    end = addDays(end, hold.daysRequested);
  }
  return end;
}

/**
 * `coversUntil`, by STORED status: it describes the plan, never one day. A
 * switch with no default for the same reason as above.
 */
function coverEndsOn(m: MembershipSnapshot, holds: readonly ScheduledHold[]): CivilDate | null {
  switch (m.status) {
    case MembershipStatus.ACTIVE:
      return projectedEndsOn(m.endsOn, holds);
    case MembershipStatus.FROZEN:
      // It thaws when the running hold ends; endsOn already carries that
      // hold's days. Without the hold's row, no day is ever bookable.
      return m.hold === null ? null : projectedEndsOn(m.endsOn, holds);
    case MembershipStatus.EXPIRED:
    case MembershipStatus.CANCELLED:
      return null;
  }
}

/**
 * The last day of a pause, carried through any freeze that starts the very
 * next day, so a member frozen back-to-back is told when they are actually
 * back rather than the first of two dates.
 */
function pauseEndsOn(endsOn: CivilDate, holds: readonly ScheduledHold[]): CivilDate {
  let end = endsOn;
  for (const hold of holds) {
    if (hold.startsOn === addDays(end, 1)) end = hold.endsOn;
  }
  return end;
}

/** Civil dates compare as plain yyyy-mm-dd strings (gym-time.ts). */
function byStartsOn(a: ScheduledHold, b: ScheduledHold): number {
  if (a.startsOn === b.startsOn) return 0;
  return a.startsOn < b.startsOn ? -1 : 1;
}
