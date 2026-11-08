// Incident (0.16.0): several logs on one clock, and the findings TextForge spots by itself.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../logs.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   - ' + name); }
  catch (e) { console.error('FAIL - ' + name + '\n' + (e.stack || e.message)); process.exitCode = 1; }
}
const source = (name, text) => { const lines = text.split('\n'); return { name, lines, entries: L.parseEntries(lines).entries }; };
const sample = (n) => source(n + '.log', fs.readFileSync(path.join(__dirname, '../samples', n + '.log'), 'utf8'));
const SAMPLES = ['api-gateway', 'order-service', 'payment-service', 'inventory-service'];
const inc = () => L.incident(SAMPLES.map(sample));

test('Each log becomes a named service on one shared clock', () => {
  const r = inc();
  assert.deepStrictEqual(r.services.map((s) => s.name), SAMPLES);
  assert.strictEqual(L.formatTs(r.min), '10:15:00');
  assert.strictEqual(L.formatTs(r.max), '10:18:12');
});

test('Service name comes from the log, else from the file name', () => {
  assert.strictEqual(L.serviceName(source('x.log', '2026-11-02T10:15:00.402+05:30  INFO 1 --- [billing] [main] c.e.App : started')), 'billing');
  assert.strictEqual(L.serviceName(source('checkout.log', '2026-11-02 10:15:00 INFO started')), 'checkout');
});

test('Two files of the same service stay apart', () => {
  const a = sample('order-service');
  const b = Object.assign({}, sample('order-service'), { name: 'order-service-2.log' });
  const r = L.incident([a, b]);
  assert.notStrictEqual(r.services[0].name, r.services[1].name);
});

test('Errors in several services at the same moment are one finding, listed first', () => {
  const r = inc();
  const t = r.findings.filter((f) => f.kind === 'together');
  assert.strictEqual(t.length, 2);
  assert.strictEqual(r.findings[0].kind, 'together');
  assert.deepStrictEqual(t[0].services, ['payment-service', 'order-service']);
  assert.strictEqual(t[0].refs.length, 2);
});

test('Repeated errors are grouped per service and titled with the real message (no trace ID)', () => {
  const r = inc();
  const pay = r.findings.find((f) => f.kind === 'error' && f.services[0] === 'payment-service' && f.count === 2);
  assert.ok(pay, 'payment timeouts');
  assert.ok(/^Read timed out after 1500 ms/.test(pay.title), pay.title);
  assert.ok(/SocketTimeoutException/.test(pay.detail), pay.detail);
  assert.ok(!r.findings.some((f) => /traceId=|<hex>/.test(f.title)), 'no raw pattern text in titles');
});

test('A service that goes quiet while others report errors calling it is found; an idle one is not', () => {
  const r = inc();
  const q = r.findings.filter((f) => f.kind === 'quiet');
  assert.strictEqual(q.length, 1, q.map((f) => f.title).join(' | '));
  assert.ok(/^payment-service went quiet for 47\.6 s/.test(q[0].title), q[0].title);
  assert.strictEqual(L.formatTs(q[0].from), '10:16:41');
});

test('Slow calls: "took" with ms or s, "in" only with ms', () => {
  assert.strictEqual(L.durationMs('took 1534ms'), 1534);
  assert.strictEqual(L.durationMs('took: 2.1 s'), 2100);
  assert.strictEqual(L.durationMs('POST /api/orders 502 in 1560ms'), 1560);
  assert.strictEqual(L.durationMs('OPEN after 4 failures in 60s'), null);
  const r = inc();
  const gw = r.findings.find((f) => f.kind === 'slow' && f.services[0] === 'api-gateway');
  assert.strictEqual(gw.count, 3);
  assert.ok(/Slowest 2\.2 s/.test(gw.detail), gw.detail);
});

test('Lanes: each service spread over equal slices of the time span', () => {
  const r = inc();
  const b = L.incidentBuckets(r.services[2], r.min, r.max, 60);
  assert.strictEqual(b.length, 60);
  assert.strictEqual(b.reduce((a, x) => a + x.total, 0), r.services[2].entries.filter((e) => e.ts != null).length);
  assert.strictEqual(b.reduce((a, x) => a + x.error, 0), 3);
});

test('Big incidents stay quick (4 logs x 50k entries)', () => {
  const big = SAMPLES.map((n, k) => {
    const lines = [];
    for (let i = 0; i < 50000; i++) {
      const s = 10 + Math.floor(i / 1000);
      lines.push(`2026-11-02T${String(s).padStart(2, '0')}:${String(Math.floor(i / 20) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000+05:30 ${i % 97 ? 'INFO' : 'ERROR'} 1 --- [${n}] [main] c.e.X : request ${i} took ${i % 1500}ms`);
    }
    return { name: n + '.log', lines, entries: L.parseEntries(lines).entries };
  });
  const t0 = Date.now();
  const r = L.incident(big);
  const ms = Date.now() - t0;
  assert.strictEqual(r.services.length, 4);
  assert.ok(ms < 5000, ms + ' ms');
});

console.log(`\n${passed} passed`);
