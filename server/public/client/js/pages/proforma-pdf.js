// =============================================
// Proforma Invoice PDF
// =============================================
// A sibling of invoice-pdf.js, the same way sales-return-pdf.js is, rather
// than a mode flag inside buildInvoicePDFDoc(). Two reasons, and both matter:
// the tax invoice's three-copy document is a legal artefact that must not
// move because a quotation needed a different heading, and a proforma is a
// genuinely different document - one copy, no copy labels, no verification
// QR, because there is nothing yet to verify.
//
// It reuses the shared pieces deliberately: invoicePartyLines() for the
// BILL TO / SHIP TO blocks and the item figures the grid already computed,
// so a quotation shows the customer exactly what the invoice will.
// ── The item table's columns ──────────────────────────
//
// One descriptor per column, carrying its heading, its width, its alignment
// AND the value it prints. Three things that have to agree about a column
// and used to live in three places: a weights array, a head array and the
// row builder. Adding Unit meant editing all three in step, and any one of
// them left behind puts every figure in the wrong column - so they are one
// list now, and the heading cannot drift from the value underneath it.
//
// UNIT is always shown. A quantity with no unit is not something a customer
// can check a quotation against, and proforma_invoice_items has carried
// `unit` since the table existed - the column was simply never printed.
//
// DISCOUNT is shown only when at least one line actually carries one. A
// column of dashes down a quotation that gave no discount is noise, and the
// room landscape A4 has is worth spending on the product name instead.
const PROFORMA_ITEM_COLUMNS = [
  { head: '#',            w: 9,  align: 'center', val: (it, i) => String(i + 1) },
  // The only column that wraps, so it takes the slack the others leave.
  { head: 'Product Name', w: 88, align: 'left', bold: true,
    val: (it) => it.product_name || '' },
  { head: 'HSN',          w: 22, align: 'center', val: (it) => it.hsn_code || '' },
  { head: 'Qty',          w: 16, align: 'right',  val: (it) => formatNum(it.quantity) },
  // Printed as stored and never defaulted here: a quotation saved without a
  // unit shows that it has none rather than claiming PCS on the company's
  // behalf. The Invoice grid's mandatory-unit rule is deliberately NOT
  // applied to quotations (itemsUnitMustBeConfirmed() in invoice-items.js),
  // so blank is a state this column has to be able to print.
  { head: 'Unit',         w: 16, align: 'center', val: (it) => it.unit || '-' },
  { head: 'Rate',         w: 24, align: 'right',  val: (it) => formatNum(it.rate) },
  { head: 'Disc %',       w: 17, align: 'right', optional: true,
    val: (it) => (+it.discount_percentage || 0) ? formatNum(it.discount_percentage) + '%' : '-' },
  { head: 'GST%',         w: 16, align: 'right',
    val: (it) => (+it.gst_percentage || 0) + '%' },
  { head: 'CGST',         w: 22, align: 'right',  val: (it) => +it.cgst ? formatNum(it.cgst) : '-' },
  { head: 'SGST',         w: 22, align: 'right',  val: (it) => +it.sgst ? formatNum(it.sgst) : '-' },
  { head: 'IGST',         w: 22, align: 'right',  val: (it) => +it.igst ? formatNum(it.igst) : '-' },
  { head: 'Total',        w: 24, align: 'right', bold: true,
    val: (it) => formatNum(it.total_amount) }
];

// Does any line on this quotation give a discount? Decides one column, and
// is asked of the items being printed rather than of a setting.
function proformaHasDiscount(items) {
  return (items || []).some(it => (+((it || {}).discount_percentage) || 0) > 0);
}

function proformaItemColumns(showDiscount) {
  return PROFORMA_ITEM_COLUMNS.filter(c => !c.optional || showDiscount);
}

function PROFORMA_ITEM_COLUMN_STYLES(tableWidth, showDiscount) {
  const cols = proformaItemColumns(showDiscount);
  const total = cols.reduce((a, c) => a + c.w, 0);
  const styles = {};
  cols.forEach((c, i) => {
    styles[i] = { cellWidth: tableWidth * c.w / total, halign: c.align };
    if (c.bold) styles[i].fontStyle = 'bold';
  });
  return styles;
}

// How long the offer actually runs, read back from the two dates the row
// already stores rather than from the 30-day default. A quotation edited to
// 45 days has to say 45, and one whose Valid Until was typed by hand still
// gets a truthful figure. Nothing is written back - this is display only.
function proformaValidityDays(dateISO, untilISO) {
  if (!dateISO || !untilISO) return null;
  const from = new Date(String(dateISO).slice(0, 10) + 'T00:00:00');
  const to = new Date(String(untilISO).slice(0, 10) + 'T00:00:00');
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return null;
  const days = Math.round((to - from) / 86400000);
  return days > 0 ? days : null;
}

// Shapes a proforma row + its items into the object the shared renderers
// expect, so invoicePartyLines() and the money formatting need no proforma
// special-casing.
function proformaToRenderable(row, items) {
  return {
    type: row.gst_number ? 'b2b' : 'b2c',
    id: row.id,
    // Drawn under the configured format, exactly as the list draws it, so a
    // printed quotation and the list never disagree about its number. The
    // stored value is untouched; this is the rendering only.
    invoice_number: typeof proformaDisplayNumber === 'function'
      ? proformaDisplayNumber(row.document_number)
      : (row.document_number || ''),
    invoice_date: row.document_date,
    valid_until: row.valid_until || null,
    customer_name: row.customer_name || '',
    gstin: row.gst_number || '',
    phone: row.phone || '',
    address: row.address || '',
    state: row.state || '',
    shipping_address: row.shipping_address || '',
    shipping_state: row.shipping_state || '',
    shipping_district: row.shipping_district || '',
    supply_type: row.supply_type || 'intrastate',
    gst_category: row.gst_category || 'regular',
    taxable_amount: +row.taxable_amount || 0,
    gst_percentage: +row.gst_percentage || 0,
    gst_amount: +row.gst_amount || 0,
    igst: +row.igst || 0,
    cgst: +row.cgst || 0,
    sgst: +row.sgst || 0,
    // The quoted delivery charge and its derived tax, carried exactly as the
    // tax invoice carries them (invoice-pdf.js): NULL stays null, never 0,
    // so a proforma quoted without delivery prints exactly what it always did.
    transport_charge: (row.transport_charge === null || row.transport_charge === undefined)
      ? null : +row.transport_charge,
    transport_gst_amount: (row.transport_gst_amount === null || row.transport_gst_amount === undefined)
      ? null : +row.transport_gst_amount,
    // What the quotation asks for up front. NULL - every proforma older than
    // the column, and every one quoted without an advance - prints no payment
    // summary at all, so those documents are byte for byte what they were.
    advance_amount: (row.advance_amount === null || row.advance_amount === undefined)
      ? null : +row.advance_amount,
    // Round-off is DERIVED here, not stored - proforma_invoices has no
    // round_off column, exactly as the tax invoice has none. The taxable
    // value and every tax column above are passed through untouched, so
    // nothing that feeds a return or a converted invoice moves.
    //
    // A proforma saved now stores the tax invoice's own Grand Total:
    // taxable + GST + cess, already rounded to the rupee (saveProforma takes
    // it from computeInvoiceRollups). So, as the tax invoice PDF does, the
    // round-off is what that total added to the calculated amount, and the
    // cess - part of the total - gets its own line. Recognised by the rule
    // itself: its stored total IS Math.round(taxable + GST + cess).
    //
    // A proforma saved before stored the unrounded taxable + GST instead, and
    // prints exactly as it always has: rounded here, for the page only.
    // That rounding exists because numberToWordsINR() already rounds
    // (Math.round(Math.abs(n))), so a total of 138900.16 printed as
    // "...Nine Hundred Rupees Only" beside a numeral of 138900.16 - the words
    // and the figure disagreed on the same line of the same document.
    //
    // round2() on the difference keeps binary floating point out of the
    // print: 138900 - 138900.16 is -0.15999999999417923, and -0.16 is what a
    // quotation has to show.
    //
    // The GST in that calculated amount is the IGST/CGST/SGST split - the
    // figure the invoice rollup adds up and the rows this PDF prints above.
    // A line's CGST and SGST are each rounded on their own, so together they
    // can sit a paisa away from the line's gst_amount; summing gst_amount
    // instead would print a round-off a paisa off the screen's.
    ...(() => {
      const stored = +row.total_amount || 0;
      const cess = round2((items || []).reduce((s, it) => s + (+it.cess_amount || 0), 0));
      const beforeRounding = round2((+row.taxable_amount || 0)
        + (+row.igst || 0) + (+row.cgst || 0) + (+row.sgst || 0) + cess);
      if (stored === Math.round(beforeRounding)) {
        return { round_off: round2(stored - beforeRounding), total_amount: stored, cess_amount: cess };
      }
      const calculated = stored;
      const rounded = Math.round(calculated);
      return { round_off: round2(rounded - calculated), total_amount: rounded, cess_amount: 0 };
    })(),
    notes: row.notes || '',
    terms: row.terms || '',
    status: row.status,
    items: (items || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
  };
}

async function buildProformaPDFDoc(row, items) {
  const inv = proformaToRenderable(row, items);
  const p = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const accent = hexToRgb(p?.header_color);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const pw = doc.internal.pageSize.width;
  const L = 14, R = pw - 14;

  const [logoData, sealData, signatureData] = await Promise.all([
    imageUrlToDataUrl(p?.logo_base64),
    imageUrlToDataUrl(p?.seal_base64),
    imageUrlToDataUrl(p?.signature_base64)
  ]);

  // ── Header, drawn on every page ──
  const drawHeader = () => {
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
    doc.text('PROFORMA INVOICE', R, 14, { align: 'right' });

    // No copy label. A proforma is one document - the Original/Duplicate set
    // belongs to a tax invoice and would be a false claim here.
    //
    // "NOT A TAX INVOICE" is the whole difference between this document and a
    // bill, and it used to be 8.5pt grey beside a 15pt title - the one line a
    // reader could miss on a page that otherwise looks exactly like an
    // invoice. Now it is an outlined badge: uppercase, boxed, on the accent,
    // and drawn on EVERY page, because a reader holding page two of a
    // quotation has to be able to tell what they are holding.
    const BADGE = 'NOT A TAX INVOICE';
    doc.setFontSize(8.5); doc.setFont('helvetica', 'bold');
    const badgeW = doc.getTextWidth(BADGE) + 5;
    const badgeH = 5.4;
    const badgeX = R - badgeW, badgeY = 17.2;
    doc.setDrawColor(...accent); doc.setLineWidth(0.4);
    doc.rect(badgeX, badgeY, badgeW, badgeH);
    doc.setTextColor(...accent);
    doc.text(BADGE, badgeX + badgeW / 2, badgeY + 3.8, { align: 'center' });

    doc.setFillColor(...accent);
    doc.rect(L, 25, R - L, 1.3, 'F');

    let y = 34;
    const PART_GAP = 6;
    const partColW = (R - L - PART_GAP * 3) / 4;
    const partX = [0, 1, 2, 3].map(i => L + i * (partColW + PART_GAP));

    doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...accent);
    doc.text('SOLD BY', partX[0], y);
    doc.text('QUOTATION DETAILS', partX[1], y);
    doc.text('BILL TO', partX[2], y);
    doc.text('SHIP TO', partX[3], y);
    doc.setDrawColor(...accent); doc.setLineWidth(0.3);
    doc.line(L, y + 1.5, R, y + 1.5);

    const partTop = y + 7;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(60, 60, 60);

    const soldBy = [p?.business_name, p?.address, p?.state,
      p?.gstin ? 'GSTIN: ' + p.gstin : ''].filter(Boolean);
    const soldByWrapped = doc.splitTextToSize(soldBy.join('\n'), partColW);
    soldByWrapped.forEach((l, i) => doc.text(l, partX[0], partTop + i * 4.5));

    const validityDays = proformaValidityDays(inv.invoice_date, inv.valid_until);
    const meta = [
      'Proforma No: ' + (inv.invoice_number || ''),
      'Date: ' + formatDate(inv.invoice_date),
      validityDays ? 'Validity: ' + validityDays + ' Days' : '',
      inv.valid_until ? 'Valid Until: ' + formatDate(inv.valid_until) : '',
      'Place of Supply: ' + (inv.state || ''),
      'Type: ' + (inv.type === 'b2b' ? 'B2B (Registered)' : 'B2C (Unregistered)')
    ].filter(Boolean);
    const metaWrapped = doc.splitTextToSize(meta.join('\n'), partColW);
    metaWrapped.forEach((l, i) => doc.text(l, partX[1], partTop + i * 4.5));

    // The invoice's own party renderer, so BILL TO / SHIP TO read identically.
    const parties = invoicePartyLines(inv);
    doc.setFont('helvetica', 'bold');
    doc.text(doc.splitTextToSize(inv.customer_name || '', partColW), partX[2], partTop);
    doc.text(doc.splitTextToSize(inv.customer_name || '', partColW), partX[3], partTop);
    doc.setFont('helvetica', 'normal');
    const nameH = 4.5;
    const billWrapped = doc.splitTextToSize(parties.bill.join('\n'), partColW);
    billWrapped.forEach((l, i) => doc.text(l, partX[2], partTop + nameH + i * 4.5));
    const shipWrapped = doc.splitTextToSize(parties.ship.join('\n'), partColW);
    shipWrapped.forEach((l, i) => doc.text(l, partX[3], partTop + nameH + i * 4.5));
    if (parties.sameAddress) {
      doc.setFont('helvetica', 'italic'); doc.setTextColor(120, 120, 120);
      doc.text('Same as billing address', partX[3], partTop + nameH + shipWrapped.length * 4.5);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(60, 60, 60);
    }
    const partyRows = Math.max(billWrapped.length, shipWrapped.length) + 1;
    return partTop + Math.max(soldByWrapped.length, metaWrapped.length, partyRows) * 4.5 + 3;
  };

  let y = drawHeader();
  const HEADER_BOTTOM = y;

  // Discount earns its column from the lines themselves, so the same builder
  // prints an eleven-column quotation and a twelve-column one.
  const showDiscount = proformaHasDiscount(inv.items);
  const itemCols = proformaItemColumns(showDiscount);
  const rows = inv.items.map((it, i) => itemCols.map(c => c.val(it, i)));

  doc.autoTable({
    startY: y,
    head: [itemCols.map(c => c.head)],
    body: rows,
    theme: 'grid',
    headStyles: { fillColor: accent, textColor: 255, fontSize: 8.5, fontStyle: 'bold' },
    bodyStyles: { fontSize: 8.5, textColor: [40, 40, 40] },
    columnStyles: PROFORMA_ITEM_COLUMN_STYLES(R - L, showDiscount),
    margin: { left: L, right: L, top: HEADER_BOTTOM },
    styles: { cellPadding: 2.5, lineColor: [225, 225, 225] },
    showHead: 'everyPage',
    // A product row is never split down the middle by a page break: a line
    // whose name wraps to three lines moves to the next page whole, under a
    // repeated heading, rather than having its figures left behind.
    rowPageBreak: 'avoid',
    didDrawPage: (d) => { if (d.pageNumber > 1) drawHeader(); }
  });

  y = doc.lastAutoTable.finalY + 8;

  // ── Totals ──
  const boxW = 80, boxX = R - boxW;
  // The stored figures INCLUDE any quoted delivery, so the goods are recovered
  // by taking the stored transport figures back off - through the tax
  // invoice's own invoiceTransportParts() (invoice-pdf.js, which every page
  // that prints a proforma loads), never a second copy of that arithmetic.
  // With no delivery quoted it hands back the stored figures unchanged, so
  // this block prints exactly what it always has.
  const tp = invoiceTransportParts(inv);
  const totalsRows = [['Subtotal', formatNum(tp.productTaxable)]];
  // The GST base, named as the tax invoice names it. Printed only when it
  // DIFFERS from the Subtotal above - which is exactly when delivery was
  // quoted, because the charge is taxable too. On a quotation with no
  // delivery the two figures are the same number, and printing it twice
  // under two labels reads as a mistake rather than as a summary.
  if (round2(inv.taxable_amount) !== round2(tp.productTaxable)) {
    totalsRows.push(['Taxable Amount', formatNum(inv.taxable_amount)]);
  }
  if (tp.productCgst > 0) totalsRows.push(['CGST', formatNum(tp.productCgst)]);
  if (tp.productSgst > 0) totalsRows.push(['SGST', formatNum(tp.productSgst)]);
  if (tp.productIgst > 0) totalsRows.push(['IGST', formatNum(tp.productIgst)]);
  // Delivery, quoted separately from the goods and never as a product line.
  // Labelled without a rate, as the tax invoice labels it: the amount is
  // stored, the rate it came from is not this file's to assert.
  if (tp.has) {
    // What the goods alone came to, tax included - the tax invoice's own
    // invoiceMachineTotal(), so this column reads exactly as the invoice's
    // does: goods total, then the charge, then its tax, then rounding.
    totalsRows.push(['Machine / Product Total', formatNum(invoiceMachineTotal(inv, tp))]);
    totalsRows.push(['Transport Charge', formatNum(tp.charge)]);
    totalsRows.push(['Transport GST', formatNum(tp.gst)]);
  }
  // Cess, when the quoted total carries it (a proforma saved since the total
  // became the invoice's Grand Total - see proformaToRenderable). Its own line,
  // so the column adds up and the round-off below is only the rounding. Absent
  // otherwise, so everything else prints exactly as it did.
  if (inv.cess_amount > 0) totalsRows.push(['Cess', formatNum(inv.cess_amount)]);
  // Shown only when it is worth a line. Same threshold and same signed format
  // the tax invoice uses, so the two documents read alike.
  if (Math.abs(inv.round_off) >= 0.005) {
    totalsRows.push(['Round Off', (inv.round_off >= 0 ? '+' : '') + formatNum(inv.round_off)]);
  }

  // What is asked for up front and what is left, printed only when an
  // advance was actually quoted. The balance is computed here from the two
  // stored figures rather than read from a column, so it cannot disagree with
  // the Quoted Total printed directly above it.
  const advance = (inv.advance_amount === null || inv.advance_amount === undefined)
    ? null : round2(inv.advance_amount);
  const paymentRows = advance === null ? [] : [
    ['Advance Amount', formatNum(advance)],
    ['Balance Amount Due', formatNum(round2(inv.total_amount - advance))]
  ];

  // ── Everything below the item table, measured before anything is drawn ──
  //
  // This decides whether the close fits on the page the table ended on, and
  // it used to decide it with a constant: "+ 60". A constant cannot know what
  // this particular quotation has to print, and it was wrong in both
  // directions. On the document that prompted this redesign - three products,
  // a delivery charge, an advance, five bank lines, notes and terms - the
  // flat 60 reserved far MORE than the close needs, so the whole close was
  // pushed to page two and page one was left half empty under the table. The
  // opposite case is worse: a longer left column than 60mm would have been
  // drawn straight through the signature band.
  //
  // So each piece is measured, at the size it will be drawn at, and the
  // pieces are laid out in the two columns they actually occupy: the totals
  // on the right, the bank/words/notes/terms on the left. The close needs the
  // TALLER of the two, not their sum.
  const leftW = boxX - 6 - L;

  // Right column: the totals rows, then the rule and the Quoted Total under
  // them. The Quoted Total is the last thing in this column now - the advance
  // and balance moved to the left column below, so the figure the customer is
  // being quoted is what the column ends on.
  const rightH = totalsRows.length * 5.5 + 8;

  // Left column, in the order it is drawn further down. Each wrapped block is
  // measured at the font size it is printed at, because splitTextToSize
  // answers for the size that is set when it is called.
  const bankLines = bankDetailLines(p);
  doc.setFontSize(8.5);
  const notesWrapped = inv.notes ? doc.splitTextToSize('Notes: ' + inv.notes, leftW) : [];
  const docTermsWrapped = inv.terms ? doc.splitTextToSize('Terms: ' + inv.terms, leftW) : [];
  // ONE gap between the blocks in this column, used by the measurement here
  // and by the drawing below, so the two cannot disagree about it. Each block
  // used to carry its own trailing pad of 3mm on top of the ~4mm its last
  // line already left, which put about 7mm between blocks - loose enough that
  // a quotation carrying bank details, payment terms, notes and its own terms
  // spent 10mm on gaps alone and tipped onto a second page for it. 1.5mm
  // leaves about 5.5mm between blocks at 8-9pt, which is still airy. No font
  // size changed.
  const LEFT_GAP = 1.5;
  const leftH =
      (bankLines.length ? 4.5 + bankLines.length * 4 + LEFT_GAP : 0)        // bank block
    + (paymentRows.length ? 4.5 + paymentRows.length * 4.5 + LEFT_GAP : 0)  // advance/balance
    + 11                                                                    // amount in words
    + 4 + (inv.valid_until ? 4 : 0)                                         // the two notices
    + (notesWrapped.length ? LEFT_GAP + notesWrapped.length * 4 : 0)
    + (docTermsWrapped.length ? LEFT_GAP + docTermsWrapped.length * 4 : 0);

  // The signature block follows the totals DOWN the same column - sigY is
  // max(totalsBottom + 5, bandTop) below - so on the right the two stack and
  // their heights add. The left column is a different column: it spans from
  // the margin to just short of the totals box, nowhere near the stamp, so it
  // only has to clear the footer. Treating them as one column was what made
  // the first version of this guard too pessimistic: it added the stamp's
  // height to the bank details, which the stamp never sits under.
  const SEAL = 26;
  const sealReserveH = sealData ? SEAL : (signatureData ? 18 : 14);
  const signatureStackH = 13 + sealReserveH;      // gap + "For ...", stamp, label

  // ONE floor for everything drawn below the item table.
  //
  // It is the footer RULE - 10mm above the footer text - less 2mm, so nothing
  // ends up sitting on the line. Not the bottom of the page: a stamp on the
  // footer rule is the overlap this guard exists to prevent
  // (proforma-transport-charge.test.js PT21 pins it at eight item lines, the
  // shape where the close lands just low enough to touch it).
  //
  // The terms schedule further down measures against this same floor. It
  // used to have its own, 4mm lower, which was an inconsistency rather than
  // a decision: there is one footer, so there is one floor.
  const CONTENT_FLOOR = doc.internal.pageSize.height - 12 - 10 - 2;
  const closeH = Math.max(rightH + signatureStackH, leftH);
  if (y + closeH > CONTENT_FLOOR) {
    doc.addPage();
    y = drawHeader();
  }

  doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(60, 60, 60);
  totalsRows.forEach((r, i) => {
    doc.text(r[0], boxX, y + i * 5.5);
    doc.text('Rs.' + r[1], R, y + i * 5.5, { align: 'right' });
  });
  const ruleY = y + totalsRows.length * 5.5 + 1;
  doc.setDrawColor(60, 60, 60);
  doc.line(boxX, ruleY, R, ruleY);
  doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.setTextColor(...accent);
  doc.text('Quoted Total', boxX, ruleY + 7);
  doc.text('Rs.' + formatNum(inv.total_amount), R, ruleY + 7, { align: 'right' });

  // The right column ends on the Quoted Total. The advance and balance are
  // drawn in the left column further down - see the payment-terms block
  // there - so the signature band follows the Quoted Total as it always did.
  let totalsBottom = ruleY + 7;

  // ── Left column: bank details, words, validity, notes, terms ──
  let ly = y;

  // The same block the tax invoice prints, from the same source -
  // bankDetailLines() in invoice-pdf.js. A quotation has to say where the
  // money goes if it is accepted, and it must name the same account; a second
  // copy of this list here would be one that could drift from the invoice's.
  // Set in the left column level with the totals, exactly as the invoice does.
  // bankLines was measured above, with the rest of this column.
  if (bankLines.length) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...accent);
    doc.text('Bank Details for Payment', L, ly);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(60, 60, 60);
    bankLines.forEach((l, i) => doc.text(l, L, ly + 4.5 + i * 4, { maxWidth: boxX - 6 - L }));
    ly += 4.5 + bankLines.length * 4 + LEFT_GAP;
  }

  // ── What is asked for up front, and what is left ──
  //
  // These sit here, under the account the money goes to, rather than under
  // the Quoted Total where they used to. Two reasons, and the first is the
  // document: "pay this much now, into this account, and this much remains"
  // is one instruction, and it reads as one when it is in one column. The
  // second is the page. The right column has the stamp stacked beneath it, so
  // every row added there pushed the signature down and took a one-page
  // quotation onto a second page; the left column has the whole height of the
  // page under it and nothing stacked below.
  //
  // Printed only when an advance was actually quoted. A quotation without one
  // prints no payment summary at all, exactly as before.
  //
  // The balance is bold because it is the figure the customer acts on. The
  // advance is a TERM of the quotation, not a receipt, and is not described
  // as one - no money has been received and none is recorded here.
  if (paymentRows.length) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...accent);
    doc.text('Payment Terms', L, ly);
    const payW = Math.min(78, leftW);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(60, 60, 60);
    doc.text(paymentRows[0][0], L, ly + 5);
    doc.text('Rs.' + paymentRows[0][1], L + payW, ly + 5, { align: 'right' });
    doc.setFont('helvetica', 'bold'); doc.setTextColor(30, 30, 30);
    doc.text(paymentRows[1][0], L, ly + 9.5);
    doc.text('Rs.' + paymentRows[1][1], L + payW, ly + 9.5, { align: 'right' });
    ly += 4.5 + paymentRows.length * 4.5 + LEFT_GAP;
  }

  doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(30, 30, 30);
  doc.text('Amount in Words:', L, ly);
  doc.setFont('helvetica', 'bold');
  doc.text(numberToWordsINR(inv.total_amount), L, ly + 5, { maxWidth: boxX - 6 - L });
  ly += 11;

  doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(110, 110, 110);
  // Said plainly on the document, because this is the whole difference
  // between a quotation and a bill.
  doc.text('* This is a Proforma Invoice (quotation). It is not a Tax Invoice and no GST is payable on it.', L, ly);
  ly += 4;
  if (inv.valid_until) {
    doc.text('* Valid until ' + formatDate(inv.valid_until) + '. Prices are subject to change after this date.', L, ly);
    ly += 4;
  }

  // Both wrapped once, above, and drawn from the same arrays the page-fit
  // decision was made with - so what was measured is exactly what is printed.
  if (notesWrapped.length) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(60, 60, 60);
    doc.text(notesWrapped, L, ly + LEFT_GAP + 1.5);
    ly += LEFT_GAP + notesWrapped.length * 4;
  }
  if (docTermsWrapped.length) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(60, 60, 60);
    doc.text(docTermsWrapped, L, ly + LEFT_GAP + 1.5);
    ly += LEFT_GAP + docTermsWrapped.length * 4;
  }

  // ── Terms & Conditions: the company's standing schedule ──
  //
  // Two different things are printed, because they answer different
  // questions. inv.terms above is what THIS quotation says, typed on the form
  // for this customer. This block is the company's standing schedule -
  // Payment Term, Delivery Schedule, Taxes & Duties, Freight, Installation,
  // Shipment Date - read from the Business Profile through the tax invoice's
  // own parseTermsTable(), so a customer who reads a quotation and then its
  // invoice is not shown two different sets of terms.
  //
  // The parser decides the shape from the writing: two or more "Label: value"
  // lines become a schedule, anything else stays a paragraph. Nothing to
  // configure, and a company that writes prose sees a paragraph as before.
  const termsPairs = (typeof parseTermsTable === 'function')
    ? parseTermsTable(p?.terms_conditions) : null;
  const termsProse = (!termsPairs && p?.terms_conditions)
    ? doc.splitTextToSize(String(p.terms_conditions), leftW) : [];

  if (termsPairs || termsProse.length) {
    // Measured before anything is drawn, and the whole block moves to a new
    // page as one. A schedule split across a page boundary is the failure
    // this guard exists for: half the payment terms on page one and the rest
    // under the next page's header reads as two different documents.
    doc.setFontSize(7);
    const termsH = termsPairs
      ? 6 + Math.ceil(termsPairs.length / 2) * 4.6 + 3
      : 5 + termsProse.length * 3.6 + 3;
    if (ly + termsH > CONTENT_FLOOR) {
      doc.addPage();
      ly = drawHeader();
    }

    if (termsPairs) {
      // Two terms to a row, so a six-term schedule is three rows rather than
      // six - the shape the company's own sheet uses, and the shape the tax
      // invoice prints.
      const rows = [];
      for (let i = 0; i < termsPairs.length; i += 2) {
        const a = termsPairs[i], b = termsPairs[i + 1];
        rows.push([a[0], a[1], b ? b[0] : '', b ? b[1] : '']);
      }
      // Styled to the company's terms sheet, exactly as invoice-pdf.js styles
      // it: yellow ground, black rules, bold labels. That sheet is the one the
      // customer already knows, and restyling it to this document's green
      // would quietly redesign something the company treats as fixed.
      const TERMS_YELLOW = [255, 255, 153];
      doc.autoTable({
        startY: ly + 2,
        head: [[{ content: 'Terms & condition', colSpan: 4 }]],
        body: rows,
        theme: 'grid',
        margin: { left: L, right: pw - (L + leftW) },
        styles: { fontSize: 7, cellPadding: 1, lineColor: [0, 0, 0], lineWidth: 0.1,
          textColor: [0, 0, 0], fillColor: TERMS_YELLOW },
        headStyles: { fillColor: TERMS_YELLOW, textColor: [0, 0, 0],
          fontStyle: 'bold', halign: 'center', fontSize: 7.5 },
        columnStyles: {
          0: { fontStyle: 'bold', halign: 'left',  cellWidth: leftW * 0.25 },
          1: { fontStyle: 'normal', halign: 'left', cellWidth: leftW * 0.25 },
          2: { fontStyle: 'bold', halign: 'left',  cellWidth: leftW * 0.25 },
          3: { fontStyle: 'normal', halign: 'left', cellWidth: leftW * 0.25 }
        },
        // The same underline the invoice draws under this title, because
        // autoTable has no underline of its own.
        didDrawCell: (data) => {
          if (data.section !== 'head') return;
          const w = doc.getTextWidth('Terms & condition');
          const cx = data.cell.x + data.cell.width / 2;
          const ty = data.cell.y + data.cell.height - 1.6;
          doc.setDrawColor(0, 0, 0); doc.setLineWidth(0.3);
          doc.line(cx - w / 2, ty, cx + w / 2, ty);
        }
      });
      ly = doc.lastAutoTable.finalY + 3;
    } else {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...accent);
      doc.text('Terms & Conditions', L, ly + 3);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(90, 90, 90);
      doc.text(termsProse, L, ly + 7.5);
      ly += 7.5 + termsProse.length * 3.6;
    }
  }

  // ── Signature (no QR: there is no invoice to verify yet) ──
  // SEAL and sealReserveH come from the measurement block above: the band's
  // height is part of deciding whether the close fits on this page.
  const bandTop = doc.internal.pageSize.height - 12 - 18 - (6 + sealReserveH + 5);
  // Below whatever the right column actually printed. With no advance
  // quoted totalsBottom IS ruleY + 7, so this is the ruleY + 12 it has
  // always been and that document's layout does not move by a hair.
  let sigY = Math.max(totalsBottom + 5, bandTop);

  // The same stamp block the tax invoice draws, measured the same way: every
  // size below is of the INK inside each file, never of the file's edges - see
  // inkBoundsOf() in invoice-pdf.js. Drawing the PNG at SEAL square instead
  // sized the transparent margin rather than the mark, so the stamp came out
  // small and faint; and the signature was drawn only where no seal existed,
  // so a business with both never saw it at all.
  const [sealInk, sigInk] = await Promise.all([inkBoundsOf(sealData), inkBoundsOf(signatureData)]);
  const sealCx = R - 5 - SEAL / 2;       // centre, held clear of the margin
  const sealTop = sigY + 3;              // unchanged: the band does not move

  // Fit the stamp's longer side to SEAL, so a mark wider than it is tall does
  // not overshoot the space reserved for it.
  const sbk = sealInk || { w: 1, h: 1, imgW: 1, imgH: 1 };
  const sealWantW = SEAL * sbk.w / Math.max(sbk.w, sbk.h * (sbk.imgH / sbk.imgW));
  const seal = sealData ? placeInk(sealInk, sealWantW, sealCx, sealTop)
                        : { inkW: SEAL, inkH: sealReserveH };

  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(30, 30, 30);
  doc.text('For ' + (p?.business_name || ''), sealCx, sealTop - 1.8, { align: 'center' });

  if (sealData) {
    try { doc.addImage(sealData, 'PNG', seal.x, seal.y, seal.w, seal.h); } catch {}
  }
  if (signatureData) {
    // Centred over the stamp's visible ink, and capped so a tall scan cannot
    // spill out of it - the same rule the tax invoice uses.
    const cx = sealCx, cy = sealTop + seal.inkH * 0.50;
    let sig = placeInk(sigInk, seal.inkW * 0.62, cx, 0);
    const maxH = seal.inkH * 0.5;
    if (sig.inkH > maxH) {
      const k = maxH / sig.inkH;
      sig = placeInk(sigInk, seal.inkW * 0.62 * k, cx, 0);
    }
    // placeInk aligns the ink's top; the block wants its centre.
    const sgk = sigInk || { y: 0, h: 1 };
    sig.y = cy - sgk.y * sig.h - sig.inkH / 2;
    try { doc.addImage(signatureData, 'PNG', sig.x, sig.y, sig.w, sig.h); } catch {}
  }

  const authY = sealTop + seal.inkH + 5;
  doc.setDrawColor(170, 170, 170);
  doc.line(sealCx - 22, authY - 3.5, sealCx + 22, authY - 3.5);
  doc.setFontSize(8); doc.setTextColor(120, 120, 120);
  doc.text('Authorized Signatory', sealCx, authY, { align: 'center' });

  // ── Footer + page numbers ──
  const PAGE_BOTTOM = doc.internal.pageSize.height - 12;
  doc.setDrawColor(178, 223, 219);
  doc.line(L, PAGE_BOTTOM - 10, R, PAGE_BOTTOM - 10);
  doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(140, 140, 140);
  doc.text('This is a computer-generated proforma invoice.', pw / 2, PAGE_BOTTOM - 5, { align: 'center' });
  // How to reach the company, from the same three profile fields and in the
  // same order the tax invoice footer uses. A quotation is the document a
  // customer replies to, so the reply address belongs on it.
  const contactLine = [p?.email, p?.phone, p?.website].filter(Boolean).join('  |  ');
  if (contactLine) {
    doc.setFontSize(7); doc.setTextColor(150, 150, 150);
    doc.text(contactLine, pw / 2, PAGE_BOTTOM - 1, { align: 'center' });
  }

  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(7); doc.setTextColor(180);
    doc.text(`Page ${i} of ${pageCount}`, L, doc.internal.pageSize.height - 8);
  }
  return doc;
}

async function downloadProformaDocument(row, items) {
  // A PDF can be asked for from a page that has not drawn the list yet, so
  // the format is made sure of here too rather than assumed.
  if (typeof ensureProformaDisplayFormat === 'function') {
    try { await ensureProformaDisplayFormat(); } catch { /* draws stored values */ }
  }
  const doc = await buildProformaPDFDoc(row, items);
  // The filename carries the number as shown, for the same reason.
  const shownNumber = typeof proformaDisplayNumber === 'function'
    ? proformaDisplayNumber(row.document_number)
    : (row.document_number || '');
  doc.save(`Proforma_${shownNumber || row.id.slice(0, 8)}.pdf`);
  if (typeof showToast === 'function') showToast('Proforma PDF downloaded!', 'success');
}

// ═══ Preview, print, and sharing ══════════════════════════════════════
//
// A sibling of invoice-pdf.js's buildInvoiceHTML() for the same reason the A4
// renderer is a sibling: a quotation is a different document. What it is NOT
// is a second opinion about the figures. The item columns below are the SAME
// descriptors the PDF prints (proformaItemColumns), the totals come from the
// same invoiceTransportParts(), the parties from the same invoicePartyLines(),
// the standing terms from the same parseTermsTable(). The screen, the printer
// and the downloaded file therefore cannot disagree about a number, a heading
// or a column.
//
// No verification QR and no Original/Duplicate labels: there is nothing to
// verify yet, and a quotation is one document.
async function buildProformaHTML(row, items, opts) {
  opts = opts || {};
  if (typeof ensureProformaDisplayFormat === 'function') {
    try { await ensureProformaDisplayFormat(); } catch { /* draws stored values */ }
  }
  const inv = proformaToRenderable(row, items);
  const p = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const accentHex = p?.header_color || '#00796b';
  const MONEY = 'Rs.';

  const showDiscount = proformaHasDiscount(inv.items);
  const cols = proformaItemColumns(showDiscount);
  // Each column takes the same share of the table the PDF gives it, so the
  // two renderings have the same proportions as well as the same headings.
  const colTotal = cols.reduce((a, c) => a + c.w, 0);
  const colGroup = cols.map(c => `<col style="width:${(c.w / colTotal * 100).toFixed(2)}%">`).join('');
  const headHtml = cols.map(c => `<th>${escHtml(c.head)}</th>`).join('');
  const clsOf = (c) => c.align === 'right' ? 'r' : (c.align === 'center' ? 'c' : 'desc');
  const rowsHtml = inv.items.map((it, i) =>
    '<tr>' + cols.map(c => {
      const v = escHtml(String(c.val(it, i)));
      return `<td class="${clsOf(c)}">${c.bold ? '<b>' + v + '</b>' : v}</td>`;
    }).join('') + '</tr>').join('');

  // The same totals block the PDF builds, in the same order, from the same
  // helper and under the same conditions.
  const tp = invoiceTransportParts(inv);
  const totRow = (label, value, cls) =>
    `<tr${cls ? ` class="${cls}"` : ''}><td>${label}</td><td>${MONEY}${value}</td></tr>`;
  let totalsHtml = totRow('Subtotal', formatNum(tp.productTaxable));
  if (round2(inv.taxable_amount) !== round2(tp.productTaxable)) {
    totalsHtml += totRow('Taxable Amount', formatNum(inv.taxable_amount));
  }
  if (tp.productCgst > 0) totalsHtml += totRow('CGST', formatNum(tp.productCgst));
  if (tp.productSgst > 0) totalsHtml += totRow('SGST', formatNum(tp.productSgst));
  if (tp.productIgst > 0) totalsHtml += totRow('IGST', formatNum(tp.productIgst));
  if (tp.has) {
    totalsHtml += totRow('Machine / Product Total', formatNum(invoiceMachineTotal(inv, tp)));
    totalsHtml += totRow('Transport Charge', formatNum(tp.charge));
    totalsHtml += totRow('Transport GST', formatNum(tp.gst));
  }
  if (inv.cess_amount > 0) totalsHtml += totRow('Cess', formatNum(inv.cess_amount));
  if (Math.abs(inv.round_off) >= 0.005) {
    totalsHtml += totRow('Round Off', (inv.round_off >= 0 ? '+' : '') + formatNum(inv.round_off));
  }
  totalsHtml += totRow('Quoted Total', formatNum(inv.total_amount), 'grand');

  // Advance and balance, in the left column exactly where the PDF puts them.
  const advance = (inv.advance_amount === null || inv.advance_amount === undefined)
    ? null : round2(inv.advance_amount);
  const payHtml = advance === null ? '' : `
      <h3>Payment Terms</h3>
      <p class="kv"><span>Advance Amount</span><span>${MONEY}${formatNum(advance)}</span></p>
      <p class="kv"><span>Balance Amount Due</span><b>${MONEY}${formatNum(round2(inv.total_amount - advance))}</b></p>`;

  const parties = invoicePartyLines(inv);
  const billLines = parties.bill.map(escHtml);
  const shipLines = parties.ship.map(escHtml)
    .concat(parties.sameAddress ? ['<i>Same as billing address</i>'] : []);
  const sellerLines = [escHtml(p?.address), escHtml(p?.state),
    p?.gstin ? 'GSTIN: ' + escHtml(p.gstin) : ''].filter(Boolean);
  const bankLines = bankDetailLines(p);
  const contactLine = [p?.email, p?.phone, p?.website].filter(Boolean).map(escHtml).join(' &middot; ');

  // The company's standing schedule, through the tax invoice's own parser.
  const termsPairs = (typeof parseTermsTable === 'function')
    ? parseTermsTable(p?.terms_conditions) : null;
  let termsRowsHtml = '';
  if (termsPairs) {
    for (let i = 0; i < termsPairs.length; i += 2) {
      const a = termsPairs[i], b = termsPairs[i + 1];
      termsRowsHtml += `<tr><td class="k">${escHtml(a[0])}</td><td>${escHtml(a[1])}</td>`
        + `<td class="k">${b ? escHtml(b[0]) : ''}</td><td>${b ? escHtml(b[1]) : ''}</td></tr>`;
    }
  }
  const termsHtml = termsPairs
    ? `<table class="tc"><tr><th colspan="4">Terms &amp; condition</th></tr>${termsRowsHtml}</table>`
    : (p?.terms_conditions
        ? `<div class="tc-title">Terms &amp; Conditions</div><div class="tc-prose">${escHtml(p.terms_conditions)}</div>`
        : '');

  const validityDays = proformaValidityDays(inv.invoice_date, inv.valid_until);
  const hasSeal = !!p?.seal_base64;
  const hasSign = !!p?.signature_base64;
  const statusLabel = String(inv.status || '').replace(/^./, c => c.toUpperCase());
  const autoPrintTag = opts.autoPrint
    ? '<' + 'script>window.onload = function(){ window.print(); };<' + '/script>'
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Proforma ${escHtml(inv.invoice_number)}</title>
<style>
  /* A4 landscape, the PDF's own orientation, so the preview, the print and
     the downloaded file are the same shape as well as the same data. */
  @page { size: A4 landscape; margin: 10mm 10mm 8mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 9.5px; color: #1a1a1a;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { width: 100%; max-width: 277mm; margin: 0 auto; }

  .hdr { display: flex; justify-content: space-between; align-items: flex-start;
         border-bottom: 2.5px solid ${accentHex}; padding-bottom: 8px; }
  .hdr .who { display: flex; gap: 10px; align-items: flex-start; }
  .hdr .logo { max-height: 56px; max-width: 90px; object-fit: contain; }
  .hdr .name { font-size: 18px; font-weight: 800; color: #141414; line-height: 1.15; }
  .hdr .site { font-size: 9px; color: #777; margin-top: 3px; }
  .hdr .right { text-align: right; white-space: nowrap; padding-left: 12px; }
  .hdr .title { font-size: 19px; font-weight: 800; color: ${accentHex}; letter-spacing: 0.5px; }
  /* The whole difference between this document and a bill, so it is a badge
     rather than a footnote - the same decision the PDF's header makes. */
  .hdr .badge { display: inline-block; margin-top: 4px; padding: 2px 7px;
       border: 1.5px solid ${accentHex}; color: ${accentHex};
       font-size: 9.5px; font-weight: 800; letter-spacing: 0.7px; border-radius: 2px; }

  .cols { display: flex; gap: 10px; margin-top: 9px; }
  .cols > * { flex: 1 1 0; min-width: 0; }
  .box { border: 1px solid #cfcfcf; border-radius: 3px; padding: 6px 8px; }
  h3 { margin: 0 0 4px; font-size: 8.5px; letter-spacing: 0.6px; text-transform: uppercase;
       color: #fff; background: ${accentHex}; padding: 3px 6px; border-radius: 2px; display: block; }
  .box p, .strip p { margin: 1.5px 0; font-size: 9px; line-height: 1.4; word-wrap: break-word; }
  .strip { padding: 0 2px; }
  .kv { display: flex; justify-content: space-between; gap: 8px; }
  .kv span:first-child { color: #555; }

  table.items { width: 100%; border-collapse: collapse; margin-top: 9px;
                table-layout: fixed; font-size: 8.2px; }
  table.items th { background: ${accentHex}; color: #fff; padding: 5px 3px;
                   border: 1px solid ${accentHex}; font-weight: 700;
                   text-align: center; font-size: 7.8px; }
  table.items td { padding: 4px 3px; border: 1px solid #d8d8d8; vertical-align: top; }
  table.items td.desc { word-wrap: break-word; }
  .r { text-align: right; } .c { text-align: center; }
  /* Repeat the heading on every printed page, and never split a product row. */
  table.items thead { display: table-header-group; }
  table.items tr { page-break-inside: avoid; }

  .totrow { display: flex; gap: 12px; margin-top: 9px; align-items: flex-start; }
  .totrow .left { flex: 1 1 0; min-width: 0; }
  .totrow .right { flex: 0 0 38%; }
  .words { font-size: 9px; margin-top: 6px; }
  .words b { display: block; margin-top: 2px; }
  .notice { margin-top: 6px; font-size: 8px; color: #666; font-style: italic; line-height: 1.45; }
  table.tot { width: 100%; border-collapse: collapse; font-size: 9px; }
  table.tot td { padding: 3px 6px; border: none; }
  table.tot td:last-child { text-align: right; }
  table.tot tr.grand td { border-top: 2px solid ${accentHex}; font-weight: 800;
      font-size: 12.5px; color: ${accentHex}; padding-top: 6px; }

  /* The company's own terms sheet: yellow ground, black rules, exactly as the
     PDF draws it. Deliberately not restyled to this document's green - that
     sheet is one the company treats as fixed. */
  table.tc { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 7.5px;
             page-break-inside: avoid; }
  table.tc th { background: #ffff99; color: #000; border: 1px solid #000; padding: 3px;
                font-weight: 700; text-align: center; text-decoration: underline; }
  table.tc td { background: #ffff99; color: #000; border: 1px solid #000; padding: 2px 4px; }
  table.tc td.k { font-weight: 700; width: 25%; }
  .tc-title { font-size: 8px; font-weight: 700; color: ${accentHex}; margin-top: 8px; }
  .tc-prose { font-size: 7.8px; color: #666; white-space: pre-line; margin: 2px 0 5px; }

  .signrow { display: flex; justify-content: flex-end; margin-top: 10px; page-break-inside: avoid; }
  .signblock { text-align: center; }
  .signblock .for { font-size: 9.5px; font-weight: 700; margin-bottom: 2px; }
  .stamp { position: relative; width: 104px; height: 104px; margin: 2px auto 0; }
  .stamp .seal { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .stamp .sig { position: absolute; left: 50%; top: 52%; transform: translate(-50%, -50%);
                max-width: 74%; max-height: 46%; object-fit: contain; }
  .stamp.no-seal .sig { position: static; transform: none; display: block;
                        margin: 26px auto 0; max-width: 92%; max-height: 60%; }
  .stamp.empty { height: 70px; }
  .signblock .auth { font-size: 9px; color: #444; margin-top: 3px;
                     border-top: 1px solid #bbb; padding-top: 3px; min-width: 118px; }

  .foot { margin-top: 12px; border-top: 1px solid ${accentHex}; padding-top: 7px;
          text-align: center; page-break-inside: avoid; }
  .foot .gen { font-size: 8px; color: #777; }
  .foot .contact { font-size: 8px; color: #777; margin-top: 2px; }

  /* The identity belongs on every PRINTED page, not only the one carrying
     the header - a reader holding page two has to be able to tell what they
     are holding, which is the same reason the PDF draws its badge on every
     page. A fixed element repeats on each printed page, which is how a
     running header is done without rebuilding the layout as a table. It is
     hidden on screen, where the header badge is already in view. */
  .pagemark { display: none; }
  @media print {
    .pagemark { display: block; position: fixed; top: 1mm; right: 0;
                font-size: 8px; font-weight: 800; letter-spacing: 0.6px;
                color: ${accentHex}; }
  }
</style></head>
<body>
  <div class="pagemark">NOT A TAX INVOICE</div>
  <div class="sheet">

  <div class="hdr">
    <div class="who">
      ${p?.logo_base64 ? `<img class="logo" src="${p.logo_base64}" alt="">` : ''}
      <div>
        <div class="name">${escHtml(p?.business_name) || 'Your Business Name'}</div>
        ${p?.website ? `<div class="site">${escHtml(p.website)}</div>` : ''}
      </div>
    </div>
    <div class="right">
      <div class="title">PROFORMA INVOICE</div>
      <div class="badge">NOT A TAX INVOICE</div>
    </div>
  </div>

  <div class="cols">
    <div class="strip">
      <h3>Sold By</h3>
      <p><b>${escHtml(p?.business_name)}</b></p>
      ${sellerLines.map(l => `<p>${l}</p>`).join('')}
    </div>
    <div class="strip">
      <h3>Quotation Details</h3>
      <p class="kv"><span>Proforma No</span><b>${escHtml(inv.invoice_number)}</b></p>
      <p class="kv"><span>Date</span><b>${formatDate(inv.invoice_date)}</b></p>
      ${validityDays ? `<p class="kv"><span>Validity</span><b>${validityDays} Days</b></p>` : ''}
      ${inv.valid_until ? `<p class="kv"><span>Valid Until</span><b>${formatDate(inv.valid_until)}</b></p>` : ''}
      <p class="kv"><span>Place of Supply</span><b>${escHtml(inv.state) || '-'}</b></p>
      <p class="kv"><span>Type</span><b>${inv.type === 'b2b' ? 'B2B (Registered)' : 'B2C (Unregistered)'}</b></p>
      ${statusLabel ? `<p class="kv"><span>Status</span><b>${escHtml(statusLabel)}</b></p>` : ''}
    </div>
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
    <colgroup>${colGroup}</colgroup>
    <thead><tr>${headHtml}</tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>

  <div class="totrow">
    <div class="left">
      ${bankLines.length ? `<h3>Bank Details for Payment</h3>
        ${bankLines.map(l => `<p style="margin:1.5px 0;font-size:9px;">${escHtml(l)}</p>`).join('')}` : ''}
      ${payHtml}
      <div class="words">Amount in Words:<b>${escHtml(numberToWordsINR(inv.total_amount))}</b></div>
      <div class="notice">
        * This is a Proforma Invoice (quotation). It is not a Tax Invoice and no GST is payable on it.
        ${inv.valid_until ? `<br>* Valid until ${formatDate(inv.valid_until)}. Prices are subject to change after this date.` : ''}
        ${inv.notes ? `<br>Notes: ${escHtml(inv.notes)}` : ''}
        ${inv.terms ? `<br>Terms: ${escHtml(inv.terms)}` : ''}
      </div>
      ${termsHtml}
    </div>
    <div class="right">
      <table class="tot">${totalsHtml}</table>
    </div>
  </div>

  <div class="signrow">
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
    <div class="gen">This is a computer-generated proforma invoice.</div>
    ${contactLine ? `<div class="contact">${contactLine}</div>` : ''}
  </div>

</div>
  ${autoPrintTag}
</body></html>`;
}

// ── Print ─────────────────────────────────────────────
// Opens the document the preview shows, with the browser's print dialog
// already up. Nothing is written and no number is reserved: printing a
// quotation is a read.
async function printProformaDocument(row, items) {
  const html = await buildProformaHTML(row, items, { autoPrint: true });
  const w = window.open('', '_blank');
  if (!w) {
    if (typeof showToast === 'function') showToast('Allow pop-ups to print this proforma.', 'error');
    return;
  }
  w.document.write(html);
  w.document.close();
  if (typeof showToast === 'function') showToast('Print dialog opened!');
}

// ── Preview ───────────────────────────────────────────
async function viewProformaDocument(row, items) {
  const html = await buildProformaHTML(row, items, { autoPrint: false });
  const w = window.open('', '_blank');
  if (!w) {
    if (typeof showToast === 'function') showToast('Allow pop-ups to preview this proforma.', 'error');
    return;
  }
  w.document.write(html);
  w.document.close();
}

// ── WhatsApp ──────────────────────────────────────────
// The mechanism the tax invoice already uses: a wa.me link with the message
// pre-filled, opened in a new tab. No API, no credentials, no customer number
// is dialled and nothing is sent - the person reads the message and presses
// send themselves.
//
// It says "Proforma Invoice" and "Quoted Total", never "Tax Invoice" or
// "Total Amount": a quotation that reads like a bill is how a customer comes
// to believe GST has been charged on it.
async function shareProformaWhatsApp(row, items) {
  if (typeof ensureProformaDisplayFormat === 'function') {
    try { await ensureProformaDisplayFormat(); } catch { /* stored values */ }
  }
  const inv = proformaToRenderable(row, items);
  const p = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const biz = p?.business_name || 'Proforma Invoice';
  const sellerAddressLine = [p?.address, p?.state].filter(Boolean).join(', ');
  const bankLines = bankDetailLines(p);
  const advance = (inv.advance_amount === null || inv.advance_amount === undefined)
    ? null : round2(inv.advance_amount);

  const msg = `*${biz} — Proforma Invoice (Quotation)*\n`
    + `_Not a Tax Invoice_\n\n`
    + `Proforma No : ${inv.invoice_number}\n`
    + `Date        : ${formatDate(inv.invoice_date)}\n`
    + (inv.valid_until ? `Valid Until : ${formatDate(inv.valid_until)}\n` : '')
    + `Customer    : ${inv.customer_name}\n`
    + (inv.gstin ? `GSTIN       : ${inv.gstin}\n` : '')
    + `\nTaxable Amt : ₹${formatNum(inv.taxable_amount)}\n`
    + (inv.igst > 0 ? `IGST        : ₹${formatNum(inv.igst)}\n`
                    : `CGST        : ₹${formatNum(inv.cgst)}\nSGST        : ₹${formatNum(inv.sgst)}\n`)
    + `*Quoted Total: ₹${formatNum(inv.total_amount)}*\n`
    + (advance === null ? ''
        : `Advance     : ₹${formatNum(advance)}\n`
          + `*Balance Due : ₹${formatNum(round2(inv.total_amount - advance))}*\n`)
    + `\n*Quoted By*\n${biz}\n`
    + (p?.gstin ? `GSTIN: ${p.gstin}\n` : '')
    + (sellerAddressLine ? `${sellerAddressLine}\n` : '')
    + (p?.phone ? `Ph: ${p.phone}\n` : '')
    + (p?.email ? `Email: ${p.email}\n` : '')
    + (p?.website ? `${p.website}\n` : '')
    + (bankLines.length ? `\n*Payment Details*\n${bankLines.join('\n')}\n` : '')
    + `\n_This is a quotation, not a Tax Invoice. No GST is payable on it._`;
  window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
}

// ── Email ─────────────────────────────────────────────
// There is no mail server in this application, so this does what the tax
// invoice's email action does: downloads the PDF and opens the person's own
// mail client with the details filled in, for them to attach and send. A
// browser will not attach a file from a mailto: link, so the download is how
// the file gets there - and the body says so rather than leaving it as a
// surprise. No message is sent from here.
async function emailProformaDocument(row, items) {
  const inv = proformaToRenderable(row, items);
  const p = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  await downloadProformaDocument(row, items);

  const subject = `Proforma Invoice ${inv.invoice_number} from ${p?.business_name || 'us'}`;
  const body = `Dear ${inv.customer_name},\n\n`
    + `Please find attached Proforma Invoice ${inv.invoice_number} dated `
    + `${formatDate(inv.invoice_date)} for ₹${formatNum(inv.total_amount)}.\n`
    + (inv.valid_until ? `This quotation is valid until ${formatDate(inv.valid_until)}.\n` : '')
    + `\nThis is a quotation and not a Tax Invoice; no GST is payable on it.\n`
    + `\n(The PDF has just been downloaded — please attach it to this email before sending.)\n`
    + `\nThank you,\n${p?.business_name || ''}`;
  const mailto = `mailto:${encodeURIComponent(row.email || '')}`
    + `?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  if (typeof showToast === 'function') {
    showToast('PDF downloaded — attach it in the email that just opened.', 'success');
  }
  window.location.href = mailto;
}
