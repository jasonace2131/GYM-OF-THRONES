import {
  collapseSpaces,
  filterNameTyping,
  filterPhoneTyping,
  formatPhPhone,
  isPersonName,
  isPhPhone,
  isPlausibleBirthDate,
  normalisePhPhone,
  sanitisePersonName,
  NAME_MAX,
  PH_PHONE_MAX_INPUT,
} from '@got/shared';

describe('normalisePhPhone', () => {
  it.each([
    ['09171234567', '+639171234567'],
    ['+639171234567', '+639171234567'],
    ['639171234567', '+639171234567'],
    ['0917 123 4567', '+639171234567'],
    ['0917-123-4567', '+639171234567'],
    ['+63 917 123 4567', '+639171234567'],
    ['  +63-917-123-4567 ', '+639171234567'],
  ])('accepts %s', (raw, stored) => {
    expect(normalisePhPhone(raw)).toBe(stored);
    expect(isPhPhone(raw)).toBe(true);
  });

  it.each([
    ['letters', '0917abc4567'],
    ['a landline', '(02) 8123 4567'],
    ['a landline in digits', '0281234567'],
    ['10 digits', '0917123456'],
    ['12 digits', '091712345678'],
    ['a +63 landline', '+6328123456'],
    ['not starting 09', '08171234567'],
    ['blank', ''],
    ['a number', 9171234567],
    ['null', null],
  ])('refuses %s', (_label, raw) => {
    expect(normalisePhPhone(raw)).toBeNull();
    expect(isPhPhone(raw)).toBe(false);
  });

  it('formats a stored number for display', () => {
    expect(formatPhPhone('+639171234567')).toBe('+63 917 123 4567');
    expect(formatPhPhone('n/a')).toBe('n/a');
  });
});

describe('filterPhoneTyping', () => {
  it('drops letters and symbols, keeps digits, spaces and dashes', () => {
    expect(filterPhoneTyping('09a1b7-12(3) 4567')).toBe('0917-123 4567');
  });

  it('keeps a + only at the front', () => {
    expect(filterPhoneTyping('+63+917')).toBe('+63917');
    expect(filterPhoneTyping('63+917')).toBe('63917');
  });

  it('collapses runs of spaces so a spaced paste still fits', () => {
    expect(filterPhoneTyping('+63  917  123  4567')).toBe('+63 917 123 4567');
  });

  it('typing only letters yields nothing', () => {
    expect(filterPhoneTyping('abcdef')).toBe('');
  });

  it('is cut at the input maximum', () => {
    expect(filterPhoneTyping('1'.repeat(30))).toHaveLength(PH_PHONE_MAX_INPUT);
  });
});

describe('person names', () => {
  it.each(['Niña', 'José Mari', "O'Brien", 'Dela Cruz-Santos', 'Ma. Teresa', 'Zoë'])(
    'accepts %s',
    (name) => expect(isPersonName(name)).toBe(true),
  );

  it.each(['Juan2', '123', 'Juan_', 'a@b', ''])('refuses %s', (name) =>
    expect(isPersonName(name)).toBe(false),
  );

  it('refuses 61 characters and accepts 60', () => {
    expect(isPersonName('a'.repeat(NAME_MAX))).toBe(true);
    expect(isPersonName('a'.repeat(NAME_MAX + 1))).toBe(false);
  });

  it('honours a minimum length', () => {
    expect(isPersonName('J', 2)).toBe(false);
    expect(isPersonName('Jo', 2)).toBe(true);
  });

  it('collapses inner whitespace', () => {
    expect(collapseSpaces('  Juan   dela  Cruz ')).toBe('Juan dela Cruz');
  });

  it('filters what may be typed, keeping inner spaces', () => {
    expect(filterNameTyping('Ju4n d3la ')).toBe('Jun dla ');
    expect(filterNameTyping('x'.repeat(80))).toHaveLength(NAME_MAX);
  });

  it('sanitises an unvalidated name into a storable one, or empty', () => {
    expect(sanitisePersonName('  <b>Juan</b>  99 ')).toBe('Juan');
    expect(sanitisePersonName('Juan<br/>Cruz')).toBe('Juan Cruz');
    expect(sanitisePersonName('<script>x</script>')).toBe('x');
    expect(sanitisePersonName("  -'Ana   Marie ")).toBe('Ana Marie');
    expect(sanitisePersonName('12345')).toBe('');
    expect(sanitisePersonName(42)).toBe('');
    expect(sanitisePersonName('a'.repeat(100))).toHaveLength(NAME_MAX);
    expect(isPersonName(sanitisePersonName('juan.dela.cruz123'))).toBe(true);
  });
});

describe('isPlausibleBirthDate', () => {
  const today = '2026-10-23';
  it('accepts today and a past date, with no minimum age', () => {
    expect(isPlausibleBirthDate('2026-10-23', today)).toBe(true);
    expect(isPlausibleBirthDate('1990-02-28', today)).toBe(true);
  });
  it('refuses the future, before 1900, and impossible dates', () => {
    expect(isPlausibleBirthDate('2026-10-24', today)).toBe(false);
    expect(isPlausibleBirthDate('1899-12-31', today)).toBe(false);
    expect(isPlausibleBirthDate('2001-02-30', today)).toBe(false);
    expect(isPlausibleBirthDate('20-01-01', today)).toBe(false);
  });
});
