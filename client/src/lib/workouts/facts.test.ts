import { describe, expect, it } from 'vitest';
import type { ProgressSummary } from '@/lib/progress/types';
import { bookingHint, gymFacts } from './facts';
import { CHECKINS, SPIN } from './fixtures';

const PROGRESS: ProgressSummary = {
  measurements: [
    {
      id: 'm1',
      businessDate: '2026-09-20',
      weightGrams: 68_000,
      heightMm: 1650,
      bodyFatPermille: null,
      notes: null,
      recordedBy: { firstName: 'Ana' },
    },
  ],
  goals: [],
  latestWeightGrams: 68_000,
  changeGrams: null,
  changeOverDays: null,
  bmiThousandths: 24_980,
};

describe('gymFacts', () => {
  it('phrases measurements, attendance and bookings the way the switches show them', () => {
    expect(gymFacts(PROGRESS, CHECKINS, [SPIN])).toEqual({
      measurements: '68 kg · 165 cm, recorded by Coach Ana on 20 Sep 2026',
      attendance: '2.1 visits a week on average',
      bookings: 'Spin · Tuesdays 6:00 PM',
    });
  });

  it('is null for anything the gym does not have', () => {
    expect(gymFacts(null, null, [])).toEqual({
      measurements: null,
      attendance: null,
      bookings: null,
    });
    expect(
      gymFacts({ ...PROGRESS, measurements: [] }, { ...CHECKINS, avgPerWeek: 0 }, []).attendance,
    ).toBeNull();
  });

  it('shows weight alone when no height was recorded, and self-recorded without a coach', () => {
    const selfOnly = {
      ...PROGRESS,
      measurements: [{ ...PROGRESS.measurements[0]!, heightMm: null, recordedBy: null }],
    };
    expect(gymFacts(selfOnly, null, []).measurements).toBe('68 kg, recorded on 20 Sep 2026');
  });
});

describe('bookingHint', () => {
  it('reads "Spin on Tuesdays at 6:00 PM" for the week step', () => {
    expect(bookingHint([SPIN])).toBe('Spin on Tuesdays at 6:00 PM');
    expect(bookingHint([])).toBeNull();
    expect(bookingHint([SPIN, { ...SPIN, status: 'WAITLISTED' }])).toBe(
      'Spin on Tuesdays at 6:00 PM',
    );
  });
});
