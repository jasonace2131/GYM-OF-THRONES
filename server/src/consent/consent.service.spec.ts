import { ConsentService } from './consent.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { LEGAL_VERSIONS } from '@got/shared';

const config = {
  get: () => 'test-pepper',
} as unknown as ConfigService<Env, true>;

describe('ConsentService', () => {
  const findMany = jest.fn();
  const createMany = jest.fn();
  const prisma = { consentRecord: { findMany, createMany } } as unknown as PrismaService;

  beforeEach(() => {
    findMany.mockReset();
    createMany.mockReset();
    createMany.mockResolvedValue({ count: 0 });
  });

  describe('standing', () => {
    it('reports all three outstanding for somebody who has accepted nothing', async () => {
      findMany.mockResolvedValue([]);
      const service = new ConsentService(prisma, config);

      const standing = await service.standing('u1');

      expect(standing.satisfied).toBe(false);
      expect(standing.outstanding).toEqual(['WAIVER', 'TERMS', 'PRIVACY']);
      expect(standing.accepted).toEqual([]);
    });

    it('is satisfied once all three are accepted at the current version', async () => {
      findMany.mockResolvedValue([
        { kind: 'WAIVER', version: LEGAL_VERSIONS.WAIVER },
        { kind: 'TERMS', version: LEGAL_VERSIONS.TERMS },
        { kind: 'PRIVACY', version: LEGAL_VERSIONS.PRIVACY },
      ]);
      const service = new ConsentService(prisma, config);

      const standing = await service.standing('u1');

      expect(standing.satisfied).toBe(true);
      expect(standing.outstanding).toEqual([]);
    });

    /**
     * THE WHOLE POINT OF STORING A VERSION.
     *
     * "Has this member consented" is the wrong question — the right one is
     * "has this member consented to THIS WORDING". A boolean column could not
     * express the difference, which is why bumping LEGAL_VERSIONS is the
     * entire re-prompt mechanism: no migration, no sweep job, no flag to
     * reset on 2,000 rows.
     */
    it('re-prompts for a document accepted at an older version', async () => {
      findMany.mockResolvedValue([
        { kind: 'WAIVER', version: '2020-01-01' },
        { kind: 'TERMS', version: LEGAL_VERSIONS.TERMS },
        { kind: 'PRIVACY', version: LEGAL_VERSIONS.PRIVACY },
      ]);
      const service = new ConsentService(prisma, config);

      const standing = await service.standing('u1');

      expect(standing.outstanding).toEqual(['WAIVER']);
      expect(standing.accepted).toEqual(['TERMS', 'PRIVACY']);
      expect(standing.satisfied).toBe(false);
    });
  });

  describe('accept', () => {
    it('writes the SERVER version, never one supplied by the caller', async () => {
      findMany.mockResolvedValue([]);
      const service = new ConsentService(prisma, config);

      await service.accept('u1', ['WAIVER'], {}, new Date('2026-09-01T02:00:00.000Z'));

      const [{ data }] = createMany.mock.calls[0] as [{ data: { version: string }[] }];
      expect(data[0]?.version).toBe(LEGAL_VERSIONS.WAIVER);
    });

    /**
     * An IP is personal data under RA 10173. Evidencing consent must not
     * itself create a privacy problem, so the address is peppered and hashed
     * — the same control StationScan.originIpHash uses — and the raw value
     * never reaches a column. `CHAR(64)` plus a hex CHECK is the backstop.
     */
    it('hashes the origin address rather than storing it', async () => {
      findMany.mockResolvedValue([]);
      const service = new ConsentService(prisma, config);

      await service.accept('u1', ['PRIVACY'], { ip: '203.0.113.9', userAgent: 'Firefox' });

      const [{ data }] = createMany.mock.calls[0] as [{ data: { ipHash: string | null }[] }];
      expect(data[0]?.ipHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(data)).not.toContain('203.0.113.9');
    });

    it('records no address when there is no request behind the acceptance', async () => {
      findMany.mockResolvedValue([]);
      const service = new ConsentService(prisma, config);

      await service.accept('u1', ['TERMS'], {});

      const [{ data }] = createMany.mock.calls[0] as [{ data: { ipHash: string | null }[] }];
      expect(data[0]?.ipHash).toBeNull();
    });

    it('truncates an absurd user agent rather than rejecting the acceptance', async () => {
      findMany.mockResolvedValue([]);
      const service = new ConsentService(prisma, config);

      await service.accept('u1', ['TERMS'], { userAgent: 'x'.repeat(5000) });

      const [{ data }] = createMany.mock.calls[0] as [{ data: { userAgent: string | null }[] }];
      expect(data[0]?.userAgent).toHaveLength(400);
    });

    /**
     * Two tabs, a double-tap, or a retry after a dropped response all land
     * here. The unique index settles it; `skipDuplicates` means the second
     * one is a no-op rather than a 500 shown to a member who did nothing
     * wrong.
     */
    it('is idempotent on a repeat acceptance of the same version', async () => {
      findMany.mockResolvedValue([]);
      const service = new ConsentService(prisma, config);

      await service.accept('u1', ['WAIVER', 'TERMS', 'PRIVACY'], {});

      const [call] = createMany.mock.calls[0] as [{ skipDuplicates: boolean }];
      expect(call.skipDuplicates).toBe(true);
    });
  });
});
