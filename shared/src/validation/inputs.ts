/**
 * Input rules shared by the API and the app (owner, 2026-10-23). One copy, two
 * runtimes: the server's DTOs refuse what these refuse, and the app's inputs
 * stop it being typed in the first place.
 */

// ── Names ────────────────────────────────────────────────────────────────

/** Every person's name — member, guest, lead, coach, staff, import. */
export const NAME_MAX = 60;

/**
 * Characters a name may hold: letters (any script, with their accents),
 * spaces, apostrophes, hyphens and dots — "Ma. Niña O'Brien-Santos".
 * Built from a string: the client compiles with target ES2017, and TypeScript
 * refuses a `\p{…}` regex LITERAL below ES2018.
 */
const NAME_DISALLOWED = new RegExp("[^\\p{L}\\p{M} '’.-]", 'gu');
const NAME_LEADING_NON_LETTER = new RegExp('^[^\\p{L}\\p{M}]+', 'u');

/** Trimmed, every run of whitespace collapsed to one space. */
export function collapseSpaces(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * What a name field keeps while somebody types: the allowed characters only,
 * cut at `NAME_MAX`. Not trimmed — the space between two words is typed
 * before the second word exists.
 */
export function filterNameTyping(raw: string): string {
  return raw.replace(/\s/g, ' ').replace(NAME_DISALLOWED, '').slice(0, NAME_MAX);
}

/**
 * A name made safe to store from a source nobody validated (Supabase sign-up
 * metadata, an email local-part): HTML tags and disallowed characters dropped, spaces
 * collapsed, leading punctuation dropped, cut at `NAME_MAX`. May return ''.
 */
export function sanitisePersonName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // Tags go first, whole: '<b>Juan</b>' is Juan, not 'bJuanb'.
  const untagged = raw.replace(/<[^>]*>/g, ' ');
  const kept = collapseSpaces(untagged.replace(/\s/g, ' ').replace(NAME_DISALLOWED, ''));
  return collapseSpaces(kept.replace(NAME_LEADING_NON_LETTER, '').slice(0, NAME_MAX));
}

/** A name after `collapseSpaces`, checked against the shared rule. */
export function isPersonName(raw: string, minLength = 1): boolean {
  const name = collapseSpaces(raw);
  if (name.length < minLength || name.length > NAME_MAX) return false;
  return new RegExp("^[\\p{L}\\p{M}][\\p{L}\\p{M} '’.-]*$", 'u').test(name);
}

// ── Philippine mobile numbers ────────────────────────────────────────────

/** "+63 917-123-4567" is 16 characters — the longest spelling worth typing. */
export const PH_PHONE_MAX_INPUT = 16;

/** The one stored shape: E.164, `+639XXXXXXXXX`. */
export const PH_PHONE_E164 = /^\+639\d{9}$/;

/**
 * What a phone field keeps while somebody types: digits, spaces, dashes, and a
 * `+` only as the very first character. Letters cannot get in.
 */
export function filterPhoneTyping(raw: string): string {
  const plus = raw.trimStart().startsWith('+');
  // Runs of spaces collapse to one, so a pasted "+63  917  123  4567" still
  // fits the 16-character cut.
  const body = raw.replace(/\s/g, ' ').replace(/[^0-9 -]/g, '').replace(/ {2,}/g, ' ');
  return ((plus ? '+' : '') + body).slice(0, PH_PHONE_MAX_INPUT);
}

/**
 * A Philippine MOBILE number in its stored form, `+639XXXXXXXXX`, or null.
 * Accepts `09XXXXXXXXX`, `639XXXXXXXXX` and `+639XXXXXXXXX`, with spaces and
 * dashes anywhere. Landlines, 10- or 12-digit numbers and letters are null.
 */
export function normalisePhPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const compact = raw.trim().replace(/[\s-]/g, '');
  if (/^09\d{9}$/.test(compact)) return `+63${compact.slice(1)}`;
  if (/^\+?639\d{9}$/.test(compact)) return `+${compact.replace(/^\+/, '')}`;
  return null;
}

export function isPhPhone(raw: unknown): boolean {
  return normalisePhPhone(raw) !== null;
}

/** `+639171234567` → `+63 917 123 4567`; anything else is returned as given. */
export function formatPhPhone(raw: string): string {
  const e164 = normalisePhPhone(raw);
  if (e164 === null) return raw;
  return `+63 ${e164.slice(3, 6)} ${e164.slice(6, 9)} ${e164.slice(9)}`;
}

export const PH_PHONE_MESSAGE = 'Enter a PH mobile number — 09XX XXX XXXX or +63 9XX XXX XXXX';

// ── Other shared text limits ─────────────────────────────────────────────

/** RFC 5321's address limit. */
export const EMAIL_MAX = 254;
/** bcrypt's input limit, which Supabase Auth inherits. */
export const PASSWORD_MAX = 72;

/**
 * A GCash / e-wallet reference (owner rule 4: loose). Any characters, trimmed,
 * blank refused, and this ONE length everywhere — 4 to 64.
 */
export const PAYMENT_REFERENCE_MIN = 4;
export const PAYMENT_REFERENCE_MAX = 64;

/** An OSCA / PWD ID number. */
export const STATUTORY_ID_MIN = 3;
export const STATUTORY_ID_MAX = 64;

/** The emergency-contact free text (walk-in guest, member). */
export const EMERGENCY_CONTACT_MAX = 200;

// ── Dates of birth ───────────────────────────────────────────────────────
//
// Every `today` below is a `yyyy-mm-dd` civil date, and so is every result.

/**
 * A date of birth is less than this many years before today: the database's
 * own bound (`User_dob_plausible`: `dateOfBirth > CURRENT_DATE - interval
 * '120 years'`), so no form accepts a date the database refuses. It used to be
 * a fixed 1900-01-01, and a self-registered member born before the CHECK's
 * bound failed the first-sight insert and was turned away at every sign-in.
 */
export const BIRTH_DATE_MAX_YEARS = 120;

/**
 * Nobody under this age has an account (owner, 2026-10-30, reversing
 * 2026-10-23's "no minimum age"). Refused at sign-up, at the counter and on
 * the setup link. Accounts already on file are left alone.
 */
export const MINIMUM_ACCOUNT_AGE = 12;

export const MINIMUM_AGE_MESSAGE = `You need to be at least ${MINIMUM_ACCOUNT_AGE} years old to create an account.`;

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * The same month and day `years` earlier, as a STRING that may name 29
 * February of a common year. Only ever compared, and that is deliberate: the
 * string sorts between the 28th and 1 March, which is exactly where the
 * comparisons below need it.
 */
function yearsBefore(day: string, years: number): string {
  return `${String(Number(day.slice(0, 4)) - years).padStart(4, '0')}${day.slice(4)}`;
}

/**
 * A real calendar date, less than `BIRTH_DATE_MAX_YEARS` years ago, never after
 * `today`. Says nothing about the minimum age: that is `meetsMinimumAge`.
 */
export function isPlausibleBirthDate(value: string, today: string): boolean {
  if (!isCalendarDate(value)) return false;
  return value > yearsBefore(today, BIRTH_DATE_MAX_YEARS) && value <= today;
}

/**
 * Whether somebody born on `dateOfBirth` is `MINIMUM_ACCOUNT_AGE` or older on
 * `today`. The 12th birthday itself counts. A 29 February birthday turns 12 on
 * 1 March in a common year (it is not yet 12 on the 28th).
 */
export function meetsMinimumAge(dateOfBirth: string, today: string): boolean {
  return isCalendarDate(dateOfBirth) && dateOfBirth <= yearsBefore(today, MINIMUM_ACCOUNT_AGE);
}

/** The latest date of birth `meetsMinimumAge` accepts on `today`: a date input's `max`. */
export function latestBirthDateFor(today: string): string {
  const latest = yearsBefore(today, MINIMUM_ACCOUNT_AGE);
  // Only 29 February of a common year is not a real day; the 28th is the last before it.
  return isCalendarDate(latest) ? latest : `${latest.slice(0, 8)}28`;
}

/** The earliest date of birth `isPlausibleBirthDate` accepts on `today`: a date input's `min`. */
export function earliestBirthDateFor(today: string): string {
  const bound = yearsBefore(today, BIRTH_DATE_MAX_YEARS);
  if (!isCalendarDate(bound)) return `${bound.slice(0, 5)}03-01`;
  const next = new Date(`${bound}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
