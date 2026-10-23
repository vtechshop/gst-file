// =============================================
// ADVANCE RECEIPT — the printable acknowledgement of money received
// =============================================
//
// A receipt voucher is the GST document for an advance a customer has
// actually paid, and GSTR-1 reports it in Table 11A. Until now it could be
// recorded but not handed over: there was no printable receipt for any
// voucher in the application.
//
// What this prints is an ACKNOWLEDGEMENT, not a quotation and not an
// invoice. The title says so, and the figures say which is which: the
// quotation's total is shown as context, the amount received now is the
// figure the document exists for, and the balance is what remains. A
// proforma's own "advance amount" is a payment TERM and never appears here —
// only money this voucher records as received.
//
// Everything is derived from the stored voucher (and the quotation it names,
// where there is one). Nothing is recalculated from today's prices, and no
// total is taken from the browser.

// Portrait A4, which suits a short document that gets filed and folded.
const RECEIPT_PAGE = { w: 210, h: 297, margin: 14 };

// What the receipt says about how the money arrived. The six the payments
// ledger allows, in words a customer reads rather than column values.
const RECEIPT_METHOD_LABELS = {
  cash: 'Cash',
  upi: 'UPI',
  bank_transfer: 'Bank Transfer',
  cheque: 'Cheque',
  card: 'Card',
  other: 'Other'
};
function receiptMethodLabel(method) {
  const key = String(method || '').trim().toLowerCase();
  return RECEIPT_METHOD_LABELS[key] || (key ? key : '');
}

// The figures the receipt is about, computed in one place so the page and
// the PDF cannot disagree.
//
//   total     what the quotation came to, when one is named
//   previous  what was received against it BEFORE this voucher
//   now       what this voucher records as received
//   balance   what is left after it
//
// With no quotation there is no total and no balance to speak of: the
// receipt then simply acknowledges the amount, and says nothing it cannot
// support.
function receiptFigures(voucher, quotation, previousReceived) {
  const now = round2(Number(voucher && voucher.advance_amount) || 0);
  const linked = !!(quotation && quotation.id);
  const total = linked ? round2(Number(quotation.total_amount) || 0) : null;
  const previous = linked ? round2(Number(previousReceived) || 0) : null;
  return {
    linked,
    total,
    previous,
    now,
    balance: linked ? round2(total - previous - now) : null
  };
}

async function buildReceiptPDFDoc(voucher, quotation, items, previousReceived) {
  const p = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const accent = hexToRgb(p && p.header_color);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const L = RECEIPT_PAGE.margin;
  const R = RECEIPT_PAGE.w - RECEIPT_PAGE.margin;
  const fig = receiptFigures(voucher, quotation, previousReceived);

  const [logo, seal, signature] = await Promise.all([
    imageUrlToDataUrl(p && p.logo_base64),
    imageUrlToDataUrl(p && p.seal_base64),
    imageUrlToDataUrl(p && p.signature_base64)
  ]);

  // ── Header: who is acknowledging the money ──
  let y = RECEIPT_PAGE.margin;
  if (logo) {
    try { doc.addImage(logo, 'PNG', L, y - 2, 22, 22); } catch { /* a bad logo must not stop a receipt */ }
  }
  const textLeft = logo ? L + 26 : L;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...accent);
  doc.text(String((p && p.business_name) || 'Business'), textLeft, y + 4, { maxWidth: R - textLeft - 42 });

  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(70, 70, 70);
  let hy = y + 9;
  for (const line of [
    (p && p.address) || '',
    [(p && p.district) || '', (p && p.state) || ''].filter(Boolean).join(', '),
    [(p && p.phone) ? 'Phone: ' + p.phone : '', (p && p.email) || ''].filter(Boolean).join('   '),
    (p && p.gstin) ? 'GSTIN: ' + p.gstin : ''
  ].filter(Boolean)) {
    doc.text(String(line), textLeft, hy, { maxWidth: R - textLeft - 42 });
    hy += 4;
  }

  // The title, where it cannot be mistaken for anything else.
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...accent);
  doc.text('ADVANCE RECEIPT', R, y + 4, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(70, 70, 70);
  doc.text('Receipt No: ' + String(voucher.document_number || ''), R, y + 10, { align: 'right' });
  doc.text('Date: ' + formatDate(voucher.document_date), R, y + 14.5, { align: 'right' });

  y = Math.max(hy, y + 20) + 2;
  doc.setDrawColor(...accent); doc.setLineWidth(0.4);
  doc.line(L, y, R, y);
  y += 7;

  // ── Received from ──
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...accent);
  doc.text('Received With Thanks From', L, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(30, 30, 30);
  doc.text(String(voucher.party_name || ''), L, y + 5.5, { maxWidth: 110 });

  let py = y + 10;
  doc.setFontSize(8.5); doc.setTextColor(70, 70, 70);
  if (voucher.party_gstin) { doc.text('GSTIN: ' + voucher.party_gstin, L, py, { maxWidth: 110 }); py += 4; }
  if (voucher.place_of_supply) { doc.text('Place of Supply: ' + voucher.place_of_supply, L, py, { maxWidth: 110 }); py += 4; }
  if (fig.linked && quotation.document_number) {
    doc.text('Against Quotation: ' + quotation.document_number
      + (quotation.document_date ? ' dated ' + formatDate(quotation.document_date) : ''), L, py, { maxWidth: 110 });
    py += 4;
  }

  // How the money arrived, opposite the party, so the two read together.
  let my = y + 5.5;
  const method = receiptMethodLabel(voucher.payment_method);
  if (method) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...accent);
    doc.text('Payment Mode', 130, y);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(70, 70, 70);
    doc.text(method, 130, my); my += 4.5;
  }
  if (voucher.reference_number) {
    doc.text('Reference: ' + voucher.reference_number, 130, my, { maxWidth: R - 130 }); my += 4.5;
  }

  y = Math.max(py, my) + 3;

  // ── What the quotation covers, when there is one ──
  const rows = (items || []).map((it, i) => [
    String(i + 1),
    String(it.product_name || ''),
    String(it.hsn_code || ''),
    String(+it.quantity || 0),
    String(it.unit || ''),
    formatNum(it.rate),
    (+it.gst_percentage || 0) + '%',
    formatNum(it.total_amount)
  ]);
  if (rows.length) {
    doc.autoTable({
      startY: y,
      head: [['#', 'Description', 'HSN', 'Qty', 'Unit', 'Rate', 'GST %', 'Amount']],
      body: rows,
      theme: 'grid',
      margin: { left: L, right: RECEIPT_PAGE.margin },
      styles: { fontSize: 8, cellPadding: 1.8, textColor: [40, 40, 40], lineColor: [190, 190, 190] },
      headStyles: { fillColor: accent, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
      columnStyles: {
        0: { cellWidth: 8, halign: 'center' },
        2: { cellWidth: 18 },
        3: { cellWidth: 12, halign: 'right' },
        4: { cellWidth: 14 },
        5: { cellWidth: 22, halign: 'right' },
        6: { cellWidth: 16, halign: 'right' },
        7: { cellWidth: 24, halign: 'right' }
      }
    });
    y = doc.lastAutoTable.finalY + 6;
  }

  // ── The payment summary: the point of the document ──
  // A new page rather than a summary split across the fold.
  if (y + 46 > RECEIPT_PAGE.h - RECEIPT_PAGE.margin) { doc.addPage(); y = RECEIPT_PAGE.margin; }

  const boxX = 112;
  const summary = [];
  if (fig.linked) summary.push(['Quotation Total', formatNum(fig.total)]);
  if (fig.linked && fig.previous > 0) summary.push(['Advance Received Earlier', formatNum(fig.previous)]);
  summary.push(['Advance Received Now', formatNum(fig.now)]);

  doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(60, 60, 60);
  summary.forEach((r, i) => {
    doc.text(r[0], boxX, y + i * 5.5);
    doc.text('Rs.' + r[1], R, y + i * 5.5, { align: 'right' });
  });
  let sy = y + summary.length * 5.5 + 1;
  doc.setDrawColor(60, 60, 60); doc.setLineWidth(0.2);
  doc.line(boxX, sy, R, sy);

  if (fig.linked) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...accent);
    doc.text('Balance Due', boxX, sy + 6.5);
    doc.text('Rs.' + formatNum(fig.balance), R, sy + 6.5, { align: 'right' });
    sy += 6.5;
  }

  // Amount in words, of the money actually received - never of the balance.
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(30, 30, 30);
  doc.text('Amount Received in Words:', L, y);
  doc.setFont('helvetica', 'bold');
  doc.text(numberToWordsINR(fig.now), L, y + 5, { maxWidth: boxX - 6 - L });

  let ly = y + 12;
  if (voucher.description) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(90, 90, 90);
    const lines = doc.splitTextToSize('Towards: ' + voucher.description, boxX - 6 - L);
    doc.text(lines, L, ly); ly += lines.length * 4;
  }
  if (voucher.notes) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(90, 90, 90);
    const lines = doc.splitTextToSize('Notes: ' + voucher.notes, boxX - 6 - L);
    doc.text(lines, L, ly + 2); ly += 2 + lines.length * 4;
  }

  // Said plainly, because this is the whole difference between this document
  // and an invoice: money has been received, nothing has been supplied yet.
  doc.setFont('helvetica', 'italic'); doc.setFontSize(7.5); doc.setTextColor(110, 110, 110);
  doc.text('* This is a receipt for an advance payment. It is not a Tax Invoice.',
    L, Math.max(ly + 3, sy + 12), { maxWidth: boxX - 6 - L });

  // ── Signature band, below whatever the two columns printed ──
  let band = Math.max(ly + 10, sy + 16);
  if (band + 26 > RECEIPT_PAGE.h - RECEIPT_PAGE.margin) { doc.addPage(); band = RECEIPT_PAGE.margin + 10; }
  if (seal) { try { doc.addImage(seal, 'PNG', boxX - 34, band - 4, 24, 24); } catch { /* optional */ } }
  if (signature) { try { doc.addImage(signature, 'PNG', R - 42, band, 38, 14); } catch { /* optional */ } }
  doc.setDrawColor(150, 150, 150); doc.setLineWidth(0.2);
  doc.line(R - 46, band + 16, R, band + 16);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(70, 70, 70);
  doc.text('Authorised Signatory', R, band + 20, { align: 'right' });
  doc.setFontSize(7.5); doc.setTextColor(120, 120, 120);
  doc.text('For ' + String((p && p.business_name) || ''), R, band + 24.5, { align: 'right' });

  return doc;
}

async function downloadReceiptDocument(voucher, quotation, items, previousReceived) {
  const doc = await buildReceiptPDFDoc(voucher, quotation, items, previousReceived);
  doc.save(`Advance_Receipt_${voucher.document_number || String(voucher.id || '').slice(0, 8)}.pdf`);
  if (typeof showToast === 'function') showToast('Advance receipt downloaded!', 'success');
}

async function printReceiptDocument(voucher, quotation, items, previousReceived) {
  const doc = await buildReceiptPDFDoc(voucher, quotation, items, previousReceived);
  doc.autoPrint();
  const url = doc.output('bloburl');
  // Opened rather than replaced, so the voucher list the user came from is
  // still behind the print dialog.
  window.open(url, '_blank');
}
