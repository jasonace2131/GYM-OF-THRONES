import { CODE_ALPHABET } from '@got/shared';

/**
 * Member and station codes use Crockford-style base32: no I, L, O or U, so a
 * code read aloud or off a card cannot be misread. What a person types for the
 * look-alikes is mapped (O→0, I/L→1) instead of silently dropped; U, which
 * has no look-alike digit, is dropped, and the hint says why.
 */
export const CODE_HINT = 'Codes never contain I, L, O or U.';

export function filterCodeTyping(raw: string, length: number): string {
  return raw
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .split('')
    .filter((char) => CODE_ALPHABET.includes(char))
    .join('')
    .slice(0, length);
}
