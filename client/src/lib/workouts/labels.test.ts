import { describe, expect, it } from 'vitest';
import {
  EASY_ON_LABEL,
  GOAL_LABEL,
  LEVEL_LABEL,
  PRESET_LABEL,
  TIME_LABEL,
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  easyOnPhrase,
  planNameFor,
  weekdayList,
} from './labels';

describe('labels', () => {
  it('names every goal, level, time of day, area and preset', () => {
    expect(GOAL_LABEL.MUSCLE.title).toBe('Build muscle');
    expect(GOAL_LABEL.FAT_LOSS.sub).toBe('Lean out and keep your muscle');
    expect(LEVEL_LABEL.NEW.title).toBe('New to lifting');
    expect(TIME_LABEL.EVENING).toBe('Evening');
    expect(EASY_ON_LABEL.LOWER_BACK).toBe('Lower back');
    expect(PRESET_LABEL.BUSY).toBe('Equipment’s busy');
  });

  it('spells weekdays with Sunday at 0, like OpeningHours', () => {
    expect(WEEKDAY_LONG[0]).toBe('Sunday');
    expect(WEEKDAY_SHORT[6]).toBe('Sat');
  });

  it('lists weekdays Monday-first as "Mon · Wed · Sat"', () => {
    expect(weekdayList([0, 1, 3, 6])).toBe('Mon · Wed · Sat · Sun');
    expect(weekdayList([])).toBe('None yet');
  });

  it('phrases the easy-on areas in lower case', () => {
    expect(easyOnPhrase(['KNEES'])).toBe('knees');
    expect(easyOnPhrase(['KNEES', 'LOWER_BACK'])).toBe('knees, lower back');
    expect(easyOnPhrase([])).toBe('');
  });

  it('proposes a plan name from level and goal — "Beginner Muscle"', () => {
    expect(planNameFor('MUSCLE', 'NEW')).toBe('Beginner Muscle');
    expect(planNameFor('FAT_LOSS', 'SOME')).toBe('Intermediate Fat Loss');
    expect(planNameFor('GENERAL', 'EXPERIENCED')).toBe('Advanced Fitness');
  });
});
