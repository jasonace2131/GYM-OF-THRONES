import { Controller, Get } from '@nestjs/common';
import type { PermissionScope, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequirePermission } from './decorators/require-permission.decorator';
import { PERMISSION_CATALOGUE } from './permission-registry';
import type { PermissionDefinition } from './permission-registry';

export type PermissionCatalogueResponse = Record<string, PermissionDefinition[]>;

/** One seeded role's default grants: key and reach. DEV has none — it bypasses. */
export type RoleGrantsResponse = Record<
  Exclude<Role, 'DEV'>,
  Array<{ key: string; scope: PermissionScope }>
>;

/** Groups the catalogue by resource, e.g. `{ member: [...], coach: [...] }`. */
export function groupByResource(catalogue: PermissionDefinition[]): PermissionCatalogueResponse {
  const grouped: PermissionCatalogueResponse = {};
  for (const entry of catalogue) {
    (grouped[entry.resource] ??= []).push(entry);
  }
  return grouped;
}

@Controller('admin/permissions')
export class AdminPermissionsController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The full permission catalogue, grouped by resource.
   *
   * Static — this reads the hard-coded registry, not the database. It is
   * the first endpoint this app protects with @RequirePermission, proving
   * the AuthGuard → PermissionsGuard → PermissionsService path end to end.
   */
  @Get()
  @RequirePermission('permission.read')
  list(): PermissionCatalogueResponse {
    return groupByResource(PERMISSION_CATALOGUE);
  }

  /**
   * `GET /admin/permissions/roles` — what each role can do, as the Staff &
   * Access screen's read-only matrix draws it.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * READ FROM THE DATABASE, NOT THE REGISTRY.
   *
   * The catalogue above is static by design, but the grants are what
   * `PermissionsService` actually resolves against: `RolePermission` rows the
   * seed writes. A matrix drawn from the registry would describe the NEXT
   * deploy's grants the moment a registry edit shipped before its seed ran —
   * the one moment somebody would be looking at this screen to check.
   *
   * DEV never appears. It holds no rows (it bypasses the table in
   * `PermissionsService`), and a stray one is ignored rather than drawn as
   * if it limited anything. The console renders the Super Admin's column as
   * "every key, at ALL", which is what the bypass means.
   * ─────────────────────────────────────────────────────────────────────────
   */
  @Get('roles')
  @RequirePermission('permission.read')
  async roles(): Promise<RoleGrantsResponse> {
    const rows = await this.prisma.rolePermission.findMany({
      select: { role: true, scope: true, permission: { select: { key: true } } },
    });

    const grouped: RoleGrantsResponse = { CLIENT: [], FRONT_DESK: [], COACH: [], ADMIN: [] };
    for (const row of rows) {
      if (row.role === 'DEV') continue;
      grouped[row.role].push({ key: row.permission.key, scope: row.scope });
    }
    for (const grants of Object.values(grouped)) {
      grants.sort((a, b) => a.key.localeCompare(b.key));
    }
    return grouped;
  }
}
