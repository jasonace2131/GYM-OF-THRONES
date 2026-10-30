import { describe, expect, it } from 'vitest';
import { SUMMARY, SUMMARY_MONDAY } from './fixtures';
import {
  FEELING_OPTIONS,
  bestLine,
  durationText,
  exerciseLine,
  finishLine,
  kgText,
  plainLine,
  recentRow,
  savedFootnote,
  sessionDate,
  statTiles,
  summaryHref,
} from './history';

describe('numbers', () => {
  it('writes kg with thousands separators and at most two decimals', () => {
    expect(kgText(4435)).toBe('4,435 kg');
    expect(kgText(37.5)).toBe('37.5 kg');
    expect(kgText(22.25)).toBe('22.25 kg');
  });

  it('writes a duration in minutes, then hours', () => {
    expect(durationText(46)).toBe('46 min');
    expect(durationText(60)).toBe('1 h');
    expect(durationText(72)).toBe('1 h 12 min');
  });

  it("names the gym day without the phone's time zone moving it", () => {
    expect(sessionDate('2026-09-30')).toBe('Wed, Sep 30');
    expect(sessionDate('2026-09-28')).toBe('Mon, Sep 28');
  });
});

describe('recentRow', () => {
  it('reads like the Recent workouts rows of PhoneHubCoach.dc.html', () => {
    expect(recentRow(SUMMARY_MONDAY)).toEqual({
      id: 'sess-0',
      title: 'Full body A',
      when: 'Mon, Sep 28 · 48 min · 15 sets',
      volume: '1,980 kg',
      href: '/portal/workouts/history/sess-0',
    });
  });

  it('leaves the weight out of a workout logged without weights, rather than "0 kg"', () => {
    expect(recentRow({ ...SUMMARY_MONDAY, volumeKg: 0 }).volume).toBeNull();
    expect(recentRow({ ...SUMMARY_MONDAY, setsDone: 1 }).when).toBe('Mon, Sep 28 · 48 min · 1 set');
  });
});

describe('the finish screen', () => {
  it('heads it like PhoneFinish.dc.html', () => {
    expect(finishLine(SUMMARY)).toBe('Full body B · 46 min · Wed, Sep 30');
    expect(plainLine(SUMMARY)).toBe('Wed, Sep 30 · 46 min · Beginner Muscle');
  });

  it('fills the four tiles, the new-best tile in gold only when there is one', () => {
    expect(statTiles(SUMMARY)).toEqual([
      { value: '13', label: 'Sets done', highlight: false },
      { value: '5 / 5', label: 'Exercises', highlight: false },
      { value: '4,435 kg', label: 'Weight moved', highlight: false },
      { value: '1', label: 'New best', highlight: true },
    ]);
    const noBest = statTiles({ ...SUMMARY, bests: [] });
    expect(noBest[3]).toEqual({ value: '0', label: 'New bests', highlight: false });
  });

  it('shows only sets and exercises for a workout logged without weights', () => {
    expect(statTiles({ ...SUMMARY, bests: [], volumeKg: 0 })).toEqual([
      { value: '13', label: 'Sets done', highlight: false },
      { value: '5 / 5', label: 'Exercises', highlight: false },
    ]);
  });

  it('says what the best beat, and only what it knows', () => {
    expect(bestLine(SUMMARY.bests[0]!)).toBe('14 kg × 10 — up from 12 kg');
  });

  it('writes each exercise as "what you did"', () => {
    expect(SUMMARY.perExercise.map(exerciseLine)).toEqual([
      '3 sets · top 80 kg × 12',
      '3 sets · top 37.5 kg × 10',
      '3 sets · top 14 kg × 10',
      '2 sets · up to 10 reps',
      '2 of 3 sets · up to 8 reps',
    ]);
    expect(
      exerciseLine({ name: 'Row', setsDone: 1, plannedSets: 1, top: { weightKg: 40, reps: 8 } }),
    ).toBe('1 set · 40 kg × 8');
    expect(
      exerciseLine({ name: 'Dip', setsDone: 1, plannedSets: 3, top: { weightKg: null, reps: 1 } }),
    ).toBe('1 of 3 sets · 1 rep');
    expect(exerciseLine({ name: 'Row', setsDone: 0, plannedSets: 3, top: null })).toBe('Not done');
  });

  it('names the ticked weekday in the footnote', () => {
    expect(savedFootnote(SUMMARY)).toBe(
      'Saved to your history — Wednesday is ticked on your week.',
    );
  });

  it('offers the three feelings in the order of the mockup', () => {
    expect(FEELING_OPTIONS).toEqual([
      { value: 'EASY', label: 'Easy' },
      { value: 'RIGHT', label: 'Just right' },
      { value: 'HARD', label: 'Hard' },
    ]);
  });

  it('links a summary, and the just-finished version of it', () => {
    expect(summaryHref('sess-1')).toBe('/portal/workouts/history/sess-1');
    expect(summaryHref('a b', true)).toBe('/portal/workouts/history/a%20b?just=1');
  });
});
