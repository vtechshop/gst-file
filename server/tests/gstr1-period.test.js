// Regression tests for GSTR-1 month-wise export.
//
// The one thing these exist to prevent: a return filed for July that
// contains an August invoice, or vice versa. The Portal rejects a period
// mismatch, and a return that quietly carries the wrong month's supplies
// misstates what is owed.
//
// Three independent guards make that impossible today, and there is one
// test group per guard:
//   1. getReportDateRange()    — the window the queries actually use
//   2. gstr1FilingPeriod()     — only a named month may be filed
//   3. gstr1DeriveFilingMonth() — the fetched invoices must share one month
// plus an integration group that drives buildGSTR1Payload() with a
// recording client and asserts on the date filters really sent.
//
// Loaded through tests/helpers/browser-context.js, which runs the shipped
// js/*.js files unmodified — see that file for why.
const test = require('node:test');
const assert = require('node:assert');
const { createBrowserContext, makeRecordingSupabase } = require('./helpers/browser-context');

const ctx = createBrowserContext();
const { getReportDateRange, gstr1FilingPeriod, gstr1DeriveFilingMonth } = ctx;

// Objects built inside the vm carry that context's Object.prototype, which
// deepStrictEqual treats as a different type ("same structure but not
// reference-equal"). Rebuilding the two fields here compares the values,
// which is what these tests are actually about.
const range = (selection) => {
  const r = getReportDateRange(selection);
  return { start: r.start, end: r.end };
};

// ── 1. getReportDateRange: the window the queries use ────────────────
test('getReportDateRange spans exactly the selected month', async (t) => {
  await t.test('July 2026', () => {
    assert.deepStrictEqual(range('2026-07'), { start: '2026-07-01', end: '2026-07-31' });
  });

  await t.test('August 2026', () => {
    assert.deepStrictEqual(range('2026-08'), { start: '2026-08-01', end: '2026-08-31' });
  });

  // 30-day month: proves the end date is the real last day, not a fixed 31.
  await t.test('September 2026 ends on the 30th', () => {
    assert.deepStrictEqual(range('2026-09'), { start: '2026-09-01', end: '2026-09-30' });
  });

  await t.test('February 2026 (non-leap) ends on the 28th', () => {
    assert.deepStrictEqual(range('2026-02'), { start: '2026-02-01', end: '2026-02-28' });
  });

  await t.test('February 2024 (leap) ends on the 29th', () => {
    assert.deepStrictEqual(range('2024-02'), { start: '2024-02-01', end: '2024-02-29' });
  });

  // Year boundary: new Date(2026, 12, 0) must roll to 31 December 2026 and
  // not leak into January 2027.
  await t.test('December 2026 stays inside 2026', () => {
    assert.deepStrictEqual(range('2026-12'), { start: '2026-12-01', end: '2026-12-31' });
  });

  await t.test('January 2027 does not reach back into December', () => {
    assert.deepStrictEqual(range('2027-01'), { start: '2027-01-01', end: '2027-01-31' });
  });

  // The whole point: two different selections must not overlap by a day.
  await t.test('July and August windows do not overlap', () => {
    const jul = range('2026-07');
    const aug = range('2026-08');
    assert.ok(jul.end < aug.start, `July must end before August begins (${jul.end} < ${aug.start})`);
    assert.notStrictEqual(jul.start, aug.start);
  });
});

// ── 2. gstr1FilingPeriod: only a named month may be filed ────────────
test('gstr1FilingPeriod accepts a month and rejects every range', async (t) => {
  await t.test('July 2026 becomes fp 072026', () => {
    assert.strictEqual(gstr1FilingPeriod('2026-07').fp, '072026');
  });

  await t.test('August 2026 becomes fp 082026', () => {
    assert.strictEqual(gstr1FilingPeriod('2026-08').fp, '082026');
  });

  await t.test('December 2026 becomes fp 122026', () => {
    assert.strictEqual(gstr1FilingPeriod('2026-12').fp, '122026');
  });

  // A GSTR-1 covers one named month. Every multi-month selection on the
  // Reports dropdown has to be refused rather than silently exported as a
  // combined return.
  for (const selection of ['current', 'fy', 'q1', 'q2', 'q3', 'q4', '', '2026', '2026-13', '2026-00', 'july']) {
    await t.test(`refuses ${JSON.stringify(selection)}`, () => {
      const result = gstr1FilingPeriod(selection);
      assert.ok(result.error, `${JSON.stringify(selection)} must not produce a filing period`);
      assert.strictEqual(result.fp, undefined);
    });
  }

  await t.test('null and undefined are refused, not coerced', () => {
    assert.ok(gstr1FilingPeriod(null).error);
    assert.ok(gstr1FilingPeriod(undefined).error);
  });
});

// ── 3. gstr1DeriveFilingMonth: the cross-month guard ─────────────────
const JULY_A = { invoice_number: 'A', invoice_date: '2026-07-05' };
const JULY_B = { invoice_number: 'B', invoice_date: '2026-07-28' };
const AUG_C  = { invoice_number: 'C', invoice_date: '2026-08-01' };
const AUG_D  = { invoice_number: 'D', invoice_date: '2026-08-31' };

test('gstr1DeriveFilingMonth refuses a mixed-month dataset', async (t) => {
  await t.test('July-only invoices derive July', () => {
    const r = gstr1DeriveFilingMonth([JULY_A, JULY_B]);
    assert.strictEqual(r.month, '2026-07');
    assert.ok(!r.error);
  });

  await t.test('August-only invoices derive August', () => {
    const r = gstr1DeriveFilingMonth([AUG_C, AUG_D]);
    assert.strictEqual(r.month, '2026-08');
    assert.ok(!r.error);
  });

  // THE test. Invoice A and B are July, C and D are August; a dataset
  // holding all four must be refused outright rather than filed as either
  // month.
  await t.test('July + August together is an error', () => {
    const r = gstr1DeriveFilingMonth([JULY_A, JULY_B, AUG_C, AUG_D]);
    assert.ok(r.error, 'a mixed-month dataset must be refused');
    assert.strictEqual(r.month, undefined);
    assert.match(r.error.message, /one filing month/i);
  });

  await t.test('a single stray invoice from another month is still an error', () => {
    assert.ok(gstr1DeriveFilingMonth([JULY_A, JULY_B, AUG_C]).error);
  });

  await t.test('a month boundary pair (31 Jul + 1 Aug) is an error', () => {
    assert.ok(gstr1DeriveFilingMonth([{ invoice_date: '2026-07-31' }, { invoice_date: '2026-08-01' }]).error);
  });

  await t.test('December + January is an error across the year boundary', () => {
    assert.ok(gstr1DeriveFilingMonth([{ invoice_date: '2026-12-31' }, { invoice_date: '2027-01-01' }]).error);
  });

  // No invoices at all is a nil return, which is filable — so this must
  // NOT be an error.
  await t.test('an empty month is allowed (nil return)', () => {
    const r = gstr1DeriveFilingMonth([]);
    assert.strictEqual(r.month, null);
    assert.ok(!r.error);
  });
});

// ── 4. Integration: the filters actually sent for the selected month ──
//
// Everything above tests the pure helpers. This drives the real
// buildGSTR1Payload() with a recording stand-in for js/apiClient.js and
// asserts on the gte/lte values it puts on the wire — so a regression that
// left the helpers correct but stopped passing the window through to the
// queries would still be caught.
async function recordQueriesFor(period) {
  const recorded = [];
  ctx._supabase = makeRecordingSupabase(recorded);
  await ctx.buildGSTR1Payload('test-user-id', { gstin: '29AABCU9603R1ZM', state: 'Karnataka' }, period);
  return recorded;
}

function dateFiltersOn(recorded, table) {
  const rec = recorded.find(r => r.table === table);
  assert.ok(rec, `expected a query against ${table}`);
  return { gte: Object.values(rec.gte)[0], lte: Object.values(rec.lte)[0] };
}

test('the selected month reaches the queries, and changing it changes them', async (t) => {
  const july = await recordQueriesFor('2026-07');
  const august = await recordQueriesFor('2026-08');

  // Every dated source table must be scoped to the selected month. These
  // are the tables that carry a date column of their own; line items and
  // HSN rows are scoped by their parent invoice ids instead.
  for (const table of ['b2b_invoices', 'b2c_invoices', 'cdn_notes', 'sales_returns']) {
    await t.test(`${table} is filtered to July when July is selected`, () => {
      assert.deepStrictEqual(dateFiltersOn(july, table), { gte: '2026-07-01', lte: '2026-07-31' });
    });

    await t.test(`${table} is filtered to August when August is selected`, () => {
      assert.deepStrictEqual(dateFiltersOn(august, table), { gte: '2026-08-01', lte: '2026-08-31' });
    });

    await t.test(`${table} filters actually change between the two`, () => {
      assert.notDeepStrictEqual(dateFiltersOn(july, table), dateFiltersOn(august, table));
    });
  }

  // Table 13 (Documents Issued) is fetched separately and must follow the
  // same window — this is the section the production GSTR-1 error came
  // from, so it gets its own assertion rather than relying on the loop.
  await t.test('Documents Issued (Table 13) is scoped to the selected month', () => {
    const docTables = july.filter(r => Object.keys(r.gte).includes('document_date'));
    assert.ok(docTables.length > 0, 'expected at least one document_date-scoped query');
    docTables.forEach(r => {
      assert.strictEqual(r.gte.document_date, '2026-07-01');
      assert.strictEqual(r.lte.document_date, '2026-07-31');
    });
  });

  await t.test('no query carries a filter from the month not selected', () => {
    const julyText = JSON.stringify(july);
    assert.ok(!julyText.includes('2026-08'), 'a July export must not reference August anywhere');
    const augustText = JSON.stringify(august);
    assert.ok(!augustText.includes('2026-07'), 'an August export must not reference July anywhere');
  });
});

// ── 5. The filename carries the selected month ───────────────────────
// exportGSTR1JSON() names the file `GSTR1_${payload.fp}.json`, so proving
// fp is enough to prove the filename.
// ── 6. The month named in the progress toasts (E1) ───────────────────
// exportGSTR1JSON() says "…for July 2026" using gstr1MonthLabel(), and for
// the two later messages converts payload.fp back to a label. Both are
// tested here so the wording cannot silently start naming the wrong month.
test('the month shown to the user during export', async (t) => {
  const { gstr1MonthLabel } = ctx;
  const labelFromFp = (fp) => gstr1MonthLabel(`${fp.slice(2)}-${fp.slice(0, 2)}`);

  await t.test('the selection is labelled for the first toast', () => {
    assert.strictEqual(gstr1MonthLabel('2026-07'), 'July 2026');
    assert.strictEqual(gstr1MonthLabel('2026-08'), 'August 2026');
  });

  await t.test('fp is labelled back for the generating/success toasts', () => {
    assert.strictEqual(labelFromFp('072026'), 'July 2026');
    assert.strictEqual(labelFromFp('082026'), 'August 2026');
    assert.strictEqual(labelFromFp('122026'), 'December 2026');
    assert.strictEqual(labelFromFp('012027'), 'January 2027');
  });

  await t.test('the round trip selection -> fp -> label is stable', () => {
    for (const sel of ['2026-01', '2026-07', '2026-08', '2026-12', '2027-01']) {
      assert.strictEqual(labelFromFp(gstr1FilingPeriod(sel).fp), gstr1MonthLabel(sel));
    }
  });

  // The toasts only name a month when one was actually selected; a range
  // falls back to the generic wording rather than saying "for current".
  await t.test('a range selection is not labelled as a month', () => {
    const namesMonth = (sel) => ctx.__eval(`GSTR1_MONTH_SELECTION.test(${JSON.stringify(sel)})`);
    for (const sel of ['current', 'fy', 'q1', 'q2', 'q3', 'q4', '']) {
      assert.strictEqual(namesMonth(sel), false, `${sel || '(empty)'} must not be treated as a month`);
    }
    assert.strictEqual(namesMonth('2026-07'), true);
    assert.strictEqual(namesMonth('2026-08'), true);
  });

  // The toast condition and the export gate must agree: anything labelled
  // as a month must also be accepted for filing, and anything refused for
  // filing must not be labelled. A drift between the two would show the
  // user a confident month for an export that is about to be rejected.
  await t.test('the toast condition matches the filing gate exactly', () => {
    for (const sel of ['2026-07', '2026-08', '2026-12', 'current', 'fy', 'q1', '', '2026-13']) {
      const labelled = ctx.__eval(`GSTR1_MONTH_SELECTION.test(${JSON.stringify(sel)})`);
      const filable = !gstr1FilingPeriod(sel).error;
      assert.strictEqual(labelled, filable, `disagreement on ${JSON.stringify(sel)}`);
    }
  });
});

test('the export filename identifies the filing month', async (t) => {
  await t.test('July 2026 produces GSTR1_072026.json', () => {
    assert.strictEqual(`GSTR1_${gstr1FilingPeriod('2026-07').fp}.json`, 'GSTR1_072026.json');
  });

  await t.test('August 2026 produces GSTR1_082026.json', () => {
    assert.strictEqual(`GSTR1_${gstr1FilingPeriod('2026-08').fp}.json`, 'GSTR1_082026.json');
  });
});
