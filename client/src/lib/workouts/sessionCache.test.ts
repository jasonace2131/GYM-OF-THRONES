import { beforeEach, describe, expect, it } from 'vitest';
import { SESSION, SUMMARY } from './fixtures';
import {
  SESSION_CACHE_KEY,
  clearSessionCache,
  readSessionCache,
  stashSummary,
  stashedSummary,
  writeSessionCache,
} from './sessionCache';

describe('the device copy of the open session', () => {
  beforeEach(() => window.localStorage.clear());

  it('round-trips the view, the exercise on screen and the rest', () => {
    const rest = { endsAt: 1_000, exerciseIndex: 2, nextSet: 2 };
    writeSessionCache({ view: SESSION, current: 2, rest });
    expect(readSessionCache()).toEqual({ view: SESSION, current: 2, rest });
    expect(window.localStorage.getItem(SESSION_CACHE_KEY)).not.toBeNull();
  });

  it('is gone after clear, and null when nothing or junk is stored', () => {
    writeSessionCache({ view: SESSION, current: 0, rest: null });
    clearSessionCache();
    expect(readSessionCache()).toBeNull();
    window.localStorage.setItem(SESSION_CACHE_KEY, '{"view":{"id":1}}');
    expect(readSessionCache()).toBeNull();
    window.localStorage.setItem(SESSION_CACHE_KEY, 'not json');
    expect(readSessionCache()).toBeNull();
  });

  it('drops a rest that is not a rest', () => {
    window.localStorage.setItem(
      SESSION_CACHE_KEY,
      JSON.stringify({ view: SESSION, current: 1, rest: { endsAt: 'soon' } }),
    );
    expect(readSessionCache()).toEqual({ view: SESSION, current: 1, rest: null });
  });

  it('never throws when storage does', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(readSessionCache(broken)).toBeNull();
    expect(() =>
      writeSessionCache({ view: SESSION, current: 0, rest: null }, broken),
    ).not.toThrow();
    expect(() => clearSessionCache(broken)).not.toThrow();
  });
});

describe('stashSummary', () => {
  it('hands the finish screen the summary the finish call returned', () => {
    stashSummary(SUMMARY);
    expect(stashedSummary(SUMMARY.id)).toEqual(SUMMARY);
    expect(stashedSummary('another')).toBeNull();
  });
});
