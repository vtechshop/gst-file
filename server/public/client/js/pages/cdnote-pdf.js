// =============================================
// Credit / Debit Note PDF — a customer-facing A4 document
// =============================================
//
// A note is a single-figure document: cdn_notes stores one taxable amount,
// one rate and one tax split, with no line items of its own. So this draws
// a tax BREAKUP rather than an item table — there is nothing to tabulate,
// and an empty items grid would only look like something had gone missing.
//
// Every figure printed is the figure that is STORED. Nothing here
// recomputes GST, re-splits a tax or reads the original invoice to derive
// anything: a note that was saved at 18% prints at 18% even if the product
// or the rate has moved since, which is the whole point of a tax document.
//
// The layout, the shared helpers (hexToRgb, wrapLines, imageUrlToDataUrl,
// bankDetailLines, generateQRDataUrl) and the letterhead come from
// invoice-pdf.js, which cdnotes.html loads alongside this file — the same
// arrangement sales-return-pdf.js already uses. Nothing in invoice-pdf.js
// is modified.

// The note as the database holds it, scoped to the signed-in tenant by the
// API. A note that was deleted, or that belongs to someone else, comes back
// as no row and is reported rather than drawn.
async function fetchCDNoteRecord(id) {
  const rows = await readAll(
    [_supabase.from('cdn_notes').select('*').eq('id', id)],
    'Could not load the note'
  );
  if (!rows) return null;                       // read failed, already reported
  const note = (rows[0] || [])[0];
  if (!note) { showToast('That note no longer exists.', 'warning'); return null; }
  return note;
}

// A rate, written the way a rate is written. gst_percentage is NUMERIC(5,2)
// and arrives as "18.00", which on a customer's note reads as a stored
// decimal rather than a tax rate. 18.00 becomes 18 and 2.50 becomes 2.5,
// without touching the AMOUNTS, which are printed exactly as stored.
function cdRate(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n * 1000) / 1000);
}

function cdNoteTitle(note) {
  return String(note.note_type || '').toLowerCase() === 'debit' ? 'DEBIT NOTE' : 'CREDIT NOTE';
}

// "Credit-Note-005.pdf". The note number is used as the customer knows it;
// only characters a filesystem would object to are replaced.
function cdNoteFileName(note) {
  const kind = String(note.note_type || '').toLowerCase() === 'debit' ? 'Debit-Note' : 'Credit-Note';
  const num = String(note.note_number == null ? '' : note.note_number)
    .trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${kind}-${num || 'note'}`;
}

async function downloadCDNotePDF(id) {
  const note = await fetchCDNoteRecord(id);
  if (!note) return;
  try {
    const doc = await buildCDNotePDFDoc(note);
    doc.save(cdNoteFileName(note) + '.pdf');
    showToast(cdNoteTitle(note) + ' downloaded!', 'success');
  } catch (err) {
    handleApiError(err, 'building the note PDF');
  }
}

async function buildCDNotePDFDoc(note) {
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

  // Which kind of note this is, said once and unmistakably.
  const isDebit = String(note.note_type || '').toLowerCase() === 'debit';
  doc.setTextColor(...accent);
  doc.setFontSize(15); doc.setFont('helvetica', 'bold');
  doc.text(cdNoteTitle(note), R, 14, { align: 'right' });
  doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(120, 120, 120);
  doc.text(isDebit ? 'Additional amount payable' : 'Amount credited to your account',
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
    'Original Invoice: ' + (note.original_invoice || '-'),
    // Only when the note actually carries one - an empty label reads as a
    // missing value rather than as a field that does not apply.
    note.original_invoice_date ? 'Invoice Date: ' + formatDate(note.original_invoice_date) : '',
    'Supply: ' + (note.supply_type === 'interstate' ? 'Inter-state' : 'Intra-state')
  ].filter(Boolean);
  const colWidth = (pw / 2) - 4 - L - 4;
  const issuedWrapped = wrapLines(doc, issuedBy, colWidth);
  const metaWrapped = wrapLines(doc, meta, R - (pw / 2 + 4));
  const blockTop = y;
  issuedWrapped.forEach((line, i) => doc.text(line, L, blockTop + i * 4.5, { maxWidth: colWidth }));
  metaWrapped.forEach((line, i) => doc.text(line, pw / 2 + 4, blockTop + i * 4.5));
  y = blockTop + Math.max(issuedWrapped.length, metaWrapped.length) * 4.5 + 5;

  // ── Customer ──
  doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...accent);
  doc.text(isDebit ? 'DEBITED TO' : 'CREDITED TO', L, y);
  doc.line(L, y + 1.5, R, y + 1.5);
  y += 6;
  doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(40, 40, 40);
  const custLines = wrapLines(doc, [
    note.customer_name || '',
    note.gstin ? 'GSTIN: ' + note.gstin : '',
    note.state ? 'State: ' + note.state : ''
  ].filter(Boolean), R - L);
  custLines.forEach((line, i) => doc.text(line, L, y + i * 4.5, { maxWidth: R - L }));
  y += custLines.length * 4.5 + 5;

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

  if (y > 210) { doc.addPage(); y = 20; }

  // ── Tax breakup ──
  //
  // Every figure below is read straight off the stored note. The rate is
  // printed beside the tax it produced so the customer can check the note
  // against their own books without doing the arithmetic.
  doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...accent);
  doc.text('TAX BREAKUP', L, y);
  doc.line(L, y + 1.5, R, y + 1.5);
  y += 8;

  const half = cdRate(Number(note.gst_percentage || 0) / 2);
  const rows = [['Taxable Amount', formatNum(note.taxable_amount)],
    ['GST Rate', cdRate(note.gst_percentage) + '%']];
  if (+note.cgst > 0) rows.push([`CGST (${half}%)`, formatNum(note.cgst)]);
  if (+note.sgst > 0) rows.push([`SGST (${half}%)`, formatNum(note.sgst)]);
  if (+note.igst > 0) rows.push([`IGST (${cdRate(note.gst_percentage)}%)`, formatNum(note.igst)]);
  if (+note.cess_amount > 0) rows.push(['Compensation Cess', formatNum(note.cess_amount)]);
  rows.push(['Total GST', formatNum(note.gst_amount)]);

  const boxW = 80, boxX = R - boxW;
  doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(60, 60, 60);
  rows.forEach((r, i) => {
    doc.text(r[0], boxX, y + i * 5.5);
    // The rate is a percentage, not money, so it is the one row without
    // a currency prefix.
    doc.text(r[0] === 'GST Rate' ? r[1] : 'Rs.' + r[1], R, y + i * 5.5, { align: 'right' });
  });
  const ruleY = y + rows.length * 5.5 + 1;
  doc.setDrawColor(60, 60, 60);
  doc.line(boxX, ruleY, R, ruleY);
  doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.setTextColor(...accent);
  doc.text(isDebit ? 'Total Debit Amount' : 'Total Credit Amount', boxX, ruleY + 7);
  doc.text('Rs.' + formatNum(note.total_amount), R, ruleY + 7, { align: 'right' });
  y = ruleY + 16;

  doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(30, 30, 30);
  doc.text('Amount in Words:', L, y);
  doc.setFont('helvetica', 'bold');
  doc.text(numberToWordsINR(note.total_amount), L, y + 5, { maxWidth: R - L });
  y += 13;

  doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(110, 110, 110);
  doc.text(isDebit
    ? '* This Debit Note increases the amount payable against the invoice referenced above.'
    : '* This Credit Note reduces the amount payable against the invoice referenced above.', L, y);
  y += 8;

  const bankLines = (typeof bankDetailLines === 'function') ? bankDetailLines(p) : [];
  if (bankLines.length) {
    if (y > 250) { doc.addPage(); y = 20; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...accent);
    doc.text('Bank Details', L, y);
    y += 4.5;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(60, 60, 60);
    bankLines.forEach((l, i) => doc.text(l, L, y + i * 4));
    y += bankLines.length * 4 + 6;
  }

  // ── Signature and footer, anchored to the foot of the page ──
  //
  // A Tax Invoice measures its footer first and hangs the signature row
  // directly above it, so the stamp, the footer and the margin beneath them
  // sit at the same height on every invoice however long it runs. The note
  // used to draw both wherever its content happened to end, which put the
  // stamp about 20mm higher than on an invoice and left the footer floating
  // mid-page over an empty band. These are the invoice's own measurements
  // (its closing grid in invoice-pdf.js), so the two land on the same line
  // of the sheet.
  const qrSource = qrCustomData || await generateQRDataUrl(
    `${cdNoteTitle(note)}: ${note.note_number}\nDate: ${formatDate(note.note_date)}\nAmount: Rs.${formatNum(note.total_amount)}`,
    p?.header_color);
  const [sealInk, sigInk] = await Promise.all([inkBoundsOf(sealData), inkBoundsOf(signatureData)]);
  const SEAL = 26;                             // mm across the visible stamp
  const sealReserveH = sealData ? SEAL : (signatureData ? 18 : 14);
  const SIG_BLOCK_H = 6 + sealReserveH + 5;    // gap + stamp reserve + caption
  // The rule, the computer-generated line and the contact line, measured as
  // the invoice measures the same three. The note prints no profile footer
  // text, so that term is zero here.
  const footerH = 6 + 4 + 4;                   // rule + gap, generated line + contact
  // The page number sits 8mm from the bottom, so the footer finishes above that.
  const PAGE_BOTTOM = doc.internal.pageSize.height - 12;
  const FOOTER_Y = PAGE_BOTTOM - footerH;
  // The invoice's signature row, held tall enough for the QR and its caption
  // on the left, which the invoice keeps in a row of its own.
  const SIG_ROW_H = Math.max(SIG_BLOCK_H + 3, qrSource ? 32 : 0);
  const sigBlockY = FOOTER_Y - SIG_ROW_H;
  // Content that already reaches into the band moves the band to a new
  // page; drawing the stamp over it is never the answer.
  if (y > sigBlockY) doc.addPage();

  if (qrSource) {
    try {
      doc.addImage(qrSource, 'PNG', L, sigBlockY, 24, 24);
      doc.setFontSize(7); doc.setTextColor(...accent); doc.setFont('helvetica', 'normal');
      doc.text('Scan to verify', L, sigBlockY + 28);
    } catch {}
  }
  // The seal / signature block, reproduced from drawSignatureBlock() in
  // invoice-pdf.js so a note is signed exactly as a Tax Invoice is: the same
  // 26mm stamp, the same caption above it, the signature centred on the
  // stamp's visible ink, and the same rule and "Authorized Signatory" below.
  //
  // Positioned against the INVOICE's right edge (pw - 8), not this page's
  // 14mm content margin, so the block lands on the same spot of the sheet as
  // it does on an invoice. The ink measurement and placement are the
  // invoice's own helpers, loaded beside this file - not copies of them.
  const SIG_R = pw - 8;                  // the Tax Invoice's right edge
  const sealCx = SIG_R - 5 - SEAL / 2;   // centre, held clear of the margin
  const sealTop = sigBlockY + 6;         // top of the stamp; "For ..." sits above

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
    if (sig.inkH > maxH) {
      const k = maxH / sig.inkH;
      sig = placeInk(sigInk, seal.inkW * 0.62 * k, cx, 0);
    }
    const sigBounds = sigInk || { y: 0, h: 1 };
    sig.y = cy - sigBounds.y * sig.h - sig.inkH / 2;
    try { doc.addImage(signatureData, 'PNG', sig.x, sig.y, sig.w, sig.h); } catch {}
  }

  const authY = sealTop + seal.inkH + 5;
  const authW = Math.min(22, SIG_R - 3 - sealCx);
  // The rule is drawn at the invoice's weight, then the previous weight is
  // put back so the footer divider below is exactly what it always was.
  const priorLineWidth = typeof doc.getLineWidth === 'function' ? doc.getLineWidth() : null;
  doc.setDrawColor(...RULE_INK);
  doc.setLineWidth(RULE_CELL);
  doc.line(sealCx - authW, authY - 3.5, sealCx + authW, authY - 3.5);
  if (priorLineWidth !== null) doc.setLineWidth(priorLineWidth);
  doc.setFontSize(8); doc.setTextColor(120, 120, 120);
  doc.text('Authorized Signatory', sealCx, authY, { align: 'center' });

  // The footer, exactly where the invoice's is. The block above ends at
  // FOOTER_Y - 3 at the lowest, so the rule can never run through it.
  y = FOOTER_Y;
  doc.setDrawColor(178, 223, 219);
  doc.line(L, y, R, y);
  y += 6;
  doc.setFontSize(7.5); doc.setTextColor(140, 140, 140);
  doc.text('This is a computer-generated ' + (isDebit ? 'Debit Note' : 'Credit Note') + '.',
    pw / 2, y, { align: 'center' });
  y += 5;
  const contactLine = [p?.email, p?.phone, p?.website].filter(Boolean).join('  |  ');
  if (contactLine) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(140, 140, 140);
    doc.text(contactLine, pw / 2, y, { align: 'center' });
  }

  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(7); doc.setTextColor(180);
    doc.text(`Page ${i} of ${pageCount}`, L, doc.internal.pageSize.height - 8);
  }

  return doc;
}
