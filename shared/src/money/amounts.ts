import { DiscountType } from '../types/membership.types';

/**
 * The statutory money arithmetic, in ONE place for both runtimes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LIFTED OUT OF `server/src/membership/membership-terms.ts` SO THERE IS
 * EXACTLY ONE COPY.
 *
 * The admin console's amend preview has to show the operator what the
 * corrected figure will be BEFORE they press Save. Computing that in the
 * client would be a second implementation of RA 9994 / RA 10754's 20% on the
 * VAT-exclusive base — two things to get wrong, and the one that is wrong is
 * the one nobody notices, because the server writes the right number and the
 * screen shows a different one.
 *
 * `membership-terms.ts` re-exports these under their original names, so no
 * server caller changed. It also wraps `computeAmounts` to translate
 * `AmountsError` into the `DomainException` the HTTP layer already renders —
 * `@got/shared` cannot import `@nestjs/common`, which is the only reason the
 * error type below exists rather than the exception itself.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PURE. No clock, no config service, no DI. Every configurable value arrives
 * on the input object.
 */

export interface Amounts {
  grossCentavos: number;
  vatBaseCentavos: number;
  discountCentavos: number;
  netCentavos: number;
  vatExempt: boolean;
}

export interface AmountsInput {
  priceCentavos: number;
  discountType: DiscountType;
  vatRegistered: boolean;
  operatorDiscountCentavos?: number;
}

/**
 * A refusal from the arithmetic itself.
 *
 * Carries the `PAYMENT_AMOUNT_MISMATCH` code verbatim so the server's wrapper
 * is a translation rather than a decision — the code is chosen here, once,
 * next to the rule that produced it.
 */
export class AmountsError extends Error {
  readonly code = 'PAYMENT_AMOUNT_MISMATCH';

  constructor(message: string) {
    super(message);
    this.name = 'AmountsError';
  }
}

/** Half-up to the centavo. Every money value in this system is non-negative. */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

/**
 * §5.7.4. Staff never type an amount for a statutory discount: they select the
 * type and enter the OSCA/PWD ID, and this computes. Rounding is applied ONCE
 * and all three results are stored, never recomputed on read.
 */
export function computeAmounts(input: AmountsInput): Amounts {
  const grossCentavos = input.priceCentavos;

  if (input.discountType === DiscountType.SENIOR || input.discountType === DiscountType.PWD) {
    const vatExempt = input.vatRegistered;
    const vatBaseCentavos = input.vatRegistered ? roundHalfUp(grossCentavos / 1.12) : grossCentavos;
    const discountCentavos = roundHalfUp(vatBaseCentavos * 0.2);
    return {
      grossCentavos,
      vatBaseCentavos,
      discountCentavos,
      netCentavos: vatBaseCentavos - discountCentavos,
      vatExempt,
    };
  }

  const discountCentavos =
    input.discountType === DiscountType.NONE ? 0 : (input.operatorDiscountCentavos ?? 0);

  if (!Number.isInteger(discountCentavos) || discountCentavos < 0) {
    throw new AmountsError('A discount must be a whole, non-negative number of centavos.');
  }
  if (discountCentavos > grossCentavos) {
    throw new AmountsError(
      'A discount cannot exceed the list price — there are no negative payments.',
    );
  }

  return {
    grossCentavos,
    vatBaseCentavos: grossCentavos,
    discountCentavos,
    netCentavos: grossCentavos - discountCentavos,
    vatExempt: false,
  };
}
