import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { ActiveSession, AuthUser, SupabaseClaims } from './auth.types';
import { ageRequirementNotMet, isOldEnoughForAccount } from './minimum-age';

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

/**
 * The account's one current sign-in, for SingleSessionService. Read in the SAME
 * query as the user, so the one-device rule adds no query to a request. Never
 * part of AuthUser: `@CurrentUser()` hands that to controllers, and these are
 * not something any response should carry.
 */
const ACTIVE_SESSION_FIELDS = { activeSessionId: true, activeSessionSignedInAt: true } as const;

/** What every query here selects: AUTH_USER_FIELDS plus the account's current sign-in. */
const SESSION_USER_FIELDS = { ...AUTH_USER_FIELDS, ...ACTIVE_SESSION_FIELDS } as const;

/** The read shape: SESSION_USER_FIELDS plus the column the throttle decision needs. */
const RESOLVE_FIELDS = { ...SESSION_USER_FIELDS, lastSeenAt: true } as const;

/**
 * How stale `lastSeenAt` is allowed to get before it is rewritten.
 *
 * A value accurate to a quarter hour is worth exactly as much as one accurate
 * to the second, and costs a fraction of the writes at the 05:00-07:00 peak
 * when every arriving member's phone hits this path.
 */
export const LAST_SEEN_THROTTLE_MS = 900_000;

type SessionUserRow = AuthUser & {
  activeSessionId: string | null;
  activeSessionSignedInAt: Date | null;
};

/** One request's user, and the sign-in that currently holds the account. */
export interface ResolvedAuth {
  user: AuthUser;
  activeSession: ActiveSession;
}

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
   *
   * Nobody under 12 gets a row (owner, 2026-10-30). The Supabase identity
   * already exists by now (the browser made it with the public key), so this
   * is the first place the API can say no.
   */
  async resolve(claims: SupabaseClaims): Promise<AuthUser> {
    return (await this.resolveWithActiveSession(claims)).user;
  }

  /**
   * `resolve`, plus the account's current sign-in (the one-device rule). Both
   * come from the same single read of the User row, so the guards that
   * enforce the rule pay no extra query for it. Nothing here writes the active
   * sign-in: SingleSessionService does, and only after the emailed code is
   * satisfied.
   */
  async resolveWithActiveSession(claims: SupabaseClaims): Promise<ResolvedAuth> {
    const existing = await this.prisma.user.findUnique({
      where: { supabaseId: claims.sub },
      select: RESOLVE_FIELDS,
    });

    if (!existing) {
      // FIRST SIGHT ONLY: an account already on file is never refused, whatever
      // its date says. A token with no date (a staff invitation, a dashboard
      // user) is not judged. Nothing is written, so every later sign-in is
      // refused the same way until they turn 12. AuthGuard passes this 403
      // through so the sign-in page can say why.
      if (claims.dateOfBirth !== null && !isOldEnoughForAccount(claims.dateOfBirth)) {
        throw ageRequirementNotMet(HttpStatus.FORBIDDEN);
      }

      // First sight of this identity. Upsert rather than create so two
      // concurrent first requests cannot race into a unique violation.
      const created = await this.prisma.user.upsert({
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
        select: SESSION_USER_FIELDS,
      });
      return split(created);
    }

    // A soft-deleted row is never touched. AuthGuard rejects the request a
    // moment later; writing anything here would resurrect the account by its
    // owner's own next request.
    if (existing.deletedAt) {
      return split(existing);
    }

    const now = new Date();
    const emailChanged = existing.email !== claims.email;
    const lastSeenStale =
      existing.lastSeenAt === null ||
      now.getTime() - existing.lastSeenAt.getTime() >= LAST_SEEN_THROTTLE_MS;

    if (!emailChanged && !lastSeenStale) {
      return split(existing);
    }

    const updated = await this.prisma.user.update({
      where: { supabaseId: claims.sub },
      data: { email: claims.email, lastSeenAt: now },
      select: SESSION_USER_FIELDS,
    });
    return split(updated);
  }
}

/** Separates the row into the AuthUser and the active sign-in, dropping `lastSeenAt`. */
function split(row: SessionUserRow & { lastSeenAt?: Date | null }): ResolvedAuth {
  const { lastSeenAt: _lastSeenAt, activeSessionId, activeSessionSignedInAt, ...user } = row;
  return {
    user,
    activeSession: {
      sessionId: activeSessionId ?? null,
      signedInAt: activeSessionSignedInAt ?? null,
    },
  };
}
