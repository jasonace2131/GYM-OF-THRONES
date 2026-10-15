import { describe, expect, it } from 'vitest';
import { DiscountType, computeAmounts } from '@got/shared';
import type { PaymentDetail } from '@/lib/adminApi';
import { amendBody, draftProblem, initialDraft, previewAmounts } from './amendDraft';

/** A live CASH walk-in with nothing optional set. */
const CASH: PaymentDetail = {
  id: 'p1',
  userId: null,
  payerName: null,
  membershipId: null,
  purpose: 'WALK_IN',
  status: 'RECORDED',
  planCode: 'WALKIN',
  planName: 'Walk-in day pass',
  grossCentavos: 9000,
  vatBaseCentavos: 9000,
  discountType: 'NONE',
  discountCentavos: 0,
  netCentavos: 9000,
  vatExempt: false,
  statutoryIdNo: null,
  discountReason: null,
  termMonths: null,
  termStartsOn: null,
  termEndsOn: null,
  method: 'CASH',
  reference: null,
  receiptNo: null,
  receiptIssued: false,
  receivedAt: '2026-09-14T02:00:00.000Z',
  businessDate: '2026-09-14',
  shiftId: 's1',
  recordedById: 'u1',
  voidedAt: null,
  voidedById: null,
  voidReason: null,
  voidKind: null,
  notes: null,
  docNo: 'GOT-20260914-ABCDEF',
  payerMemberCode: null,
  recordedByName: 'Sam Tarly',
  voidedByName: null,
  archivedByName: null,
  archivedAt: null,
  gcashVerified: false,
  gcashVerifiedAt: null,
  gcashVerifiedByName: null,
  hasProof: false,
  replacesPaymentId: null,
  replacedByPaymentId: null,
  checkIn: null,
  membership: null,
  vatRegistered: false,
};

const GCASH: PaymentDetail = {
  ...CASH,
  method: 'GCASH',
  reference: '6028 871 884223',
  gcashVerified: true,
  gcashVerifiedAt: '2026-09-14T02:10:00.000Z',
  gcashVerifiedByName: 'Jon Snow',
  receiptNo: 'INV-0042',
  receiptIssued: true,
  notes: 'paid at the counter',
};

describe('initialDraft', () => {
  it('turns every nullable column into an empty string, so an input has a value', () => {
    const draft = initialDraft(CASH);
    expect(draft).toMatchObject({
      planCode: 'WALKIN',
      method: 'CASH',
      reference: '',
      receiptNo: '',
      notes: '',
      statutoryIdNo: '',
      discountReason: '',
      discountType: 'NONE',
      discountCentavos: 0,
      gcashVerified: false,
      reason: '',
    });
  });
});

describe('amendBody', () => {
  /**
   * The honest Save button. A modal whose Save is enabled when nothing has
   * changed sends a request that voids a live payment and re-records an
   * identical one — a correction that corrects nothing, with a voided row in
   * the register to explain afterwards.
   */
  it('returns null when nothing changed, however long the reason is', () => {
    const draft = { ...initialDraft(CASH), reason: 'I typed a reason but changed no field' };
    expect(amendBody(CASH, draft)).toBeNull();
  });

  it('emits ONLY the fields that changed', () => {
    const draft = { ...initialDraft(CASH), planCode: 'MONTHLY', reason: 'rang the wrong plan' };
    expect(amendBody(CASH, draft)).toEqual({
      reason: 'rang the wrong plan',
      planCode: 'MONTHLY',
    });
  });

  /**
   * `''` is the operator saying "there is no booklet number after all".
   * `undefined` is "I did not touch it". The server reads them differently, so
   * the client has to keep them apart.
   */
  it('emits an empty string as a CLEAR, and omits an untouched field entirely', () => {
    const cleared = { ...initialDraft(GCASH), receiptNo: '', reason: 'no invoice was issued' };
    const body = amendBody(GCASH, cleared);

    expect(body).not.toBeNull();
    expect(body).toHaveProperty('receiptNo', '');
    // Untouched, therefore absent — not sent as null, not sent as ''.
    expect(Object.keys(body!)).not.toContain('notes');
    expect(Object.keys(body!)).not.toContain('planCode');
  });

  /**
   * A CASH row carrying a GCash reference and an attestation is nonsense —
   * and `Payment_gcash_verified_shape` refuses the attestation outright. The
   * client drops both explicitly rather than leaving the server to inherit
   * them.
   */
  it('drops the reference and the attestation when the method becomes CASH', () => {
    const draft = { ...initialDraft(GCASH), method: 'CASH' as const, reason: 'it was cash' };
    const body = amendBody(GCASH, draft);

    expect(body).toMatchObject({ method: 'CASH', reference: '' });
    expect(Object.keys(body!)).not.toContain('gcashVerified');
  });

  it('carries the reference and the attestation when the method stays GCASH', () => {
    const draft = {
      ...initialDraft(GCASH),
      reference: '6028 871 999999',
      reason: 'mis-keyed the reference',
    };
    expect(amendBody(GCASH, draft)).toEqual({
      reason: 'mis-keyed the reference',
      reference: '6028 871 999999',
    });
  });

  it('emits the discount trio together when a discount is introduced', () => {
    const draft = {
      ...initialDraft(CASH),
      discountType: 'GOODWILL' as const,
      discountCentavos: 1000,
      discountReason: 'machine was down',
      reason: 'agreed a goodwill discount',
    };
    expect(amendBody(CASH, draft)).toEqual({
      reason: 'agreed a goodwill discount',
      discountType: 'GOODWILL',
      discountCentavos: 1000,
      discountReason: 'machine was down',
    });
  });
});

describe('draftProblem', () => {
  it('refuses a GCASH method with a blank reference, before anything is sent', () => {
    const draft = { ...initialDraft(CASH), method: 'GCASH' as const, reason: 'it was GCash' };
    expect(draftProblem(draft)).toMatch(/reference/i);
  });

  it('refuses a statutory discount with no ID number', () => {
    const draft = { ...initialDraft(CASH), discountType: 'SENIOR' as const, reason: 'senior' };
    expect(draftProblem(draft)).toMatch(/OSCA|PWD|ID/i);
  });

  it('refuses a discretionary discount with a reason under three characters', () => {
    const draft = {
      ...initialDraft(CASH),
      discountType: 'PROMO' as const,
      discountReason: 'ok',
      reason: 'promo',
    };
    expect(draftProblem(draft)).toMatch(/reason/i);
  });

  it('refuses a discretionary discount worth nothing', () => {
    const draft = {
      ...initialDraft(CASH),
      discountType: 'PROMO' as const,
      discountReason: 'grand opening',
      discountCentavos: 0,
      reason: 'forgot the promo',
    };
    expect(draftProblem(draft)).toMatch(/percentage or a peso amount/i);
    expect(draftProblem({ ...draft, discountCentavos: 15000 })).toBeNull();
  });

  it('refuses an amend reason under three characters', () => {
    expect(draftProblem({ ...initialDraft(CASH), reason: 'x' })).toMatch(/why/i);
  });

  it('is null for a well-formed draft', () => {
    expect(draftProblem({ ...initialDraft(CASH), reason: 'rang the wrong plan' })).toBeNull();
  });
});

describe('previewAmounts', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════
   * THE PARITY THAT JUSTIFIES LIFTING `computeAmounts` INTO `@got/shared`.
   *
   * The statutory branch divides by 1.12 only for a VAT-registered seller, and
   * rounds half-up ONCE. A second implementation on the client would differ by
   * a centavo on exactly the sales the BIR register is about, and the screen
   * would disagree with the row the server wrote.
   * ═══════════════════════════════════════════════════════════════════════
   */
  it.each([true, false])('matches computeAmounts for SENIOR at vatRegistered=%s', (vat) => {
    const draft = {
      ...initialDraft(CASH),
      discountType: 'SENIOR' as const,
      statutoryIdNo: 'OSCA-1234',
      reason: 'senior discount was missed',
    };

    expect(previewAmounts(draft, { priceCentavos: 80_000 }, vat)).toEqual(
      computeAmounts({
        priceCentavos: 80_000,
        discountType: DiscountType.SENIOR,
        vatRegistered: vat,
      }),
    );
  });

  it('matches computeAmounts for a discretionary discount', () => {
    const draft = {
      ...initialDraft(CASH),
      discountType: 'GOODWILL' as const,
      discountCentavos: 1000,
      discountReason: 'machine was down',
      reason: 'goodwill',
    };

    expect(previewAmounts(draft, { priceCentavos: 9000 }, false)).toEqual(
      computeAmounts({
        priceCentavos: 9000,
        discountType: DiscountType.GOODWILL,
        vatRegistered: false,
        operatorDiscountCentavos: 1000,
      }),
    );
  });

  /** A discount above the list price is refused by the shared core; the
   *  preview shows nothing rather than a negative peso figure. */
  it('returns null rather than a negative figure when the discount exceeds the price', () => {
    const draft = {
      ...initialDraft(CASH),
      discountType: 'GOODWILL' as const,
      discountCentavos: 999_999,
      discountReason: 'typo',
      reason: 'goodwill',
    };
    expect(previewAmounts(draft, { priceCentavos: 9000 }, false)).toBeNull();
  });
});
