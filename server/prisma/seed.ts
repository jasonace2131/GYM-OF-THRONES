import { PrismaClient } from '@prisma/client';
import {
  PERMISSION_CATALOGUE,
  ROLE_PERMISSIONS,
  assertRequiresClosure,
  assertRequiresKeysExist,
} from '../src/rbac/permission-registry';
import { bumpPermissionVersionForRoles } from '../src/rbac/permission-version';
import { seedPlans } from '../src/catalogue/plan-registry';
import { seedStationRegistry } from '../src/checkin/station-registry';

const prisma = new PrismaClient();

/**
 * Idempotent and convergent: safe to run against a database that already has
 * some or all of these rows. Keyed on `Permission.key` and the
 * `(role, permissionId)` unique constraint, so re-running after editing the
 * registry updates existing rows in place rather than duplicating them — and
 * rows the registry no longer defines are pruned, so removing a key or a
 * grant actually revokes it instead of leaving a stale row behind forever.
 *
 * Two passes bracket that work. Before anything is written, the registry
 * assertions run: a bad catalogue must not be half-applied. After the prune,
 * every user holding a role whose grant set actually changed gets
 * `permissionVersion` incremented, so a revocation is visible on the next
 * request rather than after a 60-second TTL.
 */
async function main(): Promise<void> {
  assertRequiresKeysExist(PERMISSION_CATALOGUE);
  assertRequiresClosure(PERMISSION_CATALOGUE, ROLE_PERMISSIONS);

  for (const def of PERMISSION_CATALOGUE) {
    await prisma.permission.upsert({
      where: { key: def.key },
      update: {
        resource: def.resource,
        action: def.action,
        description: def.description,
        isDangerous: def.isDangerous,
        requires: def.requires,
      },
      create: {
        key: def.key,
        resource: def.resource,
        action: def.action,
        description: def.description,
        isDangerous: def.isDangerous,
        requires: def.requires,
      },
    });
  }
  console.info(`Seeded ${PERMISSION_CATALOGUE.length} permissions.`);

  // Snapshot every grant BEFORE the permission prune, so a grant that
  // disappears via `onDelete: Cascade` still counts as a change for its role.
  const grantsBefore = await prisma.rolePermission.findMany({
    select: { role: true, scope: true, permission: { select: { key: true } } },
  });
  const before = new Map<string, Set<string>>();
  for (const row of grantsBefore) {
    const set = before.get(row.role) ?? new Set<string>();
    set.add(`${row.permission.key}:${row.scope}`);
    before.set(row.role, set);
  }

  // Keys dropped from the catalogue. Their RolePermission rows go with them
  // via `onDelete: Cascade`, which is why this runs before the grant pass.
  const desiredKeys = PERMISSION_CATALOGUE.map((def) => def.key);
  const { count: prunedPermissions } = await prisma.permission.deleteMany({
    where: { key: { notIn: desiredKeys } },
  });
  if (prunedPermissions > 0) {
    console.info(`Pruned ${prunedPermissions} permission(s) no longer in the catalogue.`);
  }

  const roles = Object.keys(ROLE_PERMISSIONS) as Array<keyof typeof ROLE_PERMISSIONS>;
  const affectedRoles: Array<keyof typeof ROLE_PERMISSIONS> = [];
  let grantCount = 0;

  for (const role of roles) {
    const desiredIds: string[] = [];

    for (const grant of ROLE_PERMISSIONS[role]) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { key: grant.key } });
      await prisma.rolePermission.upsert({
        where: { role_permissionId: { role, permissionId: permission.id } },
        update: { scope: grant.scope },
        create: { role, permissionId: permission.id, scope: grant.scope },
      });
      desiredIds.push(permission.id);
      grantCount += 1;
    }

    // The separate concern: a grant this role lost while the permission
    // itself still exists (and may still be granted to other roles).
    const { count: prunedGrants } = await prisma.rolePermission.deleteMany({
      where: { role, permissionId: { notIn: desiredIds } },
    });
    if (prunedGrants > 0) {
      console.info(`Pruned ${prunedGrants} stale grant(s) for role ${role}.`);
    }

    const previous = before.get(role) ?? new Set<string>();
    const desired = new Set(ROLE_PERMISSIONS[role].map((g) => `${g.key}:${g.scope}`));
    const changed =
      previous.size !== desired.size || [...desired].some((entry) => !previous.has(entry));
    if (changed) {
      affectedRoles.push(role);
    }
  }
  console.info(`Seeded ${grantCount} role permission grants.`);

  const bumped = await bumpPermissionVersionForRoles(prisma, affectedRoles);
  if (bumped > 0) {
    console.info(
      `Bumped permissionVersion for ${bumped} user(s) holding ${affectedRoles.join(', ')}.`,
    );
  }

  // The plan pass is CREATE-ONLY and deliberately unlike everything above it.
  // The permission catalogue is convergent because permissions are code; plan
  // prices are business data owned by whoever runs the gym, so an upsert here
  // would silently revert every price change they made the next time anyone
  // deployed. A plan that should no longer sell is archived through
  // POST /admin/plans/:id/archive, never removed from the registry.
  const plans = await seedPlans(prisma);
  console.info(
    `Plans: created ${plans.created}, skipped ${plans.skipped} (create-only — prices are business data).`,
  );

  // Also create-only, and for the same reason: `Station.code` is physically
  // printed under the screen, so a convergent seed would silently invalidate
  // the label on every redeploy.
  const station = await seedStationRegistry(prisma);
  console.info(
    station.created
      ? `Station: created 'Front desk' (${station.code}).`
      : 'Station: skipped (a Station row already exists).',
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
