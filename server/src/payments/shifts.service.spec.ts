import { HttpStatus, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainException } from '../common/exceptions/domain.exception';
import { civilDateFromPrisma } from '../common/time/gym-time';
import type { GymConfigService } from '../config/gym.config';
import type { PrismaService } from '../prisma/prisma.service';
import {
  OPEN_MARKER,
  ShiftsService,
  assertVarianceExplained,
  computeClosure,
} from './shifts.service';

const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const SHIFT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const GYM = {
  timeZone: 'Asia/Manila',
  shiftVarianceNoteThresholdCentavos: 20_000,
} as unknown as GymConfigService;

interface PrismaMock {
  shift: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    updateMany: jest.Mock;
  };
  payment: { aggregate: jest.Mock };
  $transaction: jest.Mock;
}

function buildPrisma(): PrismaMock {
  const mock: PrismaMock = {
    shift: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
    },
    payment: { aggregate: jest.fn().mockResolvedValue({ _sum: { netCentavos: null } }) },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation(async (fn: (tx: PrismaMock) => Promise<unknown>) =>
    fn(mock),
  );
  return mock;
}

function shiftRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: SHIFT_ID,
    status: 'OPEN',
    openedById: ACTOR_ID,
    openedAt: new Date('2026-08-19T21:00:00.000Z'),
    openingFloatCentavos: 300_000,
    closedById: null,
    closedAt: null,
    countedCentavos: null,
    expectedCentavos: null,
    varianceCentavos: null,
    note: null,
    businessDate: new Date('2026-08-20T00:00:00.000Z'),
    openMarker: OPEN_MARKER,
    createdAt: new Date('2026-08-19T21:00:00.000Z'),
    updatedAt: new Date('2026-08-19T21:00:00.000Z'),
    ...overrides,
  };
}

function build(prisma: PrismaMock): ShiftsService {
  return new ShiftsService(prisma as unknown as PrismaService, GYM);
}

describe('computeClosure', () => {
  it('expects the float plus every recorded cash peso, and reports a clean count as zero', () => {
    // ₱3,000 float, one walk-in at ₱90 and one monthly at ₱800.
    expect(computeClosure(300_000, 89_000, 389_000)).toEqual({
      expectedCentavos: 389_000,
      varianceCentavos: 0,
    });
  });

  it('reports a short drawer as a negative variance and a long one as positive', () => {
    expect(computeClosure(300_000, 89_000, 384_000).varianceCentavos).toBe(-5_000);
    expect(computeClosure(300_000, 89_000, 394_000).varianceCentavos).toBe(5_000);
  });

  it('expects exactly the float on a shift that took no cash', () => {
    expect(computeClosure(300_000, 0, 300_000)).toEqual({
      expectedCentavos: 300_000,
      varianceCentavos: 0,
    });
  });
});

describe('assertVarianceExplained', () => {
  it('passes a variance inside ±₱200 with no note', () => {
    expect(() =>
      assertVarianceExplained(
        { expectedCentavos: 389_000, varianceCentavos: -20_000 },
        undefined,
        20_000,
      ),
    ).not.toThrow();
  });

  it('demands a note beyond the threshold — the only thing that makes a blind count useful', () => {
    try {
      assertVarianceExplained(
        { expectedCentavos: 389_000, varianceCentavos: -25_000 },
        undefined,
        20_000,
      );
      throw new Error('assertVarianceExplained did not throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainException);
      expect((error as DomainException).code).toBe('SHIFT_VARIANCE_REASON_REQUIRED');
      expect((error as DomainException).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    }
  });

  it('accepts a real note and refuses a whitespace one', () => {
    expect(() =>
      assertVarianceExplained(
        { expectedCentavos: 389_000, varianceCentavos: 25_000 },
        'extra ₱250 from yesterday, logged in the book',
        20_000,
      ),
    ).not.toThrow();
    expect(() =>
      assertVarianceExplained(
        { expectedCentavos: 389_000, varianceCentavos: 25_000 },
        '   ',
        20_000,
      ),
    ).toThrow(DomainException);
  });
});

describe('ShiftsService.open', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('stamps the GYM-LOCAL business date, not the UTC one', async () => {
    // 16:30 UTC is 00:30 the NEXT day in Manila. A shift opened just after
    // midnight local belongs to the new business day.
    jest.useFakeTimers().setSystemTime(new Date('2026-08-19T16:30:00.000Z'));
    const prisma = buildPrisma();
    prisma.shift.create.mockResolvedValue(shiftRow());

    await build(prisma).open(ACTOR_ID, { openingFloatCentavos: 300_000 });

    const data = prisma.shift.create.mock.calls[0][0].data as { businessDate: Date };
    expect(civilDateFromPrisma(data.businessDate)).toBe('2026-08-20');
  });

  it('keeps a 23:30 Manila open on the same business day', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-19T15:30:00.000Z'));
    const prisma = buildPrisma();
    prisma.shift.create.mockResolvedValue(shiftRow());

    await build(prisma).open(ACTOR_ID, { openingFloatCentavos: 300_000 });

    const data = prisma.shift.create.mock.calls[0][0].data as { businessDate: Date };
    expect(civilDateFromPrisma(data.businessDate)).toBe('2026-08-19');
  });

  it('sets the openMarker sentinel so the database enforces one open drawer', async () => {
    const prisma = buildPrisma();
    prisma.shift.create.mockResolvedValue(shiftRow());

    await build(prisma).open(ACTOR_ID, { openingFloatCentavos: 300_000 });

    const data = prisma.shift.create.mock.calls[0][0].data as { openMarker: string };
    expect(data.openMarker).toBe(OPEN_MARKER);
  });

  it('turns the sentinel unique violation into 409 SHIFT_ALREADY_OPEN', async () => {
    const prisma = buildPrisma();
    prisma.shift.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: '6.19.0',
        meta: { target: ['openMarker'] },
      }),
    );

    try {
      await build(prisma).open(ACTOR_ID, { openingFloatCentavos: 300_000 });
      throw new Error('open did not throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainException);
      expect((error as DomainException).code).toBe('SHIFT_ALREADY_OPEN');
      expect((error as DomainException).getStatus()).toBe(HttpStatus.CONFLICT);
    }
  });
});

describe('ShiftsService.close', () => {
  it('sums only RECORDED CASH payments in this shift', async () => {
    const prisma = buildPrisma();
    prisma.shift.findUnique.mockResolvedValue(shiftRow());
    prisma.payment.aggregate.mockResolvedValue({ _sum: { netCentavos: 89_000 } });
    prisma.shift.updateMany.mockResolvedValue({ count: 1 });
    prisma.shift.findUniqueOrThrow.mockResolvedValue(
      shiftRow({ status: 'CLOSED', openMarker: null, countedCentavos: 389_000 }),
    );

    const result = await build(prisma).close(ACTOR_ID, SHIFT_ID, { countedCentavos: 389_000 });

    expect(prisma.payment.aggregate).toHaveBeenCalledWith({
      _sum: { netCentavos: true },
      where: { shiftId: SHIFT_ID, status: 'RECORDED', method: 'CASH' },
    });
    expect(result.expectedCentavos).toBe(389_000);
    expect(result.varianceCentavos).toBe(0);
  });

  it('clears the sentinel and writes the computed figures in one conditional update', async () => {
    const prisma = buildPrisma();
    prisma.shift.findUnique.mockResolvedValue(shiftRow());
    prisma.payment.aggregate.mockResolvedValue({ _sum: { netCentavos: 89_000 } });
    prisma.shift.updateMany.mockResolvedValue({ count: 1 });
    prisma.shift.findUniqueOrThrow.mockResolvedValue(
      shiftRow({ status: 'CLOSED', openMarker: null, countedCentavos: 384_000 }),
    );

    await build(prisma).close(ACTOR_ID, SHIFT_ID, { countedCentavos: 384_000 });

    const call = prisma.shift.updateMany.mock.calls[0][0] as {
      where: { id: string; status: string };
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: SHIFT_ID, status: 'OPEN' });
    expect(call.data.openMarker).toBeNull();
    expect(call.data.expectedCentavos).toBe(389_000);
    expect(call.data.varianceCentavos).toBe(-5_000);
    expect(call.data.closedById).toBe(ACTOR_ID);
  });

  it('404s an unknown shift', async () => {
    const prisma = buildPrisma();
    prisma.shift.findUnique.mockResolvedValue(null);

    await expect(
      build(prisma).close(ACTOR_ID, SHIFT_ID, { countedCentavos: 300_000 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('409s SHIFT_ALREADY_CLOSED on a closed row', async () => {
    const prisma = buildPrisma();
    prisma.shift.findUnique.mockResolvedValue(shiftRow({ status: 'CLOSED', openMarker: null }));

    try {
      await build(prisma).close(ACTOR_ID, SHIFT_ID, { countedCentavos: 300_000 });
      throw new Error('close did not throw');
    } catch (error) {
      expect((error as DomainException).code).toBe('SHIFT_ALREADY_CLOSED');
      expect((error as DomainException).getStatus()).toBe(HttpStatus.CONFLICT);
    }
  });

  it('409s when the conditional update matches nothing — another staffer closed it first', async () => {
    const prisma = buildPrisma();
    prisma.shift.findUnique.mockResolvedValue(shiftRow());
    prisma.shift.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      build(prisma).close(ACTOR_ID, SHIFT_ID, { countedCentavos: 300_000 }),
    ).rejects.toMatchObject({ code: 'SHIFT_ALREADY_CLOSED' });
    expect(prisma.shift.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('refuses a ₱250 discrepancy with no note, before writing anything', async () => {
    const prisma = buildPrisma();
    prisma.shift.findUnique.mockResolvedValue(shiftRow());
    prisma.payment.aggregate.mockResolvedValue({ _sum: { netCentavos: 89_000 } });

    await expect(
      build(prisma).close(ACTOR_ID, SHIFT_ID, { countedCentavos: 364_000 }),
    ).rejects.toMatchObject({ code: 'SHIFT_VARIANCE_REASON_REQUIRED' });
    expect(prisma.shift.updateMany).not.toHaveBeenCalled();
  });
});

describe('ShiftsService.requireOpenShiftId', () => {
  it('resolves the open drawer through the unique sentinel', async () => {
    const prisma = buildPrisma();
    prisma.shift.findUnique.mockResolvedValue({ id: SHIFT_ID });

    const id = await build(prisma).requireOpenShiftId(
      prisma as unknown as Prisma.TransactionClient,
    );

    expect(id).toBe(SHIFT_ID);
    expect(prisma.shift.findUnique).toHaveBeenCalledWith({
      where: { openMarker: OPEN_MARKER },
      select: { id: true },
    });
  });

  it('422s SHIFT_NOT_OPEN when the drawer is shut — money without a drawer is unreconcilable', async () => {
    const prisma = buildPrisma();
    prisma.shift.findUnique.mockResolvedValue(null);

    try {
      await build(prisma).requireOpenShiftId(prisma as unknown as Prisma.TransactionClient);
      throw new Error('requireOpenShiftId did not throw');
    } catch (error) {
      expect((error as DomainException).code).toBe('SHIFT_NOT_OPEN');
      expect((error as DomainException).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    }
  });
});
