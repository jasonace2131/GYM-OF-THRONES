import { Inject, Injectable, Logger } from '@nestjs/common';
import { HoldStatus, MembershipEventType, MembershipStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import {
  addDays,
  civilDateFromPrisma,
  civilDaysBetween,
  gymToday,
  toDateColumn,
  type CivilDate,
} from '../common/time/gym-time';
import type { ScheduledJob } from '../scheduler/scheduler.service';
import { MembershipHoldsService } from './membership-holds.service';
import { writeMembershipEvent } from './membership-events';
import { termEndsOn } from './membership-terms';
import { ReportsService } from '../payments/reports.service';
import { SUMMARY_TRANSPORT, type SummaryTransport } from '../payments/summary-transport';
import { SystemNotificationsService } from '../notifications/system-notifications.service';

export interface NightlyStepResult {
  step:
    | 'completeFinishedHolds'
    | 'activateScheduledHolds'
    | 'closeTermsUnderNotice'
    | 'expireLapsedTerms'
    | 'reconcileHoldArithmetic'
    | 'emitOwnerSummary';
  matched: number;
  changed: number;
  note: string | null;
}

export interface NightlyRunResult {
  runFor: CivilDate;
  steps: NightlyStepResult[];
}

/**
 * §5.9. 03:15 gym-local: after close, well before the 05:00 rush, off the top of
 * the hour. An optimiser, never a gatekeeper — accessVerdict recomputes from
 * dates, so three missed nights break nothing at the door (§5.9.3).
 *
 * Idempotent structurally, not by convention: every step is a conditional UPDATE
 * whose WHERE clause its own effect falsifies, and the single increment in the
 * whole job (endsOn += daysRequested) is guarded by the SCHEDULED → ACTIVE flip
 * inside MembershipHoldsService.activateHoldInTx. The job calls those helpers
 * rather than copying the arithmetic.
 */
@Injectable()
export class MembershipNightlyJob implements ScheduledJob {
  readonly name = 'membershipNightly';
  readonly cronExpression = '15 3 * * *';

  private readonly logger = new Logger(MembershipNightlyJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly holds: MembershipHoldsService,
    private readonly reports: ReportsService,
    @Inject(SUMMARY_TRANSPORT) private readonly summary: SummaryTransport,
    private readonly notifications: SystemNotificationsService,
  ) {}

  /**
   * The scheduled entry point. `runFor` is the one an operator calls by hand
   * from `POST /admin/jobs/nightly`, and it stays free of notification
   * side-effects so a catch-up replay of four missed nights does not fill the
   * console board with four notices about work nobody was waiting on.
   *
   * A THROW HERE IS THE ONE THING NOBODY WOULD OTHERWISE SEE.
   * `SchedulerService.fire` catches and logs so a failed job cannot take the
   * process down, which is right — but a log line at 03:15 is read by nobody.
   * The board is where a person looks.
   */
  async run(): Promise<void> {
    const now = new Date();
    const today = gymToday(now, this.gym.timeZone);

    let result: NightlyRunResult;
    try {
      result = await this.runFor(today, now);
    } catch (caught) {
      await this.notifications.raise({
        kind: 'NIGHTLY_JOB_FAILED',
        severity: 'CRITICAL',
        title: `The nightly membership job failed for ${today}`,
        // The message, never the stack: this renders at a counter. The stack
        // is already in the log, which is where somebody debugging will look.
        body:
          `${caught instanceof Error ? caught.message : String(caught)} — memberships were not ` +
          `rolled over. The door still decides from dates, so nobody is wrongly ` +
          `denied, but expiries will look a day stale until this is re-run.`,
        linkPath: '/admin/settings',
        subjectType: 'MembershipNightlyJob',
      });
      // Re-thrown so SchedulerService still logs it with a stack. The board is
      // an addition to that boundary, not a replacement for it.
      throw caught;
    }

    const changed = result.steps.reduce((total, step) => total + step.changed, 0);
    // Silence when nothing happened. A gym with no expiries this week does not
    // need six identical "nothing to do" notices by Saturday — a board that
    // fills with noise is a board staff stop opening.
    if (changed === 0) return;

    await this.notifications.raise({
      kind: 'NIGHTLY_JOB',
      severity: 'INFO',
      title: `${changed} membership ${changed === 1 ? 'change' : 'changes'} overnight`,
      body: result.steps
        .filter((step) => step.changed > 0)
        .map((step) => `${step.step}: ${step.changed} of ${step.matched}`)
        .join(' · '),
      // The roster, in renewal-call order. `/admin/subscriptions` merged into
      // `/admin/members` — rows RAISED BEFORE that merge still carry the old
      // path, which is why `client/next.config.ts` keeps a redirect for it
      // rather than relying on this line alone. `linkPath` is stored text on
      // `SystemNotification`, so changing it here only affects future rows.
      linkPath: '/admin/members?sort=ending',
      subjectType: 'MembershipNightlyJob',
    });
  }

  async runFor(today: CivilDate, now: Date): Promise<NightlyRunResult> {
    const steps: NightlyStepResult[] = [
      // Order is load-bearing (§5.9.1): holds resolve before terms, so a hold
      // ending today and a term ending today cannot interleave — completing the
      // hold first can restore endsOn to a future date before expiry is ever
      // evaluated. Within holds, completion precedes activation so a
      // back-to-back SCHEDULED hold starting the same day a prior ACTIVE hold
      // ends sees a membership that is already un-frozen. Within terms, notice
      // closes before expiry so a leaver under notice is never even briefly
      // EXPIRED (closeTermsUnderNotice claims ACTIVE rows with
      // cancelRequestedOn set, so expireLapsedTerms's ACTIVE + cancelRequestedOn
      // IS NULL predicate can no longer see it).
      await this.completeFinishedHolds(today, now),
      await this.activateScheduledHolds(today, now),
      await this.closeTermsUnderNotice(today, now),
      await this.expireLapsedTerms(today, now),
      await this.reconcileHoldArithmetic(),
      await this.emitOwnerSummary(today),
    ];

    for (const step of steps) {
      this.logger.log(
        `job=${this.name} runFor=${today} step=${step.step} ` +
          `matched=${step.matched} changed=${step.changed}` +
          (step.note ? ` note="${step.note}"` : ''),
      );
    }

    return { runFor: today, steps };
  }

  /**
   * The instant a transition SHOULD have carried, so a catch-up run produces
   * exactly the same event trail as if the job had run each night.
   *
   * Compared against the REAL gym-day derived from `now`, never against the
   * `today` argument `runFor` was called with: a catch-up replay passes a past
   * `today` alongside the real (current) `now`, and `dueDay === today` would
   * then wrongly stamp a days-old transition with this instant's wall-clock
   * time. Only a live nightly run — where the due day and the actual current
   * gym-day coincide — gets the precise timestamp; every backfilled day gets
   * that day's civil midnight instead.
   */
  private effectiveInstant(dueDay: CivilDate, now: Date): Date {
    const realToday = gymToday(now, this.gym.timeZone);
    return dueDay === realToday ? now : toDateColumn(dueDay);
  }

  private async completeFinishedHolds(today: CivilDate, now: Date): Promise<NightlyStepResult> {
    const due = await this.prisma.membershipHold.findMany({
      where: { status: HoldStatus.ACTIVE, endsOn: { lt: toDateColumn(today) } },
      select: { id: true, endsOn: true },
    });

    let changed = 0;
    for (const hold of due) {
      const dueDay = addDays(civilDateFromPrisma(hold.endsOn), 1);
      const effectiveAt = this.effectiveInstant(dueDay, now);
      const applied = await this.prisma.$transaction((tx) =>
        this.holds.completeHoldInTx(tx, hold.id, today, effectiveAt, null),
      );
      if (applied) changed += 1;
    }

    return { step: 'completeFinishedHolds', matched: due.length, changed, note: null };
  }

  private async activateScheduledHolds(today: CivilDate, now: Date): Promise<NightlyStepResult> {
    const due = await this.prisma.membershipHold.findMany({
      where: { status: HoldStatus.SCHEDULED, startsOn: { lte: toDateColumn(today) } },
      select: { id: true, startsOn: true },
    });

    let changed = 0;
    let late = 0;
    for (const hold of due) {
      const dueDay = civilDateFromPrisma(hold.startsOn);
      if (dueDay < today) late += 1;
      const applied = await this.prisma.$transaction((tx) =>
        this.holds.activateHoldInTx(tx, hold.id, today, this.effectiveInstant(dueDay, now), null),
      );
      if (applied) changed += 1;
    }

    return {
      step: 'activateScheduledHolds',
      matched: due.length,
      changed,
      // A late activation is a missed run, and the one place this job's failure
      // has a real (if benign) commercial effect.
      note: late > 0 ? `${late} late activation(s) — a run was missed` : null,
    };
  }

  private async closeTermsUnderNotice(today: CivilDate, now: Date): Promise<NightlyStepResult> {
    const due = await this.prisma.membership.findMany({
      where: {
        status: MembershipStatus.ACTIVE,
        cancelRequestedOn: { not: null },
        endsOn: { lt: toDateColumn(today) },
      },
      select: { id: true, endsOn: true },
    });

    let changed = 0;
    for (const membership of due) {
      const dueDay = addDays(civilDateFromPrisma(membership.endsOn), 1);
      const effectiveAt = this.effectiveInstant(dueDay, now);

      const applied = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.membership.updateMany({
          where: {
            id: membership.id,
            status: MembershipStatus.ACTIVE,
            cancelRequestedOn: { not: null },
            endsOn: { lt: toDateColumn(today) },
          },
          data: { status: MembershipStatus.CANCELLED, cancelledOn: toDateColumn(dueDay) },
        });
        if (claimed.count !== 1) return false;

        await writeMembershipEvent(tx, {
          membershipId: membership.id,
          type: MembershipEventType.CANCELLED,
          fromStatus: MembershipStatus.ACTIVE,
          toStatus: MembershipStatus.CANCELLED,
          previousEndsOn: null,
          newEndsOn: null,
          reason: 'notice',
          actorId: null,
          paymentId: null,
          batchRef: null,
          effectiveAt,
        });
        return true;
      });
      if (applied) changed += 1;
    }

    return { step: 'closeTermsUnderNotice', matched: due.length, changed, note: null };
  }

  private async expireLapsedTerms(today: CivilDate, now: Date): Promise<NightlyStepResult> {
    // FROZEN is deliberately excluded: a membership frozen with two days left
    // sails past its endsOn mid-freeze, and that is correct.
    const due = await this.prisma.membership.findMany({
      where: {
        status: MembershipStatus.ACTIVE,
        cancelRequestedOn: null,
        endsOn: { lt: toDateColumn(today) },
      },
      select: { id: true, endsOn: true },
    });

    let changed = 0;
    for (const membership of due) {
      const dueDay = addDays(civilDateFromPrisma(membership.endsOn), 1);
      const effectiveAt = this.effectiveInstant(dueDay, now);

      const applied = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.membership.updateMany({
          where: {
            id: membership.id,
            status: MembershipStatus.ACTIVE,
            cancelRequestedOn: null,
            endsOn: { lt: toDateColumn(today) },
          },
          data: { status: MembershipStatus.EXPIRED },
        });
        if (claimed.count !== 1) return false;

        await writeMembershipEvent(tx, {
          membershipId: membership.id,
          type: MembershipEventType.EXPIRED,
          fromStatus: MembershipStatus.ACTIVE,
          toStatus: MembershipStatus.EXPIRED,
          previousEndsOn: null,
          newEndsOn: null,
          reason: null,
          actorId: null,
          paymentId: null,
          batchRef: null,
          effectiveAt,
        });
        return true;
      });
      if (applied) changed += 1;
    }

    return { step: 'expireLapsedTerms', matched: due.length, changed, note: null };
  }

  /** Logs mismatches and repairs nothing — a silent repair hides its own cause. */
  private async reconcileHoldArithmetic(): Promise<NightlyStepResult> {
    const rows = await this.prisma.membership.findMany({
      where: { holds: { some: {} } },
      select: {
        id: true,
        billingAnchorDay: true,
        termMonths: true,
        startsOn: true,
        endsOn: true,
        holds: {
          where: { status: { not: HoldStatus.CANCELLED } },
          select: { daysApplied: true },
        },
        events: {
          where: { type: MembershipEventType.ADJUSTED },
          select: { previousEndsOn: true, newEndsOn: true, effectiveAt: true },
        },
      },
    });

    let mismatches = 0;
    for (const row of rows) {
      const startsOn = civilDateFromPrisma(row.startsOn);
      const base = termEndsOn(row.billingAnchorDay, startsOn, row.termMonths);
      const held = row.holds.reduce((sum, hold) => sum + hold.daysApplied, 0);
      const adjusted = row.events
        .filter((event) => event.effectiveAt >= toDateColumn(startsOn))
        .reduce(
          (sum, event) =>
            event.previousEndsOn && event.newEndsOn
              ? sum +
                civilDaysBetween(
                  civilDateFromPrisma(event.previousEndsOn),
                  civilDateFromPrisma(event.newEndsOn),
                )
              : sum,
          0,
        );

      const expected = addDays(base, held + adjusted);
      const actual = civilDateFromPrisma(row.endsOn);
      if (expected !== actual) {
        mismatches += 1;
        this.logger.warn(
          `membership=${row.id} endsOn=${actual} expected=${expected} ` +
            `(term=${base} holdDays=${held} adjustedDays=${adjusted})`,
        );
      }
    }

    return {
      step: 'reconcileHoldArithmetic',
      matched: rows.length,
      changed: 0,
      note: mismatches > 0 ? `${mismatches} mismatch(es) logged, none repaired` : null,
    };
  }

  /**
   * The job runs at 03:15, so the day that just closed is yesterday. Sending
   * fails loudly rather than silently: a missing summary is the de facto
   * monitor for this whole job.
   */
  private async emitOwnerSummary(today: CivilDate): Promise<NightlyStepResult> {
    const businessDate = addDays(today, -1);
    const payload = await this.reports.buildOwnerSummary(businessDate);
    await this.summary.send(payload);

    return {
      step: 'emitOwnerSummary',
      matched: 1,
      changed: 0,
      note: `summary sent for ${businessDate}`,
    };
  }
}
