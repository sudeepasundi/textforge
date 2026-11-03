const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../logs.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   - ' + name); }
  catch (e) { console.error('FAIL - ' + name + '\n' + (e.stack || e.message)); process.exitCode = 1; }
}

const sample = fs.readFileSync(path.join(__dirname, '../samples/order-service.log'), 'utf8');
const lines = sample.split('\n');
const parsed = L.parseEntries(lines);

test('spring boot sample detected as log', () => {
  assert.ok(L.isLogText(sample));
  assert.strictEqual(parsed.format, 'spring');
  assert.strictEqual(parsed.formatLabel, 'Spring Boot');
});

test('stack traces attach to their entry', () => {
  const e = parsed.entries.find((x) => x.message.startsWith('traceId=c3e09f1a7b264d58 Payment'));
  assert.ok(e, 'entry found');
  assert.strictEqual(e.level, 'ERROR');
  assert.strictEqual(e.logger, 'c.e.order.service.PaymentClient');
  assert.strictEqual(e.thread, 'nio-8082-exec-3');
  assert.strictEqual(e.traceId, 'c3e09f1a7b264d58');
  assert.ok(e.hasStack);
  assert.ok(e.end - e.start >= 10, 'continuation lines included');
  assert.strictEqual(parsed.entries.filter((x) => x.fmt === 'none').length, 0);
});

test('level counts', () => {
  const c = L.levelCounts(parsed.entries);
  assert.strictEqual(c.ERROR, 4);
  assert.strictEqual(c.WARN, 3);
  assert.strictEqual(c.DEBUG, 1);
});

test('error grouping finds the repeated NPE and timeout', () => {
  const g = L.groupErrors(parsed.entries, lines, { myPackages: 'com.example' });
  assert.strictEqual(g.length, 2);
  const npe = g.find((x) => x.title === 'NullPointerException');
  assert.strictEqual(npe.count, 2);
  assert.strictEqual(npe.frame, 'com.example.order.service.ShippingService.estimate(ShippingService.java:41)');
  const to = g.find((x) => x.title === 'SocketTimeoutException');
  assert.strictEqual(to.count, 2);
  assert.strictEqual(to.rootCause, 'java.net.SocketTimeoutException');
});

test('filters: level, include, trace, time range', () => {
  const E = parsed.entries;
  let v = L.filterEntries(E, lines, { levels: new Set(['ERROR']) });
  assert.strictEqual(v.reduce((a, b) => a + b, 0), 4);
  v = L.filterEntries(E, lines, { levels: new Set(L.LEVEL_CHIPS), include: /SocketTimeout/ });
  assert.strictEqual(v.reduce((a, b) => a + b, 0), 2);
  v = L.filterEntries(E, lines, { levels: new Set(L.LEVEL_CHIPS), trace: 'f1a2b3c4d5e6f708' });
  assert.strictEqual(v.reduce((a, b) => a + b, 0), 1);
  const from = L.parseTimeInput('10:17', E[0].ts);
  v = L.filterEntries(E, lines, { levels: new Set(L.LEVEL_CHIPS), from });
  assert.strictEqual(v.reduce((a, b) => a + b, 0), 4);
  v = L.filterEntries(E, lines, { levels: new Set(L.LEVEL_CHIPS), logger: 'kafka' });
  assert.strictEqual(v.reduce((a, b) => a + b, 0), 3);
});

test('timeline buckets', () => {
  const t = L.timeline(parsed.entries, 60);
  assert.ok(t && t.buckets.length > 1 && t.buckets.length <= 60);
  assert.strictEqual(t.buckets.reduce((a, b) => a + b.error, 0), 4);
});

test('extract durations with named groups + stats', () => {
  const units = lines.map((t, i) => ({ line: i + 1, text: t }));
  const r = L.extractRegex(units, 'orderId=(?<orderId>\\d+).*?took (?<ms>\\d+)ms', '');
  assert.deepStrictEqual(r.columns, ['orderId', 'ms']);
  assert.ok(r.rows.length >= 5);
  const s = L.numericStats(r.rows.map((x) => x.values[1]));
  assert.ok(s && s.max === 1534);
  assert.ok(L.extractRegex(units, '(', '').error);
  const kv = L.extractKeyValues(units);
  assert.ok(kv.columns.includes('orderId') && kv.columns.includes('traceId'));
  const dur = L.PRESETS.find((p) => p.id === 'durations');
  const d = L.extractRegex(units, dur.regex, dur.flags);
  assert.deepStrictEqual(d.columns, ['method', 'path', 'ms']);
  assert.ok(!d.error && d.rows.some((x) => x.values[1] === '/api/orders' && x.values[2] === '2210'));
  assert.ok(d.rows.some((x) => x.values[0] === '' && x.values[2] === '23'), 'durations without an HTTP call still extracted');
});

test('other formats: JSON, access, logback, syslog', () => {
  const j = L.parseLine('{"@timestamp":"2026-11-02T10:00:00.123Z","level":"WARN","logger_name":"c.e.X","message":"hi","traceId":"abc123def456"}');
  assert.strictEqual(j.fmt, 'json');
  assert.strictEqual(j.level, 'WARN');
  assert.strictEqual(j.traceId, 'abc123def456');
  const a = L.parseLine('10.0.0.5 - - [02/Nov/2026:10:15:30 +0530] "GET /api/orders HTTP/1.1" 503 120');
  assert.strictEqual(a.fmt, 'access');
  assert.strictEqual(a.level, 'ERROR');
  const lb = L.parseLine('2026-11-02 10:15:30,123 [http-nio-8080-exec-1] ERROR com.example.Foo - Boom happened');
  assert.strictEqual(lb.level, 'ERROR');
  assert.strictEqual(lb.thread, 'http-nio-8080-exec-1');
  assert.strictEqual(lb.logger, 'com.example.Foo');
  assert.strictEqual(lb.message, 'Boom happened');
  const sl = L.parseLine('Nov  2 10:15:30 host1 app[123]: ERROR disk full');
  assert.strictEqual(sl.fmt, 'syslog');
  assert.strictEqual(sl.level, 'ERROR');
  const tc = L.parseLine('02-Nov-2026 10:15:30.123 SEVERE [main] org.apache.catalina.Foo.bar Something');
  assert.strictEqual(tc.level, 'ERROR');
});

test('plain prose / code is not a log', () => {
  assert.ok(!L.isLogText('Dear team,\nplease find attached the report.\nThanks'));
  assert.ok(!L.isLogText('public class A {\n  int x = 1;\n}\n'));
});

test('mask secrets', () => {
  const r = L.maskSecrets(sample);
  assert.ok(!r.text.includes('hunter2'));
  assert.ok(!r.text.includes('ravi.k@example.com'));
  assert.ok(!r.text.includes('eyJhbGciOiJIUzI1NiJ9'));
  assert.ok(r.text.includes('Bearer <jwt>'));
  assert.strictEqual(L.maskSecrets('Authorization: Bearer abcdef1234567890').text, 'Authorization: Bearer <redacted>');
  assert.ok(r.text.includes('orderId=90002'), 'normal ids untouched');
  assert.ok(r.count >= 3);
  assert.strictEqual(L.maskSecrets('card 4111 1111 1111 1111 ok').text, 'card <card> ok');
  assert.strictEqual(L.maskSecrets('id 1234567890123 ok').text, 'id 1234567890123 ok');
  assert.strictEqual(L.maskSecrets('pan ABCPK1234F').text, 'pan <pan>');
  assert.strictEqual(L.maskSecrets('"password":"s3cr3t"').text, '"password":"****"');
});

test('merge logs by timestamp', () => {
  const a = '2026-11-02 10:00:01.000 INFO [main] a.B - one\n2026-11-02 10:00:03.000 ERROR [main] a.B - three\n\tat x.Y.z(Y.java:1)';
  const b = '2026-11-02 10:00:02.000 INFO [main] c.D - two';
  const out = L.mergeLogs([{ name: 'svc-a', text: a }, { name: 'svc-b', text: b }]).split('\n');
  assert.deepStrictEqual(out.map((l) => l.slice(0, 7)), ['[svc-a]', '[svc-b]', '[svc-a]', '\tat x.Y']);
  const re = L.parseEntries(out);
  assert.strictEqual(re.entries.length, 3);
  assert.strictEqual(re.entries[2].level, 'ERROR');
});

test('prompt building truncates the middle', () => {
  const p = L.buildPrompt('explain', 'x'.repeat(30000), null, 1000);
  assert.ok(p.length < 1600 && p.includes('characters omitted') && p.startsWith('I am a Java'));
});

test('entryIndexAt binary search', () => {
  const E = parsed.entries;
  const err = E.findIndex((x) => x.hasStack);
  assert.strictEqual(L.entryIndexAt(E, E[err].start + 3), err);
  assert.strictEqual(L.entryIndexAt(E, 0), 0);
});

test('prefixed, epoch and java.util.logging formats parse into entries', () => {
  const k8s = Array.from({ length: 30 }, (_, i) => `[order-service-7d9f8b5c4-x2kq9 app] 2026-11-03 10:00:${String(i).padStart(2, '0')}.000 ${i % 3 ? 'INFO' : 'ERROR'} c.e.S - n=${i}`);
  let p = L.parseEntries(k8s);
  assert.strictEqual(p.entries.length, 30);
  assert.strictEqual(L.levelCounts(p.entries).ERROR, 10);
  const epoch = Array.from({ length: 30 }, (_, i) => `${1793691301000 + i} ${i % 3 ? 'INFO' : 'ERROR'} OrderService n=${i}`);
  p = L.parseEntries(epoch);
  assert.strictEqual(p.entries.length, 30);
  assert.ok(p.entries[1].ts - p.entries[0].ts === 1);
  const jul = [];
  for (let i = 0; i < 10; i++) jul.push(`Nov 03, 2026 10:15:${String(i).padStart(2, '0')} PM com.example.S run`, (i % 2 ? 'INFO' : 'SEVERE') + ': n=' + i);
  p = L.parseEntries(jul);
  assert.strictEqual(p.entries.length, 10);
  assert.strictEqual(L.levelCounts(p.entries).ERROR, 5);
  assert.strictEqual(p.entries[0].end, 1, 'two-line record is one entry');
  assert.strictEqual(new Date(p.entries[0].ts).getUTCHours(), 22, '12-hour clock');
});

test('unknown layout falls back to one entry per line (filter still works)', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `node-${i % 4} | ${i % 4 === 0 ? 'ERROR' : 'INFO'} | something happened ${i}`);
  lines.splice(5, 0, '    at com.example.X.y(X.java:1)');
  const p = L.parseEntries(lines);
  assert.ok(p.entries.length >= 40, 'not one giant entry: ' + p.entries.length);
  const vis = L.filterEntries(p.entries, lines, { levels: new Set(['ERROR']) });
  assert.strictEqual(vis.reduce((a, b) => a + b, 0), 10);
  assert.ok(L.isLogText(lines.join('\n')));
});

console.log(`\n${passed} passed`);
