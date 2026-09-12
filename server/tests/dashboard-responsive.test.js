// Dashboard on phones and tablets - the rules a later edit could quietly undo.
//
// The layout itself was measured in a real browser (headless Edge, 320 to
// 1920px wide). These guard what made it work: grid tracks that cannot be
// floored by the text inside them, fixed desktop widths that stop at 430px,
// a drawer that leaves the tab order when closed, and a desktop layout that
// is left exactly as it was.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const CSS = rd('client', 'css', 'style.css').replace(/\/\*[\s\S]*?\*\//g, '');
const DASH = rd('dashboard.html');

// The body of a brace block starting at `open` (the index of its "{").
function blockAt(css, open) {
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}' && --depth === 0) return { body: css.slice(open + 1, j), end: j };
  }
  throw new Error('unbalanced braces');
}

// Every block for one exact media query, joined.
function media(query) {
  const head = `@media ${query} {`;
  const out = [];
  for (let i = CSS.indexOf(head); i !== -1; i = CSS.indexOf(head, i + 1)) {
    out.push(blockAt(CSS, i + head.length - 1).body);
  }
  return out.join('\n');
}

// Every @media block as { query, body }, and the stylesheet without them.
function allMedia() {
  const blocks = [];
  let rest = '', from = 0;
  for (let i = CSS.indexOf('@media'); i !== -1; i = CSS.indexOf('@media', from)) {
    const open = CSS.indexOf('{', i);
    const { body, end } = blockAt(CSS, open);
    blocks.push({ query: CSS.slice(i + 6, open).trim(), body });
    rest += CSS.slice(from, i);
    from = end + 1;
  }
  return { blocks, base: rest + CSS.slice(from) };
}

// Declarations of every rule whose selector list names `selector` exactly.
function decl(block, selector) {
  const out = [];
  for (const m of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1].split(',').map(s => s.replace(/\s+/g, ' ').trim());
    if (sels.includes(selector)) out.push(m[2]);
  }
  return out.join(';');
}

const M768 = media('(max-width: 768px)');
const M430 = media('(max-width: 430px)');
const { blocks: MEDIA, base: BASE } = allMedia();
const DASH_RULES = MEDIA.filter(b => b.body.includes('.dashboard-page')).map(b => b.body).join('\n');

// ── 1. breakpoints ─────────────────────────────────────────────────────
test('R1 the Dashboard has its own 768px and 430px breakpoints', () => {
  assert.match(M768, /\.dashboard-page \.stat-grid\s*\{/, 'no tablet rules for the Dashboard');
  assert.match(M430, /\.dashboard-page \.stat-grid\s*\{/, 'no phone rules for the Dashboard');
  assert.match(DASH, /<meta name="viewport" content="width=device-width, initial-scale=1.0">/);
});

// ── 2. summary grid ────────────────────────────────────────────────────
test('R2 the summary grid is sized by the screen, never by the text in its cards', () => {
  // The original fault: repeat(2, 1fr). A bare 1fr is minmax(auto, 1fr),
  // whose "auto" floors each column at its card's nowrap content (~225px),
  // so two columns ran ~467px wide on a 390px phone.
  assert.match(decl(M430, '.dashboard-page .stat-grid'), /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(decl(M768, '.dashboard-page .stat-grid'), /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(100%,\s*\d+px\),\s*1fr\)\)/);

  // No Dashboard grid track anywhere may fall back to a content-sized minimum.
  const tracks = [...DASH_RULES.matchAll(/grid-template-columns:\s*([^;}]+)/g)].map(m => m[1].trim());
  assert.ok(tracks.length >= 4, 'expected the stat, chart and storage grids');
  for (const t of tracks) {
    const outsideMinmax = t.replace(/minmax\((?:[^()]|\([^()]*\))*\)/g, '');
    // (?<![\w-]) so the "auto" in auto-fill / auto-fit is not mistaken for a track
    assert.equal(/(?<![\w-])(1fr|auto|min-content|max-content)(?![\w-])/.test(outsideMinmax), false, `content-floored track: ${t}`);
    for (const mm of t.matchAll(/minmax\(((?:[^()]|\([^()]*\))*)\)/g)) {
      const min = mm[1].split(/,(?![^(]*\))/)[0].trim();
      assert.ok(min === '0' || /^min\(100%,\s*\d+px\)$/.test(min), `minmax minimum must be 0 or min(100%, Npx): ${t}`);
    }
  }

  // On a phone the card stacks, labels wrap, and the amount gets the full width.
  assert.match(decl(M430, '.dashboard-page .stat-card'), /flex-direction:\s*column/);
  assert.match(decl(M430, '.dashboard-page .stat-info'), /align-self:\s*stretch/);
  assert.match(decl(M768, '.dashboard-page .stat-label'), /white-space:\s*normal/);
  // Amount sizing is still the shared clamp() + fitStatValues(); no fixed size.
  assert.equal(/\.stat-value[^{]*\{[^}]*font-size/.test(DASH_RULES), false);
});

// ── 3. fixed widths ────────────────────────────────────────────────────
test('R3 no fixed desktop width or height survives on a phone', () => {
  assert.match(decl(M768, '.dashboard-page .top-bar'), /height:\s*auto/);
  assert.match(decl(M768, '.dashboard-page .top-bar'), /flex-wrap:\s*wrap/);
  assert.match(decl(M430, '.dashboard-page .dash-select-year'), /width:\s*auto/);
  const month = decl(M430, '.dashboard-page .dash-select-month');
  assert.match(month, /width:\s*auto/);
  assert.match(month, /min-width:\s*0/);
  assert.match(decl(M768, '.dashboard-page .chart-grid'), /minmax\(min\(100%,\s*\d+px\),\s*1fr\)/);
  // and nothing new is wider than the narrowest phone
  for (const m of DASH_RULES.matchAll(/(?:^|[;{\s])(min-width|width|flex-basis|flex)\s*:\s*([^;}]+)/g)) {
    for (const px of m[2].matchAll(/(\d+)px/g)) {
      assert.ok(+px[1] <= 200, `${m[1]}: ${m[2].trim()} is too wide for a 320px screen`);
    }
  }
});

// ── 4. sidebar ─────────────────────────────────────────────────────────
test('R4 the sidebar is an accessible drawer on mobile, on the existing mechanism', () => {
  assert.match(DASH, /<aside class="sidebar" id="appSidebar" aria-label="Main menu">/);
  assert.match(DASH, /<button type="button" class="menu-toggle" id="menuToggle" aria-label="[^"]+" aria-controls="appSidebar" aria-expanded="false" title="[^"]+">/);
  // still the one shared open/close (utils.js) - not a second implementation
  assert.match(DASH, /setupMobileMenu\(\);\s*\n\s*setupDrawerA11y\(\);/);
  assert.match(M768, /\.sidebar\s*\{\s*transform:\s*translateX\(-100%\)/, 'existing off-canvas rule');
  assert.match(M768, /\.sidebar\.open\s*\{\s*transform:\s*none/, 'existing open rule');
  // closed: out of the tab order; open: back in
  assert.match(decl(M768, '.dashboard-page .sidebar'), /visibility:\s*hidden/);
  assert.match(decl(M768, '.dashboard-page .sidebar.open'), /visibility:\s*visible/);
  // the links must be focusable the moment the drawer opens: a transition
  // on "all" would also animate their inherited visibility from hidden
  const itemTransition = decl(M768, '.dashboard-page .menu-item');
  assert.match(itemTransition, /transition:/);
  assert.equal(/\b(all|visibility)\b/.test(itemTransition), false, itemTransition);
  // keyboard half
  const fn = DASH.slice(DASH.indexOf('function setupDrawerA11y'), DASH.indexOf('// ── Init'));
  assert.match(fn, /setAttribute\('aria-expanded'/);
  assert.match(fn, /e\.key === 'Escape'/);
  assert.match(fn, /toggle\.focus\(\)/);
  // 44px touch target
  const t = decl(M768, '.dashboard-page .menu-toggle');
  assert.match(t, /width:\s*44px/);
  assert.match(t, /height:\s*44px/);
});

// ── 5. backup card ─────────────────────────────────────────────────────
test('R5 the backup card wraps and keeps Backup, Restore and Delete touch-sized', () => {
  assert.match(decl(M768, '.dashboard-page .storage-stats'), /display:\s*grid/);
  assert.match(decl(M768, '.dashboard-page .storage-stats > span'), /overflow-wrap:\s*anywhere/);
  assert.match(decl(M768, '.dashboard-page .storage-actions .btn'), /min-height:\s*44px/);
  assert.match(decl(M768, '.dashboard-page .storage-actions .btn-clear-data'), /min-width:\s*44px/);
  assert.match(decl(M430, '.dashboard-page .storage-actions'), /flex:\s*1 1 100%/);
  assert.match(decl(M430, '.dashboard-page .storage-stats'), /repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  // the three actions are still wired exactly as before
  assert.match(DASH, /onclick="exportLocalBackup\(\)"/);
  assert.match(DASH, /onchange="importLocalBackup\(this\.files\[0\]\)"/);
  assert.match(DASH, /onclick="confirmClearData\(\)"/);
});

// ── 6. page overflow ───────────────────────────────────────────────────
test('R6 overflow is fixed at its source, not hidden, and wide content scrolls in its own box', () => {
  assert.equal(/overflow(-x)?\s*:\s*(hidden|clip)/.test(DASH_RULES), false, 'the Dashboard rules must not hide overflow');
  assert.equal(/100vw/.test(DASH_RULES), false, '100vw includes the scrollbar and overflows');
  // the 12-month table scrolls inside its wrapper, never the page
  assert.match(DASH, /<div class="table-wrapper">\s*<table class="data-table" id="monthSummaryTable">/);
  assert.match(decl(BASE, '.table-wrapper'), /overflow-x:\s*auto/);
  // layout lives in the stylesheet, not in scattered inline styles
  assert.equal(/<style[\s>]/.test(DASH), false);
  assert.equal(/\sstyle="/.test(DASH), false);
});

// ── 7. desktop ─────────────────────────────────────────────────────────
test('R7 desktop is untouched: every Dashboard rule sits behind a max-width query', () => {
  assert.equal(BASE.includes('.dashboard-page'), false, 'a Dashboard rule outside any media query would reach desktop');
  for (const b of MEDIA.filter(x => x.body.includes('.dashboard-page'))) {
    assert.match(b.query, /^\(max-width: (768|430)px\)( and \(prefers-reduced-motion: reduce\))?$/, b.query);
  }
  // the desktop rules themselves are unchanged
  assert.match(decl(BASE, '.stat-grid'), /repeat\(auto-fill, minmax\(180px, 1fr\)\)/);
  assert.match(decl(BASE, '.chart-grid'), /repeat\(auto-fill, minmax\(340px, 1fr\)\)/);
  assert.match(decl(BASE, '.top-bar'), /height:\s*var\(--header-h\)/);
  assert.match(decl(BASE, '.dash-select-year'), /width:\s*100px/);
  assert.match(decl(BASE, '.dash-select-month'), /width:\s*150px/);
  assert.match(decl(BASE, '.storage-bar'), /padding:\s*12px 20px/);
  assert.match(decl(BASE, '.stat-value'), /text-align:\s*right/);
  // only the Dashboard opts in, so GSTR-3B, Reports and Products (which
  // share .stat-grid / .storage-bar) keep their layout
  const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
  const optedIn = pages.filter(f => rd(f).includes('dashboard-page'));
  assert.deepEqual(optedIn, ['dashboard.html']);
  // the Dashboard fetches the new stylesheet
  assert.match(DASH, /href="client\/css\/style\.css\?v=36"/);
});
