// =============================================
// Value sanitisers shared by both document scanners.
//
// Gemini is schema-constrained, so the SHAPE of a reply is already
// guaranteed by services/schemaCheck.js. These functions deal with the
// CONTENT: a 15-character string that is not a GSTIN, a date that does
// not exist, a percentage of 180.
//
// The rule throughout: every one of these either produces a clean value
// or produces blank. None of them repairs, guesses or invents — a blank
// box is visibly incomplete, whereas a plausible wrong value gets saved.
// =============================================

const str = v => (typeof v === 'string' ? v.trim() : '');

const num = v => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// Blank unless it is a genuinely well-formed 15-character GSTIN. The
// prompts already ask for "" over a partial read; this is the backstop
// for when the model ignores that.
const gstin = v => {
  const g = str(v).toUpperCase().replace(/\s/g, '');
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(g) ? g : '';
};

// Date inputs need YYYY-MM-DD and nothing else. A real calendar check as
// well as a shape check — 2026-02-31 matches the regex.
const isoDate = v => {
  const d = str(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day ? d : '';
};

const pct = v => {
  const n = num(v);
  return n !== null && n >= 0 && n <= 100 ? n : null;
};

// One product/line-item row, identical on a purchase bill and a sales
// invoice. Money fields come back prefixed `reported_` precisely so that
// nothing downstream can mistake them for values to save: the app's own
// calcGST() recomputes every one of them from quantity/rate/discount/GST.
const lineItem = p => ({
  product_name: str(p.product_name).replace(/^\d+[.)]\s*/, ''),   // drop a leading serial number
  hsn_code: (str(p.hsn_code).match(/\d{4,8}/) || [''])[0],
  unit: str(p.unit).replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 10),
  quantity: num(p.quantity),
  rate: num(p.rate),
  discount_percentage: pct(p.discount_percentage),
  gst_percentage: pct(p.gst_percentage),
  reported_taxable_value: num(p.taxable_value),
  reported_gst_amount: num(p.gst_amount),
  reported_total: num(p.total)
});

// A row with no name is table furniture the model mistook for a product;
// a row with neither quantity nor rate cannot be priced.
const isUsableLine = p => !!p.product_name && (p.quantity !== null || p.rate !== null);

module.exports = { str, num, gstin, isoDate, pct, lineItem, isUsableLine };
