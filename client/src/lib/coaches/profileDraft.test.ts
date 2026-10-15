import { describe, expect, it } from 'vitest';
import {
  coachOptionLabel,
  draftFromProfile,
  draftProblem,
  draftToBody,
  parseSpecializations,
  specializationsLine,
} from './profileDraft';

describe('parseSpecializations', () => {
  it('splits on commas and new lines, trims, and drops blanks', () => {
    expect(parseSpecializations(' Strength, Mobility\nBoxing ,, ')).toEqual([
      'Strength',
      'Mobility',
      'Boxing',
    ]);
  });

  it('keeps the first spelling of a case-insensitive repeat — what the server stores', () => {
    expect(parseSpecializations('Strength, strength, STRENGTH')).toEqual(['Strength']);
  });
});

describe('draftProblem', () => {
  it('accepts up to five specializations and a 500-character bio', () => {
    expect(draftProblem({ specializations: 'a, b, c, d, e', bio: 'x'.repeat(500) })).toBeNull();
  });

  it('refuses a sixth specialization — the database would', () => {
    expect(draftProblem({ specializations: 'a, b, c, d, e, f', bio: '' })).toMatch(/at most 5/i);
  });

  it('refuses a specialization over 40 characters, naming it', () => {
    expect(draftProblem({ specializations: 'x'.repeat(41), bio: '' })).toMatch(/40 characters/);
  });

  it('refuses a bio over 500 characters, counted after trimming', () => {
    expect(draftProblem({ specializations: '', bio: `  ${'x'.repeat(500)}  ` })).toBeNull();
    expect(draftProblem({ specializations: '', bio: 'x'.repeat(501) })).toMatch(/500/);
  });
});

describe('draftToBody / draftFromProfile', () => {
  it('sends a blank bio as null, which clears it', () => {
    expect(draftToBody({ specializations: 'Strength', bio: '   ' })).toEqual({
      specializations: ['Strength'],
      bio: null,
    });
  });

  it('round-trips a stored profile into the form', () => {
    expect(
      draftFromProfile({
        userId: 'c1',
        specializations: ['Strength', 'Mobility'],
        bio: 'Ten years.',
        updatedAt: '2026-09-25T00:00:00.000Z',
      }),
    ).toEqual({ specializations: 'Strength, Mobility', bio: 'Ten years.' });
    expect(draftFromProfile(undefined)).toEqual({ specializations: '', bio: '' });
  });
});

describe('specializationsLine / coachOptionLabel', () => {
  it('joins specializations with a middle dot, or says nothing', () => {
    expect(specializationsLine(['Strength', 'Mobility'])).toBe('Strength · Mobility');
    expect(specializationsLine([])).toBe('');
    expect(specializationsLine(undefined)).toBe('');
  });

  it('names a coach in the assign picker with what they specialise in', () => {
    expect(coachOptionLabel({ firstName: 'Ana', lastName: 'Cruz' }, ['Strength', 'Mobility'])).toBe(
      'Ana Cruz — Strength, Mobility',
    );
    expect(coachOptionLabel({ firstName: 'Ana', lastName: 'Cruz' }, [])).toBe('Ana Cruz');
  });
});
