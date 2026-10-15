import { cronAt } from './cron.util';

describe('cronAt', () => {
  it.each([
    ['22:00', 15, '15 22 * * *'],
    ['22:00', 0, '0 22 * * *'],
    ['05:00', undefined, '0 5 * * *'],
    ['23:50', 30, '20 0 * * *'],
    ['23:59', 1, '0 0 * * *'],
    ['00:10', -20, '50 23 * * *'],
    ['13:07', 53, '0 14 * * *'],
  ])('cronAt(%s, %s) === %s', (timeOfDay, offset, expected) => {
    expect(cronAt(timeOfDay, offset)).toBe(expected);
  });

  it.each(['24:00', '7:00', '22:60', '2200', '', 'noon'])(
    'throws on the malformed time %p',
    (bad) => {
      expect(() => cronAt(bad)).toThrow(/not an HH:mm time of day/);
    },
  );
});
