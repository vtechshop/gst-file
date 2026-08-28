// =============================================
// Proforma Invoice PDF
// =============================================
// A sibling of invoice-pdf.js, the same way sales-return-pdf.js is, rather
// than a mode flag inside buildInvoicePDFDoc(). Two reasons, and both matter:
// the tax invoice's three-copy document is a legal artefact that must not
// move because a quotation needed a different heading, and a proforma is a
// genuinely different document - one copy, no copy labels, no verification
// QR, because there is nothing yet to verify.
//
// It reuses the shared pieces deliberately: invoicePartyLines() for the
// BILL TO / SHIP TO blocks and the item figures the grid already computed,
// so a quotation shows the customer exactly what the invoice will.
const PROFORMA_ITEM_COLUMN_WEIGHTS = [
  9,    // #
  100,  // Product Name — the only column that wraps
  22,   // HSN
  16,   // Qty
  24,   // Rate
  16,   // GST%
  22,   // CGST
  22,   // SGST
  22,   // IGST
  24    // Total
];

function PROFORMA_ITEM_COLUMN_STYLES(tableWidth) {
  const total = PROFORMA_ITEM_COLUMN_WEIGHTS.reduce((a, b) => a + b, 0);
  const styles = {};
  PROFORMA_ITEM_COLUMN_WEIGHTS.forEach((w, i) => { styles[i] = { cellWidth: tableWidth * w / total }; });
  styles[1].fontStyle = 'bold';
  styles[9].fontStyle = 'bold';
  return styles;
}

// Shapes a proforma row + its items into the object the shared renderers
// expect, so invoicePartyLines() and the money formatting need no proforma
// special-casing.
function proformaToRenderable(row, items) {
  return {
    type: row.gst_number ? 'b2b' : 'b2c',
    id: row.id,
    invoice_number: row.document_number || '',
    invoice_date: row.document_date,
    valid_until: row.valid_until || null,
    customer_name: row.customer_name || '',
    gstin: row.gst_number || '',
    phone: row.phone || '',
    address: row.address || '',
    state: row.state || '',
    shipping_address: row.shipping_address || '',
    shipping_state: row.shipping_state || '',
    shipping_district: row.shipping_district || '',
    supply_type: row.supply_type || 'intrastate',
    gst_category: row.gst_category || 'regular',
    taxable_amount: +row.taxable_amount || 0,
    gst_percentage: +row.gst_percentage || 0,
    gst_amount: +row.gst_amount || 0,
    igst: +row.igst || 0,
    cgst: +row.cgst || 0,
    sgst: +row.sgst || 0,
    round_off: 0,
    total_amount: +row.total_amount || 0,
    notes: row.notes || '',
    terms: row.terms || '',
    status: row.status,
    items: (items || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
  };
}

async function buildProformaPDFDoc(row, items) {
  const inv = proformaToRenderable(row, items);
  const p = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const accent = hexToRgb(p?.header_color);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const pw = doc.internal.pageSize.width;
  const L = 14, R = pw - 14;

  const [logoData, sealData, signatureData] = await Promise.all([
    imageUrlToDataUrl(p?.logo_base64),
    imageUrlToDataUrl(p?.seal_base64),
    imageUrlToDataUrl(p?.signature_base64)
  ]);

  // ── Header, drawn on every page ──
  const drawHeader = () => {
    let nameX = L;
    if (logoData) {
      try { doc.addImage(logoData, 'PNG', L, 8, 14, 14); nameX = L + 18; } catch {}
    }
    doc.setTextColor(20, 20, 20);
    doc.setFontSize(19); doc.setFont('helvetica', 'bold');
    doc.text(p?.business_name || 'Your Business Name', nameX, 15);
    if (p?.website) {
      doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(120, 120, 120);
      doc.text(p.website, nameX, 20.5);
    }

    doc.setTextColor(...accent);
    doc.setFontSize(15); doc.setFont('helvetica', 'bold');
    doc.text('PROFORMA INVOICE', R, 14, { align: 'right' });
    // No copy label. A proforma is one document - the Original/Duplicate
    // set belongs to a tax invoice and would be a false claim here.
    doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(120, 120, 120);
    doc.text('Not a Tax Invoice', R, 20, { align: 'right' });

    doc.setFillColor(...accent);
    doc.rect(L, 25, R - L, 1.3, 'F');

    let y = 34;
    const PART_GAP = 6;
    const partColW = (R - L - PART_GAP * 3) / 4;
    const partX = [0, 1, 2, 3].map(i => L + i * (partColW + PART_GAP));

    doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...accent);
    doc.text('SOLD BY', partX[0], y);
    doc.text('QUOTATION DETAILS', partX[1], y);
    doc.text('BILL TO', partX[2], y);
    doc.text('SHIP TO', partX[3], y);
    doc.setDrawColor(...accent); doc.setLineWidth(0.3);
    doc.line(L, y + 1.5, R, y + 1.5);

    const partTop = y + 7;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(60, 60, 60);

    const soldBy = [p?.business_name, p?.address, p?.state,
      p?.gstin ? 'GSTIN: ' + p.gstin : ''].filter(Boolean);
    const soldByWrapped = doc.splitTextToSize(soldBy.join('\n'), partColW);
    soldByWrapped.forEach((l, i) => doc.text(l, partX[0], partTop + i * 4.5));

    const meta = [
      'Proforma No: ' + (inv.invoice_number || ''),
      'Date: ' + formatDate(inv.invoice_date),
      inv.valid_until ? 'Valid Until: ' + formatDate(inv.valid_until) : '',
      'Place of Supply: ' + (inv.state || ''),
      'Type: ' + (inv.type === 'b2b' ? 'B2B (Registered)' : 'B2C (Unregistered)')
    ].filter(Boolean);
    const metaWrapped = doc.splitTextToSize(meta.join('\n'), partColW);
    metaWrapped.forEach((l, i) => doc.text(l, partX[1], partTop + i * 4.5));

    // The invoice's own party renderer, so BILL TO / SHIP TO read identically.
    const parties = invoicePartyLines(inv);
    doc.setFont('helvetica', 'bold');
    doc.text(doc.splitTextToSize(inv.customer_name || '', partColW), partX[2], partTop);
    doc.text(doc.splitTextToSize(inv.customer_name || '', partColW), partX[3], partTop);
    doc.setFont('helvetica', 'normal');
    const nameH = 4.5;
    const billWrapped = doc.splitTextToSize(parties.bill.join('\n'), partColW);
    billWrapped.forEach((l, i) => doc.text(l, partX[2], partTop + nameH + i * 4.5));
    const shipWrapped = doc.splitTextToSize(parties.ship.join('\n'), partColW);
    shipWrapped.forEach((l, i) => doc.text(l, partX[3], partTop + nameH + i * 4.5));
    if (parties.sameAddress) {
      doc.setFont('helvetica', 'italic'); doc.setTextColor(120, 120, 120);
      doc.text('Same as billing address', partX[3], partTop + nameH + shipWrapped.length * 4.5);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(60, 60, 60);
    }
    const partyRows = Math.max(billWrapped.length, shipWrapped.length) + 1;
    return partTop + Math.max(soldByWrapped.length, metaWrapped.length, partyRows) * 4.5 + 3;
  };

  let y = drawHeader();
  const HEADER_BOTTOM = y;

  const rows = inv.items.map((it, i) => [
    i + 1,
    it.product_name || '',
    it.hsn_code || '',
    formatNum(it.quantity),
    formatNum(it.rate),
    (+it.gst_percentage || 0) + '%',
    +it.cgst ? formatNum(it.cgst) : '-',
    +it.sgst ? formatNum(it.sgst) : '-',
    +it.igst ? formatNum(it.igst) : '-',
    formatNum(it.total_amount)
  ]);

  doc.autoTable({
    startY: y,
    head: [['#', 'Product Name', 'HSN', 'Qty', 'Rate', 'GST%', 'CGST', 'SGST', 'IGST', 'Total']],
    body: rows,
    theme: 'grid',
    headStyles: { fillColor: accent, textColor: 255, fontSize: 8.5, fontStyle: 'bold' },
    bodyStyles: { fontSize: 8.5, textColor: [40, 40, 40] },
    columnStyles: PROFORMA_ITEM_COLUMN_STYLES(R - L),
    margin: { left: L, right: L, top: HEADER_BOTTOM },
    styles: { cellPadding: 2.5, lineColor: [225, 225, 225] },
    showHead: 'everyPage',
    didDrawPage: (d) => { if (d.pageNumber > 1) drawHeader(); }
  });

  y = doc.lastAutoTable.finalY + 8;

  // ── Totals ──
  const boxW = 80, boxX = R - boxW;
  const totalsRows = [['Subtotal', formatNum(inv.taxable_amount)]];
  if (inv.cgst > 0) totalsRows.push(['CGST', formatNum(inv.cgst)]);
  if (inv.sgst > 0) totalsRows.push(['SGST', formatNum(inv.sgst)]);
  if (inv.igst > 0) totalsRows.push(['IGST', formatNum(inv.igst)]);

  if (y + totalsRows.length * 5.5 + 60 > doc.internal.pageSize.height - 12) {
    doc.addPage();
    y = drawHeader();
  }

  doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(60, 60, 60);
  totalsRows.forEach((r, i) => {
    doc.text(r[0], boxX, y + i * 5.5);
    doc.text('Rs.' + r[1], R, y + i * 5.5, { align: 'right' });
  });
  const ruleY = y + totalsRows.length * 5.5 + 1;
  doc.setDrawColor(60, 60, 60);
  doc.line(boxX, ruleY, R, ruleY);
  doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.setTextColor(...accent);
  doc.text('Quoted Total', boxX, ruleY + 7);
  doc.text('Rs.' + formatNum(inv.total_amount), R, ruleY + 7, { align: 'right' });

  // ── Left column: words, validity, notes, terms ──
  let ly = y;
  doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(30, 30, 30);
  doc.text('Amount in Words:', L, ly);
  doc.setFont('helvetica', 'bold');
  doc.text(numberToWordsINR(inv.total_amount), L, ly + 5, { maxWidth: boxX - 6 - L });
  ly += 11;

  doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(110, 110, 110);
  // Said plainly on the document, because this is the whole difference
  // between a quotation and a bill.
  doc.text('* This is a Proforma Invoice (quotation). It is not a Tax Invoice and no GST is payable on it.', L, ly);
  ly += 4;
  if (inv.valid_until) {
    doc.text('* Valid until ' + formatDate(inv.valid_until) + '. Prices are subject to change after this date.', L, ly);
    ly += 4;
  }

  if (inv.notes) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(60, 60, 60);
    doc.text(doc.splitTextToSize('Notes: ' + inv.notes, boxX - 6 - L), L, ly + 3);
    ly += 3 + doc.splitTextToSize('Notes: ' + inv.notes, boxX - 6 - L).length * 4;
  }
  if (inv.terms) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(60, 60, 60);
    doc.text(doc.splitTextToSize('Terms: ' + inv.terms, boxX - 6 - L), L, ly + 3);
    ly += 3 + doc.splitTextToSize('Terms: ' + inv.terms, boxX - 6 - L).length * 4;
  }

  // ── Signature (no QR: there is no invoice to verify yet) ──
  const SEAL = 26;
  const sealReserveH = sealData ? SEAL : (signatureData ? 18 : 14);
  const bandTop = doc.internal.pageSize.height - 12 - 18 - (6 + sealReserveH + 5);
  let sigY = Math.max(ruleY + 12, bandTop);

  // The same stamp block the tax invoice draws, measured the same way: every
  // size below is of the INK inside each file, never of the file's edges - see
  // inkBoundsOf() in invoice-pdf.js. Drawing the PNG at SEAL square instead
  // sized the transparent margin rather than the mark, so the stamp came out
  // small and faint; and the signature was drawn only where no seal existed,
  // so a business with both never saw it at all.
  const [sealInk, sigInk] = await Promise.all([inkBoundsOf(sealData), inkBoundsOf(signatureData)]);
  const sealCx = R - 5 - SEAL / 2;       // centre, held clear of the margin
  const sealTop = sigY + 3;              // unchanged: the band does not move

  // Fit the stamp's longer side to SEAL, so a mark wider than it is tall does
  // not overshoot the space reserved for it.
  const sbk = sealInk || { w: 1, h: 1, imgW: 1, imgH: 1 };
  const sealWantW = SEAL * sbk.w / Math.max(sbk.w, sbk.h * (sbk.imgH / sbk.imgW));
  const seal = sealData ? placeInk(sealInk, sealWantW, sealCx, sealTop)
                        : { inkW: SEAL, inkH: sealReserveH };

  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(30, 30, 30);
  doc.text('For ' + (p?.business_name || ''), sealCx, sealTop - 1.8, { align: 'center' });

  if (sealData) {
    try { doc.addImage(sealData, 'PNG', seal.x, seal.y, seal.w, seal.h); } catch {}
  }
  if (signatureData) {
    // Centred over the stamp's visible ink, and capped so a tall scan cannot
    // spill out of it - the same rule the tax invoice uses.
    const cx = sealCx, cy = sealTop + seal.inkH * 0.50;
    let sig = placeInk(sigInk, seal.inkW * 0.62, cx, 0);
    const maxH = seal.inkH * 0.5;
    if (sig.inkH > maxH) {
      const k = maxH / sig.inkH;
      sig = placeInk(sigInk, seal.inkW * 0.62 * k, cx, 0);
    }
    // placeInk aligns the ink's top; the block wants its centre.
    const sgk = sigInk || { y: 0, h: 1 };
    sig.y = cy - sgk.y * sig.h - sig.inkH / 2;
    try { doc.addImage(signatureData, 'PNG', sig.x, sig.y, sig.w, sig.h); } catch {}
  }

  const authY = sealTop + seal.inkH + 5;
  doc.setDrawColor(170, 170, 170);
  doc.line(sealCx - 22, authY - 3.5, sealCx + 22, authY - 3.5);
  doc.setFontSize(8); doc.setTextColor(120, 120, 120);
  doc.text('Authorized Signatory', sealCx, authY, { align: 'center' });

  // ── Footer + page numbers ──
  const PAGE_BOTTOM = doc.internal.pageSize.height - 12;
  doc.setDrawColor(178, 223, 219);
  doc.line(L, PAGE_BOTTOM - 10, R, PAGE_BOTTOM - 10);
  doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(140, 140, 140);
  doc.text('This is a computer-generated proforma invoice.', pw / 2, PAGE_BOTTOM - 5, { align: 'center' });

  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(7); doc.setTextColor(180);
    doc.text(`Page ${i} of ${pageCount}`, L, doc.internal.pageSize.height - 8);
  }
  return doc;
}

async function downloadProformaDocument(row, items) {
  const doc = await buildProformaPDFDoc(row, items);
  doc.save(`Proforma_${row.document_number || row.id.slice(0, 8)}.pdf`);
  if (typeof showToast === 'function') showToast('Proforma PDF downloaded!', 'success');
}
