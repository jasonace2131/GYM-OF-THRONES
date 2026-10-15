import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { CODE_ALPHABET, CODE_CHAR_CLASS, STATION_CODE_LENGTH } from '@got/shared';

/** Payload-format version. `S` for station, per §6.1.1. */
const FORMAT_TAG = 'GOTS1';

/** First 10 bytes of the HMAC digest, base32-encoded to exactly 16 characters. */
const MAC_DIGEST_BYTES = 10;

/**
 * Used ONLY to equalise the shape of work when the real station is unknown or
 * inactive (§6.1.2 step 3) — never a real row, never looked up. A syntactically
 * valid UUID so the HMAC input has the same shape as a real one.
 */
const DUMMY_STATION_ID = '00000000-0000-0000-0000-000000000000';
const DUMMY_TOKEN_EPOCH = 1;

const PAYLOAD_REGEX = new RegExp(
  `^${FORMAT_TAG}\\.(${CODE_CHAR_CLASS}{${STATION_CODE_LENGTH}})\\.(\\d{8,9})\\.(${CODE_CHAR_CLASS}{16})$`,
);

/** The real slot range runs out around 2065 — see STATION_TOKEN_REGEX's own comment. */
const MAX_SLOT = 2_147_483_647;

export interface ParsedStationToken {
  stationCode: string;
  slot: number;
  mac: string;
}

/** What the MAC covers — never `code`, never `gymCode`, per §6.1.2. */
export interface StationTokenSubject {
  stationId: string;
  tokenEpoch: number;
}

/** The minimum a caller must already know about a station to verify against it. */
export type StationLookupResult = (StationTokenSubject & { isActive: boolean }) | null;

export type VerifyStationTokenOutcome =
  /**
   * Unknown station, inactive station, wrong epoch and a forged MAC are all
   * this ONE outcome — collapsed deliberately (§6.1.2) so a member-facing
   * response cannot distinguish "no such station" from "someone guessed
   * wrong". The caller logs which one it actually was.
   */
  | { kind: 'INVALID' }
  /** A station-clock alarm, never a member action (§6.1.3). */
  | { kind: 'NOT_YET_VALID' }
  | { kind: 'EXPIRED'; stationId: string; slot: number; tokenStalenessSeconds: number }
  | { kind: 'VALID'; stationId: string; slot: number };

/**
 * Pure: sign, verify, slot window. No I/O — every station lookup and every
 * clock read is a parameter, so this is unit-testable without a database or a
 * fake timer.
 *
 * The verification ORDER inside `verify()` is the security property (§6.1.2):
 * the MAC is checked before the slot window is even consulted, and neither is
 * checked before shape (the DTO's regex, upstream of this service). Getting
 * that order right is what stops a forged payload from writing anything.
 */
@Injectable()
export class StationTokenService {
  /** `Math.floor(epochSeconds / slotSeconds)` — the station display's own clock. */
  computeSlot(instant: Date, slotSeconds: number): number {
    return Math.floor(instant.getTime() / 1000 / slotSeconds);
  }

  /** The wall-clock bounds of a slot — `notAfter` is THIS slot's end, never the verifier's look-back. */
  slotBounds(slot: number, slotSeconds: number): { notBefore: Date; notAfter: Date } {
    const startSeconds = slot * slotSeconds;
    return {
      notBefore: new Date(startSeconds * 1000),
      notAfter: new Date((startSeconds + slotSeconds) * 1000),
    };
  }

  /** `GOTS1.<stationCode>.<slot>.<mac>` — the literal string a display renders into a QR. */
  buildPayload(stationCode: string, slot: number, mac: string): string {
    return `${FORMAT_TAG}.${stationCode}.${slot}.${mac}`;
  }

  /**
   * Signs one slot for one station under one secret. Always the CURRENT
   * secret — signing never uses `STATION_TOKEN_SECRET_PREVIOUS`, which is
   * verify-only by construction (its type is a plain `string`, not a tuple
   * position this method accepts).
   */
  sign(subject: StationTokenSubject, slot: number, secret: string): string {
    return this.computeMac(subject.stationId, subject.tokenEpoch, slot, secret);
  }

  /**
   * Parses and shape-checks a payload already known to have passed the DTO's
   * regex. Re-validated here anyway because this service must be safe to call
   * with arbitrary input in a unit test, independent of the pipe.
   */
  parsePayload(payload: string): ParsedStationToken | null {
    const match = PAYLOAD_REGEX.exec(payload);
    if (!match) return null;

    const slot = Number(match[2]);
    if (!Number.isInteger(slot) || slot > MAX_SLOT) return null;

    return { stationCode: match[1], slot, mac: match[3] };
  }

  /**
   * The full verification order from §6.1.2 / §7.2's "Station-token
   * verification order — normative" table, steps 3–4 (step 1, shape, is the
   * DTO; step 2, the lookup, and step 5, gym hours, are the caller's job —
   * this service is pure).
   *
   * `station` is passed in ALREADY RESOLVED (or `null` for "not found"), so a
   * caller that found nothing and a caller that found an inactive row both
   * still cause a same-shaped HMAC computation against `DUMMY_STATION_ID`
   * before returning INVALID — the response time does not distinguish "no
   * such station" from "forged MAC for a real one". Only a genuinely active
   * station with a genuinely matching MAC ever reaches the slot window.
   */
  verify(params: {
    payload: string;
    station: StationLookupResult;
    /** Tried in order: `[STATION_TOKEN_SECRET, STATION_TOKEN_SECRET_PREVIOUS?]`. */
    secrets: readonly string[];
    now: Date;
    slotSeconds: number;
  }): VerifyStationTokenOutcome {
    const parsed = this.parsePayload(params.payload);
    if (!parsed) return { kind: 'INVALID' };

    const stationFound = params.station !== null && params.station.isActive;
    const subject: StationTokenSubject = stationFound
      ? { stationId: params.station!.stationId, tokenEpoch: params.station!.tokenEpoch }
      : { stationId: DUMMY_STATION_ID, tokenEpoch: DUMMY_TOKEN_EPOCH };

    // Every branch below runs the SAME shaped work (one HMAC per secret,
    // constant-time compared) whether or not a real station was found.
    const macMatches = params.secrets.some((secret) =>
      this.macEquals(
        parsed.mac,
        this.computeMac(subject.stationId, subject.tokenEpoch, parsed.slot, secret),
      ),
    );

    if (!stationFound || !macMatches) {
      return { kind: 'INVALID' };
    }

    const currentSlot = this.computeSlot(params.now, params.slotSeconds);
    if (parsed.slot > currentSlot) {
      return { kind: 'NOT_YET_VALID' };
    }
    if (parsed.slot < currentSlot - 1) {
      return {
        kind: 'EXPIRED',
        stationId: subject.stationId,
        slot: parsed.slot,
        tokenStalenessSeconds: (currentSlot - parsed.slot) * params.slotSeconds,
      };
    }

    return { kind: 'VALID', stationId: subject.stationId, slot: parsed.slot };
  }

  private computeMac(stationId: string, tokenEpoch: number, slot: number, secret: string): string {
    const message = `${FORMAT_TAG}|${stationId}|${tokenEpoch}|${slot}`;
    const digest = createHmac('sha256', secret).update(message).digest();
    return base32Encode(digest.subarray(0, MAC_DIGEST_BYTES));
  }

  /** Length-checked BEFORE `timingSafeEqual`, which throws on a length mismatch rather than failing closed. */
  private macEquals(candidate: string, expected: string): boolean {
    const candidateBuf = Buffer.from(candidate, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (candidateBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(candidateBuf, expectedBuf);
  }
}

/**
 * Crockford base32 (this project's `CODE_ALPHABET`), no padding. 10 bytes is
 * exactly 80 bits, and 80 / 5 = 16 whole groups, so the output is always
 * exactly 16 characters with nothing left over to pad.
 */
function base32Encode(bytes: Buffer): string {
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');

  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += CODE_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}
