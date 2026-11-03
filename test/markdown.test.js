const assert = require('assert');
const { JSDOM } = require('jsdom');
const M = require('../markdown.js');
const L = require('../logs.js');
const D = require('./fixtures/datasets.json');

const dom = new JSDOM('<!doctype html><body></body>');
const doc = dom.window.document;
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   - ' + name); }
  catch (e) { console.error('FAIL - ' + name + '\n' + (e.stack || e.message)); process.exitCode = 1; }
}

test('HTML chat -> Markdown keeps headings, lists, code language, tables', () => {
  const html = '<h3>Table 2</h3><p>Some <strong>bold</strong> and <code>code</code>.</p><ul><li><p>one</p></li><li>two<ul><li>deep</li></ul></li></ul>' +
    '<pre><button>Copy code</button><code class="language-java">int x = 1;</code></pre>' +
    '<table><thead><tr><th>API</th><th>Avg (ms)</th></tr></thead><tbody><tr><td>/api/users</td><td>120</td></tr><tr><td>a|b</td><td></td></tr></tbody></table>';
  const md = M.htmlToMarkdown(html, dom.window.DOMParser);
  assert.ok(md.startsWith('### Table 2\n\nSome **bold** and `code`.'));
  assert.ok(/^- one\n- two\n {3}- deep$/m.test(md));
  assert.ok(md.includes('```java\nint x = 1;\n```') && !md.includes('Copy code'));
  assert.ok(md.includes('| API        | Avg (ms) |') && md.includes('| a\\|b       |          |'));
});

test('render: tables, alignment, code, lists, escapes; no HTML injection', () => {
  const div = doc.createElement('div');
  div.appendChild(M.render('# T\n\n|a|b|\n|:-|--:|\n|1|<img src=x onerror=alert(1)>|\n\n```log\nERROR x\n```\n\n- [x] done\n- item with [link](https://example.com)\n\n1\\. not a list', doc));
  assert.strictEqual(div.querySelectorAll('table td').length, 2);
  assert.strictEqual(div.querySelector('td:nth-child(2)').style.textAlign, 'right');
  assert.strictEqual(div.querySelector('img'), null, 'raw HTML is shown as text');
  assert.ok(div.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.strictEqual(div.querySelector('pre').getAttribute('data-lang'), 'log');
  assert.ok(div.querySelector('input[type=checkbox]').checked);
  assert.strictEqual(div.querySelector('a').getAttribute('href'), 'https://example.com');
  assert.ok(div.textContent.includes('1. not a list'));
  assert.ok(div.querySelector('[data-line="2"]'), 'tables carry their source line');
});

test('javascript: links are never created', () => {
  const div = doc.createElement('div');
  div.appendChild(M.render('[x](javascript:alert(1)) and <script>alert(1)</script>', doc));
  assert.strictEqual(div.querySelector('a'), null);
  assert.strictEqual(div.querySelector('script'), null);
});

test('alignTables keeps alignment markers and short separators', () => {
  const out = M.alignTables('|Name|Score|\n|---|--:|\n|Rahul Sharma|85|');
  assert.strictEqual(out, '| Name         | Score |\n| ------------ | ----: |\n| Rahul Sharma | 85    |');
  assert.strictEqual(M.countTables(out), 1);
  assert.ok(M.looksLikeMarkdown('## H\n\n' + out));
  assert.ok(!M.looksLikeMarkdown('just text | with a pipe\nand more'));
});

test('per-line logged stack traces join their error (Log 1)', () => {
  const lines = D.log1_spring.split('\n');
  const p = L.parseEntries(lines);
  const c = L.levelCounts(p.entries);
  assert.strictEqual(c.ERROR, 2);
  const g = L.groupErrors(p.entries, lines, { myPackages: 'com.example' });
  const t = g.find((x) => x.title === 'SocketTimeoutException');
  assert.ok(t, 'grouped under the exception');
  assert.strictEqual(t.frame, 'com.example.gateway.PaymentGateway.process(PaymentGateway.java:145)');
});

test('upper-case source after the level is the logger (Log 2, Log 4)', () => {
  const e = L.parseLine('2026-11-03 10:15:12 ERROR SERVER-02 Connection refused: database-primary:3306');
  assert.strictEqual(e.logger, 'SERVER-02');
  assert.strictEqual(e.message, 'Connection refused: database-primary:3306');
  assert.strictEqual(L.parseLine('2026-11-03 12:00:01 INFO AUTH User=admin IP=192.168.1.10').logger, 'AUTH');
});

test('duplicates and count-by (Test C)', () => {
  const lines = D.testC_duplicates.split('\n');
  const p = L.parseEntries(lines);
  const d = L.findDuplicates(p.entries, lines, true);
  assert.deepStrictEqual(d.map((x) => [x.text, x.count]), [['Database connection timeout', 4], ['Service restarted', 3]]);
  assert.deepStrictEqual(L.countBy(['a', 'b', 'a']), [['a', 2], ['b', 1]]);
});

test('IP and timestamp presets', () => {
  const units = D.log4_auth.split('\n').map((t, i) => ({ line: i + 1, text: t }));
  const ip = L.PRESETS.find((x) => x.id === 'ips');
  const r = L.extractRegex(units, ip.regex, ip.flags);
  assert.strictEqual(r.rows.length, 6);
  assert.strictEqual(new Set(r.rows.map((x) => x.values[0])).size, 3);
  const ts = L.PRESETS.find((x) => x.id === 'timestamps');
  assert.strictEqual(L.extractRegex(units, ts.regex, '').rows.length, 12);
});

console.log(`\n${passed} passed`);
