// Automatic tables: the engine must find the patterns and name the columns by itself, for any layout.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../logs.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   - ' + name); }
  catch (e) { console.error('FAIL - ' + name + '\n' + (e.stack || e.message)); process.exitCode = 1; }
}
const run = (text) => { const lines = text.split('\n'); return L.autoTables(lines, L.parseEntries(lines).entries); };
const find = (r, re) => r.tables.find((t) => re.test(t.template));
const col = (t, name) => { const i = t.columns.indexOf(name); assert.ok(i >= 0, 'no column "' + name + '" in ' + t.columns.join(', ')); return t.rows.map((r) => r.values[i]); };

test('Spring Boot sample: requests, Kafka and failures each get a table with named columns', () => {
  const r = run(fs.readFileSync(path.join(__dirname, '../samples/order-service.log'), 'utf8'));
  const req = find(r, /POST \/api\/orders userId=/);
  assert.ok(req, 'request table');
  assert.deepStrictEqual(col(req, 'took (ms)'), ['84', '1534', '97', '76']);
  assert.deepStrictEqual(col(req, 'orderId').slice(0, 2), ['90001', '90002']);
  assert.ok(req.columns.includes('time') && req.columns.includes('traceId'));
  const kafka = find(r, /processed orderId/);
  assert.deepStrictEqual(kafka.columns.filter((c) => /partition|offset|orderId|took/.test(c)), ['partition', 'offset', 'orderId', 'took (ms)']);
  const fail = find(r, /Failed to place order/);
  assert.deepStrictEqual(col(fail, 'exception'), ['java.lang.NullPointerException', 'java.lang.NullPointerException']);
  const pay = find(r, /Payment call failed .*password/);
  assert.strictEqual(col(pay, 'caused by')[0], 'java.net.SocketTimeoutException');
  assert.ok(!r.tables.some((t) => t.rows.some((row) => row.values.some((v) => /:$/.test(v)))), 'no trailing colons in values');
});

test('similar messages are merged: the changing word becomes a column', () => {
  const lines = [];
  const words = ['succeeded', 'failed', 'retried'];
  for (let i = 0; i < 30; i++) lines.push(`2026-11-03 10:00:${String(i).padStart(2, '0')} INFO c.w.Pay - Payment ${words[i % 3]} for order ${1000 + i} in ${10 + i} ms`);
  const r = run(lines.join('\n'));
  assert.strictEqual(r.tables.length, 1, r.tables.map((t) => t.template).join(' / '));
  const t = r.tables[0];
  assert.deepStrictEqual(col(t, 'Payment').slice(0, 3), words, 'rows stay in file order');
  assert.strictEqual(col(t, 'order')[0], '1000');
  assert.strictEqual(col(t, 'ms')[1], '11');
});

test('different events stay apart', () => {
  const lines = [];
  for (let i = 0; i < 10; i++) { lines.push(`2026-11-03 10:00:0${i % 10} INFO App - Order placed id=${i}`); lines.push(`2026-11-03 10:00:0${i % 10} INFO App - Cache cleared in ${i}ms`); }
  const r = run(lines.join('\n'));
  assert.ok(find(r, /Order placed/) && find(r, /Cache cleared/));
  assert.strictEqual(find(r, /Order placed/).count, 10);
});

test('JSON logs: message patterns plus the other JSON fields as columns', () => {
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(JSON.stringify({ '@timestamp': `2026-11-03T10:00:${String(i).padStart(2, '0')}Z`, level: i % 4 ? 'WARN' : 'ERROR', logger_name: 'c.w.Stock', message: `Stock low for sku SKU-${10 + i}: ${i % 5} left`, warehouse: i % 2 ? 'BLR' : 'HYD', ctx: { region: i % 2 ? 'south' : 'west' } }));
  const t = run(lines.join('\n')).tables[0];
  assert.deepStrictEqual(t.columns, ['time', 'level', 'sku', 'left', 'warehouse', 'ctx.region']);
  assert.deepStrictEqual(t.rows[1].values.slice(2), ['SKU-11', '1', 'BLR', 'south']);
});

test('unknown layout with key=value metrics: units go into the column name', () => {
  const lines = [];
  for (let i = 0; i < 12; i++) lines.push(`2026-11-03 10:15:${String(i).padStart(2, '0')} INFO SERVER-0${1 + (i % 3)} CPU_USAGE=${20 + i}% MEM=${1 + i}GB`);
  const t = run(lines.join('\n')).tables[0];
  assert.deepStrictEqual(t.columns, ['time', 'logger', 'CPU_USAGE (%)', 'MEM (GB)']);
  assert.deepStrictEqual(t.rows[0].values, ['2026-11-03 10:15:00', 'SERVER-01', '20', '1']);
});

test('host:port, words after from / to / by, and seconds get sensible names', () => {
  const lines = [];
  for (let i = 0; i < 9; i++) {
    lines.push(`2026-11-03 10:15:0${i} ERROR DB Connection to db-${1 + (i % 3)}.internal:5432 timed out after ${i + 1}s`);
    lines.push(`2026-11-03 10:15:0${i} INFO [main] c.w.Order - Order ORD-${100 + i} moved from ${i % 2 ? 'NEW' : 'PAID'} to ${i % 2 ? 'SHIPPED' : 'CANCELLED'} by ${i % 2 ? 'system' : 'ravi'}`);
  }
  const r = run(lines.join('\n'));
  const db = find(r, /Connection to/);
  assert.strictEqual(db.count, 9, 'all DB hosts in one table');
  assert.deepStrictEqual(db.columns, ['time', 'host', 'seconds']);
  assert.deepStrictEqual(find(r, /moved from/).columns.slice(-4), ['Order', 'from', 'to', 'by']);
});

test('access logs become one request table with a route column', () => {
  const lines = [];
  for (let i = 0; i < 10; i++) lines.push(`10.1.2.${i} - - [03/Nov/2026:10:15:0${i} +0530] "GET /api/orders/${900 + i}?full=1 HTTP/1.1" ${i % 4 ? 200 : 500} ${100 + i} "-" "curl/8.4"`);
  const t = run(lines.join('\n')).tables[0];
  assert.deepStrictEqual(t.columns.slice(0, 7), ['ip', 'time', 'method', 'route', 'path', 'status', 'bytes']);
  assert.ok(col(t, 'route').every((v) => v === '/api/orders/{id}'));
  assert.deepStrictEqual(col(t, 'status').slice(0, 2), ['500', '200']);
});

test('a "changing" part that never changes stays in the pattern text', () => {
  const lines = [];
  for (let i = 0; i < 6; i++) lines.push(`2026-11-03 10:15:0${i} INFO App - Listening on port 8080 for user u${i}`);
  const t = run(lines.join('\n')).tables[0];
  assert.ok(/port 8080/.test(t.template), t.template);
  assert.ok(!t.columns.includes('port'));
});

test('large logs stay quick (100k entries)', () => {
  const lines = [];
  for (let i = 0; i < 100000; i++) lines.push(`2026-11-03 10:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000 ${i % 7 ? 'INFO' : 'WARN'} [exec-${i % 8}] c.e.Svc - order=${i} user=U${i % 50} took ${i % 900}ms`);
  const t0 = Date.now();
  const r = L.autoTables(lines, L.parseEntries(lines).entries);
  const ms = Date.now() - t0;
  assert.strictEqual(r.tables[0].count, 100000);
  assert.ok(ms < 4000, ms + ' ms');
});

console.log(`\n${passed} passed`);
