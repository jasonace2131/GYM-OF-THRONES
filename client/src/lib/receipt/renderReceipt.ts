import type { ReceiptDoc } from './receiptDoc';

/**
 * The TRANSACTION SLIP renderer — a complete standalone HTML document.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS A DOCUMENT, NOT A FOURTH SURFACE.
 *
 * No navigation, no session chrome, no interactivity — and it is DELIBERATELY
 * isolated from portal.css / admin.css / desk.css. Do not "fix" that by
 * importing portal.css: globals.css sets html{background:#0b0b0d} and a light
 * body colour unconditionally, and Chrome's default print-color-adjust:economy
 * drops the background but KEEPS the light text — a near-white slip on white
 * paper. (client/src/app/(legal)/legal.css works around the same hazard.)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ESCAPING IS THE DEFAULT, NOT A DISCIPLINE. This string becomes a
 * same-origin srcdoc iframe, so an unescaped payer name / notes / voidReason
 * is XSS with reach into the Supabase token in localStorage. The tagged
 * template below escapes EVERY interpolation; nest a trusted fragment only
 * through raw().
 *
 * What is deliberately NOT printed (all legally load-bearing):
 * - the words Invoice / Official Receipt (unregistered software may not);
 * - "NOT VALID FOR CLAIM OF INPUT TAX" (belongs only on BIR-registered docs);
 * - any validity/expiry legend (abolished, RR 6-2022), Business Style
 *   (RMC 77-2024), or an ATP/OCN/PTU it does not have.
 * The `doc.notice` legend from the server is rendered verbatim instead.
 */

class Raw {
  constructor(readonly value: string) {}
}

/** Mark an already-rendered fragment as trusted for nesting. */
function raw(value: string): Raw {
  return new Raw(value);
}

const esc = (v: unknown): string =>
  String(v).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

/** Every interpolation is escaped; Raw fragments and arrays of them pass through. */
function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = '';
  strings.forEach((chunk, i) => {
    out += chunk;
    if (i >= values.length) return;
    const v = values[i];
    if (v === null || v === undefined || v === false) return;
    if (v instanceof Raw) out += v.value;
    else if (Array.isArray(v))
      out += v.map((item) => (item instanceof Raw ? item.value : esc(item))).join('');
    else out += esc(v);
  });
  return out;
}

/** 9000 → "90.00". The peso sign is a label on the slip, never in the number. */
function money(centavos: number): string {
  const sign = centavos < 0 ? '-' : '';
  const abs = Math.abs(centavos);
  const pesos = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  return `${sign}${pesos.toLocaleString('en-PH')}.${cents}`;
}

function clockLine(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-PH', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Manila',
  });
}

function row(label: string, value: string, strong = false): Raw {
  return raw(
    html`<div class="slip__row${strong ? ' slip__row--strong' : ''}"><span>${label}</span
      ><span>${value}</span></div>`,
  );
}

/**
 * 80mm thermal only for now — `format` is the seam a future A4 layout slots
 * into without touching call sites.
 */
export function renderReceiptHtml(
  doc: ReceiptDoc,
  opts: { copy: boolean; format?: 'THERMAL_80MM' },
): string {
  void opts.format;
  const seller: Raw[] = [];
  // A null line is OMITTED, never placeholdered — a plausible-looking wrong
  // TIN on a printed document is worse than an absence.
  if (doc.seller.tradeName !== null)
    seller.push(raw(html`<div class="slip__seller-name">${doc.seller.tradeName}</div>`));
  if (doc.seller.registeredName !== null && doc.seller.registeredName !== doc.seller.tradeName)
    seller.push(raw(html`<div>${doc.seller.registeredName}</div>`));
  if (doc.seller.address !== null) seller.push(raw(html`<div>${doc.seller.address}</div>`));
  if (doc.seller.tin !== null)
    seller.push(
      raw(
        html`<div>${doc.seller.vatRegistered ? 'VAT Reg TIN' : 'Non-VAT Reg TIN'}:
          ${doc.seller.tin}</div>`,
      ),
    );

  const totals: Raw[] = [row('Amount', money(doc.line.unitCostCentavos))];
  if (doc.showVatBlock) {
    totals.push(row('VATable Sales', money(doc.totals.vatableSalesCentavos)));
    totals.push(row('VAT-Exempt Sale', money(doc.totals.vatExemptSalesCentavos)));
    totals.push(row('VAT (12%)', money(doc.totals.vatAmountCentavos)));
  }
  if (doc.discount !== null) {
    totals.push(row(`Less: ${doc.discount.label}`, `-${money(doc.discount.centavos)}`));
    if (doc.showVatBlock && doc.discount.vatExemptionCentavos !== null) {
      totals.push(row('Less: 12% VAT exemption', `-${money(doc.discount.vatExemptionCentavos)}`));
    }
  }
  totals.push(row('AMOUNT DUE (PHP)', money(doc.totals.netCentavos), true));

  const discountBlock =
    doc.discount === null
      ? null
      : raw(html`
          <div class="slip__section">
            <div class="slip__row"><span>Discount</span><span>${doc.discount.label}</span></div>
            ${doc.discount.idNo === null
              ? null
              : row(doc.discount.type === 'PWD' ? 'PWD ID no.' : 'OSCA ID no.', doc.discount.idNo)}
            ${doc.discount.reason === null ? null : row('Reason', doc.discount.reason)}
            ${doc.discount.statutory
              ? raw(
                  // A physical counter sale: the online signature waiver does
                  // not apply, so the slip carries the line to sign.
                  html`<div class="slip__sig">
                    <div class="slip__sig-rule"></div>
                    <div>Signature (SC/PWD)</div>
                  </div>`,
                )
              : null}
          </div>
        `);

  const bands: Raw[] = [];
  if (doc.status === 'VOIDED') {
    bands.push(
      raw(
        html`<div class="slip__band">
          *** ${doc.voidKind === 'REFUND' ? 'REFUNDED' : 'VOIDED — NOT A RECORD OF PAYMENT'} ***
        </div>`,
      ),
    );
    if (doc.voidedAt !== null) bands.push(row('Voided', clockLine(doc.voidedAt)));
    if (doc.voidReason !== null) bands.push(row('Reason', doc.voidReason));
  }
  if (opts.copy) bands.push(raw(html`<div class="slip__band">*** REPRINT ***</div>`));

  return html`<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>${doc.docNo}</title>
        <style>
          /* margin:0 also hides Chrome's own URL/date header and footer. */
          @page {
            size: 80mm auto;
            margin: 0;
          }
          html,
          body {
            margin: 0;
            padding: 0;
            background: #fff;
            color: #000;
          }
          .slip {
            width: 72mm; /* 80mm paper, 72mm printable at 203 dpi */
            margin: 0 auto;
            padding: 3mm 0 10mm; /* bottom pad = feed before the cut */
            /* No web font: display:swap can reflow mid-print. */
            font: 11px/1.35 'Courier New', ui-monospace, monospace;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .slip__center {
            text-align: center;
          }
          .slip__seller-name {
            font-weight: 700;
            font-size: 13px;
          }
          .slip__title {
            text-align: center;
            font-weight: 700;
            letter-spacing: 1px;
            margin: 2mm 0 1mm;
          }
          .slip__section {
            border-top: 1px dashed #000;
            margin-top: 2mm;
            padding-top: 2mm;
          }
          .slip__row {
            display: flex;
            justify-content: space-between;
            gap: 3mm;
          }
          .slip__row span:last-child {
            text-align: right;
          }
          .slip__row--strong {
            font-weight: 700;
            font-size: 12.5px;
            margin-top: 1mm;
          }
          .slip__totals,
          .slip__band,
          .slip__sig {
            break-inside: avoid;
            page-break-inside: avoid;
          }
          /* Needs print-color-adjust: exact above, or it prints as nothing. */
          .slip__band {
            background: #000;
            color: #fff;
            text-align: center;
            font-weight: 700;
            padding: 1.5mm 0;
            margin-top: 2mm;
          }
          .slip__sig {
            margin-top: 6mm;
          }
          .slip__sig-rule {
            border-bottom: 1px solid #000;
            height: 6mm;
          }
          .slip__notice {
            margin-top: 3mm;
            text-align: center;
            font-size: 9.5px;
          }
        </style>
      </head>
      <body>
        <div class="slip">
          <div class="slip__center">${seller}</div>

          <div class="slip__title">TRANSACTION SLIP</div>
          <div class="slip__center">${doc.docNo}</div>
          <div class="slip__center">${clockLine(doc.issuedAt)}</div>

          <div class="slip__section">
            ${row('Sold to', doc.buyer.name ?? 'Walk-in guest')}
            ${doc.buyer.memberCode === null ? null : row('Member code', doc.buyer.memberCode)}
          </div>

          <div class="slip__section">
            <div>${doc.line.description}</div>
            ${row(`${doc.line.quantity} × ${money(doc.line.unitCostCentavos)}`, money(doc.line.quantity * doc.line.unitCostCentavos))}
          </div>

          <div class="slip__section slip__totals">${totals}</div>

          ${discountBlock}

          <div class="slip__section">
            ${row('Paid by', doc.payment.method)}
            ${doc.payment.reference === null ? null : row('GCash ref', doc.payment.reference)}
            ${doc.payment.gcashVerified ? row('Verified', 'seen in GCash app') : null}
            ${row('Received', clockLine(doc.payment.receivedAt))}
          </div>

          <div class="slip__section">
            ${row('BIR Invoice No.', doc.birInvoiceNo ?? '________________')}
            ${row('Recorded by', doc.recordedByName)}
          </div>

          ${bands}

          <div class="slip__notice">${doc.notice}</div>
        </div>
      </body>
    </html>`;
}
