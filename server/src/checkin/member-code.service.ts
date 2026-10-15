import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { CODE_ALPHABET, CODE_CHAR_CLASS, MEMBER_CODE_LENGTH } from '@got/shared';

/**
 * The member-held fallback code, and why it exists.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS THE FALLBACK, NOT THE HAPPY PATH.
 *
 * The normal check-in is still §6's inversion: the station displays a rotating
 * QR and the member scans it with their own phone. That path's documented cost
 * (§6.10) is that the MEMBER'S HANDSET BECOMES A HARD NETWORK DEPENDENCY — a
 * dead access point, an expired data plan or a phone in a locker means no
 * check-in at all.
 *
 * This is the other direction, which §12.4 leaves open as "a documented
 * upgrade path, not a prohibition": the member's phone renders a code, staff
 * scan it at the desk, and the member's own connectivity stops mattering.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY IT IS SIGNED AND ROTATING, when the plain MEMBER_CODE path it sits
 * beside is neither:
 *
 * Decision #1 was rejected because a member-held badge can be screenshotted
 * and sent to a friend. A bare `memberCode` has exactly that problem — it is
 * six characters that never change, and a photograph of it works forever.
 * Binding the code to a 60-second slot means a screenshot is worthless within
 * a minute, which is what makes a member-held credential acceptable at all.
 *
 * It does NOT replace staff judgement: a person is standing at the counter
 * being looked at, which is the identity control decision #1 lost and this
 * path quietly gets back.
 *
 * WHAT THE PAYLOAD REVEALS. `memberCode` is in the clear, because the desk has
 * to resolve it and the MAC cannot be reversed into one. That is a narrower
 * exposure than the station display's: this renders on the member's OWN phone
 * for the seconds they hold it up, not on a wall-mounted screen facing a room
 * all day. The station payload still names nobody, and must not start to.
 */

/** `M` for member. Distinct from `GOTS1` so the two can never cross-verify. */
const FORMAT_TAG = 'GOTM1';

/** First 10 bytes of the HMAC digest, base32-encoded to exactly 16 characters. */
const MAC_DIGEST_BYTES = 10;

/**
 * Sixty seconds, not the station's thirty.
 *
 * A station display is glanced at and scanned immediately. This one is held up
 * by a person who has to unlock a phone, find the screen, and hand it across a
 * counter with a queue behind them. Thirty seconds means codes expiring in the
 * member's hand; sixty plus the ±1 slot tolerance gives up to two minutes,
 * which is generous enough to never be the reason a check-in fails and short
 * enough that a shared screenshot is useless.
 *
 * A constant rather than an env var on purpose: it is a property of how long a
 * human takes at a counter, not something an operator should tune per gym.
 */
export const MEMBER_CODE_SLOT_SECONDS = 60;

/**
 * Used ONLY to equalise the shape of work when the member code is unknown —
 * never a real row, never looked up. A syntactically valid UUID so the HMAC
 * input has the same shape as a real one.
 */
const DUMMY_USER_ID = '00000000-0000-0000-0000-000000000000';

const PAYLOAD_REGEX = new RegExp(
  `^${FORMAT_TAG}\\.(${CODE_CHAR_CLASS}{${MEMBER_CODE_LENGTH}})\\.(\\d{8,9})\\.(${CODE_CHAR_CLASS}{16})$`,
);

/** The real slot range runs out around 2110 at 60-second slots. */
const MAX_SLOT = 2_147_483_647;

export interface ParsedMemberCode {
  memberCode: string;
  slot: number;
  mac: string;
}

/** The minimum a caller must already know to verify. `null` for "no such code". */
export type MemberLookupResult = { userId: string } | null;

export type VerifyMemberCodeOutcome =
  /**
   * Unknown member code and a forged MAC are the SAME outcome, deliberately.
   * Distinguishing them would turn the desk scanner into an oracle for which
   * six-character codes are real — 32^6 is only about a billion, and a
   * distinguishable response makes enumerating them worth doing.
   */
  | { kind: 'INVALID' }
  /** The member's phone clock is ahead. An alarm, not a member action. */
  | { kind: 'NOT_YET_VALID' }
  | { kind: 'EXPIRED'; stalenessSeconds: number }
  | { kind: 'VALID'; userId: string; memberCode: string };

/**
 * Pure: sign, verify, slot window. No I/O — the member lookup and the clock
 * read are both parameters, so this is unit-testable without a database.
 *
 * The verification ORDER is the security property, and it mirrors the station
 * token's exactly: shape, then MAC, then the slot window. Checking expiry
 * before the MAC would let a forged payload learn whether its guessed slot was
 * current, which is a free oracle.
 */
@Injectable()
export class MemberCodeService {
  computeSlot(instant: Date, slotSeconds: number = MEMBER_CODE_SLOT_SECONDS): number {
    return Math.floor(instant.getTime() / 1000 / slotSeconds);
  }

  /** `notAfter` is THIS slot's end — never the verifier's extra look-back. */
  slotBounds(
    slot: number,
    slotSeconds: number = MEMBER_CODE_SLOT_SECONDS,
  ): { notBefore: Date; notAfter: Date } {
    const startSeconds = slot * slotSeconds;
    return {
      notBefore: new Date(startSeconds * 1000),
      notAfter: new Date((startSeconds + slotSeconds) * 1000),
    };
  }

  /** `GOTM1.<memberCode>.<slot>.<mac>` — the literal string a phone renders. */
  buildPayload(memberCode: string, slot: number, mac: string): string {
    return `${FORMAT_TAG}.${memberCode}.${slot}.${mac}`;
  }

  /** Signs one slot for one member. Always the CURRENT secret. */
  sign(userId: string, slot: number, secret: string): string {
    return this.computeMac(userId, slot, secret);
  }

  parsePayload(payload: string): ParsedMemberCode | null {
    const match = PAYLOAD_REGEX.exec(payload);
    if (!match) return null;

    const slot = Number(match[2]);
    if (!Number.isInteger(slot) || slot > MAX_SLOT) return null;

    return { memberCode: match[1], slot, mac: match[3] };
  }

  /**
   * `member` arrives ALREADY RESOLVED (or `null` for "no such code"), so an
   * unknown code and a forged MAC both still cause the same shaped HMAC work
   * against `DUMMY_USER_ID` before returning INVALID. The response time does
   * not distinguish them.
   */
  verify(params: {
    payload: string;
    member: MemberLookupResult;
    /** Tried in order: `[STATION_TOKEN_SECRET, STATION_TOKEN_SECRET_PREVIOUS?]`. */
    secrets: readonly string[];
    now: Date;
    slotSeconds?: number;
  }): VerifyMemberCodeOutcome {
    const slotSeconds = params.slotSeconds ?? MEMBER_CODE_SLOT_SECONDS;
    const parsed = this.parsePayload(params.payload);
    if (!parsed) return { kind: 'INVALID' };

    const found = params.member !== null;
    const userId = found ? params.member!.userId : DUMMY_USER_ID;

    const macMatches = params.secrets.some((secret) =>
      this.macEquals(parsed.mac, this.computeMac(userId, parsed.slot, secret)),
    );

    if (!found || !macMatches) return { kind: 'INVALID' };

    const currentSlot = this.computeSlot(params.now, slotSeconds);
    if (parsed.slot > currentSlot) return { kind: 'NOT_YET_VALID' };
    if (parsed.slot < currentSlot - 1) {
      return { kind: 'EXPIRED', stalenessSeconds: (currentSlot - parsed.slot) * slotSeconds };
    }

    return { kind: 'VALID', userId, memberCode: parsed.memberCode };
  }

  /**
   * The MAC covers the USER ID, never the member code.
   *
   * A member code can be reallocated; a user id cannot. Signing the code would
   * mean a reissued code inherits every signature ever minted for the previous
   * holder.
   */
  private computeMac(userId: string, slot: number, secret: string): string {
    const message = `${FORMAT_TAG}|${userId}|${slot}`;
    const digest = createHmac('sha256', secret).update(message).digest();
    return base32Encode(digest.subarray(0, MAC_DIGEST_BYTES));
  }

  /** Length-checked BEFORE `timingSafeEqual`, which throws on a length mismatch. */
  private macEquals(candidate: string, expected: string): boolean {
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
  }
}

/** Crockford base32 over the shared alphabet — same encoding the station uses. */
function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CODE_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) out += CODE_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
