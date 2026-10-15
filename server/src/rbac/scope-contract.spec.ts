import type { Prisma } from '@prisma/client';
import type { ScopedWhere, ScopeSubject } from './scope.util';
import { Scope } from './decorators/scope.decorator';
import type { MembershipListItem } from '../membership/membership.presenter';

/**
 * The test that makes forgetting impossible rather than merely detectable —
 * PROVIDED this file is actually type-checked, which `npm test` alone does
 * NOT do.
 *
 * The paragraph below ("ts-jest reports TypeScript diagnostics as failures")
 * describes the intended mechanism, not the current one: in this repo's jest
 * setup, ts-jest's diagnostics do not fail on type errors — an
 * @ts-expect-error that never fires does NOT fail this file under
 * `npm test`. Verified directly: appending a bare `const x: number = 'a
 * string'` to this file and running it through jest produced zero errors.
 * Enabling ts-jest diagnostics is a deliberate Chunk 1 decision (it would
 * type-check every spec at test time and could surface a large pre-existing
 * backlog mid-chunk), not something to slip in here.
 *
 * Until then, the ONLY thing enforcing every guarantee in this file —
 * including the branded `ScopedWhere` contract the whole chunk is built
 * around — is `npm run typecheck --workspace=server` (`tsc --noEmit -p
 * tsconfig.json`, which — unlike `tsconfig.build.json` — does not exclude
 * `*.spec.ts`). That command MUST run in CI for anything below this comment
 * to mean what it says. If it is ever dropped from CI, or ts-jest diagnostics
 * are enabled and this comment not removed, update this comment.
 *
 * ts-jest reports TypeScript diagnostics as failures [when enabled], so an
 * @ts-expect-error that does NOT fire fails this file with TS2578 ("Unused
 * '@ts-expect-error' directive"). Reviewers: reject any service where
 * `where: { ...filters, ...scope }` still compiles.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- only the signature is under test
function listAssignments(_where: ScopedWhere<Prisma.CoachAssignmentWhereInput>): void {
  // Body intentionally empty.
}

describe('scoped call contract', () => {
  it('accepts a branded fragment and rejects every unbranded shape', () => {
    const scope = {} as ScopedWhere<Prisma.CoachAssignmentWhereInput>;

    listAssignments(scope);

    // @ts-expect-error — a bare WhereInput is not a ScopedWhere
    listAssignments({ coachId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });

    // @ts-expect-error — spreading a scoped fragment loses the brand
    listAssignments({ ...scope });

    // @ts-expect-error — merging filters into the scope loses it too
    listAssignments({ ...scope, status: 'ACTIVE' });

    // @ts-expect-error — an empty object is not a scope, however tempting
    listAssignments({});

    expect(typeof listAssignments).toBe('function');
  });

  /**
   * KNOWN GAP, pinned rather than hidden.
   *
   * `Object.assign({}, filters, scope)` does the exact same runtime damage as
   * `{ ...filters, ...scope }` — it silently overwrites a co-existing
   * top-level OR and can widen the query — but it is NOT rejected here. There
   * is no `@ts-expect-error` above this call because there is no error to
   * expect: TypeScript's private-member stripping is special-cased to
   * object-*literal* spread syntax, and `Object.assign`'s own signature
   * (`assign<T, U>(target: T, source: U): T & U`) preserves the intersection
   * — brand included — through a plain function call. Verified empirically
   * with tsc 5.9.3 --strict --noEmit: zero diagnostics.
   *
   * This is pinned, not fixed, because no brand shape was found that rejects
   * `Object.assign` without also rejecting or complicating every legitimate
   * use of a `ScopedWhere` — the failure mode is a property of how
   * `Object.assign` is typed in lib.es2015.core.d.ts, not of how `ScopedWhere`
   * is branded, so strengthening the brand further cannot close it. If a
   * future TypeScript release tightens this, this test starts failing
   * (because the call below would then need an `@ts-expect-error` it does
   * not have) and that is the intended signal to revisit this comment.
   */
  it('KNOWN GAP: Object.assign silently preserves the brand — not caught', () => {
    const scope = {} as ScopedWhere<Prisma.CoachAssignmentWhereInput>;
    const filters: Prisma.CoachAssignmentWhereInput = { status: 'ACTIVE' };

    // No @ts-expect-error: this compiles today, and is not endorsed by doing so.
    listAssignments(Object.assign({}, filters, scope));

    expect(typeof listAssignments).toBe('function');
  });
});

/**
 * Fix-wave regression #1: a nested ternary chain replaced this switch for a
 * while. Its final `else` silently became the catch-all for any
 * `ScopeSubject` not explicitly matched, so a fourth union member would have
 * compiled and mapped to the wrong fragment — no error, no signal. Restored
 * as a `switch` in `scope.util.ts`'s `reachFor`; this proves the mechanism
 * that makes that restoration load-bearing, using the real `ScopeSubject`
 * type rather than a copy that could drift from it.
 */
describe('ScopeSubject exhaustiveness', () => {
  it('a switch missing a case fails to compile — TS2366, not a silent fallthrough', () => {
    // @ts-expect-error — TS2366 "function lacks ending return statement": the
    // switch below omits 'coachAssignment', and the return type is `object`,
    // not `void`/`any`, so TypeScript refuses to compile the missing path
    // rather than letting it fall through to `undefined`.
    function reachForIncomplete(subject: ScopeSubject): object {
      switch (subject) {
        case 'user':
          return {};
        case 'ownedByUser':
          return {};
      }
    }

    expect(typeof reachForIncomplete).toBe('function');
  });

  it('the same switch, all four cases present, compiles cleanly', () => {
    // No @ts-expect-error: this is the exhaustive form and must compile.
    function reachForComplete(subject: ScopeSubject): object {
      switch (subject) {
        case 'user':
          return {};
        case 'ownedByUser':
          return {};
        case 'coachAssignment':
          return {};
        case 'coachedMember':
          return {};
      }
    }

    expect(typeof reachForComplete).toBe('function');
  });
});

/**
 * Fix-wave regression #2: `createParamDecorator`'s own generated type signs
 * its returned factory as `(...dataOrPipes: unknown[]) => ParameterDecorator`
 * — the data argument is optional and untyped at the call site. Calling that
 * factory directly as `@Scope()` with no subject used to compile, and
 * `subject` would arrive `undefined` at runtime — on a `'user'` route at ALL
 * scope, `buildScopeWhere` would silently miss the `deletedAt: null` filter
 * fix 6 exists to guarantee. `Scope()` in `scope.decorator.ts` wraps the
 * factory in a plain function whose own parameter is required, which is what
 * this proves.
 */
describe('Scope() subject is required at the type level', () => {
  it('rejects a missing subject and accepts a real one', () => {
    // @ts-expect-error — subject is required; omitting it must not compile.
    Scope();

    // Compiles: a real ScopeSubject is supplied.
    const decorator = Scope('coachAssignment');
    expect(typeof decorator).toBe('function');
  });
});

/**
 * The chunk-1 half of the contract.
 *
 * ts-jest does NOT fail on type errors in this repo, so `npm test` proves
 * nothing here: `npm run typecheck --workspace=server` is the ONLY thing that
 * makes these @ts-expect-error directives mean anything. Whoever wires CI must
 * run the typecheck, not just the tests.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- only the signature is under test
function listMemberships(_where: ScopedWhere<Prisma.MembershipWhereInput>): MembershipListItem[] {
  return [];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- only the signature is under test
function listPayments(_where: ScopedWhere<Prisma.PaymentWhereInput>): void {
  // Body intentionally empty.
}

describe('Membership and Payment reads are scoped by the same contract', () => {
  it('rejects a bare MembershipWhereInput and every spread of a scope', () => {
    const scope = {} as ScopedWhere<Prisma.MembershipWhereInput>;

    listMemberships(scope);

    // @ts-expect-error — a bare WhereInput is not a ScopedWhere
    listMemberships({ status: 'ACTIVE' });

    // @ts-expect-error — spreading a scoped fragment loses the brand
    listMemberships({ ...scope });

    // @ts-expect-error — and merging a filter into it loses the brand too,
    // which is exactly the `{ ...filters, ...scope }` shape that would clobber
    // a coach's top-level OR and widen the read to the whole member base.
    listMemberships({ ...scope, planCode: 'MONTHLY' });

    expect(typeof listMemberships).toBe('function');
  });

  it('rejects a bare PaymentWhereInput and every spread of a scope', () => {
    const scope = {} as ScopedWhere<Prisma.PaymentWhereInput>;

    listPayments(scope);

    // @ts-expect-error — a bare WhereInput is not a ScopedWhere
    listPayments({ method: 'CASH' });

    // @ts-expect-error — spreading a scoped fragment loses the brand
    listPayments({ ...scope });

    // @ts-expect-error — merging filters into the scope loses it too
    listPayments({ ...scope, status: 'RECORDED' });

    expect(typeof listPayments).toBe('function');
  });
});
