import { Logger } from '@nestjs/common';
import { AssistantSettingsService } from './assistant-settings.service';
import { assistantSafetyRules, DEFAULT_ASSISTANT_INSTRUCTIONS } from './assistant-prompt';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const SAVED_AT = new Date('2026-10-14T03:00:00.000Z');

const row = (instructions: string) => ({
  id: 1,
  instructions,
  updatedById: ADMIN,
  updatedAt: SAVED_AT,
  updatedBy: { firstName: 'Ana', lastName: 'Cruz' },
});

describe('AssistantSettingsService', () => {
  const findUnique = jest.fn();
  const upsert = jest.fn();
  const deleteMany = jest.fn();
  const record = jest.fn();

  const prisma = {
    assistantSettings: { findUnique, upsert, deleteMany },
  } as unknown as PrismaService;
  const audit = { record } as unknown as AuditService;
  const gym = { timeZone: 'Asia/Manila' } as unknown as GymConfigService;
  const build = (): AssistantSettingsService => new AssistantSettingsService(prisma, gym, audit);

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-14T04:00:00.000Z') });
    for (const fn of [findUnique, upsert, deleteMany, record]) fn.mockReset();
    upsert.mockResolvedValue({});
    record.mockResolvedValue(undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('instructions()', () => {
    it('is the built-in default when nothing is saved', async () => {
      findUnique.mockResolvedValue(null);

      await expect(build().instructions()).resolves.toEqual({
        text: DEFAULT_ASSISTANT_INSTRUCTIONS,
        isDefault: true,
        updatedAt: null,
        updatedByName: null,
      });
    });

    it('is the saved text, with who saved it and when', async () => {
      findUnique.mockResolvedValue(row('Be brief.'));

      await expect(build().instructions()).resolves.toEqual({
        text: 'Be brief.',
        isDefault: false,
        updatedAt: SAVED_AT,
        updatedByName: 'Ana Cruz',
      });
      expect(findUnique).toHaveBeenCalledWith({
        where: { id: 1 },
        include: { updatedBy: { select: { firstName: true, lastName: true } } },
      });
    });

    it('names nobody when the editor account is gone', async () => {
      findUnique.mockResolvedValue({ ...row('Be brief.'), updatedById: null, updatedBy: null });

      expect((await build().instructions()).updatedByName).toBeNull();
    });

    /**
     * A database problem must never leave a member without an assistant —
     * and must not pin the default for a minute either: the next question
     * tries the table again.
     */
    it('falls back to the default when the read fails, and retries next time', async () => {
      findUnique
        .mockRejectedValueOnce(new Error('connection terminated'))
        .mockResolvedValueOnce(row('Be brief.'));
      const service = build();

      expect((await service.instructions()).isDefault).toBe(true);
      expect((await service.instructions()).text).toBe('Be brief.');
      expect(findUnique).toHaveBeenCalledTimes(2);
    });

    it('reads the table once a minute, not once a question', async () => {
      findUnique.mockResolvedValue(row('Be brief.'));
      const service = build();

      await service.instructions();
      await service.instructions();
      expect(findUnique).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(60_001);
      await service.instructions();
      expect(findUnique).toHaveBeenCalledTimes(2);
    });
  });

  /** The admin view: what the table holds, or an error — never the default in its place. */
  describe('instructionsStrict()', () => {
    it('is the saved text', async () => {
      findUnique.mockResolvedValue(row('Be brief.'));

      await expect(build().instructionsStrict()).resolves.toMatchObject({
        text: 'Be brief.',
        isDefault: false,
      });
    });

    it('throws when the read fails, where the member path falls back', async () => {
      findUnique.mockRejectedValue(new Error('connection terminated'));
      const service = build();

      await expect(service.instructionsStrict()).rejects.toThrow('connection terminated');
      expect((await service.instructions()).isDefault).toBe(true);
    });

    it('reads the table every time, past the cache', async () => {
      findUnique.mockResolvedValueOnce(row('Cached.')).mockResolvedValueOnce(row('Fresh.'));
      const service = build();

      await service.instructions();
      await expect(service.instructionsStrict()).resolves.toMatchObject({ text: 'Fresh.' });
    });
  });

  describe('systemPrompt()', () => {
    it('is the saved instructions followed by the locked safety rules', async () => {
      findUnique.mockResolvedValue(row('Be brief.'));

      const prompt = await build().systemPrompt();

      expect(prompt.startsWith('Be brief.')).toBe(true);
      expect(prompt.endsWith(assistantSafetyRules('Asia/Manila'))).toBe(true);
    });
  });

  describe('save()', () => {
    it('writes row 1 with the editor, then serves the new text at once', async () => {
      findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(row('Be brief.'));

      const result = await build().save('Be brief.', ADMIN, 'ADMIN');

      expect(upsert).toHaveBeenCalledWith({
        where: { id: 1 },
        create: { id: 1, instructions: 'Be brief.', updatedById: ADMIN },
        update: { instructions: 'Be brief.', updatedById: ADMIN },
      });
      expect(result).toMatchObject({ text: 'Be brief.', isDefault: false });
    });

    it('trims what it stores', async () => {
      findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(row('Be brief.'));

      await build().save('\n  Be brief.  \n', ADMIN, 'ADMIN');

      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { instructions: 'Be brief.', updatedById: ADMIN } }),
      );
    });

    it('audits the before and the after', async () => {
      findUnique.mockResolvedValueOnce(row('Old.')).mockResolvedValueOnce(row('Newer.'));

      await build().save('Newer.', ADMIN, 'ADMIN');

      expect(record).toHaveBeenCalledWith({
        action: 'ASSISTANT_INSTRUCTIONS_UPDATED',
        actorId: ADMIN,
        actorRole: 'ADMIN',
        subjectType: 'AssistantSettings',
        subjectLabel: '4 → 6 characters',
        details: { before: 'Old.', after: 'Newer.', wasDefault: false },
      });
    });

    it('audits replacing the built-in default, and says so', async () => {
      findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(row('Be brief.'));

      await build().save('Be brief.', ADMIN, 'ADMIN');

      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ASSISTANT_INSTRUCTIONS_UPDATED',
          details: { before: DEFAULT_ASSISTANT_INSTRUCTIONS, after: 'Be brief.', wasDefault: true },
        }),
      );
    });

    /** A write would move the "Edited by" badge with no audit entry to explain it. */
    it('writes nothing and audits nothing when the text is unchanged', async () => {
      findUnique.mockResolvedValue(row('Same.'));

      const result = await build().save('  Same.\n', ADMIN, 'ADMIN');

      expect(upsert).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(result).toMatchObject({ text: 'Same.', isDefault: false, updatedByName: 'Ana Cruz' });
    });

    it('still saves the default text over the default, so it is pinned', async () => {
      findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(row(DEFAULT_ASSISTANT_INSTRUCTIONS));

      await build().save(DEFAULT_ASSISTANT_INSTRUCTIONS, ADMIN, 'ADMIN');

      expect(upsert).toHaveBeenCalled();
    });

    /**
     * The swallowing member read would audit the default as "before" and
     * write over text it never saw.
     */
    it('fails without writing or auditing when the before-read fails', async () => {
      findUnique.mockRejectedValue(new Error('connection terminated'));

      await expect(build().save('Be brief.', ADMIN, 'ADMIN')).rejects.toThrow(
        'connection terminated',
      );
      expect(upsert).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('compares against the table, not a minute-old cache', async () => {
      findUnique
        .mockResolvedValueOnce(row('Cached.'))
        .mockResolvedValueOnce(row('Saved elsewhere.'))
        .mockResolvedValueOnce(row('Mine.'));
      const service = build();

      await service.instructions();
      await service.save('Mine.', ADMIN, 'ADMIN');

      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          details: { before: 'Saved elsewhere.', after: 'Mine.', wasDefault: false },
        }),
      );
    });
  });

  describe('reset()', () => {
    it('deletes the row, audits what it replaced and serves the default', async () => {
      findUnique.mockResolvedValueOnce(row('Be brief.')).mockResolvedValueOnce(null);
      deleteMany.mockResolvedValue({ count: 1 });

      const result = await build().reset(ADMIN, 'ADMIN');

      expect(deleteMany).toHaveBeenCalledWith({ where: { id: 1 } });
      expect(record).toHaveBeenCalledWith({
        action: 'ASSISTANT_INSTRUCTIONS_RESET',
        actorId: ADMIN,
        actorRole: 'ADMIN',
        subjectType: 'AssistantSettings',
        subjectLabel: 'Back to the built-in instructions',
        details: { before: 'Be brief.' },
      });
      expect(result.isDefault).toBe(true);
    });

    it('fails without deleting or auditing when the before-read fails', async () => {
      findUnique.mockRejectedValue(new Error('connection terminated'));

      await expect(build().reset(ADMIN, 'ADMIN')).rejects.toThrow('connection terminated');
      expect(deleteMany).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('audits nothing when it was already on the default', async () => {
      findUnique.mockResolvedValue(null);
      deleteMany.mockResolvedValue({ count: 0 });

      await build().reset(ADMIN, 'ADMIN');

      expect(record).not.toHaveBeenCalled();
    });
  });
});
