import { describe, expect, it } from 'vitest';
import { demoVideoUrl } from './demoVideo';

describe('demoVideoUrl', () => {
  it('searches YouTube for the exercise name plus "proper form"', () => {
    expect(demoVideoUrl('Goblet squat')).toBe(
      'https://www.youtube.com/results?search_query=Goblet%20squat%20proper%20form',
    );
  });

  it('encodes special characters, so a name can never break out of the query', () => {
    expect(demoVideoUrl('Push-up (knees) & hold #2 / 50%?')).toBe(
      'https://www.youtube.com/results?search_query=' +
        encodeURIComponent('Push-up (knees) & hold #2 / 50%? proper form'),
    );
    const url = new URL(demoVideoUrl('Curl & press?x=1'));
    expect(url.hostname).toBe('www.youtube.com');
    expect([...url.searchParams.keys()]).toEqual(['search_query']);
    expect(url.searchParams.get('search_query')).toBe('Curl & press?x=1 proper form');
  });

  it('trims and collapses the spaces in a name', () => {
    expect(demoVideoUrl('  Romanian   deadlift ')).toBe(
      'https://www.youtube.com/results?search_query=Romanian%20deadlift%20proper%20form',
    );
  });
});
