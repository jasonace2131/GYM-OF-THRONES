import { renderReceiptHtml } from './renderReceipt';
import type { ReceiptDoc } from './receiptDoc';

/**
 * Hidden-iframe print driver.
 *
 * The wart, documented rather than "fixed": `afterprint` fires on CANCEL too,
 * and `--kiosk-printing` bypasses the dialog entirely — the browser never
 * tells you whether ink hit paper, so nothing here claims it did. The frame
 * is removed on afterprint and NEVER on a setTimeout: Chrome can tear the
 * frame down mid-spool if you race it.
 */
export function printReceipt(doc: ReceiptDoc, opts: { copy: boolean }): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  frame.srcdoc = renderReceiptHtml(doc, { copy: opts.copy });
  frame.onload = () => {
    const w = frame.contentWindow;
    if (w === null) return;
    w.addEventListener('afterprint', () => frame.remove());
    // Safari and Firefox need focus before print().
    w.focus();
    w.print();
  };
  document.body.appendChild(frame);
}
