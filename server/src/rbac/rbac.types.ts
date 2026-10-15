import type { Request } from 'express';
import type { PermissionScope } from '@prisma/client';
import type { AuthUser } from '../auth/auth.types';

/** One permission this user effectively holds, and at what row-level reach. */
export interface EffectivePermission {
  key: string;
  scope: PermissionScope;
}

/**
 * The only three fields permission resolution needs. Exported because the
 * scoped services take it as a parameter — passing a whole AuthUser would let
 * a service read `role` and re-derive access rules that belong here.
 */
export type PermissionUser = Pick<AuthUser, 'id' | 'role' | 'permissionVersion'>;

/**
 * The request after AuthGuard and PermissionsGuard have run.
 *
 * `permission` is what lets a handler reach the matched grant without
 * re-resolving it — the guard has already paid for the lookup.
 */
export interface RequestWithPermission extends Request {
  user?: AuthUser;
  permission?: EffectivePermission;
}
