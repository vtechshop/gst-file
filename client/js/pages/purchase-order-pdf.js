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
// item table, the tax summary beside the amount in words, terms and
// conditions, then the supplier and approval signatures. A purchase order is
// issued TO a supplier, so it carries no bank details of ours.
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
// Each clause is a heading and a body: the heading is set in bold so the six
// points can be scanned, the body wraps beneath it. Generic on purpose - no
// party, address, GSTIN or contact belongs in wording reused by every order.
const PO_PDF_DEFAULT_TERMS = [
  ['Delivery',
    'Material shall be dispatched within the agreed delivery period from the date of receipt '
    + 'of this Purchase Order and delivered to the address mentioned in the order.'],
  ['Inspection & Acceptance',
    'All materials are subject to inspection and acceptance. Rejected or defective materials '
    + 'shall be replaced by the supplier at no additional cost.'],
  ['Price',
    'The prices mentioned in this Purchase Order are firm and fixed until completion of the '
    + 'order, unless otherwise agreed in writing.'],
  ['Order Amendment',
    'Any amendment or change to this Purchase Order shall be valid only with written approval '
    + 'from both parties.'],
  ['Invoice & Delivery Documents',
    'The supplier shall mention our Purchase Order Number on the invoice and submit the '
    + 'invoice along with the delivery/delivery note.'],
  ['Order Acknowledgement',
    'The supplier shall provide a signed and stamped acknowledgement of the Purchase Order '
    + 'within two working days. If no objection is received within this period, the order '
    + 'shall be deemed accepted.']
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

// ── the tax summary and the amount in words ───────────────────────────
function poPdfSummary(doc, y, order, buyer) {
  const M = PO_PDF.MARGIN;
  const R = PO_PDF.PAGE_W - M;

  const rows = [['Untaxed Amount', poPdfMoney(order.taxable_amount)]];
  if (Number(order.cgst)) rows.push(['CGST', poPdfMoney(order.cgst)]);
  if (Number(order.sgst)) rows.push(['SGST', poPdfMoney(order.sgst)]);
  if (Number(order.igst)) rows.push(['IGST', poPdfMoney(order.igst)]);
  if (Number(order.cess_amount)) rows.push(['Cess', poPdfMoney(order.cess_amount)]);

  const words = (typeof numberToWordsINR === 'function') ? numberToWordsINR(order.total_amount) : '';
  const boxW = 76;
  const boxX = R - boxW;
  const leftW = boxX - M - 6;
  const wordLines = words ? doc.splitTextToSize(words, leftW - 4) : [];
  const summaryH = rows.length * 6 + 11;
  const leftH = wordLines.length ? wordLines.length * 4 + 9 : 0;

  y = poPdfSpace(doc, y, Math.max(summaryH, leftH) + 4);

  // amount in words, from the shared helper the rest of the app uses
  const ly = y;
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

  // The standard set runs the full width, one numbered paragraph per clause:
  // six clauses of real wording set two to a row would be a column of about
  // fifty characters, which is where terms stop being read. A clause that
  // would run past the foot of the page starts the next one whole, so no
  // paragraph is ever split across the break.
  if (!source) {
    const bodyW = R - M - 4;
    y = poPdfSpace(doc, y, 14);
    heading();
    PO_PDF_DEFAULT_TERMS.forEach((clause, i) => {
      const [label, text] = clause;
      const lead = (i + 1) + '. ' + label + ': ';
      doc.setFont('helvetica', 'bold');
      const leadW = doc.getTextWidth(lead);
      // The first line sits beside the heading, the rest wrap under it.
      const first = doc.splitTextToSize(text, bodyW - leadW);
      const firstLine = first[0] || '';
      const restText = text.slice(firstLine.length).trim();
      const rest = restText ? doc.splitTextToSize(restText, bodyW) : [];
      y = poPdfSpace(doc, y, (rest.length + 1) * 3.6 + 4);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor.apply(doc, PO_PDF.INK);
      doc.text(lead, M, y);
      doc.setFont('helvetica', 'normal');
      doc.text(firstLine, M + leadW, y);
      let ly = y;
      rest.forEach(l => { ly += 3.6; doc.text(l, M, ly); });
      y = ly + 4.4;
    });
    return y + 1;
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
// purpose. Ours is signed exactly as a Tax Invoice is: the stamp measured
// by its visible ink rather than by the file's edges, the caption above it,
// the signature beside it across a small gap, then the rule and
// "Authorized Signatory" beneath. Seal and signature are centred as one
// group, so the pair reads as a single approval mark. inkBoundsOf() and placeInk() are
// invoice-pdf.js's own helpers, loaded beside this file - not copies. When
// they are absent the marks still draw, from the file's edges.
const PO_SEAL = 19;          // mm across the visible stamp
const PO_SIG_OF_SEAL = 0.9;  // the signature, as a fraction of that width
const PO_MARK_GAP = 4;       // mm of air between the stamp and the signature

async function poPdfSignatures(doc, y, buyer) {
  const M = PO_PDF.MARGIN;
  const R = PO_PDF.PAGE_W - M;
  const gap = 6;
  const w = (R - M - gap) / 2;
  // Every mark inside the block is placed against blockH, so the seal, the
  // signature, the rule and the caption keep their order and never sit on
  // top of one another.
  const blockH = 40;
  const ruleY = y + blockH - 5.5;

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

  // our side: For <company>, the stamp with the signature on it, then the
  // rule and the caption - every one of them centred on the panel, so the
  // block reads as one approval mark however many assets are configured.
  const bx = M + w + gap;
  const cx = bx + w / 2;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.text('For ' + String(buyer.name).toUpperCase(), cx, y + 11, { align: 'center' });

  const measure = (typeof inkBoundsOf === 'function') ? inkBoundsOf : async () => null;
  const place = (typeof placeInk === 'function') ? placeInk : null;
  const [sealInk, sigInk] = await Promise.all([measure(buyer.seal), measure(buyer.signature)]);

  // One group, centred as a whole: the stamp, a small gap, the signature.
  // Both ink boxes are worked out before anything is drawn, because centring
  // each mark on the panel in turn would stack one on top of the other.
  const markTop = y + 12.5;
  const SB = sealInk || { x: 0, y: 0, w: 1, h: 1, imgW: 1, imgH: 1 };
  const GB = sigInk || { x: 0, y: 0, w: 1, h: 1, imgW: 1, imgH: 1 };
  const sealTall = (SB.h / SB.w) * (SB.imgH / SB.imgW);   // ink height per unit of width
  const sigTall = (GB.h / GB.w) * (GB.imgH / GB.imgW);
  const sealW = buyer.seal ? PO_SEAL / Math.max(1, sealTall) : 0;   // a tall stamp is not blown up
  const sealH = sealW * sealTall;
  let sigW = buyer.signature ? PO_SEAL * PO_SIG_OF_SEAL : 0;
  let sigH = sigW * sigTall;
  const sigCap = (sealH || PO_SEAL) * 0.75;               // never overpowers the stamp
  if (sigH > sigCap) { sigW *= sigCap / sigH; sigH = sigCap; }

  // With one asset missing its gap collapses, so the survivor centres alone.
  const markGap = (sealW && sigW) ? PO_MARK_GAP : 0;
  const left = cx - (sealW + markGap + sigW) / 2;
  const sealCx = left + sealW / 2;
  const sigCx = left + sealW + markGap + sigW / 2;
  const midY = markTop + (sealH || PO_SEAL) / 2;          // one centre line for both

  if (buyer.seal) {
    if (place) {
      const s = place(sealInk, sealW, sealCx, markTop);
      try { doc.addImage(buyer.seal, 'PNG', s.x, s.y, s.w, s.h); } catch (e) { /* optional */ }
    } else {
      try { doc.addImage(buyer.seal, 'PNG', sealCx - sealW / 2, markTop, sealW, sealH); } catch (e) { /* optional */ }
    }
  }
  if (buyer.signature) {
    if (place) {
      const g = place(sigInk, sigW, sigCx, 0);
      g.y = midY - GB.y * g.h - g.inkH / 2;               // sits on the stamp's centre line
      try { doc.addImage(buyer.signature, 'PNG', g.x, g.y, g.w, g.h); } catch (e) { /* optional */ }
    } else {
      try { doc.addImage(buyer.signature, 'PNG', sigCx - sigW / 2, midY - sigH / 2, sigW, sigH); } catch (e) { /* optional */ }
    }
  }

  doc.setDrawColor.apply(doc, PO_PDF.RULE);
  doc.line(cx - 22, ruleY, cx + 22, ruleY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text('Authorized Signatory', cx, ruleY + 4, { align: 'center' });

  return y + blockH + 4;
}

// Async because the stamp is measured from its own pixels before it is
// placed - see poPdfSignatures(). The callers fire and forget, exactly as
// they did; the document is finished before it is saved or printed.
async function generatePurchaseOrderPDF(order, items, mode) {
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
  await poPdfSignatures(doc, y, buyer);

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
