import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainException } from './domain.exception';
import { CONSTRAINT_ERROR_CODES, mapPrismaError } from './prisma-error.mapper';

function knownRequestError(meta: Record<string, unknown>, code = 'P2010'): Error {
  return new Prisma.PrismaClientKnownRequestError('database constraint violated', {
    code,
    clientVersion: '6.19.0',
    meta,
  });
}

describe('mapPrismaError', () => {
  it('maps a known CHECK constraint to a 422 with its domain code', () => {
    const mapped = mapPrismaError(knownRequestError({ constraint: 'CoachAssignment_not_self' }));

    expect(mapped).toBeInstanceOf(DomainException);
    expect(mapped?.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(mapped?.getResponse()).toEqual({
      code: 'COACH_SELF_ASSIGNMENT',
      message: expect.any(String),
    });
  });

  it('maps both active-marker constraints to MEMBER_ALREADY_ASSIGNED', () => {
    for (const constraint of [
      'CoachAssignment_active_marker',
      'CoachAssignment_active_marker_agrees',
      'CoachAssignment_activeMemberId_key',
    ]) {
      const mapped = mapPrismaError(knownRequestError({ constraint }));
      expect(mapped?.getResponse()).toMatchObject({ code: 'MEMBER_ALREADY_ASSIGNED' });
    }
  });

  /**
   * The shape this used to assert — `target` holding a constraint NAME — does
   * not occur. A real P2002 puts FIELD names in `target` and the model in
   * `modelName`, which is why the mapper never fired against a live database
   * despite this spec passing. Assert the real shape: the name is reassembled
   * into Prisma's own `Model_field_key` convention.
   */
  it('rebuilds Model_field_key from a real P2002 (field names in target)', () => {
    const mapped = mapPrismaError(
      knownRequestError({ modelName: 'CoachAssignment', target: ['activeMemberId'] }, 'P2002'),
    );
    expect(mapped?.getResponse()).toMatchObject({ code: 'MEMBER_ALREADY_ASSIGNED' });
  });

  it('reads the constraint name out of the message text, as raw-SQL errors report it', () => {
    const raw = knownRequestError({}, 'P2010');
    raw.message =
      'new row for relation "CoachAssignment" violates check constraint "CoachAssignment_not_self"';
    expect(mapPrismaError(raw)?.getResponse()).toMatchObject({ code: 'COACH_SELF_ASSIGNMENT' });
  });

  /**
   * Both were reachable from user input as 500s: a measurement POST carrying
   * only `notes`, and a goal whose target equals its start. The services now
   * refuse both first; these are the backstops.
   */
  it('maps the two progress CHECKs reachable from user input to named 422s', () => {
    const empty = mapPrismaError(knownRequestError({ constraint: 'BodyMeasurement_not_empty' }));
    expect(empty?.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(empty?.getResponse()).toMatchObject({ code: 'MEASUREMENT_EMPTY' });

    const flat = mapPrismaError(knownRequestError({ constraint: 'MemberGoal_target_differs' }));
    expect(flat?.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(flat?.getResponse()).toMatchObject({ code: 'GOAL_TARGET_EQUALS_START' });
  });

  /**
   * Only a service bug can trip these — the recorder is always the token's
   * caller and the member always comes from a scoped lookup — so they stay
   * unmapped and surface as a loud 500 rather than a plausible domain error.
   */
  it('leaves the recorder/updater CHECKs unmapped', () => {
    for (const constraint of [
      'BodyMeasurement_recorder_not_member',
      'BodyMeasurement_updater_shape',
      'MemberGoal_recorder_not_member',
      'MemberGoal_updater_shape',
    ]) {
      expect(mapPrismaError(knownRequestError({ constraint }))).toBeNull();
    }
  });

  it('returns null for an unknown constraint, so the filter still renders a 500', () => {
    expect(mapPrismaError(knownRequestError({ constraint: 'Some_Future_constraint' }))).toBeNull();
  });

  it('maps a real P2002 on User_email_key to a 409 MEMBER_EMAIL_TAKEN', () => {
    const mapped = mapPrismaError(
      knownRequestError({ modelName: 'User', target: ['email'] }, 'P2002'),
    );
    expect(mapped?.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(mapped?.getResponse()).toMatchObject({ code: 'MEMBER_EMAIL_TAKEN' });
  });

  it('returns null for a Prisma error carrying no constraint at all', () => {
    expect(mapPrismaError(knownRequestError({}))).toBeNull();
  });

  it('returns null for anything that is not a Prisma known-request error', () => {
    expect(mapPrismaError(new Error('boom'))).toBeNull();
    expect(mapPrismaError('boom')).toBeNull();
    expect(mapPrismaError(null)).toBeNull();
  });
});

describe('CONSTRAINT_ERROR_CODES', () => {
  it('never maps a constraint to a code outside the DomainErrorCode union', () => {
    // Compile-time proof lives in the type; this asserts the table is non-empty
    // and every value is a non-empty screaming-snake string.
    const values = Object.values(CONSTRAINT_ERROR_CODES);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).toMatch(/^[A-Z][A-Z_]+$/);
    }
  });
});

describe('DomainException', () => {
  it('defaults to 422 and carries the code in its body', () => {
    const error = new DomainException('COACH_NOT_A_COACH', 'That user is not a coach');
    expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(error.getResponse()).toEqual({
      code: 'COACH_NOT_A_COACH',
      message: 'That user is not a coach',
    });
  });

  it('accepts an explicit status for the conflict cases', () => {
    const error = new DomainException(
      'IDEMPOTENCY_KEY_REUSED',
      'That key was used for a different request',
      HttpStatus.CONFLICT,
    );
    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
  });
});
