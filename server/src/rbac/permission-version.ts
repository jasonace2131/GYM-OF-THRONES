import type { Prisma, Role } from '@prisma/client';

/**
 * The one way to invalidate a permission cache.
 *
 * Both take a `Prisma.TransactionClient` rather than the service, because the
 * bump must land in the SAME transaction as the write that changed the answer.
 * A bump issued afterwards leaves a window in which some instance serves the
 * old set from cache and no later event closes it.
 *
 * `{ increment: 1 }`, never an assignment: two concurrent grant writes must
 * both move the version, and a read-modify-write would let one overwrite the
 * other and silently keep a revoked permission live for a full TTL.
 *
 * PrismaClient itself satisfies TransactionClient, so the seed can call these
 * outside a transaction where there is nothing to be atomic with.
 */
export async function bumpPermissionVersionForRoles(
  tx: Prisma.TransactionClient,
  roles: readonly Role[],
): Promise<number> {
  if (roles.length === 0) return 0;
  const { count } = await tx.user.updateMany({
    where: { role: { in: [...roles] } },
    data: { permissionVersion: { increment: 1 } },
  });
  return count;
}

export async function bumpPermissionVersionForUsers(
  tx: Prisma.TransactionClient,
  userIds: readonly string[],
): Promise<number> {
  if (userIds.length === 0) return 0;
  const { count } = await tx.user.updateMany({
    where: { id: { in: [...userIds] } },
    data: { permissionVersion: { increment: 1 } },
  });
  return count;
}
