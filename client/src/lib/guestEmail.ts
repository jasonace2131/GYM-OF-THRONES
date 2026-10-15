/**
 * Enough of an email to be worth sending to — the form's gate before the server's
 * `@IsEmail`. One `@`, something on both sides, a dot in the domain, no spaces.
 * Deliberately loose: the server is the authority, and this only spares the desk
 * a round trip for an obvious typo.
 */
export function isPlausibleEmail(value: string): boolean {
  const email = value.trim();
  if (email.length === 0 || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
