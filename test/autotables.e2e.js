/* Automatic tables in the app: command, pattern list, switching tables, count-by keeping the list,
   other panels unaffected, phone layout. Usage: node test/autotables.e2e.js [selfhost URL] */
const path = require('path'), fs = require('fs');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(process.env.HOME || '', '.npm-global/lib/node_modules/playwright')); }
const URL_ = process.argv[2] || 'http://127.0.0.1:8765/';
const results = [];
const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail });
const json = [];
for (let i = 0; i < 60; i++) {
  const ts = `2026-11-03T10:${String(10 + (i % 40)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;
  if (i % 3 === 0) json.push(JSON.stringify({ '@timestamp': ts, level: 'INFO', logger_name: 'c.w.Pay', message: `Payment ${['succeeded', 'failed'][i % 2]} for order ${1000 + i} in ${i * 3} ms`, currency: i % 2 ? 'INR' : 'USD' }));
  if (i % 3 === 1) json.push(JSON.stringify({ '@timestamp': ts, level: 'WARN', logger_name: 'c.w.Stock', message: `Stock low for sku SKU-${i}: ${i % 4} left` }));
  if (i % 3 === 2) json.push(JSON.stringify({ '@timestamp': ts, level: 'INFO', logger_name: 'c.w.Dup', message: 'Heartbeat ok' }));
}
(async () => {
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL_);
  await page.waitForFunction(() => window.__tf && window.__tf.active, null, { timeout: 60000 });
  await page.evaluate((t) => { const x = __tf.newTab({ name: 'svc.log', content: t }); __tf.activate(x); }, json.join('\n') + '\n');
  await page.waitForTimeout(600);
  await page.evaluate(async () => { await __tf.runCommand('Auto tables'); });
  await page.waitForSelector('.at-item', { timeout: 10000 });
  let r = await page.evaluate(() => ({ items: Array.from(document.querySelectorAll('.at-item')).map((x) => x.textContent), th: Array.from(document.querySelectorAll('.at-main th')).map((x) => x.textContent) }));
  ok('Command "Auto tables" lists the detected patterns (plus All entries)', r.items.length === 4 && /All entries/.test(r.items[0]), r.items.length + ' items');
  ok('The biggest pattern opens first with learned column names', JSON.stringify(r.th) === JSON.stringify(['Line', 'time', 'Payment', 'order', 'ms', 'currency']), r.th.join(', '));
  await page.click('.at-item:has-text("Stock low")');
  r = await page.evaluate(() => Array.from(document.querySelectorAll('.at-main th')).map((x) => x.textContent));
  ok('Clicking a pattern shows its table', JSON.stringify(r) === JSON.stringify(['Line', 'time', 'sku', 'left']), r.join(', '));
  await page.selectOption('#panel-tools select', { label: 'left' });
  await page.click('#panel-tools >> text=Count by value');
  r = await page.evaluate(() => ({ list: !!document.querySelector('.at-list'), title: document.getElementById('panel-title').textContent }));
  ok('Count by value keeps the pattern list beside it', r.list && /Count by left/.test(r.title), r.title);
  await page.fill('.at-list input', 'heart');
  r = await page.evaluate(() => Array.from(document.querySelectorAll('.at-item')).map((x) => x.textContent));
  ok('The pattern list can be filtered', r.length === 1 && /Heartbeat/.test(r[0]), r.join(' / '));
  await page.click('.at-item:has-text("Heartbeat")');
  const want = await page.evaluate(() => +document.querySelector('.at-main td.ln').textContent);
  await page.click('.at-main td.ln');
  r = await page.evaluate(() => __tf.editor.getPosition().lineNumber);
  ok('Clicking a line number jumps to it in the log', r === want, 'line ' + r + ' (wanted ' + want + ')');
  await page.evaluate(() => __tf.runCommand('Find duplicate'));
  await page.waitForTimeout(300);
  r = await page.evaluate(() => ({ split: document.getElementById('panel-body').classList.contains('at-split'), title: document.getElementById('panel-title').textContent }));
  ok('Other result panels do not show the pattern list', !r.split, r.title);
  // Extract sidebar: auto-detect is the default, the button says so
  await page.keyboard.press('Alt+2').catch(() => {});
  await page.evaluate(() => __tf.showView('extract', { toggle: false }));
  r = await page.evaluate(() => ({ sel: document.querySelector('.view[data-view="extract"] select').value, btn: document.querySelector('.view[data-view="extract"] button.primary').textContent, regex: document.querySelector('.view[data-view="extract"] textarea').closest('.field').hidden }));
  ok('Extract opens on auto-detect with a "Build tables" button', r.sel === 'auto' && r.btn === 'Build tables' && r.regex, JSON.stringify(r));
  // phone
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => __tf.runCommand('Auto tables'));
  await page.waitForTimeout(400);
  r = await page.evaluate(() => { const l = document.querySelector('.at-list').getBoundingClientRect(); const m = document.querySelector('.at-main').getBoundingClientRect(); return { stacked: m.top >= l.bottom - 1, hscroll: document.documentElement.scrollWidth > innerWidth }; });
  ok('On a phone the list sits above the table, no sideways scrolling', r.stacked && !r.hscroll, JSON.stringify(r));
  ok('No errors', errors.length === 0, errors.join(' | ') || 'none');
  let pass = 0;
  for (const x of results) { if (x.pass) pass++; console.log((x.pass ? 'PASS ' : 'FAIL ') + x.name + '  —  ' + x.detail); }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exitCode = pass === results.length ? 0 : 1;
})().catch((e) => { console.error('AUTO TABLE TESTS FAILED', e); process.exit(2); });
