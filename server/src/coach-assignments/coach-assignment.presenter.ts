import type { CoachAssignment, CoachAssignmentStatus } from '@prisma/client';

/**
 * A row as every query in this module reads it: the assignment plus the two
 * people it names.
 *
 * The include is not optional and the type says so. A caller that forgets it
 * is a compile error here rather than an `undefined` reaching a screen.
 */
export type CoachAssignmentRow = CoachAssignment & {
  coach: { firstName: string; lastName: string };
  member: { firstName: string; lastName: string; memberCode: string | null };
};

/**
 * The wire shape of a coach assignment.
 *
 * `startedAt` / `endedAt` are instants (`@db.Timestamptz(3)`), so they travel
 * as full ISO-8601 strings and are formatted client-side with an explicit
 * `timeZone`. They are deliberately NOT civil dates — see §3.3 rule 3.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE NAMES ARE HERE BECAUSE THE CLIENT WAS ALREADY PROMISING THEM.
 *
 * `adminApi.ts` declared `CoachAssignmentItem` with `coachName`, `memberName`
 * and `memberCode` while this projection sent none of them — a type that
 * type-checked, compiled, and would have rendered `undefined` the moment any
 * screen read one. The assignment screen needs the names (a table of UUID
 * pairs is not a screen), so the projection now sends what the client always
 * claimed to receive.
 *
 * This is `coach.read`-gated, which ADMIN holds at ALL and COACH at OWN, so
 * the widest audience for a name here is somebody already entitled to the
 * member list.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export interface CoachAssignmentView {
  id: string;
  coachId: string;
  coachName: string;
  memberId: string;
  memberName: string;
  memberCode: string | null;
  status: CoachAssignmentStatus;
  startedAt: string;
  endedAt: string | null;
  assignedById: string;
  endedById: string | null;
  notes: string | null;
}

/**
 * Row → response projection. The controller never returns a raw Prisma model:
 * `activeMemberId` is an enforcement sentinel, not information, and shipping it
 * would invite a client to reason about it.
 */
export function toCoachAssignmentView(row: CoachAssignmentRow): CoachAssignmentView {
  return {
    id: row.id,
    coachId: row.coachId,
    coachName: `${row.coach.firstName} ${row.coach.lastName}`.trim(),
    memberId: row.memberId,
    memberName: `${row.member.firstName} ${row.member.lastName}`.trim(),
    memberCode: row.member.memberCode,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    assignedById: row.assignedById,
    endedById: row.endedById,
    notes: row.notes,
  };
}

/**
 * The one include every read in this module uses.
 *
 * Exported so the four call sites cannot drift — a `findMany` that selected a
 * different shape would compile against `CoachAssignmentRow` only by accident.
 */
export const COACH_ASSIGNMENT_INCLUDE = {
  coach: { select: { firstName: true, lastName: true } },
  member: { select: { firstName: true, lastName: true, memberCode: true } },
} as const;
