import type { Payment } from '@prisma/client';
import { civilDateFromPrisma, type CivilDate } from '../common/time/gym-time';

/**
 * The printable TRANSACTION SLIP, composed here and nowhere else.
 *
 * PURE — no clock, no Prisma client, no config service. `now` and the seller
 * block arrive as parameters, exactly like `presentCheckIn`, because most of
 * what this file encodes is statute and statute deserves unit tests.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A "TRANSACTION SLIP" AND NOT AN INVOICE.
 *
 * Under RA 11976 + RR 7-2024 the Invoice is the primary document for a sale
 * of services, and any machine OR SOFTWARE issuing one must be BIR-registered
 * — no revenue threshold. This CRM is not registered. So the slip:
 *   - is titled TRANSACTION SLIP (never "Invoice" / "Official Receipt" —
 *     using those on unregistered software is use of unregistered invoices);
 *   - carries the legend in `notice` below (RR 11-2004 §12 permits internal
 *     control documents PROVIDED registered invoices are issued for sales);
 *   - does NOT print "NOT VALID FOR CLAIM OF INPUT TAX" — that legend belongs
 *     only on BIR-registered supplementary documents and on unregistered
 *     output it falsely implies registration;
 *   - never prints a validity/expiry legend (abolished, RR 6-2022), a
 *     "Business Style" field (RMC 77-2024), or an ATP/OCN/PTU it lacks;
 *   - prints "BIR Invoice No.: ____" from Payment.receiptNo — the line that
 *     ties the booklet number to the system row, which payment.prisma names
 *     as the actual reconciliation problem.
 *
 * VAT RENDERING IS LEGALLY LOAD-BEARING IN BOTH DIRECTIONS. A non-VAT seller
 * printing anything VAT-shaped incurs the VAT with no input credit plus a 50%
 * surcharge (RR 7-2024 D.1); a VAT-registered seller omitting the VAT-exempt
 * breakdown on an SC/PWD sale is liable as if the exemption did not apply
 * (D.2). `showVatBlock` is therefore a SERVER decision the client renders,
 * never a client conditional.
 *
 * THE STORED COLUMNS ARE AUTHORITATIVE — computeAmounts is never re-run. A
 * repriced plan or a flipped GYM_VAT_REGISTERED must not rewrite a slip
 * already handed over. Only derivations of stored figures happen here.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface ReceiptSeller {
  registeredName: string | null;
  tradeName: string | null;
  address: string | null;
  tin: string | null;
  vatRegistered: boolean;
}

export interface ReceiptDoc {
  docNo: string;
  issuedAt: string;
  seller: ReceiptSeller;
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
    businessDate: CivilDate;
    receivedAt: string;
  };
  birInvoiceNo: string | null;
  status: 'RECORDED' | 'VOIDED';
  voidKind: 'VOID' | 'REFUND' | null;
  voidedAt: string | null;
  voidReason: string | null;
  recordedByName: string;
  /** Legally load-bearing copy, composed server-side so it changes in ONE place. */
  notice: string;
}

const DISCOUNT_LABELS: Readonly<Record<string, string>> = {
  SENIOR: 'Senior citizen (20%)',
  PWD: 'PWD (20%)',
  PROMO: 'Promo',
  STAFF: 'Staff',
  GUEST_PASS: 'Guest pass',
  GOODWILL: 'Goodwill',
};

const NOTICE =
  'INTERNAL RECORD — NOT A BIR-REGISTERED INVOICE. Ask the counter for your BIR Invoice.';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDay(iso: CivilDate): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

/**
 * The slip's document number.
 *
 * Derived, not sequenced: no legal sequencing duty on a supplementary slip,
 * stable across reprints AND across a void (so "a void keeps its number"
 * holds for free), and spec §5.10's "no receiptNo sequence" non-goal is
 * untouched. If this app is ever BIR-registered, the number becomes a real
 * serial from an approved range and a DocumentCounter is built to THAT spec.
 *
 * EXPORTED so the payment DETAIL drawer can print the same number the printed
 * slip carries. Two derivations of one identifier is two things that can
 * disagree, and the one place a person notices is when they hold the paper
 * next to the screen.
 */
export function paymentDocNo(id: string, businessDate: CivilDate): string {
  return `GOT-${businessDate.replace(/-/g, '')}-${id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

type ReceiptRow = Payment & {
  user: { firstName: string; lastName: string; memberCode: string | null } | null;
  recordedBy: { firstName: string; lastName: string };
};

export function toReceiptDoc(row: ReceiptRow, seller: ReceiptSeller, now: Date): ReceiptDoc {
  const businessDate = civilDateFromPrisma(row.businessDate);

  // One derivation, shared with the payment detail drawer — see paymentDocNo.
  const docNo = paymentDocNo(row.id, businessDate);

  const vatAmountCentavos = row.grossCentavos - row.vatBaseCentavos;

  const statutory = row.discountType === 'SENIOR' || row.discountType === 'PWD';
  const discount =
    row.discountType === 'NONE'
      ? null
      : {
          type: row.discountType as string,
          label: DISCOUNT_LABELS[row.discountType] ?? row.discountType,
          statutory,
          idNo: row.statutoryIdNo,
          reason: row.discountReason,
          centavos: row.discountCentavos,
          // The 12% the statutory buyer did not pay — meaningful only for a
          // VAT-registered seller; null suppresses the line entirely.
          vatExemptionCentavos:
            statutory && seller.vatRegistered && row.vatExempt ? vatAmountCentavos : null,
        };

  const description =
    row.purpose === 'MEMBERSHIP' && row.termStartsOn !== null && row.termEndsOn !== null
      ? `${row.planName}, ${shortDay(civilDateFromPrisma(row.termStartsOn))} – ${shortDay(
          civilDateFromPrisma(row.termEndsOn),
        )}`
      : row.planName;

  const normalized = row.referenceNormalized;

  return {
    docNo,
    issuedAt: now.toISOString(),
    seller,
    buyer:
      row.user === null
        ? { name: null, memberCode: null }
        : {
            name: `${row.user.firstName} ${row.user.lastName}`.trim(),
            memberCode: row.user.memberCode,
          },
    line: { description, quantity: 1, unitCostCentavos: row.grossCentavos },
    totals: {
      grossCentavos: row.grossCentavos,
      vatableSalesCentavos: row.vatExempt ? 0 : row.vatBaseCentavos,
      vatExemptSalesCentavos: row.vatExempt ? row.vatBaseCentavos : 0,
      vatAmountCentavos,
      vatBaseCentavos: row.vatBaseCentavos,
      discountCentavos: row.discountCentavos,
      netCentavos: row.netCentavos,
    },
    showVatBlock: seller.vatRegistered,
    discount,
    payment: {
      method: row.method as 'CASH' | 'GCASH',
      reference: row.reference,
      referenceTail: normalized === null || normalized.length < 4 ? null : normalized.slice(-4),
      gcashVerified: row.gcashVerifiedAt !== null,
      businessDate,
      receivedAt: row.receivedAt.toISOString(),
    },
    birInvoiceNo: row.receiptNo,
    status: row.status as 'RECORDED' | 'VOIDED',
    voidKind: row.voidKind,
    voidedAt: row.voidedAt === null ? null : row.voidedAt.toISOString(),
    voidReason: row.voidReason,
    recordedByName: `${row.recordedBy.firstName} ${row.recordedBy.lastName}`.trim(),
    notice: NOTICE,
  };
}
