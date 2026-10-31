// Invoice List - the layout contract.
//
// The page was restyled for layout only: it gained class hooks and nothing
// else. These guard the three things a layout fix like this can quietly get
// wrong - it leaks out of the page it was meant for, it reaches the width it
// wanted by throwing away padding or squeezing figures, or it moves something
// the list's script depends on.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const rdRaw = (...p) => fs.readFileSync(path.join(ROOT, ...p));
const rd = (...p) => rdRaw(...p).toString('utf8');
// The working tree is CRLF on Windows and LF on the host; neither should
// decide whether a test passes.
const norm = (s) => s.replace(/\r\n/g, '\n');

const HTML = norm(rd('invoice-list.html'));
const LIST = norm(rd('client', 'js', 'pages', 'invoice-list.js'));
const CSS = norm(rd('client', 'css', 'style.css'));

// ---- the page's own section of the stylesheet ----------------------------
const MARK = 'Invoice List page (invoice-list.html)';
const END = '/* end Invoice List */';
function section() {
  const at = CSS.indexOf(MARK);
  const end = CSS.indexOf(END);
  assert.ok(at > -1 && end > at, 'one delimited section');
  return CSS.slice(CSS.lastIndexOf('/*', at), end);
}
const SECTION = section();
const BARE = SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

// Every rule in the section as [mediaMaxWidth | null, selector, declarations].
// The section nests one level deep (a rule inside a media query) and no
// declaration contains a brace, which is all this needs to be exact.
function rules(text) {
  const out = [];
  let media = null, depth = 0, buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      const sel = buf.trim();
      buf = '';
      if (sel.startsWith('@media')) {
        const m = /max-width:\s*(\d+)px/.exec(sel);
        assert.ok(m, 'every media query is a max-width: ' + sel);
        media = Number(m[1]);
        depth = 1;
      } else {
        const close = text.indexOf('}', i);
        assert.ok(close > i, 'unclosed rule: ' + sel);
        out.push([media, sel, text.slice(i + 1, close)]);
        i = close;
        if (depth === 0) media = null;
      }
    } else if (ch === '}') {
      if (depth === 1) { depth = 0; media = null; }
      buf = '';
    } else {
      buf += ch;
    }
  }
  return out;
}
const RULES = rules(BARE);
// The walk above leans on the section's formatting, so a reformat that it
// could not follow fails here rather than silently skipping rules.
assert.equal(RULES.filter((r) => r[0] !== null).length > 0, true);
assert.equal((BARE.match(/@media/g) || []).length,
  new Set(RULES.filter((r) => r[0] !== null).map((r) => r[0])).size,
  'every @media block was parsed');

const declsOf = (selector, media = null) => RULES
  .filter((r) => r[0] === media && r[1] === selector).map((r) => r[2]).join(';');
const has = (selector, decl, media = null) =>
  declsOf(selector, media).replace(/\s+/g, ' ').includes(decl);

// What .inv-list-page's tokens resolve to at a viewport width: the base
// block, then every max-width query that applies, in source order.
function tokensAt(width) {
  const out = {};
  for (const [media, sel, decls] of RULES) {
    if (sel !== '.inv-list-page') continue;
    if (media !== null && width > media) continue;
    for (const m of decls.matchAll(/(--il-[a-z-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  }
  return out;
}
// Does a declaration apply at this width? Last writer wins.
function appliedAt(selector, prop, width) {
  let value = null;
  for (const [media, sel, decls] of RULES) {
    if (sel !== selector) continue;
    if (media !== null && width > media) continue;
    const m = new RegExp(prop + '\\s*:\\s*([^;]+);').exec(decls);
    if (m) value = m[1].trim();
  }
  return value;
}

test('IL1 the page carries the scope and every hook the new styles need', () => {
  assert.match(HTML, /<div class="content inv-list-page">/);
  for (const hook of [
    'class="text-muted-sm mb-16 inv-list-intro"',
    'class="card inv-list-card"',
    'class="card-header inv-list-head"',
    'class="d-flex gap-10 flex-wrap inv-list-filters"',
    'class="form-control w-220 inv-list-sort"',
    'btn btn-secondary btn-sm text-nowrap inv-list-migrate',
    'class="table-wrapper inv-list-scroll"',
    'class="data-table inv-list-table"'
  ]) assert.ok(HTML.includes(hook), 'missing hook: ' + hook);
  // The hooks are additions. Every shared class the page had is still on it,
  // so nothing that styled it before has stopped applying.
  for (const kept of ['content', 'card', 'card-header', 'd-flex', 'gap-10', 'flex-wrap',
    'table-wrapper', 'data-table', 'card-body p-0', 'text-muted-sm']) {
    assert.ok(HTML.includes(kept), 'dropped shared class: ' + kept);
  }
  // And no other page adopted the scope.
  const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
  const scoped = pages.filter((f) => rd(f).includes('inv-list-page'));
  assert.deepStrictEqual(scoped, ['invoice-list.html']);
});

test('IL2 the new styles are scoped to this page alone, with no !important', () => {
  assert.ok(RULES.length > 25, 'the section was found and parsed');
  for (const [, selector] of RULES) {
    for (const sel of selector.split(',').map((s) => s.trim())) {
      assert.ok(sel.startsWith('.inv-list-page') || sel.startsWith(':root[data-theme="dark"] .inv-list-page'),
        'unscoped selector: ' + sel);
    }
  }
  // Colours come from page tokens that the app's dark theme swaps, the same
  // arrangement the Purchase Orders list uses.
  assert.match(SECTION, /:root\[data-theme="dark"\] \.inv-list-page \{[^}]*--il-ink:/);
  assert.equal(/!important/.test(SECTION), false, 'no !important');
});

test('IL3 the shared layout rules are untouched, so no other page moves', () => {
  // Pinned verbatim: these are what every other page's width comes from.
  for (const rule of [
    '.app-layout { display: flex; min-height: 100vh; }',
    '.content { padding: 24px; flex: 1; }',
    '.table-wrapper { overflow-x: auto; }',
    '.card-body { padding: 20px; }',
    '.data-table thead th { padding: 11px 14px; text-align: left; font-weight: 600; font-size: 12px; white-space: nowrap; }',
    '.data-table tbody td { padding: 10px 14px; white-space: nowrap; }',
    '.action-btns { display: flex; gap: 4px; flex-wrap: nowrap; }'
  ]) assert.ok(CSS.includes(rule), 'shared rule changed: ' + rule);
  assert.match(CSS, /\.main-content \{\n  margin-left: var\(--sidebar-w\);\n  flex: 1;/);
  assert.match(CSS, /table\.data-table \{\n  width: 100%;\n  border-collapse: collapse;/);
  // The section redeclares nothing shared: it only adds rules of its own.
  for (const [, selector] of RULES) {
    for (const sel of selector.split(',').map((s) => s.trim())) {
      assert.notEqual(sel, '.inv-list-page .content');
      assert.notEqual(sel, '.inv-list-page .table-wrapper');
      assert.notEqual(sel, '.inv-list-page .data-table');
    }
  }
});

test('IL4 the page keeps its side padding, and nothing indents or caps the card', () => {
  // Side padding is preserved, not removed: the page's own 24px stays, and
  // the card's header padding is the same on both sides.
  assert.ok(CSS.includes('.content { padding: 24px; flex: 1; }'));
  assert.ok(has('.inv-list-page .inv-list-head', 'padding: 14px var(--il-pad-x);'),
    'the header pads equally from one token');
  for (const w of [1650, 1366, 1024, 768]) {
    const pad = tokensAt(w)['--il-pad-x'];
    assert.ok(parseInt(pad, 10) >= 16, `--il-pad-x is still real padding at ${w}px: ${pad}`);
  }
  // The card takes the content column and is neither centred nor capped.
  assert.ok(has('.inv-list-page .inv-list-card', 'width: 100%;'));
  assert.equal(/margin(-left|-right)?\s*:\s*(auto|\d)/.test(declsOf('.inv-list-page .inv-list-card')), false);
  assert.equal(/max-width/.test(declsOf('.inv-list-page .inv-list-card')), false);
  // The intro line is prose and may be measured; nothing else is.
  // max-width:none lifts a shared cap rather than adding one, so only a
  // real length counts here.
  const capped = RULES.filter((r) => [...r[2].matchAll(/max-width:\s*([^;]+);/g)]
    .some((m) => m[1].trim() !== 'none')).map((r) => r[1]);
  assert.deepStrictEqual(capped, ['.inv-list-page .inv-list-intro']);
});

test('IL5 the table scrolls inside its own wrapper, never the page or the sidebar', () => {
  assert.ok(has('.inv-list-page .inv-list-scroll', 'overflow-x: auto;'));
  assert.ok(has('.inv-list-page .inv-list-scroll', '-webkit-overflow-scrolling: touch;'));
  // The page itself still cannot scroll sideways, so the sidebar cannot move.
  assert.match(CSS, /\.main-content \{[^}]*overflow-x: hidden;/);
  // The scroll rail is reachable: the app's 6px default is a width, which a
  // horizontal bar does not use.
  assert.ok(has('.inv-list-page .inv-list-scroll::-webkit-scrollbar', 'height: 10px;'));
  // Wide on a wide screen, and never compressed on a narrow one.
  assert.equal(appliedAt('.inv-list-page .inv-list-table', 'min-width', 1650), '100%');
  assert.equal(appliedAt('.inv-list-page .inv-list-table', 'min-width', 1366), '100%');
  assert.equal(appliedAt('.inv-list-page .inv-list-table', 'min-width', 1024), '1180px');
  assert.equal(appliedAt('.inv-list-page .inv-list-table', 'min-width', 768), '1180px');
  // Nothing in the section hides the overflow instead of scrolling it.
  for (const [, sel, decls] of RULES) {
    assert.equal(/overflow[^:]*:\s*hidden/.test(decls), false, 'clipped instead of scrolled: ' + sel);
  }
});

test('IL6 header and body column widths stay in step', () => {
  // One table holds thead, tbody and tfoot, so a column is measured once.
  assert.equal((HTML.match(/<table/g) || []).length, 1);
  assert.match(HTML, /<table class="data-table inv-list-table">\s*<thead>/);
  assert.ok(HTML.includes('<tbody id="invListTableBody">'));
  assert.ok(HTML.includes('<tfoot id="invListTableTotal">'));
  // Auto layout, so the header and its cells size together. A fixed layout
  // would make each <th> width the column width and let the two drift.
  assert.equal(/table-layout/.test(SECTION), false, 'the layout stays auto');
  // Cell padding comes from one token on every row type, so a column's
  // header and body cells are inset identically.
  for (const row of ['thead th', 'tbody td', 'tfoot td']) {
    assert.match(declsOf('.inv-list-page .inv-list-table ' + row),
      /padding: \d+px var\(--il-cell-x\);/, row + ' pads from the shared token');
  }
});

test('IL7 row actions stay reachable at the far right', () => {
  const sticky = '.inv-list-page .inv-list-table thead th:last-child,\n.inv-list-page .inv-list-table tbody td:last-child,\n.inv-list-page .inv-list-table tfoot td:last-child';
  assert.ok(BARE.includes(sticky), 'all three row types pin the last column');
  assert.ok(has(sticky, 'position: sticky; right: 0;'));
  // A sticky cell is transparent, so each one paints the background its row
  // would have shown - otherwise the scrolling columns show through it.
  assert.ok(has('.inv-list-page .inv-list-table thead th:last-child', 'background: var(--primary-dark);'));
  assert.ok(has('.inv-list-page .inv-list-table tbody td:last-child', 'background: var(--card-bg);'));
  assert.ok(has('.inv-list-page .inv-list-table tfoot td:last-child', 'background: var(--primary-xlight);'));
  assert.ok(has('.inv-list-page .inv-list-table tbody tr:hover td:last-child', 'background: var(--primary-xlight);'));
  // The table's borders are collapsed, which means a row's border belongs to
  // the table and the opaque sticky cell covers it. Each pinned cell redraws
  // the line it hides.
  assert.ok(CSS.includes('border-collapse: collapse'));
  assert.match(declsOf('.inv-list-page .inv-list-table tbody td:last-child'), /inset 0 -1px 0 var\(--border\)/);
  assert.match(declsOf('.inv-list-page .inv-list-table tfoot td:last-child'), /inset 0 2px 0 var\(--primary-light\)/);
  // --card-bg and --primary-xlight are swapped at :root, so both themes are
  // covered by those two tokens alone.
  assert.match(CSS, /:root\[data-theme="dark"\] \{[^}]*--card-bg: #1b2523;/);
  assert.match(CSS, /:root\[data-theme="dark"\] \{[^}]*--primary-xlight: #16302c;/);
  // The loading and empty rows are one cell spanning the table, which is
  // also the last child: it must scroll with the rest.
  assert.ok(has('.inv-list-page .inv-list-table tbody td[colspan]', 'position: static;'));
  assert.ok(BARE.indexOf('td[colspan]') > BARE.indexOf('tbody td:last-child'),
    'the colspan guard is declared after the rule it overrides');
  // Nine buttons per row, each a measured square rather than text padding.
  assert.ok(has('.inv-list-page .inv-list-table .action-btns .btn',
    'width: var(--il-act-btn); height: var(--il-act-btn); padding: 0; justify-content: center;'));
  for (const w of [1650, 1499, 1366, 1024, 768]) {
    const size = parseInt(tokensAt(w)['--il-act-btn'], 10);
    assert.ok(size >= 27 && size <= 32, `action buttons stay tappable at ${w}px: ${size}px`);
  }
});

test('IL8 the filter toolbar fills the card width and every control can shrink', () => {
  // A row of its own, instead of competing with the card title for what was
  // left of the header.
  assert.ok(has('.inv-list-page .inv-list-head', 'flex-direction: column; align-items: stretch;'));
  assert.ok(has('.inv-list-page .inv-list-filters', 'width: 100%;'));
  // min-width:0 on every child is what lets the row fill the card rather
  // than wrap as soon as the fixed .w-* widths overflow it.
  assert.ok(has('.inv-list-page .inv-list-filters > *', 'min-width: 0;'));
  assert.match(declsOf('.inv-list-page .inv-list-filters > .form-control'), /flex: 1 1 \d+px; min-width: \d+px;/);
  // The selects are the direct children and are sized by flex. The search box
  // is an <input> nested in .search-input-wrap, and an input at width:auto
  // falls back to its default size attribute instead of filling its wrapper,
  // so it has to keep the shared width:100%.
  assert.ok(has('.inv-list-page .inv-list-filters > .form-control', 'width: auto;'));
  assert.equal(/width:\s*auto/.test(declsOf('.inv-list-page .inv-list-filters .form-control')), false,
    'the descendant rule must not reach the search input');
  assert.match(declsOf('.inv-list-page .inv-list-filters > .search-input-wrap'), /flex: 2 1 \d+px;/);
  assert.match(declsOf('.inv-list-page .inv-list-filters > .inv-list-sort'), /flex: 2 1 \d+px;/);
  // One height for every control, so the search box, the selects and Series
  // Migration sit on one line.
  assert.ok(has('.inv-list-page .inv-list-filters .form-control', 'height: var(--il-ctl-h);'));
  assert.ok(has('.inv-list-page .inv-list-filters > .inv-list-migrate', 'height: var(--il-ctl-h);'));
  // Series Migration sits at the far right of the toolbar on a wide screen.
  assert.equal(appliedAt('.inv-list-page .inv-list-filters > .inv-list-migrate', 'margin-left', 1650), 'auto');
  // On a phone it spans the row instead of hanging off the end of a short one.
  assert.equal(appliedAt('.inv-list-page .inv-list-filters > .inv-list-migrate', 'margin-left', 768), '0');
  assert.equal(appliedAt('.inv-list-page .inv-list-filters > .inv-list-migrate', 'flex', 768), '1 1 100%');
  assert.equal(appliedAt('.inv-list-page .inv-list-filters > .search-input-wrap', 'flex', 768), '1 1 100%');
  // Filters wrap into even rows rather than overlapping: three up on a
  // tablet-width phone, two at 640px, one at 480px.
  assert.equal(appliedAt('.inv-list-page .inv-list-filters > .form-control', 'flex', 768), '1 1 calc(33.333% - 6px)');
  assert.equal(appliedAt('.inv-list-page .inv-list-filters > .form-control', 'flex', 640), '1 1 calc(50% - 4px)');
  assert.equal(appliedAt('.inv-list-page .inv-list-filters > .form-control', 'flex', 480), '1 1 100%');
  // Touch targets grow on a phone.
  assert.ok(parseInt(tokensAt(768)['--il-ctl-h'], 10) >= 42);
});

test('IL9 the ladder covers 1650 / 1366 / 1024 / 768 and only ever narrows', () => {
  const steps = [...new Set(RULES.filter((r) => r[0] !== null).map((r) => r[0]))];
  assert.deepStrictEqual(steps, [1499, 1366, 1180, 768, 640, 480],
    'every breakpoint is a max-width step, in descending order');
  // A 1650px screen gets the base block and nothing else, so the desktop
  // layout cannot be changed by a narrow-screen rule.
  assert.deepStrictEqual(Object.keys(tokensAt(1650)).sort(), [
    '--il-act-btn', '--il-act-gap', '--il-cell-x', '--il-ctl-font', '--il-ctl-h',
    '--il-font', '--il-head-font', '--il-ink', '--il-line', '--il-pad-x', '--il-rail'
  ]);
  // Cell padding tightens through the widths where the columns can still sit
  // side by side, then relaxes once the table scrolls instead.
  const cell = (w) => parseInt(tokensAt(w)['--il-cell-x'], 10);
  assert.ok(cell(1650) > cell(1499), 'tighter at 1440-1499 than at 1650');
  assert.ok(cell(1499) > cell(1366), 'tighter again at 1366');
  assert.ok(cell(1024) > cell(1366), 'comfortable again once it scrolls');
  assert.equal(cell(1024), cell(768), 'tablet and phone read the same');
  // Figures never shrink to the point of being unreadable.
  for (const w of [1650, 1499, 1366, 1180, 1024, 768, 640, 480]) {
    const t = tokensAt(w);
    assert.ok(parseFloat(t['--il-font']) >= 12.5, `body text at ${w}px: ${t['--il-font']}`);
    assert.ok(parseFloat(t['--il-head-font']) >= 11.5, `header text at ${w}px: ${t['--il-head-font']}`);
  }
  // The sidebar's own behaviour is the app's, untouched by this page.
  assert.match(CSS, /@media \(max-width: 768px\) \{\n  \.sidebar \{ transform: translateX\(-100%\); \}/);
  for (const [, sel] of RULES) assert.equal(/\.sidebar/.test(sel), false, 'the section never styles the sidebar');
});

test('IL10 the row, totals and loading contract is unchanged', () => {
  const head = HTML.slice(HTML.indexOf('<thead>'), HTML.indexOf('</thead>'));
  assert.deepStrictEqual([...head.matchAll(/<th>([^<]*)<\/th>/g)].map((m) => m[1]),
    ['#', 'Invoice No', 'Source', 'Date', 'Customer', 'Type', 'State',
      'Total', 'Paid', 'Balance', 'Payment', 'Actions']);
  // Twelve columns, so every full-width cell spans twelve. The loading row
  // spanned ten, which left it short of the table's own width.
  assert.ok(HTML.includes('<td colspan="12" class="empty-state">'), 'the loading row spans the table');
  assert.equal(/colspan="1[01]"/.test(HTML.slice(HTML.indexOf('<tbody id="invListTableBody">'),
    HTML.indexOf('</tbody>'))), false);
  assert.match(LIST, /<td colspan="12" class="empty-state">/);
  const footAt = LIST.indexOf('<tr><td colspan="7"');
  const foot = LIST.slice(footAt, LIST.indexOf('</tr>', footAt));
  assert.match(foot, /<td colspan="7"/);
  assert.equal((foot.match(/<td/g) || []).length, 6, 'colspan 7 plus five cells is twelve columns');
  // The row itself: twelve cells, nine actions, in their existing order.
  const rowAt = LIST.indexOf('<tr data-invoice-id=');
  const row = LIST.slice(rowAt, LIST.indexOf('</tr>', rowAt));
  assert.equal((row.match(/<td[ >]/g) || []).length, 12);
  const actions = row.slice(row.indexOf('<div class="action-btns">'));
  assert.deepStrictEqual([...actions.matchAll(/title="([^"]+)"/g)].map((m) => m[1]),
    ['View', 'Edit', 'Duplicate', 'Download PDF', 'Print', 'Share via WhatsApp',
      'Email PDF', 'View warranties for this invoice', 'Delete']);
  // Sorting, filtering and paging are still wired to the same handlers.
  for (const hook of ['applyInvoiceListFilters()', 'onInvoiceListSortChange()', 'openSeriesMigrationModal()']) {
    assert.ok(HTML.includes(hook), 'lost handler: ' + hook);
  }
  for (const id of ['invListSearch', 'invListStateFilter', 'invListMonthFilter', 'invListYearFilter',
    'invListTypeFilter', 'invListSourceFilter', 'invListSortOrder', 'invListTableBody',
    'invListTableTotal', 'invListPagination']) {
    assert.ok(HTML.includes('id="' + id + '"'), 'lost id: ' + id);
  }
});

test('IL11 only this page\'s cache key moved', () => {
  assert.ok(HTML.includes('client/css/style.css?v=44'));
  // The stylesheet is one file with a key per page, so every other page keeps
  // the key it had - this change is additive and page-scoped, so an older
  // cached copy cannot affect them.
  const keys = {};
  for (const f of fs.readdirSync(ROOT).filter((x) => x.endsWith('.html'))) {
    const m = /client\/css\/style\.css\?v=(\d+)/.exec(rd(f));
    if (m) keys[f] = m[1];
  }
  assert.equal(keys['invoice-list.html'], '44');
  assert.equal(Object.values(keys).filter((v) => v === '44').length, 1,
    'the key is unused elsewhere, so no page can serve a cached copy of the old stylesheet to this one');
  // The scripts were not touched, so their keys must not have moved either.
  assert.ok(HTML.includes('client/js/pages/invoice-list.js?v=34'));
  assert.ok(HTML.includes('client/js/utilities/utils.js?v=34'));
  assert.ok(HTML.includes('client/js/pages/profile.js?v=41'));
});

test('IL12 the server/public mirrors are byte-identical', () => {
  for (const rel of [['invoice-list.html'], ['client', 'css', 'style.css']]) {
    const src = rdRaw(...rel);
    const pub = rdRaw('server', 'public', ...rel);
    assert.ok(src.equals(pub), 'mirror differs: ' + rel.join('/') + ' - run npm run build:public');
  }
});
