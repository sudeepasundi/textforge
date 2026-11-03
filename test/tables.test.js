const assert = require('assert');
const { JSDOM } = require('jsdom');
const T = require('../tables.js');

const DP = new JSDOM('').window.DOMParser;
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   - ' + name); }
  catch (e) { console.error('FAIL - ' + name + '\n' + e.message); process.exitCode = 1; }
}

const excelHtml = `<html><body><!--StartFragment--><table>
<tr><td>Name</td><td>Qty</td><td>Price</td></tr>
<tr><td>Apple</td><td>3</td><td>1.50</td></tr>
<tr><td>Fig | dried</td><td>10</td><td>4,20</td></tr></table><!--EndFragment--></body></html>`;

test('html table extracted', () => {
  const rows = T.extractTableFromHtml(excelHtml, DP);
  assert.deepStrictEqual(rows, [['Name', 'Qty', 'Price'], ['Apple', '3', '1.50'], ['Fig | dried', '10', '4,20']]);
});

test('colspan and <br> are handled', () => {
  const rows = T.extractTableFromHtml('<table><tr><td colspan="2">A<br>B</td><td>C</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>', DP);
  assert.deepStrictEqual(rows, [['A B', '', 'C'], ['1', '2', '3']]);
});

test('single cell and mixed content are left alone', () => {
  assert.strictEqual(T.extractTableFromHtml('<table><tr><td>x</td></tr></table>', DP), null);
  const mixed = '<p>' + 'Some long paragraph of text that is not part of the table. '.repeat(5) + '</p><table><tr><td>a</td><td>b</td></tr></table>';
  assert.strictEqual(T.extractTableFromHtml(mixed, DP), null);
  assert.strictEqual(T.extractTableFromHtml('<table><tr><td>a</td><td>b</td></tr></table><table><tr><td>c</td><td>d</td></tr></table>', DP), null);
  assert.strictEqual(T.extractTableFromHtml('<b>no table</b>', DP), null);
});

test('tsv detection', () => {
  assert.deepStrictEqual(T.parseTsv('a\tb\n1\t2\n'), [['a', 'b'], ['1', '2']]);
  assert.strictEqual(T.parseTsv('a\tb'), null);           // one line
  assert.strictEqual(T.parseTsv('a\tb\n1\t2\t3'), null);  // ragged
  assert.strictEqual(T.parseTsv('hello\nworld'), null);   // no tabs
});

const rows = [['Name', 'Qty'], ['Apple', '3'], ['Fig | dried', '10']];

test('markdown format round-trips', () => {
  const md = T.formatRows(rows, 'markdown');
  assert.strictEqual(md.split('\n')[1].replace(/[ -]/g, ''), '|||'); // separator row: 2 columns = 3 pipes
  assert.ok(md.includes('Fig \\| dried'));
  assert.deepStrictEqual(T.parseTableText(md), rows);
});

test('grid format round-trips', () => {
  const g = T.formatRows(rows, 'grid');
  assert.ok(g.startsWith('+'));
  assert.deepStrictEqual(T.parsePipeTable(g), [['Name', 'Qty'], ['Apple', '3'], ['Fig | dried', '10']].map((r) => r));
});

test('csv format quotes and round-trips', () => {
  const r2 = [['a', 'b'], ['x,y', 'say "hi"']];
  const csv = T.formatRows(r2, 'csv');
  assert.strictEqual(csv, 'a,b\n"x,y","say ""hi"""');
  assert.deepStrictEqual(T.parseTableText(csv), r2);
});

test('tsv and aligned round-trip', () => {
  const r2 = [['id', 'item name'], ['1', 'red apple']];
  assert.deepStrictEqual(T.parseTableText(T.formatRows(r2, 'tsv')), r2);
  const al = T.formatRows(r2, 'aligned');
  assert.deepStrictEqual(T.parseTableText(al), r2);
});

test('wide characters are padded by display width', () => {
  assert.strictEqual(T.strWidth('日本'), 4);
  const out = T.formatRows([['a', 'b'], ['日本', 'x']], 'aligned').split('\n');
  // second column must start at the same display column on both lines (width 4 + 2 gap = 6)
  assert.strictEqual(T.strWidth(out[0].slice(0, out[0].indexOf('b'))), 6);
  assert.strictEqual(T.strWidth(out[1].slice(0, out[1].indexOf('x'))), 6);
});

test('rich html escapes content', () => {
  const h = T.rowsToHtml([['<b>', 'a&b'], ['1', '2']]);
  assert.ok(h.includes('&lt;b&gt;') && h.includes('a&amp;b') && h.includes('<th'));
});

test('plain prose is not a table', () => {
  assert.strictEqual(T.parseTableText('just a sentence\nand another line'), null);
});

test('space-separated table with multi-word values (user report)', () => {
  const r = T.inferSpaceTable(`Employee ID Name Department Designation
EMP1001 Rahul Sharma Engineering Senior Developer
EMP1002 Priya Nair QA Test Engineer
EMP1003 Amit Verma DevOps Cloud Engineer
EMP1004 Sneha Rao Engineering Tech Lead
EMP1005 Karthik Kumar Support Analyst
EMP1006 Divya Menon Engineering Java Developer
EMP1007 Arjun Reddy QA Automation Engineer
EMP1008 Meera Iyer DevOps SRE
EMP1009 Vikram Singh Security Security Analyst
EMP1010 Ananya Das Engineering Backend Developer`);
  assert.ok(r && r.confident);
  assert.deepStrictEqual(r.rows[0], ['Employee ID', 'Name', 'Department', 'Designation']);
  assert.deepStrictEqual(r.rows[1], ['EMP1001', 'Rahul Sharma', 'Engineering', 'Senior Developer']);
  assert.deepStrictEqual(r.rows[5], ['EMP1005', 'Karthik Kumar', 'Support', 'Analyst']);
  assert.deepStrictEqual(r.rows[8], ['EMP1008', 'Meera Iyer', 'DevOps', 'SRE']);
  assert.strictEqual(r.rows.length, 11);
});

test('space-separated: variable column in the middle, IDs stay whole', () => {
  const r = T.inferSpaceTable('Order ID Customer Amount Status\nORD-1 Ravi Kumar 1200 Paid\nORD-2 Anu 300 Pending\nORD-3 Joseph Mathew 4500 Paid');
  assert.deepStrictEqual(r.rows[1], ['ORD-1', 'Ravi Kumar', '1200', 'Paid']);
  assert.deepStrictEqual(r.rows[2], ['ORD-2', 'Anu', '300', 'Pending']);
  const s = T.inferSpaceTable('Service Port Status Uptime\norder-service 8082 UP 3d\npayment-service 8083 DOWN 0m\ninventory-service 8084 UP 12h');
  assert.deepStrictEqual(s.rows[0], ['Service', 'Port', 'Status', 'Uptime']);
});

test('space-separated: prose, code and name lists are not tables', () => {
  assert.strictEqual(T.inferSpaceTable('Hi team,\nplease find the report attached.\nLet me know if anything is missing\nthanks'), null);
  assert.strictEqual(T.inferSpaceTable('public class A {\n  int x = 1;\n  void run() { x++; }\n}'), null);
  assert.strictEqual(T.inferSpaceTable('Rahul Sharma\nPriya Nair\nAmit Verma'), null);
  const nh = T.inferSpaceTable('EMP1001 Rahul Sharma Engineering\nEMP1002 Priya Nair QA\nEMP1003 Amit Verma DevOps');
  assert.ok(nh && !nh.confident, 'no header: offered, not automatic');
});

test('space-separated header with units and two-word names (API metrics)', () => {
  const r = T.inferSpaceTable(`Requests Avg Response (ms) Max Response (ms) Error Count Status
15200 120 450 12 SUCCESS
8700 350 1200 45 WARNING
22000 95 300 0 SUCCESS
5400 850 3500 120 CRITICAL
12500 180 800 8 SUCCESS
1200 2500 8000 32 WARNING
9800 210 950 5 SUCCESS
3400 450 1800 87 WARNING
7600 160 600 3 SUCCESS
950 1800 6500 110 CRITICAL`);
  assert.ok(r && r.confident);
  assert.deepStrictEqual(r.rows[0], ['Requests', 'Avg Response (ms)', 'Max Response (ms)', 'Error Count', 'Status']);
  assert.deepStrictEqual(r.rows[4], ['5400', '850', '3500', '120', 'CRITICAL']);
  assert.strictEqual(r.rows.length, 11);
});

console.log(`\n${passed} passed`);
