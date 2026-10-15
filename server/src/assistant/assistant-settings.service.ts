import { Injectable, Logger } from '@nestjs/common';
import type { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { GymConfigService } from '../config/gym.config';
import { composeSystemPrompt, DEFAULT_ASSISTANT_INSTRUCTIONS } from './assistant-prompt';

export interface AssistantInstructions {
  text: string;
  /** True when nothing is saved and the built-in default is in use. */
  isDefault: boolean;
  updatedAt: Date | null;
  /** Null for the default, and when the account that saved it is gone. */
  updatedByName: string | null;
}

/** The table holds one row or none (CHECK "id" = 1). */
const ROW_ID = 1;

/** As OpeningHoursService: edits are rare, and every member question reads this. */
const CACHE_MS = 60_000;

/** Characters as Postgres and the DTO count them: code points, so an emoji is one. */
const characters = (text: string): number => Array.from(text).length;

/**
 * The member assistant's editable instructions — the table first, the built-in
 * default as the floor.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A DATABASE PROBLEM NEVER LEAVES A MEMBER WITHOUT AN ASSISTANT.
 *
 * No row → the default. A read that throws → the default, logged, and NOT
 * cached, so the next question tries the table again. The safety rules are
 * appended by `composeSystemPrompt` in every case, saved text or default.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class AssistantSettingsService {
  private readonly logger = new Logger(AssistantSettingsService.name);

  private cache: { at: number; value: AssistantInstructions } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly audit: AuditService,
  ) {}

  private defaults(): AssistantInstructions {
    return {
      text: DEFAULT_ASSISTANT_INSTRUCTIONS,
      isDefault: true,
      updatedAt: null,
      updatedByName: null,
    };
  }

  async instructions(): Promise<AssistantInstructions> {
    const now = Date.now();
    if (this.cache !== null && now - this.cache.at < CACHE_MS) return this.cache.value;

    let value: AssistantInstructions;
    try {
      value = await this.instructionsStrict();
    } catch (caught) {
      this.logger.error(
        'Could not read the assistant instructions — using the built-in default',
        caught as Error,
      );
      return this.defaults();
    }

    this.cache = { at: now, value };
    return value;
  }

  /**
   * What the table holds, read past the cache — and a database error THROWS.
   *
   * For the admin side only: the Settings card and the audit's "before". The
   * default in place of a failed read would show "Built-in default" over
   * custom text, and audit the default as what a save replaced.
   */
  async instructionsStrict(): Promise<AssistantInstructions> {
    const row = await this.prisma.assistantSettings.findUnique({
      where: { id: ROW_ID },
      include: { updatedBy: { select: { firstName: true, lastName: true } } },
    });
    if (row === null) return this.defaults();
    return {
      text: row.instructions,
      isDefault: false,
      updatedAt: row.updatedAt,
      updatedByName:
        row.updatedBy === null
          ? null
          : `${row.updatedBy.firstName} ${row.updatedBy.lastName}`.trim(),
    };
  }

  /** What Gemini is told: the instructions, then the locked safety rules. */
  async systemPrompt(): Promise<string> {
    const { text } = await this.instructions();
    return composeSystemPrompt(text, this.gym.timeZone);
  }

  /** Called after a write, so a save takes effect on the next question. */
  invalidate(): void {
    this.cache = null;
  }

  async save(text: string, actorId: string, actorRole: Role): Promise<AssistantInstructions> {
    const instructions = text.trim();

    // A fresh, strict read: the audit entry must say what the table held,
    // which another admin may have changed in the last minute — and a failed
    // read stops the save rather than audit the default as "before".
    const before = await this.instructionsStrict();

    // Rewriting the same text would move the "Edited by" badge with nothing
    // in the audit log to explain it.
    if (!before.isDefault && before.text === instructions) return before;

    await this.prisma.assistantSettings.upsert({
      where: { id: ROW_ID },
      create: { id: ROW_ID, instructions, updatedById: actorId },
      update: { instructions, updatedById: actorId },
    });

    this.invalidate();
    const after = await this.instructions();

    await this.audit.record({
      action: 'ASSISTANT_INSTRUCTIONS_UPDATED',
      actorId,
      actorRole,
      subjectType: 'AssistantSettings',
      subjectLabel: `${characters(before.text)} → ${characters(instructions)} characters`,
      details: { before: before.text, after: instructions, wasDefault: before.isDefault },
    });

    return after;
  }

  async reset(actorId: string, actorRole: Role): Promise<AssistantInstructions> {
    const before = await this.instructionsStrict();

    const { count } = await this.prisma.assistantSettings.deleteMany({ where: { id: ROW_ID } });
    this.invalidate();

    if (count > 0) {
      await this.audit.record({
        action: 'ASSISTANT_INSTRUCTIONS_RESET',
        actorId,
        actorRole,
        subjectType: 'AssistantSettings',
        subjectLabel: 'Back to the built-in instructions',
        details: { before: before.text },
      });
    }

    return this.instructions();
  }
}
