import {
  buildScopeWhere,
  coachedMemberWhere,
  ownCoachAssignmentWhere,
  ownRowWhere,
  ownUserWhere,
} from './scope.util';

const ME = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/**
 * OWN has exactly one, role-independent definition: rows that are mine, or
 * that belong to a member actively assigned to me as their coach. Snapshotting
 * the exact `where` is the cheapest regression net there is — scopeFilter
 * quietly resolving to `{}` is otherwise invisible.
 */
describe('scope where-builders', () => {
  it('ownUserWhere: me, or a member I actively coach', () => {
    expect(ownUserWhere(ME)).toEqual({
      OR: [{ id: ME }, { assignedCoach: { some: { coachId: ME, endedAt: null } } }],
    });
  });

  it('ownRowWhere: the same rule, one hop away through userId', () => {
    expect(ownRowWhere(ME)).toEqual({
      OR: [{ userId: ME }, { user: { assignedCoach: { some: { coachId: ME, endedAt: null } } } }],
    });
  });

  it('ownCoachAssignmentWhere: rows naming me as either side', () => {
    expect(ownCoachAssignmentWhere(ME)).toEqual({
      OR: [{ coachId: ME }, { memberId: ME }],
    });
  });

  /**
   * THE DIFFERENCE FROM ownUserWhere IS THE WHOLE POINT.
   *
   * ownUserWhere ORs `{ id: me }` in, so a coach naming their own id reaches
   * their own row. For the progress routes that would let a coach record their
   * own weight through a surface built for recording other people's — so this
   * builder has NO self branch at all: an active assignment where I am the
   * coach, and nothing else.
   */
  it('coachedMemberWhere: a member I ACTIVELY coach, and never me', () => {
    expect(coachedMemberWhere(ME)).toEqual({
      assignedCoach: { some: { coachId: ME, endedAt: null } },
    });
    expect(JSON.stringify(coachedMemberWhere(ME))).not.toContain('"id"');
    expect(coachedMemberWhere(ME)).not.toHaveProperty('OR');
  });
});

describe('buildScopeWhere — coachedMember', () => {
  it('at OWN: an active assignment to me, AND not soft-deleted', () => {
    expect(buildScopeWhere('OWN', 'coachedMember', ME)).toEqual({
      assignedCoach: { some: { coachId: ME, endedAt: null } },
      deletedAt: null,
    });
  });

  /** ALL means "no OWN restriction", never "including deleted" (§4.4). */
  it('at ALL: every member, but still never a deleted one', () => {
    expect(buildScopeWhere('ALL', 'coachedMember', ME)).toEqual({ deletedAt: null });
  });

  it('leaves the user subject exactly as it was', () => {
    expect(buildScopeWhere('ALL', 'user', ME)).toEqual({ deletedAt: null });
    expect(buildScopeWhere('OWN', 'user', ME)).toEqual({ ...ownUserWhere(ME), deletedAt: null });
  });
});
