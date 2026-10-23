import { HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type Role } from '@prisma/client';
import type { GymEquipmentInput, GymEquipmentItem } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DomainException } from '../common/exceptions/domain.exception';

/** As AssistantSettingsService: edits are rare, every plan reads this. */
const CACHE_MS = 60_000;

const DUPLICATE_MESSAGE = 'That equipment is already on the list.';
const ORDER_MESSAGE = 'The list changed while you were reordering. Reload and try again.';

type Row = { id: string; name: string; detail: string | null; sortOrder: number };

const toItem = (row: Row): GymEquipmentItem => ({
  id: row.id,
  name: row.name,
  detail: row.detail,
  sortOrder: row.sortOrder,
});

/** "Dumbbells (2–40 kg pairs)", or just the name. What the AI is given. */
export function equipmentForPrompt(rows: readonly Pick<Row, 'name' | 'detail'>[]): string[] {
  return rows.map((row) => (row.detail ? `${row.name} (${row.detail})` : row.name));
}

const clean = (text: string | null | undefined): string | null => {
  const trimmed = (text ?? '').trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * The gym's equipment list (owner, 2026-10-23), edited in Admin → Settings
 * and read by the AI planners.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LIST NEVER FAILS A PLAN.
 *
 * `forPrompt` answers `[]` when the read throws (logged, not cached), and an
 * empty list means the planners' old behaviour — common gym basics and the
 * "never invent equipment" rule. The admin side reads strictly: a failure
 * there is a 500 the admin can see, never an empty list they might "fix".
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class GymEquipmentService {
  private readonly logger = new Logger(GymEquipmentService.name);

  private cache: { at: number; value: string[] } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<GymEquipmentItem[]> {
    const rows = await this.prisma.gymEquipment.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toItem);
  }

  /** The planners' read: phrased lines, cached, `[]` on failure. */
  async forPrompt(): Promise<string[]> {
    const now = Date.now();
    if (this.cache !== null && now - this.cache.at < CACHE_MS) return this.cache.value;
    try {
      const value = equipmentForPrompt(await this.list());
      this.cache = { at: now, value };
      return value;
    } catch (caught) {
      this.logger.error('Could not read the gym equipment — planning without it', caught as Error);
      return [];
    }
  }

  async create(input: GymEquipmentInput, actorId: string, actorRole: Role): Promise<GymEquipmentItem> {
    const name = input.name.trim();
    const detail = clean(input.detail);
    await this.assertNameFree(name);
    const { _max } = await this.prisma.gymEquipment.aggregate({ _max: { sortOrder: true } });
    const sortOrder = _max.sortOrder === null ? 0 : _max.sortOrder + 1;

    const created = await this.writeNamed(() =>
      this.prisma.gymEquipment.create({ data: { name, detail, sortOrder } }),
    );
    await this.changed(actorId, actorRole, created.id, `Added ${created.name}`, {
      change: 'ADDED',
      after: { name, detail },
    });
    return toItem(created);
  }

  async update(
    id: string,
    input: GymEquipmentInput,
    actorId: string,
    actorRole: Role,
  ): Promise<GymEquipmentItem> {
    const before = await this.prisma.gymEquipment.findUnique({ where: { id } });
    if (before === null) throw new NotFoundException('Equipment not found');
    const name = input.name.trim();
    // A PATCH that does not mention `detail` leaves it as it is; null or ""
    // clears it.
    const detailPatch = input.detail === undefined ? {} : { detail: clean(input.detail) };
    await this.assertNameFree(name, id);

    const updated = await this.writeNamed(() =>
      this.prisma.gymEquipment.update({ where: { id }, data: { name, ...detailPatch } }),
    );
    await this.changed(actorId, actorRole, id, `Edited ${updated.name}`, {
      change: 'EDITED',
      before: { name: before.name, detail: before.detail },
      after: { name, detail: updated.detail },
    });
    return toItem(updated);
  }

  async remove(id: string, actorId: string, actorRole: Role): Promise<void> {
    const before = await this.prisma.gymEquipment.findUnique({ where: { id } });
    if (before === null) throw new NotFoundException('Equipment not found');
    await this.prisma.gymEquipment.delete({ where: { id } });
    await this.changed(actorId, actorRole, id, `Removed ${before.name}`, {
      change: 'REMOVED',
      before: { name: before.name, detail: before.detail },
    });
  }

  /** `ids` is the whole list in its new order — every item exactly once. */
  async reorder(ids: string[], actorId: string, actorRole: Role): Promise<GymEquipmentItem[]> {
    const mismatch = (): DomainException =>
      new DomainException('GYM_EQUIPMENT_ORDER_MISMATCH', ORDER_MESSAGE, HttpStatus.BAD_REQUEST);

    // The check and the writes in ONE interactive transaction. `updateMany`
    // rather than `update`: an item another admin deleted after the read
    // matches nothing (count 0) instead of throwing P2025 — and the throw
    // below is the transaction's LAST statement, so it rolls back cleanly
    // rather than issuing anything on an aborted transaction (25P02).
    const current = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.gymEquipment.findMany({
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
      const known = new Set(rows.map((row) => row.id));
      if (
        new Set(ids).size !== ids.length ||
        ids.length !== rows.length ||
        ids.some((id) => !known.has(id))
      ) {
        throw mismatch();
      }
      for (const [index, id] of ids.entries()) {
        const { count } = await tx.gymEquipment.updateMany({
          where: { id },
          data: { sortOrder: index },
        });
        if (count === 0) throw mismatch();
      }
      return rows;
    });
    await this.changed(actorId, actorRole, null, `Reordered ${ids.length} items`, {
      change: 'REORDERED',
      before: current.map((row) => row.name),
      after: ids.map((id) => current.find((row) => row.id === id)?.name ?? id),
    });
    return this.list();
  }

  /** Called after every write, so the next plan sees it. */
  invalidate(): void {
    this.cache = null;
  }

  private async assertNameFree(name: string, exceptId?: string): Promise<void> {
    const clash = await this.prisma.gymEquipment.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
      },
    });
    if (clash !== null) throw this.duplicate();
  }

  /** Two admins adding the same name at once: the lower(name) index decides. */
  private async writeNamed<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (caught) {
      if (caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === 'P2002') {
        throw this.duplicate();
      }
      throw caught;
    }
  }

  private duplicate(): DomainException {
    return new DomainException('GYM_EQUIPMENT_DUPLICATE', DUPLICATE_MESSAGE, HttpStatus.CONFLICT);
  }

  private async changed(
    actorId: string,
    actorRole: Role,
    subjectId: string | null,
    subjectLabel: string,
    details: Prisma.InputJsonValue,
  ): Promise<void> {
    this.invalidate();
    await this.audit.record({
      action: 'GYM_EQUIPMENT_CHANGED',
      actorId,
      actorRole,
      subjectType: 'GymEquipment',
      subjectId,
      subjectLabel,
      details,
    });
  }
}
