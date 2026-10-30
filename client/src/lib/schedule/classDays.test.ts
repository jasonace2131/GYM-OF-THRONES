import { describe, expect, it } from 'vitest';
import { at, session } from './fixtures';
import { dayRange } from './gymClock';
import { classCountLabel, classCountsByDay, nextClassDay, openingDay } from './classDays';

/**
 * Finding future classes on the member's timetable (gym report, 2026-10-30).
 * The window is Mon 14 Sep 2026 and the thirteen days after it.
 */

const TODAY = '2026-09-14';
const DAYS = dayRange(TODAY, 14);

/** A class on `day` at `hhmm` Manila, one hour. */
const classAt = (id: string, day: string, hhmm: string, cancelled = false) =>
  session({
    id,
    businessDate: day,
    startsAt: at(day, hhmm).toISOString(),
    endsAt: new Date(at(day, hhmm).getTime() + 3_600_000).toISOString(),
    cancelledAt: cancelled ? at(TODAY, '08:00').toISOString() : null,
  });

describe('classCountsByDay', () => {
  it('counts the classes on each day, leaving cancelled ones out', () => {
    const counts = classCountsByDay([
      classAt('a', '2026-09-14', '07:00'),
      classAt('b', '2026-09-17', '07:00'),
      classAt('c', '2026-09-17', '18:00'),
      classAt('d', '2026-09-18', '18:00', true),
    ]);
    expect([...counts]).toEqual([
      ['2026-09-14', 1],
      ['2026-09-17', 2],
    ]);
  });

  it('says how many in words a screen reader can speak', () => {
    expect([0, 1, 3].map(classCountLabel)).toEqual(['no classes', '1 class', '3 classes']);
  });
});

describe('openingDay', () => {
  it('opens on today while today has a class still to come', () => {
    const sessions = [classAt('a', TODAY, '18:00'), classAt('b', '2026-09-16', '07:00')];
    expect(openingDay(DAYS, sessions, TODAY, at(TODAY, '10:00'))).toBe(TODAY);
  });

  it("opens on the next day with a class once today's have all started", () => {
    const sessions = [classAt('a', TODAY, '07:00'), classAt('b', '2026-09-17', '07:00')];
    expect(openingDay(DAYS, sessions, TODAY, at(TODAY, '10:00'))).toBe('2026-09-17');
  });

  it('skips a day whose only class is cancelled, today included', () => {
    const sessions = [
      classAt('a', TODAY, '18:00', true),
      classAt('b', '2026-09-15', '18:00', true),
      classAt('c', '2026-09-19', '09:00'),
    ];
    expect(openingDay(DAYS, sessions, TODAY, at(TODAY, '10:00'))).toBe('2026-09-19');
  });

  it('stays on today when nothing in the window is still to come', () => {
    expect(openingDay(DAYS, [classAt('a', TODAY, '07:00')], TODAY, at(TODAY, '10:00'))).toBe(TODAY);
    expect(openingDay(DAYS, [], TODAY, at(TODAY, '10:00'))).toBe(TODAY);
  });

  it('never opens outside the window', () => {
    const sessions = [classAt('a', '2026-09-30', '07:00')];
    expect(openingDay(DAYS, sessions, TODAY, at(TODAY, '10:00'))).toBe(TODAY);
  });
});

describe('nextClassDay', () => {
  const sessions = [
    classAt('a', TODAY, '18:00'),
    classAt('b', '2026-09-16', '07:00', true),
    classAt('c', '2026-09-18', '07:00'),
    classAt('d', '2026-09-24', '07:00'),
  ];
  const now = at(TODAY, '10:00');

  it('finds the first later day with a class, passing over cancelled ones', () => {
    expect(nextClassDay(DAYS, sessions, '2026-09-15', now)).toBe('2026-09-18');
    expect(nextClassDay(DAYS, sessions, '2026-09-18', now)).toBe('2026-09-24');
  });

  it('only looks forward, and only inside the window', () => {
    expect(nextClassDay(DAYS, sessions, '2026-09-24', now)).toBeNull();
    expect(nextClassDay(DAYS.slice(0, 7), sessions, '2026-09-19', now)).toBeNull();
  });
});
