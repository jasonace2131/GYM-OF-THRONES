import { describe, expect, it } from 'vitest';
import { normaliseIdentifier, normalisePassword } from './credentials';

describe('normaliseIdentifier', () => {
  /**
   * THE BUG THIS EXISTS FOR.
   *
   * Supabase treats "juan@example.com " as a different account, so one
   * invisible character came back as "Invalid login credentials" — the same
   * message as a wrong password, with nothing on screen to see.
   */
  it.each([
    ['juan@example.com ', 'trailing space, the reported case'],
    [' juan@example.com', 'leading space'],
    ['  juan@example.com  ', 'both ends'],
    ['juan@example.com\t', 'tab'],
    ['juan@example.com\n', 'newline from a paste'],
    ['juan@example.com\u00A0', 'non-breaking space'],
    ['juan@example.com\u200B', 'zero-width space, which trim() does NOT remove'],
    ['\uFEFFjuan@example.com', 'BOM from a spreadsheet paste'],
  ])('cleans %j (%s)', (raw) => {
    expect(normaliseIdentifier(raw)).toBe('juan@example.com');
  });

  it('lowercases, because Supabase stores addresses lowercased at sign-up', () => {
    expect(normaliseIdentifier('Juan@Example.COM')).toBe('juan@example.com');
  });

  it('leaves a clean address untouched', () => {
    expect(normaliseIdentifier('juan@example.com')).toBe('juan@example.com');
  });

  it('handles a phone number the same way', () => {
    expect(normaliseIdentifier(' 09171234567 ')).toBe('09171234567');
  });

  it('does not invent an address from nothing', () => {
    expect(normaliseIdentifier('   ')).toBe('');
  });
});

describe('normalisePassword', () => {
  /**
   * DELIBERATELY NOT TRIMMED. A space is a legal password character and plenty
   * of passphrases end in one. Trimming would silently change the credential
   * and lock somebody out with an error blaming them.
   */
  it.each([
    ['correct horse ', 'a trailing space is part of the password'],
    [' correct horse', 'so is a leading one'],
    ['  ', 'even a password of only spaces'],
  ])('preserves %j (%s)', (raw) => {
    expect(normalisePassword(raw)).toBe(raw);
  });

  it('strips invisible characters, which no password manager generates', () => {
    expect(normalisePassword('hunter2\u200B')).toBe('hunter2');
    expect(normalisePassword('\uFEFFhunter2')).toBe('hunter2');
  });
});
