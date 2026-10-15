import type { MyBookingWire, MyCheckInSummary } from '@got/shared';
import { formatCivilDate } from '@/lib/gymTime';
import type { ProgressSummary } from '@/lib/progress/types';
import { gymClock12 } from '@/lib/schedule/gymClock';
import type { GymFacts } from './intake';
import { WEEKDAY_LONG } from './labels';
import { weekdayOf } from './today';

/**
 * The gym-held facts behind the "use what the gym knows" switches, phrased
 * for the About step's detail lines. This is what the member is deciding
 * whether to share, so it is spelled out; the server rebuilds the same
 * facts from its own reads and never receives these strings.
 */

function kg(grams: number): string {
  return `${(grams / 1000).toFixed(1).replace(/\.0$/, '')} kg`;
}

function cm(mm: number): string {
  return `${(mm / 10).toFixed(1).replace(/\.0$/, '')} cm`;
}

function measurementsFact(progress: ProgressSummary | null): string | null {
  if (progress === null) return null;
  const latest = [...progress.measurements].sort((a, b) =>
    b.businessDate.localeCompare(a.businessDate),
  )[0];
  if (latest === undefined) return null;
  const parts: string[] = [];
  if (latest.weightGrams !== null) parts.push(kg(latest.weightGrams));
  if (latest.heightMm !== null) parts.push(cm(latest.heightMm));
  if (parts.length === 0) return null;
  const by =
    latest.recordedBy === null || latest.recordedBy === undefined
      ? 'recorded'
      : `recorded by Coach ${latest.recordedBy.firstName}`;
  return `${parts.join(' · ')}, ${by} on ${formatCivilDate(latest.businessDate)}`;
}

function attendanceFact(summary: MyCheckInSummary | null): string | null {
  if (summary === null || summary.avgPerWeek <= 0) return null;
  const avg = Number.isInteger(summary.avgPerWeek)
    ? String(summary.avgPerWeek)
    : summary.avgPerWeek.toFixed(1);
  return `${avg} ${avg === '1' ? 'visit' : 'visits'} a week on average`;
}

function liveBooked(bookings: readonly MyBookingWire[]): MyBookingWire[] {
  return bookings
    .filter((b) => b.status === 'BOOKED' && b.session.cancelledAt === null)
    .sort((a, b) => a.session.startsAt.localeCompare(b.session.startsAt));
}

/** "Spin · Tuesdays 6:00 PM" — one per distinct class, weekday-plural. */
function bookingsFact(bookings: readonly MyBookingWire[]): string | null {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const b of liveBooked(bookings)) {
    const day = WEEKDAY_LONG[weekdayOf(b.session.businessDate)] ?? '';
    const line = `${b.session.title} · ${day}s ${gymClock12(b.session.startsAt)}`;
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  }
  return lines.length === 0 ? null : lines.join(', ');
}

export function gymFacts(
  progress: ProgressSummary | null,
  checkIns: MyCheckInSummary | null,
  bookings: readonly MyBookingWire[],
): GymFacts {
  return {
    measurements: measurementsFact(progress),
    attendance: attendanceFact(checkIns),
    bookings: bookingsFact(bookings),
  };
}

/** The week step's blue hint: "Spin on Tuesdays at 6:00 PM". */
export function bookingHint(bookings: readonly MyBookingWire[]): string | null {
  const first = liveBooked(bookings)[0];
  if (first === undefined) return null;
  const day = WEEKDAY_LONG[weekdayOf(first.session.businessDate)] ?? '';
  return `${first.session.title} on ${day}s at ${gymClock12(first.session.startsAt)}`;
}
