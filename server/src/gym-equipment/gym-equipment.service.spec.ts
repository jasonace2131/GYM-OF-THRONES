import { HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { DomainException } from '../common/exceptions/domain.exception';
import { GymEquipmentService, equipmentForPrompt } from './gym-equipment.service';

/**
 * The gym's equipment list (owner, 2026-10-23): the admin's CRUD + reorder,
 * each audited, and the planners' read — which never fails a plan.
 */

const ADMIN = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const row = (id: string, name: string, sortOrder: number, detail: string | null = null) => ({
  id,
  name,
  detail,
  sortOrder,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('GymEquipmentService', () => {
  let prisma: {
    gymEquipment: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      aggregate: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      delete: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let service: GymEquipmentService;

  beforeEach(() => {
    prisma = {
      gymEquipment: {
        findMany: jest.fn().mockResolvedValue([row(A, 'Dumbbells', 0, '2–40 kg pairs')]),
        findUnique: jest.fn().mockResolvedValue(row(A, 'Dumbbells', 0)),
        findFirst: jest.fn().mockResolvedValue(null),
        aggregate: jest.fn().mockResolvedValue({ _max: { sortOrder: 0 } }),
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(row(B, data['name'] as string, data['sortOrder'] as number)),
        ),
        update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(row(A, (data['name'] as string) ?? 'Dumbbells', 0)),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn().mockResolvedValue(row(A, 'Dumbbells', 0)),
      },
      $transaction: jest.fn((ops: unknown) =>
        Array.isArray(ops) ? Promise.all(ops) : (ops as (tx: unknown) => unknown)(prisma),
      ),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new GymEquipmentService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('lists in the admin order, ties by name', async () => {
    const list = await service.list();
    expect(prisma.gymEquipment.findMany).toHaveBeenCalledWith({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    expect(list).toEqual([{ id: A, name: 'Dumbbells', detail: '2–40 kg pairs', sortOrder: 0 }]);
  });

  describe('create', () => {
    it('trims, appends at the end, audits', async () => {
      const item = await service.create({ name: '  Bench  ', detail: '  ' }, ADMIN, 'ADMIN');
      expect(prisma.gymEquipment.create).toHaveBeenCalledWith({
        data: { name: 'Bench', detail: null, sortOrder: 1 },
      });
      expect(item.name).toBe('Bench');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'GYM_EQUIPMENT_CHANGED',
          actorId: ADMIN,
          actorRole: 'ADMIN',
          subjectType: 'GymEquipment',
          subjectId: B,
          subjectLabel: 'Added Bench',
        }),
      );
    });

    it('refuses a name already listed, ignoring case, with 409', async () => {
      prisma.gymEquipment.findFirst.mockResolvedValue(row(A, 'Dumbbells', 0));
      const caught = await service
        .create({ name: 'dumbbells' }, ADMIN, 'ADMIN')
        .catch((e: unknown) => e);
      expect(prisma.gymEquipment.findFirst).toHaveBeenCalledWith({
        where: { name: { equals: 'dumbbells', mode: 'insensitive' } },
      });
      expect(caught).toBeInstanceOf(DomainException);
      expect(caught).toMatchObject({ code: 'GYM_EQUIPMENT_DUPLICATE' });
      expect((caught as DomainException).getStatus()).toBe(HttpStatus.CONFLICT);
      expect(prisma.gymEquipment.create).not.toHaveBeenCalled();
    });

    it('maps a racing unique violation to the same 409', async () => {
      prisma.gymEquipment.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
      );
      await expect(service.create({ name: 'Bench' }, ADMIN, 'ADMIN')).rejects.toMatchObject({
        code: 'GYM_EQUIPMENT_DUPLICATE',
      });
    });
  });

  describe('update', () => {
    it('renames and sets the detail, and audits before and after', async () => {
      await service.update(A, { name: 'Dumbbells', detail: '2–50 kg' }, ADMIN, 'ADMIN');
      expect(prisma.gymEquipment.findFirst).toHaveBeenCalledWith({
        where: { name: { equals: 'Dumbbells', mode: 'insensitive' }, id: { not: A } },
      });
      expect(prisma.gymEquipment.update).toHaveBeenCalledWith({
        where: { id: A },
        data: { name: 'Dumbbells', detail: '2–50 kg' },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ subjectLabel: 'Edited Dumbbells' }),
      );
    });

    it('leaves the detail alone when the PATCH does not mention it, and clears it on null or ""', async () => {
      prisma.gymEquipment.findUnique.mockResolvedValue(row(A, 'Dumbbells', 0, '2–40 kg pairs'));
      await service.update(A, { name: 'Dumbbells' }, ADMIN, 'ADMIN');
      expect(prisma.gymEquipment.update).toHaveBeenLastCalledWith({
        where: { id: A },
        data: { name: 'Dumbbells' },
      });
      await service.update(A, { name: 'Dumbbells', detail: null }, ADMIN, 'ADMIN');
      expect(prisma.gymEquipment.update).toHaveBeenLastCalledWith({
        where: { id: A },
        data: { name: 'Dumbbells', detail: null },
      });
      await service.update(A, { name: 'Dumbbells', detail: '  ' }, ADMIN, 'ADMIN');
      expect(prisma.gymEquipment.update).toHaveBeenLastCalledWith({
        where: { id: A },
        data: { name: 'Dumbbells', detail: null },
      });
    });

    it('answers 404 for an unknown id', async () => {
      prisma.gymEquipment.findUnique.mockResolvedValue(null);
      await expect(service.update(A, { name: 'X' }, ADMIN, 'ADMIN')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  it('removes and audits; 404 for an unknown id', async () => {
    await service.remove(A, ADMIN, 'ADMIN');
    expect(prisma.gymEquipment.delete).toHaveBeenCalledWith({ where: { id: A } });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ subjectLabel: 'Removed Dumbbells' }),
    );
    prisma.gymEquipment.findUnique.mockResolvedValue(null);
    await expect(service.remove(A, ADMIN, 'ADMIN')).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('reorder', () => {
    it('reads and writes each position in one interactive transaction', async () => {
      prisma.gymEquipment.findMany.mockResolvedValue([row(A, 'Dumbbells', 0), row(B, 'Bench', 1)]);
      await service.reorder([B, A], ADMIN, 'ADMIN');
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
      expect(prisma.gymEquipment.updateMany).toHaveBeenCalledWith({
        where: { id: B },
        data: { sortOrder: 0 },
      });
      expect(prisma.gymEquipment.updateMany).toHaveBeenCalledWith({
        where: { id: A },
        data: { sortOrder: 1 },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ subjectLabel: 'Reordered 2 items' }),
      );
    });

    it('refuses a list that is not every item exactly once', async () => {
      prisma.gymEquipment.findMany.mockResolvedValue([row(A, 'Dumbbells', 0), row(B, 'Bench', 1)]);
      for (const ids of [[A], [A, A], [A, B, B]]) {
        await expect(service.reorder(ids, ADMIN, 'ADMIN')).rejects.toMatchObject({
          code: 'GYM_EQUIPMENT_ORDER_MISMATCH',
        });
      }
      expect(prisma.gymEquipment.updateMany).not.toHaveBeenCalled();
    });

    it('answers ORDER_MISMATCH, not a 500, when an item is deleted mid-reorder', async () => {
      prisma.gymEquipment.findMany.mockResolvedValue([row(A, 'Dumbbells', 0), row(B, 'Bench', 1)]);
      // B goes between the read and its write: the write matches nothing.
      prisma.gymEquipment.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });
      const caught = await service.reorder([A, B], ADMIN, 'ADMIN').catch((e: unknown) => e);
      expect(caught).toMatchObject({ code: 'GYM_EQUIPMENT_ORDER_MISMATCH' });
      expect((caught as DomainException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
      // Nothing is issued on the transaction after the miss (25P02), nothing audited.
      expect(prisma.gymEquipment.updateMany).toHaveBeenCalledTimes(2);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('forPrompt', () => {
    it('phrases each item with its detail, in order', async () => {
      prisma.gymEquipment.findMany.mockResolvedValue([
        row(A, 'Dumbbells', 0, '2–40 kg pairs'),
        row(B, 'Flat bench', 1),
      ]);
      expect(await service.forPrompt()).toEqual(['Dumbbells (2–40 kg pairs)', 'Flat bench']);
    });

    it('answers an empty list when the read fails, so a plan never fails on it', async () => {
      prisma.gymEquipment.findMany.mockRejectedValue(new Error('db down'));
      expect(await service.forPrompt()).toEqual([]);
    });

    it('serves from a short cache and re-reads after a write', async () => {
      await service.forPrompt();
      await service.forPrompt();
      expect(prisma.gymEquipment.findMany).toHaveBeenCalledTimes(1);
      await service.create({ name: 'Bench' }, ADMIN, 'ADMIN');
      await service.forPrompt();
      expect(prisma.gymEquipment.findMany).toHaveBeenCalledTimes(2);
    });
  });

  it('equipmentForPrompt formats name and detail', () => {
    expect(equipmentForPrompt([{ name: 'Rower', detail: null }])).toEqual(['Rower']);
  });
});
