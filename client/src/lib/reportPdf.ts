/**
 * Report PDF export.
 *
 * `jspdf` is imported DYNAMICALLY so it never joins the admin bundle — the
 * same rule `setupCardPdf.ts` follows, and for the same reason: a 300 kB
 * library that three people press once a month must not be in the payload of
 * every screen a front-desk tablet loads.
 *
 * Deliberately plain: a report is a table of facts an owner hands to a
 * bookkeeper, so this draws a title, a range, and rows. No charts, no logo
 * fetch, no web fonts — every one of those is a way for an export to fail at
 * the moment somebody needs it.
 */

export interface PdfTable {
  title: string;
  /** Column headers, left to right. */
  columns: string[];
  /** Rows, already formatted as strings — this file never formats money. */
  rows: string[][];
  /** Optional one-line summary under the table, e.g. totals. */
  footnote?: string;
}

export interface PdfReport {
  /** Document title, also the PDF's own metadata title. */
  title: string;
  /** Rendered under the title, e.g. "1 Jan 2026 – 31 Jan 2026". */
  subtitle: string;
  tables: PdfTable[];
  /** File name without the extension. */
  fileName: string;
}

const MARGIN = 14;
const LINE = 5.2;

export async function downloadReportPdf(report: PdfReport): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  let y = MARGIN;

  /** New page when the next block would cross the bottom margin. */
  const ensure = (needed: number): void => {
    if (y + needed <= pageHeight - MARGIN) return;
    doc.addPage();
    y = MARGIN;
  };

  doc.setProperties({ title: report.title });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(report.title, MARGIN, y);
  y += 6;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(90);
  doc.text(report.subtitle, MARGIN, y);
  y += 4;
  doc.text(`Generated ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}`, MARGIN, y);
  doc.setTextColor(0);
  y += 8;

  for (const table of report.tables) {
    ensure(24);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.text(table.title, MARGIN, y);
    y += 5.5;

    const usable = pageWidth - MARGIN * 2;
    const colWidth = usable / table.columns.length;

    doc.setFontSize(9);
    doc.setTextColor(90);
    table.columns.forEach((column, index) => {
      doc.text(column, MARGIN + colWidth * index, y);
    });
    doc.setTextColor(0);
    y += 2;
    doc.setDrawColor(200);
    doc.line(MARGIN, y, pageWidth - MARGIN, y);
    y += 3.6;

    doc.setFont('helvetica', 'normal');
    if (table.rows.length === 0) {
      doc.setTextColor(140);
      doc.text('No rows in this range.', MARGIN, y);
      doc.setTextColor(0);
      y += LINE;
    } else {
      for (const row of table.rows) {
        ensure(LINE + 4);
        row.forEach((cell, index) => {
          // Truncated rather than wrapped: a report row that silently becomes
          // two lines makes every row below it land somewhere unexpected.
          const text = cell.length > 26 ? `${cell.slice(0, 25)}…` : cell;
          doc.text(text, MARGIN + colWidth * index, y);
        });
        y += LINE;
      }
    }

    if (table.footnote !== undefined) {
      ensure(LINE + 2);
      y += 1.5;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.text(table.footnote, MARGIN, y);
      doc.setFont('helvetica', 'normal');
      y += LINE;
    }

    y += 5;
  }

  doc.save(`${report.fileName}.pdf`);
}

/**
 * The same data as a CSV, for a bookkeeper who wants to sort it.
 *
 * Formula injection guard: a cell starting with = + - or @ is prefixed with a
 * single quote, because Excel executes those. The statutory register applies
 * the same rule server-side.
 */
export function downloadCsv(fileName: string, columns: string[], rows: string[][]): void {
  const cell = (value: string): string => {
    const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
    return `"${guarded.replace(/"/g, '""')}"`;
  };
  const body = [columns, ...rows].map((row) => row.map(cell).join(',')).join('\r\n');

  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${fileName}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
