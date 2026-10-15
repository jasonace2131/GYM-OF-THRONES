import { describe, expect, it } from 'vitest';
import { hoursChanges } from './openingHoursChanges';

const week = (overrides: Record<number, Partial<{ opensAt: string; closesAt: string; isClosed: boolean }>> = {}) =>
  Array.from({ length: 7 }, (_, dayOfWeek) => ({
    dayOfWeek,
    opensAt: '05:00',
    closesAt: '22:00',
    isClosed: false,
    ...overrides[dayOfWeek],
  }));

describe('hoursChanges', () => {
  it('lists nothing when nothing moved', () => {
    expect(hoursChanges(week(), week())).toEqual([]);
  });

  it('states a changed day before and after, in 12-hour time', () => {
    expect(hoursChanges(week(), week({ 1: { opensAt: '06:00' } }))).toEqual([
      'Monday: 5:00 AM – 10:00 PM → 6:00 AM – 10:00 PM',
    ]);
  });

  it('says a day is now closed, or open again, in words', () => {
    expect(hoursChanges(week(), week({ 0: { isClosed: true } }))).toEqual([
      'Sunday: 5:00 AM – 10:00 PM → closed all day',
    ]);
    expect(hoursChanges(week({ 0: { isClosed: true } }), week())).toEqual([
      'Sunday: closed all day → 5:00 AM – 10:00 PM',
    ]);
  });

  it('ignores times edited on a day that stays closed — the door reads nothing from them', () => {
    expect(
      hoursChanges(week({ 6: { isClosed: true } }), week({ 6: { isClosed: true, opensAt: '09:00' } })),
    ).toEqual([]);
  });

  it('keeps week order, Sunday first, whatever order the rows arrive in', () => {
    const after = week({ 3: { closesAt: '21:00' }, 0: { closesAt: '20:00' } }).reverse();
    expect(hoursChanges(week(), after)).toEqual([
      'Sunday: 5:00 AM – 10:00 PM → 5:00 AM – 8:00 PM',
      'Wednesday: 5:00 AM – 10:00 PM → 5:00 AM – 9:00 PM',
    ]);
  });

  it('describes a day with no stored row as new', () => {
    expect(hoursChanges(week().slice(1), week())).toEqual(['Sunday: set to 5:00 AM – 10:00 PM']);
  });
});
