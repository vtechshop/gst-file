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

  // The invoice row itself (customer_name/phone/address/state, captured
  // directly on Invoice Entry) is the authoritative source now. Customer
  // Master is still consulted as a fallback for older rows saved before
  // those fields existed, and for email (not collected on the invoice
  // form itself).
  const { data: custMatches } = await _supabase.from('customers').select('*').eq('user_id', data.user_id);
  const customer = (custMatches || []).find(c =>
    c.name.toLowerCase() === (data.customer_name || '').toLowerCase() &&
    (!data.gst_number || (c.gstin || '').toUpperCase() === (data.gst_number || '').toUpperCase())
  ) || (custMatches || []).find(c => c.name.toLowerCase() === (data.customer_name || '').toLowerCase());

  let items = null;
  const { data: itemRows } = await _supabase.from('invoice_items').select('*').eq('invoice_id', data.id).eq('invoice_type', type);
  const activeItems = (itemRows || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  if (activeItems.length) items = activeItems;

  return {
    type,
    id: data.id,
    invoice_number: data.invoice_number || (type === 'b2c' ? ('B2C-' + data.id.slice(0, 8).toUpperCase()) : ''),
    invoice_date: data.invoice_date,
    customer_name: data.customer_name || (type === 'b2c' ? 'Walk-in Customer (B2C)' : ''),
    gstin: data.gst_number || '',
    state: data.state || customer?.state || '',
    address: data.address || customer?.address || '',
    phone: data.phone || customer?.phone || '',
    email: customer?.email || '',
    // Ship-to lives on the customer record, not the invoice. Where none is
    // recorded the goods went to the billing address, so that is what the
    // Ship To box shows — the section is never dropped, because a tax
    // invoice that omits where the goods went is missing information a
    // reader expects to find.
    shipping_address: customer?.shipping_address || '',
    shipping_state: customer?.shipping_state || '',
    taxable_amount: +data.taxable_amount,
    gst_percentage: +data.gst_percentage,
    gst_amount: +data.gst_amount,
    total_amount: +data.total_amount,
    supply_type: data.supply_type,
    // Which numbering book the invoice came out of. Not printed on the
    // document — it is here because Duplicate builds its draft from this
    // record, and a copy of a website order has to stay a website order.
    invoice_source: data.invoice_source || 'offline',
    // Same reason as invoice_source above: Duplicate builds its draft
    // from this record, and a copy of an SEZ supply is an SEZ supply.
    gst_category: data.gst_category || 'regular',
    reverse_charge: !!data.reverse_charge,
    igst: +data.igst, cgst: +data.cgst, sgst: +data.sgst,
    round_off: round2(+data.total_amount - +data.taxable_amount - +data.gst_amount),
    transport_required: !!data.transport_required,
    vehicle_number: data.vehicle_number || '',
    transporter_name: data.transporter_name || '',
    transport_mode: data.transport_mode || '',
    transport_distance_km: data.transport_distance_km || null,
    lr_number: data.lr_number || '',
    lr_date: data.lr_date || null,
    transporter_gstin: data.transporter_gstin || '',
    vehicle_type: data.vehicle_type || '',
    dispatch_from: data.dispatch_from || '',
    dispatch_to: data.dispatch_to || '',
    payment_status: data.payment_status || 'unpaid',
    amount_paid: +data.amount_paid || 0,
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

// jsPDF's doc.addImage() needs actual image data (a base64 data URL or
// an already-loaded image element) — it cannot take a plain remote URL
// and fetch it internally. Business branding images are now stored as
// Cloudinary URLs (js/profile.js's handleImageUpload()), so every
// doc.addImage() call in this file first needs its source resolved
// through this helper. The plain HTML <img src="..."> paths elsewhere
// in this file (buildInvoiceHTML, used for Print/View/WhatsApp) don't
// need this — a browser <img> tag already fetches a URL on its own.
async function imageUrlToDataUrl(url) {
  if (!url || url.startsWith('data:')) return url || null;
  try {
    const blob = await fetch(url).then(r => r.blob());
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return null; // unreachable/broken URL — treated the same as "no image set"
  }
}

// Where the ink actually is inside an uploaded image, as fractions of the
// file (0..1), plus the file's natural size.
//
// A stamp or a signature is nearly always saved with a wide empty margin
// around the mark. Laying out from the file's edges then goes wrong in two
// ways at once: a seal drawn at 26mm shows perhaps 11mm of stamp, so the
// caption above it appears stranded over the gap, and a signature sized
// from the same 26mm comes out wider than the stamp it is meant to sit
// inside. Measuring the mark itself fixes both, and costs nothing when the
// image is already tightly cropped.
//
// Transparent pixels are the usual margin; a file saved without an alpha
// channel uses white instead, so both count as empty.
async function inkBoundsOf(dataUrl) {
  if (!dataUrl) return null;
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = dataUrl;
    });
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (d[i + 3] < 24) continue;                                        // transparent
        if (d[i] > 244 && d[i + 1] > 244 && d[i + 2] > 244) continue;       // white
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < x0 || y1 < y0) return null;   // nothing but margin — treat as unmeasurable
    return {
      x: x0 / w, y: y0 / h,
      w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h,
      imgW: w, imgH: h
    };
  } catch {
    return null;   // tainted canvas, broken file — fall back to the file's edges
  }
}

// Where to draw a whole image so that its ink lands on a wanted box.
// Returns the rectangle for doc.addImage plus the ink rectangle it
// produces, all in mm.
function placeInk(ink, wantW, cx, topY) {
  const b = ink || { x: 0, y: 0, w: 1, h: 1, imgW: 1, imgH: 1 };
  const ar = b.imgH / b.imgW;                  // the file's own aspect ratio
  const W = wantW / b.w;                       // full-image width, mm
  const H = W * ar;
  const inkW = b.w * W, inkH = b.h * H;
  return {
    x: cx - b.x * W - inkW / 2,
    y: topY - b.y * H,
    w: W, h: H,
    inkW, inkH
  };
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

  // Resolve every branding image (now Cloudinary URLs, not base64) into
  // actual image data once, up front — see imageUrlToDataUrl() above.
  const [logoData, sealData, signatureData, qrCustomData] = await Promise.all([
    imageUrlToDataUrl(p?.logo_base64),
    imageUrlToDataUrl(p?.seal_base64),
    imageUrlToDataUrl(p?.signature_base64),
    imageUrlToDataUrl(p?.qr_base64)
  ]);

  // ── Top: Logo + Company (left) / TAX INVOICE (right) ──
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
  const qrSource = qrCustomData || await generateQRDataUrl(`Invoice: ${inv.invoice_number}\nDate: ${formatDate(inv.invoice_date)}\nAmount: Rs.${formatNum(inv.total_amount)}`, p?.header_color);
  const qrIsCustom = !!qrCustomData;
  let sigBlockY = y;
  if (qrSource) {
    try {
      doc.addImage(qrSource, 'PNG', L, y, 24, 24);
      doc.setFontSize(7); doc.setTextColor(...accent); doc.setFont('helvetica', 'normal');
      doc.text(qrIsCustom ? 'Scan QR' : 'Scan to verify invoice', L, y + 28);
    } catch {}
  }

  // Seal and signature are one block, not two side-by-side images: the
  // signature belongs over the centre of the seal, the way it is signed on
  // paper. They used to be drawn 40mm apart, which printed as a small
  // circle with a separate scribble beside it.
  //
  // Laid out around one centre line so the caption, the stamp and the
  // wording underneath all share it. Matches the print/preview layout.
  // Every measurement below is of the ink inside each file, never of the
  // file's edges — see inkBoundsOf(). SEAL is therefore the size of the
  // stamp a reader sees, not of the PNG it came in.
  const [sealInk, sigInk] = await Promise.all([inkBoundsOf(sealData), inkBoundsOf(signatureData)]);

  const SEAL = 26;                       // mm across the visible stamp
  const sealCx = R - 5 - SEAL / 2;       // centre, held clear of the margin
  const sealTop = sigBlockY + 6;         // top of the stamp; "For ..." sits above

  // Fit the stamp's longer side to SEAL, so a mark that is wider than it is
  // tall does not overshoot the space reserved for it.
  const sb = sealInk || { w: 1, h: 1, imgW: 1, imgH: 1 };
  const sealWantW = SEAL * sb.w / Math.max(sb.w, sb.h * (sb.imgH / sb.imgW));
  const seal = sealData ? placeInk(sealInk, sealWantW, sealCx, sealTop)
                        : { inkW: SEAL, inkH: SEAL };   // no seal: the space is still reserved

  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(30, 30, 30);
  doc.text('For ' + (p?.business_name || 'Us'), sealCx, sealTop - 1.8, { align: 'center' });

  if (sealData) {
    try { doc.addImage(sealData, 'PNG', seal.x, seal.y, seal.w, seal.h); } catch {}
  }
  if (signatureData) {
    // Centred on the stamp, a little below its middle, which is where a
    // signature falls on a real one. Width is taken from the stamp the
    // reader sees; the height that follows from the signature's own shape
    // is capped so a tall scan cannot spill out of it.
    const cx = sealCx, cy = sealTop + seal.inkH * 0.52;
    let sig = placeInk(sigInk, seal.inkW * 0.62, cx, 0);
    const maxH = seal.inkH * 0.5;
    if (sig.inkH > maxH) {
      const k = maxH / sig.inkH;
      sig = placeInk(sigInk, seal.inkW * 0.62 * k, cx, 0);
    }
    // placeInk aligns the ink's top; the block wants its centre.
    const sb2 = sigInk || { y: 0, h: 1 };
    sig.y = cy - sb2.y * sig.h - sig.inkH / 2;
    try { doc.addImage(signatureData, 'PNG', sig.x, sig.y, sig.w, sig.h); } catch {}
  }

  const authY = sealTop + seal.inkH + 5;
  doc.setDrawColor(170, 170, 170);
  doc.line(sealCx - 22, authY - 3.5, sealCx + 22, authY - 3.5);
  doc.setFontSize(8); doc.setTextColor(120, 120, 120);
  doc.text('Authorized Signatory', sealCx, authY, { align: 'center' });
  y = sealTop + seal.inkH + 11;

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

// ── Print / View ───────────────────────────────────────
// buildInvoiceHTML() is the single source of the rendered invoice
// markup — printInvoice() opens it in a new window and auto-prints;
// viewInvoiceHTML() (js/invoice-list.js's View action) gets the exact
// same markup back to display read-only inside an iframe, with no
// separate template to keep in sync.
async function printInvoice(type, id) {
  const inv = await fetchInvoiceRecord(type, id);
  if (!inv) return;
  const html = await buildInvoiceHTML(inv, { autoPrint: true });
  const w = window.open('', '_blank');
  w.document.write(html);
  w.document.close();
  showToast('Print dialog opened!');
}

async function viewInvoiceHTML(type, id) {
  const inv = await fetchInvoiceRecord(type, id);
  if (!inv) return null;
  return buildInvoiceHTML(inv, { autoPrint: false });
}

async function buildInvoiceHTML(inv, opts) {
  opts = opts || {};
  const p = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const accentHex = p?.header_color || '#004d40';

  const qrSource = p?.qr_base64 || await generateQRDataUrl(`Invoice: ${inv.invoice_number}\nDate: ${formatDate(inv.invoice_date)}\nAmount: Rs.${formatNum(inv.total_amount)}`, accentHex);
  const qrCaption = p?.qr_base64 ? 'Scan QR' : 'Scan to verify invoice';
  const contactLine = [p?.email, p?.phone].filter(Boolean).join(' &middot; ');
  const bankLines = bankDetailLines(p);

  // The tax split a line was raised at, for display only. The AMOUNTS are
  // the stored ones — nothing here recomputes tax. An intra-state supply
  // splits its rate across CGST and SGST; an inter-state one carries it
  // all as IGST. Which of the two it is comes from the line's own stored
  // figures, so a corrected invoice prints what it was actually raised at.
  const splitOf = (row) => {
    const rate = +row.gst_percentage || 0;
    const inter = (+row.igst || 0) > 0 || ((+row.cgst || 0) === 0 && (+row.sgst || 0) === 0 && inv.supply_type === 'interstate');
    return inter ? { cg: 0, sg: 0, ig: rate } : { cg: rate / 2, sg: rate / 2, ig: 0 };
  };
  const pct = v => v ? (Math.round(v * 100) / 100) + '%' : '-';
  const amt = v => (+v > 0 ? formatNum(v) : '-');

  const rowHtml = (row, i) => {
    const s = splitOf(row);
    return `<tr>
      <td class="c">${i + 1}</td>
      <td class="desc"><b>${escHtml(row.product_name)}</b></td>
      <td class="c">${escHtml(row.hsn_code) || '-'}</td>
      <td class="c">${escHtml(row.unit) || '-'}</td>
      <td class="r">${formatNum(row.quantity)}</td>
      <td class="r">${formatNum(row.rate)}</td>
      <td class="r">${formatNum(row.taxable_value)}</td>
      <td class="c">${pct(s.cg)}</td><td class="r">${amt(row.cgst)}</td>
      <td class="c">${pct(s.sg)}</td><td class="r">${amt(row.sgst)}</td>
      <td class="c">${pct(s.ig)}</td><td class="r">${amt(row.igst)}</td>
      <td class="r"><b>${formatNum(row.total_amount)}</b></td>
    </tr>`;
  };

  // A pre-line-item invoice has no rows of its own; it prints as the one
  // supply it is, exactly as it did before.
  const printItemRowsHtml = inv.items
    ? inv.items.map(rowHtml).join('')
    : rowHtml({
        product_name: 'Taxable Supply', hsn_code: '', unit: '', quantity: 1,
        rate: inv.taxable_amount, taxable_value: inv.taxable_amount,
        gst_percentage: inv.gst_percentage, cgst: inv.cgst, sgst: inv.sgst,
        igst: inv.igst, total_amount: inv.total_amount
      }, 0);

  const roundOffRowHtml = Math.abs(inv.round_off) >= 0.005
    ? `<tr><td>Round Off</td><td class="r">${(inv.round_off >= 0 ? '+' : '') + formatNum(inv.round_off)}</td></tr>`
    : '';

  const billLines = [
    escHtml([inv.address, inv.state].filter(Boolean).join(', ')),
    inv.phone ? 'Phone: ' + escHtml(inv.phone) : '',
    inv.gstin ? 'GSTIN: ' + escHtml(inv.gstin) : ''
  ].filter(Boolean);

  // Same address unless a separate one was recorded — stated plainly
  // rather than left as an empty box the reader has to interpret.
  const sameAddress = !inv.shipping_address;
  const shipLines = sameAddress
    ? [escHtml([inv.address, inv.state].filter(Boolean).join(', ')),
       inv.phone ? 'Phone: ' + escHtml(inv.phone) : '',
       inv.gstin ? 'GSTIN: ' + escHtml(inv.gstin) : '',
       '<i>Same as billing address</i>'].filter(Boolean)
    : [escHtml([inv.shipping_address, inv.shipping_state || inv.state].filter(Boolean).join(', ')),
       inv.phone ? 'Phone: ' + escHtml(inv.phone) : '',
       inv.gstin ? 'GSTIN: ' + escHtml(inv.gstin) : ''].filter(Boolean);

  const sellerLines = [
    escHtml(p?.address), escHtml(p?.state),
    p?.gstin ? 'GSTIN: ' + escHtml(p.gstin) : '',
    p?.pan ? 'PAN: ' + escHtml(p.pan) : ''
  ].filter(Boolean);

  // Rendered only when the company actually uploaded them. Nothing is
  // drawn, substituted or approximated in their place.
  const hasSeal = !!p?.seal_base64;
  const hasSign = !!p?.signature_base64;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Invoice ${escHtml(inv.invoice_number)}</title>
<style>
  /* A4 with real print margins. Every width below is a percentage of the
     printable area, so nothing can run off the right edge. */
  @page { size: A4 portrait; margin: 10mm 10mm 8mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 9.5px; color: #1a1a1a;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { width: 100%; max-width: 190mm; margin: 0 auto; }

  /* ── header ── */
  .hdr { display: flex; justify-content: space-between; align-items: flex-start;
         border-bottom: 2.5px solid ${accentHex}; padding-bottom: 8px; }
  .hdr .who { display: flex; gap: 10px; align-items: flex-start; }
  .hdr .logo { max-height: 60px; max-width: 90px; object-fit: contain; }
  .hdr .name { font-size: 17px; font-weight: 800; color: ${accentHex}; line-height: 1.15; }
  .hdr .meta { font-size: 9px; color: #444; margin-top: 3px; line-height: 1.45; }
  .hdr .gstin { font-weight: 700; color: #1a1a1a; }
  .hdr .right { text-align: right; white-space: nowrap; padding-left: 12px; }
  .hdr .title { font-size: 19px; font-weight: 800; color: ${accentHex}; letter-spacing: 0.5px; }
  .hdr .copy { font-size: 8.5px; color: #666; margin-top: 2px; }

  /* ── two-column strips ── */
  .cols { display: flex; gap: 10px; margin-top: 9px; }
  .cols > * { flex: 1 1 0; min-width: 0; }
  .box { border: 1px solid #cfcfcf; border-radius: 3px; padding: 6px 8px; }
  .box h3, .strip h3 { margin: 0 0 4px; font-size: 8.5px; letter-spacing: 0.6px;
      text-transform: uppercase; color: #fff; background: ${accentHex};
      padding: 3px 6px; border-radius: 2px; display: block; }
  .box p, .strip p { margin: 1.5px 0; font-size: 9px; line-height: 1.4; word-wrap: break-word; }
  .strip { padding: 0 2px; }
  .kv { display: flex; justify-content: space-between; gap: 8px; }
  .kv span:first-child { color: #555; }

  /* ── items ── */
  table.items { width: 100%; border-collapse: collapse; margin-top: 9px; table-layout: fixed; font-size: 8.2px; }
  table.items th { background: ${accentHex}; color: #fff; padding: 5px 3px; border: 1px solid ${accentHex};
                   font-weight: 700; text-align: center; font-size: 7.8px; }
  table.items td { padding: 4px 3px; border: 1px solid #d8d8d8; vertical-align: top; }
  table.items td.desc { word-wrap: break-word; }
  .r { text-align: right; } .c { text-align: center; }
  /* Repeat the header and never split a line across pages. */
  table.items thead { display: table-header-group; }
  table.items tr { page-break-inside: avoid; }

  /* ── totals ── */
  .totrow { display: flex; gap: 12px; margin-top: 9px; align-items: flex-start; }
  .totrow .left { flex: 1 1 0; min-width: 0; }
  .totrow .right { flex: 0 0 46%; }
  .words { font-size: 9px; }
  .words b { display: block; margin-top: 2px; }
  .notes { margin-top: 6px; font-size: 8px; color: #666; font-style: italic; line-height: 1.4; }
  table.tot { width: 100%; border-collapse: collapse; font-size: 9px; }
  table.tot td { padding: 3px 6px; border: none; }
  table.tot td:last-child { text-align: right; }
  table.tot tr.grand td { border-top: 2px solid ${accentHex}; font-weight: 800;
      font-size: 12.5px; color: ${accentHex}; padding-top: 6px; }

  /* ── payment + signature ── */
  .paysign { display: flex; gap: 12px; margin-top: 10px; align-items: stretch;
             page-break-inside: avoid; }
  .paysign .pay { flex: 1 1 0; min-width: 0; }
  .paysign .qr { flex: 0 0 auto; text-align: center; padding-top: 18px; }
  .paysign .qr img { width: 62px; height: 62px; object-fit: contain; }
  .qr-cap { font-size: 7.5px; color: ${accentHex}; margin-top: 2px; }

  .signblock { flex: 0 0 32%; text-align: center; display: flex; flex-direction: column;
               align-items: center; justify-content: flex-start; }
  .signblock .for { font-size: 9.5px; font-weight: 700; margin-bottom: 2px; }
  /* The seal is the frame; the signature sits over its centre. Both are
     the exact uploaded images — object-fit keeps their aspect ratio, so
     neither is stretched or redrawn. */
  .stamp { position: relative; width: 108px; height: 108px; margin: 2px auto 0; }
  .stamp .seal { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .stamp .sig { position: absolute; left: 50%; top: 52%; transform: translate(-50%, -50%);
                max-width: 74%; max-height: 46%; object-fit: contain; }
  /* With no seal uploaded the signature simply sits in the same space. */
  .stamp.no-seal .sig { position: static; transform: none; display: block;
                        margin: 26px auto 0; max-width: 92%; max-height: 60%; }
  .stamp.empty { height: 74px; }
  .signblock .auth { font-size: 9px; color: #444; margin-top: 3px;
                     border-top: 1px solid #bbb; padding-top: 3px; min-width: 118px; }

  /* ── footer ── */
  .foot { margin-top: 12px; border-top: 1px solid ${accentHex}; padding-top: 7px;
          text-align: center; page-break-inside: avoid; }
  .foot .tc-title { font-size: 8px; font-weight: 700; color: ${accentHex}; }
  .foot .terms, .foot .ftext { font-size: 7.8px; color: #666; white-space: pre-line; margin: 2px 0 5px; }
  .foot .gen { font-size: 8px; color: #777; }
  .foot .contact { font-size: 8px; color: #777; margin-top: 2px; }
</style></head>
<body><div class="sheet">

  <div class="hdr">
    <div class="who">
      ${p?.logo_base64 ? `<img class="logo" src="${p.logo_base64}" alt="">` : ''}
      <div>
        <div class="name">${escHtml(p?.business_name) || 'Your Business Name'}</div>
        <div class="meta">
          ${sellerLines.map(l => `<div${l.startsWith('GSTIN') ? ' class="gstin"' : ''}>${l}</div>`).join('')}
          ${p?.website ? `<div>${escHtml(p.website)}</div>` : ''}
        </div>
      </div>
    </div>
    <div class="right">
      <div class="title">TAX INVOICE</div>
      <div class="copy">Original for Recipient</div>
    </div>
  </div>

  <div class="cols">
    <div class="strip">
      <h3>Sold By</h3>
      <p><b>${escHtml(p?.business_name)}</b></p>
      ${sellerLines.map(l => `<p>${l}</p>`).join('')}
    </div>
    <div class="strip">
      <h3>Order &amp; Invoice Details</h3>
      <p class="kv"><span>Invoice Number</span><b>${escHtml(inv.invoice_number)}</b></p>
      <p class="kv"><span>Invoice Date</span><b>${formatDate(inv.invoice_date)}</b></p>
      <p class="kv"><span>Place of Supply</span><b>${escHtml(invoicePlaceOfSupply(inv)) || '-'}</b></p>
      <p class="kv"><span>Type of Supply</span><b>${inv.supply_type === 'interstate' ? 'Inter-State' : 'Intra-State'}${inv.type === 'b2b' ? ' (B2B)' : ' (B2C)'}</b></p>
      <p class="kv"><span>Reverse Charge</span><b>${inv.reverse_charge ? 'Yes' : 'No'}</b></p>
    </div>
  </div>

  <div class="cols">
    <div class="box">
      <h3>Bill To</h3>
      <p><b>${escHtml(inv.customer_name)}</b></p>
      ${billLines.map(l => `<p>${l}</p>`).join('')}
    </div>
    <div class="box">
      <h3>Ship To</h3>
      <p><b>${escHtml(inv.customer_name)}</b></p>
      ${shipLines.map(l => `<p>${l}</p>`).join('')}
    </div>
  </div>

  <table class="items">
    <colgroup>
      <col style="width:3%"><col style="width:18%"><col style="width:7%"><col style="width:5%">
      <col style="width:5%"><col style="width:8%"><col style="width:9%">
      <col style="width:5%"><col style="width:7%">
      <col style="width:5%"><col style="width:7%">
      <col style="width:5%"><col style="width:7%">
      <col style="width:9%">
    </colgroup>
    <thead><tr>
      <th>#</th><th>Product Name</th><th>HSN</th><th>Unit</th><th>Qty</th><th>Rate</th>
      <th>Taxable Value</th>
      <th>CGST %</th><th>CGST</th><th>SGST %</th><th>SGST</th><th>IGST %</th><th>IGST</th>
      <th>Total</th>
    </tr></thead>
    <tbody>${printItemRowsHtml}</tbody>
  </table>

  <div class="totrow">
    <div class="left">
      <div class="words">Amount in Words:<b>${escHtml(numberToWordsINR(inv.total_amount))}</b></div>
      <div class="notes">
        GST has been charged separately as shown above.<br>
        Whether tax is payable under reverse charge: <b>${inv.reverse_charge ? 'Yes' : 'No'}</b>
      </div>
    </div>
    <div class="right">
      <table class="tot">
        <tr><td>Sub Total (Taxable Value)</td><td>Rs.${formatNum(inv.taxable_amount)}</td></tr>
        ${inv.cgst > 0 ? `<tr><td>CGST</td><td>Rs.${formatNum(inv.cgst)}</td></tr>` : ''}
        ${inv.sgst > 0 ? `<tr><td>SGST</td><td>Rs.${formatNum(inv.sgst)}</td></tr>` : ''}
        ${inv.igst > 0 ? `<tr><td>IGST</td><td>Rs.${formatNum(inv.igst)}</td></tr>` : ''}
        ${roundOffRowHtml}
        <tr class="grand"><td>Grand Total</td><td>Rs.${formatNum(inv.total_amount)}</td></tr>
      </table>
    </div>
  </div>

  <div class="paysign">
    <div class="pay">
      ${bankLines.length ? `<h3 style="margin:0 0 4px;font-size:8.5px;letter-spacing:.6px;text-transform:uppercase;color:#fff;background:${accentHex};padding:3px 6px;border-radius:2px;">Bank Details for Payment</h3>
        ${bankLines.map(l => `<p style="margin:1.5px 0;font-size:9px;">${escHtml(l)}</p>`).join('')}` : ''}
    </div>
    ${qrSource ? `<div class="qr"><img src="${qrSource}" alt=""><div class="qr-cap">${qrCaption}</div></div>` : ''}
    <div class="signblock">
      <div class="for">For ${escHtml(p?.business_name) || ''}</div>
      <div class="stamp${hasSeal ? '' : (hasSign ? ' no-seal' : ' empty')}">
        ${hasSeal ? `<img class="seal" src="${p.seal_base64}" alt="">` : ''}
        ${hasSign ? `<img class="sig" src="${p.signature_base64}" alt="">` : ''}
      </div>
      <div class="auth">Authorized Signatory</div>
    </div>
  </div>

  <div class="foot">
    ${p?.terms_conditions ? `<div class="tc-title">Terms &amp; Conditions</div><div class="terms">${escHtml(p.terms_conditions)}</div>` : ''}
    ${p?.footer_text ? `<div class="ftext">${escHtml(p.footer_text)}</div>` : ''}
    <div class="gen">This is a computer-generated invoice.</div>
    ${contactLine ? `<div class="contact">${contactLine}</div>` : ''}
  </div>

</div>
  ${opts.autoPrint ? '<script>window.onload = function(){ window.print(); }<\/script>' : ''}
</body></html>`;
}

function escHtml(v) { return (v || '').toString().replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

// ── WhatsApp Share ───────────────────────────────────
// Pulls the same full company-profile fields the PDF/Print/Email paths
// already use (business_name, gstin, address, state, phone, email,
// website, bank details, UPI — see getBusinessPDFHeader() and
// buildInvoicePDFDoc() for the PDF-side equivalents) into the shared
// text message too, not just the business name. Each field is only
// included when actually set, same "optional line" pattern the PDF
// header already uses for phone/email/website.
async function shareInvoiceWhatsApp(type, id) {
  const inv = await fetchInvoiceRecord(type, id);
  if (!inv) return;
  const p = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const biz = p?.business_name || 'GST Invoice';

  const sellerAddressLine = [p?.address, p?.state].filter(Boolean).join(', ');
  const bankLines = bankDetailLines(p);

  const msg = `*${biz} — Tax Invoice*\n\n` +
    `Invoice No : ${inv.invoice_number}\n` +
    `Date       : ${formatDate(inv.invoice_date)}\n` +
    `Customer   : ${inv.customer_name}\n` +
    (inv.gstin ? `GSTIN      : ${inv.gstin}\n` : '') +
    `\nTaxable Amt: ₹${formatNum(inv.taxable_amount)}\n` +
    (inv.igst > 0 ? `IGST       : ₹${formatNum(inv.igst)}\n` : `CGST       : ₹${formatNum(inv.cgst)}\nSGST       : ₹${formatNum(inv.sgst)}\n`) +
    `*Total Amt : ₹${formatNum(inv.total_amount)}*\n\n` +
    `*Sold By*\n` +
    `${biz}\n` +
    (p?.gstin ? `GSTIN: ${p.gstin}\n` : '') +
    (sellerAddressLine ? `${sellerAddressLine}\n` : '') +
    (p?.phone ? `Ph: ${p.phone}\n` : '') +
    (p?.email ? `Email: ${p.email}\n` : '') +
    (p?.website ? `${p.website}\n` : '') +
    (bankLines.length ? `\n*Payment Details*\n${bankLines.join('\n')}\n` : '') +
    `\n_Generated by ${biz}_`;
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
