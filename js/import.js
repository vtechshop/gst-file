// =============================================
// Excel Bulk Import Pipeline
// Parses xlsx/xls, lets the user map columns (mapping is
// remembered per user), auto-classifies each row into B2B or
// B2C by GSTIN presence, auto-generates a matching HSN Summary
// entry when HSN Code / Product Name are mapped, runs
// non-blocking validation (js/validate.js), then bulk-inserts.
// =============================================

const IMPORT_FIELDS = [
  { key: 'gstin',         label: 'GSTIN (blank routes row to B2C)', required: false },
  { key: 'customerName',  label: 'Customer Name',                   required: true  },
  { key: 'state',         label: 'State (used for B2C rows)',       required: false },
  { key: 'invoiceNumber', label: 'Invoice Number',                  required: true  },
  { key: 'invoiceDate',   label: 'Invoice Date',                    required: true  },
  { key: 'taxableAmount', label: 'Taxable Amount',                  required: true  },
  { key: 'gstPct',        label: 'GST %',                           required: true  },
  { key: 'supplyType',    label: 'Supply Type (intrastate/interstate)', required: false },
  { key: 'hsnCode',       label: 'HSN Code',                        required: false },
  { key: 'productName',   label: 'Product / Service Name',          required: false },
  { key: 'quantity',      label: 'Quantity',                        required: false }
];

const IMPORT_FIELD_HINTS = {
  gstin:         ['gstin', 'gst no', 'gst number', 'gst_no'],
  customerName:  ['customer', 'party', 'buyer', 'name'],
  state:         ['state', 'place of supply'],
  invoiceNumber: ['invoice no', 'invoice number', 'inv no', 'invoice_number', 'bill no'],
  invoiceDate:   ['invoice date', 'date', 'inv date'],
  taxableAmount: ['taxable', 'amount', 'value'],
  gstPct:        ['gst %', 'gst%', 'rate', 'tax rate', 'gst rate'],
  supplyType:    ['supply', 'supply type'],
  hsnCode:       ['hsn'],
  productName:   ['product', 'item', 'description', 'service'],
  quantity:      ['qty', 'quantity']
};

let importParsed = { headers: [], rows: [] };
let importMapping = {};
let importNormalizedRows = [];

function openExcelImportModal() {
  resetExcelImport();
  document.getElementById('excelImportModal')?.classList.add('open');
}

function closeExcelImportModal() {
  document.getElementById('excelImportModal')?.classList.remove('open');
}

function resetExcelImport() {
  importParsed = { headers: [], rows: [] };
  importMapping = {};
  importNormalizedRows = [];
  const fileInput = document.getElementById('excelImportFile');
  if (fileInput) fileInput.value = '';
  document.getElementById('importStep1')?.classList.remove('d-none');
  document.getElementById('importStep2')?.classList.add('d-none');
  document.getElementById('importStep3')?.classList.add('d-none');
}

// ── Step 1: parse file ────────────────────────────
function handleExcelFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, dateNF: 'yyyy-mm-dd', defval: '' });
      if (!grid.length) { showToast('The file has no rows.', 'error'); return; }

      importParsed.headers = grid[0].map(h => String(h || '').trim());
      importParsed.rows = grid.slice(1).filter(r => r.some(c => String(c || '').trim() !== ''));

      if (!importParsed.rows.length) { showToast('No data rows found below the header row.', 'error'); return; }

      const user = await getCurrentUser();
      const remembered = user ? await loadRememberedMapping(user.id) : null;
      const guessed = guessMapping(importParsed.headers);
      importMapping = { ...guessed, ...(remembered || {}) };
      // Drop remembered/guessed entries that no longer match a real header
      Object.keys(importMapping).forEach(k => {
        if (!importParsed.headers.includes(importMapping[k])) delete importMapping[k];
      });

      renderMappingStep();
    } catch (err) {
      showToast('Could not read this file. Is it a valid .xlsx/.xls?', 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

function guessMapping(headers) {
  const map = {};
  const lower = headers.map(h => h.toLowerCase());
  IMPORT_FIELDS.forEach(f => {
    const hints = IMPORT_FIELD_HINTS[f.key] || [];
    const idx = lower.findIndex(h => hints.some(hint => h.includes(hint)));
    if (idx !== -1) map[f.key] = headers[idx];
  });
  return map;
}

async function loadRememberedMapping(userId) {
  const { data } = await _supabase.from('import_mappings').select('*').eq('user_id', userId).eq('import_type', 'invoice_excel').single();
  return data?.mapping || null;
}

async function saveRememberedMapping(userId, mapping) {
  const existing = await _supabase.from('import_mappings').select('id').eq('user_id', userId).eq('import_type', 'invoice_excel').single();
  if (existing.data) {
    await _supabase.from('import_mappings').update({ mapping }).eq('user_id', userId).eq('import_type', 'invoice_excel');
  } else {
    await _supabase.from('import_mappings').insert({ user_id: userId, import_type: 'invoice_excel', mapping });
  }
}

// ── Step 2: column mapping UI ─────────────────────
function renderMappingStep() {
  const grid = document.getElementById('importMappingGrid');
  if (!grid) return;
  const opts = ['<option value="">&mdash; Not in file &mdash;</option>']
    .concat(importParsed.headers.map(h => `<option value="${h}">${h}</option>`)).join('');

  grid.innerHTML = IMPORT_FIELDS.map(f => `
    <div class="form-group">
      <label for="map_${f.key}">${f.label}${f.required ? ' <span class="text-required">*</span>' : ''}</label>
      <select id="map_${f.key}" class="form-control" data-field="${f.key}">${opts}</select>
    </div>`).join('');

  IMPORT_FIELDS.forEach(f => {
    const sel = document.getElementById(`map_${f.key}`);
    if (sel && importMapping[f.key]) sel.value = importMapping[f.key];
  });

  document.getElementById('importStep1')?.classList.add('d-none');
  document.getElementById('importStep2')?.classList.remove('d-none');
}

function readMappingFromUI() {
  const mapping = {};
  IMPORT_FIELDS.forEach(f => {
    const v = document.getElementById(`map_${f.key}`)?.value;
    if (v) mapping[f.key] = v;
  });
  return mapping;
}

// ── Normalization helpers ─────────────────────────
function cellValue(row, headers, headerName) {
  if (!headerName) return '';
  const idx = headers.indexOf(headerName);
  return idx === -1 ? '' : row[idx];
}

function toISODateLoose(v) {
  if (!v) return '';
  if (v instanceof Date) return toISO(v);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d) ? '' : toISO(d);
}

function inferSupplyType(gstin, profile) {
  const profileGstin = profile?.gstin || '';
  if (gstin && profileGstin && gstin.slice(0, 2) !== profileGstin.slice(0, 2)) return 'interstate';
  return 'intrastate';
}

function normalizeImportRow(rawRow, mapping, headers, profile) {
  const get = (key) => cellValue(rawRow, headers, mapping[key]);

  const gstin = String(get('gstin') || '').trim().toUpperCase();
  const row = {
    gstin,
    customerName: String(get('customerName') || '').trim(),
    state: String(get('state') || '').trim() || profile?.state || '',
    invoiceNumber: String(get('invoiceNumber') || '').trim(),
    invoiceDate: toISODateLoose(get('invoiceDate')),
    taxableAmount: parseFloat(get('taxableAmount')) || 0,
    gstPct: get('gstPct') === '' ? '' : (parseFloat(get('gstPct')) || 0),
    supplyType: String(get('supplyType') || '').toLowerCase().trim(),
    hsnCode: String(get('hsnCode') || '').trim(),
    productName: String(get('productName') || '').trim(),
    quantity: parseFloat(get('quantity')) || 0,
    requireHSN: false
  };
  if (!row.supplyType || !['intrastate', 'interstate'].includes(row.supplyType)) {
    row.supplyType = inferSupplyType(gstin, profile);
  }
  row.classification = gstin ? 'b2b' : 'b2c';
  return row;
}

// ── Step 3: validate + preview ─────────────────────
async function runImportValidation() {
  importMapping = readMappingFromUI();
  const missingRequired = IMPORT_FIELDS.filter(f => f.required && !importMapping[f.key]);
  if (missingRequired.length) {
    showToast('Please map: ' + missingRequired.map(f => f.label).join(', '), 'error');
    return;
  }

  const user = await getCurrentUser();
  if (!user) return;

  const b2bExisting = await _supabase.from('b2b_invoices').select('gst_number,invoice_number').eq('user_id', user.id);
  const existingKeys = buildExistingKeys(b2bExisting.data || []);
  const profile = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;

  importNormalizedRows = importParsed.rows.map(rawRow => {
    const row = normalizeImportRow(rawRow, importMapping, importParsed.headers, profile);
    let { warnings } = validateInvoiceRow(row, existingKeys);

    // b2c_invoices has no invoice_number column — those checks don't apply to B2C rows.
    let hardInvalid;
    if (row.classification === 'b2b') {
      hardInvalid = !row.customerName || !row.invoiceNumber || !row.invoiceDate || row.taxableAmount <= 0 || row.gstPct === '';
    } else {
      warnings = warnings.filter(w => w !== 'Missing invoice number' && w !== 'Duplicate invoice number' && w !== 'Duplicate GSTIN + invoice number combination');
      hardInvalid = !row.invoiceDate || row.taxableAmount <= 0 || row.gstPct === '' || !row.state;
      if (!row.state) warnings.push('Missing state');
    }

    if (!hardInvalid) registerRowKeys(row, existingKeys);
    return { ...row, warnings, hardInvalid, skip: hardInvalid };
  });

  await saveRememberedMapping(user.id, importMapping);
  renderImportPreview();
}

function renderImportPreview() {
  const clean = importNormalizedRows.filter(r => !r.warnings.length && !r.hardInvalid).length;
  const warned = importNormalizedRows.filter(r => r.warnings.length && !r.hardInvalid).length;
  const invalid = importNormalizedRows.filter(r => r.hardInvalid).length;
  const b2bCount = importNormalizedRows.filter(r => r.classification === 'b2b' && !r.hardInvalid).length;
  const b2cCount = importNormalizedRows.filter(r => r.classification === 'b2c' && !r.hardInvalid).length;
  const hsnCount = importNormalizedRows.filter(r => !r.hardInvalid && r.hsnCode && r.productName).length;

  const summary = document.getElementById('importSummary');
  if (summary) {
    summary.innerHTML = `
      <div class="calc-row"><span class="label">Rows found</span><span class="value">${importNormalizedRows.length}</span></div>
      <div class="calc-row"><span class="label">Ready to import</span><span class="value text-success">${clean} clean, ${warned} with warnings</span></div>
      <div class="calc-row"><span class="label">Will be skipped</span><span class="value text-danger">${invalid} (missing required data)</span></div>
      <div class="calc-row total"><span class="label">Classification</span><span class="value">${b2bCount} &rarr; B2B &nbsp;|&nbsp; ${b2cCount} &rarr; B2C &nbsp;|&nbsp; ${hsnCount} HSN entries</span></div>`;
  }

  const table = document.getElementById('importPreviewTable');
  if (table) {
    const rowsHtml = importNormalizedRows.map((r, i) => {
      const rowClass = r.hardInvalid ? 'row-skip' : (r.warnings.length ? 'row-warn' : '');
      const badge = r.hardInvalid
        ? '<span class="badge import-badge-skip">Skip</span>'
        : (r.warnings.length ? '<span class="badge import-badge-warn">Warning</span>' : '<span class="badge import-badge-ok">OK</span>');
      return `<tr class="${rowClass}">
        <td>${i + 1}</td>
        <td>${badge}</td>
        <td><span class="badge ${r.classification === 'b2b' ? 'badge-blue' : 'badge-green'}">${r.classification.toUpperCase()}</span></td>
        <td>${r.gstin || '&mdash;'}</td>
        <td>${r.customerName || '&mdash;'}</td>
        <td>${r.invoiceNumber || '&mdash;'}</td>
        <td>${r.invoiceDate || '&mdash;'}</td>
        <td class="text-right">&#8377;${formatNum(r.taxableAmount)}</td>
        <td class="text-center">${r.gstPct === '' ? '&mdash;' : r.gstPct + '%'}</td>
        <td>${r.warnings.join(', ') || '&mdash;'}</td>
      </tr>`;
    }).join('');

    table.innerHTML = `<thead><tr>
      <th>#</th><th>Status</th><th>Type</th><th>GSTIN</th><th>Customer</th><th>Invoice No</th><th>Date</th><th>Taxable</th><th>GST%</th><th>Warnings</th>
    </tr></thead><tbody>${rowsHtml}</tbody>`;
  }

  document.getElementById('importStep2')?.classList.add('d-none');
  document.getElementById('importStep3')?.classList.remove('d-none');
}

// ── Step 4: bulk insert ───────────────────────────
async function confirmExcelImport() {
  const user = await getCurrentUser();
  if (!user) return;

  const btn = document.getElementById('importConfirmBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Importing...'; }

  let importedB2B = 0, importedB2C = 0, importedHSN = 0, skipped = 0;

  for (const row of importNormalizedRows) {
    if (row.hardInvalid) { skipped++; continue; }

    const calc = calcGST(row.taxableAmount, row.gstPct, row.supplyType);

    if (row.classification === 'b2b') {
      await _supabase.from('b2b_invoices').insert({
        user_id: user.id, gst_number: row.gstin, customer_name: row.customerName,
        invoice_number: row.invoiceNumber, invoice_date: row.invoiceDate,
        taxable_amount: row.taxableAmount, gst_percentage: row.gstPct,
        gst_amount: calc.gstAmount, total_amount: calc.totalAmount,
        supply_type: row.supplyType, igst: calc.igst, cgst: calc.cgst, sgst: calc.sgst
      });
      importedB2B++;
    } else {
      await _supabase.from('b2c_invoices').insert({
        user_id: user.id, state: row.state || 'Unknown', taxable_amount: row.taxableAmount,
        gst_percentage: row.gstPct, gst_amount: calc.gstAmount, total_amount: calc.totalAmount,
        supply_type: row.supplyType, igst: calc.igst, cgst: calc.cgst, sgst: calc.sgst,
        invoice_date: row.invoiceDate
      });
      importedB2C++;
    }

    // Auto-generate matching HSN Summary entry — user never enters this by hand.
    if (row.hsnCode && row.productName) {
      const table = row.classification === 'b2b' ? 'b2b_hsn' : 'b2c_hsn';
      const payload = {
        user_id: user.id, hsn_code: row.hsnCode, product_name: row.productName,
        type: 'goods', taxable_value: row.taxableAmount, gst_percentage: row.gstPct,
        supply_type: row.supplyType, igst: calc.igst, cgst: calc.cgst, sgst: calc.sgst,
        total_gst: calc.gstAmount, total_invoice_value: calc.totalAmount,
        entry_date: row.invoiceDate || new Date().toISOString().split('T')[0]
      };
      if (row.classification === 'b2b') payload.quantity = row.quantity || 0;
      await _supabase.from(table).insert(payload);
      importedHSN++;
    }
  }

  showToast(`Imported ${importedB2B} B2B, ${importedB2C} B2C invoice(s) and ${importedHSN} HSN entr${importedHSN === 1 ? 'y' : 'ies'}. ${skipped ? skipped + ' row(s) skipped.' : ''}`, importedB2B + importedB2C > 0 ? 'success' : 'warning');

  recordImportStats(importedB2B + importedB2C + importedHSN);
  closeExcelImportModal();
  if (typeof refreshStorageStatus === 'function') refreshStorageStatus();
  if (typeof loadB2B === 'function') await loadB2B(user.id);
}

function recordImportStats(count) {
  let stats = {};
  try { stats = JSON.parse(localStorage.getItem('gst_import_stats') || '{}'); } catch {}
  stats.totalImported = (stats.totalImported || 0) + count;
  stats.lastImportDate = new Date().toISOString();
  stats.lastImportCount = count;
  localStorage.setItem('gst_import_stats', JSON.stringify(stats));
}
