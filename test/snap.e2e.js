/* 0.10.0 snap layouts: the layout picker on the split button, Snap Assist for empty spaces, the snap
   bar and zone targets while dragging a tab, resizing in grid layouts, phones.
   Usage: node test/snap.e2e.js [selfhost URL] */
const path = require('path');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(process.env.HOME || '', '.npm-global/lib/node_modules/playwright')); }
const URL_ = process.argv[2] || 'http://127.0.0.1:8765/';
const results = [];
const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail });
const mk = (svc, off) => Array.from({ length: 300 }, (_, i) => `2026-11-03 10:${String(Math.floor((i * 3 + off) / 60)).padStart(2, '0')}:${String((i * 3 + off) % 60).padStart(2, '0')}.000 ${i % 25 ? 'INFO' : 'ERROR'} [exec-${i % 4}] c.w.${svc} - ${svc} step ${i}`).join('\n');
async function dragTab(page, tabSel, targetSel, pos, { drop = true } = {}) {
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await page.locator(tabSel).dispatchEvent('dragstart', { dataTransfer: dt });
  await page.locator('#work').dispatchEvent('dragenter', { dataTransfer: dt });
  await page.waitForTimeout(100);
  const box = await page.locator(targetSel).boundingBox();
  const at = { clientX: box.x + (pos ? pos.x : box.width / 2), clientY: box.y + (pos ? pos.y : box.height / 2) };
  await page.locator(targetSel).dispatchEvent('dragover', Object.assign({ dataTransfer: dt }, at));
  if (!drop) return dt;
  await page.locator(targetSel).dispatchEvent('drop', Object.assign({ dataTransfer: dt }, at));
  await page.locator(tabSel).dispatchEvent('dragend', { dataTransfer: dt });
  await page.waitForTimeout(300);
  return dt;
}
const state = (page) => page.evaluate(() => ({ layout: __tf.split && __tf.split.layout, main: __tf.active.name, panes: __tf.split ? __tf.split.panes.map((p) => (p.tab ? p.tab.name : null)) : [] }));

(async () => {
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL_);
  await page.waitForFunction(() => window.__tf && window.__tf.active, null, { timeout: 60000 });
  await page.evaluate(([a, c, d]) => { const g = __tf.newTab({ name: 'gateway.log', content: a }); __tf.newTab({ name: 'order.log', content: c }); __tf.newTab({ name: 'payment.log', content: d }); __tf.activate(g); }, [mk('Gateway', 0), mk('Order', 1), mk('Payment', 2)]);
  await page.waitForTimeout(500);
  const ids = await page.evaluate(() => Object.fromEntries(__tf.tabs.map((t) => [t.name, t.id])));
  let r;

  // picker
  await page.hover('#topbar [data-act="split"]');
  await page.waitForTimeout(700);
  r = await page.evaluate(() => [...document.querySelectorAll('#snap-picker .snap-thumb')].map((t) => t.dataset.layout + ':' + t.querySelectorAll('.snap-zone').length));
  ok('Hovering the split button shows the 5 snap layouts', JSON.stringify(r) === JSON.stringify(['cols2:2', 'rows2:2', 'cols3:3', 'right2:3', 'grid4:4']), r.join(' '));
  await page.click('#snap-picker .snap-thumb[data-layout="cols2"] .snap-zone[data-slot="a"]');
  await page.waitForTimeout(300);
  r = await state(page);
  ok('Clicking the left space of "side by side" keeps this file on the left; the right space asks (Snap Assist)', r.layout === 'cols2' && r.main === 'gateway.log' && r.panes.length === 1 && r.panes[0] === null, JSON.stringify(r));
  r = await page.evaluate(() => ({ visible: !document.querySelector('.sp-assist').hidden, cards: [...document.querySelectorAll('.sp-assist .sa-card .nm')].map((x) => x.textContent) }));
  ok('Snap Assist lists the open files', r.visible && r.cards.includes('order.log') && r.cards.includes('payment.log'), JSON.stringify(r));
  await page.click('.sp-assist .sa-card:has-text("payment.log")');
  await page.waitForTimeout(300);
  r = await state(page);
  ok('Picking a card fills the space', r.panes[0] === 'payment.log', JSON.stringify(r));
  // keyboard: the button opens the picker and focuses a zone
  await page.click('#topbar [data-act="split"]');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ open: !!document.getElementById('snap-picker'), focus: document.activeElement && document.activeElement.classList.contains('snap-zone'), current: document.querySelector('#snap-picker .snap-thumb.current') && document.querySelector('#snap-picker .snap-thumb.current').dataset.layout }));
  ok('Clicking the button opens the picker with keyboard focus; the current layout is marked', r.open && r.focus && r.current === 'cols2', JSON.stringify(r));
  await page.keyboard.press('Escape');
  r = await page.evaluate(() => !document.getElementById('snap-picker'));
  ok('Esc closes the picker', r, String(r));
  // a different zone for this file: the main space gets another file
  await page.click('#topbar [data-act="split"]');
  await page.click('#snap-picker .snap-thumb[data-layout="right2"] .snap-zone[data-slot="b"]');
  await page.waitForTimeout(300);
  r = await state(page);
  ok('"One large, two stacked", top right: this file goes there, the others keep their places', r.layout === 'right2' && r.panes[0] === 'gateway.log' && r.main === 'payment.log' && r.panes[1] === null, JSON.stringify(r));
  r = await page.evaluate(() => { const rect = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; }; const [p1, p2] = document.querySelectorAll('.sp-pane'); return { main: rect(document.getElementById('editor')), p1: rect(p1), p2: rect(p2) }; });
  ok('The large space is full height on the left, the two others are stacked on the right', r.main.h > r.p1.h * 1.8 && r.p1.x === r.p2.x && r.p2.y > r.p1.y && Math.abs(r.main.w - r.p1.w) < 20, JSON.stringify(r));
  // resize the stacked pair
  const g = await page.evaluate(() => { const b = document.querySelector('.sp-gutter.gy').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + 3 }; });
  const h0 = await page.evaluate(() => document.querySelector('.sp-pane').getBoundingClientRect().height);
  await page.mouse.move(g.x, g.y); await page.mouse.down(); await page.mouse.move(g.x, g.y + 150, { steps: 6 }); await page.mouse.up();
  const h1 = await page.evaluate(() => document.querySelector('.sp-pane').getBoundingClientRect().height);
  ok('The divider between stacked files resizes them', h1 > h0 + 120, Math.round(h0) + 'px -> ' + Math.round(h1) + 'px');
  // "Leave this space out" on the empty one
  await page.click('.sp-assist:not([hidden]) >> text=Leave this space out');
  await page.waitForTimeout(300);
  r = await state(page);
  ok('"Leave this space out" drops the empty space and the layout adapts', r.layout === 'cols2' && r.panes.length === 1 && r.panes[0] === 'gateway.log', JSON.stringify(r));

  // dragging a tab: the snap bar and big targets
  await page.keyboard.press('Control+Backslash');
  await page.waitForTimeout(200);
  await dragTab(page, `.tab[data-tab="${ids['order.log']}"]`, '#editor', { x: 900, y: 400 }, { drop: false });
  r = await page.evaluate(() => ({ bar: !document.getElementById('snapbar').hidden && document.querySelectorAll('#snapbar .snap-thumb').length, preview: !document.getElementById('snap-preview').hidden && document.querySelector('#snap-preview span').textContent, rect: (() => { const p = document.getElementById('snap-preview').getBoundingClientRect(); const e = document.getElementById('editors').getBoundingClientRect(); return { left: Math.round(p.left - e.left), w: Math.round(p.width), ew: Math.round(e.width) }; })() }));
  ok('While dragging a tab, the snap bar shows every layout', r.bar === 5, JSON.stringify(r.bar));
  ok('Hovering the right half outlines where the file will go', /side by side/.test(r.preview) && r.rect.left > r.rect.ew * 0.45 && r.rect.w < r.rect.ew * 0.55, JSON.stringify(r));
  await page.locator('#work').dispatchEvent('dragleave', {});
  await page.evaluate(() => document.querySelector('.tab').dispatchEvent(new DragEvent('dragend', { bubbles: true })));
  await dragTab(page, `.tab[data-tab="${ids['order.log']}"]`, '#snapbar .snap-thumb[data-layout="grid4"] .snap-zone[data-slot="d"]');
  r = await state(page);
  ok('Dropping on a zone of the snap bar snaps the file there (2 × 2, bottom right)', r.layout === 'grid4' && r.panes[2] === 'order.log' && r.panes.filter(Boolean).length === 1, JSON.stringify(r));
  r = await page.evaluate(() => ({ bar: document.getElementById('snapbar').hidden, preview: document.getElementById('snap-preview').hidden }));
  ok('The snap bar and outline go away after the drop', r.bar && r.preview, JSON.stringify(r));
  // drop on an existing space replaces it
  const pane0 = await page.evaluate(() => __tf.split.panes[0].id);
  await dragTab(page, `.tab[data-tab="${ids['gateway.log']}"]`, `.sp-pane[data-pane="${pane0}"] .sp-body`);
  r = await state(page);
  ok('Dropping on a space in the current layout shows the file there', r.panes[0] === 'gateway.log', JSON.stringify(r));
  // the picker can switch back to one editor
  await page.click('#topbar [data-act="split"]');
  await page.click('#snap-picker >> text=Back to one editor');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ open: document.body.classList.contains('split-open'), grid: getComputedStyle(document.getElementById('editors')).gridTemplateAreas }));
  ok('"Back to one editor" closes the layout', !r.open && r.grid === '"a"', JSON.stringify(r));
  // command palette has the layouts too
  r = await page.evaluate(() => { __tf.runCommand('Snap layout: four in a grid'); return __tf.split.layout; });
  ok('The command palette has every layout', r === 'grid4', r);
  // phones: everything stacks
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  r = await page.evaluate(() => { const els = [document.getElementById('editor'), ...document.querySelectorAll('.sp-pane')].map((e) => e.getBoundingClientRect()); return { xs: els.map((b) => Math.round(b.x)), ys: els.map((b) => Math.round(b.y)), hscroll: document.documentElement.scrollWidth > innerWidth }; });
  ok('On a phone the files stack top to bottom', new Set(r.xs).size === 1 && r.ys.every((y, i) => i === 0 || y > r.ys[i - 1]) && !r.hscroll, JSON.stringify(r));
  ok('No errors', errors.length === 0, errors.join(' | ') || 'none');

  let pass = 0;
  for (const x of results) { if (x.pass) pass++; console.log((x.pass ? 'PASS ' : 'FAIL ') + x.name + '  —  ' + x.detail); }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exitCode = pass === results.length ? 0 : 1;
})().catch((e) => { console.error('SNAP TESTS FAILED', e); process.exit(2); });
