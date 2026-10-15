import { describe, expect, it } from 'vitest';
import { isPlausibleEmail } from './guestEmail';

describe('isPlausibleEmail', () => {
  it.each(['ana@example.com', '  Ana.Cruz@Example.COM ', 'a.b+gym@sub.example.ph'])(
    'accepts %s',
    (value) => {
      expect(isPlausibleEmail(value)).toBe(true);
    },
  );

  it.each([
    '',
    '   ',
    'ana',
    'ana@',
    '@example.com',
    'ana@example',
    'ana @example.com',
    'a@b@c.com',
  ])('refuses %j', (value) => {
    expect(isPlausibleEmail(value)).toBe(false);
  });

  it('refuses anything over 254 characters', () => {
    expect(isPlausibleEmail(`${'a'.repeat(250)}@x.co`)).toBe(false);
  });
});
