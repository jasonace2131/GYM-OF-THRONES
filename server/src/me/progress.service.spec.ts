import { HttpStatus } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ProgressService, type ProgressActor } from './progress.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';
import type { AuditService } from '../audit/audit.service';
import type { ScopedWhere } from '../rbac/scope.util';
import { DomainException } from '../common/exceptions/domain.exception';

const COACH: ProgressActor = { id: '11111111-1111-4111-8111-111111111111', role: 'COACH' };
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const ROW_ID = '44444444-4444-4444-8444-444444444444';

/** 2026-09-24T02:00Z is 10:00 on the 24th in Manila. */
const NOW = new Date('2026-09-24T02:00:00.000Z');
const TODAY_COLUMN = new Date('2026-09-24T00:00:00.000Z');

const gym = { timeZone: 'Asia/Manila' } as unknown as GymConfigService;

/** What the controller hands in: the `coachedMember` scope, already branded. */
const SCOPE = {
  assignedCoach: { some: { coachId: COACH.id, endedAt: null } },
  deletedAt: null,
} as unknown as ScopedWhere<Prisma.UserWhereInput>;

const MEMBER = { id: MEMBER_ID, firstName: 'Juan', lastName: 'Dela Cruz', memberCode: 'GOT-7' };

interface PrismaMock {
  user: { findFirst: jest.Mock; findUnique: jest.Mock };
  coachAssignment: { findUnique: jest.Mock };
  bodyMeasurement: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    upsert: jest.Mock;
    update: jest.Mock;
    deleteMany: jest.Mock;
  };
  memberGoal: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    deleteMany: jest.Mock;
  };
}

function measurementRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ROW_ID,
    userId: MEMBER_ID,
    businessDate: TODAY_COLUMN,
    weightGrams: 72_400,
    heightMm: null,
    bodyFatPermille: null,
    notes: null,
    recordedById: COACH.id,
    updatedById: null,
    recordedBy: { firstName: 'Ana' },
    updatedBy: null,
    ...over,
  };
}

function goalRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ROW_ID,
    userId: MEMBER_ID,
    name: 'Lose weight',
    unit: 'kg',
    startHundredths: 9500,
    currentHundredths: 9000,
    targetHundredths: 8500,
    achievedAt: null,
    recordedById: COACH.id,
    updatedById: null,
    recordedBy: { firstName: 'Ana' },
    updatedBy: null,
    ...over,
  };
}

function build(): { prisma: PrismaMock; audit: { record: jest.Mock }; service: ProgressService } {
  const prisma: PrismaMock = {
    user: {
      findFirst: jest.fn().mockResolvedValue(MEMBER),
      findUnique: jest.fn().mockResolvedValue({ heightCm: null, weightKg: null }),
    },
    coachAssignment: { findUnique: jest.fn().mockResolvedValue(null) },
    bodyMeasurement: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn((args: { create: Record<string, unknown> }) =>
        Promise.resolve(measurementRow(args.create)),
      ),
      update: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(measurementRow(args.data)),
      ),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    memberGoal: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(goalRow(args.data)),
      ),
      update: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(goalRow(args.data)),
      ),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new ProgressService(
    prisma as unknown as PrismaService,
    gym,
    audit as unknown as AuditService,
  );
  return { prisma, audit, service };
}

/** Rejects with a DomainException carrying this status and code. */
async function expectDomain(
  promise: Promise<unknown>,
  status: HttpStatus,
  code?: string,
): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DomainException);
  const domain = error as DomainException;
  expect(domain.getStatus()).toBe(status);
  if (code !== undefined) expect(domain.code).toBe(code);
}

/** A mock's first call's first argument, typed rather than `any`. */
function firstCall(mock: jest.Mock): Record<string, unknown> {
  const [args] = mock.mock.calls[0] as [Record<string, unknown>];
  return args;
}

/** The audit calls' `details`, flattened to a string, for "no body values" checks. */
function auditedText(audit: { record: jest.Mock }): string {
  return JSON.stringify(audit.record.mock.calls.map((call) => (call as unknown[])[0]));
}

describe('ProgressService — who can be reached', () => {
  /**
   * THE IDENTICAL 404. Every way of not being this coach's member — never
   * existed, somebody else's, assignment ended, account deleted — arrives
   * here as one `findFirst` returning null, because the scope is ANDed into
   * the lookup. A different message per cause would be an oracle.
   */
  it('404s when the member is outside the scope, before touching progress', async () => {
    const { prisma, service } = build();
    prisma.user.findFirst.mockResolvedValue(null);

    await expectDomain(
      service.recordMeasurement(COACH, MEMBER_ID, SCOPE, { weightGrams: 72_400 }, NOW),
      HttpStatus.NOT_FOUND,
      'MEMBER_NOT_FOUND',
    );
    expect(prisma.bodyMeasurement.upsert).not.toHaveBeenCalled();
  });

  it('ANDs the scope into the member lookup rather than spreading it', async () => {
    const { prisma, service } = build();

    await service.memberProgress(COACH, MEMBER_ID, SCOPE, NOW);

    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { AND: [{ id: MEMBER_ID }, SCOPE] } }),
    );
  });

  /**
   * D3: a coach cannot record their own progress. Refused before the query,
   * with the same 404 as everything else, so the route never admits that the
   * id is real — and the CHECK constraint backs it up.
   */
  it("404s on the caller's own id without querying at all", async () => {
    const { prisma, service } = build();

    await expectDomain(
      service.createGoal(COACH, COACH.id, SCOPE, {
        name: 'Bench',
        unit: 'kg',
        startHundredths: 6000,
        targetHundredths: 10_000,
      }),
      HttpStatus.NOT_FOUND,
      'MEMBER_NOT_FOUND',
    );
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.memberGoal.create).not.toHaveBeenCalled();
  });

  it('returns the member card with the summary on the coach read', async () => {
    const { service } = build();

    const result = await service.memberProgress(COACH, MEMBER_ID, SCOPE, NOW);

    expect(result.member).toEqual(MEMBER);
    expect(result.measurements).toEqual([]);
  });
});

describe('ProgressService.summary', () => {
  it('names the active coach', async () => {
    const { prisma, service } = build();
    prisma.coachAssignment.findUnique.mockResolvedValue({
      coach: { firstName: 'Ana', lastName: 'Reyes', deletedAt: null },
    });

    const result = await service.summary(MEMBER_ID, NOW);

    expect(result.coach).toEqual({ firstName: 'Ana', lastName: 'Reyes' });
    expect(prisma.coachAssignment.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { activeMemberId: MEMBER_ID } }),
    );
  });

  it('reports no coach when the assigned coach has been soft-deleted', async () => {
    const { prisma, service } = build();
    prisma.coachAssignment.findUnique.mockResolvedValue({
      coach: { firstName: 'Ana', lastName: 'Reyes', deletedAt: new Date() },
    });

    await expect(service.summary(MEMBER_ID, NOW)).resolves.toMatchObject({ coach: null });
  });

  it('reports no coach when there is no active assignment', async () => {
    const { service } = build();
    await expect(service.summary(MEMBER_ID, NOW)).resolves.toMatchObject({ coach: null });
  });

  it("shows the member's own account weight as the current weight", async () => {
    const { prisma, service } = build();
    prisma.bodyMeasurement.findMany.mockResolvedValue([measurementRow()]);
    prisma.user.findUnique.mockResolvedValue({ heightCm: 170, weightKg: 70 });

    const result = await service.summary(MEMBER_ID, NOW);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: MEMBER_ID },
      select: { heightCm: true, weightKg: true },
    });
    expect(result.latestWeightGrams).toBe(70_000);
    // 70 / 1.70^2 = 24.221...
    expect(result.bmiThousandths).toBe(24_221);
  });
});

describe('ProgressService.recordMeasurement', () => {
  it('creates the day with the coach as recorder', async () => {
    const { prisma, service } = build();

    await service.recordMeasurement(COACH, MEMBER_ID, SCOPE, { weightGrams: 72_400 }, NOW);

    const [args] = prisma.bodyMeasurement.upsert.mock.calls[0] as [
      { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> },
    ];
    expect(args.where).toEqual({
      userId_businessDate: { userId: MEMBER_ID, businessDate: TODAY_COLUMN },
    });
    expect(args.create).toMatchObject({
      userId: MEMBER_ID,
      businessDate: TODAY_COLUMN,
      weightGrams: 72_400,
      recordedById: COACH.id,
    });
  });

  /**
   * THE BUG THIS REPLACES. The old upsert wrote `?? null` for every omitted
   * field in its update branch, so recording a height after the morning's
   * weight WIPED the weight. The update branch now carries only what was sent.
   */
  it("merges into the day's row instead of wiping the fields it was not given", async () => {
    const { prisma, service } = build();
    prisma.bodyMeasurement.findUnique.mockResolvedValue(measurementRow());

    await service.recordMeasurement(COACH, MEMBER_ID, SCOPE, { heightMm: 1750 }, NOW);

    const [args] = prisma.bodyMeasurement.upsert.mock.calls[0] as [
      { update: Record<string, unknown> },
    ];
    expect(args.update).toEqual({ heightMm: 1750, updatedById: COACH.id });
    expect(args.update).not.toHaveProperty('weightGrams');
    expect(args.update).not.toHaveProperty('bodyFatPermille');
    expect(args.update).not.toHaveProperty('notes');
  });

  it('treats an explicit null on POST as "not given", never as a clear', async () => {
    const { prisma, service } = build();
    prisma.bodyMeasurement.findUnique.mockResolvedValue(measurementRow());

    await service.recordMeasurement(
      COACH,
      MEMBER_ID,
      SCOPE,
      { heightMm: 1750, weightGrams: null as unknown as undefined },
      NOW,
    );

    const [args] = prisma.bodyMeasurement.upsert.mock.calls[0] as [
      { update: Record<string, unknown> },
    ];
    expect(args.update).not.toHaveProperty('weightGrams');
  });

  it('refuses a reading with no weight, height or body fat with 422 MEASUREMENT_EMPTY', async () => {
    const { prisma, service } = build();

    await expectDomain(
      service.recordMeasurement(COACH, MEMBER_ID, SCOPE, { notes: 'felt strong' }, NOW),
      HttpStatus.UNPROCESSABLE_ENTITY,
      'MEASUREMENT_EMPTY',
    );
    expect(prisma.bodyMeasurement.upsert).not.toHaveBeenCalled();
  });

  /** D2: a day the member recorded themselves is read-only. */
  it('refuses to write over a self-recorded day with 409 PROGRESS_SELF_RECORDED', async () => {
    const { prisma, service } = build();
    prisma.bodyMeasurement.findUnique.mockResolvedValue(
      measurementRow({ recordedById: null, recordedBy: null }),
    );

    await expectDomain(
      service.recordMeasurement(COACH, MEMBER_ID, SCOPE, { weightGrams: 71_000 }, NOW),
      HttpStatus.CONFLICT,
      'PROGRESS_SELF_RECORDED',
    );
    expect(prisma.bodyMeasurement.upsert).not.toHaveBeenCalled();
  });

  it('backfills an earlier day when a date is given', async () => {
    const { prisma, service } = build();

    await service.recordMeasurement(
      COACH,
      MEMBER_ID,
      SCOPE,
      { weightGrams: 72_000, businessDate: '2026-09-20' as never },
      NOW,
    );

    const [args] = prisma.bodyMeasurement.upsert.mock.calls[0] as [
      { create: Record<string, unknown> },
    ];
    expect(args.create['businessDate']).toEqual(new Date('2026-09-20T00:00:00.000Z'));
  });

  it('rejects a date that is not on the calendar, and one in the future, with 400', async () => {
    const { service } = build();

    await expect(
      service.recordMeasurement(
        COACH,
        MEMBER_ID,
        SCOPE,
        { weightGrams: 72_000, businessDate: '2026-02-31' as never },
        NOW,
      ),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    await expect(
      service.recordMeasurement(
        COACH,
        MEMBER_ID,
        SCOPE,
        { weightGrams: 72_000, businessDate: '2026-09-25' as never },
        NOW,
      ),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
  });

  it('does not audit a first reading, nor filling in a field the day did not have', async () => {
    const { prisma, audit, service } = build();

    await service.recordMeasurement(COACH, MEMBER_ID, SCOPE, { weightGrams: 72_400 }, NOW);
    prisma.bodyMeasurement.findUnique.mockResolvedValue(measurementRow());
    await service.recordMeasurement(COACH, MEMBER_ID, SCOPE, { heightMm: 1750 }, NOW);
    // Re-sending the same value is not a correction either.
    await service.recordMeasurement(COACH, MEMBER_ID, SCOPE, { weightGrams: 72_400 }, NOW);

    expect(audit.record).not.toHaveBeenCalled();
  });

  /** D4: field NAMES, never the values — admins read the audit log, not weights. */
  it('audits overwriting a recorded value as a correction, naming fields but not values', async () => {
    const { prisma, audit, service } = build();
    prisma.bodyMeasurement.findUnique.mockResolvedValue(measurementRow());

    await service.recordMeasurement(COACH, MEMBER_ID, SCOPE, { weightGrams: 71_900 }, NOW);

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(firstCall(audit.record)).toMatchObject({
      action: 'PROGRESS_MEASUREMENT_CORRECTED',
      actorId: COACH.id,
      actorRole: 'COACH',
      subjectType: 'BodyMeasurement',
      subjectId: ROW_ID,
      details: { memberId: MEMBER_ID, businessDate: '2026-09-24', fields: ['weightGrams'] },
    });
    expect(auditedText(audit)).not.toContain('71900');
    expect(auditedText(audit)).not.toContain('72400');
  });
});

describe('ProgressService.updateMeasurement', () => {
  it('clears a field on an explicit null and names the updater', async () => {
    const { prisma, service } = build();
    prisma.bodyMeasurement.findFirst.mockResolvedValue(measurementRow({ heightMm: 1750 }));

    await service.updateMeasurement(COACH, MEMBER_ID, SCOPE, ROW_ID, { heightMm: null });

    const [args] = prisma.bodyMeasurement.update.mock.calls[0] as [
      { where: unknown; data: Record<string, unknown> },
    ];
    expect(args.where).toEqual({ id: ROW_ID });
    expect(args.data).toEqual({ heightMm: null, updatedById: COACH.id });
  });

  it('looks the row up inside this member, so another member’s id is a 404', async () => {
    const { prisma, service } = build();

    await expect(
      service.updateMeasurement(COACH, MEMBER_ID, SCOPE, ROW_ID, { weightGrams: 70_000 }),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    expect(prisma.bodyMeasurement.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ROW_ID, userId: MEMBER_ID } }),
    );
    expect(prisma.bodyMeasurement.update).not.toHaveBeenCalled();
  });

  it('refuses to clear the last reading with 422 MEASUREMENT_EMPTY', async () => {
    const { prisma, service } = build();
    prisma.bodyMeasurement.findFirst.mockResolvedValue(measurementRow());

    await expectDomain(
      service.updateMeasurement(COACH, MEMBER_ID, SCOPE, ROW_ID, { weightGrams: null }),
      HttpStatus.UNPROCESSABLE_ENTITY,
      'MEASUREMENT_EMPTY',
    );
    expect(prisma.bodyMeasurement.update).not.toHaveBeenCalled();
  });

  it('refuses to edit a self-recorded row with 409', async () => {
    const { prisma, service } = build();
    prisma.bodyMeasurement.findFirst.mockResolvedValue(
      measurementRow({ recordedById: null, recordedBy: null }),
    );

    await expectDomain(
      service.updateMeasurement(COACH, MEMBER_ID, SCOPE, ROW_ID, { weightGrams: 70_000 }),
      HttpStatus.CONFLICT,
      'PROGRESS_SELF_RECORDED',
    );
    expect(prisma.bodyMeasurement.update).not.toHaveBeenCalled();
  });

  it('audits the correction with field names only', async () => {
    const { prisma, audit, service } = build();
    prisma.bodyMeasurement.findFirst.mockResolvedValue(
      measurementRow({ heightMm: 1750, notes: 'after leg day' }),
    );

    await service.updateMeasurement(COACH, MEMBER_ID, SCOPE, ROW_ID, {
      weightGrams: 70_100,
      notes: 'corrected',
    });

    expect(firstCall(audit.record)).toMatchObject({
      action: 'PROGRESS_MEASUREMENT_CORRECTED',
      details: {
        memberId: MEMBER_ID,
        businessDate: '2026-09-24',
        fields: ['weightGrams', 'notes'],
      },
    });
    const text = auditedText(audit);
    for (const value of ['70100', '72400', 'corrected', 'after leg day', '1750']) {
      expect(text).not.toContain(value);
    }
  });
});

describe('ProgressService.removeMeasurement', () => {
  it('returns {id} rather than nothing, so the client has JSON to read', async () => {
    const { prisma, service } = build();
    prisma.bodyMeasurement.findFirst.mockResolvedValue(measurementRow());

    await expect(service.removeMeasurement(COACH, MEMBER_ID, SCOPE, ROW_ID)).resolves.toEqual({
      id: ROW_ID,
    });
    expect(prisma.bodyMeasurement.deleteMany).toHaveBeenCalledWith({
      where: { id: ROW_ID, userId: MEMBER_ID },
    });
  });

  /** D2: a coach may delete a self-recorded row — and it is audited as such. */
  it('deletes a self-recorded row and audits it, naming fields but not values', async () => {
    const { prisma, audit, service } = build();
    prisma.bodyMeasurement.findFirst.mockResolvedValue(
      measurementRow({ recordedById: null, recordedBy: null, heightMm: 1750 }),
    );

    await service.removeMeasurement(COACH, MEMBER_ID, SCOPE, ROW_ID);

    expect(firstCall(audit.record)).toMatchObject({
      action: 'PROGRESS_MEASUREMENT_DELETED',
      actorRole: 'COACH',
      subjectId: ROW_ID,
      details: {
        memberId: MEMBER_ID,
        businessDate: '2026-09-24',
        selfRecorded: true,
        fields: ['weightGrams', 'heightMm'],
      },
    });
    expect(auditedText(audit)).not.toContain('72400');
    expect(auditedText(audit)).not.toContain('1750');
  });

  it('404s on a row that is not this member’s', async () => {
    const { prisma, audit, service } = build();

    await expect(service.removeMeasurement(COACH, MEMBER_ID, SCOPE, ROW_ID)).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });
    expect(prisma.bodyMeasurement.deleteMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('ProgressService goals', () => {
  it('creates a goal with the coach as recorder, starting where the member is', async () => {
    const { prisma, service } = build();

    await service.createGoal(COACH, MEMBER_ID, SCOPE, {
      name: 'Bench',
      unit: 'kg',
      startHundredths: 6000,
      targetHundredths: 10_000,
    });

    expect(firstCall(prisma.memberGoal.create)).toMatchObject({
      data: {
        userId: MEMBER_ID,
        currentHundredths: 6000,
        recordedById: COACH.id,
      },
    });
  });

  it('refuses a goal whose target equals its start with 422, before the database does', async () => {
    const { prisma, service } = build();

    await expectDomain(
      service.createGoal(COACH, MEMBER_ID, SCOPE, {
        name: 'Stay put',
        unit: 'kg',
        startHundredths: 6000,
        targetHundredths: 6000,
      }),
      HttpStatus.UNPROCESSABLE_ENTITY,
      'GOAL_TARGET_EQUALS_START',
    );
    expect(prisma.memberGoal.create).not.toHaveBeenCalled();
  });

  it('updates a coach-recorded goal and names the updater, without auditing', async () => {
    const { prisma, audit, service } = build();
    prisma.memberGoal.findFirst.mockResolvedValue(goalRow());

    await service.updateGoal(COACH, MEMBER_ID, SCOPE, ROW_ID, { currentHundredths: 8900 });

    expect(firstCall(prisma.memberGoal.update)).toMatchObject({
      where: { id: ROW_ID },
      data: { currentHundredths: 8900, updatedById: COACH.id },
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses to edit a self-recorded goal with 409', async () => {
    const { prisma, service } = build();
    prisma.memberGoal.findFirst.mockResolvedValue(
      goalRow({ recordedById: null, recordedBy: null }),
    );

    await expectDomain(
      service.updateGoal(COACH, MEMBER_ID, SCOPE, ROW_ID, { achieved: true }),
      HttpStatus.CONFLICT,
      'PROGRESS_SELF_RECORDED',
    );
  });

  it('refuses to move a target onto the start with 422', async () => {
    const { prisma, service } = build();
    prisma.memberGoal.findFirst.mockResolvedValue(goalRow());

    await expectDomain(
      service.updateGoal(COACH, MEMBER_ID, SCOPE, ROW_ID, { targetHundredths: 9500 }),
      HttpStatus.UNPROCESSABLE_ENTITY,
      'GOAL_TARGET_EQUALS_START',
    );
  });

  it('404s on a goal that is not this member’s', async () => {
    const { prisma, service } = build();

    await expect(
      service.updateGoal(COACH, MEMBER_ID, SCOPE, ROW_ID, { achieved: true }),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    expect(prisma.memberGoal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ROW_ID, userId: MEMBER_ID } }),
    );
  });

  it('deletes a goal, returns {id}, and audits it by name with no values', async () => {
    const { prisma, audit, service } = build();
    prisma.memberGoal.findFirst.mockResolvedValue(
      goalRow({ recordedById: null, recordedBy: null }),
    );

    await expect(service.removeGoal(COACH, MEMBER_ID, SCOPE, ROW_ID)).resolves.toEqual({
      id: ROW_ID,
    });
    expect(firstCall(audit.record)).toMatchObject({
      action: 'PROGRESS_GOAL_DELETED',
      actorRole: 'COACH',
      subjectType: 'MemberGoal',
      subjectId: ROW_ID,
      subjectLabel: 'Lose weight',
      details: { memberId: MEMBER_ID, selfRecorded: true },
    });
    const text = auditedText(audit);
    for (const value of ['9500', '9000', '8500']) expect(text).not.toContain(value);
  });
});
