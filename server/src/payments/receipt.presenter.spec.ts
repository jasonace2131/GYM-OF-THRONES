import { toReceiptDoc, type ReceiptSeller } from './receipt.presenter';

const NOW = new Date('2026-09-03T02:00:00.000Z');

const SELLER: ReceiptSeller = {
  registeredName: 'GOT Fitness OPC',
  tradeName: 'Gym of Thrones',
  address: '4th Floor, JWMGI Building, Taguig City 1630',
  tin: '987-654-321-00000',
  vatRegistered: false,
};

function row(overrides: Partial<Record<string, unknown>> = {}): Parameters<typeof toReceiptDoc>[0] {
  return {
    id: 'a3f1c9d2-0000-4000-8000-000000000000',
    userId: null,
    membershipId: null,
    planId: 'p',
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
    referenceNormalized: null,
    gcashVerifiedAt: null,
    gcashVerifiedById: null,
    receiptNo: null,
    receiptIssued: false,
    receivedAt: new Date('2026-09-03T01:00:00.000Z'),
    businessDate: new Date('2026-09-03T00:00:00.000Z'),
    shiftId: 's',
    recordedById: 'r',
    notes: null,
    idempotencyKey: 'k',
    idempotencyHash: '0'.repeat(64),
    voidedAt: null,
    voidedById: null,
    voidReason: null,
    voidKind: null,
    createdAt: NOW,
    updatedAt: NOW,
    user: null,
    recordedBy: { firstName: 'Rachel', lastName: 'Nguyen' },
    ...overrides,
  } as unknown as Parameters<typeof toReceiptDoc>[0];
}

describe('toReceiptDoc', () => {
  it('derives a stable, dated docNo from the payment id — never a sequence', () => {
    const doc = toReceiptDoc(row(), SELLER, NOW);
    expect(doc.docNo).toBe('GOT-20260903-A3F1C9');
    // Stable across a void: same row voided keeps its number.
    const voided = toReceiptDoc(
      row({ status: 'VOIDED', voidedAt: NOW, voidedById: 'x', voidReason: 'r', voidKind: 'VOID' }),
      SELLER,
      NOW,
    );
    expect(voided.docNo).toBe(doc.docNo);
  });

  /**
   * A non-VAT seller printing anything VAT-shaped incurs the VAT with no
   * input credit plus a 50% surcharge (RR 7-2024 D.1). ₱90 senior: 20% off
   * the full price, no VAT lines anywhere.
   */
  it('non-VAT senior: 9000 gross, 1800 discount, 7200 due, VAT block off', () => {
    const doc = toReceiptDoc(
      row({
        discountType: 'SENIOR',
        discountCentavos: 1800,
        netCentavos: 7200,
        statutoryIdNo: 'OSCA-12345',
      }),
      SELLER,
      NOW,
    );
    expect(doc.showVatBlock).toBe(false);
    expect(doc.totals).toMatchObject({
      grossCentavos: 9000,
      discountCentavos: 1800,
      netCentavos: 7200,
      vatAmountCentavos: 0,
    });
    expect(doc.discount).toMatchObject({
      statutory: true,
      idNo: 'OSCA-12345',
      vatExemptionCentavos: null,
    });
  });

  /**
   * A VAT-registered seller omitting the VAT-exempt breakdown on an SC/PWD
   * sale is liable as if Sec. 109 did not apply (RR 7-2024 D.2).
   * ₱1,120 senior: base 1,000.00, discount 200.00, due 800.00, VAT 120.00.
   */
  it('VAT-registered senior: the exemption breakdown foots and is mandatory', () => {
    const doc = toReceiptDoc(
      row({
        grossCentavos: 112000,
        vatBaseCentavos: 100000,
        discountType: 'SENIOR',
        discountCentavos: 20000,
        netCentavos: 80000,
        vatExempt: true,
        statutoryIdNo: 'OSCA-1',
      }),
      { ...SELLER, vatRegistered: true },
      NOW,
    );
    expect(doc.showVatBlock).toBe(true);
    expect(doc.totals).toMatchObject({
      vatAmountCentavos: 12000,
      vatExemptSalesCentavos: 100000,
      vatableSalesCentavos: 0,
      netCentavos: 80000,
    });
    expect(doc.discount?.vatExemptionCentavos).toBe(12000);
  });

  it('renders VOIDED and REFUNDED as distinct shapes', () => {
    const voided = toReceiptDoc(
      row({ status: 'VOIDED', voidedAt: NOW, voidedById: 'x', voidReason: 'oops', voidKind: 'VOID' }),
      SELLER,
      NOW,
    );
    expect(voided.status).toBe('VOIDED');
    expect(voided.voidKind).toBe('VOID');
    const refunded = toReceiptDoc(
      row({ status: 'VOIDED', voidedAt: NOW, voidedById: 'x', voidReason: 'r', voidKind: 'REFUND' }),
      SELLER,
      NOW,
    );
    expect(refunded.voidKind).toBe('REFUND');
  });

  it('keeps a null seller field null — omitted by the renderer, never placeholdered', () => {
    const doc = toReceiptDoc(row(), { ...SELLER, tin: null, registeredName: null }, NOW);
    expect(doc.seller.tin).toBeNull();
    expect(doc.seller.registeredName).toBeNull();
  });

  it('describes a membership line with its term window', () => {
    const doc = toReceiptDoc(
      row({
        purpose: 'MEMBERSHIP',
        planName: '1-Month Gym Membership',
        termMonths: 1,
        termStartsOn: new Date('2026-09-03T00:00:00.000Z'),
        termEndsOn: new Date('2026-10-02T00:00:00.000Z'),
      }),
      SELLER,
      NOW,
    );
    expect(doc.line.description).toBe('1-Month Gym Membership, 03 Sep 2026 – 02 Oct 2026');
    expect(doc.line.quantity).toBe(1);
  });

  it('carries the GCash tail and attestation, and only the fixed legend', () => {
    const doc = toReceiptDoc(
      row({
        method: 'GCASH',
        reference: '6028 871 884223',
        referenceNormalized: '6028871884223',
        gcashVerifiedAt: NOW,
        gcashVerifiedById: 'staff',
      }),
      SELLER,
      NOW,
    );
    expect(doc.payment.referenceTail).toBe('4223');
    expect(doc.payment.gcashVerified).toBe(true);
    expect(doc.notice).toContain('NOT A BIR-REGISTERED INVOICE');
    // The input-tax legend belongs only on BIR-registered documents.
    expect(doc.notice).not.toMatch(/input tax/i);
  });
});
