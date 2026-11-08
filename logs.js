/* Log analysis engine. Pure functions, usable in the browser (window.Logs) and in Node tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Logs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const LEVEL_CHIPS = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE', 'OTHER'];
  const LEVEL_RE = /\b(FATAL|CRITICAL|SEVERE|ERROR|WARNING|WARN|NOTICE|INFO|DEBUG|FINEST|FINER|FINE|TRACE)\b/;
  const EXC_RE = /((?:[a-zA-Z_$][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error|Throwable|Fault))\b/;
  const FRAME_RE = /^\s+at\s+([\w$.<>/]+)\(([^)]*)\)/;
  const FRAME_ANY_RE = /\s-?\s+at\s+([\w$.<>/]+)\(([^)]*)\)\s*$/; // frame logged with a log prefix
  const STACK_LINE_RE = /^\s+at\s|^\s*Caused by:|^\s*\.\.\. \d+ (more|common frames omitted)|^\s*Suppressed:/;
  const STACK_MSG_RE = /^(at\s+[\w$.<>/]+\(|Caused by:|\.\.\. \d+ (more|common frames omitted)|Suppressed:)/;
  const JUL_LEVEL_RE = /^(SEVERE|WARNING|INFO|CONFIG|FINE|FINER|FINEST):\s?(.*)$/;
  const EXC_START_RE = /^(?:[a-zA-Z_$][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error|Throwable)\b/;
  const FORMAT_LABELS = {
    spring: 'Spring Boot',
    json: 'JSON (structured)',
    access: 'HTTP access log',
    syslog: 'Syslog',
    generic: 'Log4j / Logback',
  };

  function normLevel(s) {
    if (s == null) return null;
    const u = String(s).toUpperCase();
    if (u === 'FATAL' || u === 'CRITICAL' || u === 'SEVERE' || u === 'ERROR' || u === 'ERR' || u === 'ALERT' || u === 'EMERG') return 'ERROR';
    if (u === 'WARN' || u === 'WARNING') return 'WARN';
    if (u === 'INFO' || u === 'NOTICE' || u === 'INFORMATION') return 'INFO';
    if (u === 'DEBUG' || u === 'FINE' || u === 'CONFIG') return 'DEBUG';
    if (u === 'TRACE' || u === 'FINER' || u === 'FINEST' || u === 'VERBOSE') return 'TRACE';
    return null;
  }

  // ---------------- timestamps ----------------
  // Timestamps are compared "as written" (wall-clock); time-zone offsets are ignored on purpose so
  // that filter inputs like "10:15" match what the developer sees in the file.
  function mk(y, mo, d, h, mi, s, frac) {
    const ms = Date.UTC(y, mo, d, +h, +mi, +s, frac ? Math.floor(+('0.' + frac) * 1000) : 0);
    return Number.isNaN(ms) ? null : ms;
  }
  const mon = (s) => MONTHS[String(s).slice(0, 3).toLowerCase()];

  const TS_PATTERNS = [
    { id: 'iso', re: /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?(?:\s?(?:Z|[+-]\d{2}:?\d{2}))?/,
      f: (m) => mk(+m[1], +m[2] - 1, +m[3], m[4], m[5], m[6], m[7]) },
    { id: 'slash', re: /(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?/,
      f: (m) => mk(+m[1], +m[2] - 1, +m[3], m[4], m[5], m[6], m[7]) },
    { id: 'access', re: /(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:\s[+-]\d{4})?/,
      f: (m) => (mon(m[2]) == null ? null : mk(+m[3], mon(m[2]), +m[1], m[4], m[5], m[6])) },
    { id: 'tomcat', re: /(\d{2})-([A-Za-z]{3})-(\d{4})\s(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?/,
      f: (m) => (mon(m[2]) == null ? null : mk(+m[3], mon(m[2]), +m[1], m[4], m[5], m[6], m[7])) },
    { id: 'dmy', re: /(\d{2})[-/.](\d{2})[-/.](\d{4})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?/,
      f: (m) => mk(+m[3], +m[2] - 1, +m[1], m[4], m[5], m[6], m[7]) },
    { id: 'jul', re: /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)\b/,
      f: (m) => mk(+m[3], mon(m[1]), +m[2], (+m[4] % 12) + (m[7] === 'PM' ? 12 : 0), m[5], m[6]) },
    { id: 'epoch', re: /^\[?(1[5-9]\d{11}|1[5-9]\d{8})(?:\.(\d{1,6}))?\b(?![-:.\d])/,
      f: (m) => { const v = m[1].length === 13 ? +m[1] : +m[1] * 1000 + (m[2] ? Math.floor(+('0.' + m[2]) * 1000) : 0); const d = new Date(v); return mk(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), String(d.getMilliseconds()).padStart(3, '0')); } },
    { id: 'syslog', re: /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s(\d{2}):(\d{2}):(\d{2})\b/,
      f: (m) => mk(2000, mon(m[1]), +m[2], m[3], m[4], m[5]) },
    { id: 'time', re: /^\[?(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,6}))?\b/,
      f: (m) => mk(1970, 0, 1, m[1], m[2], m[3], m[4]) },
  ];
  let lastPattern = 0;

  function findTimestamp(line) {
    const head = line.length > 120 ? line.slice(0, 120) : line;
    for (let k = 0; k < TS_PATTERNS.length; k++) {
      const idx = (k + lastPattern) % TS_PATTERNS.length;
      const p = TS_PATTERNS[idx];
      const m = p.re.exec(head);
      if (m && m.index <= 64) { // allows prefixes such as "[order-service-7d9f8b5c4-x2kq9 app] " (Kubernetes)
        const ms = p.f(m);
        if (ms == null) continue;
        lastPattern = idx;
        return { ms, index: m.index, end: m.index + m[0].length, text: m[0], pattern: p.id };
      }
    }
    return null;
  }

  // "10:15", "10:15:30", "2026-11-02 10:15:30" -> ms. Time-only input uses the day of refMs.
  function parseTimeInput(str, refMs) {
    const s = String(str || '').trim();
    if (!s) return null;
    const full = findTimestamp(s);
    if (full && full.pattern !== 'time') return full.ms;
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3}))?)?$/.exec(s);
    if (!m) return null;
    const day = refMs != null ? Math.floor(refMs / 86400000) * 86400000 : 0;
    return day + ((+m[1] * 60 + +m[2]) * 60 + +(m[3] || 0)) * 1000 + (m[4] ? Math.floor(+('0.' + m[4]) * 1000) : 0);
  }

  // ---------------- trace / correlation ids ----------------
  const TRACE_PATTERNS = [
    /\[[\w.-]*,([0-9a-fA-F]{16,32}),[0-9a-fA-F]{8,16}(?:,\w+)?\]/, // Sleuth / Micrometer [app,trace,span]
    /\b(?:trace[_-]?id|x-b3-traceid|correlation[_-]?id|request[_-]?id|x-request-id)["']?\s*[:=]\s*["']?([\w-]{8,64})/i,
    /\[([0-9a-f]{32})-[0-9a-f]{16}\]/, // Boot 3.4 [traceId-spanId]
  ];
  function findTraceId(line) {
    for (const re of TRACE_PATTERNS) {
      const m = re.exec(line);
      if (m) return m[1];
    }
    return null;
  }

  // ---------------- line parsing ----------------
  function pick(obj, keys) {
    for (const k of keys) {
      if (obj[k] != null && obj[k] !== '') return obj[k];
      if (k.includes('.')) {
        let v = obj;
        for (const part of k.split('.')) { v = v && typeof v === 'object' ? v[part] : undefined; }
        if (v != null && v !== '') return v;
      }
    }
    return null;
  }

  function fromJson(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const rawTs = pick(obj, ['@timestamp', 'timestamp', 'time', 'ts', 'datetime', 'date', 'log.time']);
    let ts = null;
    let tsText = null;
    if (typeof rawTs === 'number') {
      ts = rawTs > 1e12 ? rawTs : rawTs * 1000;
      tsText = String(rawTs);
    } else if (typeof rawTs === 'string') {
      const f = findTimestamp(rawTs);
      ts = f ? f.ms : null;
      tsText = rawTs;
    }
    const level = normLevel(pick(obj, ['level', 'log.level', 'severity', 'levelname', 'loglevel', 'lvl']));
    const message = pick(obj, ['message', 'msg', 'log', 'text']);
    if (ts == null && level == null && message == null) return null;
    const stack = pick(obj, ['stack_trace', 'stackTrace', 'error.stack_trace', 'exception', 'stack']);
    return {
      fmt: 'json',
      ts,
      tsText,
      level,
      logger: pick(obj, ['logger_name', 'logger', 'log.logger', 'loggerName']),
      thread: pick(obj, ['thread_name', 'thread', 'process.thread.name']),
      message: message == null ? '' : typeof message === 'string' ? message : JSON.stringify(message),
      traceId: pick(obj, ['traceId', 'trace_id', 'trace.id', 'traceid', 'correlationId', 'requestId']),
      hasStack: !!stack,
    };
  }

  const SPRING_RE = /^\s+(FATAL|ERROR|WARN|INFO|DEBUG|TRACE)\s+(\d+)\s+---\s+(?:\[([^\]]*)\]\s+)?\[\s*([^\]]*?)\s*\]\s+(?:\[([^\]]*)\]\s+)?([\w.$/-]+)\s*:\s?(.*)$/;
  const ACCESS_RE = /"(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT|TRACE) ([^ "]+)[^"]*" (\d{3})\b/;
  const LOGGER_RE = /(?:^|\s)((?:[a-zA-Z_$][\w$]*\.)+[A-Za-z_$][\w$]*)(?=\s|:|$)/;

  function parseLine(line) {
    if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1); // Windows line endings (CRLF)
    const trimmed = line.trimStart();
    if (trimmed[0] === '{' && line.length < 200000) {
      try {
        const j = fromJson(JSON.parse(trimmed));
        if (j) return j;
      } catch { /* not JSON */ }
    }
    if (STACK_LINE_RE.test(line)) return null;

    const ts = findTimestamp(line);
    if (!ts) {
      const lm = /^\s*\[?(FATAL|CRITICAL|SEVERE|ERROR|WARNING|WARN|NOTICE|INFO|DEBUG|TRACE)\]?[\s:]/.exec(line);
      if (!lm) return null;
      const rest = line.slice(lm.index + lm[0].length);
      return { fmt: 'generic', ts: null, tsText: null, level: normLevel(lm[1]), logger: null, thread: null,
        message: rest.trim(), traceId: findTraceId(line) };
    }

    const after = line.slice(ts.end);
    const base = { ts: ts.ms, tsText: ts.text, traceId: findTraceId(line) };

    const sb = SPRING_RE.exec(after);
    if (sb) {
      return Object.assign(base, { fmt: 'spring', level: normLevel(sb[1]), thread: sb[4], logger: sb[6], message: sb[7],
        app: sb[3] || null });
    }

    if (ts.pattern === 'access') {
      const a = ACCESS_RE.exec(line);
      if (a) {
        const st = +a[3];
        return Object.assign(base, { fmt: 'access', level: st >= 500 ? 'ERROR' : st >= 400 ? 'WARN' : 'INFO',
          logger: null, thread: null, message: a[1] + ' ' + a[2] + ' ' + a[3], status: st });
      }
    }

    const head = after.slice(0, 160);
    const lm = LEVEL_RE.exec(head);
    const level = lm ? normLevel(lm[1]) : null;
    let thread = null;
    const brRe = /\[([^\]]{1,80})\]/g;
    let br;
    while ((br = brRe.exec(head))) {
      if (!normLevel(br[1].trim())) { thread = br[1].trim(); break; }
    }
    let logger = null;
    let message = after.trim();
    const fromIdx = lm ? lm.index + lm[0].length : 0;
    const tail = after.slice(fromIdx);
    const lg = LOGGER_RE.exec(tail.slice(0, 200));
    if (lg) {
      logger = lg[1];
      const rest = tail.slice(lg.index + lg[0].length);
      const sep = /^\s*(?:-|:)\s?/.exec(rest);
      message = (sep ? rest.slice(sep[0].length) : rest).trim();
    } else if (lm) {
      message = tail.replace(/^[\]\s:-]+/, '').trim();
      // "INFO SERVER-01 CPU_USAGE=32%" / "WARN AUTH User=..." : an upper-case source name right after the level
      const src = /^([A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)*)\s+(.*)$/.exec(message);
      if (src && src[1].length >= 3 && !normLevel(src[1]) && !/=/.test(src[1])) { logger = src[1]; message = src[2]; }
    }
    if (level == null && ts.pattern === 'time' && message.length === 0) return null;
    return Object.assign(base, { fmt: ts.pattern === 'syslog' ? 'syslog' : 'generic', level, thread, logger, message });
  }

  // ---------------- entries ----------------
  // An entry is a header line plus its continuation lines (stack traces, multi-line messages).
  function parseEntries(lines) {
    const entries = [];
    const fmtCount = {};
    let cur = null;
    let headers = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let h = line.trim() === '' ? null : parseLine(line);
      // Some apps log every stack-trace line through the logger ("ERROR ... -     at com.x.Y(Y.java:1)").
      // Such lines, and an exception line logged right after an error on the same thread, belong to that error.
      if (h && cur && cur.level === 'ERROR' && h.level === 'ERROR' && (h.thread || null) === (cur.thread || null) &&
          (STACK_MSG_RE.test(h.message || '') ||
           (EXC_START_RE.test(h.message || '') && h.ts != null && cur.ts != null && Math.abs(h.ts - cur.ts) <= 20 && !cur.hasStack))) {
        h = null;
        cur.end = i;
        cur.hasStack = true;
        continue;
      }
      // java.util.logging: "Nov 03, 2026 10:15:06 AM com.x.Y method" then "SEVERE: message" on the next line
      if (h && cur && cur.level == null && i === cur.end + 1 && cur.end === cur.start && h.ts == null && JUL_LEVEL_RE.test(line)) {
        const jm = JUL_LEVEL_RE.exec(line);
        cur.level = normLevel(jm[1]);
        cur.message = jm[2];
        cur.end = i;
        continue;
      }
      if (h) {
        cur = h;
        cur.start = i;
        cur.end = i;
        entries.push(cur);
        headers++;
        fmtCount[h.fmt] = (fmtCount[h.fmt] || 0) + 1;
      } else if (cur) {
        cur.end = i;
        if (!cur.hasStack && STACK_LINE_RE.test(line)) cur.hasStack = true;
      } else {
        cur = { fmt: 'none', ts: null, tsText: null, level: null, logger: null, thread: null, message: line, traceId: null, start: i, end: i };
        entries.push(cur);
      }
    }
    // Safety net: when hardly any line starts an entry (a format we don't know), filtering would see the
    // whole file as one block and hide nothing. Fall back to one entry per line (indented lines and stack
    // frames still join the line above), with the level taken from the first level word on the line.
    const nonEmpty = lines.length > 2000 ? 2000 : lines.length;
    let sampleNon = 0;
    for (let i = 0; i < nonEmpty; i++) if (lines[i].trim()) sampleNon++;
    if (sampleNon >= 20 && headers < Math.max(2, (entries.length ? entries.length : 0)) && headers < lines.length * 0.05) {
      return lineEntries(lines);
    }
    // trailing blank lines at the end of the file belong to no entry
    const lastE = entries[entries.length - 1];
    if (lastE) { while (lastE.end > lastE.start && lines[lastE.end].trim() === '') lastE.end--; }
    let format = null;
    let best = 0;
    for (const k in fmtCount) if (fmtCount[k] > best) { best = fmtCount[k]; format = k; }
    return { entries, format, formatLabel: format ? FORMAT_LABELS[format] || 'Log' : null, headers };
  }

  function lineEntries(lines) {
    const entries = [];
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (cur && (line.trim() === '' || /^\s/.test(line) || STACK_LINE_RE.test(line))) {
        cur.end = i;
        if (STACK_LINE_RE.test(line)) cur.hasStack = true;
        continue;
      }
      const lm = LEVEL_RE.exec(line.slice(0, 200));
      const ts = findTimestamp(line);
      cur = { fmt: 'lines', ts: ts ? ts.ms : null, tsText: ts ? ts.text : null, level: lm ? normLevel(lm[1]) : null, logger: null, thread: null,
        message: line.trim(), traceId: findTraceId(line), start: i, end: i };
      entries.push(cur);
    }
    const lastE = entries[entries.length - 1];
    if (lastE) { while (lastE.end > lastE.start && lines[lastE.end].trim() === '') lastE.end--; }
    return { entries, format: 'lines', formatLabel: 'Line-based log', headers: entries.length };
  }

  function isLogText(text) {
    if (!text) return false;
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 300);
    if (lines.length < 2) return false;
    let headers = 0;
    let stack = 0;
    let leveled = 0;
    for (const l of lines) {
      const h = parseLine(l);
      if (h) { headers++; if (h.level) leveled++; }
      else if (STACK_LINE_RE.test(l)) stack++;
    }
    if (headers >= 2 && (headers + stack) / lines.length >= 0.5 && (leveled > 0 || headers / lines.length >= 0.6)) return true;
    // unknown layout, but most lines carry a level word (INFO / WARN / ERROR ...)
    const withLevel = lines.filter((l) => LEVEL_RE.test(l.slice(0, 200))).length;
    if (lines.length >= 3 && withLevel / lines.length >= 0.6) return true;
    return headers >= 1 && stack >= 3;
  }

  function entryIndexAt(entries, line) {
    let lo = 0;
    let hi = entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].end < line) lo = mid + 1;
      else if (entries[mid].start > line) hi = mid - 1;
      else return mid;
    }
    return -1;
  }

  function chipOf(level) {
    return level || 'OTHER';
  }

  function levelCounts(entries) {
    const c = { ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0, TRACE: 0, OTHER: 0 };
    for (const e of entries) c[chipOf(e.level)]++;
    return c;
  }

  function entryText(lines, e, maxLines = 200) {
    return lines.slice(e.start, Math.min(e.end, e.start + maxLines) + 1).join('\n');
  }

  // filter: { levels:Set, include:RegExp, exclude:RegExp, logger:string, trace:string, from:ms, to:ms }
  function filterEntries(entries, lines, f) {
    const vis = new Uint8Array(entries.length);
    const logger = f.logger ? f.logger.toLowerCase() : '';
    const needText = f.include || f.exclude || (Array.isArray(f.trace) ? f.trace.length : f.trace);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (f.levels && !f.levels.has(chipOf(e.level))) continue;
      if (e.ts != null && f.from != null && e.ts < f.from) continue;
      if (e.ts != null && f.to != null && e.ts > f.to) continue;
      if (logger && !((e.logger || '') + ' ' + (e.thread || '')).toLowerCase().includes(logger)) continue;
      if (needText) {
        const t = entryText(lines, e);
        // include: one RegExp, or a list (all must match); exclude: any match hides; trace: any of the IDs
        if (f.include && (Array.isArray(f.include) ? !f.include.every((r) => r.test(t)) : !f.include.test(t))) continue;
        if (f.exclude && f.exclude.test(t)) continue;
        if (f.trace && (Array.isArray(f.trace) ? !f.trace.some((x) => t.includes(x)) : !t.includes(f.trace))) continue;
      }
      vis[i] = 1;
    }
    return vis;
  }

  // ---------------- error grouping ----------------
  function normalizeMsg(s) {
    return String(s || '')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
      .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
      .replace(/"[^"]*"/g, '"…"')
      .replace(/'[^']*'/g, "'…'")
      .replace(/\d+/g, '#')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
  }

  function packagesRegex(myPackages) {
    const list = (myPackages || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!list.length) return null;
    return new RegExp('^(?:' + list.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')');
  }

  function groupErrors(entries, lines, opts = {}) {
    const levels = opts.levels || ['ERROR'];
    const pkgRe = packagesRegex(opts.myPackages);
    const map = new Map();
    entries.forEach((e, idx) => {
      if (!levels.includes(e.level)) return;
      let exc = null;
      let root = null;
      let frame = null;
      const last = Math.min(e.end, e.start + 120);
      for (let i = e.start; i <= last; i++) {
        const l = lines[i];
        const m = EXC_RE.exec(l);
        if (m) {
          if (!exc) exc = m[1];
          if (/^\s*Caused by:/.test(l)) root = m[1];
        }
        if (!frame && pkgRe) {
          const fm = FRAME_RE.exec(l) || FRAME_ANY_RE.exec(l);
          if (fm && pkgRe.test(fm[1])) frame = fm[1] + '(' + fm[2] + ')';
        }
      }
      const cause = root || exc;
      const norm = normalizeMsg(e.message || lines[e.start]);
      const key = e.level + '|' + (cause ? cause + '@' + (frame || norm) : norm);
      let g = map.get(key);
      if (!g) {
        const simple = cause ? cause.split('.').pop() : null;
        g = { key, level: e.level, title: simple || norm || '(empty message)', exception: exc, rootCause: root,
          frame, sample: (e.message || lines[e.start]).trim().slice(0, 300), count: 0, entries: [], firstTs: e.ts, lastTs: e.ts };
        map.set(key, g);
      }
      g.count++;
      if (g.entries.length < 5000) g.entries.push(idx);
      if (e.ts != null) {
        if (g.firstTs == null || e.ts < g.firstTs) g.firstTs = e.ts;
        if (g.lastTs == null || e.ts > g.lastTs) g.lastTs = e.ts;
      }
    });
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }

  // ---------------- duplicates ----------------
  // Identical messages (timestamp / thread ignored). Returns [{text, level, count, first, last}] for count >= 2.
  function findDuplicates(entries, lines, isLog) {
    const map = new Map();
    const add = (key, text, level, line) => {
      let g = map.get(key);
      if (!g) { g = { text, level, count: 0, first: line, last: line }; map.set(key, g); }
      g.count++;
      g.last = line;
    };
    if (isLog) {
      for (const e of entries) {
        const msg = ((e.logger ? e.logger + ' ' : '') + (e.message || lines[e.start])).trim();
        if (msg) add((e.level || '') + '|' + msg, msg, e.level || '', e.start + 1);
      }
    } else {
      lines.forEach((l, i) => { if (l.trim()) add(l, l, '', i + 1); });
    }
    return Array.from(map.values()).filter((g) => g.count > 1).sort((a, b) => b.count - a.count || a.first - b.first);
  }

  function countBy(values) {
    const m = new Map();
    for (const v of values) m.set(v, (m.get(v) || 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  }

  // ---------------- timeline ----------------
  const BUCKET_SIZES = [1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5, 216e5, 432e5, 864e5, 6048e5];
  function timeline(entries, maxBuckets = 60, vis) {
    let min = Infinity;
    let max = -Infinity;
    let n = 0;
    entries.forEach((e, i) => {
      if (e.ts == null || (vis && !vis[i])) return;
      n++;
      if (e.ts < min) min = e.ts;
      if (e.ts > max) max = e.ts;
    });
    if (n < 2 || max === min) return null;
    const span = max - min;
    const size = BUCKET_SIZES.find((s) => span / s < maxBuckets) || Math.ceil(span / maxBuckets);
    const base = Math.floor(min / size) * size;
    const count = Math.floor((max - base) / size) + 1;
    const buckets = Array.from({ length: count }, (_, i) => ({ start: base + i * size, total: 0, error: 0, warn: 0, first: -1 }));
    entries.forEach((e, i) => {
      if (e.ts == null || (vis && !vis[i])) return;
      const b = buckets[Math.floor((e.ts - base) / size)];
      b.total++;
      if (e.level === 'ERROR') b.error++;
      else if (e.level === 'WARN') b.warn++;
      if (b.first < 0) b.first = i;
    });
    return { base, size, min, max, buckets };
  }

  function formatDuration(ms) {
    if (ms < 1000) return ms + ' ms';
    if (ms < 60000) return Math.round(ms / 100) / 10 + ' s';
    if (ms < 3600000) return Math.round(ms / 6000) / 10 + ' min';
    if (ms < 86400000) return Math.round(ms / 360000) / 10 + ' h';
    return Math.round(ms / 8640000) / 10 + ' d';
  }

  function formatTs(ms, withDate) {
    if (ms == null) return '';
    const d = new Date(ms);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    const t = p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
    if (!withDate || d.getUTCFullYear() <= 1970) return t;
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + t;
  }

  // ---------------- extraction ----------------
  function groupInfo(source) {
    const names = [];
    const re = /\(\?<([A-Za-z_][\w]*)>/g;
    let m;
    while ((m = re.exec(source))) names.push(m[1]);
    let groups = 0;
    try { groups = new RegExp(source + '|').exec('').length - 1; } catch { /* invalid */ }
    return { names, groups };
  }

  // units: [{line (1-based), text}]
  function extractRegex(units, source, flags) {
    let re;
    try {
      re = new RegExp(source, (flags || '').replace(/g/g, '') + 'g');
    } catch (e) {
      return { error: e.message };
    }
    const { names, groups } = groupInfo(source);
    const columns = names.length ? names : groups ? Array.from({ length: groups }, (_, i) => 'group' + (i + 1)) : ['match'];
    const rows = [];
    let truncated = false;
    outer: for (const u of units) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(u.text))) {
        if (m[0] === '') { re.lastIndex++; if (re.lastIndex > u.text.length) break; continue; }
        const values = names.length ? names.map((n) => m.groups[n] ?? '')
          : groups ? m.slice(1).map((v) => v ?? '') : [m[0]];
        rows.push({ line: u.line, values });
        if (rows.length >= 200000) { truncated = true; break outer; }
      }
    }
    return { columns, rows, truncated };
  }

  const KV_RE = /(?:^|[\s,;{(\[])([A-Za-z_][\w.-]{0,40})=("[^"]*"|'[^']*'|[^\s,;&)\]}]+)/g;
  function extractKeyValues(units, maxColumns = 25) {
    const freq = new Map();
    const parsed = [];
    for (const u of units) {
      const map = {};
      let m;
      KV_RE.lastIndex = 0;
      let any = false;
      while ((m = KV_RE.exec(u.text))) {
        const k = m[1];
        if (map[k] !== undefined) continue;
        map[k] = m[2].replace(/^["']|["']$/g, '');
        freq.set(k, (freq.get(k) || 0) + 1);
        any = true;
      }
      if (any) parsed.push({ line: u.line, map });
    }
    const keep = new Set(Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, maxColumns).map((x) => x[0]));
    const columns = Array.from(freq.keys()).filter((k) => keep.has(k));
    const rows = parsed.map((p) => ({ line: p.line, values: columns.map((c) => p.map[c] ?? '') }));
    return { columns, rows, truncated: false };
  }

  function extractJsonFields(units, fields) {
    const cols = fields.map((f) => f.trim()).filter(Boolean);
    const rows = [];
    for (const u of units) {
      const t = u.text.trim();
      if (t[0] !== '{') continue;
      let obj;
      try { obj = JSON.parse(t); } catch { continue; }
      const values = cols.map((c) => {
        const v = pick(obj, [c]);
        return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      });
      if (values.some((v) => v !== '')) rows.push({ line: u.line, values });
    }
    return { columns: cols, rows, truncated: false };
  }

  function numericStats(values) {
    const nums = [];
    for (const v of values) {
      const s = String(v).trim();
      if (!/^-?\d+(\.\d+)?\s*(ms|s|sec|%|kb|mb|b)?$/i.test(s)) continue;
      nums.push(parseFloat(s));
    }
    if (nums.length < 2 || nums.length < values.length * 0.6) return null;
    nums.sort((a, b) => a - b);
    const n = nums.length;
    const q = (p) => nums[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];
    const sum = nums.reduce((a, b) => a + b, 0);
    const r = (x) => Math.round(x * 100) / 100;
    return { count: n, min: nums[0], max: nums[n - 1], avg: r(sum / n), p50: q(0.5), p95: q(0.95), p99: q(0.99), sum: r(sum) };
  }

  const PRESETS = [
    { id: 'auto', label: 'Auto-detect tables (adapts to this log)', special: 'auto' },
    { id: 'durations', label: 'Response times (took 123ms)', regex: '(?:\\b(?<method>GET|POST|PUT|DELETE|PATCH)\\s+(?<path>/[^\\s?]*)[^\\n]*?)?\\b(?:took|duration|elapsed|timeTaken|time)[=:\\s]+(?<ms>\\d+(?:\\.\\d+)?)\\s?ms', flags: 'i' },
    { id: 'http', label: 'HTTP method, path, status', regex: '\\b(?<method>GET|POST|PUT|DELETE|PATCH)\\s+(?<path>/[^\\s"?]*)(?:[^\\n]*?\\s(?<status>[1-5]\\d\\d)\\b)?', flags: '' },
    { id: 'exceptions', label: 'Exceptions (class + message)', regex: '(?<exception>(?:[a-zA-Z_$][\\w$]*\\.)+[A-Z][\\w$]*(?:Exception|Error))(?::\\s*(?<message>.*))?', flags: '' },
    { id: 'traces', label: 'Trace / request IDs', regex: '(?:trace[_-]?id|request[_-]?id|correlation[_-]?id)["\']?\\s*[:=]\\s*["\']?(?<id>[\\w-]{8,64})', flags: 'i' },
    { id: 'sql', label: 'SQL statements', regex: '(?<sql>\\b(?:select|insert|update|delete)\\b[\\s\\S]*?)(?:$|;)', flags: 'i' },
    { id: 'kafka', label: 'Kafka topic / partition / offset', regex: '(?:topic[=: ]+(?<topic>[\\w.-]+))[^\\n]*?(?:partition[=: ]+(?<partition>\\d+))?[^\\n]*?(?:offset[=: ]+(?<offset>\\d+))?', flags: 'i' },
    { id: 'ids', label: 'IDs (orderId=, userId=, …)', regex: '\\b(?<field>\\w*[iI]d)[=:]\\s*["\']?(?<value>[\\w-]+)', flags: '' },
    { id: 'timestamps', label: 'Timestamps', regex: '(?<timestamp>\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?)', flags: '' },
    { id: 'ips', label: 'IP addresses', regex: '(?<ip>\\b(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\b)', flags: '' },
    { id: 'kv', label: 'All key=value pairs → columns', special: 'kv' },
    { id: 'json', label: 'JSON log fields', special: 'json' },
    { id: 'custom', label: 'Custom regex', regex: '', flags: '' },
  ];

  // ---------------- automatic tables ----------------
  // Learns the message templates in a log by itself (no patterns to pick) and turns every recurring
  // template into a table: the parts that change between lines become columns, named from the words
  // around them ("took 84ms" -> "took (ms)", "orderId=90001" -> "orderId", "for user alice" -> "user").
  // Similar templates are merged the way log-mining tools such as Drain do it, so
  // "Payment succeeded for order 1" and "Payment failed for order 2" become one table with a column
  // for succeeded / failed.
  const AT_STOP = new Set(['for', 'in', 'of', 'to', 'the', 'a', 'an', 'with', 'from', 'at', 'by', 'on', 'as', 'is', 'was', 'are', 'were', 'after', 'using', 'via', 'and', 'or', 'into', 'than', 'be', 'has', 'have', 'had', 'not']);
  const AT_UNITS = /^(ms|millis|milliseconds|s|sec|secs|seconds|min|mins|minutes|h|hrs|hours|bytes|b|kb|mb|gb|kib|mib|gib|items|rows|records|messages|msgs|events|attempts|retries|times|requests|req|connections|threads|tasks|users|orders|%)$/i;
  const AT_NUM_UNIT = /^(-?\d+(?:\.\d+)?)(ms|millis|s|sec|secs|m|min|h|kb|mb|gb|b|bytes|%)$/i;
  const AT_TOKEN_RE = /[^\s"]*"[^"\n]*"[^\s"]*|\S+/g;
  const AT_MAX_TOKENS = 48;

  function atKind(core) {
    if (!core) return null;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(core)) return 'uuid';
    if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(core)) return 'ip';
    if (/^[a-z][\w+.-]*:\/\/\S+$/i.test(core)) return 'url';
    if (/^[A-Za-z0-9][\w-]*(?:\.[\w-]+)*:\d{2,5}$/.test(core) && /[.-]|\d/.test(core.split(':')[0])) return 'host';
    if (/^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(core)) return 'email';
    if (AT_NUM_UNIT.test(core)) return 'num';
    if (/^-?\d+(?:[.,]\d+)*$/.test(core)) return 'num';
    if (/^\d{4}-\d{2}-\d{2}(?:[T ]\S*)?$|^\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?$/.test(core)) return 'time';
    if (core[0] === '/' && /\d/.test(core)) return 'path';
    if (/^(?:0x)?[0-9a-f]{8,}$/i.test(core) && /\d/.test(core)) return 'hex';
    if (core[0] === '"' && core[core.length - 1] === '"' && core.length >= 2) return 'text';
    if (core.length >= 2 && /\d/.test(core) && /[A-Za-z]/.test(core)) return 'id';
    if (/^[A-Z]{2,}\d+$|^\d+[A-Z]+$/i.test(core)) return 'id';
    return null;
  }

  // One token of a message -> its template text and, for changing parts, the value.
  function atToken(raw) {
    const m = /^([\[({<'"]*)(.*?)([\])}>'",;:.!?]*)$/.exec(raw);
    let pre = m[1], core = m[2], post = m[3];
    if (!core) return { key: raw, raw, core: raw };
    // a whole quoted string is one value: keep the quotes inside the value
    if (pre.endsWith('"') && post.startsWith('"')) { pre = pre.slice(0, -1); post = post.slice(1); core = '"' + core + '"'; }
    // key=value (and key:value when the value is clearly data)
    const kv = /^([A-Za-z_][\w.-]{0,40})([=:])(.+)$/.exec(core);
    if (kv && (kv[2] === '=' || (atKind(kv[3]) && !/^\/\//.test(kv[3]) && atKind(core) !== 'host'))) {
      let v = kv[3];
      if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
      const nu = AT_NUM_UNIT.exec(v);
      return { key: pre + kv[1] + kv[2] + '<*>' + post, raw, core, v: true, kvKey: kv[1], kind: atKind(v) || 'value', value: nu ? nu[1] : v, unit: nu ? nu[2] : null };
    }
    const kind = atKind(core);
    if (kind) {
      const nu = kind === 'num' ? AT_NUM_UNIT.exec(core) : null;
      let value = nu ? nu[1] : core;
      if (kind === 'text') value = core.slice(1, -1);
      return { key: pre + '<*>' + post, raw, core, v: true, kind, value, unit: nu ? nu[2] : null };
    }
    return { key: raw, raw, core };
  }

  function atTokens(message) {
    const toks = String(message).match(AT_TOKEN_RE) || [];
    if (toks.length > AT_MAX_TOKENS) { const rest = toks.slice(AT_MAX_TOKENS - 1).join(' '); toks.length = AT_MAX_TOKENS - 1; toks.push('"' + rest.replace(/"/g, "'") + '"'); }
    return toks.map(atToken);
  }

  const atWord = (t) => (t && !t.v ? t.core.replace(/[^\w.-]/g, '') : '');

  function atColumnName(tpl, i, members) {
    const t = tpl[i];
    const kinds = {};
    let unit = null;
    for (const mm of members.slice(0, 200)) {
      const x = mm.toks[i];
      if (x.kind) kinds[x.kind] = (kinds[x.kind] || 0) + 1;
      if (x.unit) unit = x.unit;
    }
    if (t.kvKey) return unit ? t.kvKey + ' (' + unit + ')' : t.kvKey;
    const kind = Object.keys(kinds).sort((a, b) => kinds[b] - kinds[a])[0] || 'word';
    if (['path', 'ip', 'uuid', 'url', 'email', 'host'].includes(kind)) return kind;
    // nearest label before the value, skipping small words ("for order 42" -> order)
    let label = '';
    const prev = tpl[i - 1];
    if (prev && !prev.v) {
      const w = atWord(prev);
      if (/[:=][\])}'"]*$/.test(prev.raw || '')) label = prev.core.replace(/[:=]+$/, '').replace(/[^\w.-]/g, '');
      else if (w && !AT_STOP.has(w.toLowerCase())) label = w;
      else if (/^(from|to|by|via|at|on|into)$/i.test(w) && !AT_NUM_UNIT.test(String(members[0].toks[i].core || ''))) label = w.toLowerCase();
      else if (tpl[i - 2] && !tpl[i - 2].v && atWord(tpl[i - 2]) && !AT_STOP.has(atWord(tpl[i - 2]).toLowerCase()) && unit == null && !(tpl[i + 1] && !tpl[i + 1].v && AT_UNITS.test(atWord(tpl[i + 1])))) label = atWord(tpl[i - 2]);
    }
    const next = tpl[i + 1];
    const nextUnit = next && !next.v && AT_UNITS.test(atWord(next)) ? atWord(next).toLowerCase() : null;
    const u = unit || nextUnit;
    if (u) return label ? label + ' (' + u + ')' : ({ s: 'seconds', sec: 'seconds', secs: 'seconds', m: 'minutes', min: 'minutes', h: 'hours', b: 'bytes' }[u.toLowerCase()] || u);
    if (label && label.length <= 40) return label;
    if (next && !next.v && atWord(next) && !AT_STOP.has(atWord(next).toLowerCase()) && /^[A-Za-z]/.test(atWord(next))) return atWord(next);
    return { num: 'number', id: 'id', hex: 'id', time: 'time', text: 'text', word: 'value' }[kind] || 'value';
  }

  function atTemplateKey(toks) { let k = ''; for (const t of toks) k += (k ? ' ' : '') + t.key; return k; }

  // Merge templates of the same length that differ in a few word positions.
  function atMerge(groups) {
    const byLen = new Map();
    for (const g of groups) {
      const L = g.tpl.length;
      if (!byLen.has(L)) byLen.set(L, []);
      byLen.get(L).push(g);
    }
    const out = [];
    for (const [L, list] of byLen) {
      list.sort((a, b) => b.members.length - a.members.length);
      const clusters = [];
      const limit = L >= 3 ? Math.floor(L * 0.34) : 0;
      for (const g of list) {
        let target = null;
        if (limit > 0) {
          for (let ci = 0; ci < clusters.length && ci < 300; ci++) {
            const c = clusters[ci];
            if (c.tpl[0].key !== g.tpl[0].key) continue;
            let diff = 0, sameConst = 0;
            for (let i = 0; i < L && diff <= limit; i++) {
              const a = c.tpl[i], b = g.tpl[i];
              if (a.key === b.key) { if (!a.v) sameConst++; continue; }
              // a changing word may only stand where both sides hold plain words or plain values
              if (a.kvKey || b.kvKey) { diff = limit + 1; break; }
              diff++;
            }
            if (diff <= limit && sameConst >= Math.max(2, Math.ceil(L * 0.5))) { target = c; break; }
          }
        }
        if (!target) { clusters.push({ tpl: g.tpl.map((t) => Object.assign({}, t)), members: g.members.slice() }); continue; }
        for (let i = 0; i < L; i++) if (target.tpl[i].key !== g.tpl[i].key) target.tpl[i] = { key: '<*>', v: true, kind: 'word', core: '' };
        for (const mm of g.members) target.members.push(mm);
      }
      for (const c of clusters) out.push(c);
    }
    return out;
  }

  function flattenJson(obj, prefix, out, depth) {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const key = prefix ? prefix + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) flattenJson(v, key, out, depth + 1);
      else out[key] = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    return out;
  }
  const JSON_STD = /^(@timestamp|timestamp|time|ts|datetime|date|level|log\.level|severity|levelname|loglevel|lvl|message|msg|log|text|logger_name|logger|log\.logger|loggerName|thread_name|thread|process\.thread\.name|@version|stack_trace|stackTrace|exception|stack)$/;

  const ACCESS_FULL_RE = /^(\S+)\s+\S+\s+(\S+)\s+\[([^\]]+)\]\s+"(\S+)\s+(\S+)[^"]*"\s+(\d{3})\s+(\S+)(?:\s+"([^"]*)"\s+"([^"]*)")?(?:\s+(\d+(?:\.\d+)?))?/;
  const routeOf = (p) => p.split('?')[0].replace(/\/(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{12,}|[A-Za-z]*\d[\w-]*)(?=\/|$)/gi, '/{id}');

  // lines: the file's lines; entries: from parseEntries (optionally only the visible ones).
  // Returns { tables: [{ id, title, template, count, levels, columns, rows: [{line, values}] }], processed, total, truncated }
  function autoTables(lines, entries, opts = {}) {
    const maxEntries = opts.maxEntries || 300000;
    const minCount = opts.minCount || (entries.length < 40 ? 1 : 2);
    const list = entries.length > maxEntries ? entries.slice(0, maxEntries) : entries;
    const groups = new Map();
    const access = [];
    const all = [];
    for (let ei = 0; ei < list.length; ei++) {
      const e = list[ei];
      const first = lines[e.start] || '';
      if (!first.trim()) continue;
      let message = e.message == null ? first.trim() : String(e.message);
      let json = null;
      if (e.fmt === 'json') { try { json = flattenJson(JSON.parse(first.trim()), '', {}, 0); } catch { json = null; } }
      if (e.fmt === 'access') {
        const a = ACCESS_FULL_RE.exec(first);
        if (a) { access.push({ e, a }); continue; }
      }
      if ((e.fmt === 'lines' || e.fmt === 'none') && e.tsText) {
        const at = message.indexOf(e.tsText);
        if (at >= 0 && at <= 64) message = (message.slice(0, at) + message.slice(at + e.tsText.length)).replace(/^[\s\]\[|:-]+/, '');
      }
      all.push(e);
      const toks = atTokens(message);
      if (!toks.length) continue;
      const key = (json ? 'j:' : '') + atTemplateKey(toks);
      let g = groups.get(key);
      if (!g) { g = { tpl: toks, members: [] }; groups.set(key, g); }
      g.members.push({ e, toks, json });
    }
    const clusters = atMerge(Array.from(groups.values()));
    const tables = [];
    let id = 0;
    for (const c of clusters) {
      if (c.members.length < minCount) continue;
      tables.push(atBuildTable(c, lines, ++id));
    }
    if (access.length) tables.push(atAccessTable(access, ++id));
    tables.sort((a, b) => b.count - a.count || b.columns.length - a.columns.length);
    return { tables, processed: list.length, total: entries.length, truncated: entries.length > list.length, overview: atOverview(all, clusters) };
  }

  function atExceptions(lines, e) {
    if (e.end <= e.start) return null;
    let first = null, cause = null;
    const stop = Math.min(e.end, e.start + 400);
    for (let i = e.start; i <= stop; i++) {
      const m = EXC_RE.exec(lines[i] || '');
      if (!m) continue;
      if (i === e.start && !/^\s*(?:Caused by:\s*)?(?:[a-zA-Z_$][\w$]*\.)+[A-Z]/.test(lines[i])) { if (!first) first = m[1]; continue; }
      if (/^\s*Caused by:/.test(lines[i])) cause = m[1];
      else if (!first) first = m[1];
    }
    return first || cause ? { first, cause } : null;
  }

  function atBuildTable(c, lines, id) {
    const members = c.members.sort((a, b) => a.e.start - b.e.start);
    const n = members.length;
    const varIdx = [];
    c.tpl.forEach((t, i) => { if (t.v) varIdx.push(i); });
    const valueAt = (mm, i) => { const x = mm.toks[i]; return x.v ? String(x.value) : x.core; };
    // a "changing" part that never changes is part of the text
    const constant = new Map();
    for (const i of varIdx) {
      const v0 = valueAt(members[0], i);
      if (n > 1 && members.every((mm) => valueAt(mm, i) === v0)) constant.set(i, v0);
    }
    const cols = [];
    const used = new Map();
    const addCol = (name, get) => {
      let nm = name;
      const k = nm.toLowerCase();
      if (used.has(k)) { used.set(k, used.get(k) + 1); nm = name + ' ' + used.get(k); } else used.set(k, 1);
      cols.push({ name: nm, get });
    };
    const share = (f) => members.reduce((a, mm) => a + (f(mm) ? 1 : 0), 0) / n;
    const varies = (f) => { const s = new Set(); for (const mm of members) { s.add(f(mm) || ''); if (s.size > 1) return true; } return false; };
    if (share((mm) => mm.e.tsText) >= 0.5) addCol('time', (mm) => mm.e.tsText || '');
    const levels = {};
    for (const mm of members) { const l = mm.e.level || 'OTHER'; levels[l] = (levels[l] || 0) + 1; }
    if (Object.keys(levels).length > 1) addCol('level', (mm) => mm.e.level || '');
    if (share((mm) => mm.e.thread) >= 0.5 && varies((mm) => mm.e.thread)) addCol('thread', (mm) => mm.e.thread || '');
    if (share((mm) => mm.e.logger) >= 0.5 && varies((mm) => mm.e.logger)) addCol('logger', (mm) => mm.e.logger || '');
    const names = {};
    for (const i of varIdx) {
      if (constant.has(i)) continue;
      const name = atColumnName(c.tpl, i, members);
      names[i] = name;
      addCol(name, (mm) => valueAt(mm, i));
    }
    const lower = new Set(cols.map((x) => x.name.toLowerCase()));
    if (!lower.has('traceid') && !lower.has('trace_id') && share((mm) => mm.e.traceId) >= 0.3 && varies((mm) => mm.e.traceId)) addCol('traceId', (mm) => mm.e.traceId || '');
    // JSON logs: the other fields, when most lines in this template have them
    if (members[0].json) {
      const freq = new Map();
      for (const mm of members) if (mm.json) for (const k of Object.keys(mm.json)) if (!JSON_STD.test(k)) freq.set(k, (freq.get(k) || 0) + 1);
      for (const [k, cnt] of freq) {
        if (cnt / n < 0.2 || lower.has(k.toLowerCase())) continue;
        if (!varies((mm) => mm.json && mm.json[k])) continue;
        addCol(k, (mm) => (mm.json && mm.json[k] != null ? mm.json[k] : ''));
      }
    }
    // stack traces: the exception and its root cause
    const exc = members.map((mm) => (mm.e.end > mm.e.start ? atExceptions(lines, mm.e) : null));
    if (exc.some((x) => x && x.first)) addCol('exception', (mm, k) => (exc[k] && exc[k].first) || '');
    if (exc.some((x) => x && x.cause && x.cause !== x.first)) addCol('caused by', (mm, k) => (exc[k] && exc[k].cause) || '');

    const rows = [];
    for (let k = 0; k < n && k < 200000; k++) {
      const mm = members[k];
      rows.push({ line: mm.e.start + 1, values: cols.map((col) => col.get(mm, k)) });
    }
    // readable template: changing parts shown as ‹name›
    const template = c.tpl.map((t, i) => {
      if (!t.v) return t.raw || t.core || t.key;
      if (constant.has(i)) return t.key.replace('<*>', constant.get(i));
      return t.key.replace('<*>', '‹' + (names[i] || 'value') + '›');
    }).join(' ');
    const loggers = new Set(members.slice(0, 500).map((mm) => mm.e.logger).filter(Boolean));
    return { id, title: template, template, count: n, levels, logger: loggers.size === 1 ? Array.from(loggers)[0] : null,
      columns: cols.map((x) => x.name), rows, truncated: n > 200000, json: !!members[0].json };
  }

  function atAccessTable(items, id) {
    const hasDur = items.some((x) => x.a[10]);
    const hasRef = items.some((x) => x.a[8] != null);
    const columns = ['ip', 'time', 'method', 'route', 'path', 'status', 'bytes'].concat(hasRef ? ['referer', 'user agent'] : [], hasDur ? ['duration'] : []);
    const levels = {};
    const rows = items.slice(0, 200000).map(({ e, a }) => {
      levels[e.level || 'OTHER'] = (levels[e.level || 'OTHER'] || 0) + 1;
      return { line: e.start + 1, values: [a[1], a[3], a[4], routeOf(a[5]), a[5], a[6], a[7] === '-' ? '0' : a[7]].concat(hasRef ? [a[8] || '', a[9] || ''] : [], hasDur ? [a[10] || ''] : []) };
    });
    return { id, title: 'HTTP requests (access log)', template: 'HTTP requests (access log)', count: items.length, levels, columns, rows, truncated: items.length > 200000 };
  }

  // One row per entry with the template it belongs to, for a quick parsed view of the whole log.
  function atOverview(all, clusters) {
    const tplOf = new Map();
    clusters.forEach((c, ci) => { for (const mm of c.members) tplOf.set(mm.e, ci); });
    const hasTs = all.some((e) => e.tsText);
    const hasThread = all.some((e) => e.thread);
    const hasLogger = all.some((e) => e.logger);
    const columns = [].concat(hasTs ? ['time'] : [], ['level'], hasThread ? ['thread'] : [], hasLogger ? ['logger'] : [], ['message']);
    const rows = all.slice(0, 200000).map((e) => ({ line: e.start + 1, values: [].concat(hasTs ? [e.tsText || ''] : [], [e.level || ''], hasThread ? [e.thread || ''] : [], hasLogger ? [e.logger || ''] : [], [String(e.message == null ? '' : e.message).slice(0, 2000)]) }));
    return { id: 0, title: 'All entries', template: 'All entries', count: all.length, columns, rows, truncated: all.length > 200000, levels: {} };
  }

  // ---------------- masking ----------------
  function luhn(digits) {
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (alt) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  function maskSecrets(text, opts = {}) {
    const o = Object.assign({ emails: true, ips: false, cards: true, pan: true }, opts);
    let count = 0;
    const rep = (re, fn) => {
      text = text.replace(re, (...a) => {
        const r = typeof fn === 'function' ? fn(...a) : fn;
        if (r !== a[0]) count++;
        return r;
      });
    };
    rep(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<private-key>');
    rep(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, '<jwt>');
    rep(/\b(Bearer|Basic)\s+[\w\-.~+/]{8,}=*/g, (m, k) => k + ' <redacted>');
    rep(/\b(password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|auth|credentials?)(["']?\s*[:=]\s*["']?)(?!<)(?!(?:Bearer|Basic)\b)([^\s"',;&}<]+)/gi,
      (m, k, sep) => k + sep + '****');
    rep(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '<aws-key>');
    if (o.cards) {
      rep(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => {
        const d = m.replace(/\D/g, '');
        return d.length >= 13 && d.length <= 19 && luhn(d) ? '<card>' : m;
      });
    }
    if (o.emails) rep(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '<email>');
    if (o.pan) rep(/\b[A-Z]{3}[ABCFGHLJPTK][A-Z]\d{4}[A-Z]\b/g, '<pan>');
    if (o.ips) rep(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>');
    return { text, count };
  }

  // ---------------- merge ----------------
  function mergeLogs(sources) {
    const items = [];
    let order = 0;
    for (const s of sources) {
      const lines = s.text.split(/\r?\n/);
      const { entries } = parseEntries(lines);
      let lastTs = -1e15;
      const tag = '[' + String(s.name).slice(0, 24) + '] ';
      for (const e of entries) {
        const ts = e.ts != null ? e.ts : lastTs;
        lastTs = ts;
        const block = lines.slice(e.start, e.end + 1);
        while (block.length > 1 && block[block.length - 1].trim() === '') block.pop();
        if (block.length === 1 && block[0].trim() === '') continue;
        block[0] = tag + block[0];
        items.push({ ts, order: order++, block });
      }
    }
    items.sort((a, b) => a.ts - b.ts || a.order - b.order);
    const out = [];
    for (const it of items) for (const l of it.block) out.push(l);
    return out.join('\n');
  }

  // ---------------- AI prompts ----------------
  function truncateMiddle(text, max) {
    if (text.length <= max) return text;
    const head = Math.floor(max * 0.6);
    const tail = max - head;
    return text.slice(0, head) + '\n\n... [' + (text.length - max) + ' characters omitted] ...\n\n' + text.slice(text.length - tail);
  }

  const PROMPTS = {
    explain: 'I am a Java / Spring Boot backend developer. Explain this error from our application logs: what it means, the most likely cause, and how to fix it. Point out the first frame in our own code if there is one.',
    rootcause: 'These are log lines from a backend service around a failure. Work out the root cause: the sequence of events, which component failed first, and what I should check next (config, data, downstream service, code).',
    summarize: 'Summarize these logs for a backend developer: the main errors and warnings with rough counts, any patterns or repeated failures, the timeline of incidents, and anything that looks abnormal.',
    fix: 'Suggest a code-level fix for this problem. Explain the cause briefly, then show the corrected Java code (Spring Boot) and any configuration change needed.',
    query: '',
  };

  function buildPrompt(kind, text, extra, maxChars = 12000) {
    const intro = kind === 'custom' ? (extra || '').trim() : PROMPTS[kind] || PROMPTS.explain;
    const ctx = extra && kind !== 'custom' ? '\n\nContext: ' + extra.trim() : '';
    return intro + ctx + '\n\n```\n' + truncateMiddle(text.trim(), maxChars) + '\n```';
  }

  // ---------------- incident: several logs on one clock (0.16.0) ----------------
  // sources: [{ name, lines, entries }] (entries from parseEntries). Returns the services, the shared time span
  // and findings TextForge spots by itself: repeated errors, errors in several services at once, a service that
  // goes quiet while the others are in trouble, and slow calls.
  // "took 1534ms", "took: 2.1 s", "502 in 1560ms" ("in" only with ms: "4 failures in 60s" is not a call)
  const TOOK_RE = /\btook[\s:=]*(\d+(?:\.\d+)?)\s*(ms|s)\b/i;
  const IN_MS_RE = /\bin\s*(\d+(?:\.\d+)?)\s*ms\b/i;
  function durationMs(line) {
    const t = TOOK_RE.exec(line || '');
    if (t) return Number(t[1]) * (t[2].toLowerCase() === 's' ? 1000 : 1);
    const m = IN_MS_RE.exec(line || '');
    return m ? Number(m[1]) : null;
  }
  // A finding's title: the entry's own message, without the trace ID it starts with.
  const cleanMessage = (m) => String(m || '').replace(/^\s*(?:trace[_-]?id)[=:]\s*[\w-]+[\s,;]*/i, '').replace(/\s+/g, ' ').trim();
  const cutText = (m, n) => (m.length > n ? m.slice(0, n - 1).trimEnd() + '…' : m);
  function joinNames(names) {
    return names.length <= 1 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }
  function serviceName(src) {
    const counts = {};
    for (const e of src.entries) if (e.app) counts[e.app] = (counts[e.app] || 0) + 1;
    let best = null;
    let n = 0;
    for (const k in counts) if (counts[k] > n) { n = counts[k]; best = k; }
    return best || String(src.name || 'log').replace(/\.(log|txt|out|json)$/i, '');
  }
  function incident(sources, opts = {}) {
    const services = sources.map((s, i) => {
      let min = null;
      let max = null;
      for (const e of s.entries) if (e.ts != null) { if (min == null || e.ts < min) min = e.ts; if (max == null || e.ts > max) max = e.ts; }
      return { index: i, name: serviceName(s), file: s.name, entries: s.entries, lines: s.lines, counts: levelCounts(s.entries), min, max };
    });
    const seen = {};
    services.forEach((s) => { seen[s.name] = (seen[s.name] || 0) + 1; });
    services.forEach((s) => { if (seen[s.name] > 1) s.name = s.name + ' (' + s.file + ')'; }); // two files of one service stay apart
    const timed = services.filter((s) => s.min != null);
    const min = timed.length ? Math.min(...timed.map((s) => s.min)) : null;
    const max = timed.length ? Math.max(...timed.map((s) => s.max)) : null;
    const findings = [];
    const ref = (s, i) => ({ s: s.index, e: i });

    // 1. errors, grouped by message within each service
    for (const s of services) {
      for (const g of groupErrors(s.entries, s.lines, { levels: ['ERROR'] })) {
        const first = s.entries[g.entries[0]];
        const msg = cleanMessage(first && first.message) || g.title;
        const exc = g.exception ? String(g.exception).split('.').pop() : '';
        findings.push({ kind: 'error', severity: g.count > 1 ? 3 : 2, title: cutText(msg, 110), services: [s.name], count: g.count, from: g.firstTs, to: g.lastTs,
          refs: g.entries.slice(0, 200).map((i) => ref(s, i)), detail: (g.count > 1 ? g.count + ' times' : 'Once') + ' in ' + s.name + (exc && !msg.includes(exc) ? ' · ' + exc : '') });
      }
    }
    // 2. errors in two or more services within a few seconds: one failure spreading
    const errs = [];
    for (const s of services) s.entries.forEach((e, i) => { if (e.level === 'ERROR' && e.ts != null) errs.push({ s, i, ts: e.ts }); });
    errs.sort((a, b) => a.ts - b.ts);
    const together = opts.togetherMs || 5000;
    let cluster = [];
    const flush = () => {
      const names = [...new Set(cluster.map((x) => x.s.name))];
      if (names.length >= 2) {
        const span = cluster[cluster.length - 1].ts - cluster[0].ts;
        findings.push({ kind: 'together', severity: 4, title: 'Errors in ' + joinNames(names) + (span < 1000 ? ' at the same moment' : ' within ' + formatDuration(span)),
          services: names, count: cluster.length, from: cluster[0].ts, to: cluster[cluster.length - 1].ts, refs: cluster.slice(0, 500).map((x) => ref(x.s, x.i)),
          detail: cluster.length + ' errors, first in ' + cluster[0].s.name });
      }
      cluster = [];
    };
    for (const x of errs) { if (cluster.length && x.ts - cluster[cluster.length - 1].ts > together) flush(); cluster.push(x); }
    if (cluster.length) flush();
    // 3. a service that stops logging while the others keep going and report errors calling it
    //    (a service that is simply idle is not a finding: the others have to name it in their warnings or errors)
    // Sorted timestamps (all entries, and warnings/errors) per service, so a time window is two binary searches.
    const lowerBound = (arr, x, key) => { let lo = 0; let hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if ((key ? arr[mid][key] : arr[mid]) <= x) lo = mid + 1; else hi = mid; } return lo; };
    const sortedTs = services.map((s) => s.entries.filter((e) => e.ts != null).map((e) => e.ts).sort((a, b) => a - b));
    const troubleList = services.map((s) => s.entries.filter((e) => e.ts != null && (e.level === 'ERROR' || e.level === 'WARN')).sort((a, b) => a.ts - b.ts));
    for (const s of services) {
      const base = s.name.replace(/ \(.*\)$/, '').toLowerCase();
      const names = base.length >= 4 ? [base] : []; // the full name only: "order" would match every /api/orders line
      const ts = sortedTs[s.index];
      if (ts.length < 4 || !names.length) continue;
      const gaps = [];
      for (let k = 1; k < ts.length; k++) gaps.push({ g: ts[k] - ts[k - 1], k });
      const bySize = gaps.slice().sort((a, b) => a.g - b.g);
      const median = bySize[Math.floor(bySize.length / 2)].g;
      const threshold = Math.max(opts.quietMs || 20000, median * 8);
      let best = null;
      for (const { g, k } of bySize.slice(-5).reverse()) { // the five longest silences are enough
        if (g < threshold) break;
        const a = ts[k - 1];
        const b = ts[k];
        let others = 0;
        let trouble = 0;
        for (const o of services) {
          if (o === s) continue;
          const arr = sortedTs[o.index];
          others += Math.max(0, lowerBound(arr, b - 1) - lowerBound(arr, a));
          const tl = troubleList[o.index];
          for (let j = lowerBound(tl, a, 'ts'); j < tl.length && tl[j].ts < b && trouble < 50; j++) {
            if (names.some((n) => entryText(o.lines, tl[j], 30).toLowerCase().includes(n))) trouble++;
          }
        }
        if (others >= 3 && trouble >= 1 && (!best || g > best.g)) best = { g, a, b, others, trouble };
      }
      if (best) {
        findings.push({ kind: 'quiet', severity: 3, title: s.name + ' went quiet for ' + formatDuration(best.g), services: [s.name], count: 0, from: best.a, to: best.b, refs: [],
          detail: 'Nothing logged while the other services wrote ' + best.others + ' entries; ' + best.trouble + ' of their warnings or errors name it' });
      }
    }
    // 4. slow calls ("took 1534ms", "in 2.2 s")
    const slowMs = opts.slowMs || 1000;
    for (const s of services) {
      const slow = [];
      s.entries.forEach((e, i) => { const ms = durationMs(s.lines[e.start]); if (ms != null && ms >= slowMs) slow.push({ i, ms, ts: e.ts }); });
      if (!slow.length) continue;
      const worst = slow.reduce((a, b) => (b.ms > a.ms ? b : a));
      const times = slow.map((x) => x.ts).filter((x) => x != null);
      findings.push({ kind: 'slow', severity: 1, title: slow.length + ' slow call' + (slow.length === 1 ? '' : 's') + ' in ' + s.name, services: [s.name], count: slow.length,
        from: times.length ? Math.min(...times) : null, to: times.length ? Math.max(...times) : null, refs: slow.slice(0, 500).map((x) => ref(s, x.i)),
        detail: 'Slowest ' + formatDuration(worst.ms) + ' · ' + formatDuration(slowMs) + ' or more' });
    }
    findings.sort((a, b) => b.severity - a.severity || b.count - a.count || (a.from ?? 0) - (b.from ?? 0));
    return { services, min, max, findings: findings.slice(0, opts.maxFindings || 40) };
  }
  // Each service's entries in n equal slices of the shared time span (for the lanes).
  function incidentBuckets(service, min, max, n) {
    const span = Math.max(1, max - min);
    const out = Array.from({ length: n }, () => ({ total: 0, error: 0, warn: 0, idx: [] }));
    service.entries.forEach((e, i) => {
      if (e.ts == null) return;
      const b = out[Math.min(n - 1, Math.max(0, Math.floor(((e.ts - min) / span) * n)))];
      b.total++;
      if (e.level === 'ERROR') b.error++;
      else if (e.level === 'WARN') b.warn++;
      if (b.idx.length < 500) b.idx.push(i);
    });
    return out;
  }

  // ---------------- requests across logs (0.17.0) ----------------
  // Entries that share a trace ID are one request. Each service it touched is a step: from the first entry
  // (moved earlier when the line says how long it took: "took 1534ms" at 10:16:15.020 started at 10:16:13.486)
  // to the last. A request failed when an entry is an ERROR or the caller got a 5xx.
  const ROUTE_RE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s?]*)/;
  const STATUS_RE = /\b([1-5]\d\d)\s+in\s+\d/; // "POST /api/orders 502 in 1560ms"
  const msText = (ms) => (ms < 1000 ? Math.round(ms) + ' ms' : formatDuration(Math.round(ms)));
  function requests(res, opts = {}) {
    const map = new Map();
    res.services.forEach((s, si) => s.entries.forEach((e, ei) => {
      if (!e.traceId || e.ts == null) return;
      let r = map.get(e.traceId);
      if (!r) { r = { id: e.traceId, hits: [] }; map.set(e.traceId, r); }
      r.hits.push({ s: si, e: ei, ts: e.ts });
    }));
    const out = [];
    for (const r of map.values()) {
      r.hits.sort((a, b) => a.ts - b.ts || a.s - b.s);
      const bySvc = new Map();
      const steps = [];
      let route = null;
      let status = null;
      let errors = 0;
      let warns = 0;
      let firstError = null;
      let reported = 0;
      for (const hit of r.hits) {
        const svc = res.services[hit.s];
        const e = svc.entries[hit.e];
        const line = svc.lines[e.start] || '';
        const d = durationMs(line);
        if (d != null && d > reported) reported = d;
        const rm = ROUTE_RE.exec(line);
        if (!route && rm) route = rm[1] + ' ' + rm[2];
        const sm = STATUS_RE.exec(line);
        if (sm) status = +sm[1]; // the last response wins
        let st = bySvc.get(hit.s);
        if (!st) {
          st = { s: hit.s, service: svc.name, from: hit.ts, to: hit.ts, refs: [], level: 'ok', label: null, firstTs: hit.ts };
          bySvc.set(hit.s, st);
          steps.push(st);
        }
        st.refs.push({ s: hit.s, e: hit.e });
        if (d != null && hit.ts - d < st.from) st.from = hit.ts - d;
        if (hit.ts > st.to) st.to = hit.ts;
        if (!st.label) st.label = rm ? rm[1] + ' ' + rm[2] : cutText(cleanMessage(e.message || line), 60);
        if (e.level === 'ERROR') {
          st.level = 'error';
          errors++;
          if (!firstError) firstError = { s: hit.s, e: hit.e, ts: hit.ts, service: svc.name, message: cleanMessage(e.message || line) };
        } else if (e.level === 'WARN') {
          warns++;
          if (st.level === 'ok') st.level = 'warn';
        }
      }
      steps.sort((a, b) => a.from - b.from || a.firstTs - b.firstTs);
      const from = Math.min(...steps.map((x) => x.from));
      const to = Math.max(...steps.map((x) => x.to));
      const ms = Math.max(to - from, reported);
      const failed = errors > 0 || (status != null && status >= 500);
      const slow = !failed && ms >= (opts.slowMs || 1000);
      const rq = { id: r.id, route, status, steps, from, to, ms, errors, warns, failed, slow, firstError, services: steps.map((x) => x.service), hits: r.hits.length };
      rq.summary = describeRequest(rq);
      out.push(rq);
    }
    // failed first, then slow, then the rest; each group in time order
    out.sort((a, b) => (b.failed - a.failed) || (b.slow - a.slow) || a.from - b.from);
    return out;
  }
  // One or two plain sentences: where the request went, where it broke first, what the caller got.
  function describeRequest(rq) {
    const what = rq.route || 'This request';
    const parts = [];
    if (rq.hits === 1) parts.push(what + ' appears once, in ' + rq.services[0] + '.');
    else parts.push(what + ' went through ' + joinNames(rq.services) + ' in ' + msText(rq.ms) + '.');
    if (rq.failed && rq.firstError) {
      const fe = rq.firstError;
      parts.push('It first failed in ' + fe.service + ' at ' + formatTs(fe.ts) + ': ' + cutText(fe.message, 140).replace(/\.$/, '') + '.');
      const others = rq.steps.filter((x) => x.level === 'error' && x.service !== fe.service).map((x) => x.service);
      if (others.length) parts.push('Then ' + joinNames(others) + ' failed too.');
      if (rq.status) parts.push('The caller got ' + rq.status + '.');
    } else if (rq.failed) {
      parts.push('The caller got ' + rq.status + '.');
    } else if (rq.slow) {
      const slowest = rq.steps.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a));
      parts.push('It worked but was slow: ' + slowest.service + ' took ' + msText(slowest.to - slowest.from) + '.');
    } else {
      parts.push('It worked' + (rq.status ? ' (' + rq.status + ')' : '') + '.');
    }
    return parts.join(' ');
  }

  // ---------------- incident report (0.18.0) ----------------
  // Markdown for Teams / Outlook / a ticket, from what the person pinned in the incident view. Pure: the
  // caller resolves each pin (title, detail, evidence lines, note) and masks secrets in the result.
  const KIND_LABEL = { together: 'Errors in several services', error: 'Error', quiet: 'Service went quiet', slow: 'Slow calls' };
  const fence = (lines) => { const body = lines.join('\n'); const ticks = /```/.test(body) ? '~~~~' : '```'; return ticks + '\n' + body + '\n' + ticks; };
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  function incidentReport({ title, summary, from, to, services, pins }) {
    const out = [];
    out.push('# ' + (title || 'Incident').trim(), '');
    const when = from != null ? formatTs(from, true) + ' to ' + formatTs(to) + ' (' + formatDuration(Math.max(0, to - from)) + ')' : '';
    out.push([when ? '**When:** ' + when : '', services && services.length ? '**Logs:** ' + services.join(', ') : ''].filter(Boolean).join(' · '), '');
    if (summary && summary.trim()) out.push('## What happened', '', summary.trim(), '');
    const findings = pins.filter((p) => p.type === 'finding');
    const reqs = pins.filter((p) => p.type === 'request');
    if (findings.length) {
      out.push('## Findings', '');
      findings.forEach((p, i) => {
        out.push('### ' + (i + 1) + '. ' + p.title, '');
        out.push([KIND_LABEL[p.kind] || p.kind, p.detail, p.when].filter(Boolean).join(' · '), '');
        if (p.note && p.note.trim()) out.push(p.note.trim(), '');
        if (p.evidence && p.evidence.length) {
          out.push(fence(p.evidence.map((ev) => ev.text)), '');
          out.push('_' + [...new Set(p.evidence.map((ev) => ev.file))].map((f) => f + ', line' + (p.evidence.filter((ev) => ev.file === f).length > 1 ? 's ' : ' ') + p.evidence.filter((ev) => ev.file === f).map((ev) => ev.line).join(', ')).join('; ') + '_', '');
        }
      });
    }
    if (reqs.length) {
      out.push('## Requests', '');
      for (const p of reqs) {
        out.push('### ' + p.id + ' · ' + p.state + (p.status ? ' · ' + p.status : ''), '');
        if (p.summary) out.push(p.summary, '');
        if (p.steps && p.steps.length) {
          out.push('| Service | Step | Took | Result |', '| --- | --- | --: | --- |');
          for (const s of p.steps) out.push('| ' + [cell(s.service), cell(s.label || ''), cell(s.took), cell(s.result)].join(' | ') + ' |');
          out.push('');
        }
        if (p.note && p.note.trim()) out.push(p.note.trim(), '');
      }
    }
    if (!findings.length && !reqs.length) out.push('_Nothing pinned yet._', '');
    out.push('_Made with TextForge from ' + (services ? services.length : 0) + ' log' + (services && services.length === 1 ? '' : 's') + '. Secrets were masked._');
    return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  }

  return {
    incidentReport,
    requests, describeRequest,
    incident, incidentBuckets, serviceName, durationMs,
    LEVEL_CHIPS, FORMAT_LABELS, PRESETS, autoTables, EXC_RE, FRAME_RE, STACK_LINE_RE,
    normLevel, findTimestamp, parseTimeInput, findTraceId, parseLine, parseEntries, isLogText, entryIndexAt,
    levelCounts, entryText, filterEntries, normalizeMsg, packagesRegex, groupErrors, timeline, formatDuration,
    formatTs, extractRegex, extractKeyValues, extractJsonFields, numericStats, maskSecrets, mergeLogs, findDuplicates, countBy,
    buildPrompt, truncateMiddle,
  };
});
