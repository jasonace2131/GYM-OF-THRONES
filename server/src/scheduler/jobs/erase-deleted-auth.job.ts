import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SupabaseAdminService } from '../../auth/supabase-admin.service';
import { eraseAuthIdentity, isSelfDeleted } from '../../users/auth-erasure';
import type { ScheduledJob } from '../scheduler.service';

/** One run's ceiling. A backlog drains over a few runs, never in one burst. */
export const ERASE_BATCH = 50;

/**
 * Finishes a member's self-deletion when Supabase was down at the time.
 *
 * `POST /me/delete-account` erases the personal data locally FIRST and deletes
 * the Supabase identity LAST; when that last call fails the request still
 * succeeds, and the row is left with `authErasedAt` NULL. This retries every
 * such row until Supabase deletes the identity or answers "not found" (which
 * `deleteAccountIdentity` counts as done).
 *
 * Self-deleted rows only — the email is the `@deleted.invalid` placeholder.
 * A STAFF soft-delete keeps its real email and is restorable, so its Supabase
 * identity must never be touched here.
 *
 * Until it runs, the identity can still sign in to Supabase, but every API
 * request is refused (AuthGuard on `deletedAt`) and the row holds no personal
 * data; the same email cannot sign up again until the identity is gone.
 */
@Injectable()
export class EraseDeletedAuthJob implements ScheduledJob {
  readonly name = 'eraseDeletedAuth';
  readonly cronExpression = '*/30 * * * *';

  private readonly logger = new Logger(EraseDeletedAuthJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseAdminService,
  ) {}

  async run(): Promise<void> {
    await this.sweep(new Date());
  }

  /** One pass, at `now`; returns what it did (tests read it, the scheduler does not). */
  async sweep(now: Date): Promise<{ erased: number; failed: number }> {
    if (!this.supabase.enabled) {
      this.logger.log(`job=${this.name} skipped: SUPABASE_SERVICE_KEY is not configured`);
      return { erased: 0, failed: 0 };
    }

    const owed = await this.prisma.user.findMany({
      where: {
        deletedAt: { not: null },
        authErasedAt: null,
        email: { startsWith: 'deleted+', endsWith: '@deleted.invalid' },
      },
      select: { id: true, supabaseId: true, email: true },
      orderBy: { deletedAt: 'asc' },
      take: ERASE_BATCH,
    });

    let erased = 0;
    let failed = 0;
    for (const user of owed) {
      // The exact placeholder for THIS row, not merely the domain.
      if (!isSelfDeleted(user)) continue;
      try {
        await eraseAuthIdentity(this.prisma, this.supabase, user, now);
        erased += 1;
      } catch (caught) {
        failed += 1;
        this.logger.warn(
          `job=${this.name} user=${user.id} not erased — ${
            caught instanceof Error ? caught.message : String(caught)
          }`,
        );
      }
    }

    this.logger.log(`job=${this.name} owed=${owed.length} erased=${erased} failed=${failed}`);
    return { erased, failed };
  }
}
