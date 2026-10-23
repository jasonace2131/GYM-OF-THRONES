import type { PrismaService } from '../prisma/prisma.service';
import type { SupabaseAdminService } from '../auth/supabase-admin.service';

/**
 * The placeholder a self-deleted member's email becomes. Tied to the row's own
 * id, so it is unique (`User.email` is UNIQUE) and it is an unambiguous marker
 * of a SELF-deletion: a staff soft-delete leaves the real address in place,
 * and no other code path writes this exact string. `.invalid` is reserved
 * (RFC 2606) and can never reach a real inbox.
 */
export function selfDeletedEmail(userId: string): string {
  return `deleted+${userId}@deleted.invalid`;
}

export function isSelfDeleted(user: { id: string; email: string }): boolean {
  return user.email === selfDeletedEmail(user.id);
}

/**
 * Deletes a self-deleted member's Supabase identity and records that it is
 * gone. "Not found" counts as gone (`deleteAccountIdentity`). Throws when
 * Supabase fails, leaving `authErasedAt` NULL for the scheduler to retry.
 */
export async function eraseAuthIdentity(
  prisma: PrismaService,
  supabase: SupabaseAdminService,
  user: { id: string; supabaseId: string },
  now: Date,
): Promise<void> {
  await supabase.deleteAccountIdentity(user.supabaseId);
  await prisma.user.updateMany({
    where: { id: user.id, authErasedAt: null },
    data: { authErasedAt: now },
  });
}
