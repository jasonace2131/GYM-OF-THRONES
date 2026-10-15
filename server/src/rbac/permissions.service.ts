import { Injectable, Logger } from '@nestjs/common';
import type { PermissionScope, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { EffectivePermission, PermissionUser } from './rbac.types';
import { buildScopeWhere, type ScopeSubject, type ScopedWhere } from './scope.util';

const CACHE_TTL_MS = 60_000;

/**
 * Every bump of permissionVersion orphans the previous entry permanently, and
 * every member's phone is a client of this API — POST /checkin resolves a
 * DIFFERENT user's set on every arrival, so the 05:00-07:00 working set is the
 * whole gym rather than the two people on the desk. 2,000 entries is more than
 * the roster and small enough to be uninteresting in memory.
 */
export const PERMISSION_CACHE_MAX_ENTRIES = 2000;

interface CacheEntry {
  expiresAt: number;
  permissions: readonly EffectivePermission[];
}

/**
 * Resolves a user's effective permissions and caches the result.
 *
 * Cache key is `{userId}:{role}:{permissionVersion}`. `role` is in the key
 * because a demotion changes the answer without changing the version until the
 * bump lands in the same transaction — and for the length of one TTL a demoted
 * ADMIN would otherwise keep the ADMIN set. It costs nothing: `role` is already
 * on AuthUser.
 *
 * The Map is a bounded LRU: a hit re-inserts its key so Map insertion order is
 * recency order, and a miss on a full cache drops the coldest entry.
 *
 * Phase 2 only: resolution is role permissions plus the DEV bypass.
 * Per-user overrides (UserPermission, DENY-beats-GRANT) land in Phase 3.
 *
 * The resolved array is frozen before it is cached: one entry is handed to
 * every caller within the TTL window — including `GET /me`, which puts it
 * straight into a response body — so an in-place mutation anywhere
 * downstream would corrupt the cache for everyone.
 */
@Injectable()
export class PermissionsService {
  private readonly logger = new Logger(PermissionsService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  async getEffectivePermissions(user: PermissionUser): Promise<readonly EffectivePermission[]> {
    const cacheKey = `${user.id}:${user.role}:${user.permissionVersion}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      // Re-insert to mark it most-recently-used.
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return cached.permissions;
    }

    let permissions: EffectivePermission[];
    if (user.role === 'DEV') {
      // Interim audit trail for the superuser escape hatch until Phase 4's
      // AuditLog lands. Cache miss only, so it is one line per TTL window,
      // not one per request.
      this.logger.warn(`DEV bypass: user ${user.id} resolved all catalogue permissions`);
      permissions = await this.getAllCataloguePermissions();
    } else {
      permissions = await this.getRolePermissions(user.role);
    }

    const frozen = Object.freeze(permissions);
    this.setCached(cacheKey, { expiresAt: now + CACHE_TTL_MS, permissions: frozen });
    return frozen;
  }

  /** Insert, evicting the least-recently-used entry when the cache is full. */
  private setCached(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    if (this.cache.size >= PERMISSION_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) {
        this.cache.delete(oldest.value);
      }
    }
    this.cache.set(key, entry);
  }

  /**
   * The widest scope the caller holds for `key`.
   *
   * Implements the RBAC design's §6 `scope(k) = max(scope)`, so a phase-3
   * UserPermission GRANT at ALL wins over a role default at OWN with no change
   * here.
   */
  async resolveScope(user: PermissionUser, key: string): Promise<PermissionScope> {
    const held = (await this.getEffectivePermissions(user)).filter((p) => p.key === key);
    if (held.length === 0) {
      // PermissionsGuard already let this request through, so we were asked for
      // a different key than the decorator declared. A wiring bug, not a client
      // error — hence a plain Error and a 500, not a 403.
      throw new Error(`scopeFilter('${key}') on a route that does not require it`);
    }
    return held.some((p) => p.scope === 'ALL') ? 'ALL' : 'OWN';
  }

  /**
   * The `where` fragment a scoped repository method must AND into its query.
   *
   * The subject argument is required and has no default: two arguments cannot
   * produce a correct `where` for User, for a userId-owned row and for
   * CoachAssignment — those are three shapes, and a wrong default widens a
   * query silently.
   */
  async scopeFilter(
    user: PermissionUser,
    key: string,
    subject: 'user',
  ): Promise<ScopedWhere<Prisma.UserWhereInput>>;
  async scopeFilter(
    user: PermissionUser,
    key: string,
    subject: 'ownedByUser',
  ): Promise<ScopedWhere<object>>;
  async scopeFilter(
    user: PermissionUser,
    key: string,
    subject: 'coachAssignment',
  ): Promise<ScopedWhere<Prisma.CoachAssignmentWhereInput>>;
  async scopeFilter(
    user: PermissionUser,
    key: string,
    subject: 'coachedMember',
  ): Promise<ScopedWhere<Prisma.UserWhereInput>>;
  async scopeFilter(user: PermissionUser, key: string, subject: ScopeSubject): Promise<object> {
    const scope = await this.resolveScope(user, key);
    return buildScopeWhere(scope, subject, user.id);
  }

  /** DEV is a superuser escape hatch — every catalogue key, full reach. */
  private async getAllCataloguePermissions(): Promise<EffectivePermission[]> {
    const rows = await this.prisma.permission.findMany({ select: { key: true } });
    return rows.map((row) => ({ key: row.key, scope: 'ALL' as const }));
  }

  private async getRolePermissions(role: PermissionUser['role']): Promise<EffectivePermission[]> {
    const rows = await this.prisma.rolePermission.findMany({
      where: { role },
      select: { scope: true, permission: { select: { key: true } } },
    });
    return rows.map((row) => ({ key: row.permission.key, scope: row.scope }));
  }
}
