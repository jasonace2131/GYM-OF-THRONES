import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { REQUIRE_PERMISSION_KEY } from '../rbac/decorators/require-permission.decorator';
import { IDEMPOTENT_KEY } from '../common/decorators/idempotent.decorator';
import type { AuthUser } from '../auth/auth.types';
import type { GymConfigService } from '../config/gym.config';
import { AdminAssistantController } from './admin-assistant.controller';
import type { AssistantSettingsService } from './assistant-settings.service';
import type { AssistantService } from './assistant.service';
import {
  ASSISTANT_INSTRUCTIONS_MAX_LENGTH,
  DEFAULT_ASSISTANT_INSTRUCTIONS,
  assistantSafetyRules,
} from './assistant-prompt';

const ADMIN = { id: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' } as AuthUser;

describe('AdminAssistantController', () => {
  const handler = (name: string): object =>
    (AdminAssistantController.prototype as unknown as Record<string, object>)[name];
  const meta = (key: string, name: string): unknown => Reflect.getMetadata(key, handler(name));
  const classMeta = (key: string): unknown => Reflect.getMetadata(key, AdminAssistantController);

  it('serves GET, PUT and DELETE /admin/assistant and POST /admin/assistant/test', () => {
    expect(classMeta(PATH_METADATA)).toBe('admin/assistant');
    expect(meta(METHOD_METADATA, 'get')).toBe(RequestMethod.GET);
    expect(meta(METHOD_METADATA, 'save')).toBe(RequestMethod.PUT);
    expect(meta(METHOD_METADATA, 'reset')).toBe(RequestMethod.DELETE);
    expect(meta(METHOD_METADATA, 'test')).toBe(RequestMethod.POST);
    expect(meta(PATH_METADATA, 'test')).toBe('test');
  });

  /** The key ADMIN already holds, unused until now. Hiding the card is not the control; this is. */
  it('gates every route on ai.admin.configure', () => {
    for (const name of ['get', 'save', 'reset', 'test']) {
      expect(meta(REQUIRE_PERMISSION_KEY, name)).toBe('ai.admin.configure');
    }
  });

  it('limits Try it to 10 questions a minute, like the member assistant', () => {
    expect(meta('THROTTLER:LIMITdefault', 'test')).toBe(10);
    expect(meta('THROTTLER:TTLdefault', 'test')).toBe(60_000);
  });

  /** Try it writes nothing, so it creates nothing (200) and needs no replay protection. */
  it('answers Try it with 200 and asks for no Idempotency-Key', () => {
    expect(meta(HTTP_CODE_METADATA, 'test')).toBe(200);
    expect(meta(IDEMPOTENT_KEY, 'test')).toBeUndefined();
  });

  describe('behaviour', () => {
    const current = {
      text: 'Be brief.',
      isDefault: false,
      updatedAt: new Date('2026-10-14T03:00:00.000Z'),
      updatedByName: 'Ana Cruz',
    };
    const settings = { instructionsStrict: jest.fn(), save: jest.fn(), reset: jest.fn() };
    const tryDraft = jest.fn();
    const gym = { timeZone: 'Asia/Manila' } as unknown as GymConfigService;
    const build = (enabled = true): AdminAssistantController =>
      new AdminAssistantController(
        settings as unknown as AssistantSettingsService,
        { enabled, tryDraft } as unknown as AssistantService,
        gym,
      );

    beforeEach(() => {
      for (const fn of [settings.instructionsStrict, settings.save, settings.reset, tryDraft]) {
        fn.mockReset();
      }
      settings.instructionsStrict.mockResolvedValue(current);
      settings.save.mockResolvedValue(current);
      settings.reset.mockResolvedValue(current);
    });

    it('shows the saved text, the default, the locked rules and the limit', async () => {
      await expect(build().get()).resolves.toEqual({
        instructions: 'Be brief.',
        isDefault: false,
        defaultInstructions: DEFAULT_ASSISTANT_INSTRUCTIONS,
        safetyRules: assistantSafetyRules('Asia/Manila'),
        maxLength: ASSISTANT_INSTRUCTIONS_MAX_LENGTH,
        updatedAt: '2026-10-14T03:00:00.000Z',
        updatedByName: 'Ana Cruz',
        enabled: true,
      });
    });

    it('says when Gemini is switched off, and still shows the text', async () => {
      await expect(build(false).get()).resolves.toMatchObject({
        enabled: false,
        instructions: 'Be brief.',
      });
    });

    it('sends updatedAt as null for the default', async () => {
      settings.instructionsStrict.mockResolvedValue({
        text: DEFAULT_ASSISTANT_INSTRUCTIONS,
        isDefault: true,
        updatedAt: null,
        updatedByName: null,
      });
      await expect(build().get()).resolves.toMatchObject({ isDefault: true, updatedAt: null });
    });

    /** Showing the default here would offer Save over custom text the card never saw. */
    it('fails rather than show the default when the table cannot be read', async () => {
      settings.instructionsStrict.mockRejectedValue(new Error('connection terminated'));
      await expect(build().get()).rejects.toThrow('connection terminated');
    });

    it('saves as the caller, then shows the result', async () => {
      await build().save(ADMIN, { instructions: 'Be brief.' });
      expect(settings.save).toHaveBeenCalledWith('Be brief.', ADMIN.id, 'ADMIN');
      expect(settings.instructionsStrict).toHaveBeenCalled();
    });

    it('resets as the caller', async () => {
      await build().reset(ADMIN);
      expect(settings.reset).toHaveBeenCalledWith(ADMIN.id, 'ADMIN');
    });

    it('runs the draft for the caller and returns the answer', async () => {
      tryDraft.mockResolvedValue({ answer: 'ok', model: 'gemini-3.1-flash-lite' });

      await expect(
        build().test(ADMIN, { instructions: 'Draft.', question: 'Hi?' }),
      ).resolves.toEqual({ answer: 'ok', model: 'gemini-3.1-flash-lite' });
      expect(tryDraft).toHaveBeenCalledWith(ADMIN.id, 'Draft.', 'Hi?');
    });
  });
});
