import { describe, expect, it } from 'vitest';
import type { WorkoutAiQuotaView } from '@got/shared';
import {
  canSpend,
  generateNote,
  limitNotice,
  quotaMeter,
  quotaPill,
  quotaResetLabel,
  quotaShort,
} from './quota';

// 2026-09-30T16:00:00Z is midnight on Oct 1 in Manila.
const q = (used: number, resetsAt = '2026-09-30T16:00:00.000Z'): WorkoutAiQuotaView => ({
  used,
  limit: 8,
  remaining: 8 - used,
  resetsAt,
});

describe('quota copy', () => {
  it('reads "5 of 8 AI actions left today" in the pill and "5 left" on a phone', () => {
    expect(quotaPill(q(3))).toBe('5 of 8 AI actions left today');
    expect(quotaShort(q(3))).toBe('5 left');
    expect(quotaPill(q(8))).toBe('No AI actions left today');
    expect(quotaShort(q(8))).toBe('0 left');
    expect(quotaPill(q(7))).toBe('1 of 8 AI actions left today');
  });

  it('draws 8 segments, the used ones first and grey', () => {
    expect(quotaMeter(q(3))).toEqual([false, false, false, true, true, true, true, true]);
    expect(quotaMeter(q(0)).every(Boolean)).toBe(true);
    expect(quotaMeter(q(8)).some(Boolean)).toBe(false);
  });

  it('says "Resets at midnight" for a gym-midnight reset, else the gym time', () => {
    expect(quotaResetLabel(q(3))).toBe('Resets at midnight');
    expect(quotaResetLabel(q(3, '2026-09-30T22:30:00.000Z'))).toBe('Resets at 6:30 AM');
  });

  it('tells the wizard what Generate will cost', () => {
    expect(generateNote(q(3))).toBe('Uses 1 of your 5 AI actions left today');
    expect(generateNote(q(7))).toBe('Uses your last AI action for today');
    expect(generateNote(q(8))).toBe('No AI actions left today — they reset at midnight');
  });

  it('knows when nothing can be spent', () => {
    expect(canSpend(q(7))).toBe(true);
    expect(canSpend(q(8))).toBe(false);
  });

  it('writes the 429 notice with the reset time, from the server line when it has one', () => {
    expect(limitNotice(q(8), null)).toBe(
      'You have used all 8 AI actions for today. They reset at midnight.',
    );
    expect(limitNotice(q(8), 'Daily AI limit reached.')).toBe(
      'Daily AI limit reached. They reset at midnight.',
    );
  });
});
