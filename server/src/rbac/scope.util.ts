import type { Prisma, PermissionScope } from '@prisma/client';

/**
 * Branded so a `where` fragment cannot be built by hand or spread away.
 *
 * Spreading a scope fragment — `where: { ...filters, ...scope }` — silently
 * destroys a co-existing top-level OR and can WIDEN the query. The brand makes
 * that a type error rather than a code-review convention: a spread copies only
 * public properties, so the private `__scoped` member is lost and the result is
 * no longer assignable to ScopedWhere. A `unique symbol` brand does NOT do this
 * — an object spread of it still type-checks. Verified with tsc 5.9.
 *
 * What this contract covers, and what it deliberately does not:
 *
 * It stops the accidental, ordinary way a scope gets destroyed — writing
 * `where: { ...filters, ...scope }` by hand at a call site — by making that a
 * compile error (see scope-contract.spec.ts). It does NOT stop, and cannot
 * stop, `Object.assign({}, filters, scope)`: TypeScript's private-member
 * stripping is special-cased to object-*literal* spread syntax, and
 * `Object.assign`'s signature (`assign<T, U>(target: T, source: U): T & U`)
 * preserves the intersection — brand included — so it type-checks with zero
 * diagnostics (verified with tsc 5.9.3 --strict --noEmit; pinned as a known
 * gap in scope-contract.spec.ts, not fixed, because there is no brand shape
 * that rejects `Object.assign` without also making legitimate uses of the
 * scope painful — see that file's comment for what was considered and
 * rejected). It likewise does not stop an explicit cast (`as ScopedWhere<T>`),
 * a value that has round-tripped through `JSON.parse(JSON.stringify(...))`,
 * or a value typed `any` reaching a scoped parameter. None of those forms is
 * `where: { ...filters, ...scope }` — the one shape every scoped repository
 * call site in this codebase is expected to write, and the one shape a
 * reviewer skimming a diff is trained to flag. The brand is worth having
 * because it converts the common case from "someone has to notice in review"
 * to "it will not compile," not because it is airtight against a determined
 * or careless bypass.
 */
declare class ScopedBrand {
  private readonly __scoped: void;
}

export type ScopedWhere<T> = T & ScopedBrand;

/**
 * Which model the fragment is destined for. Required, never defaulted: a wrong
 * default silently widens a filter, which is the one failure mode this file
 * exists to prevent. Adding another scoped subject is a compile error here,
 * not a leak in a service.
 *
 * `coachedMember` is the one subject that is not "rows that are mine": it is
 * the User row of a member the caller actively coaches, with no self branch.
 * See `coachedMemberWhere`.
 */
export type ScopeSubject = 'user' | 'ownedByUser' | 'coachAssignment' | 'coachedMember';

/**
 * §4.4: soft-deleted users are invisible to every member-facing read. Only
 * `User` carries `deletedAt` — folding this into `ownRowWhere` or
 * `ownCoachAssignmentWhere` below would silently assume every future scoped
 * model has the same column, which is not true today (CoachAssignment does
 * not). Keep it a User-only fragment.
 */
export const notDeletedUserWhere: Pick<Prisma.UserWhereInput, 'deletedAt'> = { deletedAt: null };

/** OWN, applied to the User table itself. */
export function ownUserWhere(userId: string): Prisma.UserWhereInput {
  return {
    OR: [{ id: userId }, { assignedCoach: { some: { coachId: userId, endedAt: null } } }],
  };
}

/** The same rule, one hop away, for any row hanging off a User via `userId`. */
export function ownRowWhere(userId: string): {
  OR: [
    { userId: string },
    { user: { assignedCoach: { some: { coachId: string; endedAt: null } } } },
  ];
} {
  return {
    OR: [{ userId }, { user: { assignedCoach: { some: { coachId: userId, endedAt: null } } } }],
  };
}

/**
 * OWN, applied to the assignment table itself — either side of the relationship.
 *
 * Deliberately does NOT filter on `endedAt`, unlike `ownUserWhere` and
 * `ownRowWhere` above: an assignment row belongs to both parties for its
 * whole history, active or ended, not only while it is active. This is not
 * an oversight to bring in line with the other two builders — do not "fix"
 * it into filtering on `endedAt: null`.
 */
export function ownCoachAssignmentWhere(userId: string): Prisma.CoachAssignmentWhereInput {
  return { OR: [{ coachId: userId }, { memberId: userId }] };
}

/**
 * OWN for a route whose SUBJECT is a member somebody else coaches — the User
 * row of a member I am actively assigned to, and NOTHING ELSE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO SELF BRANCH, AND THAT IS THE WHOLE REASON THIS EXISTS.
 *
 * `ownUserWhere` ORs in `{ id: userId }`, so "mine" includes the caller. That
 * is right for reading a profile and wrong for the coach progress routes: a
 * coach naming their own id would reach their own weight history through a
 * surface built for recording other people's, and could write a row whose
 * recorder is its own member — which `BodyMeasurement_recorder_not_member`
 * forbids. Do NOT "fix" this into `ownUserWhere`, and do not reuse
 * `ownRowWhere` for these routes either: it has the same self branch one hop
 * away.
 *
 * `endedAt: null` is the ACTIVE test: an ended assignment grants nothing, so
 * a coach who handed a member over loses access the moment it ends.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function coachedMemberWhere(coachId: string): Prisma.UserWhereInput {
  return { assignedCoach: { some: { coachId, endedAt: null } } };
}

/**
 * The single builder behind both `PermissionsService.scopeFilter` (which
 * resolves `scope` itself, from a permission key) and the `@Scope()` param
 * decorator (which reads the scope `PermissionsGuard` already resolved and
 * stashed on the request). Keeping one implementation means the two callers
 * cannot drift on what OWN/ALL means for a given subject — see §4.1's
 * argument for `@Scope()` in the fix-wave report.
 *
 * Not exported as `ScopedWhere<T>` — callers brand the result themselves,
 * since only they know which concrete `T` applies.
 */
export function buildScopeWhere(
  scope: PermissionScope,
  subject: ScopeSubject,
  userId: string,
): object {
  const reach: object = scope === 'ALL' ? {} : reachFor(subject, userId);

  // §4.4: soft-deleted users are invisible to every member-facing read,
  // regardless of scope reach — ALL means "no OWN restriction," never
  // "including deleted." `coachedMember` is a User subject too, so a deleted
  // member is unreachable even while their assignment is still ACTIVE (a
  // soft delete does not end it).
  return subject === 'user' || subject === 'coachedMember'
    ? { ...reach, ...notDeletedUserWhere }
    : reach;
}

/**
 * A plain switch with no default, not a ternary chain: under
 * strictNullChecks with a non-undefined return type, TypeScript treats an
 * exhaustive switch over a literal union as covering every path, and flags
 * TS2366 ("function lacks ending return statement") the moment a case goes
 * missing — e.g. when ScopeSubject grows a fourth member. A ternary chain's
 * final else has no such guard: it silently becomes the catch-all for
 * anything not explicitly matched. This is the mechanism the doc comment on
 * ScopeSubject above promises ("adding a fourth scoped model is a compile
 * error here"); keep it a switch.
 */
function reachFor(subject: ScopeSubject, userId: string): object {
  switch (subject) {
    case 'user':
      return ownUserWhere(userId);
    case 'ownedByUser':
      return ownRowWhere(userId);
    case 'coachAssignment':
      return ownCoachAssignmentWhere(userId);
    case 'coachedMember':
      return coachedMemberWhere(userId);
  }
}
