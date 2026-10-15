import { HttpStatus, Injectable } from '@nestjs/common';
import { Role, type Prisma } from '@prisma/client';
import type { CoachProfileView } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DomainException } from '../common/exceptions/domain.exception';
import type { ScopedWhere } from '../rbac/scope.util';
import type { AuthUser } from '../auth/auth.types';

type UserScope = ScopedWhere<Prisma.UserWhereInput>;

interface ProfileRow {
  userId: string;
  specializations: string[];
  bio: string | null;
  updatedAt: Date;
}

function toView(row: ProfileRow): CoachProfileView {
  return {
    userId: row.userId,
    specializations: row.specializations,
    bio: row.bio,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function emptyProfile(userId: string): CoachProfileView {
  return { userId, specializations: [], bio: null, updatedAt: null };
}

/**
 * What members read about a coach — specializations and a short bio.
 *
 * A coach is still a `User` with role COACH; this is the one thing about them
 * the user row has no column for. The limits (five tags of 1-40 characters, a
 * bio of at most 500) are the DTO's job and the database's backstop
 * (`CoachProfile_*_shape`); this service's own job is tidying what staff type
 * — trimming, dropping blank tags, folding "Strength" and "strength" into one.
 */
@Injectable()
export class CoachProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * One coach's profile. 404 for anybody who is not a live COACH within the
   * caller's reach — one answer whether the account does not exist, is
   * deleted, or holds another role, so the route is nobody's oracle.
   */
  async get(coachId: string, scope: UserScope): Promise<CoachProfileView> {
    const coach = await this.liveCoach(coachId, scope);
    const row = await this.prisma.coachProfile.findUnique({ where: { userId: coach.id } });
    return row === null ? emptyProfile(coach.id) : toView(row);
  }

  /** Every live coach's profile the caller can reach — the coaches screen and the assign picker. */
  async list(scope: UserScope): Promise<CoachProfileView[]> {
    const rows = await this.prisma.coachProfile.findMany({
      where: { user: { AND: [{ role: Role.COACH }, scope] } },
    });
    return rows.map(toView);
  }

  /**
   * `PUT /admin/coaches/:id/profile` — replaces both fields. Audited as
   * COACH_PROFILE_UPDATED with the specializations before and after, and only
   * WHETHER the bio changed: five hundred characters is not an audit line.
   */
  async update(
    actor: Pick<AuthUser, 'id' | 'role'>,
    coachId: string,
    dto: { specializations: string[]; bio: string | null },
    now: Date = new Date(),
  ): Promise<CoachProfileView> {
    // An admin edits any live coach; there is no OWN reach on this key.
    const coach = await this.liveCoach(coachId, { deletedAt: null } as UserScope);

    const specializations = tidyTags(dto.specializations);
    const bio = dto.bio === null || dto.bio.trim() === '' ? null : dto.bio.trim();

    const before = await this.prisma.coachProfile.findUnique({ where: { userId: coach.id } });
    const row = await this.prisma.coachProfile.upsert({
      where: { userId: coach.id },
      create: { userId: coach.id, specializations, bio, updatedById: actor.id },
      update: { specializations, bio, updatedById: actor.id },
    });

    await this.audit.record(
      {
        action: 'COACH_PROFILE_UPDATED',
        actorId: actor.id,
        actorRole: actor.role,
        subjectType: 'User',
        subjectId: coach.id,
        subjectLabel: `${coach.firstName} ${coach.lastName}`.trim(),
        details: {
          specializations: {
            before: (before?.specializations ?? []).join(', '),
            after: specializations.join(', '),
          },
          bioChanged: (before?.bio ?? null) !== bio,
        },
      },
      now,
    );

    return toView(row);
  }

  private async liveCoach(
    coachId: string,
    scope: UserScope,
  ): Promise<{ id: string; firstName: string; lastName: string }> {
    const coach = await this.prisma.user.findFirst({
      // AND, never spread: the scope can carry an OR of its own.
      where: { AND: [{ id: coachId, role: Role.COACH }, scope] },
      select: { id: true, firstName: true, lastName: true },
    });
    if (coach === null) {
      throw new DomainException('COACH_NOT_FOUND', 'Coach not found', HttpStatus.NOT_FOUND);
    }
    return coach;
  }
}

/** Trimmed, non-blank, first spelling wins on a case-insensitive repeat. */
function tidyTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    const key = tag.toLowerCase();
    if (tag === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}
