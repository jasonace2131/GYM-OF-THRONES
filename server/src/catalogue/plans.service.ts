import { BadRequestException, ConflictException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type Plan } from '@prisma/client';
import type { PaginatedData } from '@got/shared';
import { DomainException } from '../common/exceptions/domain.exception';
import { mapPrismaError } from '../common/exceptions/prisma-error.mapper';
import { paginated, paginationSkipTake } from '../common/dto/paginate';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { planShapeError } from './plan-registry';
import { toAdminPlan, toPublicPlan, type AdminPlan, type PublicPlan } from './plan.presenter';
import type { CreatePlanDto } from './dto/create-plan.dto';
import type { UpdatePlanDto } from './dto/update-plan.dto';
import type { ListPlansQueryDto } from './dto/list-plans-query.dto';

/**
 * Plans are the only table in this chunk with no member on it, so nothing here
 * is scoped: there is one price list and everyone with `plan.read` sees all of
 * it. That is why `list` takes no `ScopedWhere` while every membership and
 * payment read does.
 */
@Injectable()
export class PlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Route 5. Active plans only, in the order the pricing grid renders them. */
  async listPublic(): Promise<PublicPlan[]> {
    const rows = await this.prisma.plan.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { priceCentavos: 'asc' }],
    });
    return rows.map(toPublicPlan);
  }

  /** Route 6. */
  async list(query: ListPlansQueryDto): Promise<PaginatedData<AdminPlan>> {
    const where: Prisma.PlanWhereInput = {
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.kind ? { kind: query.kind } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.plan.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { priceCentavos: 'asc' }],
        ...paginationSkipTake(query),
      }),
      this.prisma.plan.count({ where }),
    ]);

    return paginated(rows.map(toAdminPlan), total, query);
  }

  /** Route 7. */
  async create(dto: CreatePlanDto): Promise<AdminPlan> {
    const freezable = dto.freezable ?? false;
    const shape = planShapeError(dto.kind, dto.termMonths, freezable);
    if (shape) throw new BadRequestException(shape);

    try {
      const row = await this.prisma.plan.create({
        data: {
          code: dto.code,
          name: dto.name,
          description: dto.description ?? null,
          kind: dto.kind,
          priceCentavos: dto.priceCentavos,
          termMonths: dto.termMonths ?? null,
          freezable,
          guestPassesPerTerm: dto.guestPassesPerTerm ?? 0,
          graceDays: dto.graceDays ?? 3,
          perks: dto.perks ?? [],
          sortOrder: dto.sortOrder ?? 0,
        },
      });
      return toAdminPlan(row);
    } catch (error) {
      // Caught OUTSIDE any transaction, so the §4.6(d) rule is not violated.
      // Route 7 names this failure `HTTP_409` and not a domain code: a
      // duplicate code is a collision in the admin's own namespace, not a
      // business outcome any client branches on.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`A plan with code ${dto.code} already exists`);
      }
      const mapped = mapPrismaError(error);
      if (mapped) throw mapped;
      throw error;
    }
  }

  /** Route 8. */
  /**
   * `actor` is here only so the audit entry can name who changed a price.
   *
   * Optional, because `create` and `requireSellable` have no such caller and
   * a required parameter would force every internal path to invent one. When
   * it is absent no entry is written, which is the honest outcome: an audit
   * line naming nobody is worse than no line at all.
   */
  async update(id: string, dto: UpdatePlanDto, actor?: AuthUser): Promise<AdminPlan> {
    const existing = await this.requireById(id);
    if (!existing.isActive) {
      throw new DomainException(
        'PLAN_ARCHIVED',
        `Plan ${existing.code} is archived. Create a replacement rather than editing a retired price.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // The shape rule is checked against the MERGED row, not the patch: a
    // request that only sends `kind: 'WALK_IN'` would otherwise leave the old
    // termMonths behind and be caught by the CHECK as a 422 instead of a 400.
    const kind = dto.kind ?? existing.kind;
    const termMonths = dto.termMonths ?? (dto.kind === undefined ? existing.termMonths : null);
    const freezable = dto.freezable ?? (dto.kind === undefined ? existing.freezable : false);
    const shape = planShapeError(kind, termMonths, freezable);
    if (shape) throw new BadRequestException(shape);

    const row = await this.prisma.plan.update({
      where: { id },
      data: {
        ...(dto.name === undefined ? {} : { name: dto.name }),
        ...(dto.description === undefined ? {} : { description: dto.description }),
        ...(dto.priceCentavos === undefined ? {} : { priceCentavos: dto.priceCentavos }),
        ...(dto.guestPassesPerTerm === undefined
          ? {}
          : { guestPassesPerTerm: dto.guestPassesPerTerm }),
        ...(dto.graceDays === undefined ? {} : { graceDays: dto.graceDays }),
        ...(dto.perks === undefined ? {} : { perks: dto.perks }),
        ...(dto.sortOrder === undefined ? {} : { sortOrder: dto.sortOrder }),
        kind,
        termMonths,
        freezable,
      },
    });

    if (actor !== undefined) {
      /*
       * BEFORE AND AFTER, for the fields that actually moved.
       *
       * A price edit reprices every renewal from the moment it lands, so "the
       * Monthly went from 800 to 900 on the 12th" is the question this entry
       * exists to answer — and "PLAN_UPDATED" alone answers none of it.
       *
       * Only changed fields are recorded. Dumping the whole row would make the
       * audit log a second copy of the plan table with none of its constraints.
       */
      const changes: Record<string, { before: unknown; after: unknown }> = {};
      for (const [field, after] of Object.entries(dto) as [keyof typeof dto, unknown][]) {
        if (after === undefined) continue;
        const before = (existing as unknown as Record<string, unknown>)[field];
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        changes[field] = { before, after };
      }

      if (Object.keys(changes).length > 0) {
        await this.audit.record({
          action: 'PLAN_UPDATED',
          actorId: actor.id,
          actorRole: actor.role,
          subjectType: 'Plan',
          subjectId: row.id,
          subjectLabel: row.code,
          details: changes as Prisma.InputJsonValue,
        });
      }
    }

    return toAdminPlan(row);
  }

  /**
   * Route 9. Retire, never delete — every relation is `onDelete: Restrict` and
   * a plan carries the price history of every term ever sold on it.
   *
   * Idempotent: archiving an already-archived plan returns 200 with the
   * existing row, so a double-click in the CRM is harmless.
   */
  async archive(id: string, actor?: AuthUser): Promise<AdminPlan> {
    const existing = await this.requireById(id);
    // Idempotent, and deliberately silent: archiving an already-archived plan
    // changed nothing, so recording it would put a line in the log for an
    // action that did not happen.
    if (!existing.isActive) return toAdminPlan(existing);

    const row = await this.prisma.plan.update({ where: { id }, data: { isActive: false } });

    if (actor !== undefined) {
      await this.audit.record({
        action: 'PLAN_ARCHIVED',
        actorId: actor.id,
        actorRole: actor.role,
        subjectType: 'Plan',
        subjectId: row.id,
        subjectLabel: row.code,
        details: { name: row.name, priceCentavos: row.priceCentavos },
      });
    }

    return toAdminPlan(row);
  }

  /**
   * The one plan lookup every selling path uses.
   *
   * Takes the transaction client FIRST because every caller resolves the plan
   * inside the same transaction that writes the Payment — reading it on the
   * base client would let an admin archive a plan between the read and the
   * write and leave a sale attributed to a plan that was retired mid-sale.
   */
  async requireSellable(tx: Prisma.TransactionClient, code: string): Promise<Plan> {
    const plan = await tx.plan.findUnique({ where: { code } });
    if (!plan) {
      throw new DomainException(
        'PLAN_NOT_FOUND',
        `No plan with code ${code}`,
        HttpStatus.NOT_FOUND,
      );
    }
    if (!plan.isActive) {
      throw new DomainException(
        'PLAN_ARCHIVED',
        `Plan ${code} is archived and cannot be sold`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return plan;
  }

  private async requireById(id: string): Promise<Plan> {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) {
      throw new DomainException('PLAN_NOT_FOUND', 'Plan not found', HttpStatus.NOT_FOUND);
    }
    return plan;
  }
}
