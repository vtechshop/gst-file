// =============================================
// Sales Return PDF / Print / WhatsApp / Email
// Mirrors js/invoice-pdf.js's structure and layout exactly (same
// letterhead, two-column details block, item table, ruled totals,
// bank/QR/signature footer) but as its own file — js/invoice-pdf.js is
// never touched — with the document re-labeled "SALES RETURN" and the
// details column showing the original invoice reference instead of
// place-of-supply/reverse-charge invoice metadata. Same Business
// Profile branding source (getCachedProfile(), bankDetailLines()).
// =============================================

async function fetchSalesReturnRecord(id) {
  const { data } = await _supabase.from('sales_returns').select('*').eq('id', id).single();
  if (!data) { showToast('Sales return not found.', 'error'); return null; }

  const { data: itemRows } = await _supabase.from('sales_return_items').select('*').eq('return_id', data.id);
  const activeItems = (itemRows || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  return {
    id: data.id,
    return_number: data.return_number,
    return_date: data.return_date,
    customer_name: data.customer_name || '',
    gstin: data.customer_gstin || '',
    state: data.state || '',
    address: data.address || '',
    phone: data.phone || '',
    original_invoice_number: data.original_invoice_number || '',
    original_invoice_type: data.original_invoice_type,
    reason: data.reason || '',
    taxable_amount: +data.taxable_amount,
    gst_percentage: +data.gst_percentage,
    gst_amount: +data.gst_amount,
    total_amount: +data.total_amount,
    supply_type: data.supply_type,
    igst: +data.igst, cgst: +data.cgst, sgst: +data.sgst,
    round_off: round2(+data.total_amount - +data.taxable_amount - +data.gst_amount),
    items: activeItems.length ? activeItems : null
  };
}

function srPlaceOfSupply(sr) {
  return sr.state || (sr.supply_type === 'interstate' ? 'Other State' : '');
}

// ── PDF ──────────────────────────────────────────────
async function downloadSalesReturnPDF(id) {
  const sr = await fetchSalesReturnRecord(id);
  if (!sr) return;
  const doc = await buildSalesReturnPDFDoc(sr);
  doc.save(`SalesReturn_${sr.return_number}.pdf`);
  showToast('Sales Return PDF downloaded!', 'success');
}

async function buildSalesReturnPDFDoc(sr) {
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
  doc.text('SALES RETURN', R, 14, { align: 'right' });
  doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(120, 120, 120);
  doc.text('Goods Return Note', R, 20, { align: 'right' });

  doc.setFillColor(...accent);
  doc.rect(L, 25, R - L, 1.3, 'F');

  let y = 34;

  doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...accent);
  doc.text('ISSUED BY', L, y);
  doc.text('RETURN DETAILS', pw / 2 + 4, y);
  doc.setDrawColor(178, 223, 219);
  doc.line(L, y + 1.5, R, y + 1.5);
  y += 6;

  doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(40, 40, 40);
  const soldByLines = [
    p?.business_name || '',
    p?.address || '',
    p?.state || '',
    p?.gstin ? 'GSTIN: ' + p.gstin : '',
    p?.pan ? 'PAN: ' + p.pan : ''
  ].filter(Boolean);
  const metaLines = [
    'Return No: ' + (sr.return_number || ''),
    'Return Date: ' + formatDate(sr.return_date),
    'Original Invoice: ' + (sr.original_invoice_number || '-') + ' (' + sr.original_invoice_type.toUpperCase() + ')',
    'Place of Supply: ' + (srPlaceOfSupply(sr) || '-'),
    sr.reason ? 'Reason: ' + sr.reason : ''
  ].filter(Boolean);
  const colWidth = (pw / 2) - 4 - L - 4;
  const soldByWrapped = wrapLines(doc, soldByLines, colWidth);
  const metaWrapped = wrapLines(doc, metaLines, R - (pw / 2 + 4));
  const blockTop = y;
  soldByWrapped.forEach((line, i) => doc.text(line, L, blockTop + i * 4.5, { maxWidth: colWidth }));
  metaWrapped.forEach((line, i) => doc.text(line, pw / 2 + 4, blockTop + i * 4.5));
  y = blockTop + Math.max(soldByWrapped.length, metaWrapped.length) * 4.5 + 5;

  doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...accent);
  doc.text('RETURNED BY', L, y);
  doc.line(L, y + 1.5, R, y + 1.5);
  y += 6;
  doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(40, 40, 40);
  const custLines = [
    sr.customer_name || '',
    sr.gstin ? 'GSTIN: ' + sr.gstin : '',
    [sr.address, sr.state].filter(Boolean).join(', '),
    sr.phone ? 'Phone: ' + sr.phone : ''
  ].filter(Boolean);
  const custWrapped = wrapLines(doc, custLines, R - L);
  custWrapped.forEach((line, i) => doc.text(line, L, y + i * 4.5, { maxWidth: R - L }));
  y += custWrapped.length * 4.5 + 6;

  const pdfItemRows = sr.items
    ? sr.items.map((it, i) => [
        String(i + 1), it.product_name, it.hsn_code || '-', it.unit || '-', formatNum(it.quantity), formatNum(it.rate),
        it.gst_percentage + '%', formatNum(it.taxable_value),
        it.cgst > 0 ? formatNum(it.cgst) : '-', it.sgst > 0 ? formatNum(it.sgst) : '-',
        it.igst > 0 ? formatNum(it.igst) : '-', formatNum(it.total_amount)
      ])
    : [];
  doc.autoTable({
    startY: y,
    head: [['#', 'Product Name', 'HSN', 'Unit', 'Return Qty', 'Rate', 'GST%', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Total']],
    body: pdfItemRows,
    theme: 'grid',
    headStyles: { fillColor: [Math.min(accent[0]+224,255), Math.min(accent[1]+165,255), Math.min(accent[2]+177,255)], textColor: accent, fontStyle: 'bold', fontSize: 7.5, lineColor: [178, 223, 219] },
    bodyStyles: { fontSize: 8, textColor: [40, 40, 40] },
    columnStyles: { 1: { fontStyle: 'bold' }, 11: { fontStyle: 'bold' } },
    margin: { left: L, right: L },
    styles: { cellPadding: 2.5, lineColor: [225, 225, 225] }
  });
  y = doc.lastAutoTable.finalY + 8;

  if (y > 220) { doc.addPage(); y = 20; }

  const boxW = 80, boxX = R - boxW;
  const totalsRows = [['Subtotal', formatNum(sr.taxable_amount)]];
  if (sr.cgst > 0) totalsRows.push(['CGST', formatNum(sr.cgst)]);
  if (sr.sgst > 0) totalsRows.push(['SGST', formatNum(sr.sgst)]);
  if (sr.igst > 0) totalsRows.push([`IGST (${sr.gst_percentage}%)`, formatNum(sr.igst)]);
  if (Math.abs(sr.round_off) >= 0.005) totalsRows.push(['Round Off', (sr.round_off >= 0 ? '+' : '') + formatNum(sr.round_off)]);

  doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(60, 60, 60);
  totalsRows.forEach((r, i) => {
    doc.text(r[0], boxX, y + i * 5.5);
    doc.text('Rs.' + r[1], R, y + i * 5.5, { align: 'right' });
  });
  const ruleY = y + totalsRows.length * 5.5 + 1;
  doc.setDrawColor(60, 60, 60);
  doc.line(boxX, ruleY, R, ruleY);
  doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.setTextColor(...accent);
  doc.text('Total Return Amount', boxX, ruleY + 7);
  doc.text('Rs.' + formatNum(sr.total_amount), R, ruleY + 7, { align: 'right' });
  y = ruleY + 16;

  doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(30, 30, 30);
  doc.text('Amount in Words:', L, y);
  doc.setFont('helvetica', 'bold');
  doc.text(numberToWordsINR(sr.total_amount), L, y + 5, { maxWidth: R - L });
  y += 13;

  doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(110, 110, 110);
  doc.text('* This is a Sales Return note against the original invoice referenced above.', L, y);
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

  const qrSource = qrCustomData || await generateQRDataUrl(`Sales Return: ${sr.return_number}\nDate: ${formatDate(sr.return_date)}\nAmount: Rs.${formatNum(sr.total_amount)}`, p?.header_color);
  let sigBlockY = y;
  if (qrSource) {
    try {
      doc.addImage(qrSource, 'PNG', L, y, 24, 24);
      doc.setFontSize(7); doc.setTextColor(...accent); doc.setFont('helvetica', 'normal');
      doc.text('Scan to verify', L, y + 28);
    } catch {}
  }

  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(30, 30, 30);
  doc.text('For ' + (p?.business_name || 'Us'), R, sigBlockY + 4, { align: 'right' });
  if (sealData) {
    try { doc.addImage(sealData, 'PNG', R - 88, sigBlockY, 20, 20); } catch {}
  }
  if (signatureData) {
    try { doc.addImage(signatureData, 'PNG', R - 45, sigBlockY + 6, 35, 14); } catch {}
  }
  doc.setFontSize(8); doc.setTextColor(120, 120, 120);
  doc.text('Authorized Signatory', R, sigBlockY + 24, { align: 'right' });
  y = sigBlockY + 32;

  if (y > 260) { doc.addPage(); y = 20; }
  doc.setDrawColor(178, 223, 219);
  doc.line(L, y, R, y);
  y += 6;
  doc.setFontSize(7.5); doc.setTextColor(140, 140, 140);
  doc.text('This is a computer-generated Sales Return document.', pw / 2, y, { align: 'center' });
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

// ── Print / View ───────────────────────────────────────
async function printSalesReturn(id) {
  const sr = await fetchSalesReturnRecord(id);
  if (!sr) return;
  const html = await buildSalesReturnHTML(sr, { autoPrint: true });
  const w = window.open('', '_blank');
  w.document.write(html);
  w.document.close();
  showToast('Print dialog opened!');
}

async function viewSalesReturnHTML(id) {
  const sr = await fetchSalesReturnRecord(id);
  if (!sr) return null;
  return buildSalesReturnHTML(sr, { autoPrint: false });
}

async function buildSalesReturnHTML(sr, opts) {
  opts = opts || {};
  const p = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const accentHex = p?.header_color || '#004d40';

  const qrSource = p?.qr_base64 || await generateQRDataUrl(`Sales Return: ${sr.return_number}\nDate: ${formatDate(sr.return_date)}\nAmount: Rs.${formatNum(sr.total_amount)}`, accentHex);
  const contactLine = [p?.email, p?.phone, p?.website].filter(Boolean).join(' &middot; ');
  const bankLines = (typeof bankDetailLines === 'function') ? bankDetailLines(p) : [];

  const printItemRowsHtml = sr.items
    ? sr.items.map((it, i) => `<tr>
        <td>${i + 1}</td><td><b>${escHtml(it.product_name)}</b></td><td>${escHtml(it.hsn_code) || '-'}</td><td>${escHtml(it.unit) || '-'}</td><td class="c">${formatNum(it.quantity)}</td><td class="r">${formatNum(it.rate)}</td><td class="c">${it.gst_percentage}%</td><td class="r">${formatNum(it.taxable_value)}</td>
        <td class="r">${it.cgst > 0 ? formatNum(it.cgst) : '-'}</td><td class="r">${it.sgst > 0 ? formatNum(it.sgst) : '-'}</td><td class="r">${it.igst > 0 ? formatNum(it.igst) : '-'}</td>
        <td class="r"><b>${formatNum(it.total_amount)}</b></td>
      </tr>`).join('')
    : '';
  const roundOffRowHtml = Math.abs(sr.round_off) >= 0.005
    ? `<tr><td>Round Off</td><td class="r">Rs.${(sr.round_off >= 0 ? '+' : '') + formatNum(sr.round_off)}</td></tr>`
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Sales Return ${escHtml(sr.return_number)}</title>
<style>
  @page { margin: 14mm 16mm; size: A4; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11.5px; color: #1a1a1a; margin: 0; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; }
  .top .logo { max-height: 44px; max-width: 44px; margin-right: 10px; }
  .top .brand { display: flex; align-items: center; }
  .top h1 { margin: 0; font-size: 22px; }
  .top .website { font-size: 10px; color: #888; margin-top: 3px; }
  .top .right { text-align: right; }
  .top .right .title { font-size: 17px; font-weight: 800; color: ${accentHex}; }
  .top .right .sub { font-size: 10px; color: #888; margin-top: 3px; }
  .divider { background: ${accentHex}; height: 2.5px; margin: 10px 0 16px; border-radius: 2px; }
  .two-col { display: flex; justify-content: space-between; gap: 24px; margin-bottom: 16px; }
  .two-col > div { flex: 1; }
  h3 { color: ${accentHex}; font-size: 11px; border-bottom: 1.5px solid #b2dfdb; padding-bottom: 4px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0.5px; }
  .two-col p { margin: 2px 0; font-size: 10.5px; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 10.5px; }
  th { background: #e0f2f1; color: ${accentHex}; padding: 7px 8px; text-align: left; border: 1px solid #b2dfdb; }
  td { padding: 7px 8px; border: 1px solid #e5e5e5; }
  .r { text-align: right; } .c { text-align: center; }
  .totals { display: flex; justify-content: flex-end; margin-top: 14px; }
  .totals table { width: 260px; margin: 0; }
  .totals td { border: none; padding: 3px 0; font-size: 10.5px; }
  .totals .grand td { border-top: 1.5px solid #333; font-weight: 800; font-size: 13px; color: ${accentHex}; padding-top: 8px; }
  .words { margin-top: 14px; font-size: 10.5px; }
  .notes { margin-top: 8px; font-size: 9px; color: #888; font-style: italic; }
  .bank-block { margin-top: 16px; }
  .bank-block h3 { margin-bottom: 4px; }
  .bank-block p { margin: 2px 0; font-size: 10px; color: #444; }
  .footer-grid { display: flex; justify-content: space-between; margin-top: 22px; gap: 20px; align-items: flex-start; }
  .qr-cap { font-size: 8.5px; color: ${accentHex}; margin-top: 4px; }
  .sign { text-align: right; font-size: 10.5px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
  .sign .seal { max-height: 55px; max-width: 55px; }
  .sign .sig-img { max-height: 36px; max-width: 120px; }
  .sign .auth { color: #888; }
  .policy-footer { margin-top: 20px; border-top: 1px solid #b2dfdb; padding-top: 10px; text-align: center; }
  .policy-footer .gen { font-size: 8.5px; color: #999; }
  .policy-footer .contact { font-size: 8.5px; color: #999; margin-top: 4px; }
</style></head>
<body>
  <div class="top">
    <div>
      <div class="brand">
        ${p?.logo_base64 ? `<img class="logo" src="${p.logo_base64}">` : ''}
        <h1>${escHtml(p?.business_name) || 'Your Business Name'}</h1>
      </div>
      ${p?.website ? `<div class="website">${escHtml(p.website)}</div>` : ''}
    </div>
    <div class="right">
      <div class="title">SALES RETURN</div>
      <div class="sub">Goods Return Note</div>
    </div>
  </div>
  <div class="divider"></div>

  <div class="two-col">
    <div>
      <h3>Issued By</h3>
      <p><b>${escHtml(p?.business_name)}</b></p>
      <p>${escHtml(p?.address)}</p>
      <p>${escHtml(p?.state)}</p>
      ${p?.gstin ? `<p>GSTIN: ${escHtml(p.gstin)}</p>` : ''}
    </div>
    <div>
      <h3>Return Details</h3>
      <p>Return No: <b>${escHtml(sr.return_number)}</b></p>
      <p>Return Date: ${formatDate(sr.return_date)}</p>
      <p>Original Invoice: ${escHtml(sr.original_invoice_number) || '-'} (${sr.original_invoice_type.toUpperCase()})</p>
      <p>Place of Supply: ${escHtml(srPlaceOfSupply(sr)) || '-'}</p>
      ${sr.reason ? `<p>Reason: ${escHtml(sr.reason)}</p>` : ''}
    </div>
  </div>

  <h3>Returned By</h3>
  <p><b>${escHtml(sr.customer_name)}</b></p>
  ${sr.gstin ? `<p>GSTIN: ${escHtml(sr.gstin)}</p>` : ''}
  <p>${escHtml([sr.address, sr.state].filter(Boolean).join(', '))}</p>
  ${sr.phone ? `<p>Phone: ${escHtml(sr.phone)}</p>` : ''}

  <table>
    <thead><tr><th>#</th><th>Product Name</th><th>HSN</th><th>Unit</th><th class="c">Return Qty</th><th class="r">Rate</th><th class="c">GST%</th><th class="r">Taxable Value</th><th class="r">CGST</th><th class="r">SGST</th><th class="r">IGST</th><th class="r">Total</th></tr></thead>
    <tbody>${printItemRowsHtml}</tbody>
  </table>

  <div class="totals">
    <table>
      <tr><td>Subtotal</td><td class="r">Rs.${formatNum(sr.taxable_amount)}</td></tr>
      ${sr.cgst > 0 ? `<tr><td>CGST</td><td class="r">Rs.${formatNum(sr.cgst)}</td></tr>` : ''}
      ${sr.sgst > 0 ? `<tr><td>SGST</td><td class="r">Rs.${formatNum(sr.sgst)}</td></tr>` : ''}
      ${sr.igst > 0 ? `<tr><td>IGST (${sr.gst_percentage}%)</td><td class="r">Rs.${formatNum(sr.igst)}</td></tr>` : ''}
      ${roundOffRowHtml}
      <tr class="grand"><td>Total Return Amount</td><td class="r">Rs.${formatNum(sr.total_amount)}</td></tr>
    </table>
  </div>

  <div class="words">Amount in Words:<br><b>${escHtml(numberToWordsINR(sr.total_amount))}</b></div>
  <div class="notes">* This is a Sales Return note against the original invoice referenced above.</div>

  ${bankLines.length ? `<div class="bank-block"><h3>Bank Details</h3>${bankLines.map(l => `<p>${escHtml(l)}</p>`).join('')}</div>` : ''}

  <div class="footer-grid">
    <div>
      ${qrSource ? `<img src="${qrSource}" style="width:70px;height:70px;"><div class="qr-cap">Scan to verify</div>` : ''}
    </div>
    <div class="sign">
      ${p?.seal_base64 ? `<img class="seal" src="${p.seal_base64}">` : ''}
      <div class="for">For ${escHtml(p?.business_name) || 'Us'}</div>
      ${p?.signature_base64 ? `<img class="sig-img" src="${p.signature_base64}">` : ''}
      <div class="auth">Authorized Signatory</div>
    </div>
  </div>

  <div class="policy-footer">
    <div class="gen">This is a computer-generated Sales Return document.</div>
    ${contactLine ? `<div class="contact">${contactLine}</div>` : ''}
  </div>

  ${opts.autoPrint ? '<script>window.onload = function(){ window.print(); }<\/script>' : ''}
</body></html>`;
}

// ── WhatsApp Share ───────────────────────────────────
async function shareSalesReturnWhatsApp(id) {
  const sr = await fetchSalesReturnRecord(id);
  if (!sr) return;
  const p = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const biz = p?.business_name || 'GST Invoice';

  const sellerAddressLine = [p?.address, p?.state].filter(Boolean).join(', ');
  const bankLines = (typeof bankDetailLines === 'function') ? bankDetailLines(p) : [];

  const msg = `*${biz} — Sales Return*\n\n` +
    `Return No  : ${sr.return_number}\n` +
    `Date       : ${formatDate(sr.return_date)}\n` +
    `Customer   : ${sr.customer_name}\n` +
    `Orig. Inv. : ${sr.original_invoice_number || '-'}\n` +
    (sr.gstin ? `GSTIN      : ${sr.gstin}\n` : '') +
    `\nTaxable Amt: ₹${formatNum(sr.taxable_amount)}\n` +
    (sr.igst > 0 ? `IGST       : ₹${formatNum(sr.igst)}\n` : `CGST       : ₹${formatNum(sr.cgst)}\nSGST       : ₹${formatNum(sr.sgst)}\n`) +
    `*Total Return: ₹${formatNum(sr.total_amount)}*\n\n` +
    `*Issued By*\n` +
    `${biz}\n` +
    (p?.gstin ? `GSTIN: ${p.gstin}\n` : '') +
    (sellerAddressLine ? `${sellerAddressLine}\n` : '') +
    (p?.phone ? `Ph: ${p.phone}\n` : '') +
    (p?.email ? `Email: ${p.email}\n` : '') +
    (bankLines.length ? `\n*Bank Details*\n${bankLines.join('\n')}\n` : '') +
    `\n_Generated by ${biz}_`;
  window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
}

// ── Email PDF ─────────────────────────────────────────
async function emailSalesReturnPDF(id) {
  const sr = await fetchSalesReturnRecord(id);
  if (!sr) return;
  const p = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const doc = await buildSalesReturnPDFDoc(sr);
  doc.save(`SalesReturn_${sr.return_number}.pdf`);

  const subject = `Sales Return ${sr.return_number} from ${p?.business_name || 'us'}`;
  const body = `Dear ${sr.customer_name},\n\nPlease find attached Sales Return ${sr.return_number} dated ${formatDate(sr.return_date)} for ₹${formatNum(sr.total_amount)}, against original invoice ${sr.original_invoice_number || ''}.\n\n(The PDF has just been downloaded — please attach it to this email before sending.)\n\nThank you,\n${p?.business_name || ''}`;
  const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  showToast('PDF downloaded — attach it in the email that just opened.', 'success');
  window.location.href = mailto;
}
