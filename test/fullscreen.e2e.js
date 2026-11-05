/* 0.12.0: resizing and full screen across the app - the preview (drag, Alt+Shift+P, double-click,
   Esc), the comparison, the results panel, Copilot, the sidebar, split panes, and phones.
   Usage: node test/fullscreen.e2e.js [selfhost URL] */
const path = require('path');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(process.env.HOME || '', '.npm-global/lib/node_modules/playwright')); }
const URL_ = process.argv[2] || 'http://127.0.0.1:8765/';
const results = [];
const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail });
const MD = '# Release notes\n\n| Service | p95 (ms) | Errors |\n|---|---|---|\n| gateway | 120 | 3 |\n| order | 340 | 12 |\n| payment | 910 | 41 |\n\n' + Array.from({ length: 60 }, (_, i) => `Paragraph ${i} with some **bold** text.`).join('\n\n');
const rect = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el || el.hidden) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; }, sel);
const win = (page) => page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
const fills = (r, w) => r && r.x === 0 && r.y === 0 && r.w === w.w && r.h === w.h;

(async () => {
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL_);
  await page.waitForFunction(() => window.__tf && window.__tf.active, null, { timeout: 60000 });
  await page.evaluate((md) => { const t = __tf.newTab({ name: 'notes.md', content: md }); __tf.activate(t); }, MD);
  await page.waitForTimeout(300);
  const W = await win(page);
  let r;

  // ---------- preview: resize ----------
  await page.keyboard.press('Alt+p');
  await page.waitForTimeout(200);
  const p0 = await rect(page, '#preview');
  const g = await rect(page, '#pv-resize');
  await page.mouse.move(g.x + 4, g.y + 300); await page.mouse.down(); await page.mouse.move(g.x - 300, g.y + 300, { steps: 6 }); await page.mouse.up();
  const p1 = await rect(page, '#preview');
  ok('The preview is wider after dragging its left edge', p1.w >= p0.w + 280, p0.w + 'px -> ' + p1.w + 'px');
  await page.mouse.move(g.x - 300 + 4, g.y + 300); await page.mouse.down(); await page.mouse.move(g.x + 500, g.y + 300, { steps: 6 }); await page.mouse.up();
  const p2 = await rect(page, '#preview');
  const w2 = await rect(page, '#work');
  ok('…and narrower the other way, never below 20%', p2.w < p0.w && p2.w >= Math.floor(w2.w * 0.2) - 1, p2.w + 'px of ' + w2.w + 'px');
  r = await page.evaluate(() => __tf.settings.previewW);
  await page.reload();
  await page.waitForFunction(() => window.__tf && window.__tf.active, null, { timeout: 60000 });
  await page.evaluate(() => { const t = __tf.tabs.find((x) => x.name === 'notes.md'); __tf.activate(t); __tf.setPreview(true); });
  await page.waitForTimeout(200);
  const p3 = await rect(page, '#preview');
  ok('The preview width is remembered', Math.abs(p3.w - p2.w) <= 3, 'saved ' + r + '% -> ' + p3.w + 'px');
  const g2 = await rect(page, '#pv-resize');
  await page.mouse.dblclick(g2.x + 4, g2.y + 300);
  const p4 = await rect(page, '#preview');
  const w4 = await rect(page, '#work');
  ok('Double-clicking the edge resets it to half', Math.abs(p4.w - w4.w / 2) <= 2, p4.w + 'px of ' + w4.w + 'px');

  // ---------- preview: full screen ----------
  await page.click('#pv-full');
  await page.waitForTimeout(200);
  r = await rect(page, '#preview');
  ok('The full-screen button makes the preview fill the window', fills(r, W), JSON.stringify(r));
  r = await page.evaluate(() => ({ toast: document.getElementById('toast').textContent, table: !!document.querySelector('#preview .md-table'), btn: document.getElementById('pv-full').getAttribute('aria-pressed'), fab: getComputedStyle(document.getElementById('cp-fab')).display }));
  ok('It says how to leave, keeps the tables, and hides the Copilot button', /Esc/.test(r.toast) && r.table && r.btn === 'true' && r.fab === 'none', JSON.stringify(r));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  r = await rect(page, '#preview');
  ok('Esc goes back to the side-by-side preview', r && r.w < W.w * 0.7 && r.x > 100, JSON.stringify(r));
  await page.dblclick('#preview .pv-head strong');
  await page.waitForTimeout(150);
  r = await rect(page, '#preview');
  ok('Double-clicking the preview header toggles full screen', fills(r, W), JSON.stringify(r));
  await page.dblclick('#preview .pv-head strong');
  await page.keyboard.press('Alt+p');
  await page.waitForTimeout(150);
  r = await page.evaluate(() => document.getElementById('preview').hidden);
  ok('Alt+P still turns the preview off', r === true, String(r));
  await page.keyboard.press('Alt+Shift+P');
  await page.waitForTimeout(200);
  r = await rect(page, '#preview');
  ok('Alt+Shift+P opens the preview straight in full screen', fills(r, W), JSON.stringify(r));
  await page.keyboard.press('Alt+Shift+P');
  await page.waitForTimeout(150);
  r = await rect(page, '#preview');
  ok('…and Alt+Shift+P again leaves full screen', r && r.w < W.w * 0.7, JSON.stringify(r));
  // things on top of a full-screen view still work: palette, menus, dialogs
  await page.keyboard.press('Alt+Shift+P');
  await page.keyboard.press('Control+Shift+P');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => { const p = document.getElementById('palette'); const b = p.getBoundingClientRect(); const top = document.elementFromPoint(b.x + b.width / 2, 100); return { open: !p.hidden, onTop: !!top && !!top.closest('#palette') }; });
  ok('The command palette opens on top of a full-screen preview', r.open && r.onTop, JSON.stringify(r));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  r = await page.evaluate(() => ({ palette: document.getElementById('palette').hidden, fs: __tf.isFullscreen('#preview') }));
  ok('Esc closes the palette first, and the preview stays full screen', r.palette && r.fs, JSON.stringify(r));
  // switching to a tab without the preview leaves full screen cleanly
  await page.evaluate(() => { const t = __tf.newTab({ name: 'other.txt', content: 'x' }); __tf.activate(t); });
  await page.waitForTimeout(150);
  r = await page.evaluate(() => ({ fs: __tf.isFullscreen(), cls: document.body.classList.contains('has-fs'), preview: document.getElementById('preview').hidden }));
  ok('Switching to a tab without a preview leaves full screen', !r.fs && !r.cls && r.preview, JSON.stringify(r));

  // ---------- comparison ----------
  await page.evaluate(() => { const a = __tf.tabs.find((x) => x.name === 'notes.md'); __tf.activate(a); __tf.compareWith(__tf.tabs.find((x) => x.name === 'other.txt')); });
  await page.waitForTimeout(400);
  await page.click('#diff .fs-btn');
  await page.waitForTimeout(300);
  r = await rect(page, '#diff');
  const dv = await page.evaluate(() => { const b = document.querySelector('#diff .monaco-diff-editor').getBoundingClientRect(); return Math.round(b.width); });
  ok('The comparison has a full-screen button; both sides use the full width', fills(r, W) && dv >= W.w - 4, JSON.stringify(r) + ' diff ' + dv + 'px');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  r = await page.evaluate(() => ({ fs: __tf.isFullscreen(), diff: !!document.getElementById('diff') }));
  ok('Esc leaves full screen and keeps the comparison open', !r.fs && r.diff, JSON.stringify(r));
  await page.click('#diff .fs-btn');
  await page.click('#diff button[title="Close comparison"]');
  await page.waitForTimeout(150);
  r = await page.evaluate(() => ({ fs: __tf.isFullscreen(), cls: document.body.classList.contains('has-fs') }));
  ok('Closing a full-screen comparison leaves full screen too', !r.fs && !r.cls, JSON.stringify(r));

  // ---------- results panel ----------
  await page.evaluate(() => { __tf.openSample(); });
  await page.waitForTimeout(500);
  await page.evaluate(() => __tf.runCommand('Auto tables'));
  await page.waitForSelector('#panel:not([hidden])');
  await page.click('#panel-full');
  await page.waitForTimeout(200);
  r = await rect(page, '#panel');
  const pb = await rect(page, '#panel-body');
  ok('The results panel goes full screen; the table area fills it', fills(r, W) && pb.h > W.h - 120, JSON.stringify(r) + ' body ' + pb.h + 'px');
  await page.click('.at-item >> nth=2');
  r = await page.evaluate(() => ({ fs: __tf.isFullscreen('#panel'), rows: document.querySelectorAll('.at-main table.grid tr').length }));
  ok('Picking another table keeps full screen', r.fs && r.rows > 0, JSON.stringify(r));
  await page.click('#panel-full');
  await page.waitForTimeout(150);
  r = await rect(page, '#panel');
  ok('The same button restores the panel', r && r.h < W.h / 2 && r.y > 200, JSON.stringify(r));
  await page.click('#panel-full');
  await page.click('#panel-close');
  await page.waitForTimeout(150);
  r = await page.evaluate(() => ({ fs: __tf.isFullscreen(), panel: document.getElementById('panel').hidden }));
  ok('Closing a full-screen panel leaves full screen', !r.fs && r.panel, JSON.stringify(r));

  // ---------- Copilot pane ----------
  await page.evaluate(() => { __tf.settings.cpDock = false; __tf.openCopilot({ toggle: false }); });
  await page.waitForTimeout(300);
  const c0 = await rect(page, '#cp-host');
  await page.click('#cp-full');
  await page.waitForTimeout(200);
  r = await rect(page, '#cp-host');
  ok('Copilot has a full-screen button', fills(r, W), JSON.stringify(c0) + ' -> ' + JSON.stringify(r));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  r = await rect(page, '#cp-host');
  ok('Esc puts Copilot back where it was', r && Math.abs(r.w - c0.w) <= 2 && Math.abs(r.h - c0.h) <= 2 && Math.abs(r.x - c0.x) <= 2, JSON.stringify(r));
  await page.evaluate(() => __tf.closeCopilot());

  // ---------- sidebar ----------
  await page.evaluate(() => __tf.showView('insights', { toggle: false }));
  await page.waitForTimeout(150);
  const s0 = await rect(page, '#side');
  const sr = await rect(page, '#side-resize');
  await page.mouse.move(sr.x + 3, sr.y + 300); await page.mouse.down(); await page.mouse.move(sr.x + 200, sr.y + 300, { steps: 5 }); await page.mouse.up();
  const s1 = await rect(page, '#side');
  ok('The sidebar resizes by dragging its edge', s1.w >= s0.w + 180, s0.w + 'px -> ' + s1.w + 'px');
  const sr2 = await rect(page, '#side-resize');
  await page.mouse.dblclick(sr2.x + 3, sr2.y + 300);
  await page.waitForTimeout(100);
  const s2 = await rect(page, '#side');
  ok('Double-clicking the sidebar edge resets its width', Math.abs(s2.w - s0.w) <= 2, s2.w + 'px');

  // ---------- split panes keep working with the preview ----------
  await page.evaluate(() => { const t = __tf.tabs.find((x) => x.name === 'notes.md'); __tf.activate(t); __tf.setPreview(true); __tf.applyLayout('cols2'); });
  await page.waitForTimeout(300);
  r = await page.evaluate(() => { const e = document.getElementById('editors').getBoundingClientRect(); const p = document.getElementById('preview').getBoundingClientRect(); return { editors: Math.round(e.width), preview: Math.round(p.width), overlap: e.right > p.left + 1 }; });
  ok('Split view and the preview share the width without overlapping', r.editors > 300 && r.preview > 300 && !r.overlap, JSON.stringify(r));
  await page.evaluate(() => __tf.closeSplit());

  // ---------- what it looks like, not just where it is (a 1920 x 1080 screen) ----------
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate((md) => { __tf.closeSplit && __tf.closeSplit(); const t = __tf.tabs.find((x) => x.name === 'notes.md'); t.model.setValue(md + '\n\n| Shortcut | Action | When to use it |\n|---|---|---|\n| `Ctrl + B` | Go to declaration | Jump from a call to the method or class it refers to, including into library sources |'); __tf.activate(t); __tf.setPreview(true); }, MD);
  await page.waitForTimeout(300);
  const look = () => page.evaluate(() => {
    const pv = document.getElementById('preview').getBoundingClientRect();
    const sc = document.getElementById('preview-body');
    const pad = parseFloat(getComputedStyle(sc).paddingLeft) + parseFloat(getComputedStyle(sc).paddingRight);
    const doc = document.getElementById('preview-doc').getBoundingClientRect();
    const wrap = document.querySelector('.md-table-wrap').getBoundingClientRect();
    const tools = document.querySelector('.md-table-tools').getBoundingClientRect();
    return { pvW: Math.round(pv.width), scrollRight: Math.round(sc.getBoundingClientRect().right), pvRight: Math.round(pv.right), inner: Math.round(sc.clientWidth - pad), docW: Math.round(doc.width), tableW: Math.round(wrap.width), toolsRight: Math.round(tools.right), tableRight: Math.round(wrap.right) };
  });
  await page.evaluate(() => { document.getElementById('preview').style.flexBasis = '85%'; });
  await page.waitForTimeout(200);
  r = await look();
  ok('Stretched preview: the scrollbar is at its right edge and the text uses the whole width (no blank band)', r.scrollRight === r.pvRight && r.docW >= r.inner - 2, JSON.stringify(r));
  ok('Table buttons sit at their own table\'s right edge, and short tables are not tiny', r.toolsRight === r.tableRight && r.tableW >= 560, JSON.stringify(r));
  await page.keyboard.press('Alt+Shift+P');
  await page.waitForTimeout(300);
  r = await look();
  ok('Full screen: the reading column uses most of a 1920 px screen, scrollbar at the screen edge', r.docW >= 1300 && r.scrollRight === 1920, JSON.stringify(r));
  r = await page.evaluate(() => { const fs = parseFloat(getComputedStyle(document.getElementById('preview-doc')).fontSize); const side = 14; const t = document.querySelector('.md-table-wrap').getBoundingClientRect(); const name = document.getElementById('pv-name').textContent; return { fs, side, tableW: Math.round(t.width), name }; });
  ok('Full screen: larger text, tables at least 980 px wide, the file name in the header', r.fs > r.side && r.tableW >= 980 && r.name === 'notes.md', JSON.stringify(r));
  await page.keyboard.press('Escape');
  // the comparison: one clean divider between the two sides
  await page.evaluate(() => { const a = __tf.tabs.find((x) => x.name === 'notes.md'); const b = __tf.tabs.find((x) => x.name === 'other.txt'); __tf.activate(a); __tf.compareWith(b); });
  await page.waitForTimeout(500);
  r = await page.evaluate(() => { const eds = [...document.querySelectorAll('#diff .monaco-diff-editor .editor.original, #diff .monaco-diff-editor .editor.modified')].map((e) => e.getBoundingClientRect()); return eds.length === 2 ? { gap: Math.round(eds[1].left - eds[0].right) } : { gap: null, n: eds.length }; });
  ok('Comparison: no empty strip between the two sides', r.gap !== null && r.gap <= 8, JSON.stringify(r));
  await page.evaluate(() => __tf.closeCompare && __tf.closeCompare());
  await page.evaluate(() => { if (document.getElementById('diff')) document.querySelector('#diff button[title="Close comparison"]').click(); });

  // ---------- phone ----------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  r = await rect(page, '#preview');
  const PW = await win(page);
  const work = await rect(page, '#work');
  ok('On a phone the preview takes the whole editor area', r && Math.abs(r.w - work.w) <= 1 && r.x === work.x, JSON.stringify(r) + ' work ' + JSON.stringify(work));
  await page.click('#pv-full');
  await page.waitForTimeout(150);
  r = await rect(page, '#preview');
  ok('…and full screen works there too', fills(r, PW), JSON.stringify(r));
  await page.keyboard.press('Escape');
  ok('No errors', errors.length === 0, errors.join(' | ') || 'none');

  let pass = 0;
  for (const x of results) { if (x.pass) pass++; console.log((x.pass ? 'PASS ' : 'FAIL ') + x.name + '  —  ' + x.detail); }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exitCode = pass === results.length ? 0 : 1;
})().catch((e) => { console.error('FULL SCREEN TESTS FAILED', e); process.exit(2); });
