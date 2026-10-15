import { asCivilDate } from '../common/time/gym-time';
import { isMinor, threadAccess, type ThreadFacts } from './chat-access';

const COACH = 'c0000000-0000-4000-8000-000000000001';
const MEMBER = 'm0000000-0000-4000-8000-000000000001';
const STRANGER = 's0000000-0000-4000-8000-000000000001';

const day = asCivilDate;

describe('isMinor', () => {
  const today = day('2026-09-25');

  it('is false for a NULL date of birth — owner decision: unknown age may chat', () => {
    expect(isMinor(null, today)).toBe(false);
  });

  it('is true until the eighteenth birthday, and false on it', () => {
    expect(isMinor(day('2008-09-26'), today)).toBe(true); // 18 tomorrow
    expect(isMinor(day('2008-09-25'), today)).toBe(false); // 18 today
    expect(isMinor(day('2008-09-24'), today)).toBe(false);
  });

  it('treats a young child and an adult the obvious way', () => {
    expect(isMinor(day('2016-01-01'), today)).toBe(true);
    expect(isMinor(day('1990-05-05'), today)).toBe(false);
  });

  it('dates a 29 February birthday to 1 March in a common year', () => {
    // Born 2008-02-29; 2026 has no 29 February, so they turn 18 on 1 March.
    expect(isMinor(day('2008-02-29'), day('2026-02-28'))).toBe(true);
    expect(isMinor(day('2008-02-29'), day('2026-03-01'))).toBe(false);
  });

  it('compares civil dates, so a year boundary is not a string accident', () => {
    expect(isMinor(day('2008-12-31'), day('2026-12-30'))).toBe(true);
    expect(isMinor(day('2008-12-31'), day('2026-12-31'))).toBe(false);
    expect(isMinor(day('2009-01-01'), day('2026-12-31'))).toBe(true);
  });
});

describe('threadAccess', () => {
  const today = day('2026-09-25');
  const facts = (overrides: Partial<ThreadFacts> = {}): ThreadFacts => ({
    coachId: COACH,
    memberId: MEMBER,
    memberDateOfBirth: day('1995-03-01'),
    coachDeleted: false,
    memberDeleted: false,
    activeAssignment: true,
    ...overrides,
  });

  it('lets each participant read and write while the assignment is ACTIVE', () => {
    expect(threadAccess(facts(), COACH, today)).toEqual({
      kind: 'participant',
      role: 'COACH',
      writable: true,
      readOnlyReason: null,
    });
    expect(threadAccess(facts(), MEMBER, today)).toEqual({
      kind: 'participant',
      role: 'MEMBER',
      writable: true,
      readOnlyReason: null,
    });
  });

  it('makes the thread read-only history once the assignment has ended', () => {
    for (const who of [COACH, MEMBER]) {
      expect(threadAccess(facts({ activeAssignment: false }), who, today)).toMatchObject({
        kind: 'participant',
        writable: false,
        readOnlyReason: 'ASSIGNMENT_ENDED',
      });
    }
  });

  it('gives somebody who is not a participant nothing — the route answers 404', () => {
    expect(threadAccess(facts(), STRANGER, today)).toEqual({ kind: 'none' });
  });

  it('closes the thread to both sides when the member is under 18', () => {
    const minor = facts({ memberDateOfBirth: day('2012-06-01') });
    expect(threadAccess(minor, COACH, today)).toEqual({ kind: 'minor' });
    expect(threadAccess(minor, MEMBER, today)).toEqual({ kind: 'minor' });
    // Still nothing at all for a stranger: "minor" is not an oracle.
    expect(threadAccess(minor, STRANGER, today)).toEqual({ kind: 'none' });
  });

  it('allows a member with no date of birth on file', () => {
    expect(threadAccess(facts({ memberDateOfBirth: null }), MEMBER, today)).toMatchObject({
      kind: 'participant',
      writable: true,
    });
  });

  it('hides a thread whose other party has been soft-deleted', () => {
    expect(threadAccess(facts({ memberDeleted: true }), COACH, today)).toEqual({ kind: 'none' });
    expect(threadAccess(facts({ coachDeleted: true }), MEMBER, today)).toEqual({ kind: 'none' });
  });
});
