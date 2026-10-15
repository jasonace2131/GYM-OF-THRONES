import { describe, expect, it } from 'vitest';
import { layoutWeek } from './weekLayout';

const ev = (id: string, startsAt: string, endsAt: string) => ({ id, startsAt, endsAt });

describe('layoutWeek', () => {
  it('places a 6:00 PM Manila class 13 hours below a 5 AM grid top', () => {
    const layout = layoutWeek([ev('a', '2026-09-16T10:00:00.000Z', '2026-09-16T11:00:00.000Z')], [
      '2026-09-16',
    ]);
    expect(layout.startHour).toBe(5);
    expect(layout.endHour).toBe(22);
    expect(layout.days[0]!.events[0]).toMatchObject({ topMin: 780, heightMin: 60, lane: 0, lanes: 1 });
  });

  it('files a 6:00 AM Manila class under the Manila day, not the UTC day', () => {
    // 22:00Z on the 9th is 6:00 AM on the 10th in Manila.
    const layout = layoutWeek(
      [ev('a', '2026-09-09T22:00:00.000Z', '2026-09-09T23:00:00.000Z')],
      ['2026-09-09', '2026-09-10'],
    );
    expect(layout.days[0]!.events).toHaveLength(0);
    expect(layout.days[1]!.events[0]).toMatchObject({ topMin: 60 });
  });

  it('extends the grid for a class before 5 AM or ending after 10 PM', () => {
    const layout = layoutWeek(
      [
        ev('early', '2026-09-15T20:30:00.000Z', '2026-09-15T21:30:00.000Z'), // 4:30-5:30 AM on the 16th
        ev('late', '2026-09-16T13:30:00.000Z', '2026-09-16T14:30:00.000Z'), // 9:30-10:30 PM
      ],
      ['2026-09-16'],
    );
    expect(layout.startHour).toBe(4);
    expect(layout.endHour).toBe(23);
    expect(layout.days[0]!.events.find((p) => p.event.id === 'early')).toMatchObject({ topMin: 30 });
  });

  it('puts overlapping classes side by side and a later one back in the first lane', () => {
    const layout = layoutWeek(
      [
        ev('a', '2026-09-16T10:00:00.000Z', '2026-09-16T11:00:00.000Z'), // 6-7 PM
        ev('b', '2026-09-16T10:30:00.000Z', '2026-09-16T11:30:00.000Z'), // 6:30-7:30 PM
        ev('c', '2026-09-16T12:00:00.000Z', '2026-09-16T13:00:00.000Z'), // 8-9 PM
      ],
      ['2026-09-16'],
    );
    const byId = Object.fromEntries(layout.days[0]!.events.map((p) => [p.event.id, p]));
    expect(byId.a).toMatchObject({ lane: 0, lanes: 2 });
    expect(byId.b).toMatchObject({ lane: 1, lanes: 2 });
    expect(byId.c).toMatchObject({ lane: 0, lanes: 1 });
  });

  it('ignores classes outside the requested days', () => {
    const layout = layoutWeek([ev('a', '2026-09-20T10:00:00.000Z', '2026-09-20T11:00:00.000Z')], [
      '2026-09-16',
    ]);
    expect(layout.days[0]!.events).toHaveLength(0);
  });
});
