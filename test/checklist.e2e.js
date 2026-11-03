/* End-to-end checklist: runs the user's datasets (test/fixtures/datasets.json) and the 35-item feature
   checklist against the web build in Chromium. Usage: node test/checklist.e2e.js [url] [--json out.json]
   Needs Playwright (global install) and a served build, e.g. python -m http.server in web-dist/selfhost. */
const path = require('path');
const fs = require('fs');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(process.env.HOME || '', '.npm-global/lib/node_modules/playwright')); }
const { chromium } = playwright;

const URL_ = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'http://127.0.0.1:8765/';
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
const D = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/datasets.json'), 'utf8'));
const CHAT = fs.readFileSync(path.join(__dirname, 'fixtures/ai-chat-datasets.md'), 'utf8');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(URL_);
  await page.waitForFunction(() => window.__tf && window.__tf.active && document.querySelector('.monaco-editor .view-lines'), null, { timeout: 30000 });
  await page.waitForTimeout(800);

  // ---------- helpers that run inside the page ----------
  await page.evaluate(() => {
    const ed = () => monaco.editor.getEditors()[0];
    window.T = {
      ed,
      open(content, name, lang) { const t = __tf.newTab({ name: name || 'test.txt', content, lang }); t.detectDone = !!lang; __tf.activate(t); return t; },
      blank() { const t = T.open('', 'blank.txt', 'plaintext'); t.detectDone = false; return t; },
      value: () => __tf.active.model.getValue(),
      paste(plain, html) {
        const dt = new DataTransfer();
        if (plain != null) dt.setData('text/plain', plain);
        if (html != null) dt.setData('text/html', html);
        ed().focus();
        document.querySelector('.monaco-editor textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      },
      mdTableHtml(md) { const d = document.createElement('div'); d.appendChild(Markdown.render(md, document)); const t = d.querySelector('table'); return '<html><body><!--StartFragment-->' + t.outerHTML + '<!--EndFragment--></body></html>'; },
      mdHtml(md) { const d = document.createElement('div'); d.appendChild(Markdown.render(md, document)); return '<html><body>' + d.innerHTML + '</body></html>'; },
      tokens(line) { return monaco.editor.tokenize(line, 'log')[0].map((t, i, a) => [line.slice(t.offset, a[i + 1] ? a[i + 1].offset : line.length), t.type.replace('.log', '')]).filter((x) => x[0].trim()); },
      tablesIn(text) { return Markdown.countTables(text); },
      rowsOf(text) { return text.split('\n').filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l)).map((l) => Markdown.splitRow(l)); },
    };
  });
  const E = (fn, arg) => page.evaluate(fn, arg);
  const results = [];
  async function check(group, name, fn) {
    let r;
    const t0 = Date.now();
    try { r = await fn(); } catch (e) { r = { pass: false, detail: 'Error: ' + e.message.split('\n')[0] }; }
    results.push(Object.assign({ group, name, ms: Date.now() - t0 }, r));
    await page.keyboard.press('Escape').catch(() => {});
    await E(() => { document.getElementById('modal').hidden = true; document.getElementById('toast').hidden = true; });
  }
  const ok = (pass, detail) => ({ pass: !!pass, detail });

  // =====================================================================================
  // Rich paste of the whole AI chat (the Teams-like behaviour)
  // =====================================================================================
  await check('AI chat paste', 'Whole chat (HTML) keeps headings, code blocks and all tables', async () => {
    const r = await E((md) => { T.blank(); T.paste(md.slice(0, 200), T.mdHtml(md)); const v = T.value(); return { tables: T.tablesIn(v), fences: (v.match(/^```/gm) || []).length / 2, lang: __tf.active.model.getLanguageId(), h3: (v.match(/^### /gm) || []).length }; }, CHAT);
    return ok(r.tables === 5 && r.fences === 7 && r.lang === 'markdown' && r.h3 >= 15, `${r.tables} tables, ${r.fences} code blocks, ${r.h3} headings, tab language ${r.lang}`);
  });
  await check('AI chat paste', 'ChatGPT-style markup (li>p, code header with Copy button) is cleaned', async () => {
    const html = '<div><h3>Results</h3><ul><li><p>First <strong>point</strong></p></li><li><p>Second</p><ul><li>nested</li></ul></li></ul>' +
      '<pre><div class="flex"><span>log</span><button>Copy code</button></div><div><code class="language-log">2026-11-03 09:00:01 INFO ok\n2026-11-03 09:00:02 ERROR bad</code></div></pre>' +
      '<table><thead><tr><th>API</th><th>Status</th></tr></thead><tbody><tr><td><code>/api/users</code></td><td>OK</td></tr></tbody></table></div>';
    const v = await E((h) => { T.blank(); T.paste('Results', h); return T.value(); }, html);
    const good = /^- First \*\*point\*\*$/m.test(v) && /^ {3}- nested$/m.test(v) && /```log\n2026-11-03 09:00:01 INFO ok/.test(v) && !/Copy code/.test(v) && /\| `\/api\/users` \| OK/.test(v);
    return ok(good, good ? 'lists, nesting, code language and inline code kept; Copy button dropped' : v);
  });
  await check('AI chat paste', 'Markdown text with unaligned tables gets aligned', async () => {
    const v = await E(() => { T.blank(); T.paste('## Scores\n\n|Name|Score|\n|---|--:|\n|Rahul Sharma|85|\n|Priya|9|\n'); return T.value(); });
    return ok(/\| Rahul Sharma \| 85    \|/.test(v) && /\| ------------ \| ----: \|/.test(v), v.split('\n').slice(2, 5).join(' / '));
  });
  await check('AI chat paste', 'Preview renders real tables; header click sorts by salary', async () => {
    const r = await E((md) => {
      T.blank(); T.paste(md); __tf.setPreview(true);
      const tbl = document.querySelector('#preview-body table.md-table');
      const th = Array.from(tbl.tHead.rows[0].cells).find((c) => c.textContent === 'Salary');
      th.click();
      const asc = Array.from(tbl.tBodies[0].rows).map((r) => r.cells[th.cellIndex].textContent);
      th.click();
      const desc = Array.from(tbl.tBodies[0].rows).map((r) => r.cells[th.cellIndex].textContent);
      return { tables: document.querySelectorAll('#preview-body table.md-table').length, asc: asc.join(','), desc: desc[0] };
    }, D.table1_employees);
    return ok(r.tables === 1 && r.asc.startsWith('45000,62000') && r.desc === '120000', `rendered ${r.tables} table; ascending ${r.asc.slice(0, 30)}…; descending starts ${r.desc}`);
  });
  await check('AI chat paste', 'Copy as rich text produces an HTML table for Teams / Outlook', async () => {
    const r = await E(async () => {
      let captured = null;
      const orig = window.api.clipboardWrite;
      window.api.clipboardWrite = async (x) => { captured = x; return true; };
      await __tf.copyRichText();
      window.api.clipboardWrite = orig;
      const d = document.createElement('div');
      d.innerHTML = captured.html;
      return { tables: d.querySelectorAll('table').length, border: d.querySelector('td').style.border, plainHasPipe: captured.text.includes('| EMP1001') };
    });
    return ok(r.tables === 1 && /1px/.test(r.border) && r.plainHasPipe, `${r.tables} table with inline borders (${r.border}); plain-text fallback is Markdown`);
  });

  // =====================================================================================
  // Table handling (checklist)
  // =====================================================================================
  await check('Table handling', 'Paste HTML tables from browsers', async () => {
    const v = await E((md) => { T.blank(); T.paste(null, T.mdTableHtml(md)); return T.value(); }, D.table1_employees);
    const rows = await E((t) => T.rowsOf(t), v);
    return ok(rows.length === 11 && rows[0].length === 7 && rows[5][1] === 'Karthik Kumar', `${rows.length} rows x ${rows[0] && rows[0].length} columns`);
  });
  await check('Table handling', 'Paste tab-separated data', async () => {
    const tsv = D.table2_api.split('\n').filter((l) => l && !/^\|\s*-/.test(l)).map((l) => l.replace(/^\|\s*|\s*\|$/g, '').split(/\s*\|\s*/).join('\t')).join('\n');
    const v = await E((t) => { T.blank(); T.paste(t); return T.value(); }, tsv);
    const rows = await E((t) => T.rowsOf(t), v);
    return ok(rows.length === 11 && rows[0][3] === 'Avg Response (ms)', `${rows.length} rows; header "${rows[0] && rows[0][3]}"`);
  });
  await check('Table handling', 'Space-separated text with a "(ms)" header (API metrics, typed or from chat)', async () => {
    const txt = 'Requests Avg Response (ms) Max Response (ms) Error Count Status\n15200 120 450 12 SUCCESS\n8700 350 1200 45 WARNING\n22000 95 300 0 SUCCESS\n5400 850 3500 120 CRITICAL\n950 1800 6500 110 CRITICAL';
    const v = await E((t) => { T.blank(); T.paste(t); return T.value(); }, txt);
    const rows = await E((t) => T.rowsOf(t), v);
    return ok(rows.length === 6 && rows[0][1] === 'Avg Response (ms)' && rows[0][3] === 'Error Count' && rows[4][4] === 'CRITICAL', rows.length ? rows[0].join(' | ') : v);
  });
  await check('Table handling', 'Paste comma-separated CSV data', async () => {
    const csv = 'Transaction ID,User ID,Operation,Rows Affected\nTXN90001,U1001,INSERT,1\nTXN90002,U1002,UPDATE,3\nTXN90003,U1003,"SELECT, JOIN",25';
    const r = await E((t) => { T.blank(); T.paste(t); const toast = document.getElementById('toast'); const b = toast.querySelector('.toast-action'); const label = b && b.textContent; if (b) b.click(); return { label, v: T.value() }; }, csv);
    const rows = await E((t) => T.rowsOf(t), r.v);
    return ok(r.label && rows.length === 4 && rows[3][2] === 'SELECT, JOIN', `offered "${r.label}"; ${rows.length} rows; quoted comma kept: ${rows[3] && rows[3][2]}`);
  });
  await check('Table handling', 'Preserve empty cells', async () => {
    const html = '<table><tr><th>ID</th><th>Name</th><th>Remarks</th></tr><tr><td>6</td><td></td><td>N/A</td></tr><tr><td></td><td>Raj</td><td></td></tr></table>';
    const v = await E((h) => { T.blank(); T.paste('x', h); return T.value(); }, html);
    const rows = await E((t) => T.rowsOf(t), v);
    return ok(rows[1][1] === '' && rows[2][0] === '' && rows[2][2] === '' && rows.every((r) => r.length === 3), JSON.stringify(rows.slice(1)));
  });
  await check('Table handling', 'Handle multiline cell values', async () => {
    const html = '<table><tr><th>ID</th><th>Remarks</th></tr><tr><td>2</td><td>Pending<br>approval</td></tr><tr><td>5</td><td><p>Requires</p><p>manual verification</p></td></tr></table>';
    const v = await E((h) => { T.blank(); T.paste('x', h); return T.value(); }, html);
    return ok(/Pending.{0,6}approval/.test(v) && /Requires.{0,6}manual verification/.test(v) && v.split('\n').filter((l) => l.startsWith('|')).length === 4, v.split('\n').slice(2, 4).join(' / '));
  });
  await check('Table handling', 'Column alignment (Table 4 messy lengths)', async () => {
    const v = await E((md) => { T.blank(); T.paste(null, T.mdTableHtml(md)); return T.value(); }, D.table4_messy);
    const lines = v.split('\n').filter((l) => l.startsWith('|'));
    const pipes = (l) => [...l].map((c, i) => (c === '|' ? i : -1)).filter((i) => i >= 0).join(',');
    const same = lines.every((l) => pipes(l) === pipes(lines[0]));
    return ok(same && lines.length === 9, same ? 'every column boundary lines up across all 9 rows' : lines.join('\n'));
  });
  await check('Table handling', 'Column selection and copying (Shift+Alt+drag block select)', async () => {
    await E((md) => { T.open(md, 'cols.md', 'markdown'); T.ed().setScrollTop(0); T.ed().setScrollLeft(0); }, D.table1_employees);
    await page.waitForTimeout(400);
    const pts = await E(() => {
      const e = T.ed();
      const box = e.getDomNode().getBoundingClientRect();
      const a = e.getScrolledVisiblePosition({ lineNumber: 3, column: 17 });
      const b = e.getScrolledVisiblePosition({ lineNumber: 7, column: 30 });
      return { x1: box.left + a.left + 2, y1: box.top + a.top + a.height / 2, x2: box.left + b.left + 2, y2: box.top + b.top + b.height / 2 };
    });
    await page.mouse.click(pts.x1, pts.y1); // put the cursor where the block starts
    await page.keyboard.down('Shift');
    await page.keyboard.down('Alt');
    await page.mouse.move(pts.x1, pts.y1);
    await page.mouse.down();
    await page.mouse.move((pts.x1 + pts.x2) / 2, (pts.y1 + pts.y2) / 2, { steps: 4 });
    await page.mouse.move(pts.x2, pts.y2, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await page.keyboard.up('Shift');
    const r = await E(() => T.ed().getSelections().map((s) => __tf.active.model.getValueInRange(s)));
    const copied = r.map((x) => x.trim());
    return ok(r.length === 5 && copied[0] === 'Rahul Sharma' && copied[4] === 'Karthik Kumar', `${r.length}-line block selected: ${copied.join(', ')}`);
  });
  await check('Table handling', 'Very long cell values', async () => {
    const long = 'International payment processing transaction '.repeat(12).trim();
    const v = await E((l) => { T.blank(); T.paste(null, '<table><tr><th>ID</th><th>Description</th></tr><tr><td>2</td><td>' + l + '</td></tr></table>'); return T.value(); }, long);
    return ok(v.includes(long), long.length + '-character cell kept whole');
  });
  await check('Table handling', 'Unicode and special characters in tables', async () => {
    const html = '<table><tr><th>Name</th><th>Amount</th></tr><tr><td>José García</td><td>₹1500.50</td></tr><tr><td>こんにちは世界</td><td>!@#$%^&amp;*()</td></tr><tr><td>नमस्ते</td><td>a|b</td></tr></table>';
    const v = await E((h) => { T.blank(); T.paste('x', h); return T.value(); }, html);
    const rows = await E((t) => T.rowsOf(t), v);
    return ok(rows[1][0] === 'José García' && rows[2][0] === 'こんにちは世界' && rows[3][1] === 'a\\|b' && v.includes('₹1500.50'), 'accents, CJK (double width), Devanagari, ₹ and an escaped pipe kept');
  });

  // =====================================================================================
  // Log reading
  // =====================================================================================
  await check('Log reading', 'Log 1 (Spring): detected, INFO/DEBUG/WARN/ERROR coloured', async () => {
    const r = await E((log) => {
      T.blank(); T.paste(log);
      return new Promise((res) => setTimeout(() => res({ lang: __tf.active.model.getLanguageId(), t: T.tokens('2026-11-03 09:00:05.125 DEBUG [http-nio-8080-exec-1] c.e.UserService - x'), e: T.tokens('2026-11-03 09:00:09.500 ERROR [x] c.e.P - y'), w: T.tokens('a WARN b'), i: T.tokens('a INFO b') }), 900));
    }, D.log1_spring);
    const types = (arr) => arr.map((x) => x[1]).join(' ');
    const good = r.lang === 'log' && /log\.debug/.test(types(r.t)) && /log\.error/.test(types(r.e)) && /log\.warn/.test(types(r.w)) && /log\.info/.test(types(r.i)) && /log\.date/.test(types(r.t));
    return ok(good, `auto-detected as ${r.lang}; tokens: ${r.t.slice(0, 3).map((x) => x[1]).join(', ')}`);
  });
  await check('Log reading', 'Search with case sensitivity', async () => {
    const r = await E(() => { const m = __tf.active.model; return { cs: m.findMatches('error', false, false, true, null, false).length, ci: m.findMatches('error', false, false, false, null, false).length }; });
    return ok(r.cs === 0 && r.ci >= 6, `"error" match-case: ${r.cs}, ignore-case: ${r.ci}`);
  });
  await check('Log reading', 'Regex search (TXN\\d+)', async () => {
    const n = await E(() => __tf.active.model.findMatches('TXN\\d+', false, true, true, null, false).length);
    return ok(n === 1, n + ' match for TXN90045');
  });
  await check('Log reading', 'Multiple keyword search (ERROR and WARN at once)', async () => {
    const r = await E(() => { __tf.setFilter({ include: '\\b(ERROR|WARN)\\b' }); const a = __tf.active.an; const n = a.vis.reduce((x, y) => x + y, 0); __tf.clearFilter(); return n; });
    return ok(r === 4 || r === 8, r + ' entries match ERROR|WARN');
  });
  await check('Log reading', 'Filter by severity (ERROR only)', async () => {
    const r = await E(() => { __tf.setFilter({ levels: new Set(['ERROR']) }); const a = __tf.active.an; const n = a.vis.reduce((x, y) => x + y, 0); const hidden = document.querySelectorAll('.monaco-editor .line-numbers').length; __tf.clearFilter(); return { n, counts: a.counts, hidden }; });
    return ok(r.n === r.counts.ERROR && r.n > 0, `${r.n} error entries shown (counts ${JSON.stringify(r.counts)})`);
  });
  await check('Log reading', 'Search by thread name (exec-3)', async () => {
    const r = await E(() => { __tf.setFilter({ logger: 'exec-3' }); const n = __tf.active.an.vis.reduce((x, y) => x + y, 0); __tf.clearFilter(); return n; });
    return ok(r >= 1, r + ' entries on thread http-nio-8080-exec-3');
  });
  await check('Log reading', 'Find next / previous error (F8 / Shift+F8)', async () => {
    await E(() => { T.ed().setPosition({ lineNumber: 1, column: 1 }); T.ed().focus(); });
    await page.keyboard.press('F8');
    const a = await E(() => T.ed().getPosition().lineNumber);
    await page.keyboard.press('F8');
    const b = await E(() => T.ed().getPosition().lineNumber);
    await page.keyboard.press('Shift+F8');
    const c = await E(() => T.ed().getPosition().lineNumber);
    return ok(a < b && c === a, `next ${a} -> ${b}, previous back to ${c}`);
  });
  await check('Log reading', 'Line numbers shown', async () => {
    const n = await E(() => document.querySelectorAll('.monaco-editor .line-numbers').length);
    return ok(n > 5, n + ' line numbers rendered');
  });
  await check('Log reading', 'Horizontal and vertical scrolling, word wrap (Test A long lines)', async () => {
    const r = await E((log) => {
      T.open(log, 'long.log', 'log');
      const e = T.ed();
      const wait = () => new Promise((r) => { e.layout(); e.render(true); setTimeout(r, 700); });
      return wait().then(() => {
        const w1 = e.getScrollWidth();
        e.updateOptions({ wordWrap: 'on' });
        return wait().then(() => {
          const w2 = e.getScrollWidth();
          const h2 = e.getScrollHeight();
          e.updateOptions({ wordWrap: 'off' });
          return { w1, w2, h2, width: e.getLayoutInfo().contentWidth };
        });
      });
    }, D.testA_long);
    return ok(r.w1 > r.width && r.w2 <= r.width + 20, `scroll width ${r.w1}px without wrap, ${r.w2}px with wrap (view ${r.width}px)`);
  });
  await check('Log reading', 'Multiline stack trace grouping (Log 3)', async () => {
    const r = await E((log) => {
      T.open(log, 'batch.log', 'log');
      __tf.treatAsLog(__tf.active);
      const a = __tf.active.an;
      const npe = a.entries.find((e) => e.level === 'ERROR');
      return { entries: a.entries.length, npeLines: npe.end - npe.start + 1, folds: a.entries.filter((e) => e.end > e.start).length };
    }, D.log3_exceptions);
    return ok(r.npeLines >= 9 && r.entries === 13, `${r.entries} entries; the NPE entry spans ${r.npeLines} lines (stack + Caused by)`);
  });
  await check('Log reading', 'Per-line logged stack traces join their error (Log 1)', async () => {
    const r = await E((log) => {
      T.open(log, 'spring.log', 'log');
      __tf.treatAsLog(__tf.active);
      const a = __tf.active.an;
      return { errors: a.counts.ERROR, groups: a.groups.map((g) => g.title + ' x' + g.count) };
    }, D.log1_spring);
    return ok(r.errors === 2, `${r.errors} errors (5 ERROR lines, of which 4 are one stack trace); groups: ${r.groups.join('; ')}`);
  });
  await check('Log reading', 'Large file loading (100,000 lines)', async () => {
    const r = await E(() => {
      const lv = ['INFO', 'INFO', 'INFO', 'DEBUG', 'WARN', 'ERROR'];
      const out = [];
      for (let i = 0; i < 100000; i++) {
        const s = String(i % 60).padStart(2, '0');
        out.push(`2026-11-03 10:${String(Math.floor(i / 6000) % 60).padStart(2, '0')}:${s}.${String(i % 1000).padStart(3, '0')} ${lv[i % 6]} [http-nio-8080-exec-${i % 9}] c.e.OrderService - order=${100000 + i} user=U${i % 977} took ${i % 1500}ms`);
      }
      const text = out.join('\n');
      const t0 = performance.now();
      const t = T.open(text, 'big.log');
      const t1 = performance.now();
      __tf.treatAsLog(t);
      const t2 = performance.now();
      __tf.setFilter({ levels: new Set(['ERROR']) });
      const t3 = performance.now();
      __tf.clearFilter();
      return { mb: (text.length / 1048576).toFixed(1), open: Math.round(t1 - t0), analyse: Math.round(t2 - t1), filter: Math.round(t3 - t2), errors: t.an.counts.ERROR };
    });
    return ok(r.analyse < 4000 && r.filter < 2000 && r.errors === 16666, `${r.mb} MB: open ${r.open} ms, analyse ${r.analyse} ms, filter ${r.filter} ms, ${r.errors} errors`);
  });

  // =====================================================================================
  // Advanced analysis
  // =====================================================================================
  await check('Advanced analysis', 'Count ERROR/WARN/INFO (Log 2)', async () => {
    const c = await E((log) => { T.open(log, 'servers.log', 'log'); __tf.treatAsLog(__tf.active); return __tf.active.an.counts; }, D.log2_servers);
    return ok(c.ERROR === 5 && c.WARN === 4 && c.INFO === 6, JSON.stringify(c));
  });
  await check('Advanced analysis', 'Search across server IDs (logger filter SERVER-02)', async () => {
    const r = await E(() => { __tf.setFilter({ logger: 'SERVER-02' }); const n = __tf.active.an.vis.reduce((x, y) => x + y, 0); __tf.clearFilter(); return n; });
    return ok(r === 3, r + ' entries from SERVER-02');
  });
  await check('Advanced analysis', 'Highlight IPs, ports, percentages and numbers', async () => {
    const t = await E(() => [...T.tokens('2026-11-03 10:15:12 ERROR SERVER-02 Connection refused: database-primary:3306'), ...T.tokens('IP=192.168.1.10 CPU_USAGE=82% x')]);
    const find = (s) => (t.find((x) => x[0].includes(s)) || [])[1] || 'none';
    const r = { ip: find('192.168.1.10'), port: find('3306'), pct: find('82%') };
    return ok(r.ip !== 'none' && r.ip !== 'log' && /number|ip|url|id/.test(r.port) && /number/.test(r.pct), JSON.stringify(r));
  });
  await check('Advanced analysis', 'Find repeated error patterns (Log 2)', async () => {
    const g = await E(() => __tf.active.an.groups.map((x) => x.title + ' x' + x.count));
    return ok(g.length >= 4, g.join('; '));
  });
  await check('Advanced analysis', 'Find duplicate log entries (Test C)', async () => {
    const r = await E((log) => {
      T.open(log, 'dups.log', 'log'); __tf.treatAsLog(__tf.active);
      __tf.runCommand('Find duplicate lines');
      return Array.from(document.querySelectorAll('#panel-body table.grid tr')).slice(1).map((tr) => Array.from(tr.cells).map((c) => c.textContent).join(' | '));
    }, D.testC_duplicates);
    const timeout = r.find((x) => /Database connection timeout/.test(x));
    const restart = r.find((x) => /Service restarted/.test(x));
    return ok(timeout && /\b4\b/.test(timeout) && restart && /\b3\b/.test(restart), r.slice(0, 3).join(' ; '));
  });
  await check('Advanced analysis', 'Extract timestamps', async () => {
    const r = await E(() => __tf.extract('timestamps'));
    return ok(r && r.rows.length === 12 && r.rows[0].values[0] === '2026-11-03 14:00:01', r ? `${r.rows.length} timestamps, first ${r.rows[0].values[0]}` : 'no preset');
  });
  await check('Advanced analysis', 'Extract IP addresses + unique count (Log 4)', async () => {
    const r = await E((log) => { T.open(log, 'auth.log', 'log'); __tf.treatAsLog(__tf.active); const x = __tf.extract('ips'); return x && { n: x.rows.length, uniq: new Set(x.rows.map((r) => r.values[0])).size, counted: __tf.countBy(0) }; }, D.log4_auth);
    return ok(r && r.n === 6 && r.uniq === 3 && r.counted && r.counted[0][0] === '203.0.113.45' && r.counted[0][1] === 4, r ? `${r.n} IPs, ${r.uniq} unique; top ${JSON.stringify(r.counted && r.counted[0])}` : 'no preset');
  });
  await check('Advanced analysis', 'Failed login detection (Log 4)', async () => {
    const r = await E(() => { __tf.setFilter({ include: 'STATUS=(FAILED|BLOCKED)' }); const n = __tf.active.an.vis.reduce((x, y) => x + y, 0); __tf.clearFilter(); const g = __tf.active.an.groups.map((x) => x.title + ' x' + x.count); return { n, g }; });
    return ok(r.n === 5, `${r.n} failed or blocked logins`);
  });
  await check('Advanced analysis', 'Highlight UUIDs and transaction IDs', async () => {
    const t = await E(() => [...T.tokens('ERROR Payment processing failed for transaction TXN90045'), ...T.tokens('id 3f2b8c1e-9a4d-4e2b-8f6a-1c2d3e4f5a6b x')]);
    const txn = (t.find((x) => x[0].includes('TXN90045')) || [])[1];
    const uuid = (t.find((x) => x[0].includes('3f2b8c1e')) || [])[1];
    return ok(/id/.test(txn || '') && /id/.test(uuid || ''), `TXN90045 -> ${txn}, UUID -> ${uuid}`);
  });
  await check('Advanced analysis', 'Filter by date and time (Log 2, 10:15:10 to 10:15:20)', async () => {
    const r = await E((log) => { T.open(log, 'servers.log', 'log'); __tf.treatAsLog(__tf.active); __tf.setFilter({ from: '10:15:10', to: '10:15:20' }); const n = __tf.active.an.vis.reduce((x, y) => x + y, 0); __tf.clearFilter(); return n; }, D.log2_servers);
    return ok(r === 6, r + ' entries between 10:15:10 and 10:15:20');
  });
  await check('Advanced analysis', 'Compare two log sections (side-by-side diff)', async () => {
    const r = await E(() => {
      const a = T.open('2026-11-03 10:00:01 INFO start\n2026-11-03 10:00:02 ERROR boom\n2026-11-03 10:00:03 INFO end', 'run-a.log', 'log');
      T.open('2026-11-03 10:00:01 INFO start\n2026-11-03 10:00:02 WARN slow\n2026-11-03 10:00:03 INFO end', 'run-b.log', 'log');
      return __tf.compareWith(a);
    });
    await page.waitForTimeout(800);
    const d = await E(() => ({ diff: !!document.querySelector('.monaco-diff-editor'), changes: (monaco.editor.getDiffEditors()[0] || { getLineChanges: () => null }).getLineChanges() }));
    await E(() => __tf.closeCompare && __tf.closeCompare());
    return ok(d.diff && d.changes && d.changes.length === 1, d.diff ? `${d.changes ? d.changes.length : '?'} changed block found` : 'no diff view');
  });
  await check('Advanced analysis', 'Copy filtered results (only shown entries)', async () => {
    const r = await E(async (log) => {
      T.open(log, 'servers.log', 'log'); __tf.treatAsLog(__tf.active);
      __tf.setFilter({ levels: new Set(['ERROR']) });
      let captured = null;
      const orig = window.api.clipboardWrite;
      window.api.clipboardWrite = async (x) => { captured = x; return true; };
      await __tf.runCommand('Copy shown entries');
      window.api.clipboardWrite = orig;
      __tf.clearFilter();
      return captured && captured.text;
    }, D.log2_servers);
    const lines = (r || '').split('\n').filter(Boolean);
    return ok(lines.length === 5 && lines.every((l) => / ERROR /.test(l)), r ? lines.length + ' lines copied, all ERROR' : 'not available');
  });
  await check('Advanced analysis', 'Preserve original line numbers while filtered', async () => {
    const r = await E(() => {
      __tf.setFilter({ levels: new Set(['ERROR']) });
      return new Promise((res) => setTimeout(() => { const n = Array.from(document.querySelectorAll('.monaco-editor .line-numbers')).map((x) => +x.textContent).filter(Boolean); __tf.clearFilter(); res(n); }, 300));
    });
    return ok(r.join(',') === '4,6,7,10,15', 'visible line numbers: ' + r.join(','));
  });
  await check('Advanced analysis', 'First and last occurrence of each exception (Log 3)', async () => {
    const r = await E((log) => { T.open(log, 'batch.log', 'log'); __tf.treatAsLog(__tf.active); return __tf.active.an.groups.map((g) => ({ t: g.title, first: g.firstTs, last: g.lastTs, n: g.count })); }, D.log3_exceptions);
    const titles = r.map((x) => x.t).join(', ');
    return ok(/IllegalArgumentException|NullPointerException/.test(titles) && /SQLException/.test(titles) && r.every((x) => x.first != null), titles);
  });

  // =====================================================================================
  // Unicode / special characters (Test B)
  // =====================================================================================
  await check('Log reading', 'Unicode and special characters (Test B): search and regex', async () => {
    const r = await E((log) => { T.open(log, 'unicode.log', 'log'); const m = __tf.active.model; return { inr: m.findMatches('₹1500.50', false, false, true, null, false).length, jp: m.findMatches('こんにちは', false, false, true, null, false).length, path: m.findMatches('C:\\Users\\admin', false, false, true, null, false).length, re: m.findMatches('José\\s+García', false, true, true, null, false).length }; }, D.testB_unicode);
    return ok(r.inr && r.jp && r.path && r.re, JSON.stringify(r));
  });

  // =====================================================================================
  // Editor stability
  // =====================================================================================
  await check('Editor stability', 'Undo and redo after paste', async () => {
    const r = await E((md) => { T.blank(); T.paste(null, T.mdTableHtml(md)); const a = T.value(); T.ed().trigger('t', 'undo'); const b = T.value(); T.ed().trigger('t', 'redo'); const c = T.value(); return { a: a.length, b: b.length, same: a === c }; }, D.table3_db);
    return ok(r.a > 0 && r.b === 0 && r.same, `after paste ${r.a} chars, undo ${r.b}, redo restores`);
  });
  await check('Editor stability', 'Handle 1 MB+ single line', async () => {
    const r = await E(() => {
      const line = '2026-11-03 13:00:01 INFO payload=' + 'x'.repeat(1100000) + ' END_MARKER';
      const t0 = performance.now();
      T.open(line, 'oneline.log');
      const t1 = performance.now();
      const n = __tf.active.model.findMatches('END_MARKER', false, false, true, null, false).length;
      const t2 = performance.now();
      return { open: Math.round(t1 - t0), find: Math.round(t2 - t1), n };
    });
    return ok(r.n === 1 && r.open < 3000, `1.1 MB line: open ${r.open} ms, search ${r.find} ms`);
  });
  await check('Editor stability', 'Open multiple files (tabs)', async () => {
    const n = await E(() => document.querySelectorAll('.tab').length);
    return ok(n >= 10, n + ' tabs open');
  });
  await check('Editor stability', 'Find and replace across 100,000 lines without freezing', async () => {
    const r = await E(() => {
      const t = __tf.tabs.find((x) => x.name === 'big.log');
      __tf.activate(t);
      const m = t.model;
      const t0 = performance.now();
      const matches = m.findMatches('OrderService', false, false, true, null, false, 1000000);
      m.pushEditOperations([], matches.map((x) => ({ range: x.range, text: 'OrderSvc' })), () => null);
      const t1 = performance.now();
      return { n: matches.length, ms: Math.round(t1 - t0) };
    });
    return ok(r.n === 100000 && r.ms < 5000, `${r.n.toLocaleString()} replacements in ${r.ms} ms`);
  });
  await check('Editor stability', 'Line endings: CRLF and LF', async () => {
    const r = await E(() => { const t = T.open('a\r\nb\r\nc', 'crlf.txt', 'plaintext'); const before = t.model.getEOL(); const v = t.model.getValue(); return { before, kept: v.includes('\r\n') }; });
    return ok(r.before === '\r\n' && r.kept, 'CRLF detected and kept on save');
  });

  // =====================================================================================
  // Multi-line filters and the floating Copilot pane
  // =====================================================================================
  const count = () => E(() => { const a = __tf.active.an; return a.vis ? a.vis.reduce((x, y) => x + y, 0) : a.entries.length; });
  await check('Multi-line filters', 'Lines matching: several lines, any of them (Log 2)', async () => {
    await E((log) => { T.open(log, 'servers.log', 'log'); __tf.treatAsLog(__tf.active); __tf.setFilter({ include: 'Disk\nrefused', includeMode: 'any' }); }, D.log2_servers);
    const n = await count();
    return ok(n === 3, n + ' entries match "Disk" or "refused"');
  });
  await check('Multi-line filters', 'Lines matching: all lines must match', async () => {
    await E(() => __tf.setFilter({ include: 'SERVER-01\nDisk', includeMode: 'all' }));
    const n = await count();
    await E(() => __tf.clearFilter());
    return ok(n === 2, n + ' entries contain both "SERVER-01" and "Disk"');
  });
  await check('Multi-line filters', 'Hide lines matching: several patterns', async () => {
    await E(() => __tf.setFilter({ exclude: 'INFO\nWARN' }));
    const n = await count();
    await E(() => __tf.clearFilter());
    return ok(n === 5, n + ' entries left after hiding INFO and WARN lines');
  });
  await check('Multi-line filters', 'Several trace / request IDs (Log 4)', async () => {
    await E((log) => { T.open(log, 'auth.log', 'log'); __tf.treatAsLog(__tf.active); __tf.setFilter({ trace: '203.0.113.45\nTKN1002' }); }, D.log4_auth);
    const n = await count();
    const bar = await E(() => document.getElementById('filterbar').innerText);
    await E(() => __tf.clearFilter());
    return ok(n === 5 && /2 IDs/.test(bar), `${n} entries for 2 IDs; filter bar: ${bar.split('\n').slice(0, 2).join(' ')}`);
  });
  await check('Multi-line filters', 'A bad pattern on one line is reported; other lines still work', async () => {
    await E((log) => { T.open(log, 'servers.log', 'log'); __tf.treatAsLog(__tf.active); __tf.setFilter({ include: 'Disk\n(unclosed' }); }, D.log2_servers);
    const n = await count();
    const err = await E(() => __tf.active.an.filterError);
    await E(() => __tf.clearFilter());
    return ok(n === 2 && /line 2/.test(err || ''), `${n} matches; error: ${err}`);
  });
  await check('Multi-line filters', 'Typing two lines in the "Lines matching" box (Enter for the next line)', async () => {
    await E((log) => { T.open(log, 'servers.log', 'log'); __tf.treatAsLog(__tf.active); __tf.clearFilter(); __tf.showView('insights', { toggle: false }); }, D.log2_servers);
    await page.waitForTimeout(300);
    await page.click('#flt-include');
    await page.keyboard.type('restored');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Restart completed');
    await page.waitForTimeout(600);
    const r = await E(() => ({ v: document.getElementById('flt-include').value, n: __tf.active.an.vis ? __tf.active.an.vis.reduce((x, y) => x + y, 0) : -1 }));
    await E(() => { __tf.clearFilter(); __tf.showView('insights'); });
    return ok(r.n === 2 && r.v.split('\n').length === 2, `box holds ${r.v.split('\n').length} lines; ${r.n} entries shown`);
  });
  await check('Copilot pane', 'Floating button opens the Copilot pane over the editor', async () => {
    await E(() => { __tf.settings.cpDock = false; __tf.settings.cpRect = null; });
    await page.click('#cp-fab');
    await page.waitForTimeout(300);
    const r = await E(() => { const h = document.getElementById('cp-host'); const s = getComputedStyle(h); return { open: !h.hidden, pos: s.position, bar: h.querySelectorAll('.cp-bar').length, fabOn: document.getElementById('cp-fab').classList.contains('on') }; });
    return ok(r.open && r.pos === 'absolute' && r.bar === 0 && r.fabOn, `open ${r.open}, ${r.pos} (floating), no action bar`);
  });
  await check('Copilot pane', 'Dock to the side and back; editor makes room when docked', async () => {
    const w0 = await E(() => T.ed().getLayoutInfo().width);
    await page.click('#cp-dock');
    await page.waitForTimeout(400);
    const d = await E(() => ({ cls: document.getElementById('cp-host').className, w: T.ed().getLayoutInfo().width }));
    await page.click('#cp-dock');
    await page.waitForTimeout(400);
    const f = await E(() => ({ cls: document.getElementById('cp-host').className, w: T.ed().getLayoutInfo().width }));
    return ok(/dock/.test(d.cls) && d.w < w0 - 300 && /float/.test(f.cls) && f.w === w0, `editor ${w0}px, docked ${d.w}px, floating again ${f.w}px`);
  });
  await check('Copilot pane', 'Drag the floating pane by its title bar', async () => {
    const before = await E(() => document.getElementById('cp-host').getBoundingClientRect().toJSON());
    const head = await E(() => document.getElementById('cp-head').getBoundingClientRect().toJSON());
    await page.mouse.move(head.x + 60, head.y + 12);
    await page.mouse.down();
    await page.mouse.move(head.x - 240, head.y - 120, { steps: 6 });
    await page.mouse.up();
    const after = await E(() => document.getElementById('cp-host').getBoundingClientRect().toJSON());
    const saved = await E(() => __tf.settings.cpRect);
    return ok(after.x < before.x - 200 && after.y < before.y - 50 && saved && saved.w > 250, `moved from (${Math.round(before.x)},${Math.round(before.y)}) to (${Math.round(after.x)},${Math.round(after.y)}), position remembered`);
  });
  await check('Copilot pane', 'Alt+4 closes and reopens it', async () => {
    await E(() => T.ed().focus());
    await page.keyboard.press('Alt+4');
    const a = await E(() => document.getElementById('cp-host').hidden);
    await page.keyboard.press('Alt+4');
    const b = await E(() => document.getElementById('cp-host').hidden);
    await E(() => __tf.closeCopilot());
    return ok(a === true && b === false, `after Alt+4: hidden ${a}; again: hidden ${b}`);
  });

  await check('Large files', 'Filter really hides lines in a 400,000-line log (Monaco large-file mode)', async () => {
    const r = await E(() => {
      const out = [];
      for (let i = 0; i < 400000; i++) out.push(`2026-11-03 10:00:${String(i % 60).padStart(2, '0')}.000 ${i % 6 === 5 ? 'ERROR' : 'INFO'} [x] c.e.S - n=${i}`);
      const t = T.open(out.join('\n'), 'huge.log');
      __tf.treatAsLog(t);
      const t0 = performance.now();
      __tf.setFilter({ levels: new Set(['ERROR']) });
      const ms = Math.round(performance.now() - t0);
      const viewLines = T.ed()._getViewModel().getLineCount();
      __tf.clearFilter();
      return { viewLines, vis: t.an.counts.ERROR, ms };
    });
    return ok(r.viewLines === 66666 && r.vis === 66666, `${r.viewLines.toLocaleString()} lines on screen for ${r.vis.toLocaleString()} errors (filter ${r.ms} ms)`);
  });
  await check('Large files', 'Kubernetes-prefixed and epoch-timestamp logs filter line by line', async () => {
    const r = await E(() => {
      const a = [], b = [];
      for (let i = 0; i < 3000; i++) {
        a.push(`[order-service-7d9f8b5c4-x2kq9 app] 2026-11-03 10:00:${String(i % 60).padStart(2, '0')}.000 ${i % 6 === 5 ? 'ERROR' : 'INFO'} c.e.S - n=${i}`);
        b.push(`${1793691301000 + i} ${i % 6 === 5 ? 'ERROR' : 'INFO'} OrderService n=${i}`);
      }
      const res = [];
      for (const txt of [a, b]) {
        const t = T.open(txt.join('\n'), 'x.log'); __tf.treatAsLog(t);
        __tf.setFilter({ levels: new Set(['ERROR']) });
        res.push(T.ed()._getViewModel().getLineCount());
        __tf.clearFilter();
      }
      return res;
    });
    return ok(r[0] === 500 && r[1] === 500, `pod-prefixed: ${r[0]} lines shown, epoch: ${r[1]} lines shown (500 errors each)`);
  });

  // ---------- report ----------
  const groups = [...new Set(results.map((r) => r.group))];
  let pass = 0;
  for (const g of groups) {
    console.log('\n' + g);
    for (const r of results.filter((x) => x.group === g)) {
      if (r.pass) pass++;
      console.log((r.pass ? '  PASS ' : '  FAIL ') + r.name + '  —  ' + (r.detail || ''));
    }
  }
  console.log(`\n${pass}/${results.length} passed` + (pageErrors.length ? `\nPage errors: ${pageErrors.slice(0, 5).join(' | ')}` : ''));
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ results, pageErrors }, null, 1));
  await browser.close();
  process.exitCode = pass === results.length ? 0 : 1;
})().catch((e) => { console.error('CHECKLIST FAILED', e); process.exit(2); });
