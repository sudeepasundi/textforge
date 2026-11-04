/* 0.9.0: resizable results panel, renaming and reordering tabs, split view with several panes,
   shared filters and search, adding panes by dragging tabs. Usage: node test/workspace.e2e.js [selfhost URL] */
const path = require('path');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(process.env.HOME || '', '.npm-global/lib/node_modules/playwright')); }
const URL_ = process.argv[2] || 'http://127.0.0.1:8765/';
const results = [];
const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail });
const mk = (svc, off) => Array.from({ length: 300 }, (_, i) => `2026-11-03 10:${String(Math.floor((i * 3 + off) / 60)).padStart(2, '0')}:${String((i * 3 + off) % 60).padStart(2, '0')}.000 ${i % 25 ? 'INFO' : 'ERROR'} [exec-${i % 4}] c.w.${svc} - ${svc} step ${i} traceId=t${i}`).join('\n');

(async () => {
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL_);
  await page.waitForFunction(() => window.__tf && window.__tf.active, null, { timeout: 60000 });
  await page.evaluate(([a, b, c]) => {
    __tf.tabs.slice().forEach((t) => { if (!t.path && t.model.getValueLength() === 0) return; });
    const g = __tf.newTab({ name: 'gateway.log', content: a }); __tf.newTab({ name: 'order.log', content: b }); __tf.newTab({ name: 'payment.log', content: c });
    __tf.activate(g);
  }, [mk('Gateway', 0), mk('Order', 1), mk('Payment', 2)]);
  await page.waitForTimeout(600);
  let r;

  // ---------- results panel resizes ----------
  await page.evaluate(() => __tf.runCommand('Auto tables'));
  await page.waitForSelector('#panel:not([hidden])');
  const ph0 = await page.evaluate(() => document.getElementById('panel').offsetHeight);
  const grip = await page.evaluate(() => { const b = document.getElementById('panel-grip').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await page.mouse.move(grip.x, grip.y); await page.mouse.down(); await page.mouse.move(grip.x, grip.y - 200, { steps: 6 }); await page.mouse.up();
  const ph1 = await page.evaluate(() => document.getElementById('panel').offsetHeight);
  ok('Results panel resizes by dragging its top edge', ph1 >= ph0 + 190, ph0 + 'px -> ' + ph1 + 'px');
  await page.click('#panel-max');
  const ph2 = await page.evaluate(() => ({ h: document.getElementById('panel').offsetHeight, body: document.getElementById('body').offsetHeight }));
  ok('Maximise makes the panel nearly full height', ph2.h >= ph2.body - 100, JSON.stringify(ph2));
  await page.click('#panel-max');
  await page.mouse.dblclick(grip.x, (await page.evaluate(() => document.getElementById('panel-grip').getBoundingClientRect().y + 4)));
  const ph3 = await page.evaluate(() => document.getElementById('panel').offsetHeight);
  ok('Double-clicking the edge resets the height', Math.abs(ph3 - 300) <= 2, ph3 + 'px');
  await page.evaluate(() => document.getElementById('panel-close').click());

  // ---------- rename ----------
  await page.evaluate(() => { const u = __tf.newTab({}); __tf.activate(u); });
  await page.waitForTimeout(200);
  const untitled = await page.evaluate(() => __tf.active.id);
  await page.dblclick(`.tab[data-tab="${untitled}"] .name`);
  await page.waitForSelector('.tab-rename');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('notes.json');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  r = await page.evaluate((id) => { const t = __tf.tabs.find((x) => x.id === id); return { name: t.name, path: t.path, lang: t.model.getLanguageId(), label: document.querySelector(`.tab[data-tab="${id}"] .name`).textContent }; }, untitled);
  ok('Double-click renames an unsaved tab (and picks the language from the new name)', r.name === 'notes.json' && r.label === 'notes.json' && r.lang === 'json' && !r.path, JSON.stringify(r));
  await page.click(`.tab[data-tab="${untitled}"]`, { button: 'right' });
  await page.click('.menu button:has-text("Rename")');
  await page.waitForSelector('.tab-rename');
  await page.keyboard.press('Escape');
  r = await page.evaluate((id) => __tf.tabs.find((x) => x.id === id).name, untitled);
  ok('Right-click > Rename, and Esc cancels', r === 'notes.json', r);
  r = await page.evaluate(async (id) => { const t = __tf.tabs.find((x) => x.id === id); const before = t.name; const res = await __tf.renameTab(t, 'bad/name.txt'); return { res, name: t.name, before }; }, untitled);
  ok('Names with \\ / : * ? " < > | are refused', r.res === false && r.name === r.before, JSON.stringify(r));

  // ---------- reorder by dragging ----------
  const order = () => page.evaluate(() => __tf.tabs.map((t) => t.name));
  const o1 = await order();
  const ids = await page.evaluate(() => Object.fromEntries(__tf.tabs.map((t) => [t.name, t.id])));
  await page.dragAndDrop(`.tab[data-tab="${ids['payment.log']}"]`, `.tab[data-tab="${ids['gateway.log']}"]`, { targetPosition: { x: 4, y: 10 } });
  await page.waitForTimeout(200);
  const o2 = await order();
  ok('Dragging a tab moves it', o2.indexOf('payment.log') === o2.indexOf('gateway.log') - 1 && o2.length === o1.length, o1.join(', ') + '  ->  ' + o2.join(', '));
  r = await page.evaluate(() => Array.from(document.querySelectorAll('.tab .name')).map((x) => x.textContent));
  ok('The tab bar shows the new order', JSON.stringify(r) === JSON.stringify(o2), r.join(', '));

  // ---------- split view: several panes, added by dragging ----------
  await page.click(`.tab[data-tab="${ids['gateway.log']}"]`);
  await page.dragAndDrop(`.tab[data-tab="${ids['order.log']}"]`, '#editor', { targetPosition: { x: 400, y: 300 } });
  await page.waitForTimeout(400);
  r = await page.evaluate(() => (__tf.split ? __tf.split.panes.map((p) => p.tab.name) : []));
  ok('Dragging a tab onto the editor opens it beside', JSON.stringify(r) === JSON.stringify(['order.log']), r.join(', '));
  await page.dragAndDrop(`.tab[data-tab="${ids['payment.log']}"]`, '#editor', { targetPosition: { x: 200, y: 300 } });
  await page.waitForTimeout(400);
  r = await page.evaluate(() => ({ panes: __tf.split.panes.map((p) => p.tab.name), widths: [document.getElementById('editor'), ...document.querySelectorAll('.sp-pane')].map((e) => Math.round(e.getBoundingClientRect().width)) }));
  ok('A second drag adds a third file; all get the same width', r.panes.length === 2 && Math.max(...r.widths) - Math.min(...r.widths) < 30, JSON.stringify(r));
  // dropping on a pane replaces it
  const firstPane = await page.evaluate(() => __tf.split.panes[0].id);
  await page.dragAndDrop(`.tab[data-tab="${untitled}"]`, `.sp-pane[data-pane="${firstPane}"] .sp-editor`);
  await page.waitForTimeout(300);
  r = await page.evaluate(() => __tf.split.panes.map((p) => p.tab.name));
  ok('Dropping a tab on a pane replaces that pane', r[0] === 'notes.json' && r.length === 2, r.join(', '));
  await page.selectOption(`.sp-pane[data-pane="${firstPane}"] .sp-tab`, { label: 'order.log' });
  await page.waitForTimeout(200);
  // ---------- filters apply to every pane ----------
  await page.evaluate(() => __tf.setFilter({ levels: new Set(['ERROR']) }));
  await page.waitForTimeout(300);
  r = await page.evaluate(() => {
    const shownLines = (ed) => { const out = new Set(); for (const rg of ed.getVisibleRanges()) for (let l = rg.startLineNumber; l <= rg.endLineNumber; l++) out.add(ed.getModel().getLineContent(l).includes('ERROR') ? 'E' : 'other'); return [...out]; };
    return { main: shownLines(__tf.editor), panes: __tf.split.panes.map((p) => shownLines(p.editor)), counts: __tf.split.panes.map((p) => p.tab.an.vis.reduce((a, x) => a + x, 0)) };
  });
  ok('A level filter hides the same entries in every pane', JSON.stringify(r.main) === '["E"]' && r.panes.every((x) => JSON.stringify(x) === '["E"]') && r.counts.every((n) => n === 12), JSON.stringify(r));
  await page.evaluate(() => __tf.setFilter({ levels: new Set(['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE', 'OTHER']), from: '10:05', to: '10:06' }));
  await page.waitForTimeout(300);
  r = await page.evaluate(() => [__tf.active, ...__tf.split.panes.map((p) => p.tab)].map((t) => { const an = t.an; const idx = Array.from(an.vis).map((v, i) => (v ? i : -1)).filter((i) => i >= 0); return t.name + ':' + idx.length + ' ' + an.lines[an.entries[idx[0]].start].slice(11, 19) + '-' + an.lines[an.entries[idx[idx.length - 1]].start].slice(11, 19); }));
  ok('A time range (e.g. dragged on the timeline) applies to every pane', r.every((x) => /:40 10:05:0\d-10:06:5\d/.test(x)), r.join(' | '));
  await page.evaluate(() => __tf.clearFilter());
  await page.waitForTimeout(200);
  r = await page.evaluate(() => __tf.split.panes.map((p) => (p.tab.an.vis ? p.tab.an.vis.reduce((a, x) => a + x, 0) : p.tab.an.entries.length)));
  ok('Clear filter clears every pane', r.every((n) => n === 300), JSON.stringify(r));

  // ---------- Ctrl+F searches every pane ----------
  await page.click('#editor', { position: { x: 200, y: 120 } });
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(200);
  await page.keyboard.type('step 150');
  await page.waitForTimeout(500);
  r = await page.evaluate(() => [__tf.editor, ...__tf.split.panes.map((p) => p.editor)].map((ed) => { const c = ed.getContribution('editor.contrib.findController'); const st = c.getState(); return { s: st.searchString, open: st.isRevealed, matches: st.matchesCount }; }));
  ok('Ctrl+F searches every pane for the same text', r.every((x) => x.s === 'step 150' && x.open && x.matches === 1), JSON.stringify(r));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => __tf.split.panes.map((p) => p.editor.getContribution('editor.contrib.findController').getState().isRevealed));
  ok('Closing search closes it in every pane', r.every((x) => !x), JSON.stringify(r));

  // ---------- scroll sync across all panes ----------
  await page.evaluate(() => __tf.editor.revealLineNearTop(150));
  await page.waitForTimeout(400);
  r = await page.evaluate(() => [__tf.editor, ...__tf.split.panes.map((p) => p.editor)].map((ed) => ed.getModel().getLineContent(__tf.topFullLine(ed)).slice(11, 19)));
  const secs = r.map((t) => { const [a, b, c] = t.split(':').map(Number); return a * 3600 + b * 60 + c; });
  ok('Scrolling the main editor brings every pane to the same time', Math.max(...secs) - Math.min(...secs) <= 3, r.join(' / '));

  // ---------- swap, close, limits ----------
  await page.click('.sp-pane >> nth=1 >> button[title="Swap with the main editor"]');
  r = await page.evaluate(() => ({ main: __tf.active.name, panes: __tf.split.panes.map((p) => p.tab.name) }));
  ok('Swap puts a pane\'s file in the main editor', r.main === 'payment.log' && r.panes.includes('gateway.log'), JSON.stringify(r));
  await page.evaluate(() => { const u = __tf.newTab({ name: 'extra.log', content: 'x' }); __tf.addSplitPane(u); const v = __tf.newTab({ name: 'extra2.log', content: 'y' }); __tf.addSplitPane(v); });
  await page.waitForTimeout(300);
  r = await page.evaluate(() => __tf.split.panes.length);
  ok('Up to 4 files side by side (the main editor plus 3 panes)', r === 3, r + ' panes');
  await page.click('.sp-pane >> nth=0 >> button[title="Close this pane"]');
  r = await page.evaluate(() => __tf.split.panes.length);
  ok('A pane closes on its own', r === 2, r + ' panes');
  await page.keyboard.press('Control+Backslash');
  r = await page.evaluate(() => ({ hidden: document.getElementById('split').hidden, panes: __tf.split.panes.length }));
  ok('Ctrl+\\ closes the split view', r.hidden && r.panes === 0, JSON.stringify(r));
  ok('No errors', errors.length === 0, errors.join(' | ') || 'none');

  let pass = 0;
  for (const x of results) { if (x.pass) pass++; console.log((x.pass ? 'PASS ' : 'FAIL ') + x.name + '  —  ' + x.detail); }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exitCode = pass === results.length ? 0 : 1;
})().catch((e) => { console.error('WORKSPACE TESTS FAILED', e); process.exit(2); });
