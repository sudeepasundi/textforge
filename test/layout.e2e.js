/* 0.8.0 layout checks: sidebar closed at start, no Copilot rail button, compact density, split view
   (open, time sync, swap, resize, narrow header, close, phone layout) and the logo.
   Usage: node test/layout.e2e.js [selfhost URL] */
const path = require('path');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(process.env.HOME || '', '.npm-global/lib/node_modules/playwright')); }
const URL_ = process.argv[2] || 'http://127.0.0.1:8765/';
const results = [];
const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail });
const mk = (svc, off) => Array.from({ length: 400 }, (_, i) => `2026-11-03 10:${String(Math.floor((i * 3 + off) / 60)).padStart(2, '0')}:${String((i * 3 + off) % 60).padStart(2, '0')}.000 ${i % 37 ? 'INFO' : 'ERROR'} [exec-${i % 4}] c.w.${svc} - ${svc} step ${i}`).join('\n');

(async () => {
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL_);
  await page.waitForFunction(() => window.__tf && window.__tf.active, null, { timeout: 60000 });
  // the sidebar stays closed even after it was used and the page is reloaded
  await page.evaluate(() => __tf.showView('insights', { toggle: false }));
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForFunction(() => window.__tf && window.__tf.active, null, { timeout: 60000 });
  await page.evaluate((t) => { const x = __tf.newTab({ name: 'opened.log', content: t }); __tf.activate(x); }, mk('X', 0));
  await page.waitForTimeout(400);
  let r = await page.evaluate(() => ({ side: !document.getElementById('side').hidden, cpRail: !!document.querySelector('.rail-btn[data-view="copilot"]'), fab: !!document.getElementById('cp-fab') }));
  ok('Sidebar stays closed at start and when a log is opened', !r.side, JSON.stringify(r));
  ok('No Copilot button in the side rail; the floating button stays', !r.cpRail && r.fab, JSON.stringify(r));
  r = await page.evaluate(() => { const b = document.querySelector('.brand svg.logo'); const w = document.querySelector('#welcome svg.logo'); return { brand: !!b && b.getBoundingClientRect().width >= 18, welcome: !!w, stroke: b && getComputedStyle(b).stroke }; });
  ok('New logo in the top bar and on the welcome card', r.brand && r.welcome && r.stroke === 'none', JSON.stringify(r));

  // density
  const sizes = () => page.evaluate(() => ({ bar: Math.round(document.getElementById('topbar').getBoundingClientRect().height), rail: Math.round(document.getElementById('rail').getBoundingClientRect().width), status: Math.round(document.getElementById('statusbar').getBoundingClientRect().height), line: __tf.editor.getOption(monaco.editor.EditorOption.lineHeight) }));
  const comfy = await sizes();
  await page.evaluate(() => __tf.showView('appearance', { toggle: false }));
  await page.click('.seg button:has-text("Compact")');
  await page.waitForTimeout(200);
  const compact = await sizes();
  ok('Compact density shrinks bars, rail, status bar and line spacing', compact.bar < comfy.bar && compact.rail < comfy.rail && compact.status < comfy.status && compact.line < comfy.line, JSON.stringify({ comfy, compact }));
  await page.click('.seg button:has-text("Comfortable")');
  await page.evaluate(() => __tf.showView('appearance'));

  // split view
  await page.evaluate(([a, c]) => { const x = __tf.newTab({ name: 'gateway.log', content: a }); __tf.newTab({ name: 'payment.log', content: c }); __tf.activate(x); }, [mk('Gateway', 0), mk('Payment', 1)]);
  await page.waitForTimeout(500);
  await page.click('#topbar [data-act="split"]');
  await page.waitForTimeout(400);
  r = await page.evaluate(() => ({ open: !document.getElementById('split').hidden, right: __tf.split.panes[0].tab.name, sync: document.querySelector('.sp-sync select').value }));
  ok('Split button opens the most recent other log on the right, synced by time', r.open && r.right === 'payment.log' && r.sync === 'time', JSON.stringify(r));
  await page.evaluate(() => __tf.editor.revealLineNearTop(200));
  await page.waitForTimeout(300);
  // gateway lines are at 0, 3, 6 s...; payment lines at 1, 4, 7 s...: the right side must land 1 s later
  const tops = () => page.evaluate(() => { const l = __tf.topFullLine(__tf.editor); const rr = __tf.topFullLine(__tf.split.panes[0].editor); const sec = (m, n) => { const x = m.getLineContent(n).slice(11, 19).split(':').map(Number); return x[0] * 3600 + x[1] * 60 + x[2]; }; return { l, r: rr, dt: sec(__tf.split.panes[0].tab.model, rr) - sec(__tf.active.model, l) }; });
  r = await tops();
  ok('Scrolling the left side brings the right side to the same time', r.l > 150 && Math.abs(r.dt) <= 2, JSON.stringify(r));
  await page.evaluate(() => __tf.split.panes[0].editor.revealLineNearTop(100));
  await page.waitForTimeout(300);
  r = await tops();
  ok('Scrolling the right side moves the left side too', r.l < 120 && Math.abs(r.dt) <= 2, JSON.stringify(r));
  await page.selectOption('.sp-sync select', 'off');
  await page.evaluate(() => __tf.editor.revealLineNearTop(5));
  await page.waitForTimeout(300);
  r = await page.evaluate(() => __tf.split.panes[0].editor.getVisibleRanges()[0].startLineNumber);
  ok('"Scroll together: off" keeps the sides independent', r > 50, 'right side at line ' + r);
  await page.click('.sp-pane button[title="Swap with the main editor"]');
  r = await page.evaluate(() => ({ left: __tf.active.name, right: __tf.split.panes[0].tab.name }));
  ok('Swap exchanges the two sides', r.left === 'payment.log' && r.right === 'gateway.log', JSON.stringify(r));
  const g = await page.evaluate(() => { const b = document.querySelector('.sp-gutter.outer').getBoundingClientRect(); return { x: b.x + 3, y: b.y + 200 }; });
  await page.mouse.move(g.x, g.y); await page.mouse.down(); await page.mouse.move(g.x + 300, g.y, { steps: 5 }); await page.mouse.up();
  r = await page.evaluate(() => { const p = document.querySelector('.sp-pane').getBoundingClientRect(); const c = document.querySelector('.sp-pane button[title="Close this pane"]').getBoundingClientRect(); return { w: Math.round(p.width), closeVisible: c.width > 0 && c.right <= p.right + 0.5 }; });
  ok('Divider resizes; the header still fits when narrow', r.w < 450 && r.closeVisible, JSON.stringify(r));
  await page.keyboard.press('Control+Backslash');
  r = await page.evaluate(() => document.getElementById('split').hidden);
  ok('Ctrl+\\ closes the split view', r, String(r));
  await page.evaluate(() => __tf.openSplit());
  await page.evaluate(async () => { const t = __tf.split.panes[0] && __tf.split.panes[0].tab; await __tf.runCommand('Close tab').catch(() => {}); });
  // closing the tab shown on the right picks another one
  await page.evaluate(async () => { const t = __tf.split.panes[0].tab; __tf.activate(t); });
  await page.keyboard.press('Control+w').catch(() => {});
  await page.waitForTimeout(300);
  r = await page.evaluate(() => ({ open: !document.getElementById('split').hidden, right: __tf.split.panes[0] && __tf.split.panes[0].tab.name, tabs: __tf.tabs.map((t) => t.name) }));
  ok('Closing a tab never leaves the right side empty', !r.open || (r.right && r.tabs.includes(r.right)), JSON.stringify(r));
  // timeline: drag a time range, double-click clears it
  await page.evaluate(() => { __tf.closeSplit(); __tf.openSample(); });
  await page.waitForTimeout(700);
  const sb = await page.evaluate(() => { const b = document.getElementById('signal').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  await page.mouse.move(sb.x + sb.w * 0.25, sb.y + sb.h * 0.6); await page.mouse.down();
  await page.mouse.move(sb.x + sb.w * 0.45, sb.y + sb.h * 0.6, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(300);
  r = await page.evaluate(() => ({ shown: __tf.active.an.vis.reduce((a, x) => a + x, 0), total: __tf.active.an.entries.length, from: __tf.active.filter.from, to: __tf.active.filter.to, shade: !document.querySelector('#signal .range').hidden }));
  ok('Dragging on the timeline shows only that time range', r.shown > 0 && r.shown < r.total && r.from && r.to && r.shade, JSON.stringify(r));
  await page.mouse.dblclick(sb.x + sb.w * 0.7, sb.y + sb.h * 0.6); await page.waitForTimeout(300);
  r = await page.evaluate(() => ({ from: __tf.active.filter.from, to: __tf.active.filter.to, shade: !document.querySelector('#signal .range').hidden }));
  ok('Double-clicking the timeline shows all times again', !r.from && !r.to && !r.shade, JSON.stringify(r));
  // phone
  await page.setViewportSize({ width: 1440, height: 860 });
  await page.evaluate(() => __tf.openSplit());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  r = await page.evaluate(() => { const s = document.getElementById('split').getBoundingClientRect(); const e = document.getElementById('editor').getBoundingClientRect(); return { stacked: s.top >= e.bottom - 1, hscroll: document.documentElement.scrollWidth > innerWidth }; });
  ok('On a phone the second side sits below, no sideways scrolling', r.stacked && !r.hscroll, JSON.stringify(r));
  ok('No errors', errors.length === 0, errors.join(' | ') || 'none');
  let pass = 0;
  for (const x of results) { if (x.pass) pass++; console.log((x.pass ? 'PASS ' : 'FAIL ') + x.name + '  —  ' + x.detail); }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exitCode = pass === results.length ? 0 : 1;
})().catch((e) => { console.error('LAYOUT TESTS FAILED', e); process.exit(2); });
