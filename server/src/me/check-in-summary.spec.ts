import { asCivilDate, addDays, type CivilDate } from '../common/time/gym-time';
import { HEATMAP_WEEKS, summariseCheckIns } from './check-in-summary';

const TODAY = asCivilDate('2026-08-20');
/** n days before today, as a CivilDate. */
const ago = (days: number): CivilDate => addDays(TODAY, -days);

describe('summariseCheckIns', () => {
  it('is all zeroes for a member who has never been in', () => {
    expect(summariseCheckIns([], TODAY)).toEqual({
      thisMonth: 0,
      allTime: 0,
      avgPerWeek: 0,
      currentStreakWeeks: 0,
      longestStreakWeeks: 0,
      days: [],
    });
  });

  it('counts two visits on one day as two, on one square', () => {
    const summary = summariseCheckIns([ago(1), ago(1), ago(3)], TODAY);
    expect(summary.allTime).toBe(3);
    expect(summary.days).toHaveLength(2);
    expect(summary.days.find((d) => d.date === ago(1))?.count).toBe(2);
  });

  it('returns days oldest-first, which is how a heatmap reads', () => {
    const summary = summariseCheckIns([ago(1), ago(30), ago(10)], TODAY);
    expect(summary.days.map((d) => d.date)).toEqual([ago(30), ago(10), ago(1)]);
  });

  /**
   * BUSINESS DATES, NOT TIMESTAMPS. Bucketing on `occurredAt` would put every
   * visit before 08:00 Manila on the previous day — and the gym opens at
   * 05:00, so that is the busiest hour of the morning in the wrong square.
   */
  it('counts the current month by gym-local civil date', () => {
    const summary = summariseCheckIns(
      [asCivilDate('2026-08-01'), asCivilDate('2026-08-20'), asCivilDate('2026-07-31')],
      TODAY,
    );
    expect(summary.thisMonth).toBe(2);
    expect(summary.allTime).toBe(3);
  });

  it('excludes days outside the heatmap window from the squares but not from all-time', () => {
    const old = addDays(TODAY, -(HEATMAP_WEEKS * 7 + 5));
    const summary = summariseCheckIns([old, ago(2)], TODAY);

    expect(summary.allTime).toBe(2);
    expect(summary.days.map((d) => d.date)).toEqual([ago(2)]);
  });

  /**
   * Averaged over the WINDOW, not over all time: a member who trained hard two
   * years ago and stopped must not read as "3.4 per week" today.
   */
  it('averages over the window', () => {
    // 26 visits across the window = exactly 1.0 per week.
    const visits = Array.from({ length: HEATMAP_WEEKS }, (_v, i) => ago(i * 7));
    expect(summariseCheckIns(visits, TODAY).avgPerWeek).toBe(1);
  });

  describe('the streak, which is weekly and not daily', () => {
    /**
     * A daily streak punishes a rest day, which is exactly the behaviour a gym
     * does NOT want. A weekly streak rewards the habit that matters.
     */
    it('does not break for a rest day', () => {
      // One visit this week, one last week, one the week before.
      const summary = summariseCheckIns([ago(0), ago(8), ago(15)], TODAY);
      expect(summary.currentStreakWeeks).toBe(3);
    });

    /**
     * THE CURRENT WEEK IS FORGIVEN. It is Monday morning; telling a member
     * they lost a twelve-week run because they have not been in since Friday
     * is both wrong and the kind of thing that makes people stop opening the
     * app.
     */
    it('survives a current week with no visit yet', () => {
      // Nothing this week; visits in each of the three before it.
      const summary = summariseCheckIns([ago(8), ago(15), ago(22)], TODAY);
      expect(summary.currentStreakWeeks).toBe(3);
    });

    it('breaks once a whole week passes with nothing', () => {
      // This week and last, then a gap, then two more.
      const summary = summariseCheckIns([ago(0), ago(8), ago(22), ago(29)], TODAY);
      expect(summary.currentStreakWeeks).toBe(2);
    });

    it('reports the longest run even when the current one is shorter', () => {
      const summary = summariseCheckIns(
        [ago(0), ago(22), ago(29), ago(36), ago(43)],
        TODAY,
      );
      expect(summary.currentStreakWeeks).toBe(1);
      expect(summary.longestStreakWeeks).toBe(4);
    });

    it('is zero when the last visit was two clear weeks ago', () => {
      expect(summariseCheckIns([ago(20)], TODAY).currentStreakWeeks).toBe(0);
    });

    it('counts a single visit as a one-week streak', () => {
      expect(summariseCheckIns([ago(0)], TODAY).currentStreakWeeks).toBe(1);
      expect(summariseCheckIns([ago(0)], TODAY).longestStreakWeeks).toBe(1);
    });
  });
});
