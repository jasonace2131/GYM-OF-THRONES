import { AmountsError, DiscountType, computeAmounts, roundHalfUp, type Amounts } from '@got/shared';
import type { DiscountTypeCode } from '@/lib/adminApi';

/**
 * The discount a counter operator enters, and the total it produces.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TOTAL IS NEVER TYPED (owner, 2026-10-08).
 *
 * The operator picks a discount type and, for the discretionary four, a
 * percentage or a peso amount. Everything else is worked out: the peso figure
 * from the percentage, and the total from `computeAmounts` — the SAME shared
 * function the server writes the payment with, so the figure on screen is the
 * figure that lands in the register, to the centavo.
 *
 * Pure and framework-free so it is testable without rendering anything (the
 * client has no `@testing-library/react`).
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type DiscountMode = 'PERCENT' | 'AMOUNT';

/** The one-tap percentages offered beside the input. */
export const PERCENT_PRESETS = [10, 20, 50] as const;

export const STATUTORY_TYPES: readonly DiscountTypeCode[] = ['SENIOR', 'PWD'];
export const DISCRETIONARY_TYPES: readonly DiscountTypeCode[] = [
  'PROMO',
  'STAFF',
  'GUEST_PASS',
  'GOODWILL',
];

export function isStatutory(type: DiscountTypeCode | ''): boolean {
  return type !== '' && STATUTORY_TYPES.includes(type);
}

export function isDiscretionary(type: DiscountTypeCode | ''): boolean {
  return type !== '' && DISCRETIONARY_TYPES.includes(type);
}

/**
 * Keeps only what a money or percentage box can hold: digits and one decimal
 * point, at most two places after it.
 */
export function cleanDiscountInput(raw: string): string {
  const digits = raw.replace(/[^\d.]/g, '');
  const dot = digits.indexOf('.');
  if (dot === -1) return digits;
  return `${digits.slice(0, dot)}.${digits
    .slice(dot + 1)
    .replace(/\./g, '')
    .slice(0, 2)}`;
}

export type ParsedDiscount =
  { kind: 'empty' } | { kind: 'ok'; centavos: number } | { kind: 'invalid'; message: string };

/**
 * The operator's entry, in centavos off the list price.
 *
 * A percentage is taken of the LIST price and rounded half-up once, the way
 * `computeAmounts` rounds. Anything above the price is refused here rather
 * than left for the server to refuse: there are no negative payments.
 */
export function parseDiscount(
  mode: DiscountMode,
  raw: string,
  priceCentavos: number,
): ParsedDiscount {
  const text = raw.trim();
  if (text === '' || text === '.') return { kind: 'empty' };

  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) {
    return { kind: 'invalid', message: 'Enter a number.' };
  }

  if (mode === 'PERCENT') {
    if (value > 100) {
      return { kind: 'invalid', message: 'A discount cannot be more than 100%.' };
    }
    return { kind: 'ok', centavos: roundHalfUp((priceCentavos * value) / 100) };
  }

  const centavos = Math.round(value * 100);
  if (centavos > priceCentavos) {
    return { kind: 'invalid', message: 'A discount cannot be more than the price.' };
  }
  return { kind: 'ok', centavos };
}

/**
 * The money for a sale: gross, the discount, the VAT taken off for a
 * statutory sale, and the total due.
 *
 * `null` while something it needs is still unknown — the price, or (for a
 * statutory discount only) whether the gym is VAT-registered — or when the
 * shared core refuses the figures. The screen then shows a dash, never a
 * guessed number.
 */
export function saleAmounts(input: {
  priceCentavos: number | null;
  discountType: DiscountTypeCode | '';
  /** `null` while the gym config is loading. Only a statutory sale needs it. */
  vatRegistered: boolean | null;
  operatorDiscountCentavos: number;
}): Amounts | null {
  if (input.priceCentavos === null) return null;
  const type = input.discountType === '' ? 'NONE' : input.discountType;
  if (isStatutory(type) && input.vatRegistered === null) return null;

  try {
    return computeAmounts({
      priceCentavos: input.priceCentavos,
      // The boundary cast this repo makes wherever a literal union meets the
      // shared TS enum — same strings, different nominal types.
      discountType: type as unknown as DiscountType,
      vatRegistered: input.vatRegistered ?? false,
      operatorDiscountCentavos: input.operatorDiscountCentavos,
    });
  } catch (caught) {
    if (caught instanceof AmountsError) return null;
    throw caught;
  }
}

/** "10%" when the discount is a whole or two-place percentage of the price, else null. */
export function percentOf(discountCentavos: number, priceCentavos: number): string | null {
  if (priceCentavos <= 0 || discountCentavos <= 0) return null;
  const percent = Math.round((discountCentavos / priceCentavos) * 10000) / 100;
  return `${percent}%`;
}
