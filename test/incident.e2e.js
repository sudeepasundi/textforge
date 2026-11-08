/* 0.16.0-0.18.0: the incident view - several logs on one clock, findings, time window, reader, jump to a line and back,
   following one request (waterfall), pins and the report. Usage: node test/incident.e2e.js [selfhost URL] */
const path = require('path');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(process.env.HOME || '', '.npm-global/lib/node_modules/playwright')); }
const URL_ = process.argv[2] || 'http://127.0.0.1:8765/';
const results = [];
const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

(async () => {
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL_);
  await page.waitForFunction(() => window.__tf && window.__tf.active && window.__tf.editor, null, { timeout: 60000 });
  await page.evaluate(() => __tf.setTheme('slate'));
  let r;

  // fewer than two logs: a hint with the sample
  await page.evaluate(() => { __tf.activate(__tf.newTab({ name: 'notes.md', content: 'hello' })); __tf.pickIncident(); });
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ toast: document.getElementById('toast').textContent, action: (document.querySelector('#toast .toast-action') || {}).textContent }));
  ok('With fewer than two logs open it explains and offers the sample', /two or more logs/.test(r.toast) && r.action === 'Try the incident sample', JSON.stringify(r));

  await page.click('#toast .toast-action');
  await page.waitForSelector('#incident', { timeout: 10000 });
  await page.waitForTimeout(300);
  r = await page.evaluate(() => ({
    tabs: __tf.tabs.map((t) => t.name).filter((n) => /-service\.log|gateway/.test(n)),
    lanes: [...document.querySelectorAll('#incident .inc-svc')].map((x) => x.textContent),
    dots: document.querySelectorAll('#incident .inc-dot').length, err: document.querySelectorAll('#incident .inc-dot.err').length,
    signalHidden: getComputedStyle(document.getElementById('signal')).display === 'none',
  }));
  ok('The sample opens four service logs as tabs and lines them up as four lanes', r.tabs.length === 4 && r.lanes.join() === 'api-gateway,order-service,payment-service,inventory-service', JSON.stringify(r));
  ok('Lanes show entries as dots, errors in their own colour', r.dots > 40 && r.err >= 6, JSON.stringify(r));
  ok('The single-log timeline steps aside while the incident is open', r.signalHidden, JSON.stringify(r));

  r = await page.evaluate(() => ({
    first: document.querySelector('#incident .inc-f.on .inc-f-title').textContent,
    kinds: [...document.querySelectorAll('#incident .inc-f .inc-tag')].map((x) => x.textContent),
    titles: [...document.querySelectorAll('#incident .inc-f-title')].map((x) => x.textContent).join(' | '),
    readerRows: document.querySelectorAll('#incident .inc-row').length, readerTitle: document.querySelector('#incident .inc-r-title').textContent,
  }));
  ok('Findings start with errors that hit several services at once, already selected', /^Errors in payment-service and order-service/.test(r.first) && r.kinds[0] === 'together', JSON.stringify(r).slice(0, 300));
  ok('A quiet service is found (payment-service went quiet)', /payment-service went quiet for 47\.6 s/.test(r.titles), r.titles.slice(0, 200));
  ok('Finding titles mask secrets (password, tokens)', !/hunter2|eyJhbGci/.test(r.titles) && /password=\*\*\*\*/.test(r.titles), r.titles.match(/password=[^ ]*/) + '');
  ok('The reader shows the lines behind the selected finding', r.readerRows === 2 && r.readerTitle === r.first, JSON.stringify(r).slice(0, 200));

  await page.click('#incident .inc-f.k-quiet');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#incident .inc-row')].map((x) => x.querySelector('.inc-row-svc').textContent);
    const pay = rows.filter((s) => s === 'payment-service').length;
    return { win: !!__tf.incident.win, rows: rows.length, others: new Set(rows.filter((s) => s !== 'payment-service')).size, pay, firstPay: rows.indexOf('payment-service'), lastPay: rows.lastIndexOf('payment-service') };
  });
  // the window is a little wider than the silence: payment-service's last entry before it and first after it frame the list
  ok('A quiet finding shows what the other services wrote meanwhile, framed by the quiet service\'s last and first entries', r.win && r.rows >= 8 && r.others >= 3 && r.pay <= 6 && r.lastPay - r.firstPay > 5, JSON.stringify(r));

  // drag a time window
  const tr = await page.locator('#incident .inc-track >> nth=1').boundingBox();
  await page.mouse.move(tr.x + tr.width * 0.40, tr.y + tr.height / 2); await page.mouse.down();
  await page.mouse.move(tr.x + tr.width * 0.55, tr.y + tr.height / 2, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(250);
  r = await page.evaluate(() => {
    const wins = [...document.querySelectorAll('#incident .inc-win')].filter((w) => !w.hidden).length;
    const lab = document.querySelector('#incident .inc-win-label'); const lr = lab.getBoundingClientRect(); const rr = document.querySelector('#incident .inc-ruler-track').getBoundingClientRect();
    const rows = [...document.querySelectorAll('#incident .inc-row-ts')].map((x) => x.textContent);
    return { wins, label: lab.textContent, inside: lr.left >= rr.left - 1 && lr.right <= rr.right + 1, sub: document.querySelector('#incident .inc-r-sub').textContent, sorted: rows.every((x, i) => !i || rows[i - 1] <= x), n: rows.length };
  });
  ok('Dragging across the lanes picks a time window, shaded on every lane, labelled on the ruler', r.wins === 4 && /^\d\d:\d\d:\d\d – \d\d:\d\d:\d\d$/.test(r.label) && r.inside, JSON.stringify(r));
  ok('The reader lists that window from every log, in time order', r.n >= 8 && r.sorted && /from [34] logs/.test(r.sub), JSON.stringify(r));
  await page.mouse.dblclick(tr.x + tr.width * 0.8, tr.y + tr.height / 2);
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ win: __tf.incident.win, shown: [...document.querySelectorAll('#incident .inc-win')].some((w) => !w.hidden) }));
  ok('Double-click clears the window', !r.win && !r.shown, JSON.stringify(r));

  // click a dot
  const dot = await page.evaluate(() => { const d = document.querySelector('#incident .inc-lane:nth-child(3) .inc-dot.err'); const b = d.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await page.mouse.click(dot.x, dot.y);
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ title: document.querySelector('#incident .inc-r-title').textContent, rows: document.querySelectorAll('#incident .inc-row').length, err: !!document.querySelector('#incident .inc-row.lv-error') }));
  ok('Clicking a dot shows its entries (that log only)', /^payment-service at /.test(r.title) && r.rows >= 1 && r.err, JSON.stringify(r));

  // jump to the line and back
  await page.click('#incident .inc-row.lv-error');
  await page.waitForTimeout(250);
  r = await page.evaluate(() => ({ view: !!document.getElementById('incident'), tab: __tf.active.name, line: __tf.editor.getPosition().lineNumber, text: __tf.active.model.getLineContent(__tf.editor.getPosition().lineNumber), action: (document.querySelector('#toast .toast-action') || {}).textContent }));
  ok('Clicking an entry opens its log at that line', !r.view && r.tab === 'payment-service.log' && /ERROR/.test(r.text) && r.action === 'Back to the incident', JSON.stringify(r).slice(0, 220));
  await page.click('#toast .toast-action');
  await page.waitForTimeout(250);
  r = await page.evaluate(() => ({ view: !!document.getElementById('incident'), title: document.querySelector('#incident .inc-r-title').textContent }));
  ok('"Back to the incident" restores it as it was', r.view && /^payment-service at /.test(r.title), JSON.stringify(r));

  // tabs and the keyboard
  await page.click('#tabs .tab >> text=api-gateway.log');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ view: !!document.getElementById('incident'), active: __tf.active.name, toast: document.getElementById('toast').textContent }));
  ok('Clicking a tab shows that file; the incident waits', !r.view && r.active === 'api-gateway.log' && /incident is still there/.test(r.toast), JSON.stringify(r));
  await page.keyboard.press('Alt+i');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => !!document.getElementById('incident'));
  ok('Alt+I brings it back', r, String(r));

  // copy findings: masked text
  await page.evaluate(() => { window.__copied = null; const orig = window.api.clipboardWrite; window.api.clipboardWrite = async (x) => { window.__copied = x.text; return true; }; });
  await page.click('#incident button:has-text("Copy findings")');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => window.__copied || '');
  ok('Copy findings gives a short report with secrets masked', /^Incident: api-gateway, order-service, payment-service, inventory-service/.test(r) && /\[quiet\] payment-service went quiet/.test(r) && !/hunter2|eyJhbGci/.test(r), r.slice(0, 160));

  // ---- 0.17.0: follow one request ----
  await page.click('#incident .inc-f >> nth=0');
  await page.waitForTimeout(150);
  r = await page.evaluate(() => ({ head: (document.querySelector('#incident .inc-follow-btn') || {}).textContent, rows: document.querySelectorAll('#incident .inc-row-follow').length }));
  ok('Entries that belong to one request offer to follow it (header and each row)', r.head === 'Follow request c3e09f1a ›' && r.rows === 2, JSON.stringify(r));
  await page.click('#incident .inc-follow-btn');
  await page.waitForTimeout(250);
  r = await page.evaluate(() => ({
    mode: __tf.incident.mode, tab: document.querySelector('#incident .inc-modes .on').textContent,
    on: (document.querySelector('#incident .inc-req.on .inc-req-id') || {}).textContent,
    text: (document.querySelector('#incident .inc-rq-text') || {}).textContent,
    steps: [...document.querySelectorAll('#incident .inc-wf-row')].map((x) => x.querySelector('.inc-row-svc').textContent),
    bars: [...document.querySelectorAll('#incident .inc-wf-bar')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; }),
    sel: [...document.querySelectorAll('#incident .inc-wf-row')].findIndex((x) => x.classList.contains('on')),
    lines: document.querySelectorAll('#incident .inc-code-line').length,
  }));
  ok('Requests view opens on that request, with a plain summary', r.mode === 'requests' && /^Requests/.test(r.tab) && r.on === 'c3e09f1a' && /^POST \/api\/orders went through api-gateway, order-service and payment-service in 1\.6 s\. It first failed in payment-service/.test(r.text), JSON.stringify(r).slice(0, 260));
  ok('Steps are one per service, nested like a waterfall', r.steps.join() === 'api-gateway,order-service,payment-service' && r.bars[0][0] <= r.bars[1][0] && r.bars[1][0] <= r.bars[2][0] && r.bars[2][1] <= r.bars[1][1] + 1 && r.bars[1][1] <= r.bars[0][1] + 1, JSON.stringify(r.bars));
  ok('The first failing step is selected and its log lines (with the stack) are shown', r.sel === 1 && r.lines >= 10, JSON.stringify({ sel: r.sel, lines: r.lines }));
  r = await page.evaluate(() => [...document.querySelectorAll('#incident .inc-wf-row')].map((row) => {
    const t = row.querySelector('.inc-wf-track').getBoundingClientRect(), d = row.querySelector('.inc-wf-dur').getBoundingClientRect();
    return d.left >= t.left - 1 && d.right <= t.right + 1;
  }));
  ok('Duration labels stay inside the timeline area (never over the step names)', r.every(Boolean), JSON.stringify(r));
  await page.click('#incident .inc-wf-row >> nth=2');
  await page.waitForTimeout(150);
  r = await page.evaluate(() => ({ head: document.querySelector('#incident .inc-rq-lhead').textContent, first: (document.querySelector('#incident .inc-code-line .inc-code-t') || {}).textContent }));
  ok('Clicking a step shows the lines behind it', /payment-service\.log/.test(r.head) && /POST \/api\/payments orderId=90002/.test(r.first), JSON.stringify(r).slice(0, 200));
  await page.click('#incident .inc-chip >> text=Slow');
  await page.waitForTimeout(150);
  r = await page.evaluate(() => ({ list: [...document.querySelectorAll('#incident .inc-req .inc-req-id')].map((x) => x.textContent), text: document.querySelector('#incident .inc-rq-text').textContent }));
  ok('The Slow filter finds the slow request and explains it', r.list.join() === '5c4b3a29' && /worked but was slow/.test(r.text), JSON.stringify(r));
  await page.click('#incident .inc-chip >> text=All');
  await page.fill('#incident .inc-rq-search', 'payments');
  await page.waitForTimeout(150);
  r = await page.evaluate(() => [...document.querySelectorAll('#incident .inc-req .inc-req-id')].map((x) => x.textContent));
  ok('Search finds requests by route', r.includes('3e4f5061') && r.length <= 3, JSON.stringify(r));
  await page.fill('#incident .inc-rq-search', '');
  await page.evaluate(() => __tf.followRequest('7a6b5c4d3e2f1a0b'));
  await page.waitForTimeout(200);
  r = await page.evaluate(() => document.querySelector('#incident .inc-rq-text').textContent);
  ok('Summaries mask secrets (the Bearer token in the error message)', /Bearer <jwt>|Bearer \*\*\*\*/.test(r) && !/eyJhbGci/.test(r), r.slice(0, 200));
  await page.click('#incident button:has-text("Show on the timeline")');
  await page.waitForTimeout(250);
  r = await page.evaluate(() => ({ mode: __tf.incident.mode, title: document.querySelector('#incident .inc-r-title').textContent, rows: document.querySelectorAll('#incident .inc-row').length, win: !!__tf.incident.win }));
  ok('"Show on the timeline" goes back with that request\'s entries and time window', r.mode === 'timeline' && r.title === 'Request 7a6b5c4d' && r.rows === 4 && r.win, JSON.stringify(r));

  // ---- 0.18.0: pins and the report ----
  await page.click('#incident .inc-f-wrap >> nth=0 >> .inc-pin');
  await page.click('#incident .inc-f.k-quiet >> xpath=.. >> .inc-pin');
  await page.waitForTimeout(150);
  r = await page.evaluate(() => ({ count: document.querySelector('#incident .inc-pin-count').textContent, on: document.querySelectorAll('#incident .inc-pin.on').length, list: document.querySelector('#incident .inc-flist').scrollTop }));
  ok('The pin on a finding adds it to the report (count on the Report tab), without rebuilding the list', r.count === '2' && r.on === 2, JSON.stringify(r));
  await page.click('#incident .inc-f-wrap >> nth=0 >> .inc-pin');
  await page.waitForTimeout(100);
  r = await page.evaluate(() => ({ count: document.querySelector('#incident .inc-pin-count').textContent, on: document.querySelectorAll('#incident .inc-pin.on').length }));
  ok('Clicking the pin again unpins', r.count === '1' && r.on === 1, JSON.stringify(r));
  await page.click('#incident .inc-f-wrap >> nth=0 >> .inc-pin');
  await page.evaluate(() => __tf.followRequest('c3e09f1a7b264d58'));
  await page.waitForTimeout(150);
  await page.click('#incident .inc-pin-req');
  await page.waitForTimeout(100);
  r = await page.evaluate(() => ({ btn: document.querySelector('#incident .inc-pin-req').textContent, count: document.querySelector('#incident .inc-pin-count').textContent }));
  ok('"Pin to report" on a request pins it', r.btn === 'Pinned to the report ✓' && r.count === '3', JSON.stringify(r));
  await page.click('#incident .inc-modes button:has-text("Report")');
  await page.waitForTimeout(250);
  await page.fill('#incident .inc-rep-form .field input', 'Checkout outage');
  await page.fill('#incident .inc-rep-form .field textarea', 'Bank gateway stopped answering.');
  await page.fill('#incident .inc-pin-item >> nth=1 >> textarea', 'Pool exhausted.');
  await page.waitForTimeout(350);
  r = await page.evaluate(() => ({
    items: [...document.querySelectorAll('#incident .inc-pin-item .inc-pin-title')].map((x) => x.textContent),
    heads: [...document.querySelectorAll('#inc-rep-doc h1, #inc-rep-doc h2, #inc-rep-doc h3')].map((x) => x.textContent),
    note: /Pool exhausted\./.test(document.getElementById('inc-rep-doc').textContent),
    table: !!document.querySelector('#inc-rep-doc table'),
    secrets: /hunter2|eyJhbGci/.test(document.getElementById('inc-rep-doc').textContent),
  }));
  ok('The Report tab lists the pins in order and previews the report as you type', r.items.length === 3 && r.heads[0] === 'Checkout outage' && r.heads.includes('What happened') && r.note && r.table, JSON.stringify(r).slice(0, 300));
  ok('The report masks secrets', !r.secrets, String(r.secrets));
  await page.click('#incident .inc-pin-item >> nth=2 >> button[aria-label="Move up"]');
  await page.waitForTimeout(150);
  r = await page.evaluate(() => [...document.querySelectorAll('#incident .inc-pin-item .inc-tag')].map((x) => x.textContent));
  ok('↑ / ↓ change the order', r[1] === 'request', JSON.stringify(r));
  await page.evaluate(() => { window.__copied = null; window.api.clipboardWrite = async (x) => { window.__copied = x; return true; }; });
  await page.click('#incident button:has-text("Copy for Teams / Outlook")');
  await page.waitForTimeout(150);
  r = await page.evaluate(() => ({ text: (window.__copied || {}).text || '', html: (window.__copied || {}).html || '' }));
  ok('Copy for Teams / Outlook puts formatted HTML and the Markdown on the clipboard', /^# Checkout outage/.test(r.text) && /<h1[^>]*>Checkout outage<\/h1>/.test(r.html) && /border-collapse/.test(r.html) && !/hunter2/.test(r.html), r.html.slice(0, 120));
  await page.click('#incident button:has-text("Open as a tab")');
  await page.waitForTimeout(300);
  r = await page.evaluate(() => ({ tab: __tf.active.name, lang: __tf.active.model.getLanguageId(), first: __tf.active.model.getLineContent(1), preview: !!__tf.active.preview, back: (document.querySelector('#toast .toast-action') || {}).textContent }));
  ok('"Open as a tab" opens the report as Markdown with the preview, and the incident waits', r.tab === 'incident-report.md' && r.lang === 'markdown' && r.first === '# Checkout outage' && r.preview && r.back === 'Back to the incident', JSON.stringify(r));
  await page.evaluate(() => __tf.setPreview(false));
  await page.keyboard.press('Alt+i');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ mode: __tf.incident.mode, pins: __tf.incident.pins.length, title: __tf.incident.report.title }));
  ok('Coming back keeps the report (pins, title, notes)', r.mode === 'report' && r.pins === 3 && r.title === 'Checkout outage', JSON.stringify(r));
  await page.evaluate(() => __tf.setIncidentMode('timeline'));
  await page.waitForTimeout(150);

  // appearance
  r = await page.evaluate(() => {
    const main = document.querySelector('#incident .inc-main').getBoundingClientRect();
    const lanes = [...document.querySelectorAll('#incident .inc-lane')].reduce((a, l) => a + l.getBoundingClientRect().height, 0);
    const ticks = [...document.querySelectorAll('#incident .inc-ticks span')].map((s) => s.getBoundingClientRect());
    const overlap = ticks.some((t, i) => i && ticks[i - 1].right > t.left - 2);
    const fab = document.getElementById('cp-fab').getBoundingClientRect(); const list = document.querySelector('#incident .inc-rlist');
    return { fill: Math.round(lanes / main.height * 100), overlap, ticks: ticks.length, roomUnderFab: parseFloat(getComputedStyle(list).paddingBottom) >= fab.height };
  });
  ok('Lanes fill the height and the time labels do not overlap', r.fill >= 60 && !r.overlap && r.ticks >= 4, JSON.stringify(r));
  ok('The entries list leaves room under the Copilot button', r.roomUnderFab, JSON.stringify(r));
  await page.evaluate(() => __tf.setTheme('paper'));
  await page.waitForTimeout(150);
  r = await page.evaluate(() => {
    const lum = (c) => { const m = c.match(/\d+(\.\d+)?/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 10) / 10; };
    const t = document.querySelector('#incident .inc-f .inc-f-title'), f = document.querySelector('#incident .inc-f');
    const d = document.querySelector('#incident .inc-f .inc-f-detail');
    return { title: ratio(getComputedStyle(t).color, getComputedStyle(f).backgroundColor), detail: ratio(getComputedStyle(d).color, getComputedStyle(f).backgroundColor) };
  });
  ok('Readable in the light theme (4.5:1 or more)', r.title >= 4.5 && r.detail >= 4.5, JSON.stringify(r));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  r = await page.evaluate(() => {
    const g = (s) => document.querySelector('#incident ' + s).getBoundingClientRect();
    return { hscroll: document.documentElement.scrollWidth > innerWidth, stacked: g('.inc-findings').bottom <= g('.inc-main').top + 1 && g('.inc-main').bottom <= g('.inc-reader').top + 1, lanes: document.querySelectorAll('#incident .inc-lane').length };
  });
  ok('On a phone: findings, lanes and entries stack without overlapping; no sideways scrolling', !r.hscroll && r.stacked && r.lanes === 4, JSON.stringify(r));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click('#incident button[aria-label="Close the incident"]');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ modal: !document.getElementById('modal').hidden, text: document.getElementById('modal-box').textContent }));
  ok('Closing with pinned items asks first', r.modal && /3 pinned items/.test(r.text), r.text.slice(0, 120));
  await page.click('#modal-box button:has-text("Keep it open")');
  await page.waitForTimeout(150);
  r = await page.evaluate(() => !!document.getElementById('incident'));
  ok('"Keep it open" keeps it', r, String(r));
  await page.click('#incident button[aria-label="Close the incident"]');
  await page.waitForTimeout(150);
  await page.click('#modal-box button.primary');
  await page.waitForTimeout(200);
  r = await page.evaluate(() => { __tf.activate(__tf.tabs.find((t) => t.name === 'api-gateway.log')); return { view: !!document.getElementById('incident'), state: __tf.incident, open: document.body.classList.contains('incident-open'), signal: getComputedStyle(document.getElementById('signal')).display }; });
  ok('Close removes it and brings the timeline back', !r.view && !r.state && !r.open && r.signal !== 'none', JSON.stringify(r));

  ok('No errors', errors.length === 0, errors.join(' | ') || 'none');
  let pass = 0;
  for (const x of results) { if (x.pass) pass++; console.log((x.pass ? 'PASS ' : 'FAIL ') + x.name + '  —  ' + x.detail); }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exitCode = pass === results.length ? 0 : 1;
})().catch((e) => { console.error('INCIDENT TESTS FAILED', e); process.exit(2); });
