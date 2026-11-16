// Proforma preview, print, WhatsApp and email - and the list actions that
// reach them.
//
// The rule these cases exist to protect: there is ONE proforma document. The
// preview, the printed page and the downloaded PDF are three renderings of
// it, and they must not be able to disagree about a figure, a heading or a
// column. So the HTML builder is held to using the PDF's own column
// descriptors, the PDF's own transport split and the PDF's own party and
// terms helpers - not to a copy of any of them.
//
// And the second rule: a quotation must never read as a bill. The identity is
// on every page, the money is a "Quoted Total", and nothing says Tax Invoice.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

const PDF = rd('client', 'js', 'pages', 'proforma-pdf.js');
const PDF_CODE = strip(PDF);
const LIST = rd('client', 'js', 'pages', 'proforma-list.js');
const LIST_HTML = rd('proforma-list.html');
const INV_PDF = rd('client', 'js', 'pages', 'invoice-pdf.js');

// ── Render the real HTML ────────────────────────────────
// buildProformaHTML is pure apart from the profile and the formatters, so
// these cases run it rather than reading it.
const PROFILE = {
  business_name: 'VTECH', website: 'https://www.vtechkitchen.com/',
  address: '9/83 E, 4TH STREET EXT, Ganapathy Pudur, Coimbatore, 641006',
  state: 'Tamil Nadu', gstin: '33AARFV8415B1Z4',
  email: 'sales@example.test', phone: '9944556683', header_color: '#00796b',
  bank_name: 'Bank of Baroda', bank_account_no: '35540200001588',
  bank_ifsc: 'BARB0GANAPA', bank_branch: 'Ganapathy', upi_id: 'vtech@barodampay',
  terms_conditions: [
    'Payment Term: 100% Advance Payment / As per Order',
    'Delivery Schedule: Bank Transfer Confirmation',
    'Taxes & Duties: Extra as applicable',
    'Freight Payment: As applicable'
  ].join('\n')
};

function sandbox(profile) {
  const ctx = {
    console,
    formatNum: (n) => new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    }).format(parseFloat(n) || 0),
    round2: (n) => Math.round((parseFloat(n) || 0) * 100) / 100,
    formatDate: (d) => {
      const s = String(d || '').slice(0, 10).split('-');
      return s.length === 3 ? `${s[2]}/${s[1]}/${s[0]}` : '';
    },
    numberToWordsINR: (n) => 'Rupees ' + Math.round(Math.abs(+n || 0)) + ' Only',
    escHtml: (v) => (v || '').toString()
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
    hexToRgb: () => [0, 121, 107],
    window: { open: () => null },
    getCachedProfile: () => (profile === undefined ? PROFILE : profile)
  };
  ctx.window.location = {};
  vm.createContext(ctx);
  // The shared helpers the proforma reuses, taken from the invoice renderer
  // itself so these cases exercise the real reuse rather than stubs.
  for (const name of ['invoicePartyLines', 'bankDetailLines', 'parseTermsTable',
                      'invoiceTransportParts', 'invoiceMachineTotal']) {
    const at = INV_PDF.indexOf('function ' + name + '(');
    assert.ok(at > -1, 'invoice-pdf.js no longer defines ' + name);
    const body = INV_PDF.slice(at);
    vm.runInContext(body.slice(0, body.search(/\r?\n\}/) + 3), ctx, { filename: name });
  }
  vm.runInContext(PDF, ctx, { filename: 'proforma-pdf.js' });
  return ctx;
}

const item = (over) => Object.assign({
  product_name: 'Sugarcane Juice Machine', hsn_code: '84351000', unit: 'NOS',
  quantity: 1, rate: 62000, discount_percentage: 0, gst_percentage: 18,
  taxable_value: 62000, gst_amount: 11160, cgst: 5580, sgst: 5580, igst: 0,
  cess_amount: 0, total_amount: 73160, sort_order: 0
}, over || {});

const row = (over) => Object.assign({
  id: 'pf-1', document_number: 'PI-00256', document_date: '2026-10-16',
  valid_until: '2026-11-15', status: 'draft', customer_name: 'Praveen C',
  gst_number: '', phone: '9876543210', address: '139 South Street, Cuddalore',
  state: 'Tamil Nadu', supply_type: 'intrastate', gst_category: 'regular',
  taxable_amount: 62000, gst_percentage: 18, gst_amount: 11160,
  igst: 0, cgst: 5580, sgst: 5580,
  transport_charge: null, transport_gst_amount: null, advance_amount: null,
  notes: '', terms: '', total_amount: 73160
}, over || {});

async function html(r, items, profile) {
  const ctx = sandbox(profile);
  return ctx.buildProformaHTML(r || row(), items || [item()], { autoPrint: false });
}

// ═══ Preview and print ════════════════════════════════

test('SP1 the preview is one document with the PDF: same columns, same headings', async () => {
  const ctx = sandbox();
  const items = [item()];
  const h = await ctx.buildProformaHTML(row(), items, {});
  // Built from the PDF's own descriptors, not a second column list.
  for (const head of ctx.proformaItemColumns(false).map(c => c.head)) {
    assert.ok(h.includes('<th>' + head + '</th>'), 'the preview must carry the column ' + head);
  }
  assert.ok(h.includes('<th>Unit</th>'), 'Unit is a column here too');
  assert.equal(h.includes('<th>Disc %</th>'), false, 'no discount on this quotation, no column');
  // And the code says so - the HTML must not hard-code its own heading list.
  assert.match(PDF_CODE, /const cols = proformaItemColumns\(showDiscount\)/);
  assert.match(PDF_CODE, /cols\.map\(c => `<th>\$\{escHtml\(c\.head\)\}<\/th>`\)/);
});

test('SP2 the preview prints the same cell values the PDF prints', async () => {
  const ctx = sandbox();
  const items = [item({ unit: 'BOX', quantity: 3, rate: 1500, total_amount: 5310 })];
  const h = await ctx.buildProformaHTML(row(), items, {});
  // Every column's value function is the PDF's, so compare against it.
  for (const c of ctx.proformaItemColumns(false)) {
    const v = ctx.escHtml(String(c.val(items[0], 0)));
    assert.ok(h.includes('>' + v + '<'), 'the preview must show ' + c.head + ' as "' + v + '"');
  }
});

test('SP3 a discounted quotation gains the column in the preview too', async () => {
  const h = await html(row(), [item({ discount_percentage: 7.5 })]);
  assert.ok(h.includes('<th>Disc %</th>'));
  assert.ok(h.includes('7.50%'));
});

test('SP4 NOT A TAX INVOICE is prominent, and on every printed page', async () => {
  const h = await html();
  // In the header, as a badge.
  assert.match(h, /<div class="badge">NOT A TAX INVOICE<\/div>/);
  assert.match(h, /\.hdr \.badge \{[^}]*font-weight: 800/);
  // And repeated on every printed page: a fixed element repeats per page, so
  // page two of a printed quotation still says what it is.
  assert.match(h, /<div class="pagemark">NOT A TAX INVOICE<\/div>/);
  assert.match(h, /@media print \{\s*\r?\n?\s*\.pagemark \{ display: block; position: fixed/);
  assert.match(h, /PROFORMA INVOICE/);
  // It never calls itself a tax invoice.
  assert.equal(/>TAX INVOICE</.test(h.replace(/NOT A TAX INVOICE/g, '')), false);
});

test('SP5 the preview carries nothing that belongs only to a tax invoice', async () => {
  const h = await html();
  for (const banned of ['Original for Recipient', 'Duplicate for File Copy',
    'Duplicate for Transporter', 'IRN', 'Scan to verify', 'e-invoice']) {
    assert.equal(h.includes(banned), false, 'the preview must not carry: ' + banned);
  }
  // It says plainly what it is instead.
  assert.ok(h.includes('It is not a Tax Invoice and no GST is payable on it'));
});

test('SP6 quotation facts are shown as stored: number, date, validity, status', async () => {
  const h = await html(row({ status: 'sent' }));
  assert.ok(h.includes('PI-00256'), 'the number as configured');
  assert.ok(h.includes('16/10/2026'), 'the document date');
  assert.ok(h.includes('15/11/2026'), 'valid until');
  assert.ok(h.includes('30 Days'), 'the validity derived from the two dates');
  assert.ok(h.includes('>Sent<'), 'the status');
  assert.ok(h.includes('B2C (Unregistered)'));
  // A registered customer reads as B2B.
  const b2b = await html(row({ gst_number: '33AARFV8415B1Z4' }));
  assert.ok(b2b.includes('B2B (Registered)'));
});

test('SP7 the totals block matches the PDF, including the conditional rows', async () => {
  // No delivery: no Taxable Amount row, because it would repeat the Subtotal.
  const plain = await html();
  assert.ok(plain.includes('<td>Subtotal</td>'));
  assert.equal(plain.includes('Taxable Amount'), false,
    'without delivery the GST base equals the subtotal and is not printed twice');

  // With delivery: the base differs, and the delivery rows appear.
  const withT = await html(row({
    transport_charge: 2500, transport_gst_amount: 450,
    taxable_amount: 64500, gst_amount: 11610, cgst: 5805, sgst: 5805, total_amount: 76110
  }));
  assert.ok(withT.includes('<td>Taxable Amount</td>'));
  assert.ok(withT.includes('<td>Machine / Product Total</td>'));
  assert.ok(withT.includes('<td>Transport Charge</td>'));
  assert.ok(withT.includes('<td>Transport GST</td>'));
  // The quoted figure is emphasised, and it is never called a Grand Total.
  assert.match(withT, /<tr class="grand"><td>Quoted Total<\/td>/);
  assert.equal(withT.includes('Grand Total'), false);
});

test('SP8 advance and balance print in the left column, as they do in the PDF', async () => {
  const none = await html();
  assert.equal(none.includes('Payment Terms'), false,
    'a quotation with no advance prints no payment summary');

  const some = await html(row({ advance_amount: 20000 }));
  assert.ok(some.includes('<h3>Payment Terms</h3>'));
  assert.ok(some.includes('Advance Amount'));
  assert.ok(some.includes('Balance Amount Due'));
  assert.ok(some.includes('53,160.00'), 'the balance is derived from the quoted total');
  // In the left column, beside the totals - not inside the totals table.
  const leftAt = some.indexOf('<div class="left">');
  const left = some.slice(leftAt, some.indexOf('<div class="right">', leftAt));
  assert.ok(left.includes('Payment Terms'), 'the payment block is in the left column');
  assert.ok(left.includes('Bank Details for Payment'),
    'under the account the money goes to');
});

test('SP9 the standing terms are the invoice\'s schedule, reused not copied', async () => {
  const h = await html();
  assert.ok(h.includes('Terms &amp; condition'));
  assert.ok(h.includes('Payment Term'), 'the schedule prints its labels');
  assert.ok(h.includes('100% Advance Payment / As per Order'));
  assert.match(h, /table\.tc th \{ background: #ffff99/);
  assert.match(PDF_CODE, /parseTermsTable\(p\?\.terms_conditions\)/);
  assert.equal(/function parseTermsTable\(/.test(PDF_CODE), false, 'reused, not copied');
  // Prose terms stay prose.
  const prose = await html(row(), [item()],
    Object.assign({}, PROFILE, { terms_conditions: 'All prices are ex-works.' }));
  assert.ok(prose.includes('Terms &amp; Conditions'));
  assert.ok(prose.includes('All prices are ex-works.'));
  assert.equal(prose.includes('<table class="tc">'), false);
});

test('SP10 print and preview use the one builder, and neither writes anything', () => {
  assert.match(PDF_CODE, /async function printProformaDocument\(row, items\) \{/);
  assert.match(PDF_CODE, /buildProformaHTML\(row, items, \{ autoPrint: true \}\)/);
  assert.match(PDF_CODE, /async function viewProformaDocument\(row, items\) \{/);
  assert.match(PDF_CODE, /buildProformaHTML\(row, items, \{ autoPrint: false \}\)/);
  // A blocked pop-up is reported, not swallowed into a dead button.
  assert.match(PDF_CODE, /Allow pop-ups to print this proforma/);
  assert.match(PDF_CODE, /Allow pop-ups to preview this proforma/);
  // Printing a quotation is a read.
  const fns = PDF_CODE.slice(PDF_CODE.indexOf('async function buildProformaHTML'));
  assert.equal(/\.update\(|\.insert\(|apiFetch\(|save-with-items/.test(fns), false,
    'none of these paths may write');
});

test('SP11 autoPrint is what decides whether the dialog opens', async () => {
  const ctx = sandbox();
  const withPrint = await ctx.buildProformaHTML(row(), [item()], { autoPrint: true });
  const without = await ctx.buildProformaHTML(row(), [item()], { autoPrint: false });
  assert.ok(withPrint.includes('window.print()'), 'print asks the browser to print');
  assert.equal(without.includes('window.print()'), false, 'the preview does not');
  // Called with no options at all it is a preview, not a surprise print.
  const bare = await ctx.buildProformaHTML(row(), [item()]);
  assert.equal(bare.includes('window.print()'), false);
});

test('SP12 long addresses and long product names cannot break the layout', async () => {
  const long = 'Plot 14/B, Second Floor, Behind the Old Bus Stand, Near Sri Ramalingam '
    + 'Kalyana Mandapam, Perundurai Main Road, Chithode Post, Erode District, Tamil Nadu 638102';
  const h = await html(
    row({ address: long, shipping_address: long + ' (gate 2)', shipping_state: 'Tamil Nadu' }),
    [item({ product_name: 'Commercial Tilting Wet Grinder with timer, 10 Litre, '
      + 'stainless drum, including stand and spare belts' })]);
  // The table cannot be pushed wider than the page, and text wraps instead.
  assert.match(h, /table\.items \{[^}]*table-layout: fixed/);
  assert.match(h, /table\.items td\.desc \{ word-wrap: break-word/);
  assert.match(h, /\.box p, \.strip p \{[^}]*word-wrap: break-word/);
  // Both addresses are present in full - nothing is silently truncated.
  assert.ok(h.includes('638102'), 'the billing address prints to its end');
  assert.ok(h.includes('(gate 2)'), 'the shipping address prints to its end');
});

test('SP13 a product row and the terms block are never split across printed pages', async () => {
  const h = await html();
  assert.match(h, /table\.items tr \{ page-break-inside: avoid/);
  assert.match(h, /table\.items thead \{ display: table-header-group/);
  assert.match(h, /table\.tc \{[^}]*page-break-inside: avoid/);
  assert.match(h, /\.signrow \{[^}]*page-break-inside: avoid/);
  assert.match(h, /\.foot \{[^}]*page-break-inside: avoid/);
  // Landscape, the same shape as the PDF.
  assert.match(h, /@page \{ size: A4 landscape/);
});

test('SP14 the seal and signature are the uploaded images, or nothing', async () => {
  const bare = await html();
  assert.ok(bare.includes('class="stamp empty"'), 'no images uploaded, nothing drawn');
  assert.equal(bare.includes('<img class="seal"'), false);

  const withBoth = await html(row(), [item()], Object.assign({}, PROFILE, {
    seal_base64: 'data:image/png;base64,AAA', signature_base64: 'data:image/png;base64,BBB'
  }));
  assert.ok(withBoth.includes('<img class="seal" src="data:image/png;base64,AAA"'));
  assert.ok(withBoth.includes('<img class="sig" src="data:image/png;base64,BBB"'));
  assert.ok(withBoth.includes('Authorized Signatory'));
  // A signature with no seal still shows, which was a bug on the PDF side.
  const signOnly = await html(row(), [item()],
    Object.assign({}, PROFILE, { signature_base64: 'data:image/png;base64,BBB' }));
  assert.ok(signOnly.includes('class="stamp no-seal"'));
  assert.ok(signOnly.includes('<img class="sig"'));
});

test('SP15 a missing business profile renders rather than throwing', async () => {
  const h = await html(row(), [item()], null);
  assert.ok(h.includes('PROFORMA INVOICE'));
  assert.ok(h.includes('NOT A TAX INVOICE'));
  assert.ok(h.includes('Your Business Name'), 'a placeholder, not a crash');
  assert.equal(h.includes('Bank Details for Payment'), false);
  assert.equal(h.includes('Terms &amp; condition'), false);
});

test('SP16 values are escaped, so a customer name cannot inject markup', async () => {
  const h = await html(row({ customer_name: '<script>alert(1)</script> & Co' }),
    [item({ product_name: '<b>bold</b> widget' })]);
  assert.equal(h.includes('<script>alert(1)'), false, 'the name must be escaped');
  // escHtml escapes &, " and < - invoice-pdf.js's own rule, shared with it.
  // Once < is gone a > is ordinary text, so no tag can be formed either way.
  assert.ok(h.includes('&lt;script'), 'the opening angle bracket is escaped');
  assert.ok(h.includes('&amp; Co'));
  assert.ok(h.includes('&lt;b'), 'the product name too');
  assert.equal(/<(script|b)/.test(h.replace(/<(\/?)(script|b)>/g, '')), false,
    'no tag may be formed from a stored value');
});

// ═══ WhatsApp and email ═══════════════════════════════

test('SP17 WhatsApp opens a prepared message and sends nothing', () => {
  assert.match(PDF_CODE, /async function shareProformaWhatsApp\(row, items\) \{/);
  // The same mechanism the tax invoice uses: a wa.me link, opened in a tab.
  assert.match(PDF_CODE, /window\.open\(`https:\/\/wa\.me\/\?text=\$\{encodeURIComponent\(msg\)\}`, '_blank'\)/);
  assert.match(INV_PDF, /https:\/\/wa\.me\/\?text=/);
  // No API, no credential, no customer number dialled.
  assert.equal(/api[._-]?key|token|whatsapp[._-]?api|graph\.facebook|twilio/i.test(PDF_CODE), false,
    'no messaging credential or API may appear here');
  assert.equal(/wa\.me\/\d|wa\.me\/\$\{/.test(PDF_CODE), false,
    'the link must not address a specific number');
});

test('SP18 the WhatsApp message reads as a quotation, never as a bill', () => {
  const msg = PDF_CODE.slice(PDF_CODE.indexOf('const msg ='), PDF_CODE.indexOf('window.open(`https://wa.me'));
  assert.ok(msg.includes('Proforma Invoice (Quotation)'));
  assert.ok(msg.includes('Not a Tax Invoice'));
  assert.ok(msg.includes('Quoted Total'));
  assert.ok(msg.includes('This is a quotation, not a Tax Invoice. No GST is payable on it.'));
  assert.equal(/Tax Invoice\*/.test(msg), false, 'it must not title itself a Tax Invoice');
  // The quotation's own facts, and the advance when there is one.
  for (const field of ['Proforma No', 'Valid Until', 'Advance', 'Balance Due']) {
    assert.ok(msg.includes(field), 'the message must carry ' + field);
  }
});

test('SP19 email downloads the PDF and hands off to the mail client', () => {
  const fn = PDF_CODE.slice(PDF_CODE.indexOf('async function emailProformaDocument'));
  // There is no mail server in this application; this is the supported path
  // the tax invoice already uses, and the body says the file needs attaching.
  assert.match(fn, /await downloadProformaDocument\(row, items\)/);
  assert.match(fn, /mailto:\$\{encodeURIComponent\(row\.email \|\| ''\)\}/);
  assert.ok(fn.includes('please attach it to this email before sending'));
  assert.ok(fn.includes('not a Tax Invoice'));
  assert.match(fn, /window\.location\.href = mailto/);
  // Subject and body are encoded, so a quotation number or a name with an
  // ampersand cannot truncate the mail.
  assert.match(fn, /subject=\$\{encodeURIComponent\(subject\)\}&body=\$\{encodeURIComponent\(body\)\}/);
  assert.equal(/smtp|sendgrid|mailgun|api[._-]?key/i.test(fn), false,
    'no mail credential or service may appear here');
});

// ═══ The list ═════════════════════════════════════════

test('SP20 the list offers the Tax Invoice List actions a quotation can have', () => {
  const cell = LIST.slice(LIST.indexOf('<div class="action-btns">'), LIST.indexOf('</td>\n    </tr>'));
  for (const [fn, title] of [
    ['viewProformaFromList', 'View'],
    ['downloadProformaPDF', 'Download PDF'],
    ['printProformaFromList', 'Print'],
    ['shareProformaFromList', 'Share via WhatsApp'],
    ['emailProformaFromList', 'Email PDF'],
    ['importProformaIntoInvoice', 'Convert to Invoice'],
    ['cancelProforma', 'Cancel']
  ]) {
    assert.ok(cell.includes(fn + "('"), 'the list must offer ' + title);
    assert.ok(cell.includes(title), 'labelled ' + title);
  }
  // Edit is a link to the entry page, as it is on the invoice list.
  assert.match(cell, /href="proforma\.html\?id=\$\{encodeURIComponent\(r\.id\)\}" title="Edit"/);
  // Nothing invoice-only arrived with them.
  assert.equal(/openMarkPaymentModal|viewInvoiceWarranties|deleteInvoiceFromList/.test(LIST), false);
});

test('SP21 Convert and Cancel stay closed on a quotation that is finished', () => {
  // The existing rule, unchanged: a converted or cancelled quotation offers
  // neither, so a second invoice cannot be raised from one offer.
  assert.match(LIST, /const canImport = st !== 'converted' && st !== 'cancelled';/);
  const cell = LIST.slice(LIST.indexOf('<div class="action-btns">'), LIST.indexOf('</td>\n    </tr>'));
  const convertAt = cell.indexOf('importProformaIntoInvoice');
  const cancelAt = cell.indexOf('cancelProforma');
  assert.ok(cell.lastIndexOf('canImport ?', convertAt) > -1, 'Convert is behind canImport');
  assert.ok(cell.lastIndexOf('canImport ?', cancelAt) > -1, 'Cancel is behind canImport');
  // Reading a quotation is always allowed, finished or not.
  for (const fn of ['viewProformaFromList', 'printProformaFromList', 'downloadProformaPDF']) {
    const at = cell.indexOf(fn);
    const guard = cell.lastIndexOf('canImport ?', at);
    const prevClose = cell.lastIndexOf('`}', at);
    assert.ok(guard === -1 || guard < prevClose, fn + ' must not be hidden on a finished quotation');
  }
});

test('SP22 every list action is a thin wrapper over the one renderer', () => {
  for (const [wrapper, target] of [
    ['viewProformaFromList', 'buildProformaHTML'],
    ['printProformaFromList', 'printProformaDocument'],
    ['shareProformaFromList', 'shareProformaWhatsApp'],
    ['emailProformaFromList', 'emailProformaDocument'],
    ['downloadProformaPDF', 'downloadProformaDocument']
  ]) {
    const at = LIST.indexOf('async function ' + wrapper);
    assert.ok(at > -1, wrapper + ' is missing');
    const body = LIST.slice(at, LIST.indexOf('\n}', at));
    assert.ok(body.includes(target), wrapper + ' must delegate to ' + target);
    assert.ok(body.includes('proformaById(id)'), wrapper + ' must look the row up');
    assert.ok(body.includes('Proforma not found'), wrapper + ' must handle a missing row');
    // The list holds no copy of the document: no markup, no money format.
    assert.equal(/<!DOCTYPE|formatNum\(|wa\.me|mailto:/.test(body), false,
      wrapper + ' must not build any part of the document itself');
  }
});

test('SP23 the preview opens in the list\'s own modal, as the invoice does', () => {
  assert.match(LIST_HTML, /id="viewProformaModal"/);
  assert.match(LIST_HTML, /id="viewProformaFrame"/);
  assert.match(LIST_HTML, /closeViewProformaModal\(\)/);
  assert.match(LIST, /frame\.srcdoc = html/);
  assert.match(LIST, /getElementById\('viewProformaModal'\)\?\.classList\.add\('open'\)/);
  assert.match(LIST, /function closeViewProformaModal\(\)/);
});

test('SP24 both pages load the new renderer, and the mirror agrees', () => {
  for (const page of ['proforma.html', 'proforma-list.html']) {
    assert.ok(rd(page).includes('client/js/pages/proforma-pdf.js?v=47'),
      page + ' must load proforma-pdf.js at v=47');
    assert.ok(rd('server', 'public', page).includes('client/js/pages/proforma-pdf.js?v=47'),
      'server/public/' + page + ' must match');
  }
  assert.ok(LIST_HTML.includes('client/js/pages/proforma-list.js?v=33'));
  assert.ok(rd('server', 'public', 'proforma-list.html').includes('client/js/pages/proforma-list.js?v=33'));
  // invoice-pdf.js must still load first - the proforma reuses its helpers.
  for (const page of ['proforma.html', 'proforma-list.html']) {
    const tags = rd(page).match(/<script src="[^"]+"><\/script>/g) || [];
    const at = (name) => tags.findIndex(t => t.includes('client/js/pages/' + name));
    assert.ok(at('invoice-pdf.js') > -1 && at('proforma-pdf.js') > -1, page + ' loads both');
    assert.ok(at('invoice-pdf.js') < at('proforma-pdf.js'),
      page + ': invoice-pdf.js must come before proforma-pdf.js');
  }
});

test('SP25 the mandatory Invoice Unit rule is still nowhere near the proforma', () => {
  for (const [name, src] of [['proforma-pdf.js', PDF_CODE], ['proforma-list.js', strip(LIST)]]) {
    assert.equal(/itemsUnitMustBeConfirmed|unit_confirmed|unitError|item_unit_required/.test(src), false,
      name + ' must not carry the invoice-only unit rule');
  }
  // And a quotation line with no unit still renders.
  return html(row(), [item({ unit: '' })]).then((h) => {
    assert.ok(h.includes('PROFORMA INVOICE'));
    assert.ok(h.includes('>-<'), 'a blank unit prints a dash, as in the PDF');
  });
});
