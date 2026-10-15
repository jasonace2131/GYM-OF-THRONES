import { roleLabel } from '@got/shared';

/**
 * "What each role can do" — the read-only matrix on Staff & Access.
 *
 * Built from two real endpoints and nothing else: the catalogue
 * (`GET /admin/permissions`, grouped by resource) and the seeded grants
 * (`GET /admin/permissions/roles`). The Super Admin's column is DRAWN rather
 * than read, because DEV holds no grant rows — it bypasses the table and
 * resolves every key at ALL, which is exactly what the column says.
 */

/** One catalogue entry, as `GET /admin/permissions` returns it. */
export interface PermissionDefinitionView {
  key: string;
  resource: string;
  action: string;
  description: string;
  isDangerous: boolean;
  requires: string[];
}

export type PermissionCatalogue = Record<string, PermissionDefinitionView[]>;

export type GrantScope = 'ALL' | 'OWN';

/** `GET /admin/permissions/roles`. DEV is absent on purpose. */
export type RoleGrants = Record<
  'CLIENT' | 'FRONT_DESK' | 'COACH' | 'ADMIN',
  Array<{ key: string; scope: string }>
>;

export const MATRIX_ROLES = ['CLIENT', 'FRONT_DESK', 'COACH', 'ADMIN', 'DEV'] as const;
export type MatrixRole = (typeof MATRIX_ROLES)[number];

export interface MatrixRow {
  key: string;
  description: string;
  isDangerous: boolean;
  cells: Record<MatrixRole, GrantScope | null>;
}

export interface MatrixGroup {
  resource: string;
  rows: MatrixRow[];
}

function scopeOf(
  grants: RoleGrants,
  role: Exclude<MatrixRole, 'DEV'>,
  key: string,
): GrantScope | null {
  const held = grants[role].filter((grant) => grant.key === key);
  if (held.length === 0) return null;
  return held.some((grant) => grant.scope === 'ALL') ? 'ALL' : 'OWN';
}

export function buildRoleMatrix(catalogue: PermissionCatalogue, grants: RoleGrants): MatrixGroup[] {
  return Object.entries(catalogue).map(([resource, definitions]) => ({
    resource,
    rows: definitions.map((definition) => ({
      key: definition.key,
      description: definition.description,
      isDangerous: definition.isDangerous,
      cells: {
        CLIENT: scopeOf(grants, 'CLIENT', definition.key),
        FRONT_DESK: scopeOf(grants, 'FRONT_DESK', definition.key),
        COACH: scopeOf(grants, 'COACH', definition.key),
        ADMIN: scopeOf(grants, 'ADMIN', definition.key),
        DEV: 'ALL',
      },
    })),
  }));
}

/** "All" (everybody's rows), "Own" (their own, or their assigned members'), or a dash. */
export function cellLabel(cell: GrantScope | null): string {
  if (cell === 'ALL') return 'All';
  if (cell === 'OWN') return 'Own';
  return '—';
}

/** Column headings, in the console's words. */
export function matrixRoleLabel(role: MatrixRole): string {
  return roleLabel(role);
}
