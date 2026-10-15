import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { buildScopeWhere, type ScopeSubject, type ScopedWhere } from '../scope.util';
import type { RequestWithPermission } from '../rbac.types';

/**
 * `createParamDecorator`'s own generated type signs its returned factory as
 * `(...dataOrPipes: unknown[]) => ParameterDecorator` — the data argument is
 * effectively optional and untyped at the call site, so `@resolveScope()`
 * with no argument would compile even though `subject` is declared
 * `ScopeSubject` in the callback below. `subject` then arrives `undefined`
 * at runtime and would fall through every `case` in `reachFor` (see
 * scope.util.ts), landing back here — hence the explicit throw.
 */
const resolveScope = createParamDecorator(
  (subject: ScopeSubject, ctx: ExecutionContext): ScopedWhere<object> => {
    if (subject === undefined) {
      throw new Error(
        '@Scope() called with no subject — this is a wiring bug, not a client error. ' +
          'Use the Scope() wrapper below, which requires a subject at the type level, ' +
          'rather than calling this factory directly.',
      );
    }

    const request = ctx.switchToHttp().getRequest<RequestWithPermission>();
    const permission = request.permission;
    if (!permission) {
      throw new Error(
        '@Scope() used on a route with no PermissionsGuard-resolved permission — pair it with @RequirePermission()',
      );
    }
    if (!request.user) {
      throw new Error('@Scope() used on a route that AuthGuard did not populate');
    }

    return buildScopeWhere(permission.scope, subject, request.user.id) as ScopedWhere<object>;
  },
);

/**
 * Resolves the `where` fragment for the CURRENT route's `@RequirePermission()`
 * key, reading the scope `PermissionsGuard` already resolved and stashed at
 * `request.permission` rather than re-resolving it from a second, hand-typed
 * copy of the permission key.
 *
 * This is what makes the stash load-bearing (§4.1): before this decorator
 * existed, a handler called `permissions.scopeFilter(user, 'coach.read',
 * 'coachAssignment')`, spelling `'coach.read'` a second time three lines
 * below `@RequirePermission('coach.read')`. If the two ever diverged, a
 * caller holding both permissions got the WRONG one's scope silently — see
 * the fix-wave report for the concrete case. With `@Scope()`, the permission
 * key is written exactly once per route, in `@RequirePermission()`, and this
 * decorator can only ever resolve the scope the guard already matched against
 * it.
 *
 * Requires `@RequirePermission()` on the same route — `PermissionsGuard` is
 * what populates `request.permission`, and it only does so when a
 * requirement was declared. Using `@Scope()` alone is a wiring bug, not a
 * client error, so it throws rather than silently returning `{}` (which would
 * be indistinguishable from an intentional ALL-scope grant).
 *
 * A plain wrapper function, deliberately NOT `export const Scope =
 * createParamDecorator(...)` directly: `createParamDecorator`'s returned
 * factory types its argument as optional, so `@Scope()` with no subject
 * would otherwise compile — and on a `'user'` route at ALL scope, the
 * `subject === 'user'` check inside `buildScopeWhere` would silently miss,
 * dropping the `deletedAt: null` filter fix 6 exists to guarantee. Wrapping
 * it in a function whose own parameter is required (`subject: ScopeSubject`,
 * no `?`, no default) makes omitting the subject a compile error instead —
 * see scope-contract.spec.ts for the pinned proof.
 */
export function Scope(subject: ScopeSubject): ParameterDecorator {
  return resolveScope(subject);
}
