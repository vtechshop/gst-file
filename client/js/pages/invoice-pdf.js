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
  // "Invoice not found" used to be shown for a FAILED read too, which
  // sent people looking for an invoice that was never missing.
  const data = await readMaybeOne(
    _supabase.from(table).select('*').eq('id', id).single(),
    'Could not load the invoice'
  );
  if (data === undefined) return null;                       // read failed, already reported
  if (!data) { showToast('That invoice no longer exists.', 'warning'); return null; }

  // The invoice row itself (customer_name/phone/address/state, captured
  // directly on Invoice Entry) is the authoritative source now. Customer
  // Master is still consulted as a fallback for older rows saved before
  // those fields existed, and for email (not collected on the invoice
  // form itself).
  // Only a fallback for older rows, so a failed read here is not worth
  // refusing to print over — the invoice's own captured fields still
  // carry the customer. Reported, then treated as no match.
  const custMatches = (await readAll(
    [_supabase.from('customers').select('*').eq('user_id', data.user_id)],
    'Could not check Customer Master for extra contact details'
  ) || [[]])[0];
  const customer = custMatches.find(c =>
    c.name.toLowerCase() === (data.customer_name || '').toLowerCase() &&
    (!data.gst_number || (c.gstin || '').toUpperCase() === (data.gst_number || '').toUpperCase())
  ) || custMatches.find(c => c.name.toLowerCase() === (data.customer_name || '').toLowerCase());

  // A failed read here is NOT allowed to fall through: the caller treats
  // a null `items` as "an old invoice with no line rows" and prints a
  // single summary line instead. On a failed read that would hand the
  // customer an invoice missing every line it actually has.
  let items = null;
  const itemRead = await readAll(
    [_supabase.from('invoice_items').select('*').eq('invoice_id', data.id).eq('invoice_type', type)],
    'Could not load the invoice line items'
  );
  if (!itemRead) return null;
  const activeItems = itemRead[0].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
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
    // Ship To recorded ON THE INVOICE wins: a tax invoice states where the
    // goods went on the day it was raised, so editing the customer's
    // delivery address later must not rewrite invoices already issued.
    // Invoices predating that column fall back to the customer record, and
    // then to the billing address, so nothing already printed changes.
    // Empty means the goods went to the billing address — the Ship To box
    // is never dropped, because a tax invoice that omits where the goods
    // went is missing information a reader expects to find.
    shipping_address: data.shipping_address || customer?.shipping_address || '',
    shipping_state: data.shipping_state || customer?.shipping_state || '',
    shipping_district: data.shipping_district || customer?.shipping_district || '',
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
    // Warranty, as stored on the invoice. This object is built from a named
    // list rather than spread, so a column added to the table does NOT reach
    // the PDF until it is named here - which is why the WARRANTY block drew
    // nothing while the data sat in the row all along. The per-item column
    // was unaffected because the line rows come back through select('*').
    warranty_period_months: data.warranty_period_months || null,
    warranty_start_date: data.warranty_start_date || null,
    warranty_until: data.warranty_until || null,
    warranty_terms: data.warranty_terms || '',
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

// ── Bill To / Ship To, composed once for both renderers ────────────────
// This file renders the same invoice two ways: buildInvoiceHTML() for the
// on-screen preview and Print, buildInvoicePDFDoc() for the downloaded
// PDF. They are separate on purpose — one is a web page, the other is a
// vector document with millimetre positioning — but WHAT each section
// says must not be. Composing the party blocks here is what stopped the
// two drifting: the PDF had no Ship To section at all for as long as the
// HTML had one, because adding it to one renderer never touched the other.
//
// Returns plain text. HTML escaping belongs to the HTML renderer; jsPDF
// draws strings and would print the entities literally.
// ── Item table column widths ────────────────────────────────
// Every column is given an explicit width. Without one, autoTable sizes
// columns from their content: a product name carrying a single long
// unbroken token took 90mm of a 182mm table and squeezed the other eleven
// columns to 6-10mm each, at which point headers like "Taxable Value"
// broke into one letter per line and the invoice ran to two pages.
//
// Weights, not millimetres, so the row always fills exactly the printable
// width it is handed — the same allocation survives a margin change or a
// different page size, and the columns cannot drift apart from the header
// because both come from this one table.
//
// The proportions, and the compromise in them. Portrait A4 leaves 182mm for
// twelve columns, and 2.5mm of padding a side spends 60mm of that before a
// character is drawn. Sizing all eleven fixed-content columns to their
// widest real value needs about 167mm, which would leave Product Name 15mm
// — narrow enough that it breaks words mid-syllable ("vegetabl / e cutting").
//
// So one column has to give, and the choice is deliberate: IGST. On an
// interstate invoice with a five-figure tax it wraps to two lines, and on
// every intrastate invoice it holds "-" and never wraps at all. In return
// Product Name gets enough width to break on word boundaries. Measured, not
// guessed: at weight 20 the names break as "vegetable / cutting / machine"
// and IGST is the only numeric column that wraps; at 21 and above three more
// numeric columns start wrapping too.
//
// Nothing here ever clips — autoTable wraps. The cost of a bad width is an
// extra line, never a lost digit.
// Relative widths, normalised to whatever the table is given. Retuned for
// A4 portrait: 194mm of usable width instead of landscape's 269mm, so every
// numeric column is cut to what its longest realistic value needs and the
// slack goes to Product Name, which is the only column that wraps.
//
// A value column is sized from its widest plausible content at 7pt, not from
// its heading: "1,47,000.00" is 11 characters and fits 19mm, where the old
// 24 units would have spent 24mm on it.
// The GST columns are DYNAMIC: they are generated from the tax the invoice
// actually carries, and the column that does not apply is absent from the
// table rather than present and blank.
//
//   IGST supply      SrNo | Product Name | HSN/SAC | Qty | Rate | IGST % | Amount
//   CGST+SGST supply SrNo | Product Name | HSN/SAC | Qty | Rate | GST % | CGST | SGST | Amount
//
// An invoice carries one regime or the other, never both, so the columns of
// the other regime could only ever hold "-" on every row. The old fixed table
// printed all three amount columns and spent about a third of its width on
// cells that said nothing; keeping them permanently is what that cost.
//
// Widths are relative, normalised to whatever width the table is given, and
// sized from the widest plausible VALUE at 7pt rather than from the heading:
// "1,47,000.00" is 11 characters and needs ~16mm with padding. Product Name
// is the only column that wraps, so it takes the slack - which is why the
// two-tax layout gives it less: the CGST and SGST columns come out of it.
// Nothing clips - autoTable wraps - so the cost of a narrow column is an
// extra line, never a lost digit.
const INVOICE_ITEM_COLUMNS_IGST = [
  { head: 'SrNo',         weight: 10, halign: 'right' },
  { head: 'Product Name', weight: 88, bold: true },
  { head: 'HSN/SAC',      weight: 20, halign: 'center' },
  { head: 'Qty',          weight: 14, halign: 'right' },
  { head: 'Rate',         weight: 24, halign: 'right' },
  { head: 'IGST %',       weight: 16, halign: 'right' },
  { head: 'Amount',       weight: 26, halign: 'right', bold: true }
];

const INVOICE_ITEM_COLUMNS_CGST_SGST = [
  { head: 'SrNo',         weight: 10, halign: 'right' },
  { head: 'Product Name', weight: 61, bold: true },
  { head: 'HSN/SAC',      weight: 19, halign: 'center' },
  { head: 'Qty',          weight: 13, halign: 'right' },
  { head: 'Rate',         weight: 21, halign: 'right' },
  { head: 'GST %',        weight: 15, halign: 'right' },
  { head: 'CGST',         weight: 20, halign: 'right' },
  { head: 'SGST',         weight: 20, halign: 'right' },
  { head: 'Amount',       weight: 23, halign: 'right', bold: true }
];

// One predicate decides the shape of the table, and it is the SAME expression
// the heading label and the totals block already use - inv.igst > 0 - so the
// table and the totals below it can never disagree about which tax this
// invoice carries. It reads existing invoice state; it computes no tax.
function invoiceItemColumns(isIgst) {
  return isIgst ? INVOICE_ITEM_COLUMNS_IGST : INVOICE_ITEM_COLUMNS_CGST_SGST;
}

// Every rule on the invoice is drawn in this ink at one of these two weights,
// so the sheet reads as a single grid instead of as a stack of separately
// styled blocks. The pale teal hairlines the sections used before were
// invisible on a laser print and made each band look unrelated to the next.
//
// BOLD frames the sheet and divides one section from the next; CELL rules the
// columns inside the item table, where a heavier line between every row would
// crowd 7pt figures.
const RULE_INK = [0, 0, 0];
const RULE_BOLD = 0.5;
const RULE_CELL = 0.25;

// The x of every column boundary, left edge through right edge. Derived from
// the SAME weights the cells are sized from, so the rules that continue below
// the last product line up with the rules beside it.
function invoiceItemColumnEdges(tableWidth, isIgst, left) {
  const columns = invoiceItemColumns(isIgst);
  const total = columns.reduce((a, c) => a + c.weight, 0);
  const edges = [left];
  let x = left;
  for (const c of columns) { x += tableWidth * c.weight / total; edges.push(x); }
  return edges;
}

function INVOICE_ITEM_COLUMN_STYLES(tableWidth, isIgst) {
  const columns = invoiceItemColumns(isIgst);
  const total = columns.reduce((a, c) => a + c.weight, 0);
  const styles = {};
  columns.forEach((c, i) => {
    styles[i] = { cellWidth: tableWidth * c.weight / total };
    if (c.halign) styles[i].halign = c.halign;
    if (c.bold) styles[i].fontStyle = 'bold';
  });
  return styles;
}

function invoicePartyLines(inv) {
  const bill = [
    [inv.address, inv.state].filter(Boolean).join(', '),
    inv.phone ? 'Phone: ' + inv.phone : '',
    inv.gstin ? 'GSTIN: ' + inv.gstin : ''
  ].filter(Boolean);

  // Same address unless a separate one was recorded — stated plainly
  // rather than left as an empty box the reader has to interpret.
  const sameAddress = !inv.shipping_address;
  const ship = sameAddress
    ? bill.slice()
    : [
      [inv.shipping_address, inv.shipping_state || inv.state].filter(Boolean).join(', '),
      inv.phone ? 'Phone: ' + inv.phone : '',
      inv.gstin ? 'GSTIN: ' + inv.gstin : ''
    ].filter(Boolean);

  return { bill, ship, sameAddress };
}

// ── Terms & Conditions, as a table when they are written as one ────────
// Business Profile stores terms as free text, and most companies write a
// paragraph. This one writes a schedule — "Payment Term: 100% bank
// transfer", "Warranty: One Year" — which reads as a table and is
// unreadable as a run-on sentence.
//
// So the shape follows the writing rather than a new setting: a line
// holding "Label: value" is a term with a value, and once at least two
// lines look like that the whole block is laid out as a table. Anything
// else stays a paragraph, exactly as before. Nothing to configure, and a
// company that writes prose sees no change.
//
// A label with no value is kept, not dropped — "Delivery at:" with the
// value still to be agreed is information the reader needs, and silently
// removing rows would edit the company's terms.
function parseTermsTable(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  const pairs = [];
  for (const line of lines) {
    // Split on the first colon only, so a value containing one survives.
    const m = /^(.{1,40}?)\s*:\s*(.*)$/.exec(line);
    if (!m) return null;                 // one prose line and it is not a table
    pairs.push([m[1].trim(), m[2].trim()]);
  }
  return pairs.length >= 2 ? pairs : null;
}

// The warranty block, as lines. Empty when the invoice carries none, which
// is every invoice raised before the feature existed - and an empty list
// draws nothing, so those documents are unchanged.
//
// Terms are printed as given: they are the seller's own wording and a
// warranty argued later turns on it.
function warrantyDetailLines(inv) {
  if (!inv) return [];
  const period = warrantyLabel(inv.warranty_period_months);
  const start = inv.warranty_start_date ? formatDate(inv.warranty_start_date) : '';
  const until = inv.warranty_until ? formatDate(inv.warranty_until) : '';
  const terms = (inv.warranty_terms || '').trim();
  if (!period && !start && !until && !terms) return [];
  return [
    period ? 'Warranty Period: ' + period : '',
    start ? 'Warranty Start: ' + start : '',
    until ? 'Warranty Until: ' + until : '',
    terms ? 'Terms: ' + terms : ''
  ].filter(Boolean);
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

// The three parts a tax invoice is issued in. Only this line differs
// between the copies - every figure, address and mark on them is the same
// document, which is the point of a duplicate.
const INVOICE_COPY_LABELS = [
  'Original for Recipient',
  'Duplicate for File Copy',
  'Duplicate for Transporter'
];

async function buildInvoicePDFDoc(inv) {
  const p = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const accent = hexToRgb(p?.header_color);
  const { jsPDF } = window.jspdf;
  // A4 PORTRAIT, the shape a commercial bill is printed in and the shape a
  // customer expects to be handed. Landscape bought width for the twelve
  // columns but spent it on the wrong axis: an A4 sheet turned sideways has
  // only 210mm of HEIGHT, and the item table is the thing that needs height.
  // Portrait gives 297mm, which is 87mm more room for product lines.
  //
  // The width that costs is bought back three ways rather than by dropping a
  // column: 8mm margins instead of 14 (194mm of table instead of 182), the
  // numeric columns cut to their real content above, and the party band set
  // as two rows of two rather than one row of four.
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  // Set once per copy by the render loop below; the header reads it.
  let copyLabel = INVOICE_COPY_LABELS[0];
  const pw = doc.internal.pageSize.width;
  const L = 8, R = pw - 8;

  // Resolve every branding image (now Cloudinary URLs, not base64) into
  // actual image data once, up front — see imageUrlToDataUrl() above.
  const [logoData, sealData, signatureData, qrCustomData] = await Promise.all([
    imageUrlToDataUrl(p?.logo_base64),
    imageUrlToDataUrl(p?.seal_base64),
    imageUrlToDataUrl(p?.signature_base64),
    imageUrlToDataUrl(p?.qr_base64)
  ]);

  // ── The invoice header, drawn on EVERY page ──
  //
  // A continuation sheet that opens straight into bare figures is not a tax
  // invoice — whoever picks up page 3 has to be able to see whose invoice it
  // is, its number, and who it is billed to. So the whole band is a function
  // and autoTable calls it again for each page it spills onto, with the same
  // positions, fonts, widths and spacing every time.
  //
  // It returns where it ends, which is both where page 1 continues and the
  // top margin the table must keep clear on every later page.
  // The top of the sheet's frame - above the logo at y=7, which is the
  // highest thing any page draws.
  const FRAME_TOP = 5;
  const drawInvoiceHeader = () => {
    // ── Top: Logo + Company (left) / TAX INVOICE (right) ──
    let nameX = L;
    if (logoData) {
      try { doc.addImage(logoData, 'PNG', L, 7, 11, 11); nameX = L + 14; } catch {}
    }
    doc.setTextColor(20, 20, 20);
    doc.setFontSize(15); doc.setFont('helvetica', 'bold');
    doc.text(p?.business_name || 'Your Business Name', nameX, 13.5);
    if (p?.website) {
      doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(120, 120, 120);
      doc.text(p.website, nameX, 18);
    }

    doc.setTextColor(...accent);
    doc.setFontSize(13); doc.setFont('helvetica', 'bold');
    doc.text('TAX INVOICE', R, 12.5, { align: 'right' });
    doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(120, 120, 120);
    doc.text(copyLabel, R, 17.5, { align: 'right' });

    // Accent divider
    doc.setFillColor(...accent);
    doc.rect(L, 20.5, R - L, 1, 'F');

    let y = 26;

    // ── Sold By / Invoice Details / Bill To / Ship To — ONE band ──
    //
    // Four columns across the landscape width instead of two bands stacked.
    // Portrait had 182mm and could hold only two at a time, so the parties sat
    // underneath the seller and the pair cost about 45mm of height. Landscape
    // has 269mm and fits all four on one line, the way a printed bill sets
    // them. The ~22mm that reclaims is what keeps an ordinary invoice on one
    // page: without it the footer alone spilled onto a second sheet.
    //
    // Every block keeps its own content and heading — nothing is dropped or
    // abbreviated, only placed side by side.
    const parties = invoicePartyLines(inv);
    // TWO rows of two, not one row of four. Four columns needed 269mm of
    // landscape; on a 194mm portrait sheet each would be 45mm, which wraps an
    // ordinary address into six lines and costs more height than the second
    // row saves. Two columns of 94mm hold an address on two lines, and the
    // pairing matches how a printed bill reads: who is selling and what the
    // document is, then who is buying and where it ships.
    const PART_GAP = 6;
    const partColW = (R - L - PART_GAP) / 2;
    const partX = [L, L + partColW + PART_GAP];
    // 3.8mm between lines rather than 4.5: at 7.5pt the glyphs are 2.6mm tall,
    // so this is still a clear gap and it saves ~6mm across the band.
    const LH = 3.8;

    const heads = (left, right) => {
      doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(...accent);
      doc.text(left, partX[0], y);
      doc.text(right, partX[1], y);
      doc.setDrawColor(...RULE_INK);
      doc.setLineWidth(RULE_BOLD);
      doc.line(L, y + 1.2, R, y + 1.2);
      sectionRuleY = y + 1.2;
      y += 4.6;
    };
    // The rule each band was headed with, so the divider between its two
    // columns can be dropped from it down to the band's foot.
    let sectionRuleY = 0;
    const columnDivider = (topY, bottomY) => {
      doc.setDrawColor(...RULE_INK);
      doc.setLineWidth(RULE_BOLD);
      doc.line(partX[1] - PART_GAP / 2, topY, partX[1] - PART_GAP / 2, bottomY);
    };

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

    // ── Row 1: SOLD BY | ORDER & INVOICE DETAILS ──
    heads('SOLD BY', 'ORDER & INVOICE DETAILS');
    doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(40, 40, 40);
    const soldByWrapped = wrapLines(doc, soldByLines, partColW);
    const metaWrapped = wrapLines(doc, metaLines, partColW);
    const row1Top = y;
    soldByWrapped.forEach((line, i) => doc.text(line, partX[0], row1Top + i * LH, { maxWidth: partColW }));
    metaWrapped.forEach((line, i) => doc.text(line, partX[1], row1Top + i * LH, { maxWidth: partColW }));
    y = row1Top + Math.max(soldByWrapped.length, metaWrapped.length) * LH + 3;
    columnDivider(sectionRuleY, y - 3 + 1);

    // ── Row 2: BILL TO | SHIP TO ──
    heads('BILL TO', 'SHIP TO');
    doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(40, 40, 40);
    const custName = inv.customer_name || '';
    const nameLines = doc.splitTextToSize(custName, partColW);
    const billWrapped = wrapLines(doc, parties.bill, partColW);
    const shipWrapped = wrapLines(doc, parties.ship, partColW);
    const partTop = y;

    // The customer's name leads each party column in bold, as before.
    doc.setFont('helvetica', 'bold');
    nameLines.forEach((line, i) => {
      doc.text(line, partX[0], partTop + i * LH);
      doc.text(line, partX[1], partTop + i * LH);
    });
    doc.setFont('helvetica', 'normal');
    const nameH = nameLines.length * LH;
    billWrapped.forEach((line, i) => doc.text(line, partX[0], partTop + nameH + i * LH, { maxWidth: partColW }));
    shipWrapped.forEach((line, i) => doc.text(line, partX[1], partTop + nameH + i * LH, { maxWidth: partColW }));

    let partyRows = nameLines.length + Math.max(billWrapped.length, shipWrapped.length);
    if (parties.sameAddress) {
      doc.setFont('helvetica', 'italic'); doc.setTextColor(120, 120, 120);
      doc.text('Same as billing address', partX[1], partTop + nameH + shipWrapped.length * LH);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(40, 40, 40);
      partyRows = Math.max(partyRows, nameLines.length + shipWrapped.length + 1);
    }

    // The deeper of the two columns decides where the item table starts.
    columnDivider(sectionRuleY, partTop + partyRows * LH + 1);
    return partTop + partyRows * LH + 2.5;
  };

  // The visible ink inside the seal and signature files, resolved ONCE for the
  // whole document rather than per draw: the images do not change between
  // copies, and the block is now drawn on every page of every copy, so
  // measuring per draw would decode the same PNGs dozens of times.
  const [sealInk, sigInk] = await Promise.all([inkBoundsOf(sealData), inkBoundsOf(signatureData)]);

  // ── The seal / signature block, drawn on EVERY page ────
  //
  // It used to be drawn once, inline, wherever the closing block happened to
  // land - which is the last page of each copy. A four-page invoice carried
  // three unsigned sheets. It is a renderer now, for the same reason
  // drawInvoiceHeader() is one: the page loop below calls it for each page, so
  // every page is signed and no page can drift from the others.
  //
  // topY is the top of the band. Everything inside is positioned relative to
  // it, so the same call gives the same block wherever it is placed.
  const SEAL = 26;                       // mm across the visible stamp
  const sealReserveH = sealData ? SEAL : (signatureData ? 18 : 14);
  const drawSignatureBlock = (topY) => {
    const sealCx = R - 5 - SEAL / 2;     // centre, held clear of the margin
    const sealTop = topY + 6;            // top of the stamp; "For ..." sits above

    // Fit the stamp's longer side to SEAL, so a mark that is wider than it is
    // tall does not overshoot the space reserved for it.
    const sb = sealInk || { w: 1, h: 1, imgW: 1, imgH: 1 };
    const sealWantW = SEAL * sb.w / Math.max(sb.w, sb.h * (sb.imgH / sb.imgW));
    const seal = sealData ? placeInk(sealInk, sealWantW, sealCx, sealTop)
                          : { inkW: SEAL, inkH: sealReserveH };

    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(30, 30, 30);
    doc.text('For ' + (p?.business_name || 'Us'), sealCx, sealTop - 1.8, { align: 'center' });

    if (sealData) {
      try { doc.addImage(sealData, 'PNG', seal.x, seal.y, seal.w, seal.h); } catch {}
    }
    if (signatureData) {
      // Centred on the stamp's visible ink, horizontally and vertically - the
      // mark's own bounds, not the edges of the file it arrived in.
      const cx = sealCx, cy = sealTop + seal.inkH * 0.50;
      let sig = placeInk(sigInk, seal.inkW * 0.62, cx, 0);
      const maxH = seal.inkH * 0.5;
      if (sig.inkH > maxH) {
        const k = maxH / sig.inkH;
        sig = placeInk(sigInk, seal.inkW * 0.62 * k, cx, 0);
      }
      const sb2 = sigInk || { y: 0, h: 1 };
      sig.y = cy - sb2.y * sig.h - sig.inkH / 2;
      try { doc.addImage(signatureData, 'PNG', sig.x, sig.y, sig.w, sig.h); } catch {}
    }

    const authY = sealTop + seal.inkH + 5;
    // Held inside the sheet's frame. At the full 22mm half-width this rule
    // ran to x=206 on a 202mm right margin - 4mm outside the page's own
    // border, which only became visible once the border was drawn.
    const authW = Math.min(22, R - 3 - sealCx);
    doc.setDrawColor(...RULE_INK);
    doc.setLineWidth(RULE_CELL);
    doc.line(sealCx - authW, authY - 3.5, sealCx + authW, authY - 3.5);
    doc.setFontSize(8); doc.setTextColor(120, 120, 120);
    doc.text('Authorized Signatory', sealCx, authY, { align: 'center' });
    return sealTop + seal.inkH + 5;      // where the block ends
  };

  // ── Three copies, one document ─────────────────────────
  // Rendered by running the same drawing code three times rather than by
  // building three documents: there is one template, so the copies cannot
  // drift apart, and only the label above changes between them.
  for (let copyIndex = 0; copyIndex < INVOICE_COPY_LABELS.length; copyIndex++) {
    copyLabel = INVOICE_COPY_LABELS[copyIndex];
    // The page the in-flow signature landed on, so the loop below does not
    // draw a second one over it.
    const signedPages = new Set();
    if (copyIndex > 0) doc.addPage();
    const copyFirstPage = doc.internal.getNumberOfPages();

    let y = drawInvoiceHeader();
    const HEADER_BOTTOM = y;

    // ── Item table — Product Name / HSN / Unit / Qty / Rate / GST% /
    // Taxable Value / CGST / SGST / IGST / Line Total, sourced directly
    // from the invoice's product line items (Product Master HSN/GST%/Unit) ──
    // Which regime this invoice carries decides the columns. Read off the
    // invoice, not recomputed: inv.igst is the value the invoice was saved
    // with, and no figure below is derived here either - quantity, rate, GST
    // rate, per-line CGST, per-line SGST and the line amount are each printed
    // exactly as stored.
    const isIgstInvoice = inv.igst > 0;
    const itemColumns = invoiceItemColumns(isIgstInvoice);

    // The single place a row is assembled, so the body can never fall out of
    // step with the head: both are built from the same regime flag.
    const itemCells = (sr, name, hsn, qty, rate, pct, cgst, sgst, amount) =>
      isIgstInvoice
        ? [sr, name, hsn, qty, rate, pct, amount]
        : [sr, name, hsn, qty, rate, pct, cgst, sgst, amount];

    const pdfItemRows = inv.items
      ? inv.items.map((it, i) => itemCells(
          String(i + 1), it.product_name, it.hsn_code || '-',
          formatNum(it.quantity), formatNum(it.rate), it.gst_percentage + '%',
          it.cgst > 0 ? formatNum(it.cgst) : '-',
          it.sgst > 0 ? formatNum(it.sgst) : '-',
          formatNum(it.total_amount)))
      : [itemCells(
          '1', 'Taxable Supply', '-', '1', formatNum(inv.taxable_amount),
          inv.gst_percentage + '%',
          inv.cgst > 0 ? formatNum(inv.cgst) : '-',
          inv.sgst > 0 ? formatNum(inv.sgst) : '-',
          formatNum(inv.total_amount))];
    // Measured BEFORE the table, because the table's bottom edge is the top
    // edge of the closing grid below. Nothing in here depends on where the
    // table ends, so measuring first changes no value - it only makes the
    // grid's height available to the table's bottom margin.
    //
    // SPLIT divides the grid: the left cell carries the bank block, the QR,
    // the warranty and the terms; the right carries the totals and the
    // signature. It is declared here because everything wrapped below is
    // wrapped to a cell width derived from it - wrapping to one width and
    // drawing at another would re-wrap at draw time and overflow the row that
    // was reserved for it.
    const SPLIT = L + 122;                       // left cell 122mm, right 72mm
    const CELL_TEXT_W = SPLIT - 32 - L;          // clear of the QR on its right
    const boxX = R - 80;
    const totalsRows = [['Subtotal', formatNum(inv.taxable_amount)]];
    if (inv.cgst > 0) totalsRows.push(['CGST', formatNum(inv.cgst)]);
    if (inv.sgst > 0) totalsRows.push(['SGST', formatNum(inv.sgst)]);
    if (inv.igst > 0) totalsRows.push([`IGST (${inv.gst_percentage}%)`, formatNum(inv.igst)]);
    if (Math.abs(inv.round_off) >= 0.005) totalsRows.push(['Round Off', (inv.round_off >= 0 ? '+' : '') + formatNum(inv.round_off)]);
    const bankLines = bankDetailLines(p);
    // Wrapped HERE, once, because the space the close needs decides whether
    // the totals fit on this page at all - and the terms are the one line
    // that can run to several. Measuring the unwrapped list would
    // under-reserve and let the block run into the signature.
    const warrantyLines = warrantyDetailLines(inv).flatMap(
      (line) => doc.splitTextToSize(line, CELL_TEXT_W));

    // Terms are wrapped here for the same reason as the warranty lines above:
    // the closing block's height is what decides whether it fits on this page,
    // and a paragraph of conditions can run to several lines. Measuring the
    // unwrapped text would under-reserve — and now that the band follows the
    // content rather than sitting at a fixed height, under-reserving would put
    // the seal on top of the terms instead of merely low on the page.
    const TC_WIDTH = SPLIT - 4 - L;
    const termsPairs = parseTermsTable(p?.terms_conditions);
    doc.setFontSize(7.5);
    const termsProse = (p?.terms_conditions && !termsPairs && TC_WIDTH > 40)
      ? doc.splitTextToSize(p.terms_conditions, TC_WIDTH)
      : [];

    // ── The closing grid's geometry ──
    //
    // A billing machine prints the close as a bordered grid rather than as free
    // text: a Sub Total strip, then bank details beside the tax summary, then
    // the amount in words beside the Grand Total, then the terms beside the
    // signature. Every row is measured HERE so the grid can be bottom-anchored
    // and the table above it given a fixed bottom edge - the two share a rule.
    const SIG_BLOCK_H = 6 + sealReserveH + 5;    // gap + stamp reserve + caption

    // The footer, measured first, because the grid is bottom-aligned against
    // it. This was a constant once, and a constant can disagree with the footer
    // that actually gets drawn: a profile carrying footer_text measures 22.6mm
    // where the guess said 18, which pushed the close 4.6mm past the page.
    doc.setFontSize(7.5);
    const footerLines = p?.footer_text ? doc.splitTextToSize(p.footer_text, R - L) : [];
    const footerH =
      6                                                   // rule + gap
      + (footerLines.length ? footerLines.length * 3.6 + 5 : 0)
      + 4 + 4;                                            // generated line + contact
    // The page number sits 8mm from the bottom, so the footer finishes above that.
    const PAGE_BOTTOM = doc.internal.pageSize.height - 12;

    // Each row's height comes from what it actually draws, so a profile with
    // six bank lines or a long warranty gets the room it needs instead of a
    // guess that could clip it.
    const ROW_A_H = 7;                                    // GSTIN | Sub Total
    const bankBlockH = bankLines.length ? 4 + bankLines.length * 3.8 : 0;
    const warrantyBlockH = warrantyLines.length ? 5 + warrantyLines.length * 3.8 : 0;
    const QR_BLOCK_H = 26;                                // 22mm code + caption
    // totalsRows[0] is the Subtotal, which has its own strip above; everything
    // after it - the taxes and any round off - is the tax summary. Read, not
    // rebuilt: the list itself is exactly as it was constructed.
    const taxLines = totalsRows.slice(1);
    const ROW_B_H = Math.max(
      bankBlockH + warrantyBlockH,                        // left, stacked
      QR_BLOCK_H,                                         // left, alongside
      5 + (1 + taxLines.length) * 4.6                     // right
    ) + 4;
    const ROW_C_H = 9;                                    // Bill Amount | Grand Total
    // A schedule of terms is a table and needs its own room; prose is wrapped
    // lines. Whichever this profile carries, the signature must still fit.
    const termsTableH = termsPairs ? 6 + Math.ceil(termsPairs.length / 2) * 4.6 : 0;
    const termsProseH = termsProse.length ? 4 + termsProse.length * 3.4 : 0;
    const ROW_D_H = Math.max(SIG_BLOCK_H + 3, termsProseH + termsTableH + 12);

    const CLOSE_H = ROW_A_H + ROW_B_H + ROW_C_H + ROW_D_H;
    const ROW_A_Y = PAGE_BOTTOM - footerH - CLOSE_H;
    const ROW_B_Y = ROW_A_Y + ROW_A_H;
    const ROW_C_Y = ROW_B_Y + ROW_B_H;
    const ROW_D_Y = ROW_C_Y + ROW_C_H;
    const CLOSE_END = ROW_D_Y + ROW_D_H;

    // The signature row's top. The page loop repeats the block here on pages
    // the close did not land on, so every page carries it at the same height.
    const bandTop = ROW_D_Y;

    // The table's bottom edge IS the grid's top edge. The floor keeps a usable
    // table even if a profile's close were absurdly tall; it never binds in
    // normal use.
    const TABLE_FIXED_BOTTOM = Math.max(ROW_A_Y, HEADER_BOTTOM + 30);

    // autoTable measures its margins from the SHEET EDGE, not from a derived
    // page-bottom, so the reserve is the distance from the sheet's foot up to
    // the fixed bottom edge.
    const TABLE_BOTTOM_RESERVE = doc.internal.pageSize.height - TABLE_FIXED_BOTTOM;

    doc.autoTable({
      startY: y,
      // The head is the dynamic column set itself, so a column can never be
      // headed here and missing from the rows below.
      head: [itemColumns.map(c => c.head)],
      body: pdfItemRows,
      theme: 'grid',
      headStyles: { fillColor: [Math.min(accent[0]+224,255), Math.min(accent[1]+165,255), Math.min(accent[2]+177,255)], textColor: accent, fontStyle: 'bold', fontSize: 6.8, lineColor: RULE_INK, lineWidth: RULE_BOLD },
      bodyStyles: { fontSize: 7, textColor: [40, 40, 40] },
      columnStyles: INVOICE_ITEM_COLUMN_STYLES(R - L, isIgstInvoice),
      // top margin keeps every continuation page clear of the repeated header;
      // page 1 starts at startY, which is already below it.
      // top keeps continuation pages clear of the repeated invoice header;
      // bottom is the FIXED bottom edge - the same on every page of every
      // invoice - so the ruled area is one constant rectangle and the close
      // below it can never be run into.
      margin: { left: L, right: L, top: HEADER_BOTTOM, bottom: TABLE_BOTTOM_RESERVE },
      // Row height is font + padding, and padding was the larger half of it:
      // 2.5mm top AND bottom added 5mm to every line, so ten products spent
      // 50mm on whitespace. 1.1mm still separates the rule from the glyphs.
      // A row is now ~5.0mm instead of ~7.8mm - the single change that decides
      // how many products reach one page.
      // lineWidth changes what is drawn, never how tall a row is, so the
      // fixed geometry above is untouched by darkening the rules.
      styles: { cellPadding: { top: 1.1, right: 1.4, bottom: 1.1, left: 1.4 }, lineColor: RULE_INK, lineWidth: RULE_CELL, overflow: 'linebreak', valign: 'middle' },
      // The column head repeats on each page by default; this repeats the
      // invoice header with it. Page 1's was already drawn above, so only the
      // continuation pages are redrawn here — for as many as the table needs,
      // with no assumption about how many that is.
      showHead: 'everyPage',
      didDrawPage: (d) => { if (d.pageNumber > 1) drawInvoiceHeader(); }
    });
    // ── Rule the unused part of the table ──
    //
    // The rows stop where the products stop, but the TABLE does not: its
    // border and column separators carry on to the fixed bottom edge, so a
    // two-line invoice prints the same ruled box as a fifteen-line one and the
    // empty area sits INSIDE the table rather than as blank paper below it.
    //
    // Only the last page of the table needs this. Earlier pages are full, so
    // their rows already reach the fixed bottom and finalY equals it.
    //
    // No horizontal rules are drawn in the empty part: a printed book rules
    // the columns down the page and leaves the rows to be written in, and
    // drawing row lines under the last product would suggest rows that are
    // not there.
    const tableFoot = doc.lastAutoTable.finalY;
    if (tableFoot < TABLE_FIXED_BOTTOM - 0.2) {
      doc.setDrawColor(...RULE_INK);        // the body rules' own ink
      doc.setLineWidth(RULE_CELL);          // and their own weight
      invoiceItemColumnEdges(R - L, isIgstInvoice, L)
        .forEach((x) => doc.line(x, tableFoot, x, TABLE_FIXED_BOTTOM));
      doc.line(L, TABLE_FIXED_BOTTOM, R, TABLE_FIXED_BOTTOM);
    }


    // ── The closing grid ──
    //
    // Every figure sits in a ruled cell, so a reader finds it in the same place
    // on every invoice. Nothing here computes anything: totalsRows was built
    // above and is only READ, row by row, into the cells - the Subtotal into
    // the strip, the taxes into the summary, and inv.total_amount into the
    // Grand Total box exactly as before.
    const cellMoney = (v) => 'Rs.' + v;

    doc.setDrawColor(...RULE_INK);
    doc.setLineWidth(RULE_BOLD);                 // the same weight as the table
    doc.rect(L, ROW_A_Y, R - L, CLOSE_END - ROW_A_Y);
    doc.line(L, ROW_B_Y, R, ROW_B_Y);
    doc.line(L, ROW_C_Y, R, ROW_C_Y);
    doc.line(L, ROW_D_Y, R, ROW_D_Y);
    doc.line(SPLIT, ROW_A_Y, SPLIT, CLOSE_END);

    // ── Row A: GSTIN | Sub Total ──
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(0, 0, 0);
    doc.text('GSTIN No.: ' + (p?.gstin || '-'), L + 2, ROW_A_Y + 4.9);
    doc.text(totalsRows[0][0], SPLIT + 2, ROW_A_Y + 4.9);
    doc.text(cellMoney(totalsRows[0][1]), R - 2, ROW_A_Y + 4.9, { align: 'right' });

    // ── Row B left: bank details, with the QR in the same cell ──
    let bankY = ROW_B_Y + 5;
    if (bankLines.length) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(0, 0, 0);
      doc.text('Bank Details for Payment', L + 2, bankY);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.8); doc.setTextColor(40, 40, 40);
      bankLines.forEach((l, i) => doc.text(l, L + 2, bankY + 4 + i * 3.8, { maxWidth: CELL_TEXT_W }));
      bankY += 4 + bankLines.length * 3.8;
    }
    // Warranty keeps its place under the bank block, in the same cell.
    if (warrantyLines.length) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(0, 0, 0);
      doc.text('WARRANTY', L + 2, bankY + 1);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.8); doc.setTextColor(40, 40, 40);
      warrantyLines.forEach((t, i) => doc.text(t, L + 2, bankY + 5 + i * 3.8, { maxWidth: CELL_TEXT_W }));
    }

    // The QR carries the verification ADDRESS, not the invoice - unchanged.
    // Encoding the figures would let the paper verify against itself; an id
    // sends the reader to the record instead. Only where it sits has moved:
    // into the bank cell, where a printed bill puts its pay-by-scan code.
    const qrSource = qrCustomData || await generateQRDataUrl(invoiceVerifyUrl(inv.type, inv.id), p?.header_color);
    const qrIsCustom = !!qrCustomData;
    const qrX = SPLIT - 26, qrY = ROW_B_Y + 2;
    if (qrSource) {
      try {
        doc.addImage(qrSource, 'PNG', qrX, qrY, 22, 22);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(6.4); doc.setTextColor(0, 0, 0);
        doc.text(qrIsCustom ? 'SCAN QR FOR PAY' : 'Scan to verify invoice',
          qrX + 11, qrY + 24.5, { align: 'center' });
      } catch {}
    }

    // ── Row B right: the tax summary ──
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(0, 0, 0);
    doc.text('Taxable Amount', SPLIT + 2, ROW_B_Y + 5.5);
    doc.text(cellMoney(formatNum(inv.taxable_amount)), R - 2, ROW_B_Y + 5.5, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setTextColor(40, 40, 40);
    // CGST and SGST on an intra-state supply, IGST on an inter-state one, plus
    // any round off - whatever totalsRows was built with, in its own order.
    taxLines.forEach((r, i) => {
      doc.text(r[0], SPLIT + 2, ROW_B_Y + 10.5 + i * 4.6);
      doc.text(cellMoney(r[1]), R - 2, ROW_B_Y + 10.5 + i * 4.6, { align: 'right' });
    });

    // ── Row C: Bill Amount in words | Grand Total ──
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(0, 0, 0);
    doc.text('Bill Amount :', L + 2, ROW_C_Y + 5.8);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.8);
    doc.text(numberToWordsINR(inv.total_amount), L + 22, ROW_C_Y + 5.8,
      { maxWidth: SPLIT - 24 - L });
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...accent);
    doc.text('Grand Total', SPLIT + 2, ROW_C_Y + 6.4);
    doc.text(cellMoney(formatNum(inv.total_amount)), R - 2, ROW_C_Y + 6.4, { align: 'right' });

    // ── Row D left: terms and the GST notes ──
    let termsY = ROW_D_Y + 4;
    if (termsProse.length) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(0, 0, 0);
      doc.text('Terms & Condition :', L + 2, termsY);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 80, 80);
      // Already wrapped above, so the height reserved and the height drawn
      // cannot disagree.
      doc.text(termsProse, L + 2, termsY + 3.6);
      termsY += 3.6 + termsProse.length * 3.4;
    }
    doc.setFont('helvetica', 'italic'); doc.setFontSize(7); doc.setTextColor(110, 110, 110);
    doc.text('* GST has been charged separately as shown above.', L + 2, termsY + 3);
    doc.text('Whether tax is payable under reverse charge: '
      + (inv.reverse_charge ? 'Yes' : 'No'), L + 2, termsY + 6.4);

    // ── Row D right: the seal and signature, unchanged in what it draws ──
    const sigBlockY = ROW_D_Y;
    const signBlockBottom = drawSignatureBlock(sigBlockY);
    signedPages.add(doc.internal.getNumberOfPages());

    y = CLOSE_END;

    // A schedule of terms is drawn full width BELOW the signature, in the
    // band that was blank, because a two-column table needs the width and
    // reads as a table rather than as a note squeezed beside the stamp.
    // Term and value are paired across the page the way the company writes
    // them, two pairs to a row.
    if (termsPairs) {
      const rows = [];
      for (let i = 0; i < termsPairs.length; i += 2) {
        const a = termsPairs[i], b = termsPairs[i + 1];
        rows.push([a[0], a[1], b ? b[0] : '', b ? b[1] : '']);
      }
      // Styled to the company's own terms sheet rather than to the rest of
      // this document: yellow ground, black rules, bold labels with the
      // numbering written exactly as they number it. That sheet is the one
      // the customer already knows, and matching the invoice's teal-and-grey
      // house style here would have quietly redesigned a document the
      // company treats as fixed.
      const TERMS_YELLOW = [255, 255, 153];
      doc.autoTable({
        // Inside the grid's left cell, not below the whole close: the grid
        // is bottom-anchored against the footer, so anything drawn under it
        // would land in the footer.
        startY: ROW_D_Y + 2,
        head: [[{ content: 'Terms & condition', colSpan: 4 }]],
        body: rows,
        theme: 'grid',
        margin: { left: L, right: pw - (SPLIT - 2) },
        styles: {
          fontSize: 7, cellPadding: 1,
          fillColor: TERMS_YELLOW, textColor: [0, 0, 0],
          lineColor: [0, 0, 0], lineWidth: 0.2,
          valign: 'middle'
        },
        headStyles: {
          fillColor: TERMS_YELLOW, textColor: [0, 0, 0],
          fontSize: 8, fontStyle: 'bold', halign: 'center',
          lineColor: [0, 0, 0], lineWidth: 0.2
        },
        // Label bold on the left of each half, value toward the right of it.
        columnStyles: {
          0: { fontStyle: 'bold', halign: 'left',  cellWidth: (SPLIT - 2 - L) * 0.25 },
          1: { fontStyle: 'normal', halign: 'right', cellWidth: (SPLIT - 2 - L) * 0.25 },
          2: { fontStyle: 'bold', halign: 'left',  cellWidth: (SPLIT - 2 - L) * 0.25 },
          3: { fontStyle: 'normal', halign: 'right', cellWidth: (SPLIT - 2 - L) * 0.25 }
        },
        // autoTable has no underline, so the title's rule is drawn on top of
        // the header cell to match the reference sheet.
        didDrawCell: data => {
          if (data.section !== 'head') return;
          const w = doc.getTextWidth('Terms & condition');
          const cx = data.cell.x + data.cell.width / 2;
          const ty = data.cell.y + data.cell.height - 1.6;
          doc.setDrawColor(0, 0, 0); doc.setLineWidth(0.3);
          doc.line(cx - w / 2, ty, cx + w / 2, ty);
        }
      });
      // The grid's own bottom still decides where the footer goes.
      y = Math.max(y, doc.lastAutoTable.finalY + 2);
    }

    // ── Footer: Terms & Conditions, footer text, computer-generated line, contact ──
    //
    // Measured before it is drawn, so the decision to start a new page is
    // made on what the block actually needs rather than on a guess. The old
    // test was `y > 260`, a fixed guess that fired whenever the signature
    // block ended low — pushing Terms onto a second page and leaving the
    // bottom of page one empty, which is exactly the blank space that
    // looked like a layout bug. Now a page is added only when the footer
    // genuinely will not fit.
    if (y + footerH > PAGE_BOTTOM) { doc.addPage(); y = drawInvoiceHeader(); }
    else {
      // Everything fits. Push the block down so it sits at the foot of the
      // page instead of leaving the gap underneath it — the invoice reads
      // as one full page rather than one that stopped early.
      y = Math.max(y, PAGE_BOTTOM - footerH);
    }

    // The rule between the closing grid and the footer. y here is exactly
    // CLOSE_END, so this lands on the frame's bottom edge and has to be drawn
    // in the same ink and weight or the frame appears to change colour there.
    doc.setDrawColor(...RULE_INK);
    doc.setLineWidth(RULE_BOLD);
    doc.line(L, y, R, y);
    y += 6;

    if (footerLines.length) {
      doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(100, 100, 100);
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


    // Numbered within the copy, not across the file: each copy is a whole
    // invoice, so it reads "Page 1 of 1" exactly as it did before there
    // were three of them, and a long invoice numbers 1..n inside each.
    const copyLastPage = doc.internal.getNumberOfPages();
    const copyPageCount = copyLastPage - copyFirstPage + 1;
    for (let i = copyFirstPage; i <= copyLastPage; i++) {
      doc.setPage(i);
      // Every page of this copy carries the seal and signature, not just the
      // one the closing block finished on. The page the flow already signed is
      // skipped so nothing is drawn twice.
      //
      // bandTop is the same figure the closing block bottom-aligns against, so
      // a continuation page's block sits exactly where the final page's does,
      // and the table's bottom margin has already held that space clear.
      if (!signedPages.has(i)) drawSignatureBlock(bandTop);
      // One border around the whole sheet, drawn on EVERY page so a
      // continuation page is framed like the first. It runs down the same x as
      // the item table and the closing grid, so the three share one continuous
      // line rather than stacking parallel rules.
      doc.setDrawColor(...RULE_INK);
      doc.setLineWidth(RULE_BOLD);
      doc.rect(L, FRAME_TOP, R - L, CLOSE_END - FRAME_TOP);
      doc.setFontSize(7); doc.setTextColor(180);
      doc.text(`Page ${i - copyFirstPage + 1} of ${copyPageCount}`, L, doc.internal.pageSize.height - 8);
    }
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

  const qrSource = p?.qr_base64 || await generateQRDataUrl(invoiceVerifyUrl(inv.type, inv.id), accentHex);
  const qrCaption = p?.qr_base64 ? 'Scan QR' : 'Scan to verify invoice';
  const contactLine = [p?.email, p?.phone].filter(Boolean).join(' &middot; ');
  const bankLines = bankDetailLines(p);

  // Which regime this invoice carries decides the columns, exactly as it does
  // for the PDF, using the same invoice-level predicate so the two renderings
  // of one invoice can never show different tax columns.
  const isIgstInvoice = (+inv.igst || 0) > 0;
  const amt = v => (+v > 0 ? formatNum(v) : '-');

  // The GST columns are generated, not fixed: the regime that does not apply
  // contributes no cells at all. Nothing here recomputes tax - the GST rate,
  // the per-line CGST and SGST and the line total are printed as stored.
  const rowHtml = (row, i) => {
    const lead = `<tr>
      <td class="c">${i + 1}</td>
      <td class="desc"><b>${escHtml(row.product_name)}</b></td>
      <td class="c">${escHtml(row.hsn_code) || '-'}</td>
      <td class="r">${formatNum(row.quantity)}</td>
      <td class="r">${formatNum(row.rate)}</td>
      <td class="r">${(+row.gst_percentage || 0)}%</td>`;
    const tax = isIgstInvoice
      ? ''
      : `<td class="r">${amt(row.cgst)}</td><td class="r">${amt(row.sgst)}</td>`;
    return `${lead}${tax}
      <td class="r"><b>${formatNum(row.total_amount)}</b></td>
    </tr>`;
  };

  // A pre-line-item invoice has no rows of its own; it prints as the one
  // supply it is, exactly as it did before.
  const printItemRowsHtml = inv.items
    ? inv.items.map(rowHtml).join('')
    : rowHtml({
        product_name: 'Taxable Supply', hsn_code: '', quantity: 1,
        rate: inv.taxable_amount,
        gst_percentage: inv.gst_percentage, cgst: inv.cgst, sgst: inv.sgst,
        total_amount: inv.total_amount
      }, 0);

  const roundOffRowHtml = Math.abs(inv.round_off) >= 0.005
    ? `<tr><td>Round Off</td><td class="r">${(inv.round_off >= 0 ? '+' : '') + formatNum(inv.round_off)}</td></tr>`
    : '';

  // Composed by invoicePartyLines() so the PDF says the same thing — see
  // the note there. Escaped here because that helper returns plain text.
  const parties = invoicePartyLines(inv);
  const billLines = parties.bill.map(escHtml);
  const shipLines = parties.ship.map(escHtml)
    .concat(parties.sameAddress ? ['<i>Same as billing address</i>'] : []);

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
      ${isIgstInvoice
        ? `<col style="width:4%"><col style="width:40%"><col style="width:10%">
           <col style="width:8%"><col style="width:12%"><col style="width:10%">
           <col style="width:16%">`
        : `<col style="width:4%"><col style="width:28%"><col style="width:9%">
           <col style="width:7%"><col style="width:11%"><col style="width:8%">
           <col style="width:11%"><col style="width:11%"><col style="width:11%">`}
    </colgroup>
    <thead><tr>
      <th>#</th><th>Product Name</th><th>HSN</th><th>Qty</th><th>Rate</th>
      ${isIgstInvoice
        ? `<th>IGST %</th>`
        : `<th>GST %</th><th>CGST</th><th>SGST</th>`}
      <th>Amount</th>
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
