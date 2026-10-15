import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GymConfigService } from '../../config/gym.config';
import type { ScheduledJob } from '../scheduler.service';

const MS_PER_HOUR = 3_600_000;

/**
 * Deletes expired ephemeral rows.
 *
 * Two tables: `IdempotencyRecord` (request receipts) and `StationScan` (one row
 * per QR scan, carrying a peppered `originIpHash`). The instruction left here
 * for the chunk-2 author was to extend this job with a second deleteMany rather
 * than write a new one; chunk 2 shipped, that extension did not, and StationScan
 * grew for as long as the gap lasted. It is closed now — but the shape of the
 * miss is worth remembering: a retention policy written only in a schema comment
 * is not a retention policy.
 *
 * Idempotent by construction: each predicate is `<column> < cutoff`, whose own
 * effect falsifies it, so a catch-up run after downtime produces the same state
 * as a nightly one.
 *
 * `responseStatus: 0` is excluded from deletion on purpose. Task 12's
 * interceptor deliberately leaves a claim at `responseStatus: 0` when the
 * receipt write fails AFTER the handler already committed — precisely so a
 * retry with the same Idempotency-Key cannot find "no claim", re-run the
 * handler, and double-charge (or otherwise double-execute for) the caller.
 * That row is a deliberate safety state, not garbage: it requires a human to
 * clear it once the underlying failure is understood. Deleting it on a timer
 * once IDEMPOTENCY_RETENTION_HOURS elapses would silently reopen exactly the
 * window task 12 closed, so this job never deletes a stuck claim — it only
 * counts and logs how many exist past the cutoff, so an operator has
 * something to notice. The trade is an unbounded (but rare, by construction)
 * table of stuck rows over a silent duplicate charge.
 */
@Injectable()
export class PruneEphemeraJob implements ScheduledJob {
  readonly name = 'pruneEphemera';
  readonly cronExpression = '30 03 * * *';

  private readonly logger = new Logger(PruneEphemeraJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
  ) {}

  async run(): Promise<void> {
    const cutoff = new Date(Date.now() - this.gym.idempotencyRetentionHours * MS_PER_HOUR);
    const expired = { createdAt: { lt: cutoff } };

    // No try/catch. A failed purge must surface as a logged, raised error the
    // scheduler reports — a swallowed one grows the table forever in silence.
    //
    // `skipped` is counted separately rather than folded into `deleted` (or
    // omitted) so the log line's `deleted=` count stays an honest measure of
    // what actually left the table — a stuck claim surviving on purpose is not
    // the same event as an ordinary claim aging out, and conflating them would
    // make the metric misleading in exactly the case an operator most needs it
    // to be trustworthy.
    /*
     * ─────────────────────────────────────────────────────────────────────
     * StationScan IS THE SECOND TABLE, AND IT WAS MISSING.
     *
     * `station-scan.prisma` states plainly that "rows older than 24h are
     * deleted by pruneEphemera", and the chunk-2 design lists this job as
     * deleting both tables. Only the IdempotencyRecord half ever shipped, so
     * the one table the schema annotates as holding Data Privacy Act-relevant
     * data — `originIpHash`, a per-member behavioural record — was the one
     * whose written retention policy nothing enforced. It grew without bound.
     *
     * Its own cutoff: a scan's usefulness ends with the slot look-back, so it
     * is retained on the same window as an idempotency claim rather than
     * needing a knob of its own.
     * ─────────────────────────────────────────────────────────────────────
     */
    const [skipped, { count: deleted }, { count: scansDeleted }] = await Promise.all([
      this.prisma.idempotencyRecord.count({ where: { ...expired, responseStatus: 0 } }),
      this.prisma.idempotencyRecord.deleteMany({
        where: { ...expired, responseStatus: { not: 0 } },
      }),
      // `consumedAt`, not `createdAt` — StationScan has no createdAt column.
      this.prisma.stationScan.deleteMany({ where: { consumedAt: { lt: cutoff } } }),
    ]);

    this.logger.log(
      `job=${this.name} cutoff=${cutoff.toISOString()} ` +
        `IdempotencyRecord.deleted=${deleted} IdempotencyRecord.skipped=${skipped} ` +
        `StationScan.deleted=${scansDeleted}`,
    );
  }
}
