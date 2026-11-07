/* 0.14.0-0.15.0 (design D): query bar with chips in the title bar, time-range chip, timeline count filters,
 * results tabs, status-bar summary, patterns found, toolbar on selected text, Copilot badge. Usage: node test/querybar.e2e.js [selfhost URL] */
const path = require('path');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(process.env.HOME || '', '.npm-global/lib/node_modules/playwright')); }
const URL_ = process.argv[2] || 'http://127.0.0.1:8765/';
const results = [];
const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail });
const rect = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; }, sel);
const state = (page) => page.evaluate(() => ({
  chips: [...document.querySelectorAll('#filterbar .qb-chip')].map((c) => c.innerText.replace(/\s+/g, ' ').replace(/ ×$/, '')),
  time: !!document.querySelector('#filterbar .qb-chip.time'),
  count: document.querySelector('#filterbar .qb-count').hidden ? '' : document.querySelector('#filterbar .qb-count').textContent,
  shown: __tf.active.an && __tf.active.an.vis ? __tf.active.an.vis.reduce((a, x) => a + x, 0) : null,
  status: document.getElementById('st-filter').hidden ? '' : document.getElementById('st-filter').innerText.replace(/\s+/g, ' '),
  f: { from: __tf.active.filter.from, to: __tf.active.filter.to, took: __tf.active.filter.took, levels: [...__tf.active.filter.levels], include: __tf.active.filter.include, exclude: __tf.active.filter.exclude, logger: __tf.active.filter.logger, trace: __tf.active.filter.trace },
}));
const type = async (page, text) => { await page.keyboard.press('Control+k'); await page.keyboard.type(text); await page.keyboard.press('Enter'); await page.waitForTimeout(250); };

(async () => {
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL_);
  await page.waitForFunction(() => window.__tf && window.__tf.active && window.__tf.active.an, null, { timeout: 60000 });
  await page.evaluate(() => __tf.setTheme('slate'));
  let r;

  // ---- layout ----
  r = await page.evaluate(() => {
    const g = (s) => document.querySelector(s).getBoundingClientRect();
    const bar = g('#topbar'), q = g('#filterbar'), brand = g('#topbar .brand'), act = g('#topbar .top-actions'), tabs = g('#tabrow'), sig = g('#signal');
    return { inBar: q.top >= bar.top && q.bottom <= bar.bottom, clear: q.left >= brand.right && q.right <= act.left, w: Math.round(q.width), tabsBelow: tabs.top >= bar.bottom - 1 && tabs.bottom <= sig.top + 1, tabInRow: document.querySelector('#tabrow .tab') !== null };
  });
  ok('The query bar sits in the title bar between the logo and the buttons', r.inBar && r.clear && r.w >= 600, JSON.stringify(r));
  ok('File tabs have their own row between the title bar and the timeline', r.tabsBelow && r.tabInRow, JSON.stringify(r));

  // ---- typing filters ----
  await page.keyboard.press('Control+k');
  r = await page.evaluate(() => ({ focus: document.activeElement && document.activeElement.id, help: !document.querySelector('#filterbar .qb-help').hidden, ex: document.querySelectorAll('#filterbar .qb-ex').length }));
  ok('Ctrl+K puts the cursor in the query bar and shows examples', r.focus === 'qb-input' && r.help && r.ex >= 6, JSON.stringify(r));
  await page.keyboard.type('level:error');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  r = await state(page);
  ok('level:error becomes a chip and shows only errors', r.chips.includes('level: error') && r.f.levels.join() === 'ERROR' && r.shown === 4 && r.count === '4 of 20', JSON.stringify(r));
  ok('The status bar says how many entries are shown, with Copy shown and Clear filter', /4 of 20 entries shown/.test(r.status) && /Copy shown/.test(r.status) && /Clear filter/.test(r.status), r.status);
  r = await page.evaluate(() => ({ focus: document.activeElement && document.activeElement.id, value: document.getElementById('qb-input').value }));
  ok('After Enter the box is empty and still focused for the next filter', r.focus === 'qb-input' && r.value === '', JSON.stringify(r));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(200);
  r = await state(page);
  ok('Backspace in the empty box removes the last chip', r.chips.length === 0 && r.f.levels.length === 6, JSON.stringify(r));
  await type(page, 'level:warn+ logger:OrderService -validation');
  r = await state(page);
  ok('Several parts at once: level:warn+, logger:, -word', r.f.levels.sort().join() === 'ERROR,WARN' && r.f.logger === 'OrderService' && r.f.exclude === 'validation' && r.chips.length === 3, JSON.stringify(r));
  await page.click('#filterbar .qb-clear');
  await type(page, 'took>1000');
  r = await state(page);
  ok('took>1000 keeps only calls that took a second or more', r.f.took === '1000' && r.shown === 2 && r.chips.includes('took> 1000 ms'), JSON.stringify(r));
  await type(page, 'took>1.5s');
  r = await state(page);
  ok('Durations in seconds work too (took>1.5s)', r.f.took === '1500' && r.shown === 2, JSON.stringify(r));
  await page.click('#filterbar .qb-clear');
  await type(page, 'trace:c3e09f1a7b264d58');
  r = await state(page);
  ok('trace: shows one request', r.f.trace === 'c3e09f1a7b264d58' && r.shown === 2 && r.chips[0].startsWith('trace:'), JSON.stringify(r));
  await page.click('#filterbar .qb-clear');
  await type(page, '"Payment call failed"');
  r = await state(page);
  ok('A quoted phrase is a text filter (shown without regex escapes)', r.chips.includes('text: Payment call failed') && r.shown === 2, JSON.stringify(r));
  await page.click('#filterbar .qb-clear');
  await type(page, 'level:loud after:noon');
  r = await page.evaluate(() => ({ value: document.getElementById('qb-input').value, toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent }));
  ok('Parts it does not understand stay in the box with a hint', r.value === 'level:loud after:noon' && /Not understood/.test(r.toast), JSON.stringify(r));
  await page.keyboard.press('Escape');

  // ---- time range ----
  await type(page, 'time:10:16..10:17');
  r = await state(page);
  ok('time:10:16..10:17 becomes a time-range chip', r.time && r.chips.includes('time: 10:16 to 10:17') && r.f.from === '10:16' && r.f.to === '10:17', JSON.stringify(r));
  r = await page.evaluate(() => { const c = document.querySelector('#filterbar .qb-chip.time'); const cs = getComputedStyle(c); return { border: cs.borderTopColor, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), icon: !!c.querySelector('svg') }; });
  ok('The time chip looks different: accent outline and a clock icon', r.icon && r.border !== 'rgba(0, 0, 0, 0)', JSON.stringify(r));
  await page.click('#filterbar .qb-chip.time .qb-x');
  await page.waitForTimeout(200);
  r = await state(page);
  ok('× on the time chip clears the range', !r.f.from && !r.f.to && !r.time, JSON.stringify(r));
  const sb = await rect(page, '#signal');
  await page.mouse.move(sb.x + sb.w * 0.3, sb.y + sb.h * 0.7); await page.mouse.down();
  await page.mouse.move(sb.x + sb.w * 0.55, sb.y + sb.h * 0.7, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(300);
  r = await state(page);
  ok('Dragging on the timeline adds the time chip', r.time && r.f.from && r.f.to && r.shown > 0 && r.shown < 20, JSON.stringify(r));
  await page.mouse.dblclick(sb.x + sb.w * 0.8, sb.y + sb.h * 0.7);
  await page.waitForTimeout(300);
  r = await state(page);
  ok('Double-clicking the timeline removes the time chip', !r.time && !r.f.from && !r.f.to, JSON.stringify(r));

  // ---- timeline counts ----
  await page.click('#signal .sig-pill.e');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ levels: [...__tf.active.filter.levels], pressed: document.querySelector('#signal .sig-pill.e').getAttribute('aria-pressed'), from: __tf.active.filter.from }));
  ok('Clicking "4 errors" on the timeline shows only errors (and does not set a time range)', r.levels.join() === 'ERROR' && r.pressed === 'true' && !r.from, JSON.stringify(r));
  await page.click('#signal .sig-pill.e');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => [...__tf.active.filter.levels].length);
  ok('Clicking it again shows every level', r === 6, String(r));

  // ---- commands and plain files ----
  await type(page, '>split');
  r = await page.evaluate(() => ({ open: !document.getElementById('palette').hidden, q: document.getElementById('palette-input').value }));
  ok('Typing > runs a command: opens the palette with the text', r.open && r.q === 'split', JSON.stringify(r));
  await page.keyboard.press('Escape');
  await page.evaluate(() => __tf.activate(__tf.newTab({ name: 'notes.md', content: 'alpha\nbeta gamma\nbeta' })));
  await page.waitForTimeout(200);
  await type(page, 'beta');
  r = await page.evaluate(() => { const fc = __tf.editor.getContribution('editor.contrib.findController'); const st = fc.getState(); return { str: st.searchString, revealed: st.isRevealed, matches: st.matchesCount, ph: document.getElementById('qb-input').placeholder }; });
  ok('In a file that is not a log, the box finds text', r.str === 'beta' && r.revealed && r.matches === 2 && /Find/.test(r.ph), JSON.stringify(r));
  await page.keyboard.press('Escape');
  await page.evaluate(() => { __tf.activate(__tf.tabs.find((t) => /sample/.test(t.name))); });
  await page.waitForTimeout(200);

  // ---- results tabs ----
  await page.evaluate(() => __tf.autoTables());
  await page.waitForTimeout(500);
  await page.evaluate(() => __tf.openSearch());
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ tabs: __tf.panelTabs, ui: document.querySelectorAll('#panel-tabs .ptab').length, titleHidden: document.getElementById('panel-title').hidden, list: !!document.querySelector('#panel-body .at-list') }));
  ok('Two kinds of results are two tabs under the editor', r.tabs.length === 2 && r.ui === 2 && r.titleHidden && r.tabs[1].on && !r.list, JSON.stringify(r));
  await page.click('#panel-tabs .ptab:first-child .ptab-name');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ list: !!document.querySelector('#panel-body .at-list'), split: document.getElementById('panel-body').classList.contains('at-split'), on: __tf.panelTabs.findIndex((t) => t.on) }));
  ok('Switching back shows the auto tables exactly as they were', r.list && r.split && r.on === 0, JSON.stringify(r));
  await page.click('#panel-tabs .ptab:nth-child(2) .ptab-x');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ n: __tf.panelTabs.length, tabsShown: !document.getElementById('panel-tabs').hidden, title: document.getElementById('panel-title').textContent, panel: !document.getElementById('panel').hidden }));
  ok('Closing one result keeps the other; with one left the plain title comes back', r.n === 1 && !r.tabsShown && r.panel && /pattern/.test(r.title), JSON.stringify(r));

  // ---- 0.15.0: patterns found, toolbar on selected text, Copilot badge ----
  await page.evaluate(() => { __tf.clearFilter(); __tf.showView('extract'); });
  await page.waitForTimeout(400);
  r = await page.evaluate(() => ({ head: (document.querySelector('.pf-group h3') || {}).textContent, n: document.querySelectorAll('.pf-item').length, first: (document.querySelector('.pf-item .pf-count') || {}).textContent }));
  ok('Extract data lists the patterns found, with row counts, without pressing anything', /Patterns found · \d+/.test(r.head) && r.n >= 5 && /rows?$/.test(r.first), JSON.stringify(r));
  await page.click('.pf-item >> nth=1');
  await page.waitForTimeout(300);
  r = await page.evaluate(() => ({ panel: !document.getElementById('panel').hidden, sel: __tf.autoState && __tf.autoState.selected && __tf.autoState.selected.count, on: [...document.querySelectorAll('.pf-item')].findIndex((x) => x.classList.contains('on')), rows: document.querySelectorAll('#panel-body table tr').length }));
  ok('One click on a pattern opens its table under the editor and marks it in the list', r.panel && r.sel > 0 && r.on === 1 && r.rows > 1, JSON.stringify(r));
  await page.evaluate(() => __tf.hideSide && __tf.hideSide());
  const sel = await page.evaluate(() => { const ed = __tf.editor; ed.revealLineInCenter(9); const a = ed.getScrolledVisiblePosition({ lineNumber: 9, column: 1 }); const c = ed.getScrolledVisiblePosition({ lineNumber: 10, column: 40 }); const r = ed.getDomNode().getBoundingClientRect(); return { x1: r.left + a.left + 2, y1: r.top + a.top + 5, x2: r.left + c.left, y2: r.top + c.top + 5, line9: r.top + a.top }; });
  await page.mouse.move(sel.x1, sel.y1); await page.mouse.down(); await page.mouse.move(sel.x2, sel.y2, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(450);
  r = await page.evaluate(() => { const n = document.querySelector('.selbar'); const b = n.getBoundingClientRect(); return { on: n.classList.contains('on'), btns: [...n.querySelectorAll('.sb-btn')].filter((x) => !x.hidden).map((x) => x.textContent), bottom: b.bottom }; });
  ok('Selecting lines shows a toolbar just above them', r.on && r.btns.includes('Table from selection') && r.btns.includes('Ask Copilot') && r.btns.includes('Copy masked') && r.bottom <= sel.line9 + 2 && r.bottom >= sel.line9 - 40, JSON.stringify(Object.assign(r, { line9: sel.line9 })));
  ok('"Show only entries with this" is offered only for a short one-line selection', !r.btns.includes('Show only entries with this'), JSON.stringify(r.btns));
  await page.click('.selbar .sb-btn:has-text("Table from selection")');
  await page.waitForTimeout(300);
  r = await page.evaluate(() => ({ on: document.querySelector('.selbar').classList.contains('on'), tabs: __tf.panelTabs.map((t) => t.mode) }));
  ok('Table from selection opens a table view (as its own result tab) and hides the toolbar', !r.on && r.tabs.includes('table'), JSON.stringify(r));
  await page.evaluate(() => { const ed = __tf.editor; ed.focus(); ed.setPosition({ lineNumber: 9, column: 1 }); });
  await page.keyboard.press('End');
  await page.keyboard.down('Shift'); for (let i = 0; i < 16; i++) await page.keyboard.press('ArrowLeft'); await page.keyboard.up('Shift');
  await page.waitForTimeout(450);
  r = await page.evaluate(() => ({ on: document.querySelector('.selbar').classList.contains('on'), only: !document.querySelector('.selbar .sb-btn:nth-child(3)').hidden, text: __tf.active.model.getValueInRange(__tf.editor.getSelection()) }));
  ok('Selecting with the keyboard shows it too, with "Show only entries with this" for one line', r.on && r.only, JSON.stringify(r));
  await page.click('.selbar .sb-btn:has-text("Show only entries with this")');
  await page.waitForTimeout(300);
  r = await page.evaluate(() => ({ trace: __tf.active.filter.trace, chips: [...document.querySelectorAll('#filterbar .qb-chip')].map((c) => c.innerText.replace(/\s+/g, ' ')) }));
  ok('"Show only entries with this" filters the log and shows a chip', r.trace && r.chips.some((c) => c.startsWith('trace:')), JSON.stringify(r));
  await page.evaluate(() => __tf.clearFilter());
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  r = await page.evaluate(() => document.querySelector('.selbar').classList.contains('on'));
  ok('The toolbar goes away when the selection does', r === false, String(r));
  r = await page.evaluate(() => { const b = document.querySelector('#cp-fab .cp-badge'); return { n: b && b.textContent, title: document.getElementById('cp-fab').title, errors: __tf.active.an.counts.ERROR }; });
  ok('The Copilot button shows how many errors this log has', r.n === String(r.errors) && /4 errors/.test(r.title), JSON.stringify(r));
  await page.evaluate(() => __tf.activate(__tf.tabs.find((t) => t.name === 'notes.md')));
  await page.waitForTimeout(200);
  r = await page.evaluate(() => !!document.querySelector('#cp-fab .cp-badge'));
  ok('No badge on a file without errors', r === false, String(r));
  await page.evaluate(() => { __tf.activate(__tf.tabs.find((t) => /sample/.test(t.name))); });
  await page.waitForTimeout(200);

  // ---- appearance: light theme and phone ----
  await page.evaluate(() => { __tf.setTheme('paper'); __tf.applyQuery('level:error'); });
  await page.waitForTimeout(200);
  r = await page.evaluate(() => {
    const chip = document.querySelector('#filterbar .qb-chip');
    const lum = (c) => { const m = c.match(/\d+(\.\d+)?/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
    const fg = getComputedStyle(chip.querySelector('b')).color; const bg = getComputedStyle(document.getElementById('filterbar')).backgroundColor;
    const a = lum(fg), b = lum(bg); return { ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 10) / 10 };
  });
  ok('Chip text is readable in the light theme (4.5:1 or more)', r.ratio >= 4.5, JSON.stringify(r));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  r = await page.evaluate(() => {
    const q = document.getElementById('filterbar').getBoundingClientRect(), bar = document.getElementById('topbar').getBoundingClientRect();
    return { hscroll: document.documentElement.scrollWidth > innerWidth, w: Math.round(q.width), below: q.top > bar.top + 30, chip: !!document.querySelector('#filterbar .qb-chip'), count: !document.querySelector('#filterbar .qb-count').hidden && getComputedStyle(document.querySelector('#filterbar .qb-count')).display !== 'none' };
  });
  ok('On a phone the query bar gets its own full-width row; nothing scrolls sideways', !r.hscroll && r.w >= 360 && r.below && r.chip && r.count, JSON.stringify(r));
  await page.click('#qb-input');
  await page.waitForTimeout(150);
  r = await page.evaluate(() => { const h = document.querySelector('#filterbar .qb-help').getBoundingClientRect(); return { l: h.left, r: h.right, vw: innerWidth, shown: h.width > 0 }; });
  ok('The examples list fits on a phone screen', r.shown && r.l >= 0 && r.r <= r.vw, JSON.stringify(r));

  ok('No errors', errors.length === 0, errors.join(' | ') || 'none');
  let pass = 0;
  for (const x of results) { if (x.pass) pass++; console.log((x.pass ? 'PASS ' : 'FAIL ') + x.name + '  —  ' + x.detail); }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exitCode = pass === results.length ? 0 : 1;
})().catch((e) => { console.error('QUERY BAR TESTS FAILED', e); process.exit(2); });
