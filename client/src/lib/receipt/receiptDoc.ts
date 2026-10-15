/**
 * The `GET /payments/:id/receipt` payload, mirroring
 * `server/src/payments/receipt.presenter.ts` field for field.
 *
 * Declared here rather than in @got/shared for the same reason PaymentSummary
 * is already declared independently on both sides: there is no shared payments
 * type today, and the receipt is one endpoint consumed by one renderer. Keep
 * the two files in sync by hand — a drift shows up as a blank line on a slip,
 * not a crash.
 */
export interface ReceiptDoc {
  docNo: string;
  issuedAt: string;
  seller: {
    registeredName: string | null;
    tradeName: string | null;
    address: string | null;
    tin: string | null;
    vatRegistered: boolean;
  };
  buyer: { name: string | null; memberCode: string | null };
  line: { description: string; quantity: number; unitCostCentavos: number };
  totals: {
    grossCentavos: number;
    vatableSalesCentavos: number;
    vatExemptSalesCentavos: number;
    vatAmountCentavos: number;
    vatBaseCentavos: number;
    discountCentavos: number;
    netCentavos: number;
  };
  showVatBlock: boolean;
  discount: null | {
    type: string;
    label: string;
    statutory: boolean;
    idNo: string | null;
    reason: string | null;
    centavos: number;
    vatExemptionCentavos: number | null;
  };
  payment: {
    method: 'CASH' | 'GCASH';
    reference: string | null;
    referenceTail: string | null;
    gcashVerified: boolean;
    businessDate: string;
    receivedAt: string;
  };
  birInvoiceNo: string | null;
  status: 'RECORDED' | 'VOIDED';
  voidKind: 'VOID' | 'REFUND' | null;
  voidedAt: string | null;
  voidReason: string | null;
  recordedByName: string;
  /** Legally load-bearing copy, composed server-side. Render verbatim. */
  notice: string;
}
