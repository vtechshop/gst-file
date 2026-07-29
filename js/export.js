// =============================================
// Export Module – Excel & PDF
// =============================================

function exportToExcel(data, sheetName, fileName) {
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, fileName + '.xlsx');
  showToast('Excel exported successfully!');
}

function exportMultiSheetExcel(sheets, fileName) {
  const wb = XLSX.utils.book_new();
  sheets.forEach(({ data, name }) => {
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, name);
  });
  XLSX.writeFile(wb, fileName + '.xlsx');
  showToast('Excel exported successfully!');
}

function exportToPDF(title, columns, rows, fileName) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape' });

  const startY = (typeof getBusinessPDFHeader === 'function')
    ? getBusinessPDFHeader(doc, title, '')
    : 28;

  if (typeof getBusinessPDFHeader !== 'function') {
    doc.setFillColor(0, 121, 107);
    doc.rect(0, 0, doc.internal.pageSize.width, 18, 'F');
    doc.setTextColor(255,255,255);
    doc.setFontSize(13); doc.setFont('helvetica','bold');
    doc.text(title, 14, 12);
    doc.setTextColor(100,100,100); doc.setFontSize(9); doc.setFont('helvetica','normal');
    doc.text('Generated: ' + new Date().toLocaleString('en-IN'), 14, 24);
  }

  doc.autoTable({
    startY,
    head: [columns],
    body: rows,
    theme: 'striped',
    headStyles: { fillColor: [0, 121, 107], textColor: 255, fontStyle: 'bold', fontSize: 8 },
    bodyStyles: { fontSize: 8 },
    alternateRowStyles: { fillColor: [232, 245, 243] },
    margin: { left: 14, right: 14 },
    styles: { cellPadding: 3 }
  });

  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(`Page ${i} of ${pageCount} | GST Invoice & GSTR-1 Management System`, 14, doc.internal.pageSize.height - 8);
  }

  doc.save(fileName + '.pdf');
  showToast('PDF exported successfully!');
}

function exportB2BExcel(invoices) {
  const data = invoices.map((r, i) => ({
    'S.No': i + 1,
    'GST Number': r.gst_number,
    'Customer Name': r.customer_name,
    'Invoice No': r.invoice_number,
    'Invoice Date': formatDate(r.invoice_date),
    'Supply Type': r.supply_type,
    'Taxable Amount': r.taxable_amount,
    'GST %': r.gst_percentage,
    'GST Amount': r.gst_amount,
    'IGST': r.igst,
    'CGST': r.cgst,
    'SGST': r.sgst,
    'Total Amount': r.total_amount
  }));
  exportToExcel(data, 'B2B Invoices', 'B2B_Invoices');
}

function exportB2CExcel(invoices) {
  const data = invoices.map((r, i) => ({
    'S.No': i + 1,
    'State': r.state,
    'Supply Type': r.supply_type,
    'Invoice Date': formatDate(r.invoice_date),
    'Taxable Amount': r.taxable_amount,
    'GST %': r.gst_percentage,
    'GST Amount': r.gst_amount,
    'IGST': r.igst,
    'CGST': r.cgst,
    'SGST': r.sgst,
    'Total Amount': r.total_amount
  }));
  exportToExcel(data, 'B2C Invoices', 'B2C_Invoices');
}

function exportHSNExcel(b2bHsn, b2cHsn) {
  const b2bData = b2bHsn.map((r, i) => ({
    'S.No': i + 1,
    'HSN Code': r.hsn_code,
    'Product Name': r.product_name,
    'Type': r.type,
    'Quantity': r.quantity,
    'Taxable Value': r.taxable_value,
    'GST %': r.gst_percentage,
    'Supply Type': r.supply_type,
    'IGST': r.igst,
    'CGST': r.cgst,
    'SGST': r.sgst,
    'Total GST': r.total_gst,
    'Total Invoice Value': r.total_invoice_value
  }));
  const b2cData = b2cHsn.map((r, i) => ({
    'S.No': i + 1,
    'HSN Code': r.hsn_code,
    'Product Name': r.product_name,
    'Type': r.type,
    'Taxable Value': r.taxable_value,
    'GST %': r.gst_percentage,
    'Supply Type': r.supply_type,
    'IGST': r.igst,
    'CGST': r.cgst,
    'SGST': r.sgst,
    'Total GST': r.total_gst,
    'Total Invoice Value': r.total_invoice_value
  }));
  exportMultiSheetExcel([{ data: b2bData, name: 'B2B HSN' }, { data: b2cData, name: 'B2C HSN' }], 'HSN_Summary');
}

function exportB2BPDF(invoices) {
  const cols = ['#', 'GST No', 'Customer', 'Inv No', 'Date', 'Type', 'Taxable', 'GST%', 'IGST', 'CGST', 'SGST', 'Total'];
  const rows = invoices.map((r, i) => [i+1, r.gst_number, r.customer_name, r.invoice_number,
    formatDate(r.invoice_date), r.supply_type, formatNum(r.taxable_amount), r.gst_percentage+'%',
    formatNum(r.igst), formatNum(r.cgst), formatNum(r.sgst), formatNum(r.total_amount)]);
  exportToPDF('GSTR-1 B2B Invoice Report', cols, rows, 'B2B_Invoices');
}

function exportB2CPDF(invoices) {
  const cols = ['#', 'State', 'Type', 'Date', 'Taxable', 'GST%', 'IGST', 'CGST', 'SGST', 'Total'];
  const rows = invoices.map((r, i) => [i+1, r.state, r.supply_type, formatDate(r.invoice_date),
    formatNum(r.taxable_amount), r.gst_percentage+'%', formatNum(r.igst),
    formatNum(r.cgst), formatNum(r.sgst), formatNum(r.total_amount)]);
  exportToPDF('GSTR-1 B2C Invoice Report', cols, rows, 'B2C_Invoices');
}

// GSTR-1 JSON export (Government Portal format) now lives in
// js/gstr1-export.js — a dedicated compliance engine (validation,
// recompute-from-items, POS/B2CL/CDNR handling) rather than the simple
// cached-totals passthrough this used to be. getStateCode() and
// formatDateDDMMYYYY() moved there too since they're only used by it.

function printReport(elementId, reportTitle) {
  const el = document.getElementById(elementId);
  if (!el) return;

  const p = (typeof getCachedProfile === 'function') ? getCachedProfile() : null;
  const now = new Date().toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
  const title = reportTitle || 'GSTR-1 Report';

  // Clean content: remove action buttons before printing
  const clone = el.cloneNode(true);
  clone.querySelectorAll('.action-btns, .no-print, button, input[type=file], .btn').forEach(b => b.remove());
  const content = clone.innerHTML;

  const letterhead = p ? `
    <div style="border:2.5px solid #004d40;border-radius:8px;padding:14px 20px;margin-bottom:0;background:#f0faf9;">
      <table style="width:100%;border:none;margin:0;">
        <tr>
          <td style="border:none;padding:0;vertical-align:top;width:70%;">
            <div style="font-size:20px;font-weight:900;color:#004d40;letter-spacing:0.5px;text-transform:uppercase;">${p.business_name || ''}</div>
            <div style="margin-top:4px;">
              <span style="background:#004d40;color:#fff;padding:2px 10px;border-radius:4px;font-size:11px;font-weight:700;">GSTIN: ${p.gstin || 'Not Set'}</span>
            </div>
            ${p.address ? `<div style="margin-top:5px;font-size:11px;color:#444;">${p.address}${p.state?', '+p.state:''}</div>` : ''}
          </td>
          <td style="border:none;padding:0;vertical-align:top;text-align:right;">
            ${p.phone ? `<div style="font-size:11px;color:#444;">&#128222; ${p.phone}</div>` : ''}
            ${p.email ? `<div style="font-size:11px;color:#444;">&#9993; ${p.email}</div>` : ''}
            <div style="margin-top:6px;font-size:10px;color:#888;">GST Invoice &amp; GSTR-1 System</div>
          </td>
        </tr>
      </table>
    </div>` : `
    <div style="border:2px dashed #ccc;border-radius:6px;padding:10px 16px;margin-bottom:0;background:#fafafa;color:#888;font-size:12px;text-align:center;">
      <b>Business Profile not set</b> — Go to Settings &#9881; to add your company details
    </div>`;

  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    @page { margin: 12mm 14mm; size: A4; }
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 11.5px; color: #111; margin: 0; padding: 0; }

    /* ── Report header bar ─────────── */
    .rpt-title-bar {
      background: #004d40;
      color: #fff;
      text-align: center;
      padding: 7px 0;
      font-size: 14px;
      font-weight: 800;
      letter-spacing: 1px;
      text-transform: uppercase;
      margin: 10px 0 0;
    }
    .rpt-period-bar {
      background: #e0f2f1;
      color: #004d40;
      text-align: center;
      padding: 4px 0;
      font-size: 11px;
      font-weight: 600;
      border: 1px solid #b2dfdb;
      margin-bottom: 14px;
    }

    /* ── Section headers ───────────── */
    h3 {
      color: #004d40;
      font-size: 12px;
      font-weight: 700;
      margin: 16px 0 6px;
      padding: 5px 10px;
      background: #e0f2f1;
      border-left: 4px solid #004d40;
      border-radius: 0 4px 4px 0;
    }

    /* ── Tables ────────────────────── */
    table { width: 100%; border-collapse: collapse; margin-bottom: 14px; page-break-inside: auto; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    th {
      background: #004d40;
      color: #fff;
      padding: 7px 9px;
      text-align: left;
      font-size: 11px;
      font-weight: 700;
    }
    td {
      padding: 6px 9px;
      border-bottom: 1px solid #ddd;
      font-size: 11px;
      vertical-align: middle;
    }
    tr:nth-child(even) td { background: #f0faf9; }
    tfoot tr td {
      background: #004d40 !important;
      color: #fff !important;
      font-weight: 700;
      padding: 8px 9px;
      border: none;
    }

    /* ── Badges ────────────────────── */
    .badge { padding: 2px 7px; border-radius: 10px; font-size: 10px; font-weight: 700; }
    .badge-green { background: #e8f5e9; color: #2e7d32; }
    .badge-blue  { background: #e3f2fd; color: #1565c0; }

    /* ── Footer ────────────────────── */
    .print-footer {
      margin-top: 20px;
      border-top: 1.5px solid #b2dfdb;
      padding-top: 8px;
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      color: #888;
    }
    .print-footer b { color: #004d40; }

    /* ── Watermark ─────────────────── */
    .watermark {
      position: fixed;
      bottom: 40px;
      right: 30px;
      font-size: 10px;
      color: #ccc;
      transform: rotate(-45deg);
      opacity: 0.4;
      pointer-events: none;
    }
  </style>
</head>
<body>

  ${letterhead}

  <div class="rpt-title-bar">${title}</div>
  <div class="rpt-period-bar">&#128197; Generated on: ${now}</div>

  ${content}

  <div class="print-footer">
    <span>${p ? '<b>' + (p.business_name||'') + '</b> | GSTIN: ' + (p.gstin||'') : 'GST Invoice &amp; GSTR-1 Management'}</span>
    <span>Printed: ${now}</span>
  </div>

  <div class="watermark">GST REPORT</div>

  <script>window.onload = function(){ window.print(); }<\/script>
</body>
</html>`);
  w.document.close();
  showToast('Print dialog opened!');
}
