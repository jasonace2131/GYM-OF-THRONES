import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser, SupabaseClaims } from './auth.types';

/** The only columns the request pipeline needs. Keeps the per-request read narrow. */
const AUTH_USER_FIELDS = {
  id: true,
  supabaseId: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  status: true,
  permissionVersion: true,
  heightCm: true,
  weightKg: true,
  // AuthGuard rejects on this. A "deleted" member otherwise keeps a valid
  // session and keeps checking themselves in at the station.
  deletedAt: true,
} as const;

/** The read shape: AUTH_USER_FIELDS plus the column the throttle decision needs. */
const RESOLVE_FIELDS = { ...AUTH_USER_FIELDS, lastSeenAt: true } as const;

/**
 * How stale `lastSeenAt` is allowed to get before it is rewritten.
 *
 * A value accurate to a quarter hour is worth exactly as much as one accurate
 * to the second, and costs a fraction of the writes at the 05:00-07:00 peak
 * when every arriving member's phone hits this path.
 */
export const LAST_SEEN_THROTTLE_MS = 900_000;

type ResolvedRow = AuthUser & { lastSeenAt: Date | null };

@Injectable()
export class UserProvisioningService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Maps verified Supabase claims to the local user, creating the row the
   * first time this identity is seen.
   *
   * A user can exist in Supabase Auth before this API has ever seen them —
   * they signed up, confirmed their email, and only then made a request. This
   * is self-healing and needs no webhook.
   *
   * Read first, write only when there is something to write. AuthGuard calls
   * this on EVERY authenticated request, ahead of the throttler, so an
   * unconditional upsert makes every request a write — and, worse, silently
   * resurrects a soft-deleted account by touching its row.
   *
   * `role` and `status` appear in no branch, and that is deliberate: they are
   * ours to control, and a token claim must never be able to set or reset
   * them. New rows take the schema defaults (CLIENT / ACTIVE).
   *
   * Body metrics are written on create only. After the account exists they are
   * profile data the person edits directly — re-applying stale sign-up values
   * on every request would silently revert a weight they had just corrected.
   */
  async resolve(claims: SupabaseClaims): Promise<AuthUser> {
    const existing = await this.prisma.user.findUnique({
      where: { supabaseId: claims.sub },
      select: RESOLVE_FIELDS,
    });

    if (!existing) {
      // First sight of this identity. Upsert rather than create so two
      // concurrent first requests cannot race into a unique violation.
      return this.prisma.user.upsert({
        where: { supabaseId: claims.sub },
        create: {
          supabaseId: claims.sub,
          email: claims.email,
          firstName: claims.firstName,
          lastName: claims.lastName,
          phone: claims.phone,
          heightCm: claims.heightCm,
          weightKg: claims.weightKg,
          // Written on FIRST SIGHT ONLY, like the name and the metrics. A
          // birthday does not change, so a later token claiming a different
          // one is either a typo being corrected — which staff should do
          // through the CRM, where it is audited — or an attempt to age into
          // a membership. `@db.Date` wants UTC midnight for a civil date.
          dateOfBirth:
            claims.dateOfBirth === null ? null : new Date(`${claims.dateOfBirth}T00:00:00.000Z`),
          lastSeenAt: new Date(),
        },
        update: {
          // Email can change in Supabase; keep our copy current.
          email: claims.email,
          lastSeenAt: new Date(),
        },
        select: AUTH_USER_FIELDS,
      });
    }

    // A soft-deleted row is never touched. AuthGuard rejects the request a
    // moment later; writing anything here would resurrect the account by its
    // owner's own next request.
    if (existing.deletedAt) {
      return stripLastSeen(existing);
    }

    const now = new Date();
    const emailChanged = existing.email !== claims.email;
    const lastSeenStale =
      existing.lastSeenAt === null ||
      now.getTime() - existing.lastSeenAt.getTime() >= LAST_SEEN_THROTTLE_MS;

    if (!emailChanged && !lastSeenStale) {
      return stripLastSeen(existing);
    }

    return this.prisma.user.update({
      where: { supabaseId: claims.sub },
      data: { email: claims.email, lastSeenAt: now },
      select: AUTH_USER_FIELDS,
    });
  }
}

function stripLastSeen(row: ResolvedRow): AuthUser {
  const { lastSeenAt: _lastSeenAt, ...user } = row;
  return user;
}
