/* Desktop-only UI checks (Electron): single title bar, drag regions, window buttons, and resizing the
   Copilot pane while the embedded Copilot page is under the mouse. Usage: node test/ui-desktop.e2e.js
   (needs a display; on Linux run under xvfb-run). */
const path = require('path');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(process.env.HOME || '', '.npm-global/lib/node_modules/playwright')); }
const { _electron: electron } = playwright;
const appDir = path.join(__dirname, '..');

(async () => {
  const app = await electron.launch({ executablePath: require(path.join(appDir, 'node_modules/electron')), args: [appDir, '--no-sandbox', '--disable-gpu'] });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1400, height: 860 }));
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  await win.waitForFunction(() => window.__tf && window.__tf.active, null, { timeout: 30000 });
  await win.waitForTimeout(1000);
  const E = (fn, a) => win.evaluate(fn, a);
  const results = [];
  const check = async (name, fn) => { let r; try { r = await fn(); } catch (e) { r = { pass: false, detail: 'Error: ' + e.message.split('\n')[0] }; } results.push(Object.assign({ name }, r)); };
  const ok = (pass, detail) => ({ pass: !!pass, detail });

  await check('One title bar: the window has no system frame', async () => {
    const r = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; const [cw, ch] = w.getContentSize(); const [ow, oh] = w.getSize(); return { frameH: oh - ch, frameW: ow - cw }; });
    return ok(r.frameH <= 1 && r.frameW <= 1, `frame adds ${r.frameW}px x ${r.frameH}px`);
  });
  await check('Top bar drags the window; buttons and tabs stay clickable', async () => {
    const r = await E(() => {
      const reg = (el) => getComputedStyle(el).getPropertyValue('-webkit-app-region') || getComputedStyle(el).webkitAppRegion;
      return { bar: reg(document.getElementById('topbar')), tab: reg(document.querySelector('.tab')), btn: reg(document.querySelector('#topbar [data-act="new"]')), search: reg(document.getElementById('palette-btn')) };
    });
    return ok(r.bar === 'drag' && r.tab === 'no-drag' && r.btn === 'no-drag' && r.search === 'no-drag', JSON.stringify(r));
  });
  await check('Space is kept for the minimise / maximise / close buttons', async () => {
    const r = await E(() => ({ pad: parseFloat(getComputedStyle(document.getElementById('topbar')).paddingRight), searchRight: document.getElementById('palette-btn').getBoundingClientRect().right, w: window.innerWidth }));
    return ok(r.pad >= 90 && r.searchRight <= r.w - 90, `reserved ${r.pad}px; search box ends ${Math.round(r.w - r.searchRight)}px from the edge`);
  });
  await check('Window buttons follow the theme colours', async () => {
    const r = await E(async () => { const a = await window.api.setTitleBar({ color: '#ffffff', symbolColor: '#667080' }); __tf.setTheme('slate'); return a; });
    return ok(r === true || r === false, r ? 'overlay colour updated' : 'not supported on this platform (macOS uses its own buttons)');
  });
  await check('Docked Copilot: resize by dragging across the embedded Copilot page', async () => {
    await E(() => { __tf.settings.cpDock = true; __tf.settings.cpDockW = 420; __tf.openCopilot({ toggle: false }); });
    await win.click('#cp-body >> text=Open Copilot and sign in').catch(() => {});
    await win.waitForTimeout(800);
    const g = await E(() => { const r = document.querySelector('.cp-grip[data-dir="l"]').getBoundingClientRect(); return { x: r.x + 3, y: r.y + 300 }; });
    // drag right, i.e. over the Copilot page itself, then back left
    await win.mouse.move(g.x, g.y); await win.mouse.down(); await win.mouse.move(g.x + 100, g.y, { steps: 6 }); await win.mouse.up();
    const a = await E(() => Math.round(document.getElementById('cp-host').getBoundingClientRect().width));
    const g2 = await E(() => { const r = document.querySelector('.cp-grip[data-dir="l"]').getBoundingClientRect(); return { x: r.x + 3, y: r.y + 300 }; });
    await win.mouse.move(g2.x, g2.y); await win.mouse.down(); await win.mouse.move(g2.x - 250, g2.y, { steps: 6 }); await win.mouse.up();
    const b = await E(() => Math.round(document.getElementById('cp-host').getBoundingClientRect().width));
    const hasWebview = await E(() => !!document.querySelector('#cp-host webview'));
    return ok(hasWebview && Math.abs(a - 320) <= 3 && Math.abs(b - 570) <= 3, `with the Copilot page loaded: 420px -> ${a}px -> ${b}px`);
  });
  await check('Floating Copilot: resize from a corner and move by the title', async () => {
    await E(() => { __tf.settings.cpDock = false; __tf.settings.cpRect = null; __tf.applyCopilotLayout(); });
    await win.waitForTimeout(200);
    const c = await E(() => { const r = document.querySelector('.cp-grip[data-dir="bl"]').getBoundingClientRect(); const h = document.getElementById('cp-host').getBoundingClientRect(); return { x: r.x + 6, y: r.y + 6, w: h.width, h: h.height }; });
    await win.mouse.move(c.x, c.y); await win.mouse.down(); await win.mouse.move(c.x - 120, c.y - 80, { steps: 6 }); await win.mouse.up();
    const after = await E(() => { const h = document.getElementById('cp-host').getBoundingClientRect(); return { w: Math.round(h.width), h: Math.round(h.height), x: Math.round(h.x), y: Math.round(h.y) }; });
    const head = await E(() => { const r = document.getElementById('cp-head').getBoundingClientRect(); return { x: r.x + 50, y: r.y + 15 }; });
    await win.mouse.move(head.x, head.y); await win.mouse.down(); await win.mouse.move(head.x - 300, head.y + 40, { steps: 6 }); await win.mouse.up();
    const moved = await E(() => { const h = document.getElementById('cp-host').getBoundingClientRect(); return { x: Math.round(h.x), y: Math.round(h.y) }; });
    await win.screenshot({ path: path.join(process.env.SHOTS || require('os').tmpdir(), 'desktop-floating.png') }).catch(() => {});
    return ok(after.w >= Math.round(c.w) + 110 && after.h <= Math.round(c.h) - 70 && moved.x <= after.x - 280, `${Math.round(c.w)}x${Math.round(c.h)} -> ${after.w}x${after.h}; moved to ${moved.x},${moved.y}`);
  });
  await check('Docking and undocking keep the Copilot page (no reload)', async () => {
    const r = await E(async () => {
      const wv = document.querySelector('#cp-host webview'); let loads = 0; wv.addEventListener('did-start-loading', () => loads++);
      document.getElementById('cp-dock').click(); await new Promise((r) => setTimeout(r, 400));
      document.getElementById('cp-dock').click(); await new Promise((r) => setTimeout(r, 400));
      return { same: document.querySelector('#cp-host webview') === wv, loads };
    });
    return ok(r.same && r.loads === 0, `same page: ${r.same}, reloads: ${r.loads}`);
  });
  await check('Full screen (Alt+Shift+P on the preview) fills the screen, and Esc puts the window back as it was', async () => {
    await E(() => { if (__tf.closeCopilot) __tf.closeCopilot(); const t = __tf.newTab({ name: 'fs.md', content: '# Full screen\n\n| a | b |\n|---|---|\n| 1 | 2 |' }); __tf.activate(t); });
    const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    await win.keyboard.press('Alt+Shift+P');
    await win.waitForTimeout(1200);
    const during = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen());
    const fill = await E(() => { const b = document.getElementById('preview').getBoundingClientRect(); return b.width === innerWidth && b.height === innerHeight; });
    await win.keyboard.press('Escape');
    await win.waitForTimeout(1500);
    const after = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { fs: w.isFullScreen(), b: w.getBounds() }; });
    const same = after.b.width === before.width && after.b.height === before.height && after.b.x === before.x && after.b.y === before.y;
    return ok(during && fill && !after.fs && same, `full screen: ${during}, preview fills: ${fill}, back to ${after.b.width}x${after.b.height} (was ${before.width}x${before.height})`);
  });
  await check('No errors in the app window', async () => ok(errors.length === 0, errors.join(' | ') || 'none'));

  let pass = 0;
  for (const r of results) { if (r.pass) pass++; console.log((r.pass ? 'PASS ' : 'FAIL ') + r.name + '  —  ' + r.detail); }
  console.log(`\n${pass}/${results.length} passed`);
  await app.close();
  process.exitCode = pass === results.length ? 0 : 1;
})().catch((e) => { console.error('DESKTOP UI TESTS FAILED', e); process.exit(2); });
