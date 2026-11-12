/* 0.14.0-0.18.1: log bar (timeline + filter row with level chips, live text box, More filters) after tracepad, time-range chip, timeline count filters,
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
  copyShown: !document.querySelector('#filterbar .lb-copy').hidden, stFilter: !!document.getElementById('st-filter'),
  f: { text: __tf.active.filter.text, from: __tf.active.filter.from, to: __tf.active.filter.to, took: __tf.active.filter.took, levels: [...__tf.active.filter.levels], include: __tf.active.filter.include, exclude: __tf.active.filter.exclude, logger: __tf.active.filter.logger, trace: __tf.active.filter.trace },
}));
let copyMenu;
const type = async (page, text) => { await page.keyboard.press('Control+k'); await page.keyboard.type(text); await page.keyboard.press('Enter'); await page.waitForTimeout(250); };

(async () => {
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL_);
  await page.waitForFunction(() => window.__tf && window.__tf.active && window.__tf.active.an, null, { timeout: 60000 });
  await page.evaluate(() => { __tf.setTheme('slate'); __tf.settings.filtersDocked = true; __tf.setFilter({}); }); // most checks use the pinned filter row; the drop down has its own section
  copyMenu = async (label) => { await page.click('#panel-tools .menu-btn'); await page.click('.menu button:has-text("' + label + '")'); };
  let r;

  // ---- layout (0.18.1: the timeline and filters form one log bar under the tabs) ----
  r = await page.evaluate(() => {
    const g = (s) => document.querySelector(s).getBoundingClientRect();
    const bar = g('#topbar'), tabs = g('#tabs'), lb = g('#logbar'), work = g('#work'), strip = g('#signal'), row = g('#filterbar'), brand = g('#topbar .brand'), act = g('#topbar .top-actions');
    return { underTabs: lb.top >= bar.bottom - 1 && lb.bottom <= work.top + 1, noTitleFilter: !document.querySelector('#topbar #qb-input'),
      tabsBelow: tabs.top >= bar.top && tabs.bottom <= bar.bottom && tabs.left >= brand.right - 1 && tabs.right <= act.left + 1 && !!document.querySelector('#topbar #tabs .tab') && !document.getElementById('tabrow'),
      stripW: Math.round(strip.width), lbW: Math.round(lb.width), rowH: Math.round(row.height), stripAbove: strip.bottom <= row.top + 1 };
  });
  ok('The file tabs are in the title bar; the timeline and filters sit right under it', r.underTabs && r.noTitleFilter && r.tabsBelow && r.stripAbove, JSON.stringify(r));
  ok('The timeline uses the full width and the filter row is one line at 1920 px', r.stripW >= r.lbW - 30 && r.rowH <= 46, JSON.stringify(r));
  r = await page.evaluate(() => ({ chips: [...document.querySelectorAll('#filterbar .lb-lvl')].map((c) => c.innerText.replace(/\s+/g, ' ')), bars: document.querySelectorAll('#signal .lb-bar').length,
    buckets: __tf.strip().buckets.length, stripW: document.getElementById('signal').clientWidth, start: document.querySelector('#logbar .lb-start').textContent, end: document.querySelector('#logbar .lb-end').textContent,
    hint: document.querySelector('#logbar .lb-hint').textContent, count: document.querySelector('#filterbar .qb-count').textContent }));
  ok('Level chips show each level with its count', r.chips.join('|') === 'ERROR 4|WARN 3|INFO 12|DEBUG 1', JSON.stringify(r.chips));
  ok('The timeline has one bar per ~7 px (like tracepad), the start and end times, and a hint', r.bars === r.buckets && r.bars === Math.max(12, Math.min(180, Math.floor(r.stripW / 7))) && /10:15:01/.test(r.start) && /10:18:12/.test(r.end) && /drag to filter/.test(r.hint) && r.count === '20 entries', JSON.stringify(r));

  // ---- level chips ----
  await page.click('#filterbar .lb-lvl[data-level="ERROR"]');
  await page.waitForTimeout(200);
  r = await state(page);
  let lv = await page.evaluate(() => [...document.querySelectorAll('#filterbar .lb-lvl')].map((c) => c.dataset.level + ':' + (c.classList.contains('on') ? 'on' : c.classList.contains('off') ? 'off' : '-')));
  ok('Clicking ERROR shows only errors; the other chips look switched off', r.f.levels.join() === 'ERROR' && r.shown === 4 && r.count === '4 of 20 entries' && lv.join() === 'ERROR:on,WARN:off,INFO:off,DEBUG:off', JSON.stringify([r.count, lv]));
  ok('Copy shown sits next to the count; the status bar no longer repeats the filter summary', r.copyShown && !r.stFilter, JSON.stringify({ copyShown: r.copyShown, stFilter: r.stFilter }));
  await page.click('#filterbar .lb-lvl[data-level="WARN"]');
  await page.waitForTimeout(200);
  r = await state(page);
  ok('Clicking WARN as well adds warnings', r.f.levels.sort().join() === 'ERROR,WARN' && r.shown === 7, JSON.stringify(r.f.levels));
  await page.click('#filterbar .lb-lvl[data-level="ERROR"]');
  await page.waitForTimeout(200);
  r = await state(page);
  ok('Clicking a pressed chip drops that level', r.f.levels.join() === 'WARN' && r.shown === 3, JSON.stringify(r.f.levels));
  await page.click('#filterbar .lb-lvl[data-level="INFO"]', { modifiers: ['Shift'] });
  await page.waitForTimeout(200);
  r = await state(page);
  ok('Shift+click shows only that level', r.f.levels.join() === 'INFO' && r.shown === 12, JSON.stringify(r.f.levels));
  await page.click('#filterbar .qb-clear');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ n: __tf.active.filter.levels.size, clear: document.querySelector('#filterbar .qb-clear').hidden }));
  ok('Clear filters shows every level again and hides itself', r.n === 6 && r.clear, JSON.stringify(r));

  // ---- the text box filters as you type ----
  await page.click('#qb-input');
  await page.keyboard.type('PAYMENT');
  await page.waitForTimeout(450);
  r = await state(page);
  const plain = r.shown;
  ok('Typing filters live, without pressing Enter (and makes no chip)', r.f.text === 'PAYMENT' && plain > 0 && plain < 20 && r.chips.length === 0 && /of 20 entries/.test(r.count), JSON.stringify(r));
  await page.click('#filterbar .lb-tog[data-tog="textCase"]');
  await page.waitForTimeout(250);
  r = await page.evaluate(() => ({ shown: __tf.active.an.vis.reduce((a, x) => a + x, 0), pressed: document.querySelector('#filterbar .lb-tog[data-tog="textCase"]').getAttribute('aria-pressed'), none: document.querySelector('#filterbar .qb-count').classList.contains('none') }));
  ok('Aa matches case (PAYMENT is not in the log in capitals)', r.pressed === 'true' && r.shown === 0 && r.none, JSON.stringify(r));
  await page.click('#filterbar .lb-tog[data-tog="textCase"]');
  await page.fill('#qb-input', 'took \\d{4}ms');
  await page.waitForTimeout(450);
  r = await state(page);
  const literal = r.shown;
  await page.click('#filterbar .lb-tog[data-tog="textRegex"]');
  await page.waitForTimeout(250);
  r = await state(page);
  ok('.* turns the text into a regular expression', literal === 0 && r.shown === 2, JSON.stringify({ literal, regex: r.shown }));
  await page.fill('#qb-input', 'took (');
  await page.waitForTimeout(450);
  r = await page.evaluate(() => ({ err: document.querySelector('#filterbar .lb-text').classList.contains('has-error'), title: document.querySelector('#filterbar .lb-text').title }));
  ok('An invalid regex marks the box red and says why', r.err && /Invalid regex/.test(r.title), JSON.stringify(r));
  await page.click('#filterbar .lb-tog[data-tog="textRegex"]');
  await page.focus('#qb-input');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  r = await state(page);
  ok('Esc empties the box and its filter', !r.f.text && r.shown === null, JSON.stringify(r.f));

  // ---- query syntax still works: Enter turns it into chips ----
  await page.evaluate(() => __tf.editor.focus());
  await page.keyboard.press('Control+k');
  r = await page.evaluate(() => ({ focus: document.activeElement && document.activeElement.id, help: !document.querySelector('#filterbar .qb-help').hidden, ex: document.querySelectorAll('#filterbar .qb-ex').length }));
  ok('Ctrl+K puts the cursor in the filter box and shows examples', r.focus === 'qb-input' && r.help && r.ex >= 6, JSON.stringify(r));
  await page.keyboard.type('level:warn+ logger:OrderService -validation');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  r = await state(page);
  ok('Several parts at once: level:warn+, logger:, -word (levels show on the chips, the rest as chips in the box)', r.f.levels.sort().join() === 'ERROR,WARN' && r.f.logger === 'OrderService' && r.f.exclude === 'validation' && r.chips.length === 2, JSON.stringify(r));
  r = await page.evaluate(() => ({ focus: document.activeElement && document.activeElement.id, value: document.getElementById('qb-input').value, more: document.querySelector('#filterbar .lb-more').innerText.trim() }));
  ok('After Enter the box is empty and still focused; More filters counts what is set', r.focus === 'qb-input' && r.value === '' && r.more === 'More filters (2)', JSON.stringify(r));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(200);
  r = await state(page);
  ok('Backspace in the empty box removes the last chip', r.chips.length === 1 && !r.f.exclude, JSON.stringify(r));
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
  ok('A quoted phrase is a text filter chip (shown without regex escapes)', r.chips.includes('text: Payment call failed') && r.shown === 2, JSON.stringify(r));
  await page.click('#filterbar .qb-clear');
  await type(page, 'level:loud after:noon');
  r = await page.evaluate(() => ({ value: document.getElementById('qb-input').value, toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent }));
  ok('Parts it does not understand stay in the box with a hint', r.value === 'level:loud after:noon' && /Not understood/.test(r.toast), JSON.stringify(r));
  await page.keyboard.press('Escape');

  // ---- More filters ----
  await page.click('#filterbar .lb-more');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ open: !document.querySelector('#logbar .lb-advanced').hidden, exp: document.querySelector('#filterbar .lb-more').getAttribute('aria-expanded'), labels: [...document.querySelectorAll('#logbar .lb-advanced .lb-fh > span')].map((x) => x.textContent) }));
  ok('More filters opens a row with the other filters', r.open && r.exp === 'true' && ['Lines matching', 'Hide lines matching', 'Logger or thread', 'Took ≥ ms', 'Trace IDs', 'From', 'To'].every((l) => r.labels.includes(l)), JSON.stringify(r));
  await page.click('#logbar .lb-advanced input[data-key="logger"]');
  await page.keyboard.type('PaymentClient', { delay: 30 });
  await page.waitForTimeout(450);
  r = await page.evaluate(() => ({ logger: __tf.active.filter.logger, value: document.querySelector('#logbar .lb-advanced input[data-key="logger"]').value, focus: document.activeElement && document.activeElement.dataset.key, more: document.querySelector('#filterbar .lb-more').innerText.trim() }));
  ok('Typing in a field filters without losing the cursor', r.logger === 'PaymentClient' && r.value === 'PaymentClient' && r.focus === 'logger' && r.more === 'More filters (1)', JSON.stringify(r));
  await page.click('#filterbar .qb-clear');
  await page.waitForTimeout(200);

  // ---- time range ----
  await page.click('#filterbar .lb-more'); // close More filters: its chips show in the box again
  await type(page, 'time:10:16..10:17');
  r = await state(page);
  ok('time:10:16..10:17 becomes a time-range chip', r.time && r.chips.includes('time: 10:16 to 10:17') && r.f.from === '10:16' && r.f.to === '10:17', JSON.stringify(r));
  r = await page.evaluate(() => { const c = document.querySelector('#filterbar .qb-chip.time'); const cs = getComputedStyle(c); return { border: cs.borderTopColor, icon: !!c.querySelector('svg'), range: !document.querySelector('#signal .range').hidden }; });
  ok('The time chip looks different (accent outline, clock) and the range is outlined on the timeline', r.icon && r.border !== 'rgba(0, 0, 0, 0)' && r.range, JSON.stringify(r));
  await page.click('#filterbar .lb-more');
  await page.waitForTimeout(150);
  r = await page.evaluate(() => ({ from: document.querySelector('#logbar .lb-advanced input[data-key="from"]').value, chips: document.querySelectorAll('#filterbar .qb-chip').length }));
  ok('With More filters open the range is in From / To, and the box drops its chips to keep room for typing', r.from === '10:16' && r.chips === 0, JSON.stringify(r));
  await page.click('#filterbar .lb-more');
  await page.waitForTimeout(150);
  await page.click('#filterbar .qb-chip.time .qb-x');
  await page.waitForTimeout(200);
  r = await state(page);
  ok('× on the time chip clears the range', !r.f.from && !r.f.to && !r.time, JSON.stringify(r));
  const sb = await rect(page, '#signal');
  await page.mouse.move(sb.x + sb.w * 0.3, sb.y + sb.h * 0.7);
  await page.waitForTimeout(100);
  r = await page.evaluate(() => ({ hint: document.querySelector('#logbar .lb-hint').textContent, hover: document.querySelectorAll('#signal .lb-bar.hover').length }));
  ok('Hovering a bar shows its time and counts', /\d\d:\d\d:\d\d – \d\d:\d\d:\d\d/.test(r.hint) && /entr/.test(r.hint) && r.hover === 1, JSON.stringify(r));
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.w * 0.55, sb.y + sb.h * 0.7, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(300);
  r = await state(page);
  const look = await page.evaluate(() => ({ range: !document.querySelector('#signal .range').hidden, dim: document.querySelectorAll('#signal .lb-bar.dim').length, hint: document.querySelector('#logbar .lb-hint').textContent }));
  ok('Dragging on the timeline filters by time: chip, outlined range, dimmed bars outside it', r.time && /^\d\d:\d\d:\d\d$/.test(r.f.from) && r.f.to && r.shown > 0 && r.shown < 20 && look.range && look.dim > 0, JSON.stringify([r.f, look]));
  await page.mouse.move(sb.x + sb.w * 0.8, sb.y - 30);
  await page.waitForTimeout(100);
  r = await page.evaluate(() => document.querySelector('#logbar .lb-hint').textContent);
  ok('The hint then says how to clear the range', /double-click to clear/.test(r), r);
  await page.mouse.dblclick(sb.x + sb.w * 0.8, sb.y + sb.h * 0.7);
  await page.waitForTimeout(300);
  r = await state(page);
  ok('Double-clicking the timeline removes the range', !r.time && !r.f.from && !r.f.to, JSON.stringify(r));
  const errX = await page.evaluate(() => { const st = __tf.strip(); const i = st.buckets.findIndex((b) => b.error); const s = document.getElementById('signal').getBoundingClientRect(); return s.left + (i + 0.5) * (s.width / st.buckets.length); });
  await page.evaluate(() => __tf.editor.setPosition({ lineNumber: 1, column: 1 }));
  await page.mouse.click(errX, sb.y + sb.h * 0.7);
  await page.waitForTimeout(300);
  r = await page.evaluate(() => { const ln = __tf.editor.getPosition().lineNumber; return { ln, text: __tf.active.model.getLineContent(ln).slice(0, 60) }; });
  ok('Clicking a bar with errors jumps to the error', r.ln > 1 && /ERROR/.test(r.text), JSON.stringify(r));

  // ---- error buttons, Auto tables ----
  await page.evaluate(() => __tf.editor.setPosition({ lineNumber: 1, column: 1 }));
  await page.click('#filterbar .lb-next');
  await page.waitForTimeout(150);
  const n1 = await page.evaluate(() => __tf.editor.getPosition().lineNumber);
  await page.click('#filterbar .lb-next');
  await page.waitForTimeout(150);
  const n2 = await page.evaluate(() => __tf.editor.getPosition().lineNumber);
  await page.click('#filterbar .lb-prev');
  await page.waitForTimeout(150);
  const n3 = await page.evaluate(() => __tf.editor.getPosition().lineNumber);
  r = await page.evaluate((l) => l.map((x) => /ERROR/.test(__tf.active.model.getLineContent(x))), [n1, n2, n3]);
  ok('The arrow buttons go to the next and previous error', r.every(Boolean) && n2 > n1 && n3 === n1, JSON.stringify({ n1, n2, n3 }));
  await page.click('#filterbar .lb-auto');
  await page.waitForTimeout(500);
  r = await page.evaluate(() => ({ panel: !document.getElementById('panel').hidden, list: !!document.querySelector('#panel-body .at-list') }));
  ok('Auto tables in the filter row builds the tables', r.panel && r.list, JSON.stringify(r));
  await page.evaluate(() => __tf.closePanel && __tf.closePanel());

  // ---- commands and plain files ----
  await type(page, '>split');
  r = await page.evaluate(() => ({ open: !document.getElementById('palette').hidden, q: document.getElementById('palette-input').value }));
  ok('Typing > runs a command: opens the palette with the text', r.open && r.q === 'split', JSON.stringify(r));
  await page.keyboard.press('Escape');
  await page.evaluate(() => __tf.activate(__tf.newTab({ name: 'notes.md', content: 'alpha\nbeta gamma\nbeta' })));
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => { const fc = __tf.editor.getContribution('editor.contrib.findController'); return { logbar: document.getElementById('logbar').hidden, revealed: fc.getState().isRevealed }; });
  ok('A file that is not a log has no log bar; Ctrl+K opens Find instead', r.logbar && r.revealed, JSON.stringify(r));
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
  await page.evaluate(() => __tf.editor.revealLineInCenter(9));
  await page.waitForTimeout(250);
  const sel = await page.evaluate(() => { const ed = __tf.editor; const a = ed.getScrolledVisiblePosition({ lineNumber: 9, column: 1 }); const c = ed.getScrolledVisiblePosition({ lineNumber: 10, column: 40 }); const r = ed.getDomNode().getBoundingClientRect(); return { x1: r.left + a.left + 2, y1: r.top + a.top + 5, x2: r.left + c.left, y2: r.top + c.top + 5, line9: r.top + a.top }; });
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

  // ---- 0.18.1: Copy as table, Copy CSV and Open as new tab in the results ----
  await page.evaluate(() => { window.__copied = []; window.__realClip = window.api.clipboardWrite; window.api.clipboardWrite = async (x) => { window.__copied.push(x); return true; }; __tf.autoTables(); });
  await page.waitForTimeout(500);
  await page.click('.at-item >> nth=1');
  await page.waitForTimeout(200);
  await copyMenu('Copy as table');
  await page.waitForTimeout(150);
  r = await page.evaluate(() => { const c = window.__copied[window.__copied.length - 1]; const rows = document.querySelectorAll('#panel-body table.grid tr').length - 1; return { lines: c.text.split('\n').filter(Boolean), html: /<table/i.test(c.html || ''), rows, toast: document.getElementById('toast').textContent }; });
  ok('Copy as table copies every row with the Line column, as a real table', r.lines.length === r.rows + 1 && /^Line\t/.test(r.lines[0]) && /^\d+\t/.test(r.lines[1]) && r.html && /Copied \d+ rows/.test(r.toast), JSON.stringify(r));
  await copyMenu('Copy as CSV');
  await page.waitForTimeout(150);
  r = await page.evaluate(() => window.__copied[window.__copied.length - 1].text.split('\n')[0]);
  ok('Copy CSV starts with the header row, Line first', /^Line,/.test(r), r);
  const nTabs = await page.evaluate(() => __tf.tabs.length);
  await copyMenu('Open as new tab');
  await page.waitForTimeout(300);
  r = await page.evaluate(() => ({ n: __tf.tabs.length, name: __tf.active.name, lines: __tf.active.model.getLineCount(), first: __tf.active.model.getLineContent(1) }));
  ok('Open as new tab opens the rows as CSV in a new tab', r.n === nTabs + 1 && /-table\.csv$/.test(r.name) && r.lines >= 3 && /^Line,/.test(r.first), JSON.stringify(r));
  // a pattern with no variable parts (Markdown table rows) still copies its lines
  await page.evaluate(() => __tf.activate(__tf.newTab({ name: 'keys.md', content: '| Shortcut | Action |\n|---|---|\n| Ctrl+K | Filter |\n| F8 | Next error |\n\nSome text here.\n', lang: 'markdown' })));
  await page.evaluate(() => __tf.autoTables());
  await page.waitForTimeout(400);
  r = await page.evaluate(() => [...document.querySelectorAll('.at-item')].length);
  let copiedEmpty = false;
  for (let i = 0; i < r; i++) {
    await page.click(`.at-item >> nth=${i}`);
    await page.waitForTimeout(120);
    await copyMenu('Copy as table');
    await page.waitForTimeout(80);
    const c = await page.evaluate(() => window.__copied[window.__copied.length - 1].text.split('\n').filter(Boolean));
    if (c.length < 2 || c.slice(1).every((l) => !l.split('\t').slice(1).join('').trim())) copiedEmpty = true;
  }
  ok('Every pattern copies something, including ones with no columns (the line text is used)', r > 0 && !copiedEmpty, 'patterns ' + r);
  await page.evaluate(() => { window.api.clipboardWrite = async () => false; });
  await copyMenu('Copy as table');
  await page.waitForTimeout(150);
  r = await page.evaluate(() => document.getElementById('toast').textContent);
  ok('When the clipboard is blocked it says so instead of claiming it copied', /Could not copy/.test(r), r);
  await page.evaluate(() => { window.api.clipboardWrite = window.__realClip; __tf.activate(__tf.tabs.find((t) => /sample/.test(t.name))); });
  await page.waitForTimeout(200);

  // ---- 0.18.1: Log insights like tracepad, and no filters in the sidebar ----
  await page.evaluate(() => { __tf.clearFilter(); __tf.showView('insights', { toggle: false }); });
  await page.waitForTimeout(300);
  r = await page.evaluate(() => {
    const v = document.querySelector('.view[data-view="insights"]');
    return { heads: [...v.querySelectorAll('.ins-sec > h3')].map((x) => x.innerText.replace(/\s+/g, ' ').trim()), filters: !!v.querySelector('textarea, #flt-include') || /Show levels|Lines matching/.test(v.innerText),
      keys: [...v.querySelectorAll('.ins-row')].map((x) => x.querySelector('dt').textContent + '=' + x.querySelector('dd').textContent),
      levels: [...v.querySelectorAll('.ins-level')].map((x) => x.innerText.replace(/\s+/g, ' ').trim()), groups: v.querySelectorAll('.ins-group').length };
  });
  ok('Log insights: Summary, Levels, Stack frames, Repeated errors, Tools; no filter fields (they are in the log bar)', ['Summary', 'Levels', 'Stack frames', 'Tools'].every((x) => r.heads.includes(x)) && r.heads.some((x) => /^Repeated errors/.test(x)) && !r.filters, JSON.stringify(r.heads));
  ok('The summary lists format, entries, from, to and how long the log covers', r.keys[0] === 'Format=Spring Boot' && /^Entries=20 in \d+ lines$/.test(r.keys[1]) && r.keys.some((k) => /^From=2026-11-02 10:15:01$/.test(k)) && r.keys.some((k) => /^Covers=3 min \d+ s$/.test(k)), JSON.stringify(r.keys));
  ok('Levels are bars with counts', r.levels.join('|') === 'ERROR 4|WARN 3|INFO 12|DEBUG 1', JSON.stringify(r.levels));
  await page.evaluate(() => __tf.editor.setPosition({ lineNumber: 1, column: 1 }));
  await page.click('.ins-group >> nth=0');
  await page.waitForTimeout(150);
  const g1 = await page.evaluate(() => __tf.editor.getPosition().lineNumber);
  await page.click('.ins-group >> nth=0');
  await page.waitForTimeout(150);
  const g2 = await page.evaluate(() => __tf.editor.getPosition().lineNumber);
  r = await page.evaluate(() => document.querySelector('.ins-group .ins-gcount').textContent);
  ok('Clicking a repeated error steps through its occurrences', r.endsWith('×') && g1 > 1 && (parseInt(r, 10) === 1 ? g2 === g1 : g2 !== g1), JSON.stringify({ r, g1, g2 }));
  r = await page.evaluate(() => !!document.querySelector('.view[data-view="highlight"] input[placeholder^="com.mycompany"]') || (__tf.showView('highlight', { toggle: false }), !!document.querySelector('.view[data-view="highlight"] input[placeholder^="com.mycompany"]')));
  ok('The package prefix lives in Log insights only (not repeated in Highlight)', r === false, String(r));
  await page.evaluate(() => __tf.hideSide && __tf.hideSide());

  // ---- 0.18.2: compact More filters, time ticks, range length, zoom, Compare with… ----
  await page.evaluate(() => { __tf.clearFilter(); __tf.activate(__tf.tabs.find((t) => /sample/.test(t.name))); });
  await page.waitForTimeout(200);
  if ((await page.getAttribute('#filterbar .lb-more', 'aria-expanded')) !== 'true') await page.click('#filterbar .lb-more');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => { const a = document.querySelector('#logbar .lb-advanced').getBoundingClientRect(); const ta = document.querySelector('#logbar .lb-advanced textarea[data-key="include"]').getBoundingClientRect(); return { h: Math.round(a.height), ta: Math.round(ta.height) }; });
  ok('More filters is one compact row at 1920 px (multi-line boxes are one line tall)', r.h <= 70 && r.ta <= 30, JSON.stringify(r));
  await page.click('#logbar .lb-advanced textarea[data-key="include"]');
  await page.waitForTimeout(100);
  r = await page.evaluate(() => { const ta = document.querySelector('#logbar .lb-advanced textarea[data-key="include"]').getBoundingClientRect(); const ed = document.getElementById('editors').getBoundingClientRect(); const a = document.querySelector('#logbar .lb-advanced').getBoundingClientRect(); return { ta: Math.round(ta.height), over: ta.bottom > ed.top, rowH: Math.round(a.height) }; });
  ok('A multi-line box opens over the editor while you type in it, without pushing the log down', r.ta >= 80 && r.over && r.rowH <= 70, JSON.stringify(r));
  await page.evaluate(() => __tf.editor.focus());
  await page.click('#filterbar .lb-more');
  r = await page.evaluate(() => [...document.querySelectorAll('#logbar .lb-ticks span')].map((s) => s.textContent));
  ok('Time ticks under the strip at round steps', r.length >= 5 && r.every((x) => /^\d\d:\d\d(:\d\d)?$/.test(x)), JSON.stringify(r));
  await page.evaluate(() => __tf.setFilter({ from: '10:16:00', to: '10:17:10' }));
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ hint: document.querySelector('#logbar .lb-hint').textContent, zoom: document.querySelector('#logbar .lb-zoom').hidden ? '' : document.querySelector('#logbar .lb-zoom').textContent }));
  ok('The hint says how long the selected range is, and Zoom to range appears', /10:16:00 – 10:17:10 \(1 min 10 s selected\)/.test(r.hint) && r.zoom === 'Zoom to range', JSON.stringify(r));
  await page.click('#logbar .lb-zoom');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => { const st = __tf.strip(); return { start: document.querySelector('#logbar .lb-start').textContent, end: document.querySelector('#logbar .lb-end').textContent, zoom: document.querySelector('#logbar .lb-zoom').textContent, total: st.buckets.reduce((a, b) => a + b.total, 0), ticks: [...document.querySelectorAll('#logbar .lb-ticks span')].map((s) => s.textContent) }; });
  ok('Zoom to range redraws the bars over just that window (with finer ticks)', /10:16:00/.test(r.start) && /10:17:10/.test(r.end) && r.zoom === 'Show all time' && r.total > 0 && r.total < 20 && r.ticks.every((x) => /^\d\d:\d\d:\d\d$/.test(x)), JSON.stringify(r));
  await page.click('#logbar .lb-zoom');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ start: document.querySelector('#logbar .lb-start').textContent, total: __tf.strip().buckets.reduce((a, b) => a + b.total, 0) }));
  ok('Show all time draws the whole log again', /10:15:01/.test(r.start) && r.total === 20, JSON.stringify(r));
  await page.evaluate(() => __tf.clearFilter());
  // Compare with… in the tab menu, and Alt+D
  await page.evaluate(() => { __tf.newTab({ name: 'other.log', content: 'x\ny' }); });
  await page.waitForTimeout(150);
  await page.click('#tabs .tab.active', { button: 'right' });
  await page.waitForTimeout(150);
  r = await page.evaluate(() => { const b = [...document.querySelectorAll('.menu button')].find((x) => /Compare with/.test(x.textContent)); return b ? { text: b.textContent, disabled: b.disabled } : null; });
  ok('The tab right-click menu has Compare with… (Alt+D)', r && /Compare with…/.test(r.text) && /Alt\+D/.test(r.text) && !r.disabled, JSON.stringify(r));
  await page.click('.menu button:has-text("Compare with")');
  await page.waitForTimeout(250);
  r = await page.evaluate(() => ({ modal: !document.getElementById('modal').hidden, title: (document.querySelector('#modal-box h2, #modal-box .title') || {}).textContent }));
  ok('…which asks which tab to compare with', r.modal, JSON.stringify(r));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await page.evaluate(() => __tf.editor.focus());
  await page.keyboard.press('Alt+d');
  await page.waitForTimeout(250);
  r = await page.evaluate(() => !document.getElementById('modal').hidden);
  ok('Alt+D opens Compare too', r, String(r));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // ---- 0.19.0: hide or remove part of every line (a path, a file name, a prefix) ----
  await page.evaluate(() => { __tf.clearFilter(); __tf.settings.hideRules = []; __tf.settings.showHidden = false; __tf.refreshHidden(); __tf.activate(__tf.tabs.find((t) => /sample/.test(t.name))); __tf.hideSide && __tf.hideSide(); });
  await page.waitForTimeout(200);
  r = await page.evaluate(() => [['/opt/app/logs/order-7.log', '/var/log/x/y.log'], ['OrderService.java:112', 'PaymentClient.java:57'], ['traceId=c3e09f1a7b264d58', 'traceId=6f1c2a9be0d34f11'], ['user 4512 ok', 'user 7 ok']]
    .map(([a, b]) => { const re = new RegExp('^' + __tf.likePattern(a) + '$'); return re.test(a) && re.test(b); }));
  ok('"Text like this" matches the same shape: paths, file names with line numbers, IDs, numbers', r.every(Boolean), JSON.stringify(r));
  const before0 = await page.evaluate(() => __tf.active.model.getValue());
  await page.evaluate(() => { const ed = __tf.editor; const line = ed.getModel().getLineContent(1); const i = line.indexOf('18244'); ed.setSelection(new monaco.Range(1, i + 1, 1, line.indexOf('[', i + 12) + 1)); ed.revealLine(1); ed.focus(); });
  await page.keyboard.press('Shift+End'); await page.keyboard.press('Shift+Home');
  await page.evaluate(() => { const ed = __tf.editor; const line = ed.getModel().getLineContent(1); const i = line.indexOf('18244'); ed.setSelection(new monaco.Range(1, i + 1, 1, line.indexOf('[', i + 12) + 1)); });
  await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowLeft');
  await page.waitForTimeout(450);
  r = await page.evaluate(() => ({ on: document.querySelector('.selbar').classList.contains('on'), sel: __tf.active.model.getValueInRange(__tf.editor.getSelection()) }));
  ok('Selecting part of a line shows the toolbar with Hide…', r.on && /^18244 --- \[order-service\] $/.test(r.sel) && await page.isVisible('.selbar .sb-btn:has-text("Hide…")'), JSON.stringify(r));
  await page.click('.selbar .sb-btn:has-text("Hide…")');
  await page.waitForTimeout(150);
  r = await page.evaluate(() => [...document.querySelectorAll('.menu button')].map((b) => b.textContent));
  ok('Hide… offers hide this text, hide text like this, and remove', r.some((x) => /^Hide "18244 --- \[order-service\] " in every line$/.test(x)) && r.some((x) => /^Hide text like this/.test(x)) && r.some((x) => /^Remove "/.test(x)), JSON.stringify(r));
  await page.click('.menu button:has-text("in every line")');
  await page.waitForTimeout(300);
  r = await page.evaluate(() => ({ n: __tf.hiddenRanges(), same: __tf.active.model.getValue(), chip: document.getElementById('st-hidden').hidden ? '' : document.getElementById('st-hidden').textContent, deco: document.querySelectorAll('.view-line .tf-hidden').length, marks: document.querySelectorAll('.view-line .tf-hidden-mark').length }));
  ok('The text is hidden in every line (with a ⋯ marker) and the file is unchanged', r.n === 20 && r.same === before0 && r.chip === 'Hidden: 20' && r.deco > 5 && r.marks > 5, JSON.stringify(Object.assign({}, r, { same: r.same === before0 })));
  r = await page.evaluate(() => { const ed = __tf.editor; const l = ed.getModel().getLineContent(2); const col = l.indexOf('[', l.indexOf('[order-service]') + 3) + 1; const sp = ed.getScrolledVisiblePosition({ lineNumber: 2, column: col }); const x = ed.getDomNode().getBoundingClientRect().left + sp.left + 2; const y = ed.getDomNode().getBoundingClientRect().top + sp.top + sp.height / 2; const t = ed.getTargetAtClientPoint(x, y); return { want: col, got: t && t.position && t.position.column }; });
  ok('Clicking text after a hidden part still lands on the right column', r.got === r.want, JSON.stringify(r));
  await page.evaluate(() => { window.__copied = []; window.__realClip2 = window.api.clipboardWrite; window.api.clipboardWrite = async (x) => { window.__copied.push(x.text); return true; }; });
  await page.evaluate(() => __tf.copyShown());
  await page.waitForTimeout(150);
  r = await page.evaluate(() => { const t = window.__copied[window.__copied.length - 1] || ''; return { has: t.includes('18244 --- [order-service]'), lines: t.split('\n').length }; });
  ok('Copy shown leaves the hidden parts out', !r.has && r.lines >= 40, JSON.stringify(r));
  await page.click('#st-hidden');
  await page.waitForTimeout(250);
  r = await page.evaluate(() => ({ chip: document.getElementById('st-hidden').textContent, shown: document.querySelectorAll('.view-line .tf-hidden-shown').length, hidden: document.querySelectorAll('.view-line .tf-hidden').length }));
  ok('The status bar chip shows the hidden text again (marked), and hides it on the next click', r.chip === 'Hidden text shown' && r.shown > 5 && r.hidden === 0, JSON.stringify(r));
  await page.click('#st-hidden');
  await page.waitForTimeout(200);
  await page.evaluate(() => __tf.showView('highlight', { toggle: false }));
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ rules: [...document.querySelectorAll('.hide-rule .hide-pat')].map((x) => x.value), ex: [...document.querySelectorAll('.hide-rule .hide-ex')].map((x) => x.textContent) }));
  ok('Highlight > Hidden text lists the rule with the text it came from', r.rules.length === 1 && /18244/.test(r.ex[0] || ''), JSON.stringify(r));
  await page.click('.hide-rule input[type="checkbox"]');
  await page.waitForTimeout(250);
  r = await page.evaluate(() => ({ n: document.querySelectorAll('.view-line .tf-hidden').length, chip: document.getElementById('st-hidden').hidden }));
  ok('Switching a rule off shows that text again', r.n === 0 && r.chip, JSON.stringify(r));
  await page.click('.hide-rule .icon-btn');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => __tf.settings.hideRules.length);
  ok('A rule can be deleted', r === 0, String(r));
  // remove (edits the text; undo puts it back)
  await page.evaluate(() => { __tf.hideSide && __tf.hideSide(); __tf.editor.focus(); __tf.removeText('traceId=c3e09f1a7b264d58', true); });
  await page.waitForTimeout(200);
  r = await page.evaluate(() => { const v = __tf.active.model.getValue(); return { left: (v.match(/traceId=[0-9a-f]{16}/g) || []).length, toast: document.getElementById('toast').textContent }; });
  ok('Remove text like this takes every trace ID out of the text', r.left === 0 && /Ctrl\+Z/.test(r.toast), JSON.stringify(r));
  await page.evaluate(() => __tf.editor.trigger('test', 'undo', null));
  await page.waitForTimeout(200);
  r = await page.evaluate((b0) => __tf.active.model.getValue() === b0, before0);
  ok('…and one Ctrl+Z puts them all back', r, String(r));
  await page.evaluate(() => { window.api.clipboardWrite = window.__realClip2; });

  // ---- 0.19.0: the filters fold into a "Filters" drop down (the default); the pin keeps them open ----
  await page.evaluate(() => { __tf.clearFilter(); __tf.settings.filtersDocked = false; __tf.setFiltersOpen(false); __tf.editor.focus(); });
  await page.waitForTimeout(200);
  r = await page.evaluate(() => { const lb = document.getElementById('logbar').getBoundingClientRect(), ed = document.getElementById('editors').getBoundingClientRect(), row = document.getElementById('filterbar'); return { lbH: Math.round(lb.height), edTop: Math.round(ed.top), lbBottom: Math.round(lb.bottom), row: getComputedStyle(row).display !== 'none' && row.offsetParent !== null, btn: document.querySelector('#logbar .lb-fbtn').innerText.trim() }; });
  ok('By default the filters are folded: just a Filters button on the timeline row, the log starts right below', !r.row && r.btn === 'Filters' && r.lbH <= 80 && r.edTop <= r.lbBottom + 1, JSON.stringify(r));
  await page.click('#logbar .lb-fbtn');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => { const row = document.getElementById('filterbar').getBoundingClientRect(), ed = document.getElementById('editors').getBoundingClientRect(), lb = document.getElementById('logbar').getBoundingClientRect(); return { visible: row.height > 0, over: row.top >= lb.bottom - 1 && row.top < ed.top + row.height + 4, edTop: Math.round(ed.top), exp: document.querySelector('#logbar .lb-fbtn').getAttribute('aria-expanded') }; });
  ok('Clicking Filters drops the filter row down over the log (the log does not move)', r.visible && r.exp === 'true', JSON.stringify(r));
  await page.click('#filterbar .lb-lvl[data-level="ERROR"]');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ open: document.querySelector('#logbar .lb-fbtn').getAttribute('aria-expanded'), btn: document.querySelector('#logbar .lb-fbtn').innerText.trim(), sum: document.querySelector('#logbar .lb-sum').innerText.replace(/\s+/g, ' ').trim() }));
  ok('Using a filter keeps the drop down open; the button counts active filters', r.open === 'true' && r.btn === 'Filters (1)', JSON.stringify(r));
  await page.mouse.click(900, 700);
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ open: document.querySelector('#logbar .lb-fbtn').getAttribute('aria-expanded'), sum: document.querySelector('#logbar .lb-sum').hidden ? '' : document.querySelector('#logbar .lb-sum').innerText.replace(/\s+/g, ' ').trim(), levels: [...__tf.active.filter.levels] }));
  ok('Clicking the log folds it again; the filter stays on and the label row says "4 of 20"', r.open === 'false' && /^4 of 20/.test(r.sum) && r.levels.join() === 'ERROR', JSON.stringify(r));
  await page.click('#logbar .lb-sum-x');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ n: __tf.active.filter.levels.size, sum: document.querySelector('#logbar .lb-sum').hidden }));
  ok('× next to the count clears the filters', r.n === 6 && r.sum, JSON.stringify(r));
  await page.evaluate(() => __tf.editor.focus());
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ open: document.querySelector('#logbar .lb-fbtn').getAttribute('aria-expanded'), focus: document.activeElement && document.activeElement.id }));
  ok('Ctrl+K opens the drop down with the cursor in the filter box', r.open === 'true' && r.focus === 'qb-input', JSON.stringify(r));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => document.querySelector('#logbar .lb-fbtn').getAttribute('aria-expanded'));
  ok('Esc folds it', r === 'false', r);
  await page.click('#logbar .lb-fbtn');
  await page.click('#filterbar .lb-pin');
  await page.waitForTimeout(250);
  r = await page.evaluate(() => { const row = document.getElementById('filterbar').getBoundingClientRect(), ed = document.getElementById('editors').getBoundingClientRect(); return { docked: __tf.settings.filtersDocked, inFlow: row.bottom <= ed.top + 1 && row.height > 0, btn: getComputedStyle(document.querySelector('#logbar .lb-fbtn')).display }; });
  ok('The pin keeps the filters open above the log (the Filters button goes away)', r.docked && r.inFlow && r.btn === 'none', JSON.stringify(r));
  await page.mouse.click(900, 700);
  await page.waitForTimeout(150);
  r = await page.evaluate(() => document.getElementById('filterbar').getBoundingClientRect().height > 0);
  ok('Pinned, clicking the log does not fold it', r, String(r));

  // ---- appearance: light theme and phone ----
  await page.evaluate(() => { __tf.setTheme('paper'); __tf.applyQuery('logger:OrderService'); __tf.setFilter({ levels: new Set(['ERROR']) }); });
  await page.waitForTimeout(200);
  r = await page.evaluate(() => {
    const lum = (c) => { const m = c.match(/\d+(\.\d+)?/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
    const ratio = (fg, bg) => { const a = lum(fg), b = lum(bg); return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 10) / 10; };
    const chip = document.querySelector('#filterbar .qb-chip');
    const lvl = document.querySelector('#filterbar .lb-lvl.on');
    return { chip: ratio(getComputedStyle(chip.querySelector('b')).color, getComputedStyle(document.querySelector('#filterbar .lb-text')).backgroundColor),
      count: ratio(getComputedStyle(lvl.querySelector('span')).color, getComputedStyle(lvl).backgroundColor) };
  });
  ok('Chip text and level counts are readable in the light theme (4.5:1 or more)', r.chip >= 4.5 && r.count >= 4.5, JSON.stringify(r));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  r = await page.evaluate(() => {
    const g = (s) => document.querySelector(s).getBoundingClientRect();
    const t = g('#filterbar .lb-text'), lv = g('#filterbar .lb-levels'), strip = g('#signal');
    return { hscroll: document.documentElement.scrollWidth > innerWidth, textW: Math.round(t.width), levels: Math.round(lv.width), stripW: Math.round(strip.width), chip: !!document.querySelector('#filterbar .qb-chip'),
      count: getComputedStyle(document.querySelector('#filterbar .qb-count')).display !== 'none', nav: getComputedStyle(document.querySelector('#filterbar .lb-nav')).display };
  });
  ok('On a phone the chips, the filter box and the timeline each get the full width; nothing scrolls sideways', !r.hscroll && r.textW >= 300 && r.levels >= 300 && r.stripW >= 300 && r.chip && r.count && r.nav === 'none', JSON.stringify(r));
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
