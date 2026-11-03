/* "Changed on disk" checks for the web version: a file opened with the Open button reloads when another
   program changes it, and the Open button works inside another site's frame (as on claude.ai).
   Usage: node test/disk.e2e.js [selfhost URL, default http://127.0.0.1:8765/]  */
const path = require('path'), fs = require('fs'), os = require('os');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(process.env.HOME || '', '.npm-global/lib/node_modules/playwright')); }
const URL_ = process.argv[2] || 'http://127.0.0.1:8765/';
const MONACO = path.join(__dirname, '..', 'node_modules/monaco-editor/min');
const results = [];
const ok = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await playwright.chromium.launch();
  // ---------- 1. standalone page: files opened with the browser's file picker stay live ----------
  {
    const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(URL_);
    await page.waitForFunction(() => window.__tf && window.__tf.active, null, { timeout: 60000 });
    // A file in the page's private storage stands in for a file on disk: the picker returns its handle.
    await page.evaluate(async () => {
      const dir = await navigator.storage.getDirectory();
      const h = await dir.getFileHandle('app.log', { create: true });
      const w = await h.createWritable(); await w.write('2026-11-03 10:00:00 INFO start\n2026-11-03 10:00:01 INFO ready\n'); await w.close();
      window.__h = h;
      window.showOpenFilePicker = async () => [h];
      window.__disk = async (text, append) => { const w = await h.createWritable({ keepExistingData: !!append }); if (append) { const f = await h.getFile(); await w.seek(f.size); } await w.write(text); await w.close(); };
    });
    await page.click('#topbar [data-act="open"]');
    await page.waitForFunction(() => __tf.active.name === 'app.log', null, { timeout: 5000 });
    await wait(2300); // first check records the baseline
    await page.evaluate(() => window.__disk('2026-11-03 10:00:02 ERROR boom\n', true));
    await page.waitForFunction(() => __tf.active.model.getValue().includes('boom'), null, { timeout: 6000 }).catch(() => {});
    let r = await page.evaluate(() => ({ lines: __tf.active.model.getLineCount(), text: __tf.active.model.getValue(), dirty: document.querySelector('.tab.active') && document.querySelector('.tab.active').className }));
    ok('Appended lines appear without doing anything', r.text.includes('boom') && r.lines === 4, `${r.lines} lines`);
    ok('The tab is not marked as modified after a reload', !/dirty|modified/.test(r.dirty), r.dirty);

    await page.evaluate(() => window.__disk('completely new content\n', false));
    await page.waitForFunction(() => __tf.active.model.getValue().startsWith('completely new'), null, { timeout: 6000 }).catch(() => {});
    r = await page.evaluate(() => __tf.active.model.getValue());
    ok('A rewritten file is reloaded', r === 'completely new content\n', JSON.stringify(r));
    await page.click('.monaco-editor .view-lines', { position: { x: 40, y: 8 } });
    await page.keyboard.press('Control+z');
    r = await page.evaluate(() => __tf.active.model.getValue());
    ok('Ctrl+Z brings back the text from before the reload', r.includes('boom'), r.split('\n').length + ' lines');
    await page.keyboard.press('Control+y');

    // Unsaved edits are never overwritten: a notice asks first.
    await page.keyboard.press('Control+End'); await page.keyboard.type('my note');
    await page.evaluate(() => window.__disk('changed again\n', false));
    await page.waitForSelector('#diskbar:not([hidden])', { timeout: 6000 }).catch(() => {});
    r = await page.evaluate(() => ({ bar: !document.querySelector('#diskbar').hidden && document.querySelector('#diskbar').textContent, text: __tf.active.model.getValue() }));
    ok('With unsaved edits it asks instead of reloading', r.bar && /unsaved/.test(r.bar) && r.text.includes('my note'), r.bar);
    await page.click('#diskbar >> text=Reload from disk');
    await wait(400);
    r = await page.evaluate(() => ({ text: __tf.active.model.getValue(), bar: document.querySelector('#diskbar').hidden }));
    ok('"Reload from disk" loads the file and closes the notice', r.text === 'changed again\n' && r.bar, JSON.stringify(r.text));
    await page.screenshot({ path: path.join(process.env.SHOTS || os.tmpdir(), 'disk-live.png') });
    ok('No errors (standalone page)', errors.length === 0, errors.join(' | ') || 'none');
    await page.close();
  }

  // ---------- 2. inside another site's frame (like claude.ai): Open works, changes are noticed ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 800 } });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    const frag = fs.readFileSync(path.join(__dirname, '..', 'web-dist/artifact/TextForge.html'), 'utf8');
    await ctx.route('https://textforge.test/', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${frag}</body></html>` }));
    await ctx.route('https://host.test/', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body style="margin:0"><iframe src="https://textforge.test/" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals" style="width:100vw;height:100vh;border:0"></iframe>' }));
    await ctx.route(/cdn\.jsdelivr\.net\/npm\/monaco-editor@[^/]+\/min\/(.*)$/, (r) => { const rel = r.request().url().replace(/^.*\/min\//, ''); const f = path.join(MONACO, rel); if (!fs.existsSync(f)) return r.fulfill({ status: 404, body: '' }); r.fulfill({ status: 200, contentType: rel.endsWith('.css') ? 'text/css' : 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(f) }); });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await page.goto('https://host.test/');
    await wait(500);
    const fr = page.frames().find((f) => f.url().includes('textforge.test'));
    await fr.waitForFunction(() => window.__tf && window.__tf.active, null, { timeout: 60000 });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-')), 'service.log');
    fs.writeFileSync(file, '2026-11-03 10:00:00 INFO start\n');
    let fsaCalled = false;
    await fr.evaluate(() => { const o = window.showOpenFilePicker; window.showOpenFilePicker = (...a) => { window.__fsa = true; return o.apply(window, a); }; });
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), fr.click('#topbar [data-act="open"]')]);
    fsaCalled = await fr.evaluate(() => !!window.__fsa);
    // Simulate Windows handing the file over late (e.g. a OneDrive file): window focus returns first.
    await fr.evaluate(() => window.dispatchEvent(new Event('focus')));
    await wait(2000);
    await chooser.setFiles(file);
    await fr.waitForFunction(() => __tf.active.name === 'service.log', null, { timeout: 5000 }).catch(() => {});
    let r = await fr.evaluate(() => __tf.active.name);
    ok('Open works inside a frame, even when the file arrives late', r === 'service.log', r + (fsaCalled ? ' (tried the blocked picker first)' : ' (went straight to the file dialog)'));
    await wait(2300);
    fs.appendFileSync(file, '2026-11-03 10:00:05 ERROR late failure\n');
    await fr.waitForSelector('#diskbar:not([hidden])', { timeout: 6000 }).catch(() => {});
    r = await fr.evaluate(() => !document.querySelector('#diskbar').hidden && document.querySelector('#diskbar').textContent);
    ok('A change on disk is noticed and explained', r && /pick the file again/i.test(r), r);
    await page.screenshot({ path: path.join(process.env.SHOTS || os.tmpdir(), 'disk-framed.png') });
    const [chooser2] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), fr.click('#diskbar >> text=Pick file again')]);
    await chooser2.setFiles(file);
    await fr.waitForFunction(() => __tf.active.model.getValue().includes('late failure'), null, { timeout: 5000 }).catch(() => {});
    r = await fr.evaluate(() => ({ text: __tf.active.model.getValue(), tabs: __tf.tabs.filter((t) => t.name === 'service.log').length, bar: document.querySelector('#diskbar').hidden }));
    ok('"Pick file again" loads the new version into the same tab', r.text.includes('late failure') && r.bar && r.tabs === 1, `${r.tabs} service.log tab`);
    ok('No errors (framed page)', errors.length === 0, errors.join(' | ') || 'none');
    await ctx.close();
  }
  let pass = 0;
  for (const x of results) { if (x.pass) pass++; console.log((x.pass ? 'PASS ' : 'FAIL ') + x.name + '  —  ' + x.detail); }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exitCode = pass === results.length ? 0 : 1;
})().catch((e) => { console.error('DISK TESTS FAILED', e); process.exit(2); });
