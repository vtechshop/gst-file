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

  if (y > 250) { doc.addPage(); y = 20; }

  // ── Signature ──
  const qrSource = qrCustomData || await generateQRDataUrl(
    `${cdNoteTitle(note)}: ${note.note_number}\nDate: ${formatDate(note.note_date)}\nAmount: Rs.${formatNum(note.total_amount)}`,
    p?.header_color);
  const sigBlockY = y;
  if (qrSource) {
    try {
      doc.addImage(qrSource, 'PNG', L, y, 24, 24);
      doc.setFontSize(7); doc.setTextColor(...accent); doc.setFont('helvetica', 'normal');
      doc.text('Scan to verify', L, y + 28);
    } catch {}
  }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(30, 30, 30);
  doc.text('For ' + (p?.business_name || 'Us'), R, sigBlockY + 4, { align: 'right' });
  if (sealData) { try { doc.addImage(sealData, 'PNG', R - 88, sigBlockY, 20, 20); } catch {} }
  if (signatureData) { try { doc.addImage(signatureData, 'PNG', R - 45, sigBlockY + 6, 35, 14); } catch {} }
  doc.setFontSize(8); doc.setTextColor(120, 120, 120);
  doc.text('Authorized Signatory', R, sigBlockY + 24, { align: 'right' });
  y = sigBlockY + 32;

  if (y > 260) { doc.addPage(); y = 20; }
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
