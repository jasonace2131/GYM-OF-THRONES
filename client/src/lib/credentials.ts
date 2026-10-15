/**
 * Normalising what somebody typed into a sign-in field.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A TRAILING SPACE USED TO MEAN "WRONG PASSWORD".
 *
 * Supabase treats `"juan@example.com "` and `"juan@example.com"` as different
 * accounts, so a single invisible character came back as *Invalid login
 * credentials* — the same message as a genuinely wrong password. Somebody in
 * that state has no way to see the problem: the field looks right, the
 * password IS right, and the error blames the password.
 *
 * Three ways it gets in, none of them the member's fault:
 *   - iOS autocorrect appends a space after an email-shaped token
 *   - copy-paste from a chat message or a spreadsheet cell carries one
 *   - a password manager filling a field that was not marked as an email
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Characters `String.prototype.trim()` does NOT remove.
 *
 * `trim()` handles ordinary spaces and even NBSP, but zero-width space, ZWNJ,
 * ZWJ and the BOM all survive it — and all four ride along on a paste out of a
 * chat app or a PDF. They are invisible in the field, so a member comparing
 * what they typed against what they expect sees no difference at all.
 *
 * BUILT FROM CODE POINTS rather than written as literal characters. A literal
 * zero-width space in source is invisible to the next person to read this
 * file, and editors, linters and copy-paste all drop or mangle them silently —
 * which would switch this guard off without changing anything anybody can see.
 */
const INVISIBLE_CODE_POINTS = [
  0x200b, // ZERO WIDTH SPACE
  0x200c, // ZERO WIDTH NON-JOINER
  0x200d, // ZERO WIDTH JOINER
  0xfeff, // BYTE ORDER MARK / ZERO WIDTH NO-BREAK SPACE
];

const INVISIBLE = new RegExp(
  `[${INVISIBLE_CODE_POINTS.map((point) => String.fromCharCode(point)).join('')}]`,
  'g',
);

/**
 * An email or phone as the identity provider stores it.
 *
 * LOWERCASED, because Supabase stores addresses lowercased at sign-up — so
 * somebody who registered as `Juan@Example.com` and later types
 * `juan@example.com` is the same person and must be able to get in. Applying
 * it to a phone number is harmless: digits have no case.
 */
export function normaliseIdentifier(raw: string): string {
  return raw.replace(INVISIBLE, '').trim().toLowerCase();
}

/**
 * A password, cleaned of the things that are never part of one.
 *
 * NOT TRIMMED, and that is deliberate rather than an oversight. A space is a
 * legal password character and plenty of people end a passphrase with one.
 * Trimming would silently change the credential — locking out anybody whose
 * password genuinely ends in a space, with an error message that blames them.
 *
 * The invisible characters ARE stripped: no password manager generates a
 * zero-width space, so one in the field came from a paste and is never
 * intended.
 */
export function normalisePassword(raw: string): string {
  return raw.replace(INVISIBLE, '');
}

/**
 * Props that stop a phone keyboard corrupting an email field before anybody
 * has to normalise anything.
 *
 * `autoCapitalize="none"` is the one that matters most: without it iOS
 * capitalises the first letter, and the same keyboard behaviour is what
 * appends the trailing space in the first place. Fixing the input beats
 * cleaning up after it, because the input is the only layer the member sees.
 */
export const EMAIL_INPUT_PROPS = {
  inputMode: 'email',
  autoCapitalize: 'none',
  autoCorrect: 'off',
  spellCheck: false,
} as const;
