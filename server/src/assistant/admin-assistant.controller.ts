import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { GymConfigService } from '../config/gym.config';
import { AssistantService } from './assistant.service';
import { AssistantSettingsService } from './assistant-settings.service';
import {
  ASSISTANT_INSTRUCTIONS_MAX_LENGTH,
  DEFAULT_ASSISTANT_INSTRUCTIONS,
  assistantSafetyRules,
} from './assistant-prompt';
import { SaveAssistantInstructionsDto, TryAssistantDraftDto } from './dto/assistant-settings.dto';

/** What the Settings card shows. Mirrored in client/src/lib/adminApi.ts. */
export interface AssistantSettingsView {
  instructions: string;
  isDefault: boolean;
  defaultInstructions: string;
  /** Read-only on the card: appended by code to whatever is saved. */
  safetyRules: string;
  maxLength: number;
  updatedAt: string | null;
  updatedByName: string | null;
  /** False when GEMINI_API_KEY is unset: the text still edits, Try it cannot answer. */
  enabled: boolean;
}

/**
 * The member assistant's instructions, edited from Admin → Settings
 * (feat/assistant-settings, 2026-10-14).
 *
 * Every route is behind `ai.admin.configure` — a key the catalogue has carried,
 * and ADMIN has held, since the assistant shipped, with nothing behind it
 * until now.
 */
@Controller('admin/assistant')
export class AdminAssistantController {
  constructor(
    private readonly settings: AssistantSettingsService,
    private readonly assistant: AssistantService,
    private readonly gym: GymConfigService,
  ) {}

  @Get()
  @RequirePermission('ai.admin.configure')
  async get(): Promise<AssistantSettingsView> {
    return this.view();
  }

  /** PUT: the whole text is replaced, so the editor and the table cannot half-agree. */
  @Put()
  @RequirePermission('ai.admin.configure')
  async save(
    @CurrentUser() user: AuthUser,
    @Body() dto: SaveAssistantInstructionsDto,
  ): Promise<AssistantSettingsView> {
    await this.settings.save(dto.instructions, user.id, user.role);
    return this.view();
  }

  @Delete()
  @RequirePermission('ai.admin.configure')
  async reset(@CurrentUser() user: AuthUser): Promise<AssistantSettingsView> {
    await this.settings.reset(user.id, user.role);
    return this.view();
  }

  /**
   * Try the UNSAVED draft. Spends the same free Gemini quota members use, so
   * it carries the member assistant's own limit.
   */
  @Post('test')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('ai.admin.configure')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async test(
    @CurrentUser() user: AuthUser,
    @Body() dto: TryAssistantDraftDto,
  ): Promise<{ answer: string; model: string }> {
    return this.assistant.tryDraft(user.id, dto.instructions, dto.question);
  }

  private async view(): Promise<AssistantSettingsView> {
    const current = await this.settings.instructionsStrict();
    return {
      instructions: current.text,
      isDefault: current.isDefault,
      defaultInstructions: DEFAULT_ASSISTANT_INSTRUCTIONS,
      safetyRules: assistantSafetyRules(this.gym.timeZone),
      maxLength: ASSISTANT_INSTRUCTIONS_MAX_LENGTH,
      updatedAt: current.updatedAt === null ? null : current.updatedAt.toISOString(),
      updatedByName: current.updatedByName,
      enabled: this.assistant.enabled,
    };
  }
}
