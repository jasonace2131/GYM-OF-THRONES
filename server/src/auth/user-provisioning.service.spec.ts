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
  sessionId: '99999999-9999-4999-8999-999999999999',
  amr: ['password'],
  signedInAt: new Date('2026-08-18T09:00:00.000Z'),
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

  // My account (owner, 2026-10-23): a member edits their own name and phone,
  // but their token keeps carrying the SIGN-UP metadata. Provisioning must
  // never copy that back over the edit.
  it("never overwrites a member's own name or phone edit with the token's sign-up values", async () => {
    findUnique.mockResolvedValue(
      existingRow({ firstName: 'Juanito', lastName: 'Cruz', lastSeenAt: STALE_LAST_SEEN }),
    );
    update.mockResolvedValue(
      existingRow({ firstName: 'Juanito', lastName: 'Cruz', lastSeenAt: NOW }),
    );

    const resolved = await service.resolve(CLAIMS);

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { email: CLAIMS.email, lastSeenAt: NOW } }),
    );
    expect(upsert).not.toHaveBeenCalled();
    expect(resolved).toMatchObject({ firstName: 'Juanito', lastName: 'Cruz' });
  });

  describe("the account's current sign-in (one device at a time)", () => {
    const HELD_AT = new Date('2026-08-18T08:00:00.000Z');
    const HOLDER = '88888888-8888-4888-8888-888888888888';

    it('comes from the SAME read: one findUnique, no extra query, no write', async () => {
      findUnique.mockResolvedValue(
        existingRow({ activeSessionId: HOLDER, activeSessionSignedInAt: HELD_AT }),
      );

      const resolved = await service.resolveWithActiveSession(CLAIMS);

      expect(resolved.activeSession).toEqual({ sessionId: HOLDER, signedInAt: HELD_AT });
      expect(findUnique).toHaveBeenCalledTimes(1);
      expect(findUnique).toHaveBeenCalledWith({
        where: { supabaseId: CLAIMS.sub },
        select: expect.objectContaining({ activeSessionId: true, activeSessionSignedInAt: true }),
      });
      expect(upsert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('never puts it on the AuthUser, which controllers receive', async () => {
      findUnique.mockResolvedValue(
        existingRow({ activeSessionId: HOLDER, activeSessionSignedInAt: HELD_AT }),
      );

      const { user } = await service.resolveWithActiveSession(CLAIMS);
      const plain = await service.resolve(CLAIMS);

      for (const shape of [user, plain]) {
        expect(shape).not.toHaveProperty('activeSessionId');
        expect(shape).not.toHaveProperty('activeSessionSignedInAt');
        expect(shape).not.toHaveProperty('lastSeenAt');
      }
    });

    it('is unheld for a row that has never been claimed', async () => {
      const resolved = await service.resolveWithActiveSession(CLAIMS);
      expect(resolved.activeSession).toEqual({ sessionId: null, signedInAt: null });
    });

    it('is unheld for a brand-new identity, read back from the upsert', async () => {
      findUnique.mockResolvedValue(null);
      upsert.mockResolvedValue(
        existingRow({
          activeSessionId: null,
          activeSessionSignedInAt: null,
          lastSeenAt: undefined,
        }),
      );

      const resolved = await service.resolveWithActiveSession(CLAIMS);

      expect(resolved.activeSession).toEqual({ sessionId: null, signedInAt: null });
      expect(upsert.mock.calls[0][0].select).toEqual(
        expect.objectContaining({ activeSessionId: true, activeSessionSignedInAt: true }),
      );
    });

    it('is never written here, even when lastSeenAt is', async () => {
      findUnique.mockResolvedValue(
        existingRow({ lastSeenAt: STALE_LAST_SEEN, activeSessionId: HOLDER }),
      );
      await service.resolveWithActiveSession(CLAIMS);
      expect(update.mock.calls[0][0].data).toEqual({ email: CLAIMS.email, lastSeenAt: NOW });
    });
  });

  /** Owner, 2026-10-30: nobody under 12 has an account (reversing 2026-10-23's "no minimum age"). */
  describe('minimum account age', () => {
    it('refuses a first-sight sign-up under 12 with 403 AGE_REQUIREMENT_NOT_MET, and creates nothing', async () => {
      findUnique.mockResolvedValue(null);

      const refused = service.resolve({ ...CLAIMS, dateOfBirth: '2020-06-01' });
      await expect(refused).rejects.toMatchObject({
        response: {
          code: 'AGE_REQUIREMENT_NOT_MET',
          message: 'You need to be at least 12 years old to create an account.',
        },
        status: 403,
      });
      expect(upsert).not.toHaveBeenCalled();
    });

    it('creates the account from the 12th birthday, once it has begun anywhere on Earth', async () => {
      findUnique.mockResolvedValue(null);

      // NOW is 2026-08-18 10:00 UTC: already the 19th at UTC+14.
      await service.resolve({ ...CLAIMS, dateOfBirth: '2014-08-19' });
      expect(upsert.mock.calls[0][0].create.dateOfBirth).toEqual(
        new Date('2014-08-19T00:00:00.000Z'),
      );

      upsert.mockClear();
      const notYet = service.resolve({ ...CLAIMS, dateOfBirth: '2014-08-20' });
      await expect(notYet).rejects.toMatchObject({ status: 403 });
      expect(upsert).not.toHaveBeenCalled();
    });

    it('does not judge a token with no date of birth (a staff invitation, a dashboard user)', async () => {
      findUnique.mockResolvedValue(null);
      await service.resolve(CLAIMS);
      expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('never refuses an account already on file, whatever its token says', async () => {
      findUnique.mockResolvedValue(existingRow());
      await expect(
        service.resolve({ ...CLAIMS, dateOfBirth: '2020-06-01' }),
      ).resolves.toMatchObject({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
    });
  });
});
