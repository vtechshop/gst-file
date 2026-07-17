// =============================================
// Invoice PDF / Print / WhatsApp / Email
// Layout modeled directly on the company's real tax-invoice
// template (logo + name top-left, TAX INVOICE top-right, accent
// divider, Sold By / Invoice Details two-column block, Bill To
// block, item table, right-aligned totals with a ruled Grand
// Total, Amount in Words, GST/reverse-charge notes, Bank/UPI
// details, QR + Seal + Signature block, and a Terms &
// Conditions / footer-text / contact footer) — generated directly
// from the invoice records already saved via B2B Invoice Entry
// (gstr1.html) or B2C Invoice Entry (b2c.html). Those tables are
// the single source of truth; nothing here is a separate data
// model. B2B rows are enriched (best-effort) with matching
// Customer Master details (address/phone/email) the same way
// gstr1.js already looks up customers by name for its datalist.
//
// All branding assets (logo/seal/signature/QR/header color/bank &
// UPI details/footer text/terms) come from the Business Profile
// row set once under Settings -> Company Branding — nothing here
// is uploaded or re-entered per invoice.
// =============================================

async function fetchInvoiceRecord(type, id) {
  const table = type === 'b2b' ? 'b2b_invoices' : 'b2c_invoices';
  const { data } = await _supabase.from(table).select('*').eq('id', id).single();
  if (!data) { showToast('Invoice not found.', 'error'); return null; }

  let customer = null;
  if (type === 'b2b') {
    const { data: custMatches } = await _supabase.from('customers').select('*').eq('user_id', data.user_id);
    customer = (custMatches || []).find(c =>
      c.name.toLowerCase() === (data.customer_name || '').toLowerCase() &&
      (c.gstin || '').toUpperCase() === (data.gst_number || '').toUpperCase()
    ) || (custMatches || []).find(c => c.name.toLowerCase() === (data.customer_name || '').toLowerCase());
  }

  let items = null;
  const { data: itemRows } = await _supabase.from('invoice_items').select('*').eq('invoice_id', data.id).eq('invoice_type', type);
  const activeItems = (itemRows || []).filter(r => !r.is_deleted).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  if (activeItems.length) items = activeItems;

  return {
    type,
    id: data.id,
    invoice_number: type === 'b2b' ? data.invoice_number : ('B2C-' + data.id.slice(0, 8).toUpperCase()),
    invoice_date: data.invoice_date,
    customer_name: type === 'b2b' ? data.customer_name : 'Walk-in Customer (B2C)',
    gstin: type === 'b2b' ? data.gst_number : '',
    state: type === 'b2b' ? (customer?.state || '') : data.state,
    address: customer?.address || '',
    phone: customer?.phone || '',
    email: customer?.email || '',
    taxable_amount: +data.taxable_amount,
    gst_percentage: +data.gst_percentage,
    gst_amount: +data.gst_amount,
    total_amount: +data.total_amount,
    supply_type: data.supply_type,
    igst: +data.igst, cgst: +data.cgst, sgst: +data.sgst,
    round_off: round2(+data.total_amount - +data.taxable_amount - +data.gst_amount),
    items
  };
}

async function generateQRDataUrl(text, darkHex) {
  try {
    if (typeof QRCode === 'undefined') return null;
    return await QRCode.toDataURL(text, { width: 160, margin: 1, color: { dark: darkHex || '#004d40', light: '#ffffff' } });
  } catch {
    return null;
  }
}

function invoicePlaceOfSupply(inv) {
  return inv.state || (inv.supply_type === 'interstate' ? 'Other State' : '');
}

function wrapLines(doc, lines, maxWidth) {
  const out = [];
  lines.forEach(line => out.push(...doc.splitTextToSize(line, maxWidth)));
  return out;
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec((hex || '').trim());
  if (!m) return [0, 77, 64];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function bankDetailLines(p) {
  if (!p) return [];
  return [
    p.bank_name ? 'Bank: ' + p.bank_name : '',
    p.bank_account_no ? 'A/c No: ' + p.bank_account_no : '',
    p.bank_ifsc ? 'IFSC: ' + p.bank_ifsc : '',
    p.bank_branch ? 'Branch: ' + p.bank_branch : '',
    p.upi_id ? 'UPI ID: ' + p.upi_id : ''
  ].filter(Boolean);
}

// ── PDF ──────────────────────────────────────────────
async function downloadInvoicePDF(type, id) {
  const inv = await fetchInvoiceRecord(type, id);
  if (!inv) return;
  const doc = await buildInvoicePDFDoc(inv);
  doc.save(`Invoice_${inv.invoice_number}.pdf`);
  showToast('Invoice PDF downloaded!', 'success');
}

async function buildInvoicePDFDoc(inv) {
  const p = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const accent = hexToRgb(p?.header_color);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pw = doc.internal.pageSize.width;
  const L = 14, R = pw - 14;

  // ── Top: Logo + Company (left) / TAX INVOICE (right) ──
  let nameX = L;
  if (p?.logo_base64) {
    try { doc.addImage(p.logo_base64, 'PNG', L, 8, 14, 14); nameX = L + 18; } catch {}
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
  doc.text('TAX INVOICE', R, 14, { align: 'right' });
  doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(120, 120, 120);
  doc.text('Original for Recipient', R, 20, { align: 'right' });

  // Accent divider
  doc.setFillColor(...accent);
  doc.rect(L, 25, R - L, 1.3, 'F');

  let y = 34;

  // ── Sold By / Order & Invoice Details ──
  doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...accent);
  doc.text('SOLD BY', L, y);
  doc.text('ORDER & INVOICE DETAILS', pw / 2 + 4, y);
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
    'Invoice No: ' + (inv.invoice_number || ''),
    'Invoice Date: ' + formatDate(inv.invoice_date),
    'Place of Supply: ' + (invoicePlaceOfSupply(inv) || '-'),
    'Type: ' + (inv.type === 'b2b' ? 'B2B (Registered)' : 'B2C (Unregistered)'),
    'Reverse Charge: No'
  ];
  const colWidth = (pw / 2) - 4 - L - 4;
  const soldByWrapped = wrapLines(doc, soldByLines, colWidth);
  const metaWrapped = wrapLines(doc, metaLines, R - (pw / 2 + 4));
  const blockTop = y;
  soldByWrapped.forEach((line, i) => doc.text(line, L, blockTop + i * 4.5, { maxWidth: colWidth }));
  metaWrapped.forEach((line, i) => doc.text(line, pw / 2 + 4, blockTop + i * 4.5));
  y = blockTop + Math.max(soldByWrapped.length, metaWrapped.length) * 4.5 + 5;

  // ── Bill To ──
  doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...accent);
  doc.text('BILL TO', L, y);
  doc.line(L, y + 1.5, R, y + 1.5);
  y += 6;
  doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(40, 40, 40);
  const custLines = [
    inv.customer_name || '',
    inv.gstin ? 'GSTIN: ' + inv.gstin : '',
    [inv.address, inv.state].filter(Boolean).join(', '),
    inv.phone ? 'Phone: ' + inv.phone : '',
    inv.email || ''
  ].filter(Boolean);
  const custWrapped = wrapLines(doc, custLines, R - L);
  custWrapped.forEach((line, i) => doc.text(line, L, y + i * 4.5, { maxWidth: R - L }));
  y += custWrapped.length * 4.5 + 6;

  // ── Item table — Product Name / HSN / Unit / Qty / Rate / GST% /
  // Taxable Value / CGST / SGST / IGST / Line Total, sourced directly
  // from the invoice's product line items (Product Master HSN/GST%/Unit) ──
  const pdfItemRows = inv.items
    ? inv.items.map((it, i) => [
        String(i + 1), it.product_name, it.hsn_code || '-', it.unit || '-', formatNum(it.quantity), formatNum(it.rate),
        it.gst_percentage + '%', formatNum(it.taxable_value),
        it.cgst > 0 ? formatNum(it.cgst) : '-', it.sgst > 0 ? formatNum(it.sgst) : '-',
        it.igst > 0 ? formatNum(it.igst) : '-', formatNum(it.total_amount)
      ])
    : [[
        '1', 'Taxable Supply', '-', '-', '1', formatNum(inv.taxable_amount),
        inv.gst_percentage + '%', formatNum(inv.taxable_amount),
        inv.cgst > 0 ? formatNum(inv.cgst) : '-', inv.sgst > 0 ? formatNum(inv.sgst) : '-',
        inv.igst > 0 ? formatNum(inv.igst) : '-', formatNum(inv.total_amount)
      ]];
  doc.autoTable({
    startY: y,
    head: [['#', 'Product Name', 'HSN', 'Unit', 'Qty', 'Rate', 'GST%', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Total']],
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

  // ── Totals (right-aligned, ruled Grand Total — no filled box) ──
  const boxW = 80, boxX = R - boxW;
  const totalsRows = [['Subtotal', formatNum(inv.taxable_amount)]];
  if (inv.cgst > 0) totalsRows.push(['CGST', formatNum(inv.cgst)]);
  if (inv.sgst > 0) totalsRows.push(['SGST', formatNum(inv.sgst)]);
  if (inv.igst > 0) totalsRows.push([`IGST (${inv.gst_percentage}%)`, formatNum(inv.igst)]);
  if (Math.abs(inv.round_off) >= 0.005) totalsRows.push(['Round Off', (inv.round_off >= 0 ? '+' : '') + formatNum(inv.round_off)]);

  doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(60, 60, 60);
  totalsRows.forEach((r, i) => {
    doc.text(r[0], boxX, y + i * 5.5);
    doc.text('Rs.' + r[1], R, y + i * 5.5, { align: 'right' });
  });
  const ruleY = y + totalsRows.length * 5.5 + 1;
  doc.setDrawColor(60, 60, 60);
  doc.line(boxX, ruleY, R, ruleY);
  doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.setTextColor(...accent);
  doc.text('Grand Total', boxX, ruleY + 7);
  doc.text('Rs.' + formatNum(inv.total_amount), R, ruleY + 7, { align: 'right' });
  y = ruleY + 16;

  // ── Amount in words + notes ──
  doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(30, 30, 30);
  doc.text('Amount in Words:', L, y);
  doc.setFont('helvetica', 'bold');
  doc.text(numberToWordsINR(inv.total_amount), L, y + 5, { maxWidth: R - L });
  y += 13;

  doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(110, 110, 110);
  doc.text('* GST has been charged separately as shown above.', L, y);
  doc.text('Whether tax is payable under reverse charge: No', L, y + 4);
  y += 12;

  // ── Bank / UPI details ──
  const bankLines = bankDetailLines(p);
  if (bankLines.length) {
    if (y > 250) { doc.addPage(); y = 20; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...accent);
    doc.text('Bank Details for Payment', L, y);
    y += 4.5;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(60, 60, 60);
    bankLines.forEach((l, i) => doc.text(l, L, y + i * 4));
    y += bankLines.length * 4 + 6;
  }

  if (y > 250) { doc.addPage(); y = 20; }

  // ── QR (left) + Seal + Signature (right) ──
  const qrSource = p?.qr_base64 || await generateQRDataUrl(`Invoice: ${inv.invoice_number}\nDate: ${formatDate(inv.invoice_date)}\nAmount: Rs.${formatNum(inv.total_amount)}`, p?.header_color);
  const qrIsCustom = !!p?.qr_base64;
  let sigBlockY = y;
  if (qrSource) {
    try {
      doc.addImage(qrSource, p?.qr_base64 ? 'PNG' : 'PNG', L, y, 24, 24);
      doc.setFontSize(7); doc.setTextColor(...accent); doc.setFont('helvetica', 'normal');
      doc.text(qrIsCustom ? 'Scan QR' : 'Scan to verify invoice', L, y + 28);
    } catch {}
  }

  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(30, 30, 30);
  doc.text('For ' + (p?.business_name || 'Us'), R, sigBlockY + 4, { align: 'right' });
  if (p?.seal_base64) {
    try { doc.addImage(p.seal_base64, 'PNG', R - 88, sigBlockY, 20, 20); } catch {}
  }
  if (p?.signature_base64) {
    try { doc.addImage(p.signature_base64, 'PNG', R - 45, sigBlockY + 6, 35, 14); } catch {}
  }
  doc.setFontSize(8); doc.setTextColor(120, 120, 120);
  doc.text('Authorized Signatory', R, sigBlockY + 24, { align: 'right' });
  y = sigBlockY + 32;

  // ── Footer: Terms & Conditions, footer text, computer-generated line, contact ──
  if (y > 260) { doc.addPage(); y = 20; }
  doc.setDrawColor(178, 223, 219);
  doc.line(L, y, R, y);
  y += 6;

  if (p?.terms_conditions) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(...accent);
    doc.text('Terms & Conditions', pw / 2, y, { align: 'center' });
    y += 4;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(100, 100, 100);
    const tcLines = doc.splitTextToSize(p.terms_conditions, R - L);
    doc.text(tcLines, pw / 2, y, { align: 'center' });
    y += tcLines.length * 3.6 + 5;
  }

  if (p?.footer_text) {
    doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(100, 100, 100);
    const footerLines = doc.splitTextToSize(p.footer_text, R - L);
    doc.text(footerLines, pw / 2, y, { align: 'center' });
    y += footerLines.length * 3.6 + 5;
  }

  doc.setFontSize(7.5); doc.setTextColor(140, 140, 140);
  doc.text('This is a computer-generated invoice.', pw / 2, y, { align: 'center' });
  y += 5;
  const contactLine = [p?.email, p?.phone, p?.website].filter(Boolean).join('  |  ');
  if (contactLine) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(140, 140, 140);
    doc.text(contactLine, pw / 2, y, { align: 'center' });
  }

  // Page numbers
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(7); doc.setTextColor(180);
    doc.text(`Page ${i} of ${pageCount}`, L, doc.internal.pageSize.height - 8);
  }

  return doc;
}

// ── Print ────────────────────────────────────────────
async function printInvoice(type, id) {
  const inv = await fetchInvoiceRecord(type, id);
  if (!inv) return;
  const p = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const accentHex = p?.header_color || '#004d40';

  const qrSource = p?.qr_base64 || await generateQRDataUrl(`Invoice: ${inv.invoice_number}\nDate: ${formatDate(inv.invoice_date)}\nAmount: Rs.${formatNum(inv.total_amount)}`, accentHex);
  const qrCaption = p?.qr_base64 ? 'Scan QR' : 'Scan to verify invoice';
  const contactLine = [p?.email, p?.phone, p?.website].filter(Boolean).join(' &middot; ');
  const bankLines = bankDetailLines(p);

  const printItemRowsHtml = inv.items
    ? inv.items.map((it, i) => `<tr>
        <td>${i + 1}</td><td><b>${escHtml(it.product_name)}</b></td><td>${escHtml(it.hsn_code) || '-'}</td><td>${escHtml(it.unit) || '-'}</td><td class="c">${formatNum(it.quantity)}</td><td class="r">${formatNum(it.rate)}</td><td class="c">${it.gst_percentage}%</td><td class="r">${formatNum(it.taxable_value)}</td>
        <td class="r">${it.cgst > 0 ? formatNum(it.cgst) : '-'}</td><td class="r">${it.sgst > 0 ? formatNum(it.sgst) : '-'}</td><td class="r">${it.igst > 0 ? formatNum(it.igst) : '-'}</td>
        <td class="r"><b>${formatNum(it.total_amount)}</b></td>
      </tr>`).join('')
    : `<tr>
        <td>1</td><td><b>Taxable Supply</b></td><td>-</td><td>-</td><td class="c">1</td><td class="r">${formatNum(inv.taxable_amount)}</td><td class="c">${inv.gst_percentage}%</td><td class="r">${formatNum(inv.taxable_amount)}</td>
        <td class="r">${inv.cgst > 0 ? formatNum(inv.cgst) : '-'}</td><td class="r">${inv.sgst > 0 ? formatNum(inv.sgst) : '-'}</td><td class="r">${inv.igst > 0 ? formatNum(inv.igst) : '-'}</td>
        <td class="r"><b>${formatNum(inv.total_amount)}</b></td>
      </tr>`;
  const roundOffRowHtml = Math.abs(inv.round_off) >= 0.005
    ? `<tr><td>Round Off</td><td class="r">Rs.${(inv.round_off >= 0 ? '+' : '') + formatNum(inv.round_off)}</td></tr>`
    : '';

  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Invoice ${escHtml(inv.invoice_number)}</title>
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
  .policy-footer .tc-title { font-size: 8.5px; font-weight: 700; color: ${accentHex}; margin-bottom: 3px; }
  .policy-footer .terms, .policy-footer .footer-text { font-size: 8.5px; color: #777; white-space: pre-line; margin-bottom: 8px; }
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
      <div class="title">TAX INVOICE</div>
      <div class="sub">Original for Recipient</div>
    </div>
  </div>
  <div class="divider"></div>

  <div class="two-col">
    <div>
      <h3>Sold By</h3>
      <p><b>${escHtml(p?.business_name)}</b></p>
      <p>${escHtml(p?.address)}</p>
      <p>${escHtml(p?.state)}</p>
      ${p?.gstin ? `<p>GSTIN: ${escHtml(p.gstin)}</p>` : ''}
      ${p?.pan ? `<p>PAN: ${escHtml(p.pan)}</p>` : ''}
    </div>
    <div>
      <h3>Order &amp; Invoice Details</h3>
      <p>Invoice No: <b>${escHtml(inv.invoice_number)}</b></p>
      <p>Invoice Date: ${formatDate(inv.invoice_date)}</p>
      <p>Place of Supply: ${escHtml(invoicePlaceOfSupply(inv)) || '-'}</p>
      <p>Type: ${inv.type === 'b2b' ? 'B2B (Registered)' : 'B2C (Unregistered)'}</p>
      <p>Reverse Charge: No</p>
    </div>
  </div>

  <h3>Bill To</h3>
  <p><b>${escHtml(inv.customer_name)}</b></p>
  ${inv.gstin ? `<p>GSTIN: ${escHtml(inv.gstin)}</p>` : ''}
  <p>${escHtml([inv.address, inv.state].filter(Boolean).join(', '))}</p>
  ${inv.phone ? `<p>Phone: ${escHtml(inv.phone)}</p>` : ''}
  ${inv.email ? `<p>${escHtml(inv.email)}</p>` : ''}

  <table>
    <thead><tr><th>#</th><th>Product Name</th><th>HSN</th><th>Unit</th><th class="c">Qty</th><th class="r">Rate</th><th class="c">GST%</th><th class="r">Taxable Value</th><th class="r">CGST</th><th class="r">SGST</th><th class="r">IGST</th><th class="r">Total</th></tr></thead>
    <tbody>${printItemRowsHtml}</tbody>
  </table>

  <div class="totals">
    <table>
      <tr><td>Subtotal</td><td class="r">Rs.${formatNum(inv.taxable_amount)}</td></tr>
      ${inv.cgst > 0 ? `<tr><td>CGST</td><td class="r">Rs.${formatNum(inv.cgst)}</td></tr>` : ''}
      ${inv.sgst > 0 ? `<tr><td>SGST</td><td class="r">Rs.${formatNum(inv.sgst)}</td></tr>` : ''}
      ${inv.igst > 0 ? `<tr><td>IGST (${inv.gst_percentage}%)</td><td class="r">Rs.${formatNum(inv.igst)}</td></tr>` : ''}
      ${roundOffRowHtml}
      <tr class="grand"><td>Grand Total</td><td class="r">Rs.${formatNum(inv.total_amount)}</td></tr>
    </table>
  </div>

  <div class="words">Amount in Words:<br><b>${escHtml(numberToWordsINR(inv.total_amount))}</b></div>
  <div class="notes">* GST has been charged separately as shown above.<br>Whether tax is payable under reverse charge: No</div>

  ${bankLines.length ? `<div class="bank-block"><h3>Bank Details for Payment</h3>${bankLines.map(l => `<p>${escHtml(l)}</p>`).join('')}</div>` : ''}

  <div class="footer-grid">
    <div>
      ${qrSource ? `<img src="${qrSource}" style="width:70px;height:70px;"><div class="qr-cap">${qrCaption}</div>` : ''}
    </div>
    <div class="sign">
      ${p?.seal_base64 ? `<img class="seal" src="${p.seal_base64}">` : ''}
      <div class="for">For ${escHtml(p?.business_name) || 'Us'}</div>
      ${p?.signature_base64 ? `<img class="sig-img" src="${p.signature_base64}">` : ''}
      <div class="auth">Authorized Signatory</div>
    </div>
  </div>

  <div class="policy-footer">
    ${p?.terms_conditions ? `<div class="tc-title">Terms &amp; Conditions</div><div class="terms">${escHtml(p.terms_conditions)}</div>` : ''}
    ${p?.footer_text ? `<div class="footer-text">${escHtml(p.footer_text)}</div>` : ''}
    <div class="gen">This is a computer-generated invoice.</div>
    ${contactLine ? `<div class="contact">${contactLine}</div>` : ''}
  </div>

  <script>window.onload = function(){ window.print(); }<\/script>
</body></html>`);
  w.document.close();
  showToast('Print dialog opened!');
}

function escHtml(v) { return (v || '').toString().replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

// ── WhatsApp Share ───────────────────────────────────
async function shareInvoiceWhatsApp(type, id) {
  const inv = await fetchInvoiceRecord(type, id);
  if (!inv) return;
  const p = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const biz = p?.business_name || 'GST Invoice';
  const msg = `*${biz} — Tax Invoice*\n\n` +
    `Invoice No : ${inv.invoice_number}\n` +
    `Date       : ${formatDate(inv.invoice_date)}\n` +
    `Customer   : ${inv.customer_name}\n` +
    (inv.gstin ? `GSTIN      : ${inv.gstin}\n` : '') +
    `\nTaxable Amt: ₹${formatNum(inv.taxable_amount)}\n` +
    (inv.igst > 0 ? `IGST       : ₹${formatNum(inv.igst)}\n` : `CGST       : ₹${formatNum(inv.cgst)}\nSGST       : ₹${formatNum(inv.sgst)}\n`) +
    `*Total Amt : ₹${formatNum(inv.total_amount)}*\n\n` +
    `_Generated by ${biz}_`;
  window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
}

// ── Email PDF ─────────────────────────────────────────
// No backend/mail server in this app — downloads the PDF and opens
// the user's email client via mailto: with the details pre-filled;
// the file must be attached manually (browsers block auto-attach on mailto:).
async function emailInvoicePDF(type, id) {
  const inv = await fetchInvoiceRecord(type, id);
  if (!inv) return;
  const p = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const doc = await buildInvoicePDFDoc(inv);
  doc.save(`Invoice_${inv.invoice_number}.pdf`);

  const subject = `Invoice ${inv.invoice_number} from ${p?.business_name || 'us'}`;
  const body = `Dear ${inv.customer_name},\n\nPlease find attached Invoice ${inv.invoice_number} dated ${formatDate(inv.invoice_date)} for ₹${formatNum(inv.total_amount)}.\n\n(The PDF has just been downloaded — please attach it to this email before sending.)\n\nThank you,\n${p?.business_name || ''}`;
  const mailto = `mailto:${encodeURIComponent(inv.email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  showToast('PDF downloaded — attach it in the email that just opened.', 'success');
  window.location.href = mailto;
}
