import { describe, expect, it } from 'vitest';
import {
  REST_STEP_SECONDS,
  clock,
  elapsedClock,
  extendRest,
  restAnnouncement,
  restRemaining,
  startRest,
} from './restTimer';

const T0 = Date.parse('2026-09-30T10:30:00.000Z');

describe('startRest', () => {
  it('ends the rest from a timestamp, so a phone that sleeps wakes to the right number', () => {
    const rest = startRest(T0, 90, 2, 3);
    expect(rest).toEqual({ endsAt: T0 + 90_000, exerciseIndex: 2, nextSet: 3 });
    // Asleep for 70 seconds: no ticks happened, the clock is still right.
    expect(restRemaining(rest!, T0 + 70_000)).toBe(20);
  });

  it('is no rest at all when the plan prescribes none', () => {
    expect(startRest(T0, 0, 0, 1)).toBeNull();
  });
});

describe('restRemaining', () => {
  it('rounds up to whole seconds and never goes below zero', () => {
    const rest = startRest(T0, 48, 2, 2)!;
    expect(restRemaining(rest, T0)).toBe(48);
    expect(restRemaining(rest, T0 + 400)).toBe(48);
    expect(restRemaining(rest, T0 + 47_001)).toBe(1);
    expect(restRemaining(rest, T0 + 48_000)).toBe(0);
    expect(restRemaining(rest, T0 + 99_000)).toBe(0);
  });
});

describe('extendRest', () => {
  it('adds 15 s to the time left', () => {
    const rest = startRest(T0, 48, 2, 2)!;
    const longer = extendRest(rest, T0 + 10_000);
    expect(REST_STEP_SECONDS).toBe(15);
    expect(restRemaining(longer, T0 + 10_000)).toBe(53);
  });

  it('counts from now when the rest has already run out', () => {
    const rest = startRest(T0, 30, 0, 2)!;
    expect(restRemaining(extendRest(rest, T0 + 60_000), T0 + 60_000)).toBe(15);
  });
});

describe('clock and elapsedClock', () => {
  it('writes m:ss like the mockup', () => {
    expect(clock(48)).toBe('0:48');
    expect(clock(90)).toBe('1:30');
    expect(clock(0)).toBe('0:00');
  });

  it('writes the time in the workout, with hours once past sixty minutes', () => {
    expect(elapsedClock(18 * 60_000 + 42_000)).toBe('18:42');
    expect(elapsedClock(62 * 60_000 + 3_000)).toBe('1:02:03');
    expect(elapsedClock(-5_000)).toBe('0:00');
  });
});

describe('restAnnouncement', () => {
  it('speaks at the start, every 15 seconds and at zero — not every second', () => {
    expect(restAnnouncement(90, true)).toBe('Rest, 1 minute 30 seconds.');
    expect(restAnnouncement(89, false)).toBeNull();
    expect(restAnnouncement(75, false)).toBe('1 minute 15 seconds left.');
    expect(restAnnouncement(30, false)).toBe('30 seconds left.');
    expect(restAnnouncement(1, false)).toBeNull();
    expect(restAnnouncement(0, false)).toBe('Rest over. Next set.');
  });
});
