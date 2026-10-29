// Customer Advance Receipt, in a real browser.
//
// The node:test suite (tests/advance-receipt.test.js, 32 tests) already
// proves the arithmetic, the server's cap and the shape of the rendered
// markup. None of it can see a painted page, which is exactly where this
// feature's one shipped runtime bug lived: renderVoucherBalance() called an
// undeclared `val`, so the handler threw the moment a quotation was selected
// while every static check stayed green. These specs are aimed at that class
// of fault - what the browser does, and what it says went wrong.
const { test, expect, openVouchers } = require('./fixtures');

const RECEIPT = 'receipt_voucher';

// The five figures, by the ids the markup gives them.
const FIG = {
  total: '#vQuoteTotal',
  earlier: '#vQuotePrev',
  now: '#vQuoteNow',
  paid: '#vQuotePaid',
  balance: '#vQuoteBalance'
};

async function selectReceiptForm(page) {
  await page.selectOption('#vDocType', RECEIPT);
  // The payment block belongs to a receipt and to no other document, so its
  // visibility is how we know the type change finished.
  await expect(page.locator('#vReceiptPayment')).toBeVisible();
}

async function chooseQuotation(page, quoteId) {
  await page.selectOption('#vProforma', quoteId);
  await expect(page.locator('#vQuotePanel')).toBeVisible();
}

test.describe('Advance Receipt - the quotation panel', () => {
  test('selecting a quotation shows its products, and nothing throws', async ({ page, seeded, consoleErrors }) => {
    await openVouchers(page);
    await selectReceiptForm(page);

    // Before: the panel is not merely empty, it is absent from view.
    await expect(page.locator('#vQuotePanel')).toBeHidden();

    await chooseQuotation(page, seeded.quoteId);

    await expect(page.locator('#vQuotePanel .section-title', { hasText: 'Products' })).toBeVisible();
    await expect(page.locator('#vQuoteItemsBody tr')).toHaveCount(2);

    // Sorted by sort_order, so the bracket precedes the grinder whatever
    // order the rows were written in.
    const names = await page.locator('#vQuoteItemsBody tr td:nth-child(2)').allTextContents();
    expect(names).toEqual(['Wall Bracket', 'Mixer Grinder']);

    // Ten headers, in the order a tax invoice lists its products.
    await expect(page.locator('#vQuoteItemsTable thead th')).toHaveCount(10);
    expect(await page.locator('#vQuoteItemsTable thead th').allTextContents())
      .toEqual(['#', 'Product / Description', 'HSN', 'Unit', 'GST Treatment',
                'Qty', 'Rate (₹)', 'Discount %', 'GST %', 'Line Total']);

    // The values of one line, read off the page.
    const grinder = page.locator('#vQuoteItemsBody tr').nth(1);
    await expect(grinder.locator('td').nth(2)).toHaveText('8509');
    await expect(grinder.locator('td').nth(3)).toHaveText('PCS');
    await expect(grinder.locator('td').nth(4)).toContainText('Taxable');
    await expect(grinder.locator('td').nth(7)).toHaveText('5%');
    await expect(grinder.locator('td').nth(8)).toHaveText('18%');
    await expect(grinder.locator('td').nth(9)).toContainText('1,416.00');

    // The Grand Total row, which is the quotation's stored total.
    await expect(page.locator('#vQuoteItemsTotal')).toContainText('GRAND TOTAL (2 items)');
    await expect(page.locator('#vQuoteItemsTotal')).toContainText('1,750.00');

    // The bug this feature actually shipped would land here.
    expect(consoleErrors, 'the page reported no errors').toEqual([]);
  });

  test('the panel is reference data - it holds no controls at all', async ({ page, seeded }) => {
    await openVouchers(page);
    await selectReceiptForm(page);
    await chooseQuotation(page, seeded.quoteId);

    const panel = page.locator('#vQuotePanel');
    for (const control of ['input', 'select', 'textarea', 'button', '[contenteditable]']) {
      await expect(panel.locator(control), 'no ' + control + ' inside the panel').toHaveCount(0);
    }
    // And the cells are not focusable text fields by another route.
    await expect(panel.locator('[tabindex]')).toHaveCount(0);
  });

  test('the quotation header carries its own saved figures', async ({ page, seeded }) => {
    await openVouchers(page);
    await selectReceiptForm(page);
    await chooseQuotation(page, seeded.quoteId);

    const summary = page.locator('#vQuoteSummary');
    await expect(summary).toContainText(seeded.seed.quote.number);
    await expect(summary).toContainText('Anand Caterers');
    await expect(summary).toContainText('33AAAAA0000A1Z5');
    await expect(summary).toContainText('Tamil Nadu');
    await expect(summary).toContainText('1,483.05');     // taxable
    await expect(summary).toContainText('133.48');       // CGST, intrastate
    await expect(summary).toContainText('133.47');       // SGST
    await expect(summary).toContainText('1,750.00');     // grand total
    // Intrastate, so no IGST line is invented.
    await expect(summary).not.toContainText('IGST');
  });

  test('the customer is filled in, and the amount is left alone', async ({ page, seeded }) => {
    await openVouchers(page);
    await selectReceiptForm(page);

    // Money received is typed first, to prove selecting a quotation does not
    // overwrite it - the quoted advance is a TERM, not a receipt.
    await page.fill('#vAmount', '500');
    await chooseQuotation(page, seeded.quoteId);

    await expect(page.locator('#vPartyName')).toHaveValue('Anand Caterers');
    await expect(page.locator('#vPartyGstin')).toHaveValue('33AAAAA0000A1Z5');
    await expect(page.locator('#vPos')).toHaveValue('Tamil Nadu');
    await expect(page.locator('#vAmount'), 'the typed amount survived').toHaveValue('500');

    // And the fields remain editable.
    await page.fill('#vPartyName', 'Anand Caterers (Unit II)');
    await expect(page.locator('#vPartyName')).toHaveValue('Anand Caterers (Unit II)');
  });
});

test.describe('Advance Receipt - the five figures', () => {
  test('they follow the amount being typed', async ({ page, seeded }) => {
    await openVouchers(page);
    await selectReceiptForm(page);
    await chooseQuotation(page, seeded.quoteId);

    await page.fill('#vAmount', '500');
    await expect(page.locator(FIG.total)).toContainText('1,750.00');
    await expect(page.locator(FIG.earlier)).toContainText('0.00');
    await expect(page.locator(FIG.now)).toContainText('500.00');
    await expect(page.locator(FIG.paid)).toContainText('500.00');
    await expect(page.locator(FIG.balance), '1750 - 500').toContainText('1,250.00');

    // Retyping moves the three that depend on it and leaves the two that do not.
    await page.fill('#vAmount', '1750');
    await expect(page.locator(FIG.total)).toContainText('1,750.00');
    await expect(page.locator(FIG.earlier)).toContainText('0.00');
    await expect(page.locator(FIG.now)).toContainText('1,750.00');
    await expect(page.locator(FIG.paid)).toContainText('1,750.00');
    await expect(page.locator(FIG.balance), 'settled exactly').toContainText('0.00');
    await expect(page.locator('#vBalanceError')).toBeHidden();

    // One rupee past the total is flagged, and no balance is shown - a
    // negative balance would read as though the overpayment was accepted.
    await page.fill('#vAmount', '1751');
    await expect(page.locator('#vBalanceError')).toBeVisible();
    await expect(page.locator('#vBalanceError')).toContainText('more than');
    await expect(page.locator(FIG.balance)).toHaveText('—');

    // An emptied box is nothing received, not NaN.
    await page.fill('#vAmount', '');
    await expect(page.locator(FIG.now)).toContainText('0.00');
    await expect(page.locator(FIG.balance)).toContainText('1,750.00');
  });

  test('the quoted advance term is never shown as money received', async ({ page, seeded }) => {
    await openVouchers(page);
    await selectReceiptForm(page);
    await chooseQuotation(page, seeded.quoteId);

    // The seeded quotation carries advance_amount = 500 as a TERM. With
    // nothing actually received, every received figure must read zero.
    expect(seeded.seed.quote.advanceTerm).toBe(500);
    await expect(page.locator(FIG.earlier)).toContainText('0.00');
    await expect(page.locator(FIG.now)).toContainText('0.00');
    await expect(page.locator(FIG.paid)).toContainText('0.00');
    await expect(page.locator(FIG.balance)).toContainText('1,750.00');
  });
});

test.describe('Advance Receipt - saving, editing and cancelling', () => {
  test('a receipt saves, prints, and is counted against its quotation', async ({ page, seeded, db }) => {
    await openVouchers(page);
    await selectReceiptForm(page);
    await chooseQuotation(page, seeded.spareId);

    await page.selectOption('#vPaymentMethod', 'upi');
    await page.fill('#vReference', 'UPI-E2E-01');
    await page.fill('#vAmount', '400');
    await page.click('#vSaveBtn');

    // The print actions appear only once a receipt exists to print.
    await expect(page.locator('#vPrintBtn')).toBeVisible();

    const { rows } = await db.query(
      `SELECT * FROM receipt_vouchers WHERE proforma_invoice_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [seeded.spareId]);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].advance_amount)).toBe(400);
    expect(rows[0].payment_method).toBe('upi');
    expect(rows[0].reference_number).toBe('UPI-E2E-01');
    expect(rows[0].document_number, 'it was numbered').toBeTruthy();

    // Re-opening the same quotation now shows 400 already received.
    await chooseQuotation(page, seeded.spareId);
    await expect(page.locator(FIG.earlier)).toContainText('400.00');
    await expect(page.locator(FIG.balance)).toContainText('500.00');
  });

  test('editing a receipt keeps its quotation, method and reference', async ({ page, seeded, db }) => {
    await openVouchers(page);
    await selectReceiptForm(page);

    const { rows } = await db.query(
      `SELECT id, document_number FROM receipt_vouchers
        WHERE proforma_invoice_id = $1 ORDER BY created_at DESC LIMIT 1`, [seeded.spareId]);
    test.skip(rows.length === 0, 'the save spec must run first');

    await page.locator('#vListBody tr', { hasText: rows[0].document_number })
      .getByTitle('Edit').click();
    await expect(page.locator('#vPaymentMethod')).toHaveValue('upi');
    await expect(page.locator('#vReference')).toHaveValue('UPI-E2E-01');
    await expect(page.locator('#vProforma')).toHaveValue(seeded.spareId);
    // Its own amount is not counted as "received earlier" against itself.
    await expect(page.locator(FIG.earlier)).toContainText('0.00');
  });

  test('a cancelled receipt frees its room and keeps its record', async ({ page, seeded, db }) => {
    await openVouchers(page);
    await selectReceiptForm(page);

    const { rows } = await db.query(
      `SELECT id, document_number, advance_amount FROM receipt_vouchers
        WHERE proforma_invoice_id = $1 AND status <> 'cancelled'
        ORDER BY created_at DESC LIMIT 1`, [seeded.spareId]);
    test.skip(rows.length === 0, 'the save spec must run first');

    page.on('dialog', (d) => d.accept());
    await page.locator('#vListBody tr', { hasText: rows[0].document_number })
      .getByTitle(/^Cancel/).click();

    // The row is kept, with its number and amount, and only its status moves.
    const after = await db.query('SELECT * FROM receipt_vouchers WHERE id = $1', [rows[0].id]);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].status).toBe('cancelled');
    expect(after.rows[0].document_number).toBe(rows[0].document_number);
    expect(Number(after.rows[0].advance_amount)).toBe(Number(rows[0].advance_amount));

    // And the capacity it held is offered back without a page reload.
    await chooseQuotation(page, seeded.spareId);
    await expect(page.locator(FIG.earlier)).toContainText('0.00');
    await expect(page.locator(FIG.balance)).toContainText('900.00');
  });

  test('an overpayment is refused by the server, not just flagged on screen', async ({ page, seeded, db }) => {
    await openVouchers(page);
    await selectReceiptForm(page);
    await chooseQuotation(page, seeded.quoteId);

    await page.fill('#vAmount', '5000');
    await expect(page.locator('#vBalanceError')).toBeVisible();

    const before = await db.query(
      'SELECT COUNT(*)::int n FROM receipt_vouchers WHERE proforma_invoice_id = $1', [seeded.quoteId]);
    await page.click('#vSaveBtn');
    // Whatever the screen chose to do, nothing may have been written.
    const after = await db.query(
      'SELECT COUNT(*)::int n FROM receipt_vouchers WHERE proforma_invoice_id = $1', [seeded.quoteId]);
    expect(after.rows[0].n, 'the overpayment was not stored').toBe(before.rows[0].n);
  });

  test('a standalone receipt needs no quotation', async ({ page, db }) => {
    await openVouchers(page);
    await selectReceiptForm(page);

    await expect(page.locator('#vProforma')).toHaveValue('');
    await expect(page.locator('#vQuotePanel')).toBeHidden();

    await page.fill('#vPartyName', 'Walk-in Customer');
    await page.selectOption('#vPaymentMethod', 'cash');
    await page.fill('#vAmount', '2500');
    await page.click('#vSaveBtn');

    const { rows } = await db.query(
      `SELECT * FROM receipt_vouchers WHERE party_name = 'Walk-in Customer' LIMIT 1`);
    expect(rows).toHaveLength(1);
    expect(rows[0].proforma_invoice_id, 'no quotation, and none invented').toBeNull();
    expect(Number(rows[0].advance_amount)).toBe(2500);
  });

  test('resetting clears the payment facts and puts the panel away', async ({ page, seeded }) => {
    await openVouchers(page);
    await selectReceiptForm(page);
    await chooseQuotation(page, seeded.quoteId);
    await page.selectOption('#vPaymentMethod', 'cheque');
    await page.fill('#vReference', 'CHQ-1');

    await page.getByRole('button', { name: /Reset/ }).click();
    await expect(page.locator('#vPaymentMethod')).toHaveValue('');
    await expect(page.locator('#vReference')).toHaveValue('');
    await expect(page.locator('#vProforma')).toHaveValue('');
    await expect(page.locator('#vQuotePanel')).toBeHidden();
  });
});

test.describe('Advance Receipt - the selector says why it is empty', () => {
  test('a cancelled quotation is not offered', async ({ page, seeded }) => {
    await openVouchers(page);
    await selectReceiptForm(page);
    const values = await page.locator('#vProforma option').evaluateAll(
      (os) => os.map((o) => o.value));
    expect(values, 'cancelled quotations are not offered')
      .not.toContain(seeded.cancelledId);
    expect(values, "nor another business's").not.toContain(seeded.foreignId);
    expect(values).toContain(seeded.quoteId);
  });

  test('with no quotations at all, the note explains the dead end', async ({ page, db, seeded }) => {
    // This is the state most likely to look like "the table is broken": the
    // panel can only appear once a quotation is selected, so with nothing to
    // select it can never appear. The note is what makes that legible.
    await db.query('UPDATE proforma_invoices SET status = $1 WHERE user_id = $2',
      ['cancelled', seeded.userId]);
    try {
      await openVouchers(page);
      await selectReceiptForm(page);
      await expect(page.locator('#vProformaNote')).toBeVisible();
      await expect(page.locator('#vProformaNote')).toContainText('cancelled');
      await expect(page.locator('#vQuotePanel')).toBeHidden();
    } finally {
      await db.query('UPDATE proforma_invoices SET status = $1 WHERE user_id = $2',
        ['issued', seeded.userId]);
    }
  });
});

test.describe('Advance Receipt - the grid at three widths', () => {
  // The visual half, which is the part no node:test can reach.
  test('the header is painted, and the grid scrolls rather than overflowing the page', async ({ page, seeded }, testInfo) => {
    await openVouchers(page);
    await selectReceiptForm(page);
    await chooseQuotation(page, seeded.quoteId);

    const head = page.locator('#vQuoteItemsTable thead tr').first();
    // The dark-green header and white labels come from .data-table thead tr.
    const bg = await head.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg, 'the header has a painted background').not.toBe('rgba(0, 0, 0, 0)');
    const colour = await page.locator('#vQuoteItemsTable thead th').first()
      .evaluate((el) => getComputedStyle(el).color);
    expect(colour).toBe('rgb(255, 255, 255)');

    // The total row is visually distinct from the body rows.
    const footBg = await page.locator('#vQuoteItemsTotal tr').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(footBg).not.toBe(bg);
    expect(footBg).not.toBe('rgba(0, 0, 0, 0)');

    // The grid is wider than a phone, so its own wrapper scrolls - the page
    // itself must not.
    const wrapper = page.locator('.quote-table-wrapper');
    const scrollable = await wrapper.evaluate((el) => el.scrollWidth > el.clientWidth);
    const pageOverflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(pageOverflows, 'the page does not scroll sideways').toBe(false);
    if (testInfo.project.name !== 'chromium-desktop') {
      expect(scrollable, 'the grid scrolls inside its wrapper').toBe(true);
    }

    // The save control stays reachable at every width.
    await expect(page.locator('#vSaveBtn')).toBeVisible();

    await testInfo.attach('quote-grid-' + testInfo.project.name + '.png', {
      body: await page.locator('#vQuotePanel').screenshot(),
      contentType: 'image/png'
    });
  });
});
