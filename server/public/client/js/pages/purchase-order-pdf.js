// Purchase Order PDF.
//
// A separate renderer. It does not touch invoice-pdf.js or proforma-pdf.js,
// and it derives nothing: every figure printed is a stored value from the
// purchase_orders / purchase_order_items rows, so the paper and the
// database cannot disagree about what was ordered.
//
// A4 portrait, laid out as the reference purchase order is: company header,
// supplier and deliver-to blocks side by side, the order's terms in a
// labelled strip, the item table with HSN under each description, the tax
// summary, terms and conditions, and the two signature blocks. Item rows
// flow onto as many pages as they need with the header repeated; the
// closing blocks are only ever drawn after the last row, on whichever page
// has room for them.
const PO_PDF = {
  MARGIN: 12,
  PAGE_W: 210,
  PAGE_H: 297,
  FOOT: 14           // space kept clear at the foot of every page
};

function poPdfMoney(v) {
  const n = Number(v) || 0;
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function poPdfQty(v) {
  return String(Math.round((Number(v) || 0) * 1000) / 1000);
}
function poPdfDate(v) {
  const s = String(v || '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : (s || '');
}

// The business this order comes FROM. Read from the saved profile, never
// hardcoded — this is the buyer on every purchase order the tenant raises.
function poPdfBuyer() {
  const p = (typeof businessProfile === 'object' && businessProfile) ? businessProfile : {};
  return {
    name: p.business_name || p.legal_name || p.name || 'Your Business',
    address: p.address || '',
    state: p.state || '',
    district: p.district || '',
    gstin: p.gstin || '',
    phone: p.phone || '',
    email: p.email || '',
    logo: p.logo_base64 || '',
    seal: p.seal_base64 || '',
    signature: p.signature_base64 || ''
  };
}

function generatePurchaseOrderPDF(order, items, mode) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const M = PO_PDF.MARGIN;
  const R = PO_PDF.PAGE_W - M;
  const buyer = poPdfBuyer();

  // ── header ──
  let y = M;
  if (buyer.logo) {
    try { doc.addImage(buyer.logo, 'PNG', M, y, 26, 18); } catch (e) { /* a bad logo must not stop the order printing */ }
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(buyer.name, buyer.logo ? M + 30 : M, y + 6);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  const buyerLines = [
    buyer.address,
    [buyer.district, buyer.state].filter(Boolean).join(', '),
    buyer.gstin ? 'GSTIN: ' + buyer.gstin : '',
    [buyer.phone, buyer.email].filter(Boolean).join('  |  ')
  ].filter(Boolean);
  let hy = y + 11;
  buyerLines.forEach(l => { doc.text(String(l), buyer.logo ? M + 30 : M, hy); hy += 4; });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.text('PURCHASE ORDER', R, y + 7, { align: 'right' });
  doc.setFontSize(10);
  doc.text(String(order.document_number || ''), R, y + 14, { align: 'right' });

  y = Math.max(hy, y + 22) + 2;
  doc.setDrawColor(0);
  doc.setLineWidth(0.5);
  doc.line(M, y, R, y);
  y += 5;

  // ── supplier / deliver to ──
  const half = (R - M) / 2;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('SUPPLIER', M, y);
  doc.text('DELIVER TO', M + half + 4, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);

  const supplier = [
    order.vendor_name,
    order.address,
    [order.district, order.state].filter(Boolean).join(', '),
    order.vendor_gstin ? 'GSTIN: ' + order.vendor_gstin : '',
    order.phone ? 'Phone: ' + order.phone : ''
  ].filter(Boolean);
  const deliver = [
    order.delivery_address || buyer.address,
    [order.delivery_district || buyer.district, order.delivery_state || buyer.state]
      .filter(Boolean).join(', ')
  ].filter(Boolean);

  let sy = y + 5, dy = y + 5;
  supplier.forEach(l => {
    doc.splitTextToSize(String(l), half - 6).forEach(w => { doc.text(w, M, sy); sy += 4; });
  });
  deliver.forEach(l => {
    doc.splitTextToSize(String(l), half - 6).forEach(w => { doc.text(w, M + half + 4, dy); dy += 4; });
  });
  y = Math.max(sy, dy) + 3;

  // ── the order's own terms ──
  const strip = [
    ['Order Date', poPdfDate(order.document_date)],
    ['Delivery Date', order.expected_delivery_date ? poPdfDate(order.expected_delivery_date) : '—'],
    ['Representative', order.purchase_representative || '—'],
    ['Logistics', order.logistics_mode || '—'],
    ['Payment Terms', order.payment_terms || '—'],
    ['Status', String(order.status || '').replace(/_/g, ' ')]
  ];
  doc.setDrawColor(120);
  doc.setLineWidth(0.2);
  doc.rect(M, y, R - M, 16);
  const colW = (R - M) / 3;
  strip.forEach((pair, i) => {
    const cx = M + (i % 3) * colW + 2;
    const cy = y + (i < 3 ? 5.5 : 12.5);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7);
    doc.text(String(pair[0]).toUpperCase(), cx, cy - 3);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
    doc.text(String(pair[1]), cx, cy + 1);
  });
  y += 20;

  // ── items ──
  // Description carries the HSN beneath it, as the reference does.
  const body = items.map((it, i) => [
    String(i + 1),
    String(it.product_name || '') + (it.hsn_code ? '\nHSN/SAC: ' + it.hsn_code : ''),
    poPdfQty(it.quantity) + (it.unit ? ' ' + it.unit : ''),
    poPdfMoney(it.rate),
    (Number(it.gst_percentage) || 0) + '%',
    poPdfMoney(it.taxable_value)
  ]);

  doc.autoTable({
    startY: y,
    head: [['#', 'DESCRIPTION', 'QTY', 'UNIT PRICE', 'TAX', 'AMOUNT']],
    body,
    theme: 'grid',
    styles: { fontSize: 8.5, cellPadding: 2, lineColor: [120, 120, 120], lineWidth: 0.2, overflow: 'linebreak' },
    headStyles: { fillColor: [235, 235, 235], textColor: 20, fontStyle: 'bold', lineWidth: 0.2 },
    columnStyles: {
      0: { cellWidth: 10, halign: 'center' },
      1: { cellWidth: 'auto' },
      2: { cellWidth: 24, halign: 'right' },
      3: { cellWidth: 26, halign: 'right' },
      4: { cellWidth: 16, halign: 'right' },
      5: { cellWidth: 28, halign: 'right' }
    },
    margin: { left: M, right: M, bottom: PO_PDF.FOOT },
    // Repeated on every page the table runs onto.
    showHead: 'everyPage'
  });
  y = doc.lastAutoTable.finalY + 6;

  // ── totals ──
  // Only the taxes that actually apply are printed, so an intrastate order
  // does not carry an IGST row of zero.
  const rows = [['Untaxed Amount', poPdfMoney(order.taxable_amount)]];
  if (Number(order.cgst)) rows.push(['CGST', poPdfMoney(order.cgst)]);
  if (Number(order.sgst)) rows.push(['SGST', poPdfMoney(order.sgst)]);
  if (Number(order.igst)) rows.push(['IGST', poPdfMoney(order.igst)]);
  if (Number(order.cess_amount)) rows.push(['Cess', poPdfMoney(order.cess_amount)]);
  rows.push(['TOTAL', poPdfMoney(order.total_amount)]);

  const needTotals = rows.length * 6 + 8;
  y = poPdfSpace(doc, y, needTotals);

  const boxW = 74;
  const boxX = R - boxW;
  doc.setDrawColor(120); doc.setLineWidth(0.2);
  rows.forEach((r, i) => {
    const last = i === rows.length - 1;
    doc.setFont('helvetica', last ? 'bold' : 'normal');
    doc.setFontSize(last ? 10 : 9);
    if (last) { doc.setLineWidth(0.5); doc.line(boxX, y - 1, R, y - 1); doc.setLineWidth(0.2); }
    doc.text(r[0], boxX + 2, y + 4);
    doc.text(r[1], R - 2, y + 4, { align: 'right' });
    y += last ? 7 : 6;
  });
  y += 4;

  // ── terms ──
  if (order.terms && String(order.terms).trim()) {
    const wrapped = doc.splitTextToSize(String(order.terms).trim(), R - M);
    y = poPdfSpace(doc, y, Math.min(wrapped.length, 8) * 4 + 10);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
    doc.text('TERMS & CONDITIONS', M, y); y += 5;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    for (const line of wrapped) {
      y = poPdfSpace(doc, y, 6);
      doc.text(line, M, y);
      y += 4;
    }
    y += 4;
  }

  // ── signatures ──
  y = poPdfSpace(doc, y, 34);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
  doc.text("SUPPLIER'S SIGNATURE", M, y);
  doc.text('APPROVED BY', M + half + 4, y);

  // The supplier signs the copy they return, so their block is left blank
  // on purpose. Ours carries the seal and signature from the profile, if
  // they have been configured.
  if (buyer.seal) {
    try { doc.addImage(buyer.seal, 'PNG', M + half + 4, y + 3, 22, 22); } catch (e) { /* optional */ }
  }
  if (buyer.signature) {
    try { doc.addImage(buyer.signature, 'PNG', M + half + 30, y + 6, 34, 16); } catch (e) { /* optional */ }
  }
  doc.setDrawColor(120); doc.setLineWidth(0.2);
  doc.line(M, y + 26, M + half - 6, y + 26);
  doc.line(M + half + 4, y + 26, R, y + 26);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  doc.text('Name / Date', M, y + 30);
  doc.text(buyer.name, M + half + 4, y + 30);

  poPdfFooters(doc, order);

  const name = 'Purchase_Order_' + String(order.document_number || 'PO').replace(/[^A-Za-z0-9_-]/g, '_');
  if (mode === 'print') {
    doc.autoPrint();
    window.open(doc.output('bloburl'), '_blank');
  } else {
    doc.save(name + '.pdf');
  }
}

// Returns a y with `need` mm of room above the footer, starting a new page
// if this one has run out. This is what keeps totals off the item rows and
// signatures off the table.
function poPdfSpace(doc, y, need) {
  if (y + need <= PO_PDF.PAGE_H - PO_PDF.FOOT) return y;
  doc.addPage();
  return PO_PDF.MARGIN;
}

function poPdfFooters(doc, order) {
  const pages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(110);
    doc.text(String(order.document_number || ''), PO_PDF.MARGIN, PO_PDF.PAGE_H - 7);
    doc.text(`Page ${p} of ${pages}`, PO_PDF.PAGE_W - PO_PDF.MARGIN, PO_PDF.PAGE_H - 7, { align: 'right' });
    doc.setTextColor(0);
  }
}
