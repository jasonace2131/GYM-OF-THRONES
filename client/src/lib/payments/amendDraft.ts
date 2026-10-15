import { AmountsError, DiscountType, computeAmounts, type Amounts } from '@got/shared';
import type {
  AmendPaymentBody,
  DiscountTypeCode,
  PaymentDetail,
  PaymentMethodCode,
} from '@/lib/adminApi';

/**
 * The amend form's state, and the three pure functions around it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE, AND IN ITS OWN MODULE, BECAUSE THIS IS THE PART WORTH TESTING.
 *
 * The client has no `@testing-library/react` — `vitest.config.ts` says so
 * itself — so the logic that decides WHAT GETS SENT lives here, where it can
 * be tested without rendering anything. `AmendPaymentModal` is the thin shell
 * around it.
 *
 * `previewAmounts` calls the SHARED `computeAmounts` from `@got/shared`, the
 * same function the server writes the row with. It is not a reimplementation
 * and must never become one: the statutory branch divides by 1.12 only for a
 * VAT-registered seller and rounds half-up once, and a second copy would
 * differ by a centavo on exactly the sales the BIR register is about.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface AmendDraft {
  /** Why the correction is being made. Required, ≥ 3 characters. */
  reason: string;
  planCode: string;
  method: PaymentMethodCode;
  reference: string;
  gcashVerified: boolean;
  discountType: DiscountTypeCode;
  discountCentavos: number;
  statutoryIdNo: string;
  discountReason: string;
  receiptNo: string;
  notes: string;
}

const STATUTORY: DiscountTypeCode[] = ['SENIOR', 'PWD'];
const DISCRETIONARY: DiscountTypeCode[] = ['PROMO', 'STAFF', 'GUEST_PASS', 'GOODWILL'];

/** Every nullable column becomes `''`, so an input always has a value. */
export function initialDraft(detail: PaymentDetail): AmendDraft {
  return {
    reason: '',
    planCode: detail.planCode,
    method: detail.method,
    reference: detail.reference ?? '',
    gcashVerified: detail.gcashVerified,
    discountType: detail.discountType,
    discountCentavos: detail.discountCentavos,
    statutoryIdNo: detail.statutoryIdNo ?? '',
    discountReason: detail.discountReason ?? '',
    receiptNo: detail.receiptNo ?? '',
    notes: detail.notes ?? '',
  };
}

/**
 * The draft, normalised the way the server will read it.
 *
 * A CASH row carrying a GCash reference and a named attestation is nonsense,
 * and `Payment_gcash_verified_shape` refuses the attestation outright. Rather
 * than leave the server to inherit them, switching to CASH clears both HERE,
 * so what the operator sees in the preview is what gets written.
 */
function normalised(draft: AmendDraft): AmendDraft {
  if (draft.method === 'CASH') {
    return { ...draft, reference: '', gcashVerified: false };
  }
  return draft;
}

/**
 * What to POST — or `null` when nothing changed, so Save can be disabled
 * HONESTLY.
 *
 * A Save that fires on an unchanged form voids a live payment and re-records
 * an identical one: a correction that corrects nothing, leaving a voided row
 * in the register for somebody to explain later.
 *
 * `''` is emitted as a CLEAR; an untouched field is omitted entirely and
 * inherits on the server. Those are different instructions and the two must
 * not collapse into one.
 */
export function amendBody(detail: PaymentDetail, raw: AmendDraft): AmendPaymentBody | null {
  const draft = normalised(raw);
  const body: AmendPaymentBody = { reason: draft.reason.trim() };
  let changed = false;

  const text = (
    key: 'reference' | 'statutoryIdNo' | 'discountReason' | 'receiptNo' | 'notes',
    original: string | null,
  ): void => {
    if (draft[key] === (original ?? '')) return;
    body[key] = draft[key];
    changed = true;
  };

  if (draft.planCode !== detail.planCode) {
    body.planCode = draft.planCode;
    changed = true;
  }
  if (draft.method !== detail.method) {
    body.method = draft.method;
    changed = true;
  }
  if (draft.discountType !== detail.discountType) {
    body.discountType = draft.discountType;
    changed = true;
  }
  if (draft.discountCentavos !== detail.discountCentavos) {
    body.discountCentavos = draft.discountCentavos;
    changed = true;
  }
  // Only meaningful on a GCASH row — `normalised` has already forced it false
  // for CASH, which makes this comparison equal for a CASH original and so
  // emits nothing.
  if (draft.method === 'GCASH' && draft.gcashVerified !== detail.gcashVerified) {
    body.gcashVerified = draft.gcashVerified;
    changed = true;
  }

  text('reference', detail.reference);
  text('statutoryIdNo', detail.statutoryIdNo);
  text('discountReason', detail.discountReason);
  text('receiptNo', detail.receiptNo);
  text('notes', detail.notes);

  return changed ? body : null;
}

/**
 * The first thing wrong with the draft, in the words the counter would use —
 * or `null` when it is well formed.
 *
 * These mirror server-side refusals the amend would hit anyway
 * (`GCASH_REFERENCE_REQUIRED`, `STATUTORY_ID_REQUIRED`,
 * `DISCOUNT_ID_REQUIRED`, `CONFIRMATION_REQUIRED`'s reason length). Catching
 * them here is a courtesy, not a control: every one of them is still enforced
 * on the server.
 */
export function draftProblem(draft: AmendDraft): string | null {
  if (draft.reason.trim().length < 3) {
    return 'Say why this payment is being corrected — at least 3 characters.';
  }
  if (draft.method === 'GCASH' && draft.reference.trim() === '') {
    return 'A GCash payment needs the reference from the member’s screen.';
  }
  if (STATUTORY.includes(draft.discountType) && draft.statutoryIdNo.trim() === '') {
    return 'Enter the OSCA or PWD ID number — BIR keeps that register separately.';
  }
  if (DISCRETIONARY.includes(draft.discountType) && draft.discountReason.trim().length < 3) {
    return 'A discretionary discount needs a reason of at least 3 characters.';
  }
  // A ₱0 promo is a discount type with no discount: the total would not move,
  // which is exactly the confusion the owner reported (2026-10-08).
  if (DISCRETIONARY.includes(draft.discountType) && draft.discountCentavos <= 0) {
    return 'Enter the discount, as a percentage or a peso amount.';
  }
  return null;
}

/**
 * What the corrected row will be worth, computed with the SAME function the
 * server writes it with.
 *
 * `plan` is whichever price applies — the newly selected plan's, or the
 * original's gross when the plan is unchanged. `vatRegistered` comes off the
 * payment (`PaymentDetail.vatRegistered`) and is never guessed here: the
 * statutory branch's answer depends on it.
 *
 * `null` when the shared core refuses the figures — a discount above the list
 * price, say. The preview then shows nothing rather than a negative peso
 * amount.
 */
export function previewAmounts(
  draft: AmendDraft,
  plan: { priceCentavos: number },
  vatRegistered: boolean,
): Amounts | null {
  try {
    return computeAmounts({
      priceCentavos: plan.priceCentavos,
      // The boundary cast this repo already makes everywhere a literal union
      // meets the shared TS enum — same strings, different nominal types.
      discountType: draft.discountType as unknown as DiscountType,
      vatRegistered,
      operatorDiscountCentavos: draft.discountCentavos,
    });
  } catch (caught) {
    if (caught instanceof AmountsError) return null;
    throw caught;
  }
}
