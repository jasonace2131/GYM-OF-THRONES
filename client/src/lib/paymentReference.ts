import { PAYMENT_REFERENCE_MAX, PAYMENT_REFERENCE_MIN } from '@got/shared';

/**
 * The one e-wallet reference rule the API holds every sale to (owner rule 4,
 * loose): trimmed, 4–64 characters, at least one letter or digit.
 */
export function isPaymentReference(raw: string): boolean {
  const value = raw.trim();
  return (
    value.length >= PAYMENT_REFERENCE_MIN &&
    value.length <= PAYMENT_REFERENCE_MAX &&
    /[A-Za-z0-9]/.test(value)
  );
}

export const PAYMENT_REFERENCE_HINT = `A reference is ${PAYMENT_REFERENCE_MIN}–${PAYMENT_REFERENCE_MAX} characters with at least one letter or digit.`;

/**
 * What a sale form says about its reference. Only a GCash sale has one: for
 * cash a leftover reference typed before switching method is ignored (and not
 * sent), so it can never disable Save.
 */
export function saleReferenceProblem(method: string, reference: string): string | null {
  if (method !== 'GCASH') return null;
  if (reference.trim() === '') return 'Enter the GCash reference from the member’s screen.';
  return isPaymentReference(reference) ? null : PAYMENT_REFERENCE_HINT;
}

/** The reference to send: trimmed, and only for a GCash sale. */
export function saleReference(method: string, reference: string): string | undefined {
  return method === 'GCASH' && reference.trim() !== '' ? reference.trim() : undefined;
}
