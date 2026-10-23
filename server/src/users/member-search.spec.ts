import { phoneSearchDigits, searchClauses } from './members.service';

describe('member search by phone (stored as +639XXXXXXXXX since 2026-10-23)', () => {
  it.each([
    ['09171234567', '639171234567'],
    ['0917 123 4567', '639171234567'],
    ['9171234567', '9171234567'],
    ['+63 917 123 4567', '639171234567'],
  ])('%s searches the stored digits as %s', (typed, digits) => {
    expect(phoneSearchDigits(typed)).toBe(digits);
    expect('+639171234567'.includes(digits)).toBe(true);
  });

  it('adds the digits clause next to the raw one, which still finds legacy rows', () => {
    const clauses = searchClauses('0917 123 4567');
    expect(clauses).toContainEqual({ phone: { contains: '0917 123 4567', mode: 'insensitive' } });
    expect(clauses).toContainEqual({ phone: { contains: '639171234567' } });
  });

  it('leaves names, emails and short fragments alone', () => {
    expect(phoneSearchDigits('Juan')).toBeNull();
    expect(phoneSearchDigits('a1@x.com')).toBeNull();
    expect(phoneSearchDigits('12')).toBeNull();
    expect(searchClauses('Juan')).toHaveLength(5);
  });
});
