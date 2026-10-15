import type { ChatReadOnlyReason } from '@got/shared';
import { civilDateFromPrisma, toDateColumn, type CivilDate } from '../common/time/gym-time';

/**
 * WHO MAY USE A COACH-MEMBER THREAD — the whole rule, in one pure module.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Every chat route asks `threadAccess` and nothing else, so the rule cannot
 * drift between the inbox, the history, the send and the delete:
 *
 *   - A thread belongs to its two PARTICIPANTS: its coach and its member.
 *     Anybody else — whatever their `chat.use` scope — gets `none`, which the
 *     routes render as the same 404 an unknown id gets.
 *   - It is WRITABLE only while the pair has an ACTIVE CoachAssignment (the
 *     `endedAt: null` sentinel). After that it is read-only history.
 *   - It is CLOSED to both sides while the member is under 18 by date of
 *     birth (owner decision, 2026-09-25: no 1:1 coach chat for minors; they
 *     go through the front desk). A NULL date of birth is ALLOWED — also the
 *     owner's decision, to be confirmed before launch.
 *   - A thread whose other party has been soft-deleted is `none`: §4.4, a
 *     deleted account is invisible to every member-facing read.
 *
 * `chat.review` (ADMIN, audited) is the one reader who is not a participant,
 * and it does not come through here.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface ThreadFacts {
  coachId: string;
  memberId: string;
  memberDateOfBirth: CivilDate | null;
  coachDeleted: boolean;
  memberDeleted: boolean;
  /** The pair has an ACTIVE CoachAssignment right now. */
  activeAssignment: boolean;
}

export type ThreadAccess =
  | { kind: 'none' }
  | { kind: 'minor' }
  | {
      kind: 'participant';
      role: 'COACH' | 'MEMBER';
      writable: boolean;
      readOnlyReason: ChatReadOnlyReason | null;
    };

/** The age of majority in the Philippines (RA 6809). */
const AGE_OF_MAJORITY = 18;

/**
 * Under 18 on `today`, the gym's civil date.
 *
 * The eighteenth birthday is computed with `Date.UTC`, which rolls a
 * 29 February birthday in a common year onto 1 March — the later, and so the
 * safer, of the two readings for a rule whose purpose is safeguarding.
 */
export function isMinor(dateOfBirth: CivilDate | null, today: CivilDate): boolean {
  if (dateOfBirth === null) return false;
  const born = toDateColumn(dateOfBirth);
  const eighteenth = civilDateFromPrisma(
    new Date(
      Date.UTC(born.getUTCFullYear() + AGE_OF_MAJORITY, born.getUTCMonth(), born.getUTCDate()),
    ),
  );
  // yyyy-mm-dd compares correctly as text.
  return today < eighteenth;
}

export function threadAccess(facts: ThreadFacts, userId: string, today: CivilDate): ThreadAccess {
  const role = userId === facts.coachId ? 'COACH' : userId === facts.memberId ? 'MEMBER' : null;
  if (role === null) return { kind: 'none' };

  if (facts.coachDeleted || facts.memberDeleted) return { kind: 'none' };

  if (isMinor(facts.memberDateOfBirth, today)) return { kind: 'minor' };

  return facts.activeAssignment
    ? { kind: 'participant', role, writable: true, readOnlyReason: null }
    : { kind: 'participant', role, writable: false, readOnlyReason: 'ASSIGNMENT_ENDED' };
}
