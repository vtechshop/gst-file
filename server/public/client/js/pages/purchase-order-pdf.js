// Purchase Order PDF.
//
// A separate renderer. It does not touch invoice-pdf.js or proforma-pdf.js,
// and it derives nothing: every figure printed is a stored value from the
// purchase_orders / purchase_order_items rows, so the paper and the
// database cannot disagree about what was ordered.
//
// A4 portrait, laid out as a company purchase order: a branded letterhead
// from the saved Business Profile, the document title with its number, date
// and status, supplier and deliver-to panels, the order's own terms, the
// item table, the tax summary beside the amount in words and the bank
// block, terms and conditions, then the supplier and approval signatures.
// Item rows flow onto as many pages as they need with the head repeated,
// every closing block is drawn only where there is room for it, and the
// footer repeats on every page.
const PO_PDF = {
  MARGIN: 12,
  PAGE_W: 210,
  PAGE_H: 297,
  FOOT: 16,          // space kept clear at the foot of every page
  ACCENT: [0, 77, 64],
  TINT: [236, 242, 241],
  RULE: [150, 150, 150],
  INK: [40, 40, 40],
  MUTED: [110, 110, 110]
};

// Printed only when the order carries no terms of its own and the Business
// Profile has none either. They are ordinary trade wording, not legal
// advice, and both the order form and the profile can replace them.
const PO_PDF_DEFAULT_TERMS = [
  'Goods must be supplied as per the purchase order specifications.',
  'Material quantity and quality must match the order.',
  'Any shortage, damage or mismatch should be informed before acceptance.',
  'Delivery should follow the agreed delivery date.',
  'Invoice should reference the Purchase Order number.',
  'GST and statutory documents must accompany the supply where applicable.',
  'Payment will be processed according to the agreed payment terms.',
  'Any change to this order requires approval from the buyer named above.',
  'Goods should be properly packed to prevent transit damage.',
  'The buyer may verify quantity and quality at the time of receipt.'
];

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
function poPdfPercent(v) {
  const n = Number(v) || 0;
  return (Math.round(n * 100) / 100) + '%';
}
function poPdfStatus(v) {
  return String(v || '').replace(/_/g, ' ').trim() || 'DRAFT';
}

// The business this order comes FROM. The saved profile is the one the rest
// of the app already holds (profile.js caches it for every page); the old
// global is still read first where a page happens to set one, so nothing
// that worked before stops working.
function poPdfBuyer() {
  const cached = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const p = cached || ((typeof businessProfile === 'object' && businessProfile) ? businessProfile : {}) || {};
  return {
    name: p.business_name || p.trade_name || p.legal_name || p.name || 'Your Business',
    legalName: p.legal_name || '',
    address: p.address || '',
    state: p.state || '',
    district: p.district || '',
    gstin: p.gstin || '',
    pan: p.pan || '',
    phone: p.phone || '',
    email: p.email || '',
    website: p.website || '',
    footerText: p.footer_text || '',
    profileTerms: p.terms_conditions || '',
    logo: p.logo_base64 || '',
    seal: p.seal_base64 || '',
    signature: p.signature_base64 || '',
    bank: {
      name: p.bank_name || '',
      account: p.bank_account_no || '',
      ifsc: p.bank_ifsc || '',
      branch: p.bank_branch || ''
    }
  };
}

// ── letterhead ────────────────────────────────────────────────────────
function poPdfHeader(doc, buyer, order) {
  const M = PO_PDF.MARGIN;
  const R = PO_PDF.PAGE_W - M;

  doc.setFillColor.apply(doc, PO_PDF.ACCENT);
  doc.rect(0, 0, PO_PDF.PAGE_W, 4, 'F');

  let y = 11;
  let textX = M;
  if (buyer.logo) {
    try {
      doc.addImage(buyer.logo, 'PNG', M, y, 24, 18);
      textX = M + 28;
    } catch (e) { /* a bad logo must not stop the order printing */ }
  }

  const rightW = 62;
  const leftW = R - rightW - textX - 4;

  doc.setTextColor.apply(doc, PO_PDF.ACCENT);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(String(buyer.name).toUpperCase(), textX, y + 5);

  doc.setTextColor.apply(doc, PO_PDF.INK);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  let hy = y + 10;
  const headLines = [];
  if (buyer.legalName && buyer.legalName !== buyer.name) headLines.push(buyer.legalName);
  if (buyer.address) headLines.push(buyer.address);
  const place = [buyer.district, buyer.state].filter(Boolean).join(', ');
  if (place) headLines.push(place);
  const idLine = [buyer.gstin ? 'GSTIN: ' + buyer.gstin : '', buyer.pan ? 'PAN: ' + buyer.pan : ''].filter(Boolean).join('   ');
  if (idLine) headLines.push(idLine);
  const reachLine = [buyer.phone ? 'Ph: ' + buyer.phone : '', buyer.email, buyer.website].filter(Boolean).join('   ');
  if (reachLine) headLines.push(reachLine);
  headLines.forEach(line => {
    doc.splitTextToSize(String(line), leftW).forEach(w => { doc.text(w, textX, hy); hy += 3.8; });
  });

  // ── the document itself, on the right ──
  doc.setTextColor.apply(doc, PO_PDF.ACCENT);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('PURCHASE ORDER', R, y + 5, { align: 'right' });

  doc.setTextColor.apply(doc, PO_PDF.INK);
  doc.setFontSize(10);
  doc.text('PO No: ' + String(order.document_number || ''), R, y + 11, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text('Order Date: ' + poPdfDate(order.document_date), R, y + 16, { align: 'right' });

  const badge = poPdfStatus(order.status);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  const badgeW = doc.getTextWidth(badge) + 8;
  doc.setFillColor.apply(doc, PO_PDF.ACCENT);
  doc.roundedRect(R - badgeW, y + 19, badgeW, 6, 1.2, 1.2, 'F');
  doc.setTextColor(255, 255, 255);
  doc.text(badge, R - badgeW / 2, y + 23.2, { align: 'center' });
  doc.setTextColor.apply(doc, PO_PDF.INK);

  y = Math.max(hy, y + 27) + 1;
  doc.setDrawColor.apply(doc, PO_PDF.ACCENT);
  doc.setLineWidth(0.6);
  doc.line(M, y, R, y);
  doc.setLineWidth(0.2);
  return y + 5;
}

// ── supplier and deliver-to, as two panels ────────────────────────────
function poPdfParties(doc, y, buyer, order) {
  const M = PO_PDF.MARGIN;
  const R = PO_PDF.PAGE_W - M;
  const gap = 6;
  const w = (R - M - gap) / 2;

  const supplier = [
    order.vendor_name,
    order.address,
    [order.district, order.state].filter(Boolean).join(', '),
    order.vendor_gstin ? 'GSTIN: ' + order.vendor_gstin : '',
    order.phone ? 'Phone: ' + order.phone : ''
  ].filter(Boolean);
  const deliver = [
    buyer.name,
    order.delivery_address || buyer.address,
    [order.delivery_district || buyer.district, order.delivery_state || buyer.state].filter(Boolean).join(', ')
  ].filter(Boolean);

  const wrap = (lines, width) => {
    const out = [];
    lines.forEach(l => doc.splitTextToSize(String(l), width - 6).forEach(s => out.push(s)));
    return out;
  };
  const sLines = wrap(supplier, w);
  const dLines = wrap(deliver, w);
  const bodyH = Math.max(sLines.length, dLines.length) * 4 + 5;
  const panelH = bodyH + 7;

  const panel = (x, title, lines) => {
    doc.setDrawColor.apply(doc, PO_PDF.RULE);
    doc.rect(x, y, w, panelH);
    doc.setFillColor.apply(doc, PO_PDF.TINT);
    doc.rect(x, y, w, 7, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor.apply(doc, PO_PDF.ACCENT);
    doc.text(title, x + 3, y + 4.8);
    doc.setTextColor.apply(doc, PO_PDF.INK);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    let ly = y + 11.5;
    lines.forEach((l, i) => {
      if (i === 0) doc.setFont('helvetica', 'bold');
      doc.text(l, x + 3, ly);
      if (i === 0) doc.setFont('helvetica', 'normal');
      ly += 4;
    });
  };
  panel(M, 'SUPPLIER DETAILS', sLines);
  panel(M + w + gap, 'DELIVER TO', dLines);
  return y + panelH + 5;
}

// ── the order's own terms, in a labelled grid ─────────────────────────
function poPdfOrderDetails(doc, y, order) {
  const M = PO_PDF.MARGIN;
  const R = PO_PDF.PAGE_W - M;
  const cells = [
    ['PO NUMBER', String(order.document_number || '—')],
    ['ORDER DATE', poPdfDate(order.document_date) || '—'],
    ['EXPECTED DELIVERY', order.expected_delivery_date ? poPdfDate(order.expected_delivery_date) : '—'],
    ['STATUS', poPdfStatus(order.status)],
    ['REPRESENTATIVE', order.purchase_representative || '—'],
    ['LOGISTICS', order.logistics_mode || '—'],
    ['PAYMENT TERMS', order.payment_terms || '—'],
    ['SUPPLY TYPE', String(order.supply_type || '').replace(/^./, c => c.toUpperCase()) || '—']
  ];
  const cols = 4;
  const colW = (R - M) / cols;
  const rows = Math.ceil(cells.length / cols);
  const rowH = 10;
  const boxH = rows * rowH;

  doc.setDrawColor.apply(doc, PO_PDF.RULE);
  doc.rect(M, y, R - M, boxH);
  doc.setFillColor.apply(doc, PO_PDF.TINT);
  doc.rect(M, y, R - M, 0.1, 'F');

  cells.forEach((pair, i) => {
    const cx = M + (i % cols) * colW;
    const cy = y + Math.floor(i / cols) * rowH;
    if (i % cols) doc.line(cx, cy, cx, cy + rowH);
    if (i >= cols) doc.line(cx, cy, cx + colW, cy);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor.apply(doc, PO_PDF.MUTED);
    doc.text(pair[0], cx + 2.5, cy + 4);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor.apply(doc, PO_PDF.INK);
    doc.splitTextToSize(String(pair[1]), colW - 5).slice(0, 1).forEach(s => doc.text(s, cx + 2.5, cy + 8.6));
  });
  return y + boxH + 6;
}

// ── the tax summary, the words, and the bank block ────────────────────
function poPdfSummary(doc, y, order, buyer) {
  const M = PO_PDF.MARGIN;
  const R = PO_PDF.PAGE_W - M;

  const rows = [['Untaxed Amount', poPdfMoney(order.taxable_amount)]];
  if (Number(order.cgst)) rows.push(['CGST', poPdfMoney(order.cgst)]);
  if (Number(order.sgst)) rows.push(['SGST', poPdfMoney(order.sgst)]);
  if (Number(order.igst)) rows.push(['IGST', poPdfMoney(order.igst)]);
  if (Number(order.cess_amount)) rows.push(['Cess', poPdfMoney(order.cess_amount)]);

  const words = (typeof numberToWordsINR === 'function') ? numberToWordsINR(order.total_amount) : '';
  const bank = [
    buyer.bank.name ? 'Bank: ' + buyer.bank.name : '',
    buyer.bank.account ? 'A/c: ' + buyer.bank.account : '',
    buyer.bank.ifsc ? 'IFSC: ' + buyer.bank.ifsc : '',
    buyer.bank.branch ? 'Branch: ' + buyer.bank.branch : ''
  ].filter(Boolean);

  const boxW = 76;
  const boxX = R - boxW;
  const leftW = boxX - M - 6;
  const wordLines = words ? doc.splitTextToSize(words, leftW - 4) : [];
  const summaryH = rows.length * 6 + 11;
  const leftH = (wordLines.length ? wordLines.length * 4 + 9 : 0) + (bank.length ? bank.length * 4 + 9 : 0);

  y = poPdfSpace(doc, y, Math.max(summaryH, leftH) + 4);

  // amount in words, from the shared helper the rest of the app uses
  let ly = y;
  if (wordLines.length) {
    doc.setDrawColor.apply(doc, PO_PDF.RULE);
    doc.rect(M, ly, leftW, wordLines.length * 4 + 8);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor.apply(doc, PO_PDF.MUTED);
    doc.text('AMOUNT IN WORDS', M + 3, ly + 4.5);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor.apply(doc, PO_PDF.INK);
    let wy = ly + 9.5;
    wordLines.forEach(w => { doc.text(w, M + 3, wy); wy += 4; });
    ly += wordLines.length * 4 + 12;
  }
  if (bank.length) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor.apply(doc, PO_PDF.MUTED);
    doc.text('BANK DETAILS', M + 3, ly + 3);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor.apply(doc, PO_PDF.INK);
    let by = ly + 7.5;
    bank.forEach(b => { doc.text(b, M + 3, by); by += 4; });
  }

  // the figures, exactly as they are stored
  let ry = y;
  doc.setDrawColor.apply(doc, PO_PDF.RULE);
  doc.rect(boxX, ry, boxW, summaryH);
  rows.forEach(r => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor.apply(doc, PO_PDF.INK);
    doc.text(r[0], boxX + 3, ry + 5.5);
    doc.text(r[1], R - 3, ry + 5.5, { align: 'right' });
    ry += 6;
  });
  doc.setFillColor.apply(doc, PO_PDF.ACCENT);
  doc.rect(boxX, ry + 0.5, boxW, 10, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(255, 255, 255);
  doc.text('TOTAL PO VALUE', boxX + 3, ry + 7);
  doc.text(poPdfMoney(order.total_amount), R - 3, ry + 7, { align: 'right' });
  doc.setTextColor.apply(doc, PO_PDF.INK);

  return Math.max(y + summaryH, y + leftH) + 4;
}

// ── terms and conditions ──────────────────────────────────────────────
// The order's own terms if it has any, else the company terms saved in the
// Business Profile, else the standard wording above - which is labelled as
// standard so nobody mistakes it for something the supplier agreed to.
function poPdfTerms(doc, y, order, buyer) {
  const M = PO_PDF.MARGIN;
  const R = PO_PDF.PAGE_W - M;
  const own = String(order.terms || '').trim();
  const saved = String(buyer.profileTerms || '').trim();
  const source = own || saved;
  const colGap = 8;
  const colW = (R - M - colGap) / 2;

  const heading = () => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor.apply(doc, PO_PDF.ACCENT);
    doc.text('TERMS & CONDITIONS', M, y);
    if (!source) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(7);
      doc.setTextColor.apply(doc, PO_PDF.MUTED);
      doc.text('Standard purchase order terms', M + 46, y);
    }
    doc.setDrawColor.apply(doc, PO_PDF.RULE);
    doc.line(M, y + 1.5, R, y + 1.5);
    y += 5.5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.6);
    doc.setTextColor.apply(doc, PO_PDF.INK);
  };

  // The standard set is set two to a row, which keeps a short order on one
  // page; saved wording is prose and runs the full width.
  if (!source) {
    const numbered = PO_PDF_DEFAULT_TERMS.map((t, i) => (i + 1) + '. ' + t);
    const mid = Math.ceil(numbered.length / 2);
    const wrapCol = list => list.reduce((acc, t) => acc.concat(doc.splitTextToSize(t, colW)), []);
    const colA = wrapCol(numbered.slice(0, mid));
    const colB = wrapCol(numbered.slice(mid));
    y = poPdfSpace(doc, y, Math.max(colA.length, colB.length) * 3.5 + 12);
    heading();
    let ay = y, by = y;
    colA.forEach(l => { doc.text(l, M, ay); ay += 3.5; });
    colB.forEach(l => { doc.text(l, M + colW + colGap, by); by += 3.5; });
    return Math.max(ay, by) + 3;
  }

  const lines = doc.splitTextToSize(source, R - M - 4);
  y = poPdfSpace(doc, y, 14);
  heading();
  for (const line of lines) {
    y = poPdfSpace(doc, y, 6);
    doc.text(line, M, y);
    y += 3.6;
  }
  return y + 3;
}

// ── signatures ────────────────────────────────────────────────────────
// The supplier signs the copy they return, so their block is left blank on
// purpose. Ours carries the seal and signature from the profile, if they
// have been configured.
function poPdfSignatures(doc, y, buyer) {
  const M = PO_PDF.MARGIN;
  const R = PO_PDF.PAGE_W - M;
  const gap = 6;
  const w = (R - M - gap) / 2;
  // Every mark inside the block is placed against blockH, so the seal, the
  // signature, the rule and the caption keep their order and never sit on
  // top of one another.
  const blockH = 38;
  const ruleY = y + blockH - 7;

  y = poPdfSpace(doc, y, blockH);

  doc.setDrawColor.apply(doc, PO_PDF.RULE);
  doc.rect(M, y, w, blockH);
  doc.rect(M + w + gap, y, w, blockH);
  doc.setFillColor.apply(doc, PO_PDF.TINT);
  doc.rect(M, y, w, 7, 'F');
  doc.rect(M + w + gap, y, w, 7, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor.apply(doc, PO_PDF.ACCENT);
  doc.text("SUPPLIER'S AUTHORIZED SIGNATORY", M + 3, y + 4.8);
  doc.text('APPROVED BY', M + w + gap + 3, y + 4.8);
  doc.setTextColor.apply(doc, PO_PDF.INK);

  // supplier side: a blank signing area
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  let sy = y + 14;
  ['Name:', 'Date:', 'Signature:'].forEach(label => {
    doc.text(label, M + 4, sy);
    doc.setDrawColor.apply(doc, PO_PDF.RULE);
    doc.line(M + 22, sy + 0.8, M + w - 4, sy + 0.8);
    sy += 8;
  });

  // our side: For <company>, then the seal and the signature side by side,
  // then the caption - the whole group centred on the panel. The marks are
  // laid out from the width of what the profile actually holds, so one on
  // its own is centred too rather than sitting where the pair would start.
  const bx = M + w + gap;
  const cx = bx + w / 2;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.text('For ' + String(buyer.name).toUpperCase(), cx, y + 12.5, { align: 'center' });

  // Both marks finish above the rule; the caption sits below it.
  const markTop = y + 13.5;
  const SEAL = 16, SIGN_W = 28, SIGN_H = 11, MARK_GAP = 4;
  const hasSeal = !!buyer.seal, hasSign = !!buyer.signature;
  const groupW = (hasSeal ? SEAL : 0) + (hasSign ? SIGN_W : 0) + (hasSeal && hasSign ? MARK_GAP : 0);
  let mx = cx - groupW / 2;
  if (hasSeal) {
    try { doc.addImage(buyer.seal, 'PNG', mx, markTop, SEAL, SEAL); } catch (e) { /* optional */ }
    mx += SEAL + MARK_GAP;
  }
  if (hasSign) {
    // Centred against the seal, which is the taller of the two.
    try { doc.addImage(buyer.signature, 'PNG', mx, markTop + (SEAL - SIGN_H) / 2, SIGN_W, SIGN_H); } catch (e) { /* optional */ }
  }
  doc.setDrawColor.apply(doc, PO_PDF.RULE);
  doc.line(bx + 4, ruleY, bx + w - 4, ruleY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text('Authorized Signatory', cx, ruleY + 4.5, { align: 'center' });

  return y + blockH + 4;
}

function generatePurchaseOrderPDF(order, items, mode) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const M = PO_PDF.MARGIN;
  const buyer = poPdfBuyer();

  let y = poPdfHeader(doc, buyer, order);
  y = poPdfParties(doc, y, buyer, order);
  y = poPdfOrderDetails(doc, y, order);

  // ── items ──
  // Every column is a stored column of the line; nothing here is derived.
  const body = (items || []).map((it, i) => [
    String(i + 1),
    String(it.product_name || ''),
    String(it.hsn_code || '—'),
    poPdfQty(it.quantity),
    String(it.unit || '—'),
    poPdfMoney(it.rate),
    poPdfPercent(it.gst_percentage),
    poPdfMoney(it.gst_amount),
    poPdfMoney(it.taxable_value)
  ]);

  doc.autoTable({
    startY: y,
    head: [['#', 'DESCRIPTION', 'HSN/SAC', 'QTY', 'UNIT', 'UNIT PRICE', 'GST %', 'TAX', 'AMOUNT']],
    body,
    theme: 'grid',
    styles: { fontSize: 8, cellPadding: 1.8, lineColor: PO_PDF.RULE, lineWidth: 0.2, overflow: 'linebreak', textColor: PO_PDF.INK },
    headStyles: { fillColor: PO_PDF.ACCENT, textColor: 255, fontStyle: 'bold', fontSize: 7.5, lineWidth: 0.2, halign: 'center' },
    alternateRowStyles: { fillColor: [250, 250, 250] },
    columnStyles: {
      0: { cellWidth: 8, halign: 'center' },
      1: { cellWidth: 'auto' },
      2: { cellWidth: 18 },
      3: { cellWidth: 13, halign: 'right' },
      4: { cellWidth: 12, halign: 'center' },
      5: { cellWidth: 22, halign: 'right' },
      6: { cellWidth: 13, halign: 'right' },
      7: { cellWidth: 21, halign: 'right' },
      8: { cellWidth: 24, halign: 'right' }
    },
    margin: { left: M, right: M, bottom: PO_PDF.FOOT },
    // Repeated on every page the table runs onto.
    showHead: 'everyPage'
  });
  y = doc.lastAutoTable.finalY + 6;

  y = poPdfSummary(doc, y, order, buyer);
  y = poPdfTerms(doc, y, order, buyer);
  poPdfSignatures(doc, y, buyer);

  poPdfFooters(doc, order, buyer);

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

function poPdfFooters(doc, order, buyer) {
  const pages = doc.internal.getNumberOfPages();
  const M = PO_PDF.MARGIN;
  const R = PO_PDF.PAGE_W - M;
  const contact = buyer && (buyer.footerText
    || [buyer.website, buyer.email, buyer.phone].filter(Boolean).join('  |  '));
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setDrawColor.apply(doc, PO_PDF.RULE);
    doc.setLineWidth(0.2);
    doc.line(M, PO_PDF.PAGE_H - 11, R, PO_PDF.PAGE_H - 11);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor.apply(doc, PO_PDF.MUTED);
    doc.text('Purchase Order No. ' + String(order.document_number || ''), M, PO_PDF.PAGE_H - 7);
    if (contact) doc.text(String(contact), PO_PDF.PAGE_W / 2, PO_PDF.PAGE_H - 7, { align: 'center' });
    doc.text(`Page ${p} of ${pages}`, R, PO_PDF.PAGE_H - 7, { align: 'right' });
    doc.setTextColor.apply(doc, PO_PDF.INK);
  }
}
