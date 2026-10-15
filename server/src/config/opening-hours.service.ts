import { Injectable, Logger } from '@nestjs/common';
import type { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { GymConfigService } from './gym.config';

export interface DayHours {
  dayOfWeek: number;
  opensAt: string;
  closesAt: string;
  isClosed: boolean;
}

/** 'HH:mm', 24-hour, and nothing else. Mirrors the SQL CHECK. */
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * A minute is plenty. These change when an owner edits them, which is a few
 * times a year, and the door reads them on every scan at 06:00.
 */
const CACHE_MS = 60_000;

/**
 * The gym's opening hours — database first, environment as the floor.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FALLBACK IS THE WHOLE DESIGN, NOT A DEFENSIVE EXTRA.
 *
 * `settings/page.tsx` argued that hours belong in the environment because
 * `env.validation.ts` crashes the process on a bad value — a loud failure at
 * deploy time, at a keyboard, with a stack trace. Moving them to a table
 * trades that for a silent failure at 06:00 with a queue at the door.
 *
 * So the table OVERRIDES rather than replaces. Every path below degrades to
 * `GYM_OPEN_TIME` / `GYM_CLOSE_TIME`:
 *
 *   - no row for today          → env
 *   - the table is empty        → env
 *   - the query throws          → env, logged
 *   - a malformed time slipped  → env, logged
 *
 * The only way to lock the gym out of itself is to deliberately mark a day
 * closed, which is a decision somebody made on a screen that said so.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class OpeningHoursService {
  private readonly logger = new Logger(OpeningHoursService.name);

  private cache: { at: number; rows: DayHours[] } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly audit: AuditService,
  ) {}

  /** What the environment says, as a full week. The floor. */
  private envWeek(): DayHours[] {
    return Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek,
      opensAt: this.gym.openTime,
      closesAt: this.gym.closeTime,
      isClosed: false,
    }));
  }

  /** The whole week, for the settings screen and the public config. */
  async week(): Promise<DayHours[]> {
    const now = Date.now();
    if (this.cache !== null && now - this.cache.at < CACHE_MS) return this.cache.rows;

    let rows: DayHours[];
    try {
      const stored = await this.prisma.openingHours.findMany({ orderBy: { dayOfWeek: 'asc' } });

      // A partial table is filled in from the environment rather than left
      // with holes — a missing Wednesday must not mean "closed on Wednesday".
      const byDay = new Map(stored.map((row) => [row.dayOfWeek, row]));
      rows = this.envWeek().map((fallback) => {
        const row = byDay.get(fallback.dayOfWeek);
        if (row === undefined) return fallback;

        if (!TIME.test(row.opensAt) || !TIME.test(row.closesAt)) {
          // The CHECK constraint should make this unreachable. If it is ever
          // reached, something bypassed the database's own guarantee, and the
          // door is not the place to find out.
          this.logger.error(
            `OpeningHours day ${row.dayOfWeek} has a malformed time — falling back to the environment.`,
          );
          return fallback;
        }

        return {
          dayOfWeek: row.dayOfWeek,
          opensAt: row.opensAt,
          closesAt: row.closesAt,
          isClosed: row.isClosed,
        };
      });
    } catch (caught) {
      this.logger.error('Could not read opening hours — using GYM_OPEN_TIME/GYM_CLOSE_TIME', caught as Error);
      rows = this.envWeek();
    }

    this.cache = { at: now, rows };
    return rows;
  }

  /**
   * Today's window, in the gym's own timezone.
   *
   * The weekday is resolved through `GYM_TIMEZONE` rather than the server's
   * clock: a Railway container runs in UTC, and at 23:30 Manila it is already
   * tomorrow there — which would read Sunday's hours on a Saturday night.
   */
  async forDate(now: Date): Promise<DayHours> {
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: this.gym.timeZone,
      weekday: 'short',
    }).format(now);

    const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
    const week = await this.week();
    return week[index === -1 ? 0 : index] ?? this.envWeek()[0]!;
  }

  /** Called after a write, so an edit takes effect at the door immediately. */
  invalidate(): void {
    this.cache = null;
  }

  async replace(days: DayHours[], updatedById: string, actorRole: Role): Promise<DayHours[]> {
    // Read BEFORE the upserts, so the entry can say what actually moved. A
    // week's hours is seven small rows; this costs one query on an action the
    // gym performs a few times a year.
    const before = await this.week();

    await this.prisma.$transaction(
      days.map((day) =>
        this.prisma.openingHours.upsert({
          where: { dayOfWeek: day.dayOfWeek },
          create: { ...day, updatedById },
          update: {
            opensAt: day.opensAt,
            closesAt: day.closesAt,
            isClosed: day.isClosed,
            updatedById,
          },
        }),
      ),
    );

    this.invalidate();
    const after = await this.week();

    /*
     * Opening hours decide who gets through the door, so a change here is a
     * change to everybody's access at once — which is exactly why it is on the
     * dangerous-action list alongside voids and role changes.
     *
     * Only the days that moved are recorded, and the stored 24-hour `HH:mm` is
     * what goes in: the audit trail records the VALUE, and any 12-hour
     * rendering is the reader's business. Storing a formatted time here would
     * put a display decision into a permanent record.
     */
    const changed = after
      .map((day, index) => ({ day, was: before[index] }))
      .filter(
        ({ day, was }) =>
          was !== undefined &&
          (was.opensAt !== day.opensAt ||
            was.closesAt !== day.closesAt ||
            was.isClosed !== day.isClosed),
      )
      .map(({ day, was }) => ({
        dayOfWeek: day.dayOfWeek,
        before: { opensAt: was?.opensAt, closesAt: was?.closesAt, isClosed: was?.isClosed },
        after: { opensAt: day.opensAt, closesAt: day.closesAt, isClosed: day.isClosed },
      }));

    if (changed.length > 0) {
      await this.audit.record({
        action: 'OPENING_HOURS_CHANGED',
        actorId: updatedById,
        actorRole,
        subjectType: 'OpeningHours',
        subjectLabel: `${changed.length} day${changed.length === 1 ? '' : 's'} changed`,
        details: { days: changed },
      });
    }

    return after;
  }
}
