import { HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { DomainErrorCode } from '@got/shared';
import { DomainException } from './domain.exception';

/**
 * Database constraint violations → named domain errors.
 *
 * Constraints are BACKSTOPS: everything they enforce is also validated in the
 * service, so one firing is a bug report rather than a user-facing path. They
 * are mapped anyway, because "also" is not "always" and the desk console cannot
 * branch on INTERNAL_SERVER_ERROR.
 *
 * ---------------------------------------------------------------------------
 * THE TRANSACTION RULE — stated once, here, so it is never re-derived.
 *
 * Inside `prisma.$transaction`, NEVER catch a unique violation and then issue
 * another statement on the same `tx`. Postgres aborts the transaction on the
 * first statement error and Prisma issues no per-statement SAVEPOINT, so every
 * subsequent statement dies with 25P02 — the replay-detection path in a naive
 * implementation is dead code that 500s at exactly the double-tap it was
 * written to handle.
 *
 * Use the non-throwing form:
 *
 *   const { count } = await tx.stationScan.createMany({ data, skipDuplicates: true });
 *   if (count === 0) { // replay: read the recorded outcome and return it }
 *
 * `createMany({ skipDuplicates: true })` compiles to INSERT … ON CONFLICT DO
 * NOTHING, returns 0 on conflict, and leaves the transaction alive. If a
 * throwing form is ever unavoidable, wrap it in an explicit SAVEPOINT /
 * ROLLBACK TO SAVEPOINT via $executeRawUnsafe.
 *
 * Catching a violation AFTER the whole $transaction call has rejected is a
 * different thing and is allowed: the transaction is already rolled back and no
 * further statement touches `tx`. That is how CoachAssignmentsService turns the
 * activeMemberId race into a 409.
 * ---------------------------------------------------------------------------
 */

const logger = new Logger('PrismaErrorMapper');

/**
 * Constraint name → domain code. The NAMES are load-bearing: they are written
 * character for character in the hand-edited migration SQL, and the
 * constraint-presence e2e suite keys on the same strings.
 *
 * Deliberately ABSENT: `CoachAssignment_end_shape`. It fires only when a row is
 * ACTIVE with endedAt set (or ENDED without it), which no client input can
 * provoke and no concurrent write can produce — it is purely a service bug, and
 * a 500 with the raw constraint in the log is the correct, loud signal for one.
 * Mapping it to COACH_ASSIGNMENT_NOT_FOUND would be a lie: it would tell the
 * client the row is gone when it demonstrably exists.
 */
export const CONSTRAINT_ERROR_CODES: Readonly<Record<string, DomainErrorCode>> = {
  // A self-assignment is rejected in the service; this is the backstop.
  CoachAssignment_not_self: 'COACH_SELF_ASSIGNMENT',
  // The sentinel column and its two CHECKs all enforce one active coach per
  // member. Any of the three firing means a second assignment raced the first.
  CoachAssignment_active_marker: 'MEMBER_ALREADY_ASSIGNED',
  CoachAssignment_active_marker_agrees: 'MEMBER_ALREADY_ASSIGNED',
  CoachAssignment_activeMemberId_key: 'MEMBER_ALREADY_ASSIGNED',

  // ── Chunk 1 — membership core (§5.8.6) ──────────────────────────────────
  MembershipHold_no_overlap: 'HOLD_OVERLAPS',
  MembershipHold_active_marker_agrees: 'MEMBERSHIP_ALREADY_FROZEN',
  MembershipHold_days_bounded: 'FREEZE_WINDOW_INVALID',
  Membership_dates_ordered: 'MEMBERSHIP_STATE_INVALID',
  Membership_counters_sane: 'MEMBERSHIP_STATE_INVALID',
  Payment_money_consistent: 'PAYMENT_AMOUNT_MISMATCH',
  Payment_gross_positive: 'PAYMENT_AMOUNT_MISMATCH',
  Payment_zero_only_when_comped: 'PAYMENT_AMOUNT_MISMATCH',
  Payment_discount_shape: 'DISCOUNT_ID_REQUIRED',
  Payment_purpose_shape: 'PAYMENT_SHAPE_INVALID',
  Payment_gcash_reference: 'PAYMENT_SHAPE_INVALID',
  Payment_reference_normalized_shape: 'PAYMENT_SHAPE_INVALID',
  // The concurrency backstop behind createInTx's own named 409 — two
  // requests racing the same reference land here.
  // Payment_gcash_verified_shape is deliberately ABSENT — same reasoning as
  // Payment_void_kind_shape below: the pair is written together in one
  // statement from a boolean DTO field, so no client input can violate it.
  Payment_gcash_reference_unique: 'GCASH_REFERENCE_DUPLICATE',
  Payment_void_shape: 'PAYMENT_SHAPE_INVALID',
  // Payment_void_kind_shape (C3, 20260827010000_payment_void_kind) is
  // deliberately ABSENT — same reasoning as CoachAssignment_end_shape above.
  // VoidPaymentDto.kind is @IsEnum-required, so PaymentsService.void() always
  // writes voidedAt and voidKind together in the one updateMany; no client
  // input can leave one set without the other. A violation would be a service
  // bug, and a 500 with the raw constraint logged is the correct signal.
  Payment_idempotencyKey_key: 'IDEMPOTENCY_KEY_REUSED',
  Shift_open_marker: 'SHIFT_ALREADY_OPEN',
  Shift_close_shape: 'SHIFT_ALREADY_OPEN',
  Membership_userId_key: 'MEMBER_ALREADY_IMPORTED',

  // ── C2 — member creation ────────────────────────────────────────────────
  // Backstop for the race MembersService.create's own pre-check narrows but
  // cannot close: two concurrent creates for the same email.
  User_email_key: 'MEMBER_EMAIL_TAKEN',

  // ── Staff & Access ──────────────────────────────────────────────────────
  // The partial unique index behind "one open invitation per address". The
  // service refuses a second live one itself; this is the backstop for two
  // admins inviting the same person at the same moment.
  StaffInvitation_one_open_per_email: 'STAFF_INVITE_PENDING',
  // ── end Staff & Access ──────────────────────────────────────────────────

  // ── Chunk 2 — station QR attendance (§6.4, §7.2) ────────────────────────
  // The open-visit sentinel. Reachable only if the CheckIn insert stops using
  // createMany({ skipDuplicates: true }) — kept as a backstop, not as a path.
  CheckIn_openUserId_key: 'CHECKIN_ALREADY_OPEN',
  CheckIn_open_marker_agrees: 'CHECKIN_ALREADY_OPEN',
  // CheckIn_open_marker and CheckIn_reopen_nonneg are deliberately ABSENT,
  // same reasoning as CoachAssignment_end_shape above: both only fire from a
  // service bug (the sentinel pointing at the wrong user, or a negative
  // decrement), never from client input.
  CheckIn_entry_shape: 'CHECKIN_INVALID_SHAPE',
  CheckIn_recorder_shape: 'CHECKIN_INVALID_SHAPE',
  CheckIn_station_shape: 'CHECKIN_INVALID_SHAPE',
  CheckIn_close_station_shape: 'CHECKIN_INVALID_SHAPE',
  CheckIn_autoclosed_agrees: 'CHECKIN_INVALID_SHAPE',
  CheckIn_void_shape: 'CHECKIN_INVALID_SHAPE',
  CheckIn_shift_shape: 'SHIFT_NOT_OPEN',
  CheckInDenial_recorder_shape: 'CHECKIN_INVALID_SHAPE',
  CheckInDenial_station_shape: 'CHECKIN_INVALID_SHAPE',
  CheckInDenial_staleness_shape: 'CHECKIN_INVALID_SHAPE',
  CheckInDenial_staleness_nonneg: 'CHECKIN_INVALID_SHAPE',
  CheckInDenial_resolution_shape: 'CHECKIN_INVALID_SHAPE',
  CheckInDenial_override_shape: 'CHECKIN_INVALID_SHAPE',
  CheckInDenial_shift_required: 'SHIFT_NOT_OPEN',

  // ── Coach-recorded progress ─────────────────────────────────────────────
  // Both were reachable from user input as a bare 500 before ProgressService
  // refused them itself: a measurement carrying only `notes`, and a goal whose
  // target equals its start. The service checks are the path; these are the
  // backstops.
  //
  // BodyMeasurement_recorder_not_member, BodyMeasurement_updater_shape and
  // their MemberGoal twins are deliberately ABSENT: the recorder is always the
  // token's caller and the member always comes from a scoped lookup that
  // excludes the caller, so only a service bug can trip them.
  BodyMeasurement_not_empty: 'MEASUREMENT_EMPTY',
  MemberGoal_target_differs: 'GOAL_TARGET_EQUALS_START',

  // Station_code_shape, Station_epoch_positive, StationScan_slot_nonneg,
  // StationScan_userId_stationId_slot_key and StationScan_opening_checkin_once
  // are deliberately ABSENT: code/epoch/slot are always server-computed, and
  // the StationScan claim is made non-throwing (createMany skipDuplicates)
  // specifically so these never fire on a real request. A violation here is a
  // service bug, and a 500 with the raw constraint logged is the correct
  // signal — mapping it to a domain code would misreport a bug as user input.
};

// Partial, not the full catalogue: only the handful of codes this mapper
// actually produces have a message here. The `??` fallback below is the
// visible contract for every other DomainErrorCode, not a cast-hidden lie.
const CONSTRAINT_MESSAGES: Readonly<Partial<Record<DomainErrorCode, string>>> = {
  COACH_SELF_ASSIGNMENT: 'A coach cannot be assigned to themselves',
  MEMBER_ALREADY_ASSIGNED: 'That member already has an active coach',
  MEMBER_EMAIL_TAKEN: 'A member with this email already exists',
  MEASUREMENT_EMPTY: 'Record at least one of weight, height or body fat',
  GOAL_TARGET_EQUALS_START: 'The target has to differ from the starting value',
  STAFF_INVITE_PENDING: 'This address already has an invitation waiting. Resend that one instead.',
};

/**
 * §5.8.6 named five of these a 409 rather than the default 422 — the caller
 * did nothing malformed, it lost a race or duplicated a key. Chunk 2 (§7.2)
 * adds two more for the open-visit sentinel, same reasoning: a 422 tells the
 * desk "your input is wrong" when the honest answer is "someone got there
 * first", which is a different thing to put in front of staff mid-transaction.
 */
const CONSTRAINT_STATUSES: Readonly<Record<string, HttpStatus>> = {
  MembershipHold_active_marker_agrees: HttpStatus.CONFLICT,
  Payment_idempotencyKey_key: HttpStatus.CONFLICT,
  // The caller lost a race, they did not send something malformed.
  Payment_gcash_reference_unique: HttpStatus.CONFLICT,
  Shift_open_marker: HttpStatus.CONFLICT,
  Shift_close_shape: HttpStatus.CONFLICT,
  Membership_userId_key: HttpStatus.CONFLICT,
  // Chunk 2 (§7.2): a race for the open-visit sentinel, not malformed input.
  CheckIn_openUserId_key: HttpStatus.CONFLICT,
  CheckIn_open_marker_agrees: HttpStatus.CONFLICT,
  // Same reasoning: the caller did nothing malformed, they lost a race for
  // the same email address.
  User_email_key: HttpStatus.CONFLICT,
  // Staff & Access: two admins inviting one address at once.
  StaffInvitation_one_open_per_email: HttpStatus.CONFLICT,
};

/**
 * Find the constraint name in whatever shape the driver actually produced.
 *
 * This used to read `meta.constraint` and `meta.target` only, which meant it
 * never fired — not once, for any of the mapped constraints. Three separate
 * reasons, all confirmed against a real database in
 * `server/test/membership-constraints.e2e-spec.ts`:
 *
 *   1. A CHECK reached through raw SQL arrives as P2010 with the constraint
 *      named ONLY in the message text — `meta` carries no `constraint` key.
 *   2. A CHECK reached through the ORM client is not a
 *      `PrismaClientKnownRequestError` at all; it is an *Unknown*RequestError,
 *      which the old first line rejected before any lookup ran.
 *   3. A unique violation (P2002) populates `meta.target` with FIELD names —
 *      `['idempotencyKey']` — never the constraint name the map is keyed on.
 *
 * So: read the explicit key, then the message text (Postgres names the
 * constraint in every violation class — check, unique, exclusion, foreign
 * key), then rebuild Prisma's own `Model_field_key` convention from
 * `modelName` + `target` as a last resort.
 */
function constraintNameOf(error: unknown): string | null {
  const meta = (error as { meta?: Record<string, unknown> }).meta;

  const explicit = meta?.['constraint'];
  if (typeof explicit === 'string') return explicit;
  if (Array.isArray(explicit) && typeof explicit[0] === 'string') return explicit[0];

  const message = (error as { message?: unknown }).message;
  if (typeof message === 'string') {
    const named = /constraint "([^"]+)"/.exec(message);
    if (named?.[1] !== undefined) return named[1];
  }

  const model = meta?.['modelName'];
  const target = meta?.['target'];
  if (typeof model === 'string') {
    if (typeof target === 'string') return `${model}_${target}_key`;
    if (Array.isArray(target) && target.every((part) => typeof part === 'string')) {
      return `${model}_${target.join('_')}_key`;
    }
  }

  return null;
}

/**
 * Translate a Prisma database error into a named 422, or null when it is not
 * one we recognise — in which case HttpExceptionFilter still renders a 500 and
 * logs the full stack.
 */
export function mapPrismaError(error: unknown): DomainException | null {
  // A CHECK violation raised through the ORM client is an *Unknown*RequestError,
  // not a Known one. Rejecting it here is what made this whole mapper dead code.
  const isPrismaError =
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError;
  if (!isPrismaError) return null;

  const constraint = constraintNameOf(error);
  if (constraint === null) return null;

  const code = CONSTRAINT_ERROR_CODES[constraint];
  if (code === undefined) return null;

  // Always log the raw constraint name: a constraint firing is a bug report,
  // and the domain code alone does not say which backstop caught it.
  const prismaCode = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : 'unknown';
  logger.warn(`Constraint ${constraint} violated (prisma ${prismaCode}) → ${code}`);

  return new DomainException(
    code,
    CONSTRAINT_MESSAGES[code] ?? 'That change conflicts with an existing record',
    CONSTRAINT_STATUSES[constraint] ?? HttpStatus.UNPROCESSABLE_ENTITY,
  );
}
