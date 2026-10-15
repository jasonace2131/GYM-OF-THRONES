import { AuditService } from './audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ListAuditQueryDto } from './dto/list-audit-query.dto';

const ACTOR = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-09-06T02:00:00.000Z');

interface PrismaMock {
  auditLog: { create: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock; count: jest.Mock };
  $transaction: jest.Mock;
}

function build(): { prisma: PrismaMock; service: AuditService } {
  const prisma: PrismaMock = {
    auditLog: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn((arg: unknown) => Promise.all(arg as Promise<unknown>[])),
  };
  return { prisma, service: new AuditService(prisma as unknown as PrismaService) };
}

function query(over: Partial<ListAuditQueryDto> = {}): ListAuditQueryDto {
  return { page: 1, limit: 25, ...over } as ListAuditQueryDto;
}

describe('AuditService.record', () => {
  /**
   * THE TRADE-OFF, PINNED.
   *
   * The eleven actions this wraps are things staff do at a counter with a
   * member in front of them. A transient failure on the LOG must not be the
   * reason a mis-keyed payment cannot be voided — an operator who cannot undo
   * a wrong charge will find another way that leaves no trail at all.
   *
   * What makes the trail trustworthy is the other half, which lives in the
   * migration: `actorId` is ON DELETE RESTRICT and there is no update or
   * delete path, so an entry that IS written cannot later be altered.
   */
  it('swallows a write failure rather than failing the action it describes', async () => {
    const { prisma, service } = build();
    prisma.auditLog.create.mockRejectedValue(new Error('connection reset'));

    await expect(
      service.record({
        action: 'PAYMENT_VOIDED',
        actorId: ACTOR,
        actorRole: 'ADMIN',
        subjectType: 'Payment',
      }),
    ).resolves.toBeUndefined();
  });

  it('stores the actor role it was given, never one it looked up later', async () => {
    const { prisma, service } = build();
    prisma.auditLog.create.mockResolvedValue({});

    await service.record(
      {
        action: 'ROLE_CHANGED',
        actorId: ACTOR,
        actorRole: 'ADMIN',
        subjectType: 'User',
        subjectId: '22222222-2222-4222-8222-222222222222',
      },
      NOW,
    );

    const [args] = prisma.auditLog.create.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(args.data).toMatchObject({ actorRole: 'ADMIN', occurredAt: NOW });
  });

  it('writes NULL rather than an empty object when there are no details', async () => {
    const { prisma, service } = build();
    prisma.auditLog.create.mockResolvedValue({});

    await service.record({
      action: 'MEMBER_RESTORED',
      actorId: ACTOR,
      actorRole: 'ADMIN',
      subjectType: 'User',
    });

    const [args] = prisma.auditLog.create.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(args.data).not.toHaveProperty('details');
    expect(args.data['reason']).toBeNull();
  });
});

describe('AuditService.list', () => {
  it('is newest-first and unscoped — a per-actor slice would let somebody audit everyone but themselves', async () => {
    const { prisma, service } = build();
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.auditLog.count.mockResolvedValue(0);

    await service.list(query());

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {}, orderBy: { occurredAt: 'desc' } }),
    );
  });

  it('applies only the filters that were given', async () => {
    const { prisma, service } = build();
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.auditLog.count.mockResolvedValue(0);

    await service.list(query({ action: 'PAYMENT_VOIDED' }));

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { action: 'PAYMENT_VOIDED' } }),
    );
  });

  it('resolves the actor name, because "voided by a3f1c9d2…" is unusable', async () => {
    const { prisma, service } = build();
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'a1',
        action: 'PAYMENT_VOIDED',
        actorId: ACTOR,
        actorRole: 'ADMIN',
        subjectType: 'Payment',
        subjectId: null,
        subjectLabel: 'OR-1042',
        reason: 'Charged twice',
        details: null,
        originIpHash: 'f'.repeat(64),
        occurredAt: NOW,
        actor: { firstName: 'Ana', lastName: 'Cruz' },
      },
    ]);
    prisma.auditLog.count.mockResolvedValue(1);

    const page = await service.list(query());

    expect(page.items[0]?.actorName).toBe('Ana Cruz');
    // The origin hash is a forensic column, not a thing to put on a screen in
    // a back office — a stable per-address identifier for no operational gain.
    expect(page.items[0]).not.toHaveProperty('originIpHash');
  });
});

describe('AuditService.recordingSince', () => {
  /**
   * Forward-only logging makes "nothing happened" and "nothing was recorded
   * yet" look identical. The screen has to be able to tell them apart, which
   * is the only reason this method exists.
   */
  it('returns null when nothing has ever been recorded', async () => {
    const { prisma, service } = build();
    prisma.auditLog.findFirst.mockResolvedValue(null);

    await expect(service.recordingSince()).resolves.toBeNull();
  });

  it('returns the earliest entry, not the latest', async () => {
    const { prisma, service } = build();
    prisma.auditLog.findFirst.mockResolvedValue({ occurredAt: NOW });

    await expect(service.recordingSince()).resolves.toBe('2026-09-06T02:00:00.000Z');
    expect(prisma.auditLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { occurredAt: 'asc' } }),
    );
  });
});
