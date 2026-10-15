import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { LAST_SEEN_THROTTLE_MS, UserProvisioningService } from './user-provisioning.service';
import type { SupabaseClaims } from './auth.types';

const CLAIMS: SupabaseClaims = {
  sub: '11111111-1111-1111-1111-111111111111',
  email: 'juan@example.com',
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  phone: '0917 000 0000',
  heightCm: 175,
  weightKg: 72.4,
  dateOfBirth: null,
};

const NOW = new Date('2026-08-18T10:00:00.000Z');

/** Seen two minutes ago — well inside the throttle window. */
const FRESH_LAST_SEEN = new Date(NOW.getTime() - 120_000);
/** Seen sixteen minutes ago — outside it. */
const STALE_LAST_SEEN = new Date(NOW.getTime() - LAST_SEEN_THROTTLE_MS - 60_000);

function existingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    supabaseId: CLAIMS.sub,
    email: CLAIMS.email,
    firstName: 'Juan',
    lastName: 'Dela Cruz',
    role: 'CLIENT',
    status: 'ACTIVE',
    permissionVersion: 0,
    heightCm: 175,
    weightKg: 72.4,
    deletedAt: null,
    lastSeenAt: FRESH_LAST_SEEN,
    ...overrides,
  };
}

describe('UserProvisioningService', () => {
  let service: UserProvisioningService;
  let findUnique: jest.Mock;
  let upsert: jest.Mock;
  let update: jest.Mock;

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(NOW);

    findUnique = jest.fn().mockResolvedValue(existingRow());
    upsert = jest.fn().mockResolvedValue(existingRow());
    update = jest.fn().mockResolvedValue(existingRow({ lastSeenAt: NOW }));

    const moduleRef = await Test.createTestingModule({
      providers: [
        UserProvisioningService,
        { provide: PrismaService, useValue: { user: { findUnique, upsert, update } } },
      ],
    }).compile();

    service = moduleRef.get(UserProvisioningService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns the resolved AuthUser without leaking lastSeenAt', async () => {
    await expect(service.resolve(CLAIMS)).resolves.toEqual({
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      supabaseId: CLAIMS.sub,
      email: CLAIMS.email,
      firstName: 'Juan',
      lastName: 'Dela Cruz',
      role: 'CLIENT',
      status: 'ACTIVE',
      permissionVersion: 0,
      heightCm: 175,
      weightKg: 72.4,
      deletedAt: null,
    });
  });

  it('reads with findUnique and writes nothing on the hot path', async () => {
    await service.resolve(CLAIMS);

    // AuthGuard runs this on every authenticated request, before the throttler
    // can reject anything. An unconditional upsert makes every check-in at the
    // 05:00 peak a write.
    expect(findUnique).toHaveBeenCalledWith({
      where: { supabaseId: CLAIMS.sub },
      select: expect.objectContaining({ deletedAt: true, lastSeenAt: true }),
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('upserts only when the identity has never been seen', async () => {
    findUnique.mockResolvedValue(null);
    await service.resolve(CLAIMS);

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ supabaseId: CLAIMS.sub });
    expect(arg.create).toMatchObject({
      supabaseId: CLAIMS.sub,
      email: CLAIMS.email,
      firstName: 'Juan',
      lastName: 'Dela Cruz',
      phone: '0917 000 0000',
      heightCm: 175,
      weightKg: 72.4,
    });
    // Role must never be settable from token claims — it falls back to the
    // schema default instead.
    expect(arg.create.role).toBeUndefined();
    expect(arg.create.status).toBeUndefined();
    expect(arg.update).not.toHaveProperty('role');
    expect(arg.update).not.toHaveProperty('status');
    expect(arg.update).not.toHaveProperty('heightCm');
    expect(arg.update).not.toHaveProperty('weightKg');
  });

  it('never resurrects a soft-deleted row', async () => {
    findUnique.mockResolvedValue(
      existingRow({ deletedAt: new Date('2026-08-01T02:00:00Z'), lastSeenAt: STALE_LAST_SEEN }),
    );

    const user = await service.resolve(CLAIMS);

    expect(user.deletedAt).toEqual(new Date('2026-08-01T02:00:00Z'));
    expect(upsert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('skips the lastSeenAt write inside the throttle window', async () => {
    findUnique.mockResolvedValue(existingRow({ lastSeenAt: FRESH_LAST_SEEN }));
    await service.resolve(CLAIMS);
    expect(update).not.toHaveBeenCalled();
  });

  it('writes lastSeenAt once the window has elapsed', async () => {
    findUnique.mockResolvedValue(existingRow({ lastSeenAt: STALE_LAST_SEEN }));
    await service.resolve(CLAIMS);

    expect(update).toHaveBeenCalledWith({
      where: { supabaseId: CLAIMS.sub },
      data: { email: CLAIMS.email, lastSeenAt: NOW },
      select: expect.objectContaining({ deletedAt: true }),
    });
  });

  it('writes lastSeenAt when it has never been set', async () => {
    findUnique.mockResolvedValue(existingRow({ lastSeenAt: null }));
    await service.resolve(CLAIMS);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('writes immediately when the email changed in Supabase, window or not', async () => {
    findUnique.mockResolvedValue(
      existingRow({ email: 'old@example.com', lastSeenAt: FRESH_LAST_SEEN }),
    );
    await service.resolve(CLAIMS);

    expect(update).toHaveBeenCalledWith({
      where: { supabaseId: CLAIMS.sub },
      data: { email: CLAIMS.email, lastSeenAt: NOW },
      select: expect.objectContaining({ deletedAt: true }),
    });
  });
});
