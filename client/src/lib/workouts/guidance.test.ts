import { describe, expect, it } from 'vitest';
import { asCivilDate } from '@/lib/gymTime';
import { dayOfYear, tipOfTheDay } from './guidance';

const TIPS = [
  { title: 'Sleep', body: '7–9 hours.' },
  { title: 'Protein', body: 'Some at every meal.' },
  { title: 'Water', body: 'Drink before, during and after.' },
  { title: 'Rest days', body: 'A short walk helps.' },
];

describe('dayOfYear', () => {
  it('counts from 1 on January 1st, with no time zone involved', () => {
    expect(dayOfYear(asCivilDate('2026-01-01'))).toBe(1);
    expect(dayOfYear(asCivilDate('2026-09-30'))).toBe(273);
    expect(dayOfYear(asCivilDate('2024-12-31'))).toBe(366);
  });
});

describe('tipOfTheDay', () => {
  it('picks guidance[dayOfYear % length], so the tip changes daily and repeats predictably', () => {
    expect(tipOfTheDay(TIPS, asCivilDate('2026-09-30'))).toBe(TIPS[273 % 4]);
    expect(tipOfTheDay(TIPS, asCivilDate('2026-10-01'))).toBe(TIPS[274 % 4]);
  });

  it('is null with no guidance to show', () => {
    expect(tipOfTheDay([], asCivilDate('2026-09-30'))).toBeNull();
  });
});
