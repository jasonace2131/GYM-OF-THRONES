import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import type { PrismaService } from '../prisma/prisma.service';
import { StationsService } from './stations.service';

/**
 * The two "stop this tablet" levers (owner bug report, 2026-11-07).
 *
 * "A tablet was lost or stolen" used to only bump the station's token epoch:
 * every tablet, the stolen one included, fetched new codes and kept working.
 * And a single Disconnect left the tablet's saved codes valid for up to five
 * minutes. Both now revoke AND bump, in one transaction.
 */

const STATION_ID = '11111111-1111-4111-8111-111111111111';
const CREDENTIAL_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-07T10:30:00.000Z');

function stationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: STATION_ID,
    code: '23JE',
    name: 'Front desk',
    gymCode: 'GOT',
    tokenEpoch: 2,
    isActive: true,
    lastTokenIssuedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    credentials: [],
    _count: { checkIns: 0 },
    ...overrides,
  };
}

function credentialRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CREDENTIAL_ID,
    stationId: STATION_ID,
    keyHash: 'h',
    label: 'Front desk tablet',
    createdById: 'u',
    createdAt: NOW,
    lastUsedAt: NOW,
    lastUsedIpHash: null,
    revokedAt: null,
    station: { code: '23JE' },
    ...overrides,
  };
}

describe('StationsService: stopping tablets', () => {
  let prisma: {
    station: { findUnique: jest.Mock; update: jest.Mock };
    stationCredential: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let service: StationsService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    prisma = {
      station: {
        findUnique: jest.fn().mockResolvedValue(stationRow()),
        update: jest.fn().mockResolvedValue(stationRow({ tokenEpoch: 3 })),
      },
      stationCredential: {
        findUnique: jest.fn().mockResolvedValue(credentialRow()),
        update: jest.fn().mockResolvedValue(credentialRow({ revokedAt: NOW })),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      // The array form: every operation is part of one transaction.
      $transaction: jest.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
    };
    service = new StationsService(
      prisma as unknown as PrismaService,
      { get: () => 'pepper' } as unknown as ConfigService<Env, true>,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('disconnectTablets ("A tablet was lost or stolen")', () => {
    it('revokes every active tablet key on the station AND changes its codes, together', async () => {
      const result = await service.disconnectTablets(STATION_ID);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.stationCredential.updateMany).toHaveBeenCalledWith({
        where: { stationId: STATION_ID, revokedAt: null },
        data: { revokedAt: NOW },
      });
      expect(prisma.station.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: STATION_ID },
          data: { tokenEpoch: { increment: 1 } },
        }),
      );
      expect(result.tokenEpoch).toBe(3);
    });

    it('answers 404 for a station that does not exist, and changes nothing', async () => {
      prisma.station.findUnique.mockResolvedValue(null);
      await expect(service.disconnectTablets(STATION_ID)).rejects.toMatchObject({ status: 404 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('revokeCredential (Disconnect, one tablet)', () => {
    it("revokes the key and changes the station's codes, so the tablet's saved codes die too", async () => {
      await service.revokeCredential(CREDENTIAL_ID);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.stationCredential.update).toHaveBeenCalledWith({
        where: { id: CREDENTIAL_ID },
        data: { revokedAt: NOW },
      });
      expect(prisma.station.update).toHaveBeenCalledWith({
        where: { id: STATION_ID },
        data: { tokenEpoch: { increment: 1 } },
      });
    });

    it('is a no-op for a key already revoked: no second epoch bump on a double-tap', async () => {
      prisma.stationCredential.findUnique.mockResolvedValue(credentialRow({ revokedAt: NOW }));
      const result = await service.revokeCredential(CREDENTIAL_ID);

      expect(result.isActive).toBe(false);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.station.update).not.toHaveBeenCalled();
    });
  });
});
