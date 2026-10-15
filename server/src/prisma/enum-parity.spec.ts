import * as shared from '@got/shared';
import {
  AccessVerdict as PrismaAccessVerdict,
  CheckInMethod as PrismaCheckInMethod,
  DenialReason as PrismaDenialReason,
  DiscountType as PrismaDiscountType,
  MembershipStatus as PrismaMembershipStatus,
  PaymentMethod as PrismaPaymentMethod,
  PaymentPurpose as PrismaPaymentPurpose,
  PaymentStatus as PrismaPaymentStatus,
  PlanKind as PrismaPlanKind,
} from '@prisma/client';
import {
  AccessVerdict,
  CheckInMethod,
  CODE_ALPHABET,
  CODE_CHAR_CLASS,
  DenialReason,
  DiscountType,
  MembershipStatus,
  PaymentMethod,
  PaymentPurpose,
  PaymentStatus,
  PlanKind,
  STATION_TOKEN_REGEX,
} from '@got/shared';
import { MIRRORED_ENUM_PAIRS, PENDING_PRISMA_MIRRORS } from './mirrored-enums';

/**
 * Prisma cannot import from @got/shared, so every enum both runtimes switch on
 * is duplicated by hand. These tests are the only thing stopping the two from
 * drifting apart — a drifted DenialReason renders a blank verdict card in a
 * member's hand at the counter.
 *
 * The table lives in mirrored-enums.ts so that adding an enum to @got/shared
 * without either pairing it or declaring the chunk it lands in is a failing
 * test rather than a silent omission.
 */

/**
 * A TypeScript string enum compiles to an object whose every value is a string
 * and — by this codebase's convention — whose every key equals its own value.
 * API_ROUTES (nested objects and functions), PAGINATION_DEFAULTS (numbers) and
 * STATION_TOKEN_REGEX (no own enumerable entries) all fail that test, which is
 * exactly what we want: they are not enums and must not be listed.
 */
function isStringEnum(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(([key, entryValue]) => typeof entryValue === 'string' && key === entryValue);
}

describe('Prisma ↔ shared enum parity', () => {
  it.each(MIRRORED_ENUM_PAIRS.map((pair) => [pair.name, pair] as const))(
    '%s matches its Prisma mirror',
    (_name, pair) => {
      expect(Object.values(pair.prisma).sort()).toEqual(Object.values(pair.shared).sort());
    },
  );

  it('lists every enum exported by @got/shared exactly once', () => {
    const exported = Object.entries(shared)
      .filter(([, value]) => isStringEnum(value))
      .map(([name]) => name)
      .sort();

    const declared = [
      ...MIRRORED_ENUM_PAIRS.map((pair) => pair.name),
      ...PENDING_PRISMA_MIRRORS.map((pending) => pending.name),
    ].sort();

    expect(declared).toEqual(exported);
  });

  it('declares no enum as both paired and pending', () => {
    const paired = MIRRORED_ENUM_PAIRS.map((pair) => pair.name);
    const pending = PENDING_PRISMA_MIRRORS.map((entry) => entry.name);
    expect(paired.filter((name) => pending.includes(name))).toEqual([]);
  });
});

describe('shared code alphabet', () => {
  it('CODE_CHAR_CLASS accepts exactly the characters in CODE_ALPHABET', () => {
    const charClass = new RegExp(`^${CODE_CHAR_CLASS}$`);
    for (const character of CODE_ALPHABET) {
      expect(charClass.test(character)).toBe(true);
    }
  });

  it('CODE_CHAR_CLASS rejects the four ambiguous letters', () => {
    const charClass = new RegExp(`^${CODE_CHAR_CLASS}$`);
    for (const character of ['I', 'L', 'O', 'U']) {
      expect(charClass.test(character)).toBe(false);
    }
  });

  it('STATION_TOKEN_REGEX accepts a four-character station code and rejects five', () => {
    expect(STATION_TOKEN_REGEX.test('GOTS1.9F2K.55512345.ABCDEFGHJKMNPQRS')).toBe(true);
    expect(STATION_TOKEN_REGEX.test('GOTS1.9F2KX.55512345.ABCDEFGHJKMNPQRS')).toBe(false);
  });
});

/**
 * One it() per enum this chunk mirrors, in the same commit that adds the Prisma
 * side. The data-driven test above proves the TABLE agrees; these prove the
 * table names the enums a reader expects to find in it, so deleting a row is a
 * failing test rather than a silently shorter loop.
 */
describe('chunk 1 mirrored enums', () => {
  it('MembershipStatus is exactly the four spec values on both sides', () => {
    expect(Object.values(PrismaMembershipStatus).sort()).toEqual(
      ['ACTIVE', 'CANCELLED', 'EXPIRED', 'FROZEN'].sort(),
    );
    expect(Object.values(MembershipStatus).sort()).toEqual(
      Object.values(PrismaMembershipStatus).sort(),
    );
  });

  it('PlanKind matches its Prisma mirror', () => {
    expect(Object.values(PrismaPlanKind).sort()).toEqual(Object.values(PlanKind).sort());
  });

  it('PaymentPurpose matches its Prisma mirror', () => {
    expect(Object.values(PrismaPaymentPurpose).sort()).toEqual(
      Object.values(PaymentPurpose).sort(),
    );
  });

  it('PaymentMethod matches its Prisma mirror', () => {
    expect(Object.values(PrismaPaymentMethod).sort()).toEqual(Object.values(PaymentMethod).sort());
  });

  it('PaymentStatus matches its Prisma mirror', () => {
    expect(Object.values(PrismaPaymentStatus).sort()).toEqual(Object.values(PaymentStatus).sort());
  });

  it('DiscountType matches its Prisma mirror', () => {
    expect(Object.values(PrismaDiscountType).sort()).toEqual(Object.values(DiscountType).sort());
  });

  it('AccessVerdict ships with exactly ALLOWED and ALLOWED_IN_GRACE', () => {
    // §7.7 route 48 mentions an ALLOWED_OVERRIDE that §6.4.1 says does not
    // exist — an override writes CheckInDenial.outcome = OVERRIDDEN instead.
    // Adding an enum value later is additive; removing one makes Prisma
    // recreate the table and take every hand-written CHECK with it.
    expect(Object.values(PrismaAccessVerdict).sort()).toEqual(['ALLOWED', 'ALLOWED_IN_GRACE']);
    expect(Object.values(AccessVerdict).sort()).toEqual(Object.values(PrismaAccessVerdict).sort());
  });

  it('DenialReason ships all TEN values now, not §5.2 six', () => {
    // Mirroring the short list now and widening it in chunk 2 is the
    // enum-removal migration shape that silently drops CHECK constraints.
    expect(Object.values(PrismaDenialReason).sort()).toEqual(
      [
        'ACCOUNT_DEACTIVATED',
        'ACCOUNT_SUSPENDED',
        'ALREADY_CHECKED_IN',
        'CHECKIN_DAILY_LIMIT',
        'GYM_CLOSED',
        'MEMBERSHIP_CANCELLED',
        'MEMBERSHIP_EXPIRED',
        'MEMBERSHIP_FROZEN',
        'NO_MEMBERSHIP',
        'STATION_TOKEN_EXPIRED',
      ].sort(),
    );
    expect(Object.values(DenialReason).sort()).toEqual(Object.values(PrismaDenialReason).sort());
  });

  it('leaves nothing pending — CheckInMethod landed this chunk', () => {
    expect(PENDING_PRISMA_MIRRORS).toEqual([]);
  });
});

/**
 * One it() per enum chunk 2 mirrors, in the same commit that adds the Prisma
 * side — same discipline as the chunk-1 block above.
 */
describe('chunk 2 mirrored enums', () => {
  it('CheckInMethod ships exactly the three §6.0.2 values on both sides', () => {
    // No SELF_QR, no SELF_QUEUED, no SELF_KIOSK in v1 — §6.10.2.
    expect(Object.values(PrismaCheckInMethod).sort()).toEqual(
      ['MANUAL', 'MEMBER_CODE', 'STATION_QR'].sort(),
    );
    expect(Object.values(CheckInMethod).sort()).toEqual(Object.values(PrismaCheckInMethod).sort());
  });

  it('pairs eleven enums in total', () => {
    expect(MIRRORED_ENUM_PAIRS).toHaveLength(11);
  });
});
