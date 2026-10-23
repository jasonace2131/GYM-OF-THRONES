import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AccountDeletionService, REDACTED, anonymisedUserData } from './account-deletion.service';
import { DeleteMyAccountDto } from './dto/delete-my-account.dto';
import type { PrismaService } from '../prisma/prisma.service';
import type { SupabaseAdminService } from '../auth/supabase-admin.service';
import type { BookingsService } from '../classes/bookings.service';
import type { AuthUser } from '../auth/auth.types';
import { DomainException } from '../common/exceptions/domain.exception';

const NOW = new Date('2026-10-23T02:00:00.000Z');
const USER: AuthUser = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  supabaseId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  email: 'juan@example.com',
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  role: 'CLIENT',
  status: 'ACTIVE',
  permissionVersion: 0,
  heightCm: 175,
  weightKg: 72.4,
  deletedAt: null,
} as AuthUser;
const PLACEHOLDER = `deleted+${USER.id}@deleted.invalid`;

function deleteMany() {
  return jest.fn().mockResolvedValue({ count: 2 });
}

function build() {
  const order: string[] = [];
  const tx = {
    user: {
      updateMany: jest.fn().mockImplementation(async () => {
        order.push('anonymise');
        return { count: 1 };
      }),
    },
    checkIn: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    coachAssignment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    bodyMeasurement: { deleteMany: deleteMany() },
    memberGoal: { deleteMany: deleteMany() },
    workoutSetLog: { deleteMany: deleteMany() },
    workoutSession: { deleteMany: deleteMany() },
    memberWorkoutDraft: { deleteMany: deleteMany() },
    memberWorkoutPlan: { deleteMany: deleteMany() },
    workoutPlan: { deleteMany: deleteMany() },
    workoutAiQuota: { deleteMany: deleteMany() },
    aiConversation: { deleteMany: deleteMany() },
    memberNotice: { deleteMany: deleteMany() },
    memberJoinLink: { deleteMany: deleteMany() },
    lead: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    membershipHold: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    checkInDenial: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    classBooking: {
      findMany: jest.fn().mockResolvedValue([{ sessionId: 'class-1' }, { sessionId: 'class-2' }]),
    },
    membership: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    user: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const supabase = {
    verifyPassword: jest.fn().mockImplementation(async () => {
      order.push('password');
      return 'ok';
    }),
    deleteAccountIdentity: jest.fn().mockImplementation(async () => {
      order.push('supabase');
    }),
  };
  const bookings = {
    cancel: jest.fn().mockImplementation(async () => {
      order.push('booking');
      return {};
    }),
  };
  const service = new AccountDeletionService(
    prisma as unknown as PrismaService,
    supabase as unknown as SupabaseAdminService,
    bookings as unknown as BookingsService,
  );
  return { service, prisma, tx, supabase, bookings, order };
}

async function caught(promise: Promise<unknown>): Promise<DomainException> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainException);
  return error as DomainException;
}

describe('DeleteMyAccountDto', () => {
  const errors = (body: Record<string, unknown>) =>
    validateSync(plainToInstance(DeleteMyAccountDto, body, { enableImplicitConversion: true }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    }).flatMap((e) => Object.keys(e.constraints ?? {}));

  it('needs confirm: true and a password', () => {
    expect(errors({ confirm: true, password: 'secret12' })).toEqual([]);
    expect(errors({ password: 'secret12' })).toContain('equals');
    expect(errors({ confirm: true })).toContain('isString');
  });

  it('never reads the string "false" as a confirmation', () => {
    expect(errors({ confirm: 'false', password: 'x' })).toContain('equals');
    expect(errors({ confirm: 'true', password: 'x' })).toContain('equals');
  });
});

describe('AccountDeletionService', () => {
  it('anonymises every personal field and sets deletedAt — only on a live row', async () => {
    const { service, tx } = build();
    await service.deleteOwnAccount(USER, 'secret12', NOW);

    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: USER.id, deletedAt: null },
      data: anonymisedUserData(USER.id, NOW),
    });
    expect(anonymisedUserData(USER.id, NOW)).toEqual({
      firstName: 'Deleted',
      lastName: 'member',
      email: PLACEHOLDER,
      phone: null,
      avatarUrl: null,
      memberCode: null,
      seniorPwdIdNo: null,
      dateOfBirth: null,
      heightCm: null,
      weightKg: null,
      medicalNotes: null,
      shareMedicalWithPlanner: false,
      emergencyContact: null,
      emergencyContactName: null,
      emergencyContactPhone: null,
      emergencyContactRelation: null,
      deletedAt: NOW,
    });
  });

  it("deletes the member's own health and workout records", async () => {
    const { service, tx } = build();
    await service.deleteOwnAccount(USER, 'secret12', NOW);
    for (const model of ['bodyMeasurement', 'memberGoal', 'aiConversation', 'memberNotice']) {
      expect(tx[model as 'bodyMeasurement'].deleteMany).toHaveBeenCalledWith({
        where: { userId: USER.id },
      });
    }
    for (const model of [
      'workoutSetLog',
      'workoutSession',
      'memberWorkoutDraft',
      'memberWorkoutPlan',
      'workoutPlan',
      'workoutAiQuota',
    ]) {
      expect(tx[model as 'workoutSetLog'].deleteMany).toHaveBeenCalledWith({
        where: { memberId: USER.id },
      });
    }
  });

  it('redacts personal text on kept records: the lead, freeze reasons, denial notes', async () => {
    const { service, tx } = build();
    await service.deleteOwnAccount(USER, 'secret12', NOW);
    expect(tx.lead.updateMany).toHaveBeenCalledWith({
      where: { convertedUserId: USER.id },
      data: {
        name: REDACTED,
        email: PLACEHOLDER,
        phone: null,
        message: null,
        notes: null,
        originIpHash: null,
      },
    });
    expect(tx.membershipHold.updateMany).toHaveBeenCalledWith({
      where: { membership: { userId: USER.id } },
      data: { reason: 'Redacted' },
    });
    expect(tx.checkInDenial.updateMany).toHaveBeenCalledWith({
      where: { userId: USER.id },
      data: { notes: null },
    });
  });

  it('keeps payments, memberships, visits, bookings, chats and audit rows — never deletes them', async () => {
    const { service, tx } = build();
    await service.deleteOwnAccount(USER, 'secret12', NOW);
    for (const kept of [
      'payment',
      'membership',
      'checkIn',
      'classBooking',
      'auditLog',
      'chatMessage',
      'chatThread',
      'coachAssignment',
      'consentRecord',
    ]) {
      const delegate = (tx as Record<string, { deleteMany?: jest.Mock; delete?: jest.Mock }>)[
        kept
      ];
      expect(delegate?.deleteMany).toBeUndefined();
      expect(delegate?.delete).toBeUndefined();
    }
  });

  it('cancels every future booking through the normal cancel path, so waitlists move', async () => {
    const { service, prisma, bookings } = build();
    await service.deleteOwnAccount(USER, 'secret12', NOW);
    expect(prisma.classBooking.findMany).toHaveBeenCalledWith({
      where: {
        userId: USER.id,
        activeKey: { not: null },
        status: { in: ['BOOKED', 'WAITLISTED'] },
        session: { startsAt: { gt: NOW }, cancelledAt: null },
      },
      select: { sessionId: true },
    });
    expect(bookings.cancel).toHaveBeenCalledWith(USER.id, 'class-1', NOW);
    expect(bookings.cancel).toHaveBeenCalledWith(USER.id, 'class-2', NOW);
  });

  it('a booking that cannot be cancelled any more does not stop the deletion', async () => {
    const { service, bookings, tx } = build();
    bookings.cancel.mockRejectedValueOnce(new Error('CLASS_ALREADY_STARTED'));
    await service.deleteOwnAccount(USER, 'secret12', NOW);
    expect(bookings.cancel).toHaveBeenCalledTimes(2);
    expect(tx.user.updateMany).toHaveBeenCalled();
  });

  it('closes an open visit and ends an active coach assignment (notes kept)', async () => {
    const { service, tx } = build();
    await service.deleteOwnAccount(USER, 'secret12', NOW);
    expect(tx.checkIn.updateMany).toHaveBeenCalledWith({
      where: { openUserId: USER.id, endedAt: null },
      data: { endedAt: NOW, closeMethod: 'MANUAL', closedById: USER.id, openUserId: null },
    });
    expect(tx.coachAssignment.updateMany).toHaveBeenCalledWith({
      where: { memberId: USER.id, status: 'ACTIVE' },
      data: { status: 'ENDED', endedAt: NOW, endedById: USER.id, activeMemberId: null },
    });
  });

  it('password, then bookings, then the local erasure, and Supabase LAST', async () => {
    const { service, order } = build();
    await service.deleteOwnAccount(USER, 'secret12', NOW);
    expect(order).toEqual(['password', 'booking', 'booking', 'anonymise', 'supabase']);
  });

  it('stamps authErasedAt once Supabase has deleted the identity', async () => {
    const { service, prisma, supabase } = build();
    await service.deleteOwnAccount(USER, 'secret12', NOW);
    expect(supabase.deleteAccountIdentity).toHaveBeenCalledWith(USER.supabaseId);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: USER.id, authErasedAt: null },
      data: { authErasedAt: NOW },
    });
  });

  it('still succeeds when the Supabase delete fails, leaving authErasedAt for the retry job', async () => {
    const { service, supabase, prisma, tx } = build();
    supabase.deleteAccountIdentity.mockRejectedValue(
      new DomainException('ACCOUNT_DELETE_FAILED', 'down', 502),
    );
    await expect(service.deleteOwnAccount(USER, 'secret12', NOW)).resolves.toBeUndefined();
    expect(tx.user.updateMany).toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('a second submit that finds the row already deleted changes nothing more', async () => {
    const { service, tx, supabase } = build();
    tx.user.updateMany.mockResolvedValue({ count: 0 });
    await service.deleteOwnAccount(USER, 'secret12', NOW);
    expect(tx.bodyMeasurement.deleteMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(supabase.deleteAccountIdentity).not.toHaveBeenCalled();
  });

  it('refuses the wrong password and changes nothing', async () => {
    const { service, supabase, prisma, bookings } = build();
    supabase.verifyPassword.mockResolvedValue('wrong');
    const error = await caught(service.deleteOwnAccount(USER, 'nope', NOW));
    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toMatchObject({ code: 'WRONG_PASSWORD' });
    expect(bookings.cancel).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(supabase.deleteAccountIdentity).not.toHaveBeenCalled();
  });

  it('refuses when the password could not be checked, and changes nothing', async () => {
    const { service, supabase, prisma } = build();
    supabase.verifyPassword.mockResolvedValue('error');
    const error = await caught(service.deleteOwnAccount(USER, 'secret12', NOW));
    expect(error.getStatus()).toBe(502);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['FRONT_DESK', 'COACH', 'ADMIN', 'DEV'])('refuses a %s account', async (role) => {
    const { service, supabase, prisma } = build();
    const error = await caught(
      service.deleteOwnAccount({ ...USER, role } as AuthUser, 'secret12', NOW),
    );
    expect(error.getStatus()).toBe(403);
    expect(error.getResponse()).toMatchObject({ code: 'ACCOUNT_DELETE_NOT_ALLOWED' });
    expect(supabase.verifyPassword).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('writes the audit row in the transaction, with no personal data', async () => {
    const { service, tx } = build();
    await service.deleteOwnAccount(USER, 'secret12', NOW);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const [{ data }] = tx.auditLog.create.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(data).toMatchObject({
      action: 'MEMBER_SELF_DELETED',
      actorId: USER.id,
      actorRole: 'CLIENT',
      subjectType: 'User',
      subjectId: USER.id,
      subjectLabel: null,
      details: {
        bookingsCancelled: 2,
        visitClosed: true,
        coachAssignmentEnded: true,
        personalRecordsDeleted: 22,
        hadActivePlan: true,
      },
    });
    const text = JSON.stringify(data);
    for (const personal of ['Juan', 'Dela Cruz', 'juan@example.com', '175', '72.4', 'secret12']) {
      expect(text).not.toContain(personal);
    }
  });
});
