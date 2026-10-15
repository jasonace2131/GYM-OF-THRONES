import { PaymentStatus, PaymentVoidKind } from '@prisma/client';
import { DiscountType } from '@got/shared';
import type { GymConfigService } from '../config/gym.config';
import type { PermissionsService } from '../rbac/permissions.service';
import type { PlansService } from '../catalogue/plans.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ShiftsService } from './shifts.service';
import { PaymentsService } from './payments.service';
import type { AuditService } from '../audit/audit.service';
import type { VoidPaymentDto } from './dto/void-payment.dto';
import type { AmendPaymentDto } from './dto/amend-payment.dto';
import type { AuthUser } from '../auth/auth.types';

const ACTOR = { id: '11111111-1111-4111-8111-111111111111' } as unknown as AuthUser;

const PAYMENT_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-08-27T03:00:00.000Z');

interface PrismaMock {
  payment: {
    findUnique: jest.Mock;
    updateMany: jest.Mock;
    findUniqueOrThrow: jest.Mock;
  };
}

function buildPrisma(existing: Record<string, unknown> | null): PrismaMock {
  return {
    payment: {
      findUnique: jest.fn().mockResolvedValue(existing),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        ...existing,
        status: PaymentStatus.VOIDED,
      }),
    },
  };
}

/**
 * Captured so the void tests can assert an audit entry is written, and shared
 * across them so each `buildService` gets a fresh spy.
 */
let auditRecord: jest.Mock;
/** The amend suite asserts this is NEVER called — see §1.1. */
let requireOpenShiftId: jest.Mock;
let requireSellable: jest.Mock;
let getEffectivePermissions: jest.Mock;

interface ServiceOverrides {
  gym?: Record<string, unknown>;
  permissions?: string[];
  plan?: Record<string, unknown>;
}

function buildService(prisma: unknown, overrides: ServiceOverrides = {}): PaymentsService {
  auditRecord = jest.fn().mockResolvedValue(undefined);
  requireOpenShiftId = jest.fn().mockResolvedValue('an-open-shift');
  requireSellable = jest.fn().mockResolvedValue(
    overrides.plan ?? {
      id: 'plan-uuid',
      code: 'MONTH',
      name: 'Monthly',
      priceCentavos: 80_000,
      kind: 'MEMBERSHIP',
      isActive: true,
    },
  );
  getEffectivePermissions = jest
    .fn()
    .mockResolvedValue((overrides.permissions ?? []).map((key) => ({ key, scope: 'ALL' })));

  return new PaymentsService(
    prisma as unknown as PrismaService,
    {
      gcashVerifyThresholdCentavos: null,
      vatRegistered: false,
      ...(overrides.gym ?? {}),
    } as unknown as GymConfigService,
    { getEffectivePermissions } as unknown as PermissionsService,
    { requireSellable } as unknown as PlansService,
    { requireOpenShiftId } as unknown as ShiftsService,
    { record: auditRecord } as unknown as AuditService,
  );
}

/** Enough of a Payment row to satisfy toPaymentSummary's projection. */
const RECORDED_ROW = {
  id: PAYMENT_ID,
  userId: null,
  membershipId: null,
  purpose: 'WALK_IN',
  status: PaymentStatus.RECORDED,
  planCode: 'DAY',
  planName: 'Day Pass',
  grossCentavos: 10_000,
  vatBaseCentavos: 10_000,
  discountType: 'NONE',
  discountCentavos: 0,
  netCentavos: 10_000,
  vatExempt: false,
  statutoryIdNo: null,
  discountReason: null,
  termMonths: null,
  termStartsOn: null,
  termEndsOn: null,
  method: 'CASH',
  reference: null,
  receiptNo: null,
  receiptIssued: false,
  receivedAt: new Date('2026-08-27T02:00:00.000Z'),
  businessDate: new Date('2026-08-27T00:00:00.000Z'),
  shiftId: '77777777-7777-4777-8777-777777777777',
  recordedById: '88888888-8888-4888-8888-888888888888',
  notes: null,
  voidedAt: null,
  voidedById: null,
  voidReason: null,
  voidKind: null,
};

describe('PaymentsService.createInTx — receipt and GCash columns', () => {
  interface TxMock {
    payment: { createMany: jest.Mock; findUnique: jest.Mock; findFirst: jest.Mock };
  }
  const baseInput = {
    userId: null,
    membershipId: null,
    planId: 'p',
    planCode: 'WALKIN',
    planName: 'Walk-in day pass',
    purpose: 'WALK_IN',
    amounts: {
      grossCentavos: 9000,
      vatBaseCentavos: 9000,
      discountCentavos: 0,
      netCentavos: 9000,
      vatExempt: false,
    },
    discountType: 'NONE',
    statutoryIdNo: null,
    discountReason: null,
    termMonths: null,
    termStartsOn: null,
    termEndsOn: null,
    method: 'CASH',
    reference: null,
    gcashVerified: false,
    receiptNo: null,
    receivedAt: NOW,
    businessDate: '2026-08-27',
    shiftId: 's',
    recordedById: ACTOR.id,
    idempotencyKey: 'k1',
    idempotencyHash: 'h'.repeat(64),
    notes: null,
  } as unknown as Parameters<PaymentsService['createInTx']>[1];

  function buildTx(): TxMock {
    return {
      payment: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ ...RECORDED_ROW }),
        findFirst: jest.fn(),
      },
    };
  }

  const service = () =>
    buildService(buildPrisma(null)) as unknown as {
      createInTx: (tx: unknown, input: unknown) => Promise<unknown>;
    };

  it('derives receiptIssued from receiptNo, in both directions', async () => {
    const tx = buildTx();
    await service().createInTx(tx as unknown, { ...baseInput, receiptNo: 'INV-001' });
    let [{ data }] = tx.payment.createMany.mock.calls[0] as [{ data: Record<string, unknown>[] }];
    expect(data[0]).toMatchObject({ receiptNo: 'INV-001', receiptIssued: true });

    const tx2 = buildTx();
    await service().createInTx(tx2 as unknown, baseInput);
    [{ data }] = tx2.payment.createMany.mock.calls[0] as [{ data: Record<string, unknown>[] }];
    expect(data[0]).toMatchObject({ receiptNo: null, receiptIssued: false });
  });

  it('normalizes the reference and writes the attestation pair together', async () => {
    const tx = buildTx();
    await service().createInTx(tx as unknown, {
      ...baseInput,
      method: 'GCASH',
      reference: '6028 871 884223',
      gcashVerified: true,
    });
    const [{ data }] = tx.payment.createMany.mock.calls[0] as [
      { data: Record<string, unknown>[] },
    ];
    expect(data[0]).toMatchObject({
      reference: '6028 871 884223',
      referenceNormalized: '6028871884223',
      gcashVerifiedAt: NOW,
      gcashVerifiedById: ACTOR.id,
    });
  });

  it('never writes the attestation pair on a CASH row, even if the flag is set', async () => {
    const tx = buildTx();
    await service().createInTx(tx as unknown, { ...baseInput, gcashVerified: true });
    const [{ data }] = tx.payment.createMany.mock.calls[0] as [
      { data: Record<string, unknown>[] },
    ];
    expect(data[0]).toMatchObject({ gcashVerifiedAt: null, gcashVerifiedById: null });
  });

  it('names the duplicate when the insert was swallowed by the reference index', async () => {
    const tx = buildTx();
    tx.payment.createMany.mockResolvedValue({ count: 0 });
    tx.payment.findUnique.mockResolvedValue(null); // not an idempotency replay
    tx.payment.findFirst.mockResolvedValue({
      businessDate: new Date('2026-08-20T00:00:00.000Z'),
      netCentavos: 9000,
    });

    await expect(
      service().createInTx(tx as unknown, {
        ...baseInput,
        method: 'GCASH',
        reference: '6028871884223',
      }),
    ).rejects.toMatchObject({ response: { code: 'GCASH_REFERENCE_DUPLICATE' } });
  });
});

describe('PaymentsService.void — kind handling', () => {
  it('writes voidKind: VOID alongside voidedAt/voidedById/voidReason for a plain void', async () => {
    const prisma = buildPrisma(RECORDED_ROW);
    const service = buildService(prisma);
    const dto: VoidPaymentDto = {
      confirm: true,
      reason: 'rang the wrong plan',
      kind: PaymentVoidKind.VOID,
    };

    await service.void(ACTOR, PAYMENT_ID, dto, NOW);

    expect(prisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: PAYMENT_ID, status: PaymentStatus.RECORDED },
      data: {
        status: PaymentStatus.VOIDED,
        voidedAt: NOW,
        voidedById: ACTOR.id,
        voidReason: dto.reason,
        voidKind: PaymentVoidKind.VOID,
      },
    });
  });

  it('writes voidKind: REFUND when the desk records money returned', async () => {
    const prisma = buildPrisma(RECORDED_ROW);
    const service = buildService(prisma);
    const dto: VoidPaymentDto = {
      confirm: true,
      reason: 'member asked for money back',
      kind: PaymentVoidKind.REFUND,
    };

    await service.void(ACTOR, PAYMENT_ID, dto, NOW);

    expect(prisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ voidKind: PaymentVoidKind.REFUND }) }),
    );
  });

  it('still 404s a missing payment before touching kind at all', async () => {
    const prisma = buildPrisma(null);
    const service = buildService(prisma);
    const dto: VoidPaymentDto = { confirm: true, reason: 'x'.repeat(5), kind: PaymentVoidKind.VOID };

    await expect(service.void(ACTOR, PAYMENT_ID, dto, NOW)).rejects.toMatchObject({
      response: { code: 'PAYMENT_NOT_FOUND' },
    });
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
  });

  it('records an audit entry carrying the operator reason and the amount taken back', async () => {
    const prisma = buildPrisma(RECORDED_ROW);
    const service = buildService(prisma);
    const dto: VoidPaymentDto = {
      confirm: true,
      reason: 'charged twice at the counter',
      kind: PaymentVoidKind.REFUND,
    };

    await service.void(ACTOR, PAYMENT_ID, dto, NOW);

    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PAYMENT_VOIDED',
        actorId: ACTOR.id,
        subjectType: 'Payment',
        subjectId: PAYMENT_ID,
        reason: 'charged twice at the counter',
      }),
      NOW,
    );
  });

  /**
   * The guarded UPDATE is what makes two simultaneous voids produce one
   * winner. The audit entry has to sit on the same side of that guard, or a
   * losing operator would leave a line claiming they voided something they
   * did not.
   */
  it('writes NO audit entry when another operator won the void a moment earlier', async () => {
    const prisma = buildPrisma(RECORDED_ROW);
    prisma.payment.updateMany.mockResolvedValue({ count: 0 });
    const service = buildService(prisma);
    const dto: VoidPaymentDto = { confirm: true, reason: 'x'.repeat(5), kind: PaymentVoidKind.VOID };

    await expect(service.void(ACTOR, PAYMENT_ID, dto, NOW)).rejects.toMatchObject({
      response: { code: 'PAYMENT_ALREADY_VOIDED' },
    });
    expect(auditRecord).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * AMEND — the void-and-re-record correction.
 * ═══════════════════════════════════════════════════════════════════════════ */

const REPLACEMENT_ID = '33333333-3333-4333-8333-333333333333';
const ORIGINAL_SHIFT = '77777777-7777-4777-8777-777777777777';

/** A RECORDED row with every column `amend()` reads off the original. */
const AMEND_ORIGINAL = {
  ...RECORDED_ROW,
  planId: 'plan-original-uuid',
  userId: null,
  purpose: 'WALK_IN',
  planCode: 'WALKIN',
  planName: 'Walk-in day pass',
  grossCentavos: 9000,
  vatBaseCentavos: 9000,
  netCentavos: 9000,
  referenceNormalized: null,
  gcashVerifiedAt: null,
  gcashVerifiedById: null,
  proofPath: null,
  idempotencyKey: 'walkin:original',
  idempotencyHash: 'a'.repeat(64),
  replacesPaymentId: null,
  archivedAt: null,
  archivedById: null,
  createdAt: new Date('2026-08-27T02:00:00.000Z'),
  updatedAt: new Date('2026-08-27T02:00:00.000Z'),
  shiftId: ORIGINAL_SHIFT,
  // Included by `amend()`'s in-transaction read.
  replacedBy: null,
  shift: { closedAt: null },
};

interface AmendTxMock {
  payment: {
    findUnique: jest.Mock;
    updateMany: jest.Mock;
    createMany: jest.Mock;
    findFirst: jest.Mock;
  };
  checkIn: { updateMany: jest.Mock };
  gcashSubmission: { updateMany: jest.Mock };
}

function buildAmendTx(original: Record<string, unknown>): AmendTxMock {
  const tx: AmendTxMock = {
    payment: {
      // `createInTx` reads the stored row back by idempotencyKey; `amend()`
      // reads the original by id. One mock, dispatched on the `where` shape.
      //
      // The read-back returns WHAT WAS INSERTED, not a copy of the original —
      // otherwise the audit's `after` block would be asserted against the
      // before values and every amend would look like a no-op that passed.
      findUnique: jest.fn((args: { where: Record<string, unknown> }) => {
        if (args.where['idempotencyKey'] === undefined) return Promise.resolve(original);
        const call = tx.payment.createMany.mock.calls[0] as
          | [{ data: Record<string, unknown>[] }]
          | undefined;
        return Promise.resolve({ ...original, ...(call?.[0].data[0] ?? {}), id: REPLACEMENT_ID });
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    checkIn: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    gcashSubmission: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  return tx;
}

function buildAmendPrisma(
  preload: Record<string, unknown> | null,
  tx: AmendTxMock,
): { payment: { findUnique: jest.Mock }; $transaction: jest.Mock } {
  return {
    payment: { findUnique: jest.fn().mockResolvedValue(preload) },
    $transaction: jest.fn((run: (t: unknown) => Promise<unknown>) => run(tx)),
  };
}

/** The `data` object handed to the one Payment INSERT. */
function insertedRow(tx: AmendTxMock): Record<string, unknown> {
  const [{ data }] = tx.payment.createMany.mock.calls[0] as [{ data: Record<string, unknown>[] }];
  return data[0]!;
}

const AMEND_DTO: AmendPaymentDto = {
  confirm: true,
  reason: 'rang the wrong plan',
} as AmendPaymentDto;

describe('PaymentsService.amend', () => {
  it('refuses an amend with no confirmation, before reading anything', async () => {
    const tx = buildAmendTx(AMEND_ORIGINAL);
    const prisma = buildAmendPrisma(AMEND_ORIGINAL, tx);
    const service = buildService(prisma);

    await expect(
      service.amend(ACTOR, PAYMENT_ID, { reason: 'x'.repeat(5) } as AmendPaymentDto, NOW),
    ).rejects.toMatchObject({ response: { code: 'CONFIRMATION_REQUIRED' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('404s a payment that does not exist', async () => {
    const tx = buildAmendTx(AMEND_ORIGINAL);
    const prisma = buildAmendPrisma(null, tx);

    await expect(
      buildService(prisma).amend(ACTOR, PAYMENT_ID, AMEND_DTO, NOW),
    ).rejects.toMatchObject({ response: { code: 'PAYMENT_NOT_FOUND' } });
  });

  it('refuses to amend a payment that is already voided', async () => {
    const voided = { ...AMEND_ORIGINAL, status: PaymentStatus.VOIDED };
    const tx = buildAmendTx(voided);
    const prisma = buildAmendPrisma(voided, tx);

    await expect(
      buildService(prisma).amend(ACTOR, PAYMENT_ID, AMEND_DTO, NOW),
    ).rejects.toMatchObject({ response: { code: 'PAYMENT_ALREADY_VOIDED' } });
    expect(tx.payment.createMany).not.toHaveBeenCalled();
  });

  /**
   * `Payment_replacesPaymentId_key` makes the chain a linked LIST. A second
   * amend of one original would be a tree, and "which row is live" would have
   * two answers.
   */
  it('refuses to amend a payment that has already been superseded', async () => {
    const amended = { ...AMEND_ORIGINAL, replacedBy: { id: REPLACEMENT_ID } };
    const tx = buildAmendTx(amended);
    const prisma = buildAmendPrisma(amended, tx);

    await expect(
      buildService(prisma).amend(ACTOR, PAYMENT_ID, AMEND_DTO, NOW),
    ).rejects.toMatchObject({ response: { code: 'PAYMENT_ALREADY_AMENDED' } });
    expect(tx.payment.createMany).not.toHaveBeenCalled();
  });

  /** Two operators, one winner — the guarded UPDATE is the concurrency control. */
  it('refuses when the guarded void UPDATE claimed nothing', async () => {
    const tx = buildAmendTx(AMEND_ORIGINAL);
    tx.payment.updateMany.mockResolvedValue({ count: 0 });
    const prisma = buildAmendPrisma(AMEND_ORIGINAL, tx);

    await expect(
      buildService(prisma).amend(ACTOR, PAYMENT_ID, AMEND_DTO, NOW),
    ).rejects.toMatchObject({ response: { code: 'PAYMENT_ALREADY_VOIDED' } });
    expect(tx.payment.createMany).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE ORDERING IS LOAD-BEARING.
   *
   * `Payment_gcash_reference_unique` is partial: ON ("referenceNormalized")
   * WHERE method = 'GCASH' AND status <> 'VOIDED'. Voting the original FIRST,
   * inside the same transaction, removes it from that predicate — which is
   * the only reason the corrected row may carry the SAME reference. Insert
   * first and the amend fails on every GCash payment whose reference is not
   * being changed, which is most of them.
   * ═════════════════════════════════════════════════════════════════════════
   */
  it('issues the void UPDATE strictly BEFORE the replacement INSERT', async () => {
    const tx = buildAmendTx(AMEND_ORIGINAL);
    const prisma = buildAmendPrisma(AMEND_ORIGINAL, tx);

    await buildService(prisma).amend(ACTOR, PAYMENT_ID, AMEND_DTO, NOW);

    const voidOrder = tx.payment.updateMany.mock.invocationCallOrder[0]!;
    const insertOrder = tx.payment.createMany.mock.invocationCallOrder[0]!;
    expect(voidOrder).toBeLessThan(insertOrder);
  });

  it('voids the original with the amend reason and voidKind VOID', async () => {
    const tx = buildAmendTx(AMEND_ORIGINAL);
    const prisma = buildAmendPrisma(AMEND_ORIGINAL, tx);

    await buildService(prisma).amend(ACTOR, PAYMENT_ID, AMEND_DTO, NOW);

    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: PAYMENT_ID, status: PaymentStatus.RECORDED },
      data: {
        status: PaymentStatus.VOIDED,
        voidedAt: NOW,
        voidedById: ACTOR.id,
        voidReason: `Amended — ${AMEND_DTO.reason}`,
        voidKind: PaymentVoidKind.VOID,
      },
    });
  });

  /**
   * §1.1. An amend moves no money — it restates a row whose cash was already
   * counted in the shift it names. Attributing Tuesday's corrected ₱800 to
   * Thursday's open drawer would put money in a box it was never in and make
   * BOTH days wrong.
   */
  it('inherits shiftId, businessDate and receivedAt from the original', async () => {
    const tx = buildAmendTx(AMEND_ORIGINAL);
    const prisma = buildAmendPrisma(AMEND_ORIGINAL, tx);

    await buildService(prisma).amend(ACTOR, PAYMENT_ID, AMEND_DTO, NOW);

    expect(insertedRow(tx)).toMatchObject({
      shiftId: ORIGINAL_SHIFT,
      businessDate: new Date('2026-08-27T00:00:00.000Z'),
      receivedAt: AMEND_ORIGINAL.receivedAt,
    });
  });

  it('never asks for an open shift — a closed one is amendable', async () => {
    const tx = buildAmendTx(AMEND_ORIGINAL);
    const prisma = buildAmendPrisma({ ...AMEND_ORIGINAL, shift: { closedAt: NOW } }, tx);
    tx.payment.findUnique.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve(
        args.where['idempotencyKey'] === undefined
          ? { ...AMEND_ORIGINAL, shift: { closedAt: NOW } }
          : { ...AMEND_ORIGINAL, id: REPLACEMENT_ID },
      ),
    );

    await buildService(prisma).amend(ACTOR, PAYMENT_ID, AMEND_DTO, NOW);

    expect(requireOpenShiftId).not.toHaveBeenCalled();
  });

  it('attributes the replacement to the AMENDING actor, not the original recorder', async () => {
    const tx = buildAmendTx(AMEND_ORIGINAL);
    const prisma = buildAmendPrisma(AMEND_ORIGINAL, tx);

    await buildService(prisma).amend(ACTOR, PAYMENT_ID, AMEND_DTO, NOW);

    expect(insertedRow(tx)['recordedById']).toBe(ACTOR.id);
    expect(insertedRow(tx)['recordedById']).not.toBe(AMEND_ORIGINAL.recordedById);
  });

  /**
   * The archived-plan case. Re-resolving a plan that has not changed would
   * fail an amend on a since-archived plan, or silently reprice a sale whose
   * plan has since gone up.
   */
  it('does NOT re-resolve the plan when planCode is unchanged', async () => {
    const tx = buildAmendTx(AMEND_ORIGINAL);
    const prisma = buildAmendPrisma(AMEND_ORIGINAL, tx);

    await buildService(prisma).amend(
      ACTOR,
      PAYMENT_ID,
      { ...AMEND_DTO, planCode: AMEND_ORIGINAL.planCode } as AmendPaymentDto,
      NOW,
    );

    expect(requireSellable).not.toHaveBeenCalled();
    expect(insertedRow(tx)).toMatchObject({
      planCode: 'WALKIN',
      grossCentavos: 9000,
    });
  });

  it('re-resolves the plan when planCode changed, and prices from it', async () => {
    const tx = buildAmendTx(AMEND_ORIGINAL);
    const prisma = buildAmendPrisma(AMEND_ORIGINAL, tx);

    await buildService(prisma).amend(
      ACTOR,
      PAYMENT_ID,
      { ...AMEND_DTO, planCode: 'MONTH' } as AmendPaymentDto,
      NOW,
    );

    expect(requireSellable).toHaveBeenCalledWith(tx, 'MONTH');
    expect(insertedRow(tx)).toMatchObject({
      planCode: 'MONTH',
      planName: 'Monthly',
      planId: 'plan-uuid',
      grossCentavos: 80_000,
      netCentavos: 80_000,
    });
  });

  it('inherits every omitted field, and treats an empty string as a clear', async () => {
    const withExtras = {
      ...AMEND_ORIGINAL,
      receiptNo: 'INV-0042',
      receiptIssued: true,
      notes: 'paid at the counter',
    };
    const tx = buildAmendTx(withExtras);
    const prisma = buildAmendPrisma(withExtras, tx);

    // Nothing but the reason: everything inherits.
    await buildService(prisma).amend(ACTOR, PAYMENT_ID, AMEND_DTO, NOW);
    expect(insertedRow(tx)).toMatchObject({
      receiptNo: 'INV-0042',
      receiptIssued: true,
      notes: 'paid at the counter',
      method: 'CASH',
    });

    // '' is the operator saying "there is no booklet number after all".
    const tx2 = buildAmendTx(withExtras);
    const prisma2 = buildAmendPrisma(withExtras, tx2);
    await buildService(prisma2).amend(
      ACTOR,
      PAYMENT_ID,
      { ...AMEND_DTO, receiptNo: '', notes: '' } as AmendPaymentDto,
      NOW,
    );
    expect(insertedRow(tx2)).toMatchObject({
      receiptNo: null,
      receiptIssued: false,
      notes: null,
    });
  });

  it('refuses to move the payer on anything but a WALK_IN', async () => {
    const membership = {
      ...AMEND_ORIGINAL,
      purpose: 'MEMBERSHIP',
      userId: '44444444-4444-4444-8444-444444444444',
      membershipId: '55555555-5555-4555-8555-555555555555',
      termMonths: 1,
    };
    const tx = buildAmendTx(membership);
    const prisma = buildAmendPrisma(membership, tx);

    await expect(
      buildService(prisma).amend(
        ACTOR,
        PAYMENT_ID,
        { ...AMEND_DTO, userId: '66666666-6666-4666-8666-666666666666' } as AmendPaymentDto,
        NOW,
      ),
    ).rejects.toMatchObject({ response: { code: 'PAYMENT_PAYER_IMMUTABLE' } });
    expect(tx.payment.createMany).not.toHaveBeenCalled();
  });

  it('accepts a new payer on a WALK_IN — that is the conversion case', async () => {
    const tx = buildAmendTx(AMEND_ORIGINAL);
    const prisma = buildAmendPrisma(AMEND_ORIGINAL, tx);

    await buildService(prisma).amend(
      ACTOR,
      PAYMENT_ID,
      { ...AMEND_DTO, userId: '66666666-6666-4666-8666-666666666666' } as AmendPaymentDto,
      NOW,
    );

    expect(insertedRow(tx)['userId']).toBe('66666666-6666-4666-8666-666666666666');
  });

  it('derives the replacement idempotency key from the original id', async () => {
    const tx = buildAmendTx(AMEND_ORIGINAL);
    const prisma = buildAmendPrisma(AMEND_ORIGINAL, tx);

    await buildService(prisma).amend(ACTOR, PAYMENT_ID, AMEND_DTO, NOW);

    expect(insertedRow(tx)['idempotencyKey']).toBe(`amend:${PAYMENT_ID}`);
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE LINE THAT LOSES REVENUE SILENTLY IF IT IS MISSED.
   *
   * `reports.walkInStats` reads `CheckIn.payment.status`. Leave the visit
   * pointing at the voided original and a ₱90 day pass reads as ₱0 forever,
   * with no error anywhere. `CheckIn_entry_shape` also requires a WALK_IN's
   * paymentId NOT NULL, so it must MOVE, never clear.
   * ═════════════════════════════════════════════════════════════════════════
   */
  it('re-points the funded walk-in visit at the replacement', async () => {
    const tx = buildAmendTx(AMEND_ORIGINAL);
    const prisma = buildAmendPrisma(AMEND_ORIGINAL, tx);

    await buildService(prisma).amend(ACTOR, PAYMENT_ID, AMEND_DTO, NOW);

    expect(tx.checkIn.updateMany).toHaveBeenCalledWith({
      where: { paymentId: PAYMENT_ID },
      data: { paymentId: REPLACEMENT_ID },
    });
  });

  it('leaves check-ins alone for a MEMBERSHIP payment, and still moves the GCash claim', async () => {
    const membership = {
      ...AMEND_ORIGINAL,
      purpose: 'MEMBERSHIP',
      userId: '44444444-4444-4444-8444-444444444444',
      membershipId: '55555555-5555-4555-8555-555555555555',
      termMonths: 1,
    };
    const tx = buildAmendTx(membership);
    const prisma = buildAmendPrisma(membership, tx);

    await buildService(prisma).amend(ACTOR, PAYMENT_ID, AMEND_DTO, NOW);

    expect(tx.checkIn.updateMany).not.toHaveBeenCalled();
    // GcashSubmission_status_shape requires APPROVED ⇒ paymentId NOT NULL.
    expect(tx.gcashSubmission.updateMany).toHaveBeenCalledWith({
      where: { paymentId: PAYMENT_ID },
      data: { paymentId: REPLACEMENT_ID },
    });
  });

  it('writes a PAYMENT_AMENDED audit entry with before/after and the link', async () => {
    const tx = buildAmendTx(AMEND_ORIGINAL);
    const prisma = buildAmendPrisma(AMEND_ORIGINAL, tx);

    await buildService(prisma).amend(
      ACTOR,
      PAYMENT_ID,
      { ...AMEND_DTO, planCode: 'MONTH' } as AmendPaymentDto,
      NOW,
    );

    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PAYMENT_AMENDED',
        actorId: ACTOR.id,
        subjectType: 'Payment',
        subjectId: REPLACEMENT_ID,
        reason: AMEND_DTO.reason,
        details: expect.objectContaining({
          replacesPaymentId: PAYMENT_ID,
          businessDate: '2026-08-27',
          shiftId: ORIGINAL_SHIFT,
          shiftWasClosed: false,
          before: expect.objectContaining({ planCode: 'WALKIN', netCentavos: 9000 }),
          after: expect.objectContaining({ planCode: 'MONTH', netCentavos: 80_000 }),
        }),
      }),
      NOW,
    );
  });

  /** §1.1's consequence, said out loud in the trail as well as in the UI. */
  it('records shiftWasClosed when the original belongs to a closed drawer', async () => {
    const closed = { ...AMEND_ORIGINAL, shift: { closedAt: new Date('2026-08-27T14:00:00.000Z') } };
    const tx = buildAmendTx(closed);
    const prisma = buildAmendPrisma(closed, tx);

    await buildService(prisma).amend(ACTOR, PAYMENT_ID, AMEND_DTO, NOW);

    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ shiftWasClosed: true }),
      }),
      NOW,
    );
  });

  /**
   * The discount keys are resolved in the service, not by a second decorator:
   * `@RequirePermission` uses getAllAndOverride, so a route carries exactly
   * one key. An amend that INTRODUCES a discretionary discount must clear the
   * same bar a fresh sale would.
   */
  it('checks the discount permission for a discount the amend introduces', async () => {
    const tx = buildAmendTx(AMEND_ORIGINAL);
    const prisma = buildAmendPrisma(AMEND_ORIGINAL, tx);

    await expect(
      buildService(prisma, { permissions: [] }).amend(
        ACTOR,
        PAYMENT_ID,
        {
          ...AMEND_DTO,
          discountType: DiscountType.GOODWILL,
          discountCentavos: 1000,
          discountReason: 'regular, machine was down',
        } as AmendPaymentDto,
        NOW,
      ),
    ).rejects.toMatchObject({ message: 'Missing required permission: payment.discount.grant' });

    expect(getEffectivePermissions).toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('lets the discount through when the actor holds the key', async () => {
    const tx = buildAmendTx(AMEND_ORIGINAL);
    const prisma = buildAmendPrisma(AMEND_ORIGINAL, tx);

    await buildService(prisma, { permissions: ['payment.discount.grant'] }).amend(
      ACTOR,
      PAYMENT_ID,
      {
        ...AMEND_DTO,
        discountType: DiscountType.GOODWILL,
        discountCentavos: 1000,
        discountReason: 'regular, machine was down',
      } as AmendPaymentDto,
      NOW,
    );

    expect(insertedRow(tx)).toMatchObject({
      discountType: DiscountType.GOODWILL,
      discountCentavos: 1000,
      netCentavos: 8000,
    });
  });

  /**
   * `AuditService.record()` never throws for a documented reason — but if the
   * promise ever did reject, the correction the operator has already told the
   * member about must not unwind.
   */
  it('does not fail the amend when the audit write rejects', async () => {
    const tx = buildAmendTx(AMEND_ORIGINAL);
    const prisma = buildAmendPrisma(AMEND_ORIGINAL, tx);
    const service = buildService(prisma);
    auditRecord.mockRejectedValue(new Error('audit table unreachable'));

    await expect(service.amend(ACTOR, PAYMENT_ID, AMEND_DTO, NOW)).resolves.toMatchObject({
      id: REPLACEMENT_ID,
    });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ARCHIVE — soft delete, mirroring User.deletedAt.
 * ═══════════════════════════════════════════════════════════════════════════ */

interface ArchivePrismaMock {
  payment: { findUnique: jest.Mock; updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
}

function buildArchivePrisma(existing: Record<string, unknown> | null): ArchivePrismaMock {
  return {
    payment: {
      findUnique: jest.fn().mockResolvedValue(existing),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ ...RECORDED_ROW, ...existing }),
    },
  };
}

describe('PaymentsService.archive / unarchive', () => {
  /** The pair moves together — Payment_archive_shape makes half of it illegal. */
  it('sets archivedAt AND archivedById, never one of them', async () => {
    const prisma = buildArchivePrisma({ ...RECORDED_ROW, archivedAt: null, archivedById: null });

    await buildService(prisma).archive(ACTOR, PAYMENT_ID, NOW);

    expect(prisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: PAYMENT_ID, archivedAt: null },
      data: { archivedAt: NOW, archivedById: ACTOR.id },
    });
  });

  it('clears both columns on unarchive', async () => {
    const prisma = buildArchivePrisma({ ...RECORDED_ROW, archivedAt: NOW, archivedById: ACTOR.id });

    await buildService(prisma).unarchive(ACTOR, PAYMENT_ID, NOW);

    expect(prisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: PAYMENT_ID, archivedAt: { not: null } },
      data: { archivedAt: null, archivedById: null },
    });
  });

  it('refuses to archive a row that is already archived', async () => {
    const prisma = buildArchivePrisma({ ...RECORDED_ROW, archivedAt: NOW, archivedById: ACTOR.id });
    prisma.payment.updateMany.mockResolvedValue({ count: 0 });

    await expect(buildService(prisma).archive(ACTOR, PAYMENT_ID, NOW)).rejects.toMatchObject({
      response: { code: 'PAYMENT_ALREADY_ARCHIVED' },
    });
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('refuses to unarchive a row that is not archived', async () => {
    const prisma = buildArchivePrisma({ ...RECORDED_ROW, archivedAt: null, archivedById: null });
    prisma.payment.updateMany.mockResolvedValue({ count: 0 });

    await expect(buildService(prisma).unarchive(ACTOR, PAYMENT_ID, NOW)).rejects.toMatchObject({
      response: { code: 'PAYMENT_NOT_ARCHIVED' },
    });
  });

  it('404s before touching anything when the payment does not exist', async () => {
    const prisma = buildArchivePrisma(null);

    await expect(buildService(prisma).archive(ACTOR, PAYMENT_ID, NOW)).rejects.toMatchObject({
      response: { code: 'PAYMENT_NOT_FOUND' },
    });
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
  });

  /**
   * ARCHIVING A RECORDED PAYMENT IS ALLOWED, DELIBERATELY. A hard block would
   * stop it being a soft delete, which is what the owner asked for. The
   * console's confirm dialog says what it does and does not change; it does
   * not refuse.
   */
  it('archives a RECORDED payment without complaint', async () => {
    const prisma = buildArchivePrisma({
      ...RECORDED_ROW,
      status: PaymentStatus.RECORDED,
      archivedAt: null,
      archivedById: null,
    });

    await expect(buildService(prisma).archive(ACTOR, PAYMENT_ID, NOW)).resolves.toMatchObject({
      id: PAYMENT_ID,
    });
  });

  it('records the two audit actions', async () => {
    const prisma = buildArchivePrisma({ ...RECORDED_ROW, archivedAt: null, archivedById: null });
    await buildService(prisma).archive(ACTOR, PAYMENT_ID, NOW);
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PAYMENT_ARCHIVED', subjectId: PAYMENT_ID }),
      NOW,
    );

    const prisma2 = buildArchivePrisma({ ...RECORDED_ROW, archivedAt: NOW, archivedById: ACTOR.id });
    await buildService(prisma2).unarchive(ACTOR, PAYMENT_ID, NOW);
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PAYMENT_UNARCHIVED', subjectId: PAYMENT_ID }),
      NOW,
    );
  });
});
