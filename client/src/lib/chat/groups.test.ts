import { describe, expect, it } from 'vitest';
import type { TimelineItem } from './chatState';
import { dayLabel, groupTimeline } from './groups';

const TZ = 'Asia/Manila';
// 2026-10-06 21:00 in Manila.
const NOW = new Date('2026-10-06T13:00:00.000Z');

function msg(id: string, iso: string, mine: boolean): TimelineItem {
  return {
    kind: 'message',
    mine,
    message: {
      id,
      threadId: 't1',
      senderId: mine ? 'me' : 'them',
      body: id,
      createdAt: iso,
      editedAt: null,
      deletedAt: null,
    },
  };
}

const shape = (rows: ReturnType<typeof groupTimeline>) =>
  rows.map((r) =>
    r.kind === 'day' ? `[${r.label}]` : `${r.key}:${r.first ? 'F' : '-'}${r.last ? 'L' : '-'}`,
  );

describe('groupTimeline', () => {
  it('runs one sender inside five minutes together, with the time on the last', () => {
    const rows = groupTimeline(
      [
        msg('a', '2026-10-06T12:00:00.000Z', false),
        msg('b', '2026-10-06T12:02:00.000Z', false),
        msg('c', '2026-10-06T12:04:59.000Z', false),
        msg('d', '2026-10-06T12:05:30.000Z', true),
      ],
      NOW,
      TZ,
    );
    expect(shape(rows)).toEqual(['[Today]', 'a:F-', 'b:--', 'c:-L', 'd:FL']);
  });

  it('breaks a run after a gap longer than five minutes', () => {
    const rows = groupTimeline(
      [msg('a', '2026-10-06T12:00:00.000Z', true), msg('b', '2026-10-06T12:06:01.000Z', true)],
      NOW,
      TZ,
    );
    expect(shape(rows)).toEqual(['[Today]', 'a:FL', 'b:FL']);
  });

  it("starts a new day at the gym's midnight, not UTC's", () => {
    // 15:59Z is 23:59 on the 5th in Manila; 16:01Z is 00:01 on the 6th.
    const rows = groupTimeline(
      [msg('a', '2026-10-05T15:59:00.000Z', true), msg('b', '2026-10-05T16:01:00.000Z', true)],
      NOW,
      TZ,
    );
    expect(shape(rows)).toEqual(['[Yesterday]', 'a:FL', '[Today]', 'b:FL']);
  });

  it('treats a message still sending as mine', () => {
    const rows = groupTimeline(
      [
        msg('a', '2026-10-06T12:00:00.000Z', true),
        {
          kind: 'pending',
          pending: {
            clientId: 'p1',
            threadId: 't1',
            body: 'hi',
            createdAt: '2026-10-06T12:01:00.000Z',
          },
        },
      ],
      NOW,
      TZ,
    );
    expect(shape(rows)).toEqual(['[Today]', 'a:F-', 'p1:-L']);
  });
});

describe('dayLabel', () => {
  it('names older days by weekday and date, and adds the year only when it differs', () => {
    expect(dayLabel('2026-10-01T04:00:00.000Z', NOW, TZ)).toBe('Thu 1 Oct');
    expect(dayLabel('2025-12-31T04:00:00.000Z', NOW, TZ)).toBe('Wed 31 Dec 2025');
  });
});
