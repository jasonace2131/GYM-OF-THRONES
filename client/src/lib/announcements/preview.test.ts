import { describe, expect, it } from 'vitest';
import { previewText } from './preview';

describe('previewText', () => {
  it('returns short text unchanged', () => {
    expect(previewText('Gym closes at 6pm on Saturday.', 140)).toBe(
      'Gym closes at 6pm on Saturday.',
    );
  });

  /** The composer is a plain textarea — paragraphs arrive as newlines. */
  it('collapses newlines and runs of spaces into single spaces', () => {
    expect(previewText('Line one.\n\n  Line   two.\tEnd', 140)).toBe('Line one. Line two. End');
  });

  it('trims the ends', () => {
    expect(previewText('   padded   ', 140)).toBe('padded');
  });

  it('cuts at a word boundary and adds an ellipsis', () => {
    expect(previewText('The sauna is repaired and open again from today', 20)).toBe(
      'The sauna is…',
    );
  });

  it('never leaves punctuation dangling before the ellipsis', () => {
    expect(previewText('Classes, lockers, sauna and more are all open', 17)).toBe(
      'Classes, lockers…',
    );
    expect(previewText('Open late. Bring water and a towel', 12)).toBe('Open late…');
  });

  it('hard-cuts a single word longer than the limit', () => {
    expect(previewText('Supercalifragilisticexpialidocious', 10)).toBe('Supercalif…');
  });

  it('keeps text of exactly the limit whole', () => {
    expect(previewText('12345 7890', 10)).toBe('12345 7890');
  });

  it('is empty for whitespace-only content', () => {
    expect(previewText(' \n ', 140)).toBe('');
  });
});
