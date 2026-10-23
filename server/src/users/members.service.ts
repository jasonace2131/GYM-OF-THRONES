import { ForbiddenException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, Role, UserStatus } from '@prisma/client';
import {
  accountActionRefusal,
  roleChangeRefusal,
  type AccountAction,
  type DomainErrorCode,
  type HierarchyTarget,
  type MembershipStatus,
  type PaginatedData,
  type RoleRuleRefusal,
} from '@got/shared';
import { roleRefusalException } from '../rbac/role-rules';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { GymConfigService } from '../config/gym.config';
import { DomainException } from '../common/exceptions/domain.exception';
import { paginated, paginationSkipTake } from '../common/dto/paginate';
import { addDays, gymToday, toDateColumn, type CivilDate } from '../common/time/gym-time';
import type { ScopedWhere } from '../rbac/scope.util';
import { SupabaseAdminService } from '../auth/supabase-admin.service';
import { PermissionsService } from '../rbac/permissions.service';
import { MembershipSalesService } from '../membership/membership-sales.service';
import type { AuthUser } from '../auth/auth.types';
import { toMemberListItem, type MemberListItem } from './members.presenter';
import { alreadySignedIn, MemberJoinService, staffAccount } from './member-join.service';
import type {
  ListMembersQueryDto,
  MemberSort,
  MemberStanding,
} from './dto/list-members-query.dto';
import type { MemberCountsQueryDto } from './dto/member-counts-query.dto';
import type { UpdateMemberDto } from './dto/update-member.dto';
import type { SuspendMemberDto } from './dto/suspend-member.dto';
import type { ChangeRoleDto } from './dto/change-role.dto';
import type { CreateMemberDto } from './dto/create-member.dto';
import { isSelfDeleted } from './auth-erasure';

/**
 * The filter fields `list()` and `counts()` have in common, named so the one
 * shared `memberWhere` builder can take either DTO.
 *
 * `role` and `membershipStatus` are optional here because the counts query
 * carries neither — `MemberCountsQueryDto` is deliberately narrower than
 * `ListMembersQueryDto` (no pagination, no sort, no standing).
 */
interface MemberFilterInput {
  search?: string;
  planCode?: string;
  role?: Role;
  /** Staff & Access: every role but CLIENT. An explicit `role` wins. */
  staff?: boolean;
  membershipStatus?: MembershipStatus;
  deleted: boolean;
}

/**
 * `GET /members/counts`'s response.
 *
 * `expiring` is a SUBSET of `active` (both are `endsOn >= today`), so these
 * five numbers do not partition and the client's captions say so. `none` is
 * the one no screen has ever shown: an account with no membership row at all.
 *
 * `expiringSoonDays` travels with the numbers so the tile's own label comes
 * from the same place the filter does — see `counts()`.
 */
export interface MemberCounts {
  active: number;
  expiring: number;
  expired: number;
  none: number;
  total: number;
  expiringSoonDays: number;
}

/**
 * Who is acting, as far as the role hierarchy needs: the id for "never
 * yourself" and the role for "only below your own". Both come from the
 * verified request, never from a body.
 */
export type AccountActor = Pick<AuthUser, 'id' | 'role'>;

/** `MembersService.create`'s result. `planSaleError` is present only when
 *  `dto.plan` was given and the sale failed — see `create`'s doc comment. */
export interface CreateMemberResult {
  member: MemberListItem;
  emailSent: boolean;
  planSaleError?: { code: string; message: string };
}

/**
 * The CRM's member list — everyone with an account, not everyone with a term.
 *
 * That difference is the whole reason this exists beside `GET /memberships`.
 * A subscription list structurally cannot show a person who has never bought
 * a plan, and those people are exactly the ones a gym rings.
 */
@Injectable()
export class MembersService {
  private readonly logger = new Logger(MembersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly memberJoin: MemberJoinService,
    private readonly permissions: PermissionsService,
    private readonly sales: MembershipSalesService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Every account action here writes one of these, so the shape is built once.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * THE ACTOR'S ROLE IS READ HERE, NOT THREADED THROUGH THE FIVE CALLERS.
   *
   * `AuditLog.actorRole` is a SNAPSHOT — an admin demoted next month must not
   * retroactively appear to have suspended somebody as a front-desk operator —
   * and reading it at the moment of the action is exactly that snapshot. The
   * alternative was widening `actorId: string` to the full `AuthUser` on five
   * public methods and their twenty-odd call sites, to carry a field only the
   * audit line uses. One primary-key read on an action a gym performs a
   * handful of times a week is the cheaper trade.
   *
   * A missing actor row skips the entry rather than throwing. `record()` is
   * best-effort by contract (see its header), and an account action must never
   * fail because its own log line could not be composed.
   * ─────────────────────────────────────────────────────────────────────────
   */
  private async recordAccountAction(
    action:
      | 'MEMBER_SUSPENDED'
      | 'MEMBER_REACTIVATED'
      | 'MEMBER_DELETED'
      | 'MEMBER_RESTORED'
      | 'ROLE_CHANGED'
      | 'MEMBER_EMAIL_CHANGED',
    actorId: string,
    subject: { userId: string; firstName: string; lastName: string; memberCode: string | null },
    extra: { reason?: string | null; details?: Prisma.InputJsonValue } = {},
    now: Date = new Date(),
  ): Promise<void> {
    let actorRole: Role;
    try {
      const actor = await this.prisma.user.findUnique({
        where: { id: actorId },
        select: { role: true },
      });
      if (actor == null) return;
      actorRole = actor.role;
    } catch {
      return;
    }

    await this.audit.record(
      {
        action,
        actorId,
        actorRole,
        subjectType: 'User',
        subjectId: subject.userId,
        // Name AND code: a name alone is ambiguous in a gym with two Santoses,
        // and a code alone is unreadable.
        subjectLabel:
          `${subject.firstName} ${subject.lastName}`.trim() +
          (subject.memberCode === null ? '' : ` (${subject.memberCode})`),
        reason: extra.reason ?? null,
        ...(extra.details === undefined ? {} : { details: extra.details }),
      },
      now,
    );
  }

  /**
   * THE ROLE HIERARCHY, ENFORCED — the gate every account write passes through.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * TWO PHASES, BECAUSE ONLY ONE RULE NEEDS THE DATABASE.
   *
   * `decide` is `@got/shared`'s pure rule for this action. It is asked first
   * with no admin count: "never yourself", "never DEV" and "only below your
   * own role" need nothing but the two roles, and most calls end there.
   *
   * Only when the target IS an ADMIN can the write take the gym's last admin
   * away, and then the count and the write share one transaction that holds
   * a row lock on every active ADMIN (`FOR UPDATE`). Two Super Admin tabs
   * demoting the last two admins at once would otherwise both count two and
   * both win; with the lock, the second waits, re-reads, counts one and is
   * refused.
   * ─────────────────────────────────────────────────────────────────────────
   */
  private async underRoleRules(
    target: HierarchyTarget,
    decide: (activeAdmins: number | undefined) => RoleRuleRefusal | null,
    self: { code: DomainErrorCode; message: string },
    write: (db: Prisma.TransactionClient) => Promise<unknown>,
  ): Promise<void> {
    const ranked = decide(undefined);
    if (ranked !== null) throw roleRefusalException(ranked, self);

    if (target.role !== Role.ADMIN) {
      await write(this.prisma);
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      const admins = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "User"
        WHERE "role" = 'ADMIN' AND "status" = 'ACTIVE' AND "deletedAt" IS NULL
        FOR UPDATE`;
      const refusal = decide(admins.length);
      if (refusal !== null) throw roleRefusalException(refusal, self);
      await write(tx);
    });
  }

  /** `underRoleRules` for suspend, reactivate, delete and restore. */
  private accountActionUnderRules(
    actor: AccountActor,
    target: HierarchyTarget,
    action: AccountAction,
    write: (db: Prisma.TransactionClient) => Promise<unknown>,
  ): Promise<void> {
    return this.underRoleRules(
      target,
      (activeAdmins) => accountActionRefusal({ actor, target, action, activeAdmins }),
      SELF_REFUSALS[action],
      write,
    );
  }

  /**
   * THE one place a member filter is built. `list()` and `counts()` both go
   * through it, and that is what makes "the KPI tiles cannot disagree with the
   * table" structural rather than aspirational — two copies of this
   * construction is exactly how a tile reading 42 ends up beside a filter
   * showing 39.
   *
   * `standing` is a PARAMETER rather than read off `query` because `counts()`
   * runs the same filter under four different standings (and once under none),
   * while its own query carries no standing at all.
   */
  private memberWhere(
    query: MemberFilterInput,
    standing: MemberStanding | undefined,
    today: CivilDate,
    scope: ScopedWhere<Prisma.UserWhereInput>,
  ): Prisma.UserWhereInput {
    // AND-ed, never spread into one object.
    //
    // planCode, membershipStatus and `standing` all express themselves through
    // the SAME `membership` key, so spreading them side by side let the last
    // one silently overwrite the others — the toolbar sends standing and
    // planCode together and got only the standing constraint back, with no
    // error to notice. Each constraint gets its own AND entry instead, which
    // is also the only form that survives `standing: 'NONE'` (a top-level
    // `membership: null`, not a nested filter).
    const membershipFilters: Prisma.UserWhereInput[] = [];
    if (query.planCode !== undefined) {
      membershipFilters.push({ membership: { planCode: query.planCode } });
    }
    if (query.membershipStatus !== undefined) {
      membershipFilters.push({ membership: { status: query.membershipStatus } });
    }
    const standingFilter = standingWhere(standing, today, this.gym.expiringSoonDays);
    if (Object.keys(standingFilter).length > 0) {
      membershipFilters.push(standingFilter);
    }

    const filters: Prisma.UserWhereInput = {
      // Soft-deleted members are invisible to every read BY DEFAULT. The scope
      // fragment carries `deletedAt: null` too for a `user` subject
      // (regardless of OWN/ALL reach — see scope.util.ts §4.4); repeating it
      // here means the filter holds even if this route is later given an
      // ALL-scope key that resolves to `{}`. `query.deleted` is the CRM's own
      // admin-facing "show deleted" toggle and flips the polarity — see the
      // `where` construction below for how the scope side of this is handled.
      deletedAt: query.deleted ? { not: null } : null,
      ...(query.search === undefined ? {} : { OR: searchClauses(query.search) }),
      ...(query.role !== undefined
        ? { role: query.role }
        : query.staff === true
          ? { role: { not: Role.CLIENT } }
          : {}),
      ...(membershipFilters.length === 0 ? {} : { AND: membershipFilters }),
    };

    // AND, never spread. Both `filters` (search) and `scope` can carry a
    // top-level OR, and spreading would let the second silently replace the
    // first — widening a coach's reach to the whole member base. The
    // `ScopedWhere` brand makes that a compile error.
    //
    // `query.deleted` needs `reachWithoutDeletedGuard`: `scope` ALWAYS folds
    // in `deletedAt: null` for subject 'user' (§4.4, "regardless of scope
    // reach"), which is correct for every other read in the app. AND-ing that
    // unconditional `deletedAt: null` with `filters`' `deletedAt: { not:
    // null }` above would be a self-contradiction — always zero rows. This is
    // the one deliberate, documented exception: keep the caller's OWN/ALL
    // reach, drop only the deletedAt clause it carries, and let `filters`
    // decide deletedAt instead.
    return {
      AND: [filters, query.deleted ? reachWithoutDeletedGuard(scope) : scope],
    };
  }

  async list(
    query: ListMembersQueryDto,
    scope: ScopedWhere<Prisma.UserWhereInput>,
    now: Date = new Date(),
  ): Promise<PaginatedData<MemberListItem>> {
    const today = gymToday(now, this.gym.timeZone);

    const where = this.memberWhere(query, query.standing, today, scope);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        include: MEMBER_INCLUDE,
        orderBy: memberOrderBy(query.sort),
        ...paginationSkipTake(query),
      }),
      this.prisma.user.count({ where }),
    ]);

    const cfg = {
      expiringSoonDays: this.gym.expiringSoonDays,
      graceAdmissionsMax: this.gym.graceAdmissionsMax,
    };

    return paginated(
      rows.map((row) => toMemberListItem(row, today, cfg)),
      total,
      query,
    );
  }

  /**
   * `GET /members/counts` — the roster's three KPI tiles in ONE round trip.
   *
   * ───────────────────────────────────────────────────────────────────────
   * WHY A SERVER ENDPOINT RATHER THAN FOUR `limit=1` LIST CALLS.
   *
   * The screen this replaces fired four requests on load and read `total`
   * off each. Two things that bought nothing and one thing it could not do:
   *
   *   - The tiles and the table now share ONE filter vocabulary and ONE
   *     `where` builder, so a tile reading 42 beside a filter showing 39 is
   *     structurally impossible rather than merely unlikely.
   *   - It can answer `none` — "signed up, never bought a plan" — which is
   *     the entire argument for a member roster existing beside a
   *     subscription list, and which no screen has ever shown.
   *
   * `expiringSoonDays` rides along because the tile has to LABEL itself
   * ("Expiring in 7 days") and `MEMBERSHIP_EXPIRING_SOON_DAYS` is
   * configurable (1–30). A hardcoded 7 in the client is drift waiting to
   * happen: the filter would move and the caption would not.
   *
   * `expiring ⊂ active` — both are `endsOn >= today` — so the two numbers
   * deliberately overlap and the client says so in the tile's caption rather
   * than pretending they partition.
   * ───────────────────────────────────────────────────────────────────────
   */
  async counts(
    query: MemberCountsQueryDto,
    scope: ScopedWhere<Prisma.UserWhereInput>,
    now: Date = new Date(),
  ): Promise<MemberCounts> {
    const today = gymToday(now, this.gym.timeZone);
    const where = (standing: MemberStanding | undefined): Prisma.UserWhereInput =>
      this.memberWhere(query, standing, today, scope);

    // One `$transaction`, so all five numbers are read at the same snapshot.
    // Five separate round trips could count a member into `active` and, a
    // renewal later, out of `total` — and the tiles would not reconcile.
    const [active, expiring, expired, none, total] = await this.prisma.$transaction([
      this.prisma.user.count({ where: where('ACTIVE') }),
      this.prisma.user.count({ where: where('EXPIRING') }),
      this.prisma.user.count({ where: where('EXPIRED') }),
      this.prisma.user.count({ where: where('NONE') }),
      // No standing at all — the same filter, unfiltered by date, which is
      // what makes the other four reconcile against it.
      this.prisma.user.count({ where: where(undefined) }),
    ]);

    return { active, expiring, expired, none, total, expiringSoonDays: this.gym.expiringSoonDays };
  }

  /**
   * 404 on a scoped miss, never 403.
   *
   * A 403 confirms the row exists and turns this endpoint into an enumeration
   * oracle over the whole member base for anyone holding the key at OWN.
   */
  async findOne(
    id: string,
    scope: ScopedWhere<Prisma.UserWhereInput>,
    now: Date = new Date(),
  ): Promise<MemberListItem> {
    const row = await this.prisma.user.findFirst({
      where: { AND: [{ id, deletedAt: null }, scope] },
      include: MEMBER_INCLUDE,
    });
    if (row === null) {
      throw new DomainException('MEMBER_NOT_FOUND', 'Member not found', HttpStatus.NOT_FOUND);
    }

    return toMemberListItem(row, gymToday(now, this.gym.timeZone), {
      expiringSoonDays: this.gym.expiringSoonDays,
      graceAdmissionsMax: this.gym.graceAdmissionsMax,
    });
  }

  /** `PATCH /members/:id` — name, phone, emergency contact. */
  async update(
    id: string,
    dto: UpdateMemberDto,
    scope: ScopedWhere<Prisma.UserWhereInput>,
    now: Date = new Date(),
  ): Promise<MemberListItem> {
    // Existence + scope checked first so a missing/out-of-scope/deleted row
    // is the same 404 `findOne` already gives, rather than Prisma's P2025
    // surfacing as something less specific.
    await this.findOne(id, scope, now);

    await this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.firstName === undefined ? {} : { firstName: dto.firstName }),
        ...(dto.lastName === undefined ? {} : { lastName: dto.lastName }),
        ...(dto.phone === undefined ? {} : { phone: dto.phone }),
        ...(dto.emergencyContact === undefined ? {} : { emergencyContact: dto.emergencyContact }),
      },
    });

    return this.findOne(id, scope, now);
  }

  /**
   * `POST /members/:id/suspend` — blocks CHECK-IN ONLY.
   *
   * Portal login is untouched: `AuthGuard` never reads `User.status`, and
   * this method never touches it either. The door is what enforces this —
   * `accessVerdict()` (membership/access-verdict.ts) denies
   * `userStatus === 'SUSPENDED'` with `DenialReason.ACCOUNT_SUSPENDED`, and
   * both check-in entry points (`CheckInService.recordStationScan` and its
   * re-verification path) already run every admission through it. Flipping
   * `status` here is the entire integration; no check-in code changes.
   */
  async suspend(
    id: string,
    dto: SuspendMemberDto,
    actor: AccountActor,
    scope: ScopedWhere<Prisma.UserWhereInput>,
    now: Date = new Date(),
  ): Promise<MemberListItem> {
    const actorId = actor.id;
    assertNotSelf(id, actorId, 'MEMBER_SELF_SUSPEND', 'You cannot suspend yourself.');

    const before = await this.findOne(id, scope, now);
    assertNotDev(before, 'suspended');
    if (before.status === UserStatus.SUSPENDED) {
      throw new DomainException(
        'MEMBER_ALREADY_SUSPENDED',
        'This member is already suspended.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    // ACTIVE is the ONLY status suspension may leave from. Without this,
    // suspend → reactivate is a two-call backdoor: reactivate writes ACTIVE
    // unconditionally, so a DEACTIVATED account could be laundered back into
    // an active one by a caller holding nothing but `member.suspend`.
    if (before.status !== UserStatus.ACTIVE) {
      throw new DomainException(
        'MEMBER_NOT_ACTIVE',
        'Only an active member can be suspended.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    await this.accountActionUnderRules(actor, hierarchyTarget(before), 'suspend', (db) =>
      db.user.update({
        where: { id },
        data: {
          status: UserStatus.SUSPENDED,
          suspendedAt: now,
          suspendedById: actorId,
          suspendReason: dto.reason,
        },
      }),
    );

    await this.recordAccountAction(
      'MEMBER_SUSPENDED',
      actorId,
      before,
      { reason: dto.reason },
      now,
    );

    return this.findOne(id, scope, now);
  }

  /** `POST /members/:id/reactivate` — clears the suspension, status back to ACTIVE. */
  async reactivate(
    id: string,
    actor: AccountActor,
    scope: ScopedWhere<Prisma.UserWhereInput>,
    now: Date = new Date(),
  ): Promise<MemberListItem> {
    const actorId = actor.id;
    assertNotSelf(id, actorId, 'MEMBER_SELF_REACTIVATE', 'You cannot reactivate yourself.');

    const before = await this.findOne(id, scope, now);
    if (before.status !== UserStatus.SUSPENDED) {
      throw new DomainException(
        'MEMBER_NOT_SUSPENDED',
        'This member is not suspended.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // The hierarchy applies to the undo too: an ADMIN who cannot suspend
    // another admin cannot lift the Super Admin's suspension of one either.
    await this.accountActionUnderRules(actor, hierarchyTarget(before), 'reactivate', (db) =>
      db.user.update({
        where: { id },
        data: {
          status: UserStatus.ACTIVE,
          suspendedAt: null,
          suspendedById: null,
          suspendReason: null,
        },
      }),
    );

    // The undo is recorded too. A trail that shows only the suspension reads
    // as an accusation rather than a history.
    await this.recordAccountAction(
      'MEMBER_REACTIVATED',
      actorId,
      before,
      // No `details`: the suspension's own reason lives on the
      // MEMBER_SUSPENDED entry this one undoes, and `MemberListItem` (what
      // `findOne` returns) deliberately does not carry it. Copying it here
      // would be a second, drifting record of one fact.
      {},
      now,
    );

    return this.findOne(id, scope, now);
  }

  /**
   * `DELETE /members/:id` — soft, sets `deletedAt`.
   *
   * Returns the pre-delete snapshot rather than 204, matching
   * `AnnouncementsService.remove`: re-fetching through `findOne` AFTER the
   * delete would 404 (its own `deletedAt: null` filter would now exclude the
   * row), so the console would have nothing to render "Deleted: <name>" from.
   */
  async remove(
    id: string,
    actor: AccountActor,
    scope: ScopedWhere<Prisma.UserWhereInput>,
    now: Date = new Date(),
  ): Promise<MemberListItem> {
    const actorId = actor.id;
    assertNotSelf(id, actorId, 'MEMBER_SELF_DELETE', 'You cannot delete your own account.');

    const before = await this.findOne(id, scope, now);
    assertNotDev(before, 'deleted');
    await this.accountActionUnderRules(actor, hierarchyTarget(before), 'delete', (db) =>
      db.user.update({ where: { id }, data: { deletedAt: now } }),
    );

    await this.recordAccountAction(
      'MEMBER_DELETED',
      actorId,
      before,
      {},
      now,
    );

    return before;
  }

  /**
   * `POST /members/:id/restore` — clears `deletedAt`, the undo for `remove`.
   *
   * Cannot go through `findOne`: that filters `deletedAt: null`, so the only
   * rows this route ever acts on are exactly the ones it cannot see. It uses
   * `reachWithoutDeletedGuard` for the same reason `list({ deleted: true })`
   * does — keep the caller's OWN/ALL REACH, drop only the deletedAt clause
   * `@Scope('user')` folds in unconditionally (§4.4) — and then re-reads
   * through `findOne` afterwards, which by then finds the restored row.
   *
   * A scoped miss is still a 404, and it is checked BEFORE the "was it
   * actually deleted" 422: a 422 on a row the caller cannot reach would
   * confirm the row exists, which is the enumeration oracle `findOne`'s doc
   * comment exists to prevent.
   */
  async restore(
    id: string,
    actor: AccountActor,
    scope: ScopedWhere<Prisma.UserWhereInput>,
    now: Date = new Date(),
  ): Promise<MemberListItem> {
    const actorId = actor.id;
    const row = await this.prisma.user.findFirst({
      where: { AND: [{ id }, reachWithoutDeletedGuard(scope)] },
      select: { id: true, email: true, deletedAt: true, role: true, status: true },
    });
    if (row === null) {
      throw new DomainException('MEMBER_NOT_FOUND', 'Member not found', HttpStatus.NOT_FOUND);
    }
    // A member's OWN deletion (POST /me/delete-account) anonymised the row and
    // erased their sign-in — there is no person left to put back (owner,
    // 2026-10-23). Only a staff soft-delete is restorable.
    if (isSelfDeleted(row)) {
      throw new DomainException(
        'MEMBER_SELF_DELETED',
        'This member deleted their own account. It cannot be restored.',
        HttpStatus.CONFLICT,
      );
    }
    if (row.deletedAt === null) {
      throw new DomainException(
        'MEMBER_NOT_DELETED',
        'This member is not deleted.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Putting a deleted ADMIN back is making somebody an admin, which only
    // the Super Admin does — the same hierarchy as delete, in reverse.
    await this.accountActionUnderRules(
      actor,
      hierarchyTarget({ id: row.id, role: row.role, status: row.status, deletedAt: row.deletedAt }),
      'restore',
      (db) => db.user.update({ where: { id }, data: { deletedAt: null } }),
    );
    const restored = await this.findOne(id, scope, now);

    await this.recordAccountAction(
      'MEMBER_RESTORED',
      actorId,
      restored,
      {},
      now,
    );

    return restored;
  }

  /**
   * `POST /members/:id/role`.
   *
   * The self-guard runs BEFORE the existence/scope check, and touches no
   * table — same order as `CoachAssignmentsService.create`'s self-assignment
   * guard, and for the same reason: it is true or false from the two ids
   * alone, so there is nothing a database round-trip could add.
   */
  async changeRole(
    id: string,
    dto: ChangeRoleDto,
    actor: AccountActor,
    scope: ScopedWhere<Prisma.UserWhereInput>,
    now: Date = new Date(),
  ): Promise<MemberListItem> {
    const actorId = actor.id;
    if (id === actorId) {
      throw new DomainException(
        SELF_REFUSALS.role.code,
        SELF_REFUSALS.role.message,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const before = await this.findOne(id, scope, now);
    assertNotDev(before, 'given a different role');

    // Only below your own role, on an account below your own role — so an
    // ADMIN manages members, front desk and coaches, and only the Super Admin
    // (DEV) makes, unmakes or changes an ADMIN. Never the last active one.
    const target = hierarchyTarget(before);
    await this.underRoleRules(
      target,
      (activeAdmins) => roleChangeRefusal({ actor, target, newRole: dto.role, activeAdmins }),
      SELF_REFUSALS.role,
      (db) => db.user.update({ where: { id }, data: { role: dto.role } }),
    );

    // Before AND after. "Role changed" without the pair is the entry somebody
    // has to reconstruct from surrounding rows, which defeats the point.
    await this.recordAccountAction(
      'ROLE_CHANGED',
      actorId,
      before,
      { reason: dto.reason ?? null, details: { before: before.role, after: dto.role } },
      now,
    );

    return this.findOne(id, scope, now);
  }

  /**
   * `POST /members` — C2. In order: validate DTO (done by the pipe before
   * this runs) → mint a Supabase user (`createAuthUser`, no link) → create
   * the `User` row with that `supabaseId` inside a transaction → the optional
   * plan sale → issue our setup link (`MemberJoinService.issue`) AFTER the
   * commit and the optional sale.
   *
   * A mail outage is never a reason to lose a member: if the link or its
   * email fails, the member row and its Supabase user already exist, so this
   * returns `{ member, emailSent: false }` rather than throwing — the UI
   * offers "resend invite" (`resendInvite` below) for exactly that case.
   *
   * A failed plan sale gets the SAME non-throwing treatment, for the same
   * reason: by the time `sales.sell` runs, the member row is already
   * committed, so a bare throw would hand the desk a generic error with no
   * reference to the member that just got created — leaving them to hunt for
   * a "planless" row, and a retry would 409 on the now-taken email. Instead
   * this returns `{ member, emailSent, planSaleError: { code, message } }`
   * (absent on success) — the desk sees exactly which member to go finish
   * selling a plan to, via `POST /memberships`. The setup link is still
   * sent regardless of the sale outcome: the member exists either way.
   *
   * `User.supabaseId` is non-nullable (see `SupabaseAdminService`'s doc
   * comment), which is why this cannot be a plain `prisma.user.create` the
   * way `UserProvisioningService` is — that path only ever runs AFTER
   * Supabase already has the identity.
   */
  async create(
    dto: CreateMemberDto,
    actor: AuthUser,
    requestOrigin?: string,
    now: Date = new Date(),
  ): Promise<CreateMemberResult> {
    // Gated separately from `@RequirePermission('member.create')`: this
    // route can also record a sale, and a role holding member.create alone
    // must not be able to move money through it. Checked first, before
    // minting anything, so a caller who lacks it never causes a Supabase
    // side effect.
    if (dto.plan) {
      const held = await this.permissions.getEffectivePermissions(actor);
      if (!held.some((permission) => permission.key === 'membership.sell')) {
        throw new ForbiddenException(
          'membership.sell is required to assign a plan at creation.',
        );
      }
    }

    // A pre-check, not the only guard: `User_email_key`'s unique constraint
    // (mapped to the same MEMBER_EMAIL_TAKEN code by prisma-error.mapper.ts)
    // is the real backstop against two concurrent creates racing the same
    // email. Checked before calling Supabase so a known collision never
    // wastes a mint.
    const existing = await this.prisma.user.findFirst({ where: { email: dto.email } });
    if (existing) {
      throw new DomainException(
        'MEMBER_EMAIL_TAKEN',
        'A member with this email already exists.',
        HttpStatus.CONFLICT,
      );
    }

    // Checked before the Supabase mint for the same reason the email is: a
    // known-bad lead reference must not leave an orphaned auth identity.
    let lead: { id: string; convertedAt: Date | null } | null = null;
    if (dto.leadId !== undefined) {
      const found = await this.prisma.lead.findUnique({
        where: { id: dto.leadId },
        select: { id: true, convertedUserId: true, convertedAt: true },
      });
      if (found === null) {
        throw new DomainException(
          'LEAD_NOT_FOUND',
          'That enquiry no longer exists.',
          HttpStatus.NOT_FOUND,
        );
      }
      if (found.convertedUserId !== null) {
        throw new DomainException(
          'LEAD_ALREADY_CONVERTED',
          'That enquiry has already been converted to a member.',
          HttpStatus.CONFLICT,
        );
      }
      lead = { id: found.id, convertedAt: found.convertedAt };
    }

    const auth = await this.supabaseAdmin.createAuthUser(dto.email);

    // The identity is minted BEFORE the local row exists (supabaseId is
    // non-nullable), so every failure between here and the commit leaves a
    // Supabase Auth user with nothing pointing at it — and the next create
    // for that email fails "already been registered" forever after, with the
    // desk having no way to see why. Undo the mint, then rethrow the ORIGINAL
    // failure: the cleanup is housekeeping, never the error the caller sees.
    let created: { id: string };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            supabaseId: auth.userId,
            email: dto.email,
            firstName: dto.firstName,
            lastName: dto.lastName,
            phone: dto.phone ?? null,
            emergencyContact: dto.emergencyContact ?? null,
            role: Role.CLIENT,
          },
        });
        if (lead !== null) {
          // Same transaction as the account: a member without their lead
          // marked, or a converted lead pointing at nobody, are both funnel
          // lies. `Lead_converted_shape` pairs status with convertedAt; the
          // original convertedAt survives if staff pressed "Joined" earlier.
          await tx.lead.update({
            where: { id: lead.id },
            data: {
              status: 'CONVERTED',
              convertedAt: lead.convertedAt ?? now,
              convertedUserId: user.id,
            },
          });
        }
        if (dto.fromCheckInId !== undefined) {
          // updateMany, not update: the guard is in the WHERE clause, so a
          // visit that is not a guest visit (or does not exist) is a no-op
          // rather than an exception that would roll back the whole account.
          // `CheckIn_converted_guest_only` enforces the same rule in the
          // database; this keeps a mistyped id from costing the member.
          await tx.checkIn.updateMany({
            where: { id: dto.fromCheckInId, userId: null, convertedToUserId: null },
            data: { convertedToUserId: user.id },
          });
        }
        return user;
      });
    } catch (err) {
      try {
        await this.supabaseAdmin.deleteUser(auth.userId);
      } catch (cleanupErr) {
        // ERROR, not warn: this is the one branch that leaves persistent
        // cross-system garbage, and the orphaned id is the only handle an
        // operator has to clean it up by hand.
        this.logger.error(
          `Orphaned Supabase user ${auth.userId} (${dto.email}): local member create failed ` +
            `and the auth cleanup failed too: ${String(cleanupErr)}`,
        );
      }
      throw err;
    }

    // Optional — "walk-in signs up and pays" in one submit. Caught, not
    // rethrown: the member row is not rolled back (it was already committed
    // above), so a bare throw here would hand the desk an error with no way
    // to find the member it's about. See `describePlanSaleError` and this
    // method's doc comment for the reasoning.
    let planSaleError: { code: string; message: string } | undefined;
    if (dto.plan) {
      try {
        await this.sales.sell(actor, { ...dto.plan, userId: created.id }, randomUUID(), now);
      } catch (err) {
        planSaleError = describePlanSaleError(err);
        this.logger.warn(`Plan sale failed for member ${created.id}: ${String(err)}`);
      }
    }

    // AFTER the plan sale, so the email can say which plan is waiting for them.
    // Caught for the same reason a failed sale is: the member is already
    // committed, and "Resend invite" issues a fresh link.
    let emailSent = false;
    try {
      emailSent = await this.memberJoin.issue(
        { userId: created.id, issuedById: actor.id, requestOrigin },
        now,
      );
    } catch (err) {
      this.logger.warn(`Setup link failed for member ${created.id}: ${String(err)}`);
    }

    const member = await this.memberView(created.id, now);
    return planSaleError === undefined ? { member, emailSent } : { member, emailSent, planSaleError };
  }

  /**
   * `POST /members/:id/resend-invite` — rotates the member's setup link and
   * emails it; the previous link dies at once. Refused (409, from
   * `MemberJoinService.issue`) for a member who has ever signed in: a link is a
   * way into the account, and they have "Forgot password". Refused the same way
   * for a staff account, which is set up from Staff & Access.
   */
  async resendInvite(
    id: string,
    scope: ScopedWhere<Prisma.UserWhereInput>,
    actor: AuthUser,
    requestOrigin?: string,
    now: Date = new Date(),
  ): Promise<{ member: MemberListItem; emailSent: boolean }> {
    const member = await this.findOne(id, scope, now);
    const emailSent = await this.memberJoin.issue(
      { userId: member.userId, issuedById: actor.id, requestOrigin },
      now,
    );
    return { member, emailSent };
  }

  /**
   * `POST /members/:id/change-email` — the counter typed the address wrong, so
   * the setup link went nowhere. Only for a member who has NEVER signed in: an
   * active member's login email is theirs to change, not the desk's, and this
   * route must never become a way to point somebody's account at another inbox.
   * For the same reason it never touches a staff account (`CLIENT` only): a desk
   * login could otherwise move a fresh staff login to its own inbox and claim it.
   *
   * Supabase first, because that is the address the member will sign in with;
   * then our row, with the unused setup link deleted alongside it. If that write
   * fails (another member took the address a moment ago — `User_email_key`),
   * Supabase is put back, so the two never disagree.
   */
  async changeEmail(
    id: string,
    email: string,
    scope: ScopedWhere<Prisma.UserWhereInput>,
    actor: AuthUser,
    requestOrigin?: string,
    now: Date = new Date(),
  ): Promise<{ member: MemberListItem; emailSent: boolean }> {
    const row = await this.prisma.user.findFirst({
      where: { AND: [{ id, deletedAt: null }, scope] },
      select: {
        id: true,
        supabaseId: true,
        email: true,
        firstName: true,
        lastName: true,
        memberCode: true,
        role: true,
        lastSeenAt: true,
      },
    });
    if (row === null) {
      throw new DomainException('MEMBER_NOT_FOUND', 'Member not found', HttpStatus.NOT_FOUND);
    }
    if (row.role !== Role.CLIENT) throw staffAccount();
    if (row.lastSeenAt !== null) throw alreadySignedIn();
    if (row.email === email) {
      throw new DomainException(
        'MEMBER_EMAIL_TAKEN',
        'That is already their email.',
        HttpStatus.CONFLICT,
      );
    }
    const holder = await this.prisma.user.findFirst({
      where: { email, NOT: { id: row.id } },
      select: { id: true },
    });
    if (holder !== null) {
      throw new DomainException(
        'MEMBER_EMAIL_TAKEN',
        'A member with this email already exists.',
        HttpStatus.CONFLICT,
      );
    }

    await this.supabaseAdmin.updateAuthEmail(row.supabaseId, email);
    try {
      // The old link went to the MISTYPED address — possibly a stranger's inbox —
      // and a claim reads the member's email fresh, so it would mint a sign-in
      // into the corrected account. It dies with the change, in the same
      // transaction: never left alive by a failure further down.
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: row.id }, data: { email } });
        await tx.memberJoinLink.deleteMany({ where: { userId: row.id, usedAt: null } });
      });
    } catch (err) {
      try {
        await this.supabaseAdmin.updateAuthEmail(row.supabaseId, row.email);
      } catch (revertErr) {
        this.logger.error(
          `Supabase user ${row.supabaseId} now has ${email} but the member row kept ${row.email}: ` +
            `the local update failed and the revert failed too: ${String(revertErr)}`,
        );
      }
      throw err;
    }

    await this.recordAccountAction(
      'MEMBER_EMAIL_CHANGED',
      actor.id,
      {
        userId: row.id,
        firstName: row.firstName,
        lastName: row.lastName,
        memberCode: row.memberCode,
      },
      { details: { before: row.email, after: email } },
      now,
    );

    // Caught, like `create`: the address has changed and the old link is dead
    // either way, so a failed issue is "Resend invite", never a 500.
    let emailSent = false;
    try {
      emailSent = await this.memberJoin.issue(
        { userId: row.id, issuedById: actor.id, requestOrigin },
        now,
      );
    } catch (err) {
      this.logger.warn(`Setup link failed for member ${row.id}: ${String(err)}`);
    }
    return { member: await this.findOne(id, scope, now), emailSent };
  }

  /** The projection every write route above re-reads through `findOne`'s
   *  scope; `create` has no caller-supplied scope to check against (there is
   *  no existing row to be out of reach of), so it reads the fresh row
   *  directly instead. */
  private async memberView(id: string, now: Date): Promise<MemberListItem> {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id }, include: MEMBER_INCLUDE });
    return toMemberListItem(row, gymToday(now, this.gym.timeZone), {
      expiringSoonDays: this.gym.expiringSoonDays,
      graceAdmissionsMax: this.gym.graceAdmissionsMax,
    });
  }
}

/**
 * `@Scope('user')` always folds `deletedAt: null` into its result (§4.4 —
 * "regardless of scope reach"), which is correct for every read except the
 * CRM's own "show deleted" toggle: that one needs the caller's OWN/ALL REACH
 * with the deletedAt clause left to `filters` instead (see `list()` above).
 *
 * The `ScopedWhere` brand blocks the ordinary `{ ...scope }` spread
 * (scope-contract.spec.ts) but not an explicit cast back to the plain
 * `Prisma.UserWhereInput` it always is underneath — scope.util.ts's own
 * comment names this exact form as the documented, un-blocked escape hatch.
 * Used here, and nowhere else in the codebase.
 */
function reachWithoutDeletedGuard(
  scope: ScopedWhere<Prisma.UserWhereInput>,
): Prisma.UserWhereInput {
  const { deletedAt: _deletedAt, ...reach } = scope as Prisma.UserWhereInput;
  return reach;
}

/**
 * The self-guard `changeRole` has always had, factored out for the three
 * routes that were missing it. Runs BEFORE any read and touches no table —
 * it is true or false from the two ids alone, so a database round-trip could
 * add nothing (same order and reasoning as
 * `CoachAssignmentsService.create`'s self-assignment guard).
 *
 * Why every one of the four: `member.suspend` and `member.delete` are held at
 * ALL by ADMIN, and an admin who suspends or deletes themselves is locked out
 * of the console with no route left to undo it. `reactivate` is guarded too
 * for symmetry — a caller can never be suspended AND making this call, so it
 * can only ever be a mis-click on their own row.
 */
function assertNotSelf(
  id: string,
  actorId: string,
  code: 'MEMBER_SELF_SUSPEND' | 'MEMBER_SELF_REACTIVATE' | 'MEMBER_SELF_DELETE',
  message: string,
): void {
  if (id === actorId) {
    throw new DomainException(code, message, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

/**
 * The "never yourself" refusal for each account action, in the words each
 * route has always used. The role hierarchy returns `SELF`; these say it.
 * Restore can never actually be self-inflicted (a deleted account cannot
 * authenticate), so it borrows delete's code rather than minting one.
 */
const SELF_REFUSALS: Record<AccountAction | 'role', { code: DomainErrorCode; message: string }> = {
  role: { code: 'ROLE_SELF_CHANGE', message: 'You cannot change your own role.' },
  suspend: { code: 'MEMBER_SELF_SUSPEND', message: 'You cannot suspend yourself.' },
  reactivate: { code: 'MEMBER_SELF_REACTIVATE', message: 'You cannot reactivate yourself.' },
  delete: { code: 'MEMBER_SELF_DELETE', message: 'You cannot delete your own account.' },
  restore: { code: 'MEMBER_SELF_DELETE', message: 'You cannot restore your own account.' },
};

/**
 * A member row as the role hierarchy sees it. "Active" is what the last-admin
 * rule counts: status ACTIVE and not soft-deleted — a suspended or deleted
 * ADMIN is nobody the gym can hand the console to.
 */
function hierarchyTarget(member: {
  userId?: string;
  id?: string;
  role: Role;
  status: string;
  deletedAt: Date | string | null;
}): HierarchyTarget {
  return {
    id: member.userId ?? member.id ?? '',
    role: member.role,
    active: member.status === UserStatus.ACTIVE && member.deletedAt === null,
  };
}

/**
 * DEV is seed/DB-only (enums.prisma) — `ASSIGNABLE_ROLES` already keeps any
 * DTO from GRANTING it, but nothing stopped an HTTP caller from taking it
 * AWAY: `POST /members/:id/role` on a DEV row demoted the break-glass account
 * to CLIENT, and suspend/delete could put it out of reach entirely.
 *
 * Called AFTER `findOne`, never before, so a caller who cannot reach the row
 * still gets `MEMBER_NOT_FOUND` (404) rather than this 422 — a 422 here would
 * confirm the row exists and name its role, which is precisely the
 * enumeration oracle the 404-not-403 rule exists to close.
 */
function assertNotDev(target: MemberListItem, verb: string): void {
  if (target.role === Role.DEV) {
    throw new DomainException(
      'MEMBER_DEV_PROTECTED',
      `A DEV account cannot be ${verb} through this API.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * `create()`'s `planSaleError` shaping. `MembershipSalesService.sell` throws
 * a `DomainException` for every EXPECTED failure (bad plan code, no open
 * shift, a declined discount, …) — those carry the real `code`/`message` a
 * desk console can show verbatim. Anything else (a genuinely unmapped bug, a
 * network blip) gets a generic code rather than leaking an internal message
 * as if it were a named domain error.
 */
function describePlanSaleError(err: unknown): { code: string; message: string } {
  if (err instanceof DomainException) {
    return { code: err.code, message: err.message };
  }
  return {
    code: 'PLAN_SALE_FAILED',
    message: err instanceof Error ? err.message : 'The plan could not be sold.',
  };
}

const MEMBER_INCLUDE = {
  membership: {
    // The nullable-unique sentinel: at most one row can carry it, so `take: 1`
    // is a statement of fact rather than a truncation.
    include: { holds: { where: { activeMembershipId: { not: null } }, take: 1 } },
  },
  _count: { select: { checkIns: true } },
} as const;

/**
 * Two orders, one of which is a business artefact.
 *
 * `recent` — newest first: a CRM's default question is "who joined
 * recently", and an alphabetical default buries every new member on page 14.
 *
 * `ending` — the RENEWAL CALL SHEET, in the order it gets worked. This is
 * what the Subscriptions screen was for before it merged into this list.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NULLS LAST IS POSTGRES'S DEFAULT FOR ASC, AND IT IS LOAD-BEARING HERE.
 *
 * `User.membership` is a to-one OPTIONAL relation, so a member who never
 * bought a plan sorts on a NULL `endsOn`. Postgres puts NULLs last on an ASC
 * ordering, which is exactly what a call sheet wants — planless members sink
 * below everybody with a date. Prisma exposes no `nulls` option for a
 * RELATION ordering (only for a scalar), so this is not something the query
 * can state; `test/members.e2e-spec.ts` asserts the resulting order against a
 * real database rather than trusting the note.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Both end in `{ id: 'asc' }`: without a unique tiebreaker two rows with the
 * same date can swap places between page 1 and page 2, which silently drops
 * one member and repeats another across a paginated call sheet.
 */
function memberOrderBy(sort: MemberSort | undefined): Prisma.UserOrderByWithRelationInput[] {
  return sort === 'ending'
    ? [{ membership: { endsOn: 'asc' } }, { id: 'asc' }]
    : [{ createdAt: 'desc' }, { id: 'asc' }];
}

/**
 * Case-insensitive across the four handles a staffer actually has in front of
 * them. `phone` is included because "somebody is on the phone asking about
 * their plan" is the most common real use of this list.
 */
export function searchClauses(search: string): Prisma.UserWhereInput[] {
  const mode = 'insensitive' as const;
  const clauses: Prisma.UserWhereInput[] = [
    { firstName: { contains: search, mode } },
    { lastName: { contains: search, mode } },
    { memberCode: { contains: search, mode } },
    { email: { contains: search, mode } },
    // The raw text still finds legacy rows stored as typed ("0917 123 4567").
    { phone: { contains: search, mode } },
  ];
  const digits = phoneSearchDigits(search);
  if (digits !== null && digits !== search) clauses.push({ phone: { contains: digits } });
  return clauses;
}

/**
 * New phones are stored as +639XXXXXXXXX, so "0917 123 4567" typed at the desk
 * must search as "639171234567": digits only, a leading 0 becomes 63, a
 * leading 63 stays, anything else is matched as a substring. Null when the
 * search has too few digits to be a phone fragment.
 */
export function phoneSearchDigits(search: string): string | null {
  if (/[A-Za-z@]/.test(search)) return null;
  const digits = search.replace(/\D/g, '');
  if (digits.length < 4) return null;
  return digits.startsWith('0') ? `63${digits.slice(1)}` : digits;
}

/**
 * The CRM's four-way standing filter, expressed entirely in DATES.
 *
 * `EXPIRING` is not a stored status and must never become one: it is `endsOn`
 * inside the configured window, derived from columns already on the row. A
 * stored value would be a second source of truth that a missed nightly run
 * falsifies — which is exactly why `MembershipStatus` has four values and not
 * five.
 */
function standingWhere(
  standing: MemberStanding | undefined,
  today: CivilDate,
  expiringSoonDays: number,
): Prisma.UserWhereInput {
  switch (standing) {
    case 'NONE':
      return { membership: null };
    case 'ACTIVE':
      return { membership: { endsOn: { gte: toDateColumn(today) } } };
    case 'EXPIRING':
      return {
        membership: {
          endsOn: {
            gte: toDateColumn(today),
            lte: toDateColumn(addDays(today, expiringSoonDays)),
          },
        },
      };
    case 'EXPIRED':
      return { membership: { endsOn: { lt: toDateColumn(today) } } };
    default:
      return {};
  }
}
