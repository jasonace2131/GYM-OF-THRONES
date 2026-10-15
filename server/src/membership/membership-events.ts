import {
  Prisma,
  type MembershipEvent,
  type MembershipEventType,
  type MembershipStatus,
} from '@prisma/client';
import { toDateColumn, type CivilDate } from '../common/time/gym-time';

/**
 * The single write path into the append-only transition ledger.
 *
 * Every mutating service logs the same shape through this function, so "why did
 * this membership's endsOn move" is answerable from one table rather than by
 * replaying six services' worth of ad-hoc creates. The table is append-only by
 * a BEFORE UPDATE OR DELETE trigger (§5.8.4), not by convention — this function
 * is the convenience, the trigger is the guarantee.
 *
 * There is deliberately no update and no delete helper here. If one is ever
 * wanted, the trigger will refuse it with restrict_violation, that constraint
 * is deliberately UNMAPPED in CONSTRAINT_ERROR_CODES, and the result is a
 * logged 500 — which is the correct, loud signal for a genuine bug.
 */
export interface MembershipEventInput {
  membershipId: string;
  type: MembershipEventType;
  /** NULL only on the very first event, when there was no prior status. */
  fromStatus: MembershipStatus | null;
  toStatus: MembershipStatus;
  /** Both NULL when the event did not move the term; populated together. */
  previousEndsOn: CivilDate | null;
  newEndsOn: CivilDate | null;
  /** Mandatory for ADJUSTED, STATUS_CORRECTED and CANCELLED (the CHECK). */
  reason: string | null;
  /** NULL means the system did it — the nightly job. A human is always named. */
  actorId: string | null;
  paymentId: string | null;
  batchRef: string | null;
  /**
   * When the change takes effect in the BUSINESS timeline, which a catch-up run
   * sets to the day the transition should have happened rather than the day it
   * was detected. Usually equal to createdAt; never assumed to be.
   */
  effectiveAt: Date;
}

function toData(input: MembershipEventInput): Prisma.MembershipEventCreateManyInput {
  return {
    membershipId: input.membershipId,
    type: input.type,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    previousEndsOn: input.previousEndsOn === null ? null : toDateColumn(input.previousEndsOn),
    newEndsOn: input.newEndsOn === null ? null : toDateColumn(input.newEndsOn),
    reason: input.reason,
    actorId: input.actorId,
    paymentId: input.paymentId,
    batchRef: input.batchRef,
    effectiveAt: input.effectiveAt,
  };
}

/** One row, unconditionally. The ordinary path for every single-row transition. */
export async function writeMembershipEvent(
  tx: Prisma.TransactionClient,
  input: MembershipEventInput,
): Promise<MembershipEvent> {
  return tx.membershipEvent.create({ data: toData(input) });
}

/**
 * The bulk-operation path: one row per (membershipId, batchRef), and a re-run of
 * the same closure credit writes nothing.
 *
 * createMany + skipDuplicates, never a caught P2002: inside $transaction
 * Postgres aborts on the first statement error and every later statement dies
 * with 25P02, so the "already applied" branch of a naive implementation is dead
 * code that 500s at exactly the re-run it was written to handle.
 *
 * Note that @@unique([membershipId, batchRef]) constrains nothing when batchRef
 * is NULL — Postgres unique indexes ignore NULL — which is why ordinary events
 * never collide and why this function refuses a null batchRef outright rather
 * than silently degrading into writeMembershipEvent.
 */
export async function writeMembershipEventIfNew(
  tx: Prisma.TransactionClient,
  input: MembershipEventInput,
): Promise<boolean> {
  if (input.batchRef === null) {
    throw new Error('writeMembershipEventIfNew requires a batchRef — use writeMembershipEvent');
  }

  const { count } = await tx.membershipEvent.createMany({
    data: [toData(input)],
    skipDuplicates: true,
  });
  return count === 1;
}
