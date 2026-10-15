import QRCode from 'qrcode';

/**
 * Renders and downloads the printable setup card for a check-in station.
 *
 * `jspdf` is imported dynamically so it never joins the main admin bundle —
 * nobody pays for a PDF engine on a page load that never opens this modal.
 * Everything the card needs is already in the caller's hands (the station's
 * own `code`, the setup URL, and the QR built from it), so this makes no
 * network call and the station's secret never leaves the browser.
 */
export async function downloadSetupCardPdf(card: {
  stationName: string;
  stationCode: string;
  pairingUrl: string;
  code: string;
  expiresAt: string;
}): Promise<void> {
  const [{ jsPDF }, qrDataUrl] = await Promise.all([
    import('jspdf'),
    QRCode.toDataURL(card.pairingUrl, { width: 512, margin: 1 }),
  ]);

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const midX = pageWidth / 2;

  // Gym name header.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.text('GYM OF THRONES', midX, 20, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(90);
  doc.text('Check-in station setup card', midX, 28, { align: 'center' });
  doc.setTextColor(0);

  // Station name + code.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(card.stationName, midX, 40, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text(`Station code: ${card.stationCode}`, midX, 47, { align: 'center' });

  // QR, placed ~48mm from the top.
  const qrSize = 70;
  const qrY = 48;
  doc.addImage(qrDataUrl, 'PNG', midX - qrSize / 2, qrY, qrSize, qrSize);

  // Pairing code, in a monospace box.
  let y = qrY + qrSize + 14;
  const boxWidth = 90;
  const boxHeight = 16;
  doc.setDrawColor(180);
  doc.setFillColor(245, 245, 245);
  doc.roundedRect(midX - boxWidth / 2, y, boxWidth, boxHeight, 2, 2, 'FD');
  doc.setFont('courier', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(0);
  doc.text(card.code, midX, y + boxHeight / 2 + 5, { align: 'center' });

  // Expiry line.
  y += boxHeight + 10;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(110);
  doc.text(`Generated ${formatCardDate(card.expiresAt)}`, midX, y, { align: 'center' });
  doc.setTextColor(0);

  // Instruction.
  y += 10;
  doc.setFontSize(12);
  doc.text('Scan this QR code on the tablet to open the setup page.', midX, y, {
    align: 'center',
    maxWidth: pageWidth - 40,
  });

  doc.save(`setup-card-${card.stationCode}.pdf`);
}

function formatCardDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('en-PH', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
