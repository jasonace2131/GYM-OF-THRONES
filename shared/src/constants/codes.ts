// Crockford base32, minus the four characters a human mis-keys at a counter.
//
// This is a HUMAN channel, not an encoding one: memberCode is what staff types
// on the MEMBER_CODE fallback and reads back over the phone, and the station
// code is what an operator quotes when a display misbehaves. Excluding I, L, O
// and U is what stops a one/I or zero/O mis-key with a queue behind it.
//
// Imported by the CheckInDto regex, the station-code format and the memberCode
// allocator, so the three can never disagree.

/** 32 characters, no I / L / O / U. 32^6 ≈ 1.07e9 for a 6-character code. */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The same set as a regex character class, for building anchored patterns. */
export const CODE_CHAR_CLASS = '[0-9A-HJKMNP-TV-Z]';

/** Six characters, CSPRNG-drawn, @unique on User, allocated lazily. */
export const MEMBER_CODE_LENGTH = 6;

/** Four characters. Four, never five — the regex below is the regression. */
export const STATION_CODE_LENGTH = 4;

/** First 10 bytes of HMAC-SHA256, base32-encoded, is 16 characters. */
const STATION_MAC_LENGTH = 16;

/**
 * `GOTS1.<stationCode>.<slot>.<mac>` — 36 to 37 characters, QR version 2 at
 * ECC M in alphanumeric mode. The slot is 8 or 9 digits until 2065.
 *
 * The payload names nobody and authenticates nothing: identity arrives on the
 * POST from the member's own session, so a photograph of the screen reveals
 * nothing about the roster.
 */
export const STATION_TOKEN_REGEX = new RegExp(
  `^GOTS1\\.${CODE_CHAR_CLASS}{${STATION_CODE_LENGTH}}\\.\\d{8,9}\\.` +
    `${CODE_CHAR_CLASS}{${STATION_MAC_LENGTH}}$`,
);
