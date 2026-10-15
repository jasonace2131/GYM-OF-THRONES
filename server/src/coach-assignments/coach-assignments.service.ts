import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PaginatedData } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { DomainException } from '../common/exceptions/domain.exception';
import { mapPrismaError } from '../common/exceptions/prisma-error.mapper';
import { paginated, paginationSkipTake } from '../common/dto/paginate';
import type { ScopedWhere } from '../rbac/scope.util';
import type { PermissionUser } from '../rbac/rbac.types';
import {
  COACH_ASSIGNMENT_INCLUDE,
  toCoachAssignmentView,
  type CoachAssignmentView,
} from './coach-assignment.presenter';
import type { ListCoachAssignmentsQueryDto } from './dto/list-coach-assignments-query.dto';
import type { CreateCoachAssignmentDto } from './dto/create-coach-assignment.dto';

/** Who may hold the coach side of an assignment. */
const COACHABLE_ROLES = ['COACH', 'ADMIN', 'DEV'] as const;

/**
 * The reference scoped service.
 *
 * Every read takes `scope: ScopedWhere<…>` as a REQUIRED parameter and ANDs it
 * internally. Spreading (`{ ...filters, ...scope }`) would clobber a
 * co-existing top-level OR and widen the query; the brand makes that a compile
 * error rather than a review finding.
 */
@Injectable()
export class CoachAssignmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    user: PermissionUser,
    query: ListCoachAssignmentsQueryDto,
    scope: ScopedWhere<Prisma.CoachAssignmentWhereInput>,
  ): Promise<PaginatedData<CoachAssignmentView>> {
    void user; // identity is already baked into `scope`; kept for call-site symmetry

    const filters: Prisma.CoachAssignmentWhereInput = {
      ...(query.coachId ? { coachId: query.coachId } : {}),
      ...(query.memberId ? { memberId: query.memberId } : {}),
      ...(query.activeOnly ? { status: 'ACTIVE' as const } : {}),
    };
    const where: Prisma.CoachAssignmentWhereInput = { AND: [filters, scope] };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.coachAssignment.findMany({
        where,
        include: COACH_ASSIGNMENT_INCLUDE,
        orderBy: { startedAt: 'desc' },
        ...paginationSkipTake(query),
      }),
      this.prisma.coachAssignment.count({ where }),
    ]);

    return paginated(rows.map(toCoachAssignmentView), total, query);
  }

  /**
   * 404, never 403, on a scoped miss — a 403 confirms the row exists and turns
   * this endpoint into an enumeration oracle.
   */
  async findOne(
    id: string,
    scope: ScopedWhere<Prisma.CoachAssignmentWhereInput>,
  ): Promise<CoachAssignmentView> {
    const row = await this.prisma.coachAssignment.findFirst({
      where: { AND: [{ id }, scope] },
      include: COACH_ASSIGNMENT_INCLUDE,
    });
    if (!row) {
      throw new DomainException(
        'COACH_ASSIGNMENT_NOT_FOUND',
        'Coach assignment not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return toCoachAssignmentView(row);
  }

  async create(actorId: string, dto: CreateCoachAssignmentDto): Promise<CoachAssignmentView> {
    if (dto.coachId === dto.memberId) {
      throw new DomainException('COACH_SELF_ASSIGNMENT', 'A coach cannot be their own member');
    }

    const [coach, member] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: dto.coachId },
        select: { id: true, role: true, deletedAt: true },
      }),
      this.prisma.user.findUnique({
        where: { id: dto.memberId },
        select: { id: true, role: true, deletedAt: true },
      }),
    ]);

    // Soft-deleted rows are invisible to every member-facing read (§4.4).
    if (!coach || coach.deletedAt) {
      throw new DomainException(
        'COACH_ASSIGNMENT_NOT_FOUND',
        'Coach not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (!member || member.deletedAt) {
      throw new DomainException(
        'COACH_ASSIGNMENT_NOT_FOUND',
        'Member not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (!COACHABLE_ROLES.includes(coach.role as (typeof COACHABLE_ROLES)[number])) {
      throw new DomainException('COACH_NOT_A_COACH', 'That user is not a coach');
    }

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        // Reassignment is one POST: end the incumbent, then insert. An
        // unconditional updateMany is safe to run when there is no incumbent —
        // it reports count 0 and leaves the transaction alive.
        await tx.coachAssignment.updateMany({
          where: { memberId: dto.memberId, status: 'ACTIVE' },
          data: {
            status: 'ENDED',
            endedAt: new Date(),
            endedById: actorId,
            activeMemberId: null,
          },
        });

        return tx.coachAssignment.create({
          include: COACH_ASSIGNMENT_INCLUDE,
          data: {
            coachId: dto.coachId,
            memberId: dto.memberId,
            activeMemberId: dto.memberId,
            assignedById: actorId,
            ...(dto.notes === undefined ? {} : { notes: dto.notes }),
          },
        });
      });

      return toCoachAssignmentView(row);
    } catch (error) {
      // The concurrency guard. Two simultaneous POSTs for one member both end
      // the incumbent and both insert; `activeMemberId @unique` lets exactly
      // one win. This is caught OUTSIDE the transaction callback, so the
      // §4.6(d) rule is not violated — no further statement runs on that tx.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DomainException(
          'MEMBER_ALREADY_ASSIGNED',
          'That member already has an active coach',
          HttpStatus.CONFLICT,
        );
      }
      const mapped = mapPrismaError(error);
      if (mapped) throw mapped;
      throw error;
    }
  }

  /**
   * Soft end. Idempotent: ending an already-ended assignment returns 200 with
   * the existing row, so a double-click at the desk is harmless. Returns the
   * row rather than 204 — the client renders "ended 18 Aug" from `endedAt`.
   *
   * `scope` is REQUIRED, matching `findOne` — safe today only because
   * `coach.update` is granted to ADMIN at ALL and nobody else. The obvious
   * next grant (`coach.update` at OWN to COACH, mirroring `coach.read`)
   * would otherwise let any coach end any assignment row by id, including
   * one between two other people. The branded `ScopedWhere` makes forgetting
   * it here a compile error rather than a scope hole discovered later.
   */
  async end(
    actorId: string,
    id: string,
    scope: ScopedWhere<Prisma.CoachAssignmentWhereInput>,
  ): Promise<CoachAssignmentView> {
    const existing = await this.prisma.coachAssignment.findFirst({
      where: { AND: [{ id }, scope] },
      include: COACH_ASSIGNMENT_INCLUDE,
    });
    if (!existing) {
      throw new DomainException(
        'COACH_ASSIGNMENT_NOT_FOUND',
        'Coach assignment not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (existing.status === 'ENDED') {
      return toCoachAssignmentView(existing);
    }

    const row = await this.prisma.coachAssignment.update({
      where: { id },
      include: COACH_ASSIGNMENT_INCLUDE,
      data: {
        status: 'ENDED',
        endedAt: new Date(),
        endedById: actorId,
        activeMemberId: null,
      },
    });
    return toCoachAssignmentView(row);
  }
}
