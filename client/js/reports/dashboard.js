// =============================================
// Dashboard Logic — Charts only
// Data loading is handled in dashboard.html script
// =============================================
let charts = {};

function renderCharts(b2b, b2c) {
  Object.values(charts).forEach(c => { try { c.destroy(); } catch(e){} });
  charts = {};

  const now = new Date();
  const selYear  = typeof getSelectedYear  === 'function' ? getSelectedYear()  : now.getFullYear();
  const selMonth = typeof getSelectedMonth === 'function' ? getSelectedMonth() : 'all';

  // Build 6-month labels for trend charts
  const months = [];
  if (selMonth === 'all') {
    for (let i = 5; i >= 0; i--) {
      const d = new Date(selYear, now.getMonth() - i, 1);
      months.push({ label: d.toLocaleString('default',{month:'short',year:'2-digit'}), key: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}` });
    }
  } else {
    // Single month selected — show day-wise? No, show last 6 months up to selected
    const mo = parseInt(selMonth);
    for (let i = 5; i >= 0; i--) {
      const d = new Date(selYear, mo - 1 - i, 1);
      months.push({ label: d.toLocaleString('default',{month:'short',year:'2-digit'}), key: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}` });
    }
  }

  const monthlyB2B = months.map(m => b2b.filter(r => r.invoice_date?.startsWith(m.key)).reduce((s,r)=>s+ +r.taxable_amount,0));
  const monthlyB2C = months.map(m => b2c.filter(r => r.invoice_date?.startsWith(m.key)).reduce((s,r)=>s+ +r.taxable_amount,0));
  const monthlyGST = months.map(m => {
    const mb = b2b.filter(r=>r.invoice_date?.startsWith(m.key)).reduce((s,r)=>s+ +r.gst_amount,0);
    const mc = b2c.filter(r=>r.invoice_date?.startsWith(m.key)).reduce((s,r)=>s+ +r.gst_amount,0);
    return mb + mc;
  });

  const all   = [...b2b, ...b2c];
  const igst  = all.reduce((s,r)=>s+ +r.igst,0);
  const cgst  = all.reduce((s,r)=>s+ +r.cgst,0);
  const sgst  = all.reduce((s,r)=>s+ +r.sgst,0);

  const makeChart = (id, type, data, opts={}) => {
    const ctx = document.getElementById(id)?.getContext('2d');
    if (!ctx) return;
    charts[id] = new Chart(ctx, {
      type, data,
      options: {
        responsive: true, maintainAspectRatio: true,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
        ...opts
      }
    });
  };

  makeChart('chartSales', 'bar', {
    labels: months.map(m=>m.label),
    datasets: [
      { label: 'B2B', data: monthlyB2B, backgroundColor: 'rgba(0,121,107,0.75)', borderRadius: 4 },
      { label: 'B2C', data: monthlyB2C, backgroundColor: 'rgba(38,166,154,0.5)',  borderRadius: 4 }
    ]
  }, { scales: { y: { beginAtZero: true } } });

  makeChart('chartGST', 'line', {
    labels: months.map(m=>m.label),
    datasets: [{ label: 'GST Collected', data: monthlyGST, borderColor: '#00796b', backgroundColor: 'rgba(0,121,107,0.08)', tension: 0.4, fill: true, pointRadius: 4 }]
  }, { scales: { y: { beginAtZero: true } } });

  const b2bTot = b2b.reduce((s,r)=>s+ +r.taxable_amount,0);
  const b2cTot = b2c.reduce((s,r)=>s+ +r.taxable_amount,0);
  makeChart('chartB2BvsB2C', 'doughnut', {
    labels: ['B2B Taxable', 'B2C Taxable'],
    datasets: [{ data: [b2bTot, b2cTot], backgroundColor: ['#00796b','#26a69a'], borderWidth: 2 }]
  });

  makeChart('chartTaxType', 'pie', {
    labels: ['IGST','CGST','SGST'],
    datasets: [{ data: [igst,cgst,sgst], backgroundColor: ['#1565c0','#e65100','#6a1b9a'], borderWidth: 2 }]
  });
}
