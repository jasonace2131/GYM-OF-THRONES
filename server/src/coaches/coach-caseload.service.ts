import { HttpStatus, Injectable } from '@nestjs/common';
import { Role, type Prisma } from '@prisma/client';
import type { CoachProfileView, RoleName } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { DomainException } from '../common/exceptions/domain.exception';
import { CoachingService } from '../me/coaching.service';
import type { CoachMemberRow } from '../me/coaching.presenter';
import type { ScopedWhere } from '../rbac/scope.util';
import { CoachProfilesService } from './coach-profiles.service';

/** Who may hold the coach side of an assignment — mirrors CoachAssignmentsService. */
const COACHABLE_ROLES = [Role.COACH, Role.ADMIN, Role.DEV];

export interface AdminCoachCaseload {
  coach: {
    id: string;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
    role: RoleName;
  };
  /** Null for an admin who happens to coach: profiles belong to the COACH role. */
  profile: CoachProfileView | null;
  members: CoachMemberRow[];
}

/**
 * The Super Admin's read-only look at one coach's caseload.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS THE ROUTE `CoachingService`'S HEADER ASKED FOR.
 *
 * That service says an admin-facing "view any coach's dashboard" must NOT be
 * built by adding a `coachId` parameter to the coach's own `/me/coaching/*`
 * routes — it gets its own `coach.read`-at-ALL route, so the two audiences
 * cannot be confused by a parameter that is optional in one direction only.
 * This is that route. The caseload rows are the SAME `members()` the coach
 * sees on their own dashboard, so the two views cannot disagree.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class CoachCaseloadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coaching: CoachingService,
    private readonly profiles: CoachProfilesService,
  ) {}

  async caseload(coachId: string): Promise<AdminCoachCaseload> {
    const coach = await this.prisma.user.findFirst({
      where: { id: coachId, role: { in: COACHABLE_ROLES }, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, avatarUrl: true, role: true },
    });
    if (coach === null) {
      throw new DomainException('COACH_NOT_FOUND', 'Coach not found', HttpStatus.NOT_FOUND);
    }

    const [members, profile] = await Promise.all([
      this.coaching.members(coach.id),
      coach.role === Role.COACH
        ? this.profiles.get(coach.id, { deletedAt: null } as ScopedWhere<Prisma.UserWhereInput>)
        : Promise.resolve(null),
    ]);

    return { coach, profile, members };
  }
}
