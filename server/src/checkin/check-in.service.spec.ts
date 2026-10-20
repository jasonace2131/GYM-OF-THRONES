import type { ConfigService } from '@nestjs/config';
import type { CheckIn } from '@prisma/client';
import { CHECK_OUT_CONFIRM_WINDOW_MS, CheckInService } from './check-in.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';
import type { StationTokenService } from './station-token.service';
import type { MembershipService } from '../membership/membership.service';
import type { DeskFeedService } from './desk-feed.service';
import type { OpeningHoursService } from '../config/opening-hours.service';
import type { AuthUser } from '../auth/auth.types';
import { DomainException } from '../common/exceptions/domain.exception';

/**
 * The confirmed check-out (owner, 2026-10-20) and the second-scan rule it
 * replaced. A second scan never closes a visit by itself; the Check out button
 * does, and only with a recent `ALREADY_INSIDE` scan as proof of presence.
 *
 * Prisma is a hand-built mock: these tests pin the service's decisions and the
 * writes it asks for, not SQL. The CHECK constraints and partial indexes are
 * covered by the e2e constraint suites.
 */

/** 18:00 Manila on 2026-09-25 — inside the gym's business day. */
const NOW = new Date('2026-09-25T10:00:00.000Z');
const TODAY_COLUMN = new Date('2026-09-25T00:00:00.000Z');
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const OTHER_ID = 'a0000000-0000-4000-8000-000000000002';
const VISIT_ID = 'c0000000-0000-4000-8000-000000000001';
const STATION = { id: 's0000000-0000-4000-8000-000000000001', code: '9F2K', name: 'Front desk' };
const SLOT_SECONDS = 30;
const slotAt = (at: Date): number => Math.floor(at.getTime() / 1000 / SLOT_SECONDS);
/** The slot a member presented thirty seconds before NOW — a fresh code. */
const PROOF_SLOT = slotAt(new Date(NOW.getTime() - 30_000));

/** A `StationScan` row as the in-memory table below holds it. */
interface ScanRow {
  userId: string;
  checkInId: string;
  outcome: string;
  consumedAt: Date;
  slot: number;
  responseSnapshot: { checkOutOffered?: boolean } | null;
  station: typeof STATION;
}

/** The second scan's row, as `stampScan` leaves it on a fresh code. */
function proofScan(overrides: Partial<ScanRow> = {}): ScanRow {
  return {
    userId: USER_ID,
    checkInId: VISIT_ID,
    outcome: 'ALREADY_INSIDE',
    consumedAt: new Date(NOW.getTime() - 30_000),
    slot: PROOF_SLOT,
    responseSnapshot: { checkOutOffered: true },
    station: STATION,
    ...overrides,
  };
}

type Range = { gte?: Date | number; gt?: Date | number };
const inRange = (value: Date | number, range: Range | undefined): boolean =>
  range === undefined ||
  ((range.gte === undefined || +value >= +range.gte) &&
    (range.gt === undefined || +value > +range.gt));

/**
 * Just enough of Prisma's `findFirst` to evaluate the proof queries against
 * real rows, so the tests pin behaviour rather than the shape of a `where`.
 */
function findFirstIn(rows: ScanRow[]) {
  return jest.fn(
    (args: {
      where: {
        userId?: string;
        checkInId?: string;
        outcome?: string;
        consumedAt?: Range;
        slot?: Range;
        responseSnapshot?: { path: string[]; equals: unknown };
      };
    }) => {
      const { where } = args;
      const match = rows
        .filter(
          (row) =>
            (where.userId === undefined || row.userId === where.userId) &&
            (where.checkInId === undefined || row.checkInId === where.checkInId) &&
            (where.outcome === undefined || row.outcome === where.outcome) &&
            inRange(row.consumedAt, where.consumedAt) &&
            inRange(row.slot, where.slot) &&
            (where.responseSnapshot === undefined ||
              (row.responseSnapshot as Record<string, unknown> | null)?.[
                where.responseSnapshot.path[0]
              ] === where.responseSnapshot.equals),
        )
        .sort((a, b) => +b.consumedAt - +a.consumedAt);
      return Promise.resolve(match[0] ?? null);
    },
  );
}

const USER = { id: USER_ID, role: 'CLIENT' } as unknown as AuthUser;

const PROFILE = {
  avatarUrl: null,
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  memberCode: 'GOT-0001',
};

function visit(overrides: Partial<CheckIn> = {}): CheckIn {
  return {
    id: VISIT_ID,
    userId: USER_ID,
    openUserId: USER_ID,
    occurredAt: new Date(NOW.getTime() - 60 * 60_000),
    businessDate: TODAY_COLUMN,
    endedAt: null,
    closeMethod: null,
    closeStationId: null,
    closeStationSlot: null,
    closeOffSiteOrigin: null,
    voidedAt: null,
    verdict: 'ALLOWED',
    ...overrides,
  } as unknown as CheckIn;
}

interface TxMock {
  checkIn: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    updateMany: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    count: jest.Mock;
  };
}

interface PrismaMock extends TxMock {
  user: { findUniqueOrThrow: jest.Mock };
  shift: { findFirst: jest.Mock };
  station: { findUnique: jest.Mock };
  stationScan: { findFirst: jest.Mock };
  $transaction: jest.Mock;
}

function buildTx(): TxMock {
  return {
    checkIn: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn(),
      count: jest.fn().mockResolvedValue(3),
    },
  };
}

function setup(scans: ScanRow[] = [proofScan()]) {
  const calls: string[] = [];
  const tx = buildTx();
  const prisma: PrismaMock = {
    ...buildTx(),
    user: { findUniqueOrThrow: jest.fn().mockResolvedValue(PROFILE) },
    shift: { findFirst: jest.fn().mockResolvedValue({ id: 'shift-1' }) },
    station: { findUnique: jest.fn().mockResolvedValue(STATION) },
    stationScan: { findFirst: findFirstIn(scans) },
    $transaction: jest.fn(async (fn: (client: TxMock) => Promise<unknown>) => {
      const value = await fn(tx);
      calls.push('commit');
      return value;
    }),
  };
  const deskFeed = { publish: jest.fn(() => calls.push('publish')) };
  const config = {
    get: (key: string) =>
      ({ GYM_EGRESS_CIDRS: '', IP_HASH_PEPPER: 'p'.repeat(32) })[key as 'GYM_EGRESS_CIDRS'],
  };
  const gym = {
    timeZone: 'Asia/Manila',
    checkinStaleVisitHours: 3,
    checkinMinSessionMinutes: 20,
    checkinReentryGraceMinutes: 60,
    stationTokenSlotSeconds: SLOT_SECONDS,
  };
  const tokens = {
    computeSlot: (at: Date, seconds: number) => Math.floor(at.getTime() / 1000 / seconds),
  };

  const service = new CheckInService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService<never, true>,
    gym as unknown as GymConfigService,
    tokens as unknown as StationTokenService,
    {} as MembershipService,
    deskFeed as unknown as DeskFeedService,
    {} as OpeningHoursService,
  );
  return { service, prisma, tx, deskFeed, calls };
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainException);
    const domain = error as DomainException;
    return { code: domain.code, status: domain.getStatus() };
  }
  throw new Error('expected a refusal');
}

describe('CheckInService.confirmCheckOut', () => {
  it('closes the open visit as STATION_QR at the proof scan’s station and slot', async () => {
    const { service, prisma, tx } = setup();
    prisma.checkIn.findUnique.mockResolvedValue(visit());
    tx.checkIn.findUnique.mockResolvedValue(visit());
    tx.checkIn.findUniqueOrThrow.mockResolvedValue(
      visit({ openUserId: null, endedAt: NOW, closeMethod: 'STATION_QR' }),
    );

    const result = await service.confirmCheckOut(USER, VISIT_ID, '203.0.113.9', NOW);

    expect(result.outcome).toBe('CHECKED_OUT');
    expect(result.display.headline).toBe('Checked out.');
    expect(result.session?.durationMinutes).toBe(60);
    expect(result.station).toEqual({ code: STATION.code, name: STATION.name });

    expect(tx.checkIn.updateMany).toHaveBeenCalledTimes(1);
    const close = tx.checkIn.updateMany.mock.calls[0][0];
    expect(close.where).toEqual({ id: VISIT_ID, endedAt: null, voidedAt: null });
    expect(close.data).toMatchObject({
      endedAt: NOW,
      closeMethod: 'STATION_QR',
      openUserId: null,
      closedById: null,
      autoClosed: false,
      closeStationId: STATION.id,
      closeStationSlot: PROOF_SLOT,
      closeOffSiteOrigin: true,
    });
  });

  describe('what counts as proof', () => {
    /** Runs a check-out against `scans` and reports the refusal code, or 'CLOSED'. */
    async function attempt(scans: ScanRow[]): Promise<string> {
      const { service, prisma, tx } = setup(scans);
      prisma.checkIn.findUnique.mockResolvedValue(visit());
      tx.checkIn.findUnique.mockResolvedValue(visit());
      tx.checkIn.findUniqueOrThrow.mockResolvedValue(
        visit({ openUserId: null, endedAt: NOW, closeMethod: 'STATION_QR' }),
      );
      try {
        await service.confirmCheckOut(USER, VISIT_ID, undefined, NOW);
        return 'CLOSED';
      } catch (error) {
        return (error as DomainException).code;
      }
    }

    it('is a two-minute window', () => {
      expect(CHECK_OUT_CONFIRM_WINDOW_MS).toBe(120_000);
    });

    it('accepts a fresh ALREADY_INSIDE scan of this visit', async () => {
      expect(await attempt([proofScan()])).toBe('CLOSED');
    });

    it('refuses a scan older than two minutes', async () => {
      expect(await attempt([proofScan({ consumedAt: new Date(NOW.getTime() - 121_000) })])).toBe(
        'CHECK_OUT_SCAN_REQUIRED',
      );
    });

    it('refuses another visit’s scan, or a scan of another outcome', async () => {
      expect(
        await attempt([proofScan({ checkInId: 'c0000000-0000-4000-8000-000000000009' })]),
      ).toBe('CHECK_OUT_SCAN_REQUIRED');
      expect(await attempt([proofScan({ outcome: 'CHECKED_IN' })])).toBe('CHECK_OUT_SCAN_REQUIRED');
    });

    /**
     * THE PHOTOGRAPHED CODE. A MAC-valid token with an old slot verifies as
     * EXPIRED, yet still lands as ALREADY_INSIDE linked to the open visit.
     * Received just now, it must still prove nothing — on either guard.
     */
    it('refuses a scan of an expired code, even one received seconds ago', async () => {
      const mondaysSlot = slotAt(new Date(NOW.getTime() - 24 * 60 * 60_000));
      // As decide() now stamps it: not offered.
      expect(
        await attempt([
          proofScan({ slot: mondaysSlot, responseSnapshot: { checkOutOffered: false } }),
        ]),
      ).toBe('CHECK_OUT_SCAN_REQUIRED');
      // And the slot guard alone, should a snapshot ever claim otherwise.
      expect(await attempt([proofScan({ slot: mondaysSlot })])).toBe('CHECK_OUT_SCAN_REQUIRED');
      // A snapshot that never offered the check-out, on a fresh slot, too.
      expect(await attempt([proofScan({ responseSnapshot: { checkOutOffered: false } })])).toBe(
        'CHECK_OUT_SCAN_REQUIRED',
      );
    });

    it('accepts the previous slot, matching the verifier’s one-slot look-back', async () => {
      const edge = slotAt(new Date(NOW.getTime() - CHECK_OUT_CONFIRM_WINDOW_MS)) - 1;
      expect(await attempt([proofScan({ slot: edge })])).toBe('CLOSED');
      expect(await attempt([proofScan({ slot: edge - 1 })])).toBe('CHECK_OUT_SCAN_REQUIRED');
    });

    /**
     * Scan at T (offered), check out at T+10s, scan back in at T+40s
     * (REOPENED, same visit). The T scan is inside the window but belongs to
     * the visit's PREVIOUS stretch, and must not close the resumed one.
     */
    it('refuses a scan from before the visit was reopened', async () => {
      const t = new Date(NOW.getTime() - 60_000);
      expect(
        await attempt([
          proofScan({ consumedAt: t }),
          proofScan({
            outcome: 'REOPENED',
            consumedAt: new Date(t.getTime() + 40_000),
            responseSnapshot: { checkOutOffered: false },
          }),
        ]),
      ).toBe('CHECK_OUT_SCAN_REQUIRED');
    });

    it('accepts a scan made after the reopen', async () => {
      expect(
        await attempt([
          proofScan({
            outcome: 'REOPENED',
            consumedAt: new Date(NOW.getTime() - 90_000),
            responseSnapshot: { checkOutOffered: false },
          }),
          proofScan({ consumedAt: new Date(NOW.getTime() - 20_000) }),
        ]),
      ).toBe('CLOSED');
    });
  });

  it('publishes ONE CHECK_OUT event to the desk, after the commit', async () => {
    const { service, prisma, tx, deskFeed, calls } = setup();
    prisma.checkIn.findUnique.mockResolvedValue(visit());
    tx.checkIn.findUnique.mockResolvedValue(visit());
    tx.checkIn.findUniqueOrThrow.mockResolvedValue(
      visit({ openUserId: null, endedAt: NOW, closeMethod: 'STATION_QR' }),
    );

    await service.confirmCheckOut(USER, VISIT_ID, undefined, NOW);

    expect(deskFeed.publish).toHaveBeenCalledTimes(1);
    expect(deskFeed.publish.mock.calls[0]).toEqual([
      expect.objectContaining({ kind: 'CHECK_OUT', outcome: 'CHECKED_OUT', checkInId: VISIT_ID }),
    ]);
    expect(calls).toEqual(['commit', 'publish']);
  });

  it('refuses 403 CHECK_OUT_SCAN_REQUIRED with no recent ALREADY_INSIDE scan', async () => {
    // A proof scan older than two minutes is excluded by the query's
    // `consumedAt >= now - 2 min`, so "too old" and "none" are one answer.
    const { service, prisma, tx, deskFeed } = setup();
    prisma.checkIn.findUnique.mockResolvedValue(visit());
    prisma.stationScan.findFirst.mockResolvedValue(null);

    expect(await refusal(service.confirmCheckOut(USER, VISIT_ID, undefined, NOW))).toEqual({
      code: 'CHECK_OUT_SCAN_REQUIRED',
      status: 403,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.checkIn.updateMany).not.toHaveBeenCalled();
    expect(deskFeed.publish).not.toHaveBeenCalled();
  });

  it('refuses 409 CHECK_OUT_NOT_OPEN for somebody else’s visit', async () => {
    const { service, prisma, deskFeed } = setup();
    prisma.checkIn.findUnique.mockResolvedValue(visit({ userId: OTHER_ID, openUserId: OTHER_ID }));

    expect(await refusal(service.confirmCheckOut(USER, VISIT_ID, undefined, NOW))).toEqual({
      code: 'CHECK_OUT_NOT_OPEN',
      status: 409,
    });
    expect(prisma.stationScan.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(deskFeed.publish).not.toHaveBeenCalled();
  });

  it('refuses 409 for an unknown or voided visit', async () => {
    const { service, prisma } = setup();
    prisma.checkIn.findUnique.mockResolvedValueOnce(null);
    expect((await refusal(service.confirmCheckOut(USER, VISIT_ID, undefined, NOW))).code).toBe(
      'CHECK_OUT_NOT_OPEN',
    );

    prisma.checkIn.findUnique.mockResolvedValueOnce(visit({ voidedAt: NOW }));
    expect((await refusal(service.confirmCheckOut(USER, VISIT_ID, undefined, NOW))).code).toBe(
      'CHECK_OUT_NOT_OPEN',
    );
  });

  it('refuses 409 for a visit the desk closed', async () => {
    const { service, prisma } = setup();
    prisma.checkIn.findUnique.mockResolvedValue(
      visit({ openUserId: null, endedAt: new Date(NOW.getTime() - 30_000), closeMethod: 'MANUAL' }),
    );
    expect((await refusal(service.confirmCheckOut(USER, VISIT_ID, undefined, NOW))).code).toBe(
      'CHECK_OUT_NOT_OPEN',
    );
  });

  it('answers a double tap with the same CHECKED_OUT card — no write, no feed', async () => {
    const { service, prisma, tx, deskFeed } = setup();
    const endedAt = new Date(NOW.getTime() - 20_000);
    prisma.checkIn.findUnique.mockResolvedValue(
      visit({
        openUserId: null,
        endedAt,
        closeMethod: 'STATION_QR',
        closeStationId: STATION.id,
        closeStationSlot: PROOF_SLOT,
        closeOffSiteOrigin: false,
      }),
    );

    const result = await service.confirmCheckOut(USER, VISIT_ID, undefined, NOW);

    expect(result.outcome).toBe('CHECKED_OUT');
    expect(result.session).toEqual({
      startedAt: visit().occurredAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMinutes: 60,
    });
    expect(result.station).toEqual({ code: STATION.code, name: STATION.name });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.checkIn.updateMany).not.toHaveBeenCalled();
    expect(prisma.checkIn.updateMany).not.toHaveBeenCalled();
    expect(deskFeed.publish).not.toHaveBeenCalled();
  });

  it('refuses 409 for a QR close older than the window', async () => {
    const { service, prisma } = setup();
    prisma.checkIn.findUnique.mockResolvedValue(
      visit({
        openUserId: null,
        endedAt: new Date(NOW.getTime() - CHECK_OUT_CONFIRM_WINDOW_MS - 1_000),
        closeMethod: 'STATION_QR',
      }),
    );
    expect((await refusal(service.confirmCheckOut(USER, VISIT_ID, undefined, NOW))).code).toBe(
      'CHECK_OUT_NOT_OPEN',
    );
  });

  it('answers a lost close race as the double tap when the winner was a QR close', async () => {
    const { service, prisma, tx, deskFeed } = setup();
    prisma.checkIn.findUnique
      .mockResolvedValueOnce(visit())
      .mockResolvedValueOnce(
        visit({ openUserId: null, endedAt: NOW, closeMethod: 'STATION_QR', closeStationId: null }),
      );
    tx.checkIn.findUnique.mockResolvedValue(visit());
    tx.checkIn.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.confirmCheckOut(USER, VISIT_ID, undefined, NOW);

    expect(result.outcome).toBe('CHECKED_OUT');
    expect(deskFeed.publish).not.toHaveBeenCalled();
  });

  it('refuses 409 when the race was lost to a desk close', async () => {
    const { service, prisma, tx } = setup();
    prisma.checkIn.findUnique
      .mockResolvedValueOnce(visit())
      .mockResolvedValueOnce(visit({ openUserId: null, endedAt: NOW, closeMethod: 'MANUAL' }));
    tx.checkIn.findUnique.mockResolvedValue(null);

    expect((await refusal(service.confirmCheckOut(USER, VISIT_ID, undefined, NOW))).code).toBe(
      'CHECK_OUT_NOT_OPEN',
    );
    expect(tx.checkIn.updateMany).not.toHaveBeenCalled();
  });
});

describe('CheckInService — a second scan while inside', () => {
  /** The private write core, reached directly: the token path is not under test. */
  function decide(
    service: CheckInService,
    tx: TxMock,
    station: typeof STATION | null,
    preVerdict: { kind: 'PROCEED' } | { kind: 'DENY'; reason: string } = { kind: 'PROCEED' },
  ) {
    const ctx = {
      user: { id: USER_ID, role: 'CLIENT' },
      profile: PROFILE,
      station,
      slot: station === null ? null : PROOF_SLOT,
      method: station === null ? 'MANUAL' : 'STATION_QR',
      recordedById: station === null ? 'staff-1' : null,
      originIpHash: null,
      offSiteOrigin: false,
      shiftId: 'shift-1',
      offlineQueued: false,
      now: NOW,
      today: '2026-09-25',
      preVerdict,
      overriding: null,
    };
    return (
      service as unknown as {
        decide: (
          tx: TxMock,
          ctx: unknown,
        ) => Promise<{
          envelope: {
            result: {
              outcome: string;
              checkOutOffered: boolean;
              display: { subhead: string; detail: string | null };
            };
          };
          checkInId: string | null;
        }>;
      }
    ).decide(tx, ctx);
  }

  it('one minute in: ALREADY_INSIDE, no close, and the scan is linked to the visit', async () => {
    const { service, tx } = setup();
    tx.checkIn.findUnique.mockResolvedValue(
      visit({ occurredAt: new Date(NOW.getTime() - 60_000) }),
    );

    const decided = await decide(service, tx, STATION);

    expect(decided.envelope.result.outcome).toBe('ALREADY_INSIDE');
    expect(decided.envelope.result.display.detail).toBe('Leaving? Check out below.');
    // `stampScan` writes this onto the StationScan row: it is what
    // `confirmCheckOut` accepts as proof of presence.
    expect(decided.checkInId).toBe(VISIT_ID);
    expect(tx.checkIn.updateMany).not.toHaveBeenCalled();
  });

  it('offers the check-out on a fresh code, and says so on the result', async () => {
    const { service, tx } = setup();
    tx.checkIn.findUnique.mockResolvedValue(visit());

    const decided = await decide(service, tx, STATION);

    expect(decided.envelope.result.checkOutOffered).toBe(true);
  });

  /**
   * THE PHOTOGRAPHED CODE. An expired token is still recognisably this member
   * scanning again, so it answers ALREADY_INSIDE — but it proves nothing about
   * where they are standing, so no check-out is offered, and the snapshot
   * `confirmCheckOut` reads back says so.
   */
  it('an EXPIRED code: ALREADY_INSIDE, but no check-out offered', async () => {
    const { service, tx } = setup();
    tx.checkIn.findUnique.mockResolvedValue(visit());

    const decided = await decide(service, tx, STATION, {
      kind: 'DENY',
      reason: 'STATION_TOKEN_EXPIRED',
    });

    expect(decided.envelope.result.outcome).toBe('ALREADY_INSIDE');
    expect(decided.envelope.result.checkOutOffered).toBe(false);
    expect(decided.envelope.result.display.detail).toBeNull();
    expect(tx.checkIn.updateMany).not.toHaveBeenCalled();
  });

  /** A member still inside after closing time must be able to leave. */
  it('GYM_CLOSED: still offers the check-out', async () => {
    const { service, tx } = setup();
    tx.checkIn.findUnique.mockResolvedValue(visit());

    const decided = await decide(service, tx, STATION, { kind: 'DENY', reason: 'GYM_CLOSED' });

    expect(decided.envelope.result.outcome).toBe('ALREADY_INSIDE');
    expect(decided.envelope.result.checkOutOffered).toBe(true);
    expect(decided.envelope.result.display.detail).toBe('Leaving? Check out below.');
  });

  it('two hours in: still ALREADY_INSIDE — a scan never checks out by itself', async () => {
    const { service, tx } = setup();
    tx.checkIn.findUnique.mockResolvedValue(
      visit({ occurredAt: new Date(NOW.getTime() - 120 * 60_000) }),
    );

    const decided = await decide(service, tx, STATION);

    expect(decided.envelope.result.outcome).toBe('ALREADY_INSIDE');
    expect(tx.checkIn.updateMany).not.toHaveBeenCalled();
    // When the visit began (16:00 Manila), not this scan (18:00).
    expect(decided.envelope.result.display.subhead).toBe('Since 4:00 PM.');
  });

  it('a desk entry for someone inside is ALREADY_INSIDE with no check-out line', async () => {
    const { service, tx } = setup();
    tx.checkIn.findUnique.mockResolvedValue(visit());

    const decided = await decide(service, tx, null);

    expect(decided.envelope.result.outcome).toBe('ALREADY_INSIDE');
    expect(decided.envelope.result.display.detail).toBeNull();
    expect(decided.envelope.result.checkOutOffered).toBe(false);
    expect(tx.checkIn.updateMany).not.toHaveBeenCalled();
  });

  it('a stale visit is still stale-closed and re-admitted as RECHECKED_IN', async () => {
    const { service, tx } = setup();
    const stale = visit({ occurredAt: new Date(NOW.getTime() - 4 * 60 * 60_000) });
    tx.checkIn.findUnique.mockResolvedValue(stale);
    tx.checkIn.findUniqueOrThrow.mockResolvedValue({ ...stale, endedAt: NOW });
    const admitted = { envelope: { result: { outcome: 'RECHECKED_IN' } }, checkInId: 'new' };
    const admit = jest
      .spyOn(service as unknown as { admit: () => Promise<unknown> }, 'admit')
      .mockResolvedValue(admitted);

    const decided = await decide(service, tx, STATION);

    expect(tx.checkIn.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.checkIn.updateMany.mock.calls[0][0].data).toMatchObject({
      closeMethod: 'STALE_CLOSE',
      autoClosed: true,
    });
    expect(admit).toHaveBeenCalledWith(tx, expect.anything(), 'RECHECKED_IN');
    expect(decided).toBe(admitted);
  });

  it('a visit from an earlier business date is stale whatever its age', async () => {
    const { service, tx } = setup();
    const yesterday = visit({
      occurredAt: new Date(NOW.getTime() - 30 * 60_000),
      businessDate: new Date('2026-09-24T00:00:00.000Z'),
    });
    tx.checkIn.findUnique.mockResolvedValue(yesterday);
    tx.checkIn.findUniqueOrThrow.mockResolvedValue({ ...yesterday, endedAt: NOW });
    jest
      .spyOn(service as unknown as { admit: () => Promise<unknown> }, 'admit')
      .mockResolvedValue({ envelope: { result: { outcome: 'RECHECKED_IN' } }, checkInId: 'x' });

    await decide(service, tx, STATION);

    expect(tx.checkIn.updateMany.mock.calls[0][0].data.closeMethod).toBe('STALE_CLOSE');
  });
});
