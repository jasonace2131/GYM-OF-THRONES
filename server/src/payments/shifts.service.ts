import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainException } from '../common/exceptions/domain.exception';
import { mapPrismaError } from '../common/exceptions/prisma-error.mapper';
import { gymToday, toDateColumn } from '../common/time/gym-time';
import { GymConfigService } from '../config/gym.config';
import { PrismaService } from '../prisma/prisma.service';
import { toShiftClosure, toShiftView, type ShiftClosure, type ShiftView } from './shift.presenter';
import type { CloseShiftDto, OpenShiftDto } from './dto/shift.dto';

/**
 * The literal the nullable-unique sentinel holds while a drawer is open.
 *
 * `Shift.openMarker String? @unique` plus the `Shift_open_marker` CHECK
 * (`("status" = 'OPEN') = ("openMarker" IS NOT NULL)`) is how "at most one open
 * drawer" is enforced by the database rather than by the UI. It is a real
 * unique index Prisma owns and declares, so a later `migrate dev` will never
 * emit a DROP for it — which is exactly what a partial unique index would have
 * risked (R3).
 */
export const OPEN_MARKER = 'OPEN';

export interface ShiftClosureFigures {
  expectedCentavos: number;
  varianceCentavos: number;
}

/**
 * §5.7.6's arithmetic, pure. `expected = openingFloat + SUM(net)` over RECORDED
 * CASH payments in the shift; `variance = counted − expected`, signed, so a
 * short drawer is negative and a long one positive.
 *
 * GCash is excluded from the expectation because no GCash peso is ever in the
 * box: it is reconciled against the statement by `GET /reports/gcash`.
 */
export function computeClosure(
  openingFloatCentavos: number,
  cashRecordedCentavos: number,
  countedCentavos: number,
): ShiftClosureFigures {
  const expectedCentavos = openingFloatCentavos + cashRecordedCentavos;
  return { expectedCentavos, varianceCentavos: countedCentavos - expectedCentavos };
}

/** Beyond ±SHIFT_VARIANCE_NOTE_THRESHOLD_CENTAVOS the closer must explain it. */
export function assertVarianceExplained(
  figures: ShiftClosureFigures,
  note: string | undefined,
  thresholdCentavos: number,
): void {
  if (Math.abs(figures.varianceCentavos) <= thresholdCentavos) return;
  if (note !== undefined && note.trim().length >= 3) return;

  throw new DomainException(
    'SHIFT_VARIANCE_REASON_REQUIRED',
    `The count is off by ${figures.varianceCentavos} centavos. A difference beyond ` +
      `${thresholdCentavos} centavos needs a written note before the drawer can close.`,
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

/**
 * One cash-drawer session. Roughly ₱12,450/day crosses this counter, mostly in
 * cash, with two or three staff rotating through one drawer — so "is the money
 * in the box equal to what the system says" is the question this model exists
 * to answer, and the reason the owner will or will not trust any revenue figure
 * this system produces.
 */
@Injectable()
export class ShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
  ) {}

  /** Route 38. */
  async open(actorId: string, dto: OpenShiftDto): Promise<ShiftView> {
    const businessDate = gymToday(new Date(), this.gym.timeZone);

    try {
      const row = await this.prisma.shift.create({
        data: {
          openedById: actorId,
          openedAt: new Date(),
          openingFloatCentavos: dto.openingFloatCentavos,
          businessDate: toDateColumn(businessDate),
          openMarker: OPEN_MARKER,
        },
      });
      return toShiftView(row);
    } catch (error) {
      // Caught OUTSIDE any transaction — nothing further runs on a `tx` here,
      // so the 25P02 rule is not in play. Two staffers tapping "open drawer" at
      // once both insert; the sentinel's unique index lets exactly one win.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DomainException(
          'SHIFT_ALREADY_OPEN',
          'A drawer is already open. Close it before opening another.',
          HttpStatus.CONFLICT,
        );
      }
      const mapped = mapPrismaError(error);
      if (mapped) throw mapped;
      throw error;
    }
  }

  /** Route 40. Null is a normal answer — the gym is shut, or nobody has opened yet. */
  async current(): Promise<ShiftView | null> {
    const row = await this.prisma.shift.findUnique({ where: { openMarker: OPEN_MARKER } });
    return row ? toShiftView(row) : null;
  }

  /**
   * Route 39, the blind close.
   *
   * The count arrives in the request; the expectation is computed here and
   * disclosed only in the response. The whole sequence runs in one transaction
   * so the SUM cannot move between being read and being stored, and the write
   * is a CONDITIONAL update its own effect falsifies — `WHERE id = :id AND
   * status = 'OPEN'` reports count 0 rather than closing a drawer twice, and
   * reports it without aborting the transaction.
   */
  async close(actorId: string, id: string, dto: CloseShiftDto): Promise<ShiftClosure> {
    return this.prisma.$transaction(async (tx) => {
      const shift = await tx.shift.findUnique({ where: { id } });
      if (!shift) throw new NotFoundException('Shift not found');
      if (shift.status === 'CLOSED') {
        throw new DomainException(
          'SHIFT_ALREADY_CLOSED',
          'That drawer was already closed.',
          HttpStatus.CONFLICT,
        );
      }

      const cash = await tx.payment.aggregate({
        _sum: { netCentavos: true },
        where: { shiftId: id, status: 'RECORDED', method: 'CASH' },
      });
      const figures = computeClosure(
        shift.openingFloatCentavos,
        cash._sum.netCentavos ?? 0,
        dto.countedCentavos,
      );
      assertVarianceExplained(figures, dto.note, this.gym.shiftVarianceNoteThresholdCentavos);

      const { count } = await tx.shift.updateMany({
        where: { id, status: 'OPEN' },
        data: {
          status: 'CLOSED',
          closedById: actorId,
          closedAt: new Date(),
          countedCentavos: dto.countedCentavos,
          expectedCentavos: figures.expectedCentavos,
          varianceCentavos: figures.varianceCentavos,
          // Releases the sentinel. The Shift_open_marker CHECK requires this to
          // move in lockstep with `status`, so the two cannot disagree.
          openMarker: null,
          ...(dto.note === undefined ? {} : { note: dto.note }),
        },
      });
      if (count === 0) {
        throw new DomainException(
          'SHIFT_ALREADY_CLOSED',
          'That drawer was closed by someone else while you were counting.',
          HttpStatus.CONFLICT,
        );
      }

      const closed = await tx.shift.findUniqueOrThrow({ where: { id } });
      return toShiftClosure(closed, figures.expectedCentavos, figures.varianceCentavos);
    });
  }

  /**
   * The single source of SHIFT_NOT_OPEN.
   *
   * `Payment.shiftId` is NOT NULL and stays that way: an unattributed payment
   * cannot be reconciled, which is the entire point of the model. Attendance
   * without a drawer is reconcilable later; money without a drawer is not, so
   * only money hard-fails here — `POST /checkin` never calls this.
   *
   * Takes the transaction client so the drawer cannot be closed between this
   * check and the Payment insert that follows it, and resolves through the
   * unique sentinel so there is no "which open shift" ordering ambiguity.
   */
  async requireOpenShiftId(tx: Prisma.TransactionClient): Promise<string> {
    const open = await tx.shift.findUnique({
      where: { openMarker: OPEN_MARKER },
      select: { id: true },
    });
    if (!open) {
      throw new DomainException(
        'SHIFT_NOT_OPEN',
        'No cash drawer is open. Open a shift before recording money.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return open.id;
  }
}
