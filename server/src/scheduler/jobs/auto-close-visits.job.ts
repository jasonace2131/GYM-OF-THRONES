import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GymConfigService } from '../../config/gym.config';
import { OpeningHoursService, type DayHours } from '../../config/opening-hours.service';
import { SystemNotificationsService } from '../../notifications/system-notifications.service';
import { GYM_HOURS_BUFFER_MINUTES } from '../../checkin/gym-hours';
import {
  civilDateFromPrisma,
  zonedTimeToInstant,
  type CivilDate,
} from '../../common/time/gym-time';
import type { ScheduledJob } from '../scheduler.service';

/** One run never reads more than this; the next tick picks up the rest. */
const BATCH = 2000;

/** What `planAutoClose` needs from a visit. */
export interface OpenVisitRow {
  id: string;
  businessDate: Date;
  occurredAt: Date;
}

export interface AutoCloseDecision {
  id: string;
  endedAt: Date;
}

/**
 * The instant a business day's doors shut.
 *
 * The day's own row in `OpeningHours` (via `OpeningHoursService.week()`,
 * which already falls back to `GYM_CLOSE_TIME` per missing day and for an
 * unreadable table), and the environment close time if the week somehow has
 * no row for that weekday at all. A day marked closed still carries times;
 * a visit somebody recorded on it is closed at that stored time.
 */
export function closingInstantFor(
  day: CivilDate,
  week: DayHours[],
  timeZone: string,
  envCloseTime: string,
): Date {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  const hours = week.find((candidate) => candidate.dayOfWeek === weekday);
  return zonedTimeToInstant(day, hours?.closesAt ?? envCloseTime, timeZone);
}

/**
 * Which open visits to close now, and at what instant — the pure half of
 * the job.
 *
 * A visit is closed once its OWN business day's closing time plus the same
 * fifteen minutes of slack the door gate allows has passed: the last member
 * walking out at 22:05 is not an incident, and the job must not beat them to
 * the door. It is stamped as having ended AT closing time, not when the job
 * happened to run — and never before it began, for a desk entry recorded
 * inside the slack.
 */
export function planAutoClose(
  rows: OpenVisitRow[],
  week: DayHours[],
  timeZone: string,
  envCloseTime: string,
  now: Date,
): AutoCloseDecision[] {
  const bufferMs = GYM_HOURS_BUFFER_MINUTES * 60_000;
  const closingByDay = new Map<string, Date>();

  return rows.flatMap((row) => {
    const day = civilDateFromPrisma(row.businessDate);
    let closesAt = closingByDay.get(day);
    if (closesAt === undefined) {
      closesAt = closingInstantFor(day, week, timeZone, envCloseTime);
      closingByDay.set(day, closesAt);
    }

    if (now.getTime() < closesAt.getTime() + bufferMs) return [];
    const endedAt = row.occurredAt.getTime() > closesAt.getTime() ? row.occurredAt : closesAt;
    return [{ id: row.id, endedAt }];
  });
}

/**
 * Closes every visit still open after the gym has shut.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: A WALK-IN GUEST'S VISIT NEVER CLOSED.
 *
 * A member's forgotten check-out is closed by the stale-visit rule the next
 * time THEY scan (`STALE_CLOSE`). A walk-in guest has no account and never
 * scans again, so their visit stayed open forever — and nothing in the system
 * wrote `AUTO_CLOSE`, the close method reserved for exactly this since the
 * attendance schema shipped. This job is that writer: every open visit,
 * member or guest, is closed as `AUTO_CLOSE` at its business day's closing
 * time.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Runs every fifteen minutes rather than once a night because closing time is
 * per weekday and editable (`OpeningHours`), and a fixed nightly cron would
 * either fire before a late close or leave the board wrong for hours after an
 * early one. A run with nothing past its close writes nothing.
 *
 * IDEMPOTENT BY CONSTRUCTION, like the other jobs: each write is guarded on
 * `endedAt IS NULL AND voidedAt IS NULL`, which its own effect falsifies, so a
 * repeat run, an overlapping run, or a run after downtime all converge on the
 * same rows — and a staff check-out that lands between this job's read and its
 * write always wins.
 *
 * AUDITED the way the jobs are: one log line per run that did something, a
 * notice on the console board when visits were closed (the desk learns who it
 * forgot to check out), and a CRITICAL notice if the run throws. Each row
 * records itself — `closeMethod = AUTO_CLOSE`, `autoClosed = true`, which also
 * keeps it out of every duration statistic.
 */
@Injectable()
export class AutoCloseVisitsJob implements ScheduledJob {
  readonly name = 'autoCloseVisits';
  readonly cronExpression = '*/15 * * * *';

  private readonly logger = new Logger(AutoCloseVisitsJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly hours: OpeningHoursService,
    private readonly notifications: SystemNotificationsService,
  ) {}

  async run(): Promise<void> {
    const now = new Date();

    let result: { matched: number; closed: number };
    try {
      result = await this.runAt(now);
    } catch (caught) {
      await this.notifications.raise({
        kind: 'NIGHTLY_JOB_FAILED',
        severity: 'CRITICAL',
        title: 'Closing-time check-out failed',
        // The message, never the stack — this renders at a counter.
        body:
          `${caught instanceof Error ? caught.message : String(caught)} — visits still open ` +
          `after closing were not checked out. They stay on "In the gym now" until the next ` +
          `run succeeds or somebody checks them out by hand.`,
        linkPath: '/admin/attendance',
        subjectType: 'AutoCloseVisitsJob',
      });
      // Re-thrown so SchedulerService still logs it with a stack.
      throw caught;
    }

    if (result.closed === 0) return;

    await this.notifications.raise({
      kind: 'NIGHTLY_JOB',
      severity: 'INFO',
      title:
        `${result.closed} ${result.closed === 1 ? 'visit' : 'visits'} still open at closing ` +
        `${result.closed === 1 ? 'was' : 'were'} checked out automatically`,
      body:
        'Walk-in guests and members who did not check out were closed at the gym’s closing ' +
        'time. Their visits are kept but left out of session-length figures.',
      linkPath: '/admin/walk-ins',
      subjectType: 'AutoCloseVisitsJob',
    });
  }

  /** One pass at `now`. Returns what it read and what it actually closed. */
  async runAt(now: Date): Promise<{ matched: number; closed: number }> {
    const open = await this.prisma.checkIn.findMany({
      where: { endedAt: null, voidedAt: null },
      select: { id: true, businessDate: true, occurredAt: true },
      orderBy: [{ businessDate: 'asc' }, { occurredAt: 'asc' }],
      take: BATCH,
    });
    if (open.length === 0) return { matched: 0, closed: 0 };

    const week = await this.hours.week();
    const plan = planAutoClose(open, week, this.gym.timeZone, this.gym.closeTime, now);
    if (plan.length === 0) return { matched: 0, closed: 0 };

    // One statement per distinct closing instant — normally one per business
    // day — rather than one per visit.
    const byInstant = new Map<number, string[]>();
    for (const decision of plan) {
      const key = decision.endedAt.getTime();
      byInstant.set(key, [...(byInstant.get(key) ?? []), decision.id]);
    }

    let closed = 0;
    for (const [instant, ids] of byInstant) {
      const { count } = await this.prisma.checkIn.updateMany({
        where: { id: { in: ids }, endedAt: null, voidedAt: null },
        data: {
          endedAt: new Date(instant),
          closeMethod: 'AUTO_CLOSE',
          // `CheckIn_autoclosed_agrees` ties the flag to the method, and
          // `CheckIn_open_marker_agrees` ties the sentinel to `endedAt` — all
          // three move in this one statement.
          autoClosed: true,
          openUserId: null,
        },
      });
      closed += count;
    }

    this.logger.log(
      `job=${this.name} at=${now.toISOString()} matched=${plan.length} closed=${closed} ` +
        `instants=${byInstant.size}`,
    );
    return { matched: plan.length, closed };
  }
}
