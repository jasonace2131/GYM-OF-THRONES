import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/** Six digits, uniformly from 000000..999999. `draw` is a seam for tests only. */
export function generateLoginCode(
  draw: (min: number, max: number) => number = (min, max) => randomInt(min, max),
): string {
  return draw(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * HMAC-SHA256, keyed by IP_HASH_PEPPER, over `login-code:v1:<sessionId>:<code>`.
 *
 * Keyed, because a million six-digit codes are trivially brute-forced from a
 * plain hash, and a leaked table without the server secret is useless.
 * Domain-separated (`login-code:v1`) so this pepper's other use (hashing IPs)
 * can never produce a colliding value, and bound to the sign-in so a code is
 * worthless on any other session.
 */
export function hashLoginCode(pepper: string, sessionId: string, code: string): string {
  return createHmac('sha256', pepper).update(`login-code:v1:${sessionId}:${code}`).digest('hex');
}

/** Constant-time comparison of two hex HMACs. False, never a throw, on a malformed input. */
export function loginCodeMatches(presentedHash: string, storedHash: string): boolean {
  const presented = Buffer.from(presentedHash, 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return presented.length === 32 && stored.length === 32 && timingSafeEqual(presented, stored);
}
