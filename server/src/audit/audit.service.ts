import { Injectable, Logger } from '@nestjs/common';
import type { AuditAction, Prisma, Role } from '@prisma/client';
import type { PaginatedData } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { paginated, paginationSkipTake } from '../common/dto/paginate';
import { AUDIT_INCLUDE, toAuditEntryView, type AuditEntryView } from './audit.presenter';
import type { ListAuditQueryDto } from './dto/list-audit-query.dto';

/**
 * What a producer records. Everything but `action`, `actorId`, `actorRole` and
 * `subjectType` is optional, because the actions differ in what they can
 * honestly say — a plan edit has a before and after, a member restore has
 * neither, and a reason exists only where the action's own DTO demanded one.
 */
export interface RecordAuditInput {
  action: AuditAction;
  actorId: string;
  /** The actor's role at the time. Snapshotted, never read back later. */
  actorRole: Role;
  subjectType: string;
  subjectId?: string | null;
  subjectLabel?: string | null;
  reason?: string | null;
  /** `{ before, after }`, small. Never a whole row. */
  details?: Prisma.InputJsonValue | null;
  /** Already hashed by the caller. This service never sees an address. */
  originIpHash?: string | null;
}

/**
 * The audit trail.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `record()` NEVER THROWS, AND THE TRADE-OFF IS DELIBERATE.
 *
 * The alternative — let a failed audit insert fail the action — sounds like
 * the rigorous choice and is the wrong one here. The eleven actions this wraps
 * are things staff do at a counter with a member standing in front of them:
 * voiding a mis-keyed payment, letting somebody in whom the door refused. A
 * transient database hiccup on the LOG must not be the reason the member is
 * turned away, and an operator who cannot void a wrong charge will find
 * another way to fix it that leaves no trail at all.
 *
 * So this is a forward-only, best-effort trail rather than a tamper-evident
 * ledger, and the screen says as much. What makes it trustworthy in practice
 * is the other half: `AuditLog.actorId` is `ON DELETE RESTRICT` and there is
 * no update or delete path anywhere in this service, so an entry that gets
 * written cannot afterwards be quietly changed or removed.
 *
 * If a genuinely tamper-evident ledger is ever wanted, the change is to accept
 * a `Prisma.TransactionClient` here and write inside each action's own
 * transaction — the shape below already takes everything that would need.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordAuditInput, now: Date = new Date()): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: input.action,
          actorId: input.actorId,
          actorRole: input.actorRole,
          subjectType: input.subjectType,
          subjectId: input.subjectId ?? null,
          subjectLabel: input.subjectLabel ?? null,
          reason: input.reason ?? null,
          ...(input.details === undefined || input.details === null
            ? {}
            : { details: input.details }),
          originIpHash: input.originIpHash ?? null,
          occurredAt: now,
        },
      });
    } catch (caught) {
      // Loud in the log, silent to the caller. The action already happened;
      // failing it now would leave the member unserved AND still unlogged.
      this.logger.error(
        `could not record ${input.action} on ${input.subjectType} ${input.subjectId ?? '—'}`,
        caught instanceof Error ? caught.stack : String(caught),
      );
    }
  }

  /**
   * The screen's list. Newest first, always — an audit log read in any other
   * order is one somebody has to reason about before they can read it.
   *
   * Unscoped, and that is correct: `audit.read` is granted only at ALL, to
   * ADMIN. A per-actor slice of an audit log would let somebody audit everyone
   * except themselves.
   */
  async list(query: ListAuditQueryDto): Promise<PaginatedData<AuditEntryView>> {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.action === undefined ? {} : { action: query.action }),
      ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
      ...(query.subjectId === undefined ? {} : { subjectId: query.subjectId }),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        include: AUDIT_INCLUDE,
        orderBy: { occurredAt: 'desc' },
        ...paginationSkipTake(query),
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return paginated(rows.map(toAuditEntryView), total, query);
  }

  /**
   * The date of the earliest entry, or null when there are none.
   *
   * The screen needs it to say "recorded from <date>" rather than presenting a
   * short list as a complete history. Forward-only logging makes the
   * difference between "nothing happened" and "nothing was recorded yet"
   * invisible otherwise, and that is precisely the confusion an audit screen
   * must not create.
   */
  async recordingSince(): Promise<string | null> {
    const earliest = await this.prisma.auditLog.findFirst({
      orderBy: { occurredAt: 'asc' },
      select: { occurredAt: true },
    });
    return earliest?.occurredAt.toISOString() ?? null;
  }
}
