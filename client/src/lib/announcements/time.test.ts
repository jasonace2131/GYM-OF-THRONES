import { describe, expect, it } from 'vitest';
import { absoluteTime, relativeTime } from './time';
import { at } from '@/lib/schedule/fixtures';

const iso = (day: string, hhmm: string): string => at(day, hhmm).toISOString();

describe('relativeTime', () => {
  // Thursday 24 September 2026, noon in Manila.
  const now = at('2026-09-24', '12:00');

  it('says "Just now" under a minute', () => {
    expect(relativeTime(new Date(now.getTime() - 59_999).toISOString(), now)).toBe('Just now');
    expect(relativeTime(now.toISOString(), now)).toBe('Just now');
    expect(relativeTime(iso('2026-09-24', '11:59'), now)).toBe('1 min ago');
  });

  /** A notice stamped a little ahead of a slow phone clock is still "now", never "in 2 min". */
  it('says "Just now" for a future timestamp', () => {
    expect(relativeTime(iso('2026-09-24', '12:05'), now)).toBe('Just now');
  });

  it('counts minutes under an hour', () => {
    expect(relativeTime(iso('2026-09-24', '11:55'), now)).toBe('5 min ago');
    expect(relativeTime(iso('2026-09-24', '11:01'), now)).toBe('59 min ago');
  });

  it('counts hours on the same gym day', () => {
    expect(relativeTime(iso('2026-09-24', '11:00'), now)).toBe('1 hr ago');
    expect(relativeTime(iso('2026-09-24', '09:00'), now)).toBe('3 hr ago');
    expect(relativeTime(iso('2026-09-24', '00:05'), now)).toBe('11 hr ago');
  });

  it('says "Yesterday" for the previous gym day', () => {
    expect(relativeTime(iso('2026-09-23', '18:00'), now)).toBe('Yesterday');
    expect(relativeTime(iso('2026-09-23', '00:01'), now)).toBe('Yesterday');
  });

  it('names the weekday within the last week', () => {
    expect(relativeTime(iso('2026-09-21', '08:00'), now)).toBe('Mon');
    expect(relativeTime(iso('2026-09-18', '08:00'), now)).toBe('Fri');
  });

  it('gives the date from a week back', () => {
    expect(relativeTime(iso('2026-09-17', '08:00'), now)).toBe('17 Sep');
    expect(relativeTime(iso('2026-01-02', '08:00'), now)).toBe('2 Jan');
  });

  it('adds the year for a notice from another year', () => {
    expect(relativeTime(iso('2025-09-16', '08:00'), now)).toBe('16 Sep 2025');
  });

  /**
   * Days are MANILA days. 01:00 on the 24th in Manila is 17:00 on the 23rd in
   * UTC — a UTC calendar would call it "Yesterday" at 9 AM.
   */
  it('reads the day in Manila, not UTC', () => {
    expect(relativeTime(iso('2026-09-24', '01:00'), at('2026-09-24', '09:00'))).toBe('8 hr ago');
  });

  it('says "Yesterday" across Manila midnight, once past the minutes window', () => {
    const justAfterMidnight = at('2026-09-24', '00:30');
    expect(relativeTime(iso('2026-09-23', '23:50'), justAfterMidnight)).toBe('40 min ago');
    expect(relativeTime(iso('2026-09-23', '22:00'), justAfterMidnight)).toBe('Yesterday');
  });

  it('reads the year in Manila too', () => {
    // 01:00 on 1 Jan 2026 in Manila is still 31 Dec 2025 in UTC.
    expect(relativeTime(iso('2026-01-01', '01:00'), now)).toBe('1 Jan');
  });
});

describe('absoluteTime', () => {
  it('is the full gym-local date and time', () => {
    expect(absoluteTime(iso('2026-09-24', '07:05'))).toBe('Thu 24 Sep 2026, 7:05 AM');
    expect(absoluteTime(iso('2026-01-01', '00:30'))).toBe('Thu 1 Jan 2026, 12:30 AM');
  });
});
