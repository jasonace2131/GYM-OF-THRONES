import { describe, expect, it } from 'vitest';
import { renderReceiptHtml } from './renderReceipt';
import type { ReceiptDoc } from './receiptDoc';

function doc(overrides: Partial<ReceiptDoc> = {}): ReceiptDoc {
  return {
    docNo: 'GOT-20260903-A3F1C9',
    issuedAt: '2026-09-03T02:00:00.000Z',
    seller: {
      registeredName: 'GOT Fitness OPC',
      tradeName: 'Gym of Thrones',
      address: '4th Floor, JWMGI Building, Taguig City 1630',
      tin: '987-654-321-00000',
      vatRegistered: false,
    },
    buyer: { name: 'Nino Cruz', memberCode: null },
    line: { description: 'Walk-in day pass', quantity: 1, unitCostCentavos: 9000 },
    totals: {
      grossCentavos: 9000,
      vatableSalesCentavos: 0,
      vatExemptSalesCentavos: 0,
      vatAmountCentavos: 0,
      vatBaseCentavos: 9000,
      discountCentavos: 0,
      netCentavos: 9000,
    },
    showVatBlock: false,
    discount: null,
    payment: {
      method: 'CASH',
      reference: null,
      referenceTail: null,
      gcashVerified: false,
      businessDate: '2026-09-03',
      receivedAt: '2026-09-03T01:00:00.000Z',
    },
    birInvoiceNo: null,
    status: 'RECORDED',
    voidKind: null,
    voidedAt: null,
    voidReason: null,
    recordedByName: 'Rachel Nguyen',
    notice:
      'INTERNAL RECORD — NOT A BIR-REGISTERED INVOICE. Ask the counter for your BIR Invoice.',
    ...overrides,
  };
}

const XSS = '"><script>alert(1)</script>';

describe('renderReceiptHtml', () => {
  it('escapes every interpolated field — the srcdoc is same-origin', () => {
    const rendered = renderReceiptHtml(
      doc({
        buyer: { name: XSS, memberCode: XSS },
        voidReason: XSS,
        status: 'VOIDED',
        voidKind: 'VOID',
        voidedAt: '2026-09-03T02:00:00.000Z',
        discount: {
          type: 'GOODWILL',
          label: 'Goodwill',
          statutory: false,
          idNo: null,
          reason: XSS,
          centavos: 100,
          vatExemptionCentavos: null,
        },
      }),
      { copy: false },
    );
    expect(rendered).not.toContain('<script');
    expect(rendered).toContain('&lt;script&gt;');
  });

  it('non-VAT senior: 90.00 / 18.00 / 72.00 and no VAT line anywhere', () => {
    const rendered = renderReceiptHtml(
      doc({
        totals: {
          grossCentavos: 9000,
          vatableSalesCentavos: 0,
          vatExemptSalesCentavos: 0,
          vatAmountCentavos: 0,
          vatBaseCentavos: 9000,
          discountCentavos: 1800,
          netCentavos: 7200,
        },
        discount: {
          type: 'SENIOR',
          label: 'Senior citizen (20%)',
          statutory: true,
          idNo: 'OSCA-12345',
          reason: null,
          centavos: 1800,
          vatExemptionCentavos: null,
        },
      }),
      { copy: false },
    );
    expect(rendered).toContain('90.00');
    expect(rendered).toContain('18.00');
    expect(rendered).toContain('72.00');
    expect(rendered).not.toContain('VATable');
    expect(rendered).not.toContain('VAT (12%)');
    expect(rendered).toContain('OSCA-12345');
    expect(rendered).toContain('Signature (SC/PWD)');
  });

  it('VAT-registered senior prints the mandatory VAT-exempt breakdown', () => {
    const rendered = renderReceiptHtml(
      doc({
        showVatBlock: true,
        totals: {
          grossCentavos: 112000,
          vatableSalesCentavos: 0,
          vatExemptSalesCentavos: 100000,
          vatAmountCentavos: 12000,
          vatBaseCentavos: 100000,
          discountCentavos: 20000,
          netCentavos: 80000,
        },
        discount: {
          type: 'SENIOR',
          label: 'Senior citizen (20%)',
          statutory: true,
          idNo: 'OSCA-1',
          reason: null,
          centavos: 20000,
          vatExemptionCentavos: 12000,
        },
      }),
      { copy: false },
    );
    expect(rendered).toContain('VAT-Exempt Sale');
    expect(rendered).toContain('1,000.00');
    expect(rendered).toContain('12% VAT exemption');
  });

  it('bands VOIDED and REFUNDED differently', () => {
    const voided = renderReceiptHtml(
      doc({ status: 'VOIDED', voidKind: 'VOID', voidedAt: '2026-09-03T02:00:00.000Z' }),
      { copy: false },
    );
    expect(voided).toContain('VOIDED — NOT A RECORD OF PAYMENT');
    const refunded = renderReceiptHtml(
      doc({ status: 'VOIDED', voidKind: 'REFUND', voidedAt: '2026-09-03T02:00:00.000Z' }),
      { copy: false },
    );
    expect(refunded).toContain('*** REFUNDED ***');
    expect(refunded).not.toContain('NOT A RECORD OF PAYMENT');
  });

  it('bands REPRINT only on a copy', () => {
    expect(renderReceiptHtml(doc(), { copy: true })).toContain('REPRINT');
    expect(renderReceiptHtml(doc(), { copy: false })).not.toContain('REPRINT');
  });

  it('omits a null seller TIN line entirely — never a placeholder', () => {
    const rendered = renderReceiptHtml(
      doc({
        seller: {
          registeredName: null,
          tradeName: 'Gym of Thrones',
          address: null,
          tin: null,
          vatRegistered: false,
        },
      }),
      { copy: false },
    );
    expect(rendered).not.toContain('TIN');
  });

  it('never claims to be an invoice, and carries the legend verbatim', () => {
    const rendered = renderReceiptHtml(doc(), { copy: false });
    expect(rendered).toContain('TRANSACTION SLIP');
    expect(rendered).toContain('NOT A BIR-REGISTERED INVOICE');
    // "BIR Invoice No." is a reference to the booklet, allowed; the document
    // must not TITLE itself an invoice or receipt.
    expect(rendered).not.toMatch(/OFFICIAL RECEIPT/i);
    expect(rendered).not.toMatch(/input tax/i);
  });
});
