import type { Shift, ShiftStatus } from '@prisma/client';
import { civilDateFromPrisma } from '../common/time/gym-time';

/**
 * A drawer session as the console sees it.
 *
 * `expectedCentavos` and `varianceCentavos` are deliberately ABSENT from this
 * interface, not merely nullable. §5.7.6: the physical count is submitted
 * BEFORE the expected figure is revealed, because a visible expected total gets
 * back-fitted every single time. Making the field unrepresentable here means
 * there is no route, no query parameter and no accidental spread that can leak
 * it — the only producer is `toShiftClosure`, and the only caller of that is
 * the close handler, which runs after the count has been recorded.
 *
 * `businessDate` is a @db.Date and travels as a yyyy-mm-dd civil date;
 * `openedAt` / `closedAt` are @db.Timestamptz(3) and travel as full ISO-8601
 * instants. Two kinds of temporal value, two wire shapes (R2).
 */
export interface ShiftView {
  id: string;
  status: ShiftStatus;
  businessDate: string;
  openedById: string;
  openedAt: string;
  openingFloatCentavos: number;
  closedById: string | null;
  closedAt: string | null;
  countedCentavos: number | null;
  note: string | null;
}

/** The close response, and the only shape that carries the expected figure. */
export interface ShiftClosure extends ShiftView {
  expectedCentavos: number;
  varianceCentavos: number;
}

export function toShiftView(row: Shift): ShiftView {
  return {
    id: row.id,
    status: row.status,
    businessDate: civilDateFromPrisma(row.businessDate),
    openedById: row.openedById,
    openedAt: row.openedAt.toISOString(),
    openingFloatCentavos: row.openingFloatCentavos,
    closedById: row.closedById,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    countedCentavos: row.countedCentavos,
    note: row.note,
  };
}

/**
 * Takes the two figures as arguments rather than reading the (nullable) columns
 * off the row: the caller has just computed them and knows they are settled,
 * whereas `row.expectedCentavos` is `number | null` and would need a `?? 0`
 * that could silently report a ₱0 expectation as a real one.
 */
export function toShiftClosure(
  row: Shift,
  expectedCentavos: number,
  varianceCentavos: number,
): ShiftClosure {
  return { ...toShiftView(row), expectedCentavos, varianceCentavos };
}
