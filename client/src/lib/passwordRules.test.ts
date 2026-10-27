import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MIN,
  meetsPasswordRules,
  newPasswordProblem,
  passwordRefusalMessage,
  passwordRules,
  passwordStrength,
} from './passwordRules';

const met = (password: string): Record<string, boolean> =>
  Object.fromEntries(passwordRules(password).map((rule) => [rule.key, rule.met]));

describe('passwordRules', () => {
  it('lists the five rules in the order the checklist shows them', () => {
    expect(passwordRules('').map((rule) => rule.key)).toEqual([
      'length',
      'lower',
      'upper',
      'number',
      'symbol',
    ]);
  });

  it('meets nothing for an empty password', () => {
    expect(Object.values(met(''))).toEqual([false, false, false, false, false]);
  });

  it('counts length from the eighth character', () => {
    expect(PASSWORD_MIN).toBe(8);
    expect(met('aaaaaaa').length).toBe(false);
    expect(met('aaaaaaaa').length).toBe(true);
  });

  it('tells lowercase from uppercase', () => {
    expect(met('abc')).toMatchObject({ lower: true, upper: false });
    expect(met('ABC')).toMatchObject({ lower: false, upper: true });
  });

  it('sees a digit', () => {
    expect(met('abc').number).toBe(false);
    expect(met('abc7').number).toBe(true);
  });

  it.each([
    '!',
    '@',
    '#',
    '$',
    '%',
    '^',
    '&',
    '*',
    '(',
    ')',
    '_',
    '+',
    '-',
    '=',
    '[',
    ']',
    '{',
    '}',
    ';',
    "'",
    ':',
    '"',
    '|',
    '<',
    '>',
    '?',
    ',',
    '.',
    '/',
    '`',
    '~',
    '\\',
  ])('counts %s as a special character (Supabase’s symbol list)', (symbol) => {
    expect(met(`a${symbol}`).symbol).toBe(true);
  });

  it('does not count a space or an accented letter as a special character', () => {
    expect(met('a b').symbol).toBe(false);
    expect(met('niña').symbol).toBe(false);
  });

  it('ignores invisible pasted characters', () => {
    // A zero-width space is stripped before the rules run, like every password here.
    expect(met(`abcdefg${String.fromCharCode(0x200b)}`).length).toBe(false);
  });
});

describe('meetsPasswordRules', () => {
  it('needs all five', () => {
    expect(meetsPasswordRules('Thr0nes!')).toBe(true);
    expect(meetsPasswordRules('Thrones!')).toBe(false);
    expect(meetsPasswordRules('thr0nes!')).toBe(false);
    expect(meetsPasswordRules('THR0NES!')).toBe(false);
    expect(meetsPasswordRules('Thr0nes1')).toBe(false);
    expect(meetsPasswordRules('Th0n!')).toBe(false);
  });
});

describe('passwordStrength', () => {
  it('is not started when empty', () => {
    expect(passwordStrength('')).toEqual({ level: 0, label: 'Not started' });
  });

  it('is weak with two rules or fewer', () => {
    expect(passwordStrength('abc')).toEqual({ level: 1, label: 'Weak' });
    expect(passwordStrength('abcdefgh')).toEqual({ level: 1, label: 'Weak' });
  });

  it('is fair with three or four rules', () => {
    expect(passwordStrength('Gym2026')).toEqual({ level: 2, label: 'Fair' });
    expect(passwordStrength('Gym20266')).toEqual({ level: 2, label: 'Fair' });
  });

  it('is good with every rule', () => {
    expect(passwordStrength('Thr0nes!')).toEqual({ level: 3, label: 'Good' });
  });

  it('is strong with every rule and 12 characters or more', () => {
    expect(passwordStrength('Thr0nes!Gym2')).toEqual({ level: 4, label: 'Strong' });
  });
});

describe('newPasswordProblem', () => {
  it('asks for a password when there is none', () => {
    expect(newPasswordProblem('', '')).toBe('Choose a password.');
  });

  it('names exactly what is still missing', () => {
    expect(newPasswordProblem('Gym2026', 'Gym2026')).toBe(
      'Your password still needs at least 8 characters and a special character.',
    );
    expect(newPasswordProblem('gym', 'gym')).toBe(
      'Your password still needs at least 8 characters, an uppercase letter, a number and a special character.',
    );
    expect(newPasswordProblem('Thrones2026', '')).toBe(
      'Your password still needs a special character.',
    );
  });

  it('checks the rules before the match, so the first fix is the one shown', () => {
    expect(newPasswordProblem('Gym2026', 'other')).toMatch(/^Your password still needs/);
  });

  it('refuses two different passwords', () => {
    expect(newPasswordProblem('Thr0nes!', 'Thr0nes?')).toBe('The two passwords do not match.');
  });

  it('accepts a password that meets every rule and matches', () => {
    expect(newPasswordProblem('Thr0nes!', 'Thr0nes!')).toBeNull();
  });
});

describe('passwordRefusalMessage', () => {
  it('turns Supabase’s weak_password into the rules in plain words', () => {
    expect(
      passwordRefusalMessage({ code: 'weak_password', message: 'Password is known to be weak' }),
    ).toBe(
      'Choose a stronger password: at least 8 characters, with a lowercase and an uppercase letter, a number and a special character.',
    );
  });

  it('turns same_password into a clear next step', () => {
    expect(
      passwordRefusalMessage({
        code: 'same_password',
        message: 'New password should be different',
      }),
    ).toBe('Choose a password different from your current one.');
  });

  it('passes any other refusal through as Supabase wrote it', () => {
    expect(passwordRefusalMessage({ message: 'User already registered' })).toBe(
      'User already registered',
    );
  });
});
