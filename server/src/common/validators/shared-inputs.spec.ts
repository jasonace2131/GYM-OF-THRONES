import {
  collapseSpaces,
  earliestBirthDateFor,
  filterNameTyping,
  filterPhoneTyping,
  formatPhPhone,
  isPersonName,
  isPhPhone,
  isPlausibleBirthDate,
  latestBirthDateFor,
  meetsMinimumAge,
  normalisePhPhone,
  sanitisePersonName,
  MINIMUM_ACCOUNT_AGE,
  MINIMUM_AGE_MESSAGE,
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
  it('accepts today and a past date: the minimum age is meetsMinimumAge, not this', () => {
    expect(isPlausibleBirthDate('2026-10-23', today)).toBe(true);
    expect(isPlausibleBirthDate('1990-02-28', today)).toBe(true);
  });
  it('refuses the future and impossible dates', () => {
    expect(isPlausibleBirthDate('2026-10-24', today)).toBe(false);
    expect(isPlausibleBirthDate('2001-02-30', today)).toBe(false);
    expect(isPlausibleBirthDate('20-01-01', today)).toBe(false);
  });
  // The database's User_dob_plausible: dateOfBirth > CURRENT_DATE - interval '120 years'.
  it('uses the database bound: strictly less than 120 years ago', () => {
    expect(isPlausibleBirthDate('1906-10-24', today)).toBe(true);
    expect(isPlausibleBirthDate('1906-10-23', today)).toBe(false);
    expect(isPlausibleBirthDate('1900-01-01', today)).toBe(false);
  });
  it('matches Postgres on a leap day whose year 120 back has none (it clamps to 28 Feb)', () => {
    // '2020-02-29'::date - interval '120 years' = 1900-02-28.
    expect(isPlausibleBirthDate('1900-02-28', '2020-02-29')).toBe(false);
    expect(isPlausibleBirthDate('1900-03-01', '2020-02-29')).toBe(true);
  });
});

/** Owner, 2026-10-30: nobody under 12 has an account (reversing 2026-10-23's "no minimum age"). */
describe('minimum account age', () => {
  it('is 12, with the one message every surface shows', () => {
    expect(MINIMUM_ACCOUNT_AGE).toBe(12);
    expect(MINIMUM_AGE_MESSAGE).toBe('You need to be at least 12 years old to create an account.');
  });

  it('counts the 12th birthday itself as old enough', () => {
    expect(meetsMinimumAge('2014-10-30', '2026-10-30')).toBe(true);
    expect(meetsMinimumAge('2014-10-31', '2026-10-30')).toBe(false);
    expect(meetsMinimumAge('1990-05-05', '2026-10-30')).toBe(true);
    expect(meetsMinimumAge('2020-06-01', '2026-10-30')).toBe(false);
  });

  it('turns a 29 February birthday 12 on 29 February in a leap year', () => {
    expect(meetsMinimumAge('2012-02-29', '2024-02-28')).toBe(false);
    expect(meetsMinimumAge('2012-02-29', '2024-02-29')).toBe(true);
  });

  it('turns a 29 February birthday 12 on 1 March in a common year', () => {
    // 2100 is not a leap year, so a 2088-02-29 baby has no 29th that year.
    expect(meetsMinimumAge('2088-02-29', '2100-02-28')).toBe(false);
    expect(meetsMinimumAge('2088-02-29', '2100-03-01')).toBe(true);
  });

  it('refuses a malformed or impossible date rather than guessing', () => {
    expect(meetsMinimumAge('', '2026-10-30')).toBe(false);
    expect(meetsMinimumAge('05/05/1990', '2026-10-30')).toBe(false);
    expect(meetsMinimumAge('2001-02-30', '2026-10-30')).toBe(false);
  });

  it('gives the date inputs a max that meetsMinimumAge accepts, and the day after it does not', () => {
    for (const today of ['2026-10-30', '2026-03-01', '2024-02-29', '2027-01-01']) {
      const max = latestBirthDateFor(today);
      expect(meetsMinimumAge(max, today)).toBe(true);
      const next = new Date(`${max}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      expect(meetsMinimumAge(next.toISOString().slice(0, 10), today)).toBe(false);
    }
    expect(latestBirthDateFor('2026-10-30')).toBe('2014-10-30');
    // 1900 had no 29 February: the latest real day 12 years before 1912-02-29.
    expect(latestBirthDateFor('1912-02-29')).toBe('1900-02-28');
  });

  it('gives the date inputs a min that isPlausibleBirthDate accepts, and the day before it does not', () => {
    for (const today of ['2026-10-30', '2026-03-01', '2024-02-29', '2020-02-29']) {
      const min = earliestBirthDateFor(today);
      expect(isPlausibleBirthDate(min, today)).toBe(true);
      const before = new Date(`${min}T00:00:00.000Z`);
      before.setUTCDate(before.getUTCDate() - 1);
      expect(isPlausibleBirthDate(before.toISOString().slice(0, 10), today)).toBe(false);
    }
    expect(earliestBirthDateFor('2026-10-30')).toBe('1906-10-31');
    expect(earliestBirthDateFor('2020-02-29')).toBe('1900-03-01');
  });
});
