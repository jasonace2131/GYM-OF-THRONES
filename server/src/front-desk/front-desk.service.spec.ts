import { FrontDeskService, openVisitWhere } from './front-desk.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';

/** 18:00 Manila on 2026-09-25 — well inside the gym's business day. */
const NOW = new Date('2026-09-25T10:00:00.000Z');
/** `toDateColumn('2026-09-25')`: a `@db.Date` is UTC midnight of the civil day. */
const TODAY_COLUMN = new Date('2026-09-25T00:00:00.000Z');

function gym(): GymConfigService {
  return {
    timeZone: 'Asia/Manila',
    expiringSoonDays: 7,
    graceAdmissionsMax: 1,
    stationTokenSlotSeconds: 30,
    stationTokenBatchSize: 10,
  } as unknown as GymConfigService;
}

/** An off-the-street walk-in: no account, so no `user` and no sentinel. */
function guestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c0000000-0000-4000-8000-000000000001',
    userId: null,
    user: null,
    guestName: 'Juan Dela Cruz',
    openUserId: null,
    occurredAt: new Date('2026-09-25T08:30:00.000Z'),
    endedAt: null,
    verdict: 'ALLOWED',
    method: 'MANUAL',
    station: null,
    offSiteOrigin: false,
    photoOnFileAtTime: false,
    ...overrides,
  };
}

interface PrismaMock {
  checkIn: { findMany: jest.Mock; count: jest.Mock; findUnique: jest.Mock };
  checkInDenial: { findMany: jest.Mock; count: jest.Mock };
  station: { findMany: jest.Mock };
  $transaction: jest.Mock;
}

function buildPrisma(): PrismaMock {
  return {
    checkIn: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    checkInDenial: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    station: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((calls: Promise<unknown>[]) => Promise.all(calls)),
  };
}

describe('openVisitWhere — the one definition of "still inside"', () => {
  it('counts a member by the open-visit sentinel, and a guest by an open visit TODAY', () => {
    expect(openVisitWhere(TODAY_COLUMN)).toEqual({
      voidedAt: null,
      OR: [
        { openUserId: { not: null } },
        { userId: null, endedAt: null, businessDate: TODAY_COLUMN },
      ],
    });
  });
});

describe('FrontDeskService', () => {
  let prisma: PrismaMock;
  let service: FrontDeskService;

  beforeEach(() => {
    prisma = buildPrisma();
    service = new FrontDeskService(prisma as unknown as PrismaService, gym());
  });

  describe('guestContact — the "Make member" hand-off', () => {
    it('returns the guest email for the "Make member" hand-off', async () => {
      prisma.checkIn.findUnique.mockResolvedValue({
        userId: null,
        guestName: 'Ana Cruz',
        guestPhone: '09171234567',
        guestEmail: 'ana@example.com',
        guestEmergencyContact: 'Maria 0917',
      });

      await expect(service.guestContact('11111111-1111-4111-8111-111111111111')).resolves.toEqual({
        guestName: 'Ana Cruz',
        guestPhone: '09171234567',
        guestEmail: 'ana@example.com',
        guestEmergencyContact: 'Maria 0917',
      });
      expect(prisma.checkIn.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ select: expect.objectContaining({ guestEmail: true }) }),
      );
    });
  });

  describe('activeCheckIns — "In the gym now"', () => {
    it('asks for open member visits AND open guest visits from today, never voided ones', async () => {
      await service.activeCheckIns({ page: 1, limit: 50 }, NOW);

      const expected = openVisitWhere(TODAY_COLUMN);
      expect(prisma.checkIn.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expected }),
      );
      expect(prisma.checkIn.count).toHaveBeenCalledWith({ where: expected });
    });

    it('puts an account-less walk-in on the board as a guest, so the desk can check them out', async () => {
      prisma.checkIn.findMany.mockResolvedValue([guestRow()]);
      prisma.checkIn.count.mockResolvedValue(1);

      const board = await service.activeCheckIns({ page: 1, limit: 50 }, NOW);

      expect(board.total).toBe(1);
      expect(board.items[0]).toMatchObject({
        checkInId: guestRow().id,
        // `userId === null` is the guest predicate the console's "Make member"
        // button already keys on.
        member: { userId: null, firstName: 'Juan', lastName: 'Dela Cruz' },
        durationMinutes: 90,
      });
    });
  });

  describe('today — the in-gym counter', () => {
    it('counts guests inside with the same predicate the board lists them by', async () => {
      await service.today(undefined, NOW);

      expect(prisma.checkIn.count).toHaveBeenCalledWith({
        where: openVisitWhere(TODAY_COLUMN),
      });
    });
  });
});
