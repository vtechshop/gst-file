// =============================================
// Purchase Credit / Debit Note PDF
//
// Prints the note exactly as it was saved. Every figure comes from the note
// row and its stored items (purchase_note_items) - never from the purchase's
// current lines and never from the Product Master, so a note keeps saying
// what it was raised for even after the purchase or the product is changed.
//
// Nothing here recomputes tax. The note's own taxable amount, GST split and
// total are printed as stored.
//
// The shared helpers (hexToRgb, wrapLines, imageUrlToDataUrl, bankDetailLines,
// generateQRDataUrl, inkBoundsOf, placeInk) come from invoice-pdf.js, which
// the page loads beside this file - exactly as cdnotes.html does. Nothing in
// it is modified.
// =============================================

async function fetchPurchaseNoteRecord(id) {
  const rows = await readAll([
    _supabase.from('purchase_notes').select('*').eq('id', id)
  ], 'Could not load the note');
  if (!rows || !rows[0].length) {
    showToast('That note could not be read.', 'error');
    return null;
  }
  return rows[0][0];
}

// The note's own items, and only those. Read every time so a note edited in
// another tab prints its new items.
async function fetchPurchaseNoteItems(id) {
  const rows = await readAll([
    _supabase.from('purchase_note_items').select('*').eq('note_id', id).order('sort_order', { ascending: true })
  ], 'Could not load the note\'s items');
  return rows ? rows[0] : null;
}

const pnRate = v => String(Math.round(Number(v || 0) * 100) / 100);
const pnMoney = v => (v === null || v === undefined || v === '' ? '-' : formatNum(v));
const pnQty = v => (v === null || v === undefined || v === '' ? '-' : String(Number(v)));

function purchaseNoteTitle(note) {
  return String(note.note_type || '').toLowerCase() === 'debit'
    ? 'PURCHASE DEBIT NOTE' : 'PURCHASE CREDIT NOTE';
}
function purchaseNoteFileName(note) {
  const kind = String(note.note_type || '').toLowerCase() === 'debit' ? 'Purchase-Debit-Note' : 'Purchase-Credit-Note';
  return `${kind}-${String(note.note_number || '').replace(/[^A-Za-z0-9_-]/g, '') || 'note'}.pdf`;
}

// The item table's columns, across the full 182mm between the margins.
// Unit stands in a column of its own - never glued onto the quantity - so
// the affected product reads at a glance.
const PN_ITEM_COLS = [
  { head: 'Product / Item', w: 66, align: 'left' },
  { head: 'HSN/SAC', w: 22, align: 'left' },
  { head: 'Unit', w: 14, align: 'left' },
  { head: 'Qty', w: 18, align: 'right' },
  { head: 'Rate', w: 22, align: 'right' },
  { head: 'GST %', w: 14, align: 'right' },
  { head: 'Taxable Amount', w: 26, align: 'right' }
];

// AFFECTED ITEMS, one row per stored item, in the order they were saved.
// Drawn by hand rather than with autoTable so the page breaks are this
// document's own: a row that would run past the foot of the page starts the
// next one, with the column heads drawn again at its top.
function drawPurchaseNoteItems(doc, items, top, { L, R, accent, gstPct }) {
  const floor = doc.internal.pageSize.height - 20;
  const tint = [Math.min(accent[0] + 224, 255), Math.min(accent[1] + 165, 255), Math.min(accent[2] + 177, 255)];
  const PAD = 1.5;
  const edges = [];
  PN_ITEM_COLS.reduce((x, c) => { edges.push(x); return x + c.w; }, L);
  const cellX = i => (PN_ITEM_COLS[i].align === 'right' ? edges[i] + PN_ITEM_COLS[i].w - PAD : edges[i] + PAD);
  let y = top;

  if (y + 4 + 6 + 6.2 > floor) { doc.addPage(); y = 20; }
  doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...accent);
  doc.text('AFFECTED ITEMS', L, y);
  doc.setDrawColor(178, 223, 219);
  doc.line(L, y + 1.5, R, y + 1.5);
  y += 4;

  const drawHeads = () => {
    doc.setFillColor(...tint);
    doc.rect(L, y, R - L, 6, 'F');
    doc.setFontSize(7.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...accent);
    PN_ITEM_COLS.forEach((c, i) => doc.text(c.head, cellX(i), y + 4.1, { align: c.align }));
    y += 6;
  };
  drawHeads();

  // One note, one GST rate: the server refuses an item charged at any other
  // rate, so the note's own rate is every line's rate. Nothing is derived.
  const gstText = (gstPct === null || gstPct === undefined || gstPct === '')
    ? '-' : pnRate(gstPct) + '%';

  for (const it of items) {
    doc.setFontSize(8); doc.setFont('helvetica', 'normal');
    const nameLines = doc.splitTextToSize(String(it.product_name || '-'), PN_ITEM_COLS[0].w - PAD * 2);
    const rowH = nameLines.length * 3.6 + 2.6;
    if (y + rowH > floor) {
      doc.addPage(); y = 20; drawHeads();
      doc.setFontSize(8); doc.setFont('helvetica', 'normal');
    }
    doc.setTextColor(40, 40, 40);
    const base = y + 4;
    doc.text(nameLines, cellX(0), base);
    [
      it.hsn_code || '-',
      it.unit || '-',
      pnQty(it.quantity),
      pnMoney(it.rate),
      gstText,
      pnMoney(it.taxable_value)
    ].forEach((v, j) => doc.text(String(v), cellX(j + 1), base, { align: PN_ITEM_COLS[j + 1].align }));
    doc.setDrawColor(178, 223, 219);
    doc.line(L, y + rowH, R, y + rowH);
    y += rowH;
  }
  return y + 6;
}

async function downloadPurchaseNotePDF(id) {
  const note = await fetchPurchaseNoteRecord(id);
  if (!note) return;
  // The stored items, read with the note. A failed read stops here rather
  // than printing a note that silently claims to cover nothing.
  const items = await fetchPurchaseNoteItems(id);
  if (!items) return;
  try {
    const doc = await buildPurchaseNotePDFDoc(note, items);
    doc.save(purchaseNoteFileName(note));
  } catch (err) {
    handleApiError(err, 'Could not build the PDF');
  }
}

async function buildPurchaseNotePDFDoc(note, items) {
  const noteItems = Array.isArray(items) ? items : [];
  const p = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const accent = hexToRgb(p?.header_color);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pw = doc.internal.pageSize.width;
  const L = 14, R = pw - 14;

  const [logoData, sealData, signatureData, qrCustomData] = await Promise.all([
    imageUrlToDataUrl(p?.logo_base64),
    imageUrlToDataUrl(p?.seal_base64),
    imageUrlToDataUrl(p?.signature_base64),
    imageUrlToDataUrl(p?.qr_base64)
  ]);

  // ── Letterhead ──
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

  const isDebit = String(note.note_type || '').toLowerCase() === 'debit';
  doc.setTextColor(...accent);
  doc.setFontSize(15); doc.setFont('helvetica', 'bold');
  doc.text(purchaseNoteTitle(note), R, 14, { align: 'right' });
  doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(120, 120, 120);
  doc.text(isDebit ? 'Amount recoverable from the supplier' : 'Amount allowed by the supplier',
    R, 20, { align: 'right' });

  doc.setFillColor(...accent);
  doc.rect(L, 25, R - L, 1.3, 'F');

  let y = 34;

  // ── Issued by / note details ──
  doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...accent);
  doc.text('ISSUED BY', L, y);
  doc.text('NOTE DETAILS', pw / 2 + 4, y);
  doc.setDrawColor(178, 223, 219);
  doc.line(L, y + 1.5, R, y + 1.5);
  y += 6;

  doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(40, 40, 40);
  const issuedBy = [
    p?.business_name || '',
    p?.address || '',
    p?.state || '',
    p?.gstin ? 'GSTIN: ' + p.gstin : '',
    p?.pan ? 'PAN: ' + p.pan : ''
  ].filter(Boolean);
  const meta = [
    'Note No: ' + (note.note_number || ''),
    'Note Date: ' + formatDate(note.note_date),
    'Original Purchase: ' + (note.original_purchase_number || '-'),
    note.original_purchase_date ? 'Purchase Date: ' + formatDate(note.original_purchase_date) : '',
    'Supply: ' + (note.supply_type === 'interstate' ? 'Inter-state' : 'Intra-state')
  ].filter(Boolean);
  const colWidth = (pw / 2) - 4 - L - 4;
  const issuedWrapped = wrapLines(doc, issuedBy, colWidth);
  const metaWrapped = wrapLines(doc, meta, R - (pw / 2 + 4));
  const blockTop = y;
  issuedWrapped.forEach((line, i) => doc.text(line, L, blockTop + i * 4.5, { maxWidth: colWidth }));
  metaWrapped.forEach((line, i) => doc.text(line, pw / 2 + 4, blockTop + i * 4.5));
  y = blockTop + Math.max(issuedWrapped.length, metaWrapped.length) * 4.5 + 5;

  // ── Supplier ──
  doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...accent);
  doc.text('SUPPLIER', L, y);
  doc.line(L, y + 1.5, R, y + 1.5);
  y += 6;
  doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(40, 40, 40);
  const vendLines = wrapLines(doc, [
    note.vendor_name || '',
    note.vendor_gstin ? 'GSTIN: ' + note.vendor_gstin : '',
    note.state ? 'State: ' + note.state : ''
  ].filter(Boolean), R - L);
  vendLines.forEach((line, i) => doc.text(line, L, y + i * 4.5, { maxWidth: R - L }));
  y += vendLines.length * 4.5 + 5;

  // ── Reason ──
  if (note.reason) {
    doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...accent);
    doc.text('REASON', L, y);
    doc.line(L, y + 1.5, R, y + 1.5);
    y += 6;
    doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(40, 40, 40);
    const reasonLines = wrapLines(doc, [String(note.reason)], R - L);
    reasonLines.forEach((line, i) => doc.text(line, L, y + i * 4.5, { maxWidth: R - L }));
    y += reasonLines.length * 4.5 + 5;
  }

  // ── Affected items ──
  // Only the products this note was raised for - never the purchase's other
  // lines. The note's own figures below stay authoritative.
  if (noteItems.length) {
    y = drawPurchaseNoteItems(doc, noteItems, y, { L, R, accent, gstPct: note.gst_percentage });
  }

  if (y > 210) { doc.addPage(); y = 20; }

  // ── Tax breakup ──
  doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...accent);
  doc.text('TAX BREAKUP', L, y);
  doc.line(L, y + 1.5, R, y + 1.5);
  y += 8;

  const half = pnRate(Number(note.gst_percentage || 0) / 2);
  const rows = [['Taxable Amount', formatNum(note.taxable_amount)],
    ['GST Rate', pnRate(note.gst_percentage) + '%']];
  if (+note.cgst > 0) rows.push([`CGST (${half}%)`, formatNum(note.cgst)]);
  if (+note.sgst > 0) rows.push([`SGST (${half}%)`, formatNum(note.sgst)]);
  if (+note.igst > 0) rows.push([`IGST (${pnRate(note.gst_percentage)}%)`, formatNum(note.igst)]);
  if (+note.cess_amount > 0) rows.push(['Compensation Cess', formatNum(note.cess_amount)]);
  rows.push(['Total GST', formatNum(note.gst_amount)]);

  const boxW = 80, boxX = R - boxW;
  const taxTop = y;
  doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(60, 60, 60);
  rows.forEach((r, i) => {
    doc.text(r[0], boxX, y + i * 5.5);
    doc.text(r[0] === 'GST Rate' ? r[1] : 'Rs.' + r[1], R, y + i * 5.5, { align: 'right' });
  });
  const ruleY = y + rows.length * 5.5 + 1;
  doc.setDrawColor(60, 60, 60);
  doc.line(boxX, ruleY, R, ruleY);
  doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.setTextColor(...accent);
  doc.text(isDebit ? 'Total Debit Amount' : 'Total Credit Amount', boxX, ruleY + 7);
  doc.text('Rs.' + formatNum(note.total_amount), R, ruleY + 7, { align: 'right' });

  // Bank details beside the breakup when the note carries items, as the
  // sales note does - below it would push the signature onto a second page.
  const bankLines = (typeof bankDetailLines === 'function') ? bankDetailLines(p) : [];
  const bankBeside = noteItems.length > 0 && bankLines.length > 0;
  let bankBottom = taxTop;
  if (bankBeside) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...accent);
    doc.text('Bank Details', L, taxTop);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(60, 60, 60);
    const bankWrapped = wrapLines(doc, bankLines, boxX - L - 6);
    bankWrapped.forEach((l, i) => doc.text(l, L, taxTop + 4.5 + i * 4));
    bankBottom = taxTop + 4.5 + bankWrapped.length * 4;
  }
  y = Math.max(ruleY + 16, bankBottom + 6);

  doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(30, 30, 30);
  doc.text('Amount in Words:', L, y);
  doc.setFont('helvetica', 'bold');
  doc.text(numberToWordsINR(note.total_amount), L, y + 5, { maxWidth: R - L });
  y += 13;

  doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(110, 110, 110);
  doc.text(isDebit
    ? '* This Debit Note increases the amount recoverable from the supplier against the purchase referenced above.'
    : '* This Credit Note reduces the amount payable to the supplier against the purchase referenced above.',
    L, y, { maxWidth: R - L });
  y += 8;
  doc.setFont('helvetica', 'italic'); doc.setFontSize(7.5); doc.setTextColor(130, 130, 130);
  doc.text('* A financial adjustment only. Goods physically returned are recorded on a Purchase Return.',
    L, y, { maxWidth: R - L });
  y += 8;

  if (bankLines.length && !bankBeside) {
    if (y > 250) { doc.addPage(); y = 20; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...accent);
    doc.text('Bank Details', L, y);
    y += 4.5;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(60, 60, 60);
    bankLines.forEach((l, i) => doc.text(l, L, y + i * 4));
    y += bankLines.length * 4 + 6;
  }

  // ── Signature and footer, anchored to the foot of the page ──
  // The same closing grid the sales note uses, so the stamp, the footer and
  // the margin beneath them sit at the same height on every document.
  const qrSource = qrCustomData || await generateQRDataUrl(
    `${purchaseNoteTitle(note)}: ${note.note_number}\nDate: ${formatDate(note.note_date)}\nAmount: Rs.${formatNum(note.total_amount)}`,
    p?.header_color);
  const [sealInk, sigInk] = await Promise.all([inkBoundsOf(sealData), inkBoundsOf(signatureData)]);
  const SEAL = 26;
  const sealReserveH = sealData ? SEAL : (signatureData ? 18 : 14);
  const SIG_BLOCK_H = 6 + sealReserveH + 5;
  const footerH = 6 + 4 + 4;
  const PAGE_BOTTOM = doc.internal.pageSize.height - 12;
  const FOOTER_Y = PAGE_BOTTOM - footerH;
  const SIG_ROW_H = Math.max(SIG_BLOCK_H + 3, qrSource ? 32 : 0);
  const sigBlockY = FOOTER_Y - SIG_ROW_H;
  if (y > sigBlockY) doc.addPage();

  if (qrSource) {
    try {
      doc.addImage(qrSource, 'PNG', L, sigBlockY, 24, 24);
      doc.setFontSize(7); doc.setTextColor(...accent); doc.setFont('helvetica', 'normal');
      doc.text('Scan to verify', L, sigBlockY + 28);
    } catch {}
  }

  const SIG_R = pw - 8;
  const sealCx = SIG_R - 5 - SEAL / 2;
  const sealTop = sigBlockY + 6;

  const sealBounds = sealInk || { w: 1, h: 1, imgW: 1, imgH: 1 };
  const sealWantW = SEAL * sealBounds.w
    / Math.max(sealBounds.w, sealBounds.h * (sealBounds.imgH / sealBounds.imgW));
  const seal = sealData ? placeInk(sealInk, sealWantW, sealCx, sealTop)
                        : { inkW: SEAL, inkH: sealReserveH };

  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(30, 30, 30);
  doc.text('For ' + (p?.business_name || 'Us'), sealCx, sealTop - 1.8, { align: 'center' });

  if (sealData) {
    try { doc.addImage(sealData, 'PNG', seal.x, seal.y, seal.w, seal.h); } catch {}
  }
  if (signatureData) {
    const cx = sealCx, cy = sealTop + seal.inkH * 0.50;
    let sig = placeInk(sigInk, seal.inkW * 0.62, cx, 0);
    const maxH = seal.inkH * 0.5;
    if (sig.inkH > maxH) sig = placeInk(sigInk, seal.inkW * 0.62 * (maxH / sig.inkH), cx, 0);
    const sigBounds = sigInk || { y: 0, h: 1 };
    sig.y = cy - sigBounds.y * sig.h - sig.inkH / 2;
    try { doc.addImage(signatureData, 'PNG', sig.x, sig.y, sig.w, sig.h); } catch {}
  }

  const authY = sealTop + seal.inkH + 5;
  const authW = Math.min(22, SIG_R - 3 - sealCx);
  doc.setDrawColor(120, 120, 120);
  doc.line(sealCx - authW, authY - 3.5, sealCx + authW, authY - 3.5);
  doc.setFontSize(8); doc.setTextColor(120, 120, 120);
  doc.text('Authorized Signatory', sealCx, authY, { align: 'center' });

  // ── Footer ──
  y = FOOTER_Y;
  doc.setDrawColor(178, 223, 219);
  doc.line(L, y, R, y);
  y += 6;
  doc.setFontSize(7.5); doc.setTextColor(140, 140, 140);
  doc.text('This is a computer-generated Purchase ' + (isDebit ? 'Debit Note' : 'Credit Note') + '.',
    pw / 2, y, { align: 'center' });
  const contact = [p?.website, p?.email, p?.phone].filter(Boolean).join('  |  ');
  if (contact) {
    doc.text(contact, pw / 2, y + 4, { align: 'center' });
  }

  return doc;
}
