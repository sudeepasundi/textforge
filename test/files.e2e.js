/* 0.11.0: the Open files list in the sidebar. Usage: node test/files.e2e.js [selfhost URL] */
const path = require('path');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(process.env.HOME || '', '.npm-global/lib/node_modules/playwright')); }
const URL_ = process.argv[2] || 'http://127.0.0.1:8765/';
const results = [];
const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail });
async function dragTab(page, srcSel, targetSel, pos) {
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await page.locator(srcSel).dispatchEvent('dragstart', { dataTransfer: dt });
  await page.locator('#work').dispatchEvent('dragenter', { dataTransfer: dt });
  await page.waitForTimeout(100);
  const box = await page.locator(targetSel).boundingBox();
  const at = { clientX: box.x + (pos ? pos.x : box.width / 2), clientY: box.y + (pos ? pos.y : box.height / 2) };
  await page.locator(targetSel).dispatchEvent('dragover', Object.assign({ dataTransfer: dt }, at));
  await page.locator(targetSel).dispatchEvent('drop', Object.assign({ dataTransfer: dt }, at));
  await page.locator(srcSel).dispatchEvent('dragend', { dataTransfer: dt });
  await page.waitForTimeout(300);
}
const names = (page) => page.evaluate(() => [...document.querySelectorAll('.view[data-view="files"] .fl-item .fl-name')].map((x) => x.textContent));

(async () => {
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL_);
  await page.waitForFunction(() => window.__tf && window.__tf.active, null, { timeout: 60000 });
  await page.evaluate(() => {
    const mk = (s) => Array.from({ length: 40 }, (_, i) => `2026-11-03 10:00:${String(i).padStart(2, '0')}.000 INFO [m] c.w.${s} - ${s} ${i}`).join('\n');
    for (const n of ['gateway.log', 'order.log', 'payment.log', 'inventory.log', 'notes.md', 'query.sql', 'config.json', 'auth.log', 'kafka-consumer.log', 'user-service.log', 'readme.txt', 'zeta.log']) __tf.newTab({ name: n, content: n.endsWith('.log') ? mk(n) : 'text ' + n });
    __tf.activate(__tf.tabs.find((t) => t.name === 'gateway.log'));
  });
  await page.waitForTimeout(400);
  let r;
  r = await page.evaluate(() => ({ btn: !!document.querySelector('#rail .rail-btn[data-view="files"]'), first: document.querySelector('#rail .rail-btn').dataset.view, badge: document.querySelector('#rail .files-count').textContent }));
  ok('A rail button for Open files, first in the rail, with the number of open files', r.btn && r.first === 'files' && +r.badge >= 12, JSON.stringify(r));
  await page.keyboard.press('Control+Shift+E');
  await page.waitForTimeout(200);
  const all = await names(page);
  const tabOrder = await page.evaluate(() => __tf.tabs.map((t) => t.name));
  ok('Ctrl+Shift+E opens the list with every open file, in tab order', JSON.stringify(all) === JSON.stringify(tabOrder), all.length + ' files');
  r = await page.evaluate(() => { const a = document.querySelector('.fl-item.active'); return { name: a && a.querySelector('.fl-name').textContent, where: a && a.querySelector('.fl-where').textContent, logs: document.querySelectorAll('.fl-kind.log').length }; });
  ok('The file in the editor is highlighted and marked "open"; logs are marked', r.name === 'gateway.log' && r.where === 'open' && r.logs >= 8, JSON.stringify(r));
  // click opens
  await page.click('.fl-item:has-text("payment.log")');
  r = await page.evaluate(() => ({ active: __tf.active.name, hl: document.querySelector('.fl-item.active .fl-name').textContent, tab: document.querySelector('.tab.active .name').textContent }));
  ok('Clicking a file opens it (the tab bar follows)', r.active === 'payment.log' && r.hl === 'payment.log' && r.tab === 'payment.log', JSON.stringify(r));
  // filter
  await page.fill('.fl-search', 'user-serv');
  await page.waitForTimeout(150);
  r = await names(page);
  ok('Typing filters the list', JSON.stringify(r) === JSON.stringify(['user-service.log']), r.join(', '));
  await page.keyboard.press('Enter');
  r = await page.evaluate(() => __tf.active.name);
  ok('Enter in the filter box opens the first match', r === 'user-service.log', r);
  await page.fill('.fl-search', '');
  // sort
  await page.selectOption('.fl-sort', 'name');
  r = await names(page);
  const sorted = r.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  ok('Sort by name', JSON.stringify(r) === JSON.stringify(sorted), r.slice(0, 4).join(', ') + '…');
  await page.selectOption('.fl-sort', 'recent');
  r = await names(page);
  ok('Sort by recently used', r[0] === 'user-service.log' && r[1] === 'payment.log', r.slice(0, 3).join(', '));
  await page.selectOption('.fl-sort', 'open');
  // keyboard navigation
  await page.click('.fl-search');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  r = await page.evaluate(() => __tf.active.name);
  ok('Arrow keys move through the list; Enter opens', r === tabOrder[1], r);
  // dirty marker
  await page.evaluate(() => { const t = __tf.tabs.find((x) => x.name === 'notes.md'); t.model.setValue('changed'); });
  await page.waitForTimeout(200);
  r = await page.evaluate(() => { const it = [...document.querySelectorAll('.fl-item')].find((x) => x.textContent.includes('notes.md')); return { dirty: it.classList.contains('dirty'), dot: getComputedStyle(it.querySelector('.fl-dot')).display, summary: document.querySelector('.fl-summary').textContent }; });
  ok('Unsaved files show a dot, and the summary counts them', r.dirty && r.dot === 'block' && /\d+ unsaved/.test(r.summary), JSON.stringify(r));
  // rename by double-click
  await page.dblclick('.fl-item:has-text("readme.txt") .fl-name');
  await page.waitForSelector('.fl-rename');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('README.md');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ list: [...document.querySelectorAll('.fl-name')].map((x) => x.textContent).includes('README.md'), tab: [...document.querySelectorAll('.tab .name')].map((x) => x.textContent).includes('README.md') }));
  ok('Double-click renames (the tab is renamed too)', r.list && r.tab, JSON.stringify(r));
  // reorder by dragging in the list
  const ids = await page.evaluate(() => Object.fromEntries(__tf.tabs.map((t) => [t.name, t.id])));
  const before = await page.evaluate(() => __tf.tabs.map((t) => t.name));
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await page.locator(`.fl-item[data-tab="${ids['zeta.log']}"]`).dispatchEvent('dragstart', { dataTransfer: dt });
  const tb = await page.locator(`.fl-item[data-tab="${ids['gateway.log']}"]`).boundingBox();
  await page.locator(`.fl-item[data-tab="${ids['gateway.log']}"]`).dispatchEvent('dragover', { dataTransfer: dt, clientX: tb.x + 20, clientY: tb.y + 3 });
  await page.locator(`.fl-item[data-tab="${ids['gateway.log']}"]`).dispatchEvent('drop', { dataTransfer: dt, clientX: tb.x + 20, clientY: tb.y + 3 });
  await page.locator(`.fl-item[data-tab="${ids['zeta.log']}"]`).dispatchEvent('dragend', { dataTransfer: dt });
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ tabs: __tf.tabs.map((t) => t.name), list: [...document.querySelectorAll('.fl-name')].map((x) => x.textContent), bar: [...document.querySelectorAll('.tab .name')].map((x) => x.textContent) }));
  ok('Dragging in the list reorders the files (tab bar too)', r.tabs.indexOf('zeta.log') === r.tabs.indexOf('gateway.log') - 1 && JSON.stringify(r.list) === JSON.stringify(r.tabs) && JSON.stringify(r.bar) === JSON.stringify(r.tabs), before.slice(0, 3).join(', ') + ' -> ' + r.tabs.slice(0, 3).join(', '));
  // drag from the list onto the editor -> split view
  await page.click('.fl-item:has-text("gateway.log")');
  const ew = await page.evaluate(() => document.getElementById('editor').getBoundingClientRect().width);
  await dragTab(page, `.fl-item[data-tab="${ids['order.log']}"]`, '#editor', { x: ew * 0.8, y: 300 });
  r = await page.evaluate(() => ({ panes: __tf.split ? __tf.split.panes.map((p) => p.tab && p.tab.name) : [], tag: (() => { const it = [...document.querySelectorAll('.fl-item')].find((x) => x.textContent.includes('order.log')); return it && it.querySelector('.fl-where') && it.querySelector('.fl-where').textContent; })(), summary: document.querySelector('.fl-summary').textContent }));
  ok('Dragging a file from the list onto the editor shows it side by side, and the list marks it "split"', JSON.stringify(r.panes) === '["order.log"]' && r.tag === 'split' && /2 on screen/.test(r.summary), JSON.stringify(r));
  // right-click menu and close
  await page.click('.fl-item:has-text("query.sql")', { button: 'right' });
  r = await page.evaluate(() => [...document.querySelectorAll('.menu button')].map((b) => b.textContent));
  ok('Right-click shows the same menu as a tab', r.includes('Rename') && r.includes('Close') && r.includes('Close other tabs'), r.join(' | '));
  await page.keyboard.press('Escape');
  const n0 = await page.evaluate(() => __tf.tabs.length);
  await page.hover('.fl-item:has-text("query.sql")');
  await page.click('.fl-item:has-text("query.sql") .fl-x');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ n: __tf.tabs.length, inList: [...document.querySelectorAll('.fl-name')].some((x) => x.textContent === 'query.sql') }));
  ok('The × closes a file', r.n === n0 - 1 && !r.inList, JSON.stringify(r));
  // the top tab bar is still there and in sync
  r = await page.evaluate(() => ({ bar: document.querySelectorAll('.tab').length, list: document.querySelectorAll('.fl-item').length }));
  ok('The tab bar stays, with the same files', r.bar === r.list, JSON.stringify(r));
  // filter with no match
  await page.fill('.fl-search', 'nothing-like-this');
  r = await page.evaluate(() => document.querySelector('.fl-list .msg') && document.querySelector('.fl-list .msg').textContent);
  ok('A filter with no match says so', /No open file matches/.test(r || ''), r);
  await page.fill('.fl-search', '');
  // phone
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ hscroll: document.documentElement.scrollWidth > innerWidth, items: document.querySelectorAll('.fl-item').length }));
  ok('Works on a phone without sideways scrolling', !r.hscroll && r.items > 5, JSON.stringify(r));
  // 0.18.2: no New / Open / Close saved buttons (the title bar has them); clickable shortcuts instead
  r = await page.evaluate(() => { __tf.showView('files', { toggle: false }); const v = document.querySelector('.view[data-view="files"]'); return { buttons: [...v.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => /^(New tab|Open a file…|Close saved)$/.test(t)), quick: [...v.querySelectorAll('.fl-q')].map((b) => b.innerText.replace(/\s+/g, ' ').trim()) }; });
  ok('Open files has no New tab / Open / Close saved buttons, and lists shortcuts with their keys', r.buttons.length === 0 && /^Search all commands Ctrl Shift P$/.test(r.quick[0]) && r.quick.some((x) => /^Compare with… Alt D$/.test(x)) && r.quick.length >= 8, JSON.stringify(r));
  await page.click('.view[data-view="files"] .fl-q:has-text("Search all commands")');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => !document.getElementById('palette').hidden);
  ok('A shortcut runs its command when clicked', r, String(r));
  await page.keyboard.press('Escape');
  ok('No errors', errors.length === 0, errors.join(' | ') || 'none');
  let pass = 0;
  for (const x of results) { if (x.pass) pass++; console.log((x.pass ? 'PASS ' : 'FAIL ') + x.name + '  —  ' + x.detail); }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exitCode = pass === results.length ? 0 : 1;
})().catch((e) => { console.error('FILES TESTS FAILED', e); process.exit(2); });
