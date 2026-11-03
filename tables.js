/* Table parsing / formatting helpers. Pure functions, usable in the browser (window.Tables) and in Node tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Tables = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FORMATS = ['markdown', 'grid', 'aligned', 'tsv', 'csv'];

  function normText(s) {
    return String(s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  }

  function rectangular(rows) {
    const n = rows.reduce((m, r) => Math.max(m, r.length), 0);
    return rows.map((r) => {
      const c = r.slice();
      while (c.length < n) c.push('');
      return c;
    });
  }

  // Pull a single table out of clipboard HTML. Returns rows (array of arrays) or null.
  // Returns null when the HTML is not "mostly one table" so ordinary rich-text pastes are left alone.
  function extractTableFromHtml(html, DOMParserCtor) {
    if (!html || !/<table/i.test(html)) return null;
    const Ctor = DOMParserCtor || (typeof DOMParser !== 'undefined' ? DOMParser : null);
    if (!Ctor) return null;
    const doc = new Ctor().parseFromString(html, 'text/html');
    const tables = Array.from(doc.querySelectorAll('table')).filter(
      (t) => !t.parentElement || !t.parentElement.closest('table')
    );
    if (tables.length !== 1) return null;
    const table = tables[0];

    const rows = [];
    for (const tr of Array.from(table.rows)) {
      const cells = [];
      for (const cell of Array.from(tr.cells)) {
        cell.querySelectorAll('br').forEach((b) => b.replaceWith(doc.createTextNode(' ')));
        cells.push(normText(cell.textContent));
        const span = Math.max(1, Math.min(parseInt(cell.colSpan, 10) || 1, 50));
        for (let i = 1; i < span; i++) cells.push('');
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return null;
    const rect = rectangular(rows);
    if (rect.length * rect[0].length < 2) return null; // a single cell: let the normal paste happen

    const bodyLen = normText(doc.body ? doc.body.textContent : '').length;
    const tableLen = normText(table.textContent).length;
    if (bodyLen > 0 && tableLen / bodyLen < 0.85) return null; // table is only part of a bigger copy
    return rect;
  }

  // Tab-separated text (what Excel / Sheets put on the clipboard as text/plain).
  function parseTsv(text) {
    if (!text) return null;
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
    if (lines.length < 2) return null;
    const rows = lines.map((l) => l.split('\t'));
    const n = rows[0].length;
    if (n < 2 || !rows.every((r) => r.length === n)) return null;
    return rows.map((r) => r.map((c) => c.trim()));
  }

  function parseCsv(text) {
    const src = text.replace(/\r\n?/g, '\n');
    const rows = [];
    let row = [];
    let cell = '';
    let q = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (q) {
        if (ch === '"') {
          if (src[i + 1] === '"') { cell += '"'; i++; } else q = false;
        } else cell += ch;
      } else if (ch === '"' && cell === '') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function parseCsvTable(text) {
    const rows = parseCsv(text.replace(/\n+$/, ''));
    if (rows.length < 2) return null;
    const n = rows[0].length;
    if (n < 2 || !rows.every((r) => r.length === n)) return null;
    return rows.map((r) => r.map((c) => c.trim()));
  }

  const MD_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const GRID_SEP = /^\s*\+[-=+]+\+\s*$/;

  // Markdown pipe tables and +---+ grid tables.
  function parsePipeTable(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
    if (!lines.length || !lines.every((l) => l.includes('|') || GRID_SEP.test(l))) return null;
    const rows = [];
    for (const l of lines) {
      if (GRID_SEP.test(l) || MD_SEP.test(l)) continue;
      let t = l.trim();
      if (t.startsWith('|')) t = t.slice(1);
      if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
      rows.push(t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim()));
    }
    if (!rows.length) return null;
    const rect = rectangular(rows);
    return rect[0].length >= 2 ? rect : null;
  }

  // Columns separated by 2+ spaces.
  function parseAligned(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
    if (lines.length < 2) return null;
    const rows = lines.map((l) => l.trim().split(/ {2,}/));
    const n = rows[0].length;
    if (n < 2 || !rows.every((r) => r.length === n)) return null;
    return rows;
  }

  // ---------- single-space separated tables (tabs lost when copied from chat, email, PDFs) ----------
  // Columns are inferred by trying "column layouts": every column has a fixed number of words except
  // one variable column that absorbs the rest. The layout whose columns look most consistent wins.
  // Words that usually finish a two-word header ("Employee ID", "Customer Name", "Order Date").
  const HEADER_SUFFIX = /^(id|no\.?|number|num|name|code|date)$/i;
  // Weaker candidates, used only when the header has one word too many for the data.
  const HEADER_SUFFIX_WEAK = /^(title|login|status|type|amount|count|time|level|address|email|phone|mobile|qty|size|version)$/i;

  // Words that usually start a multi-word header ("Avg Response", "Max Response", "Total Amount").
  const HEADER_PREFIX = /^(avg\.?|average|max\.?|maximum|min\.?|minimum|total|mean|median|peak|last|first|start|end|net|gross|full|job|unit|created|updated|p\d{2})$/i;
  const UNIT_WORD = /^\(.*\)$|^\[.*\]$|^(ms|sec|secs|s|%|kb|mb|gb|inr|usd|rs\.?)$/i;

  // Group header words into exactly k column names, preferring joins that read as one name:
  // units "(ms)", "Employee ID", "Error Count", "Avg Response", lower-case continuations.
  function fitHeader(words, k) {
    const n = words.length;
    if (k >= n) return k === n ? words.slice() : null;
    const joint = (a, b) => {
      let bonus = 0;
      if (UNIT_WORD.test(b)) bonus = 1;
      else if (/^[a-z]/.test(b)) bonus = 0.9;
      else if (HEADER_SUFFIX.test(b) && !HEADER_SUFFIX.test(a)) bonus = 0.9;
      else if (HEADER_SUFFIX_WEAK.test(b)) bonus = 0.8;
      if (HEADER_PREFIX.test(a)) bonus = Math.max(bonus, 0.8);
      return Math.max(0.05, 1 - bonus);
    };
    // best[i][g]: lowest cost for the first i words in g groups
    const best = Array.from({ length: n + 1 }, () => new Array(k + 1).fill(Infinity));
    const from = Array.from({ length: n + 1 }, () => new Array(k + 1).fill(-1));
    best[0][0] = 0;
    for (let i = 1; i <= n; i++) {
      for (let g = 1; g <= Math.min(i, k); g++) {
        let groupCost = 0;
        for (let j = i - 1; j >= g - 1; j--) { // last group = words[j..i-1]
          if (j < i - 1) groupCost += joint(words[j], words[j + 1]);
          const c = best[j][g - 1] + groupCost;
          if (c < best[i][g]) { best[i][g] = c; from[i][g] = j; }
        }
      }
    }
    if (!isFinite(best[n][k])) return null;
    const out = [];
    for (let i = n, g = k; g > 0; g--) { const j = from[i][g]; out.unshift(words.slice(j, i).join(' ')); i = j; }
    return out;
  }

  function mergeOnePair(cells) {
    let idx = cells.findIndex((c, i) => i > 0 && HEADER_SUFFIX.test(c) && !cells[i - 1].includes(' ') && !HEADER_SUFFIX.test(cells[i - 1]));
    if (idx < 1) idx = cells.findIndex((c, i) => i > 0 && HEADER_SUFFIX_WEAK.test(c) && !cells[i - 1].includes(' '));
    if (idx < 1) idx = cells.length - 1;
    return cells.slice(0, idx - 1).concat([cells[idx - 1] + ' ' + cells[idx]], cells.slice(idx + 1));
  }

  function headerCells(tokens) {
    const cells = [];
    for (const t of tokens) {
      const prev = cells[cells.length - 1];
      if (prev && HEADER_SUFFIX.test(t) && !prev.includes(' ') && !HEADER_SUFFIX.test(prev)) cells[cells.length - 1] = prev + ' ' + t;
      else cells.push(t);
    }
    return cells;
  }

  const wordShape = (w) => w.replace(/[A-Z]+/g, 'A').replace(/[a-z]+/g, 'a').replace(/\d+/g, '9');
  const cellShape = (c) => c.split(' ').map(wordShape).join(' ');

  function splitRow(tokens, k, v, counts) {
    let need = 0;
    for (let j = 0; j < k; j++) if (j !== v) need += counts[j];
    if (tokens.length < need + 1) return null;
    const cells = new Array(k);
    let left = 0;
    for (let j = 0; j < v; j++) { cells[j] = tokens.slice(left, left + counts[j]).join(' '); left += counts[j]; }
    let right = tokens.length;
    for (let j = k - 1; j > v; j--) { cells[j] = tokens.slice(right - counts[j], right).join(' '); right -= counts[j]; }
    cells[v] = tokens.slice(left, right).join(' ');
    return cells;
  }

  function scoreLayout(rowsTok, k, v, counts) {
    const cells = [];
    let feasible = 0;
    for (const t of rowsTok) {
      const c = splitRow(t, k, v, counts);
      if (c) { feasible++; cells.push(c); }
    }
    if (feasible < rowsTok.length * 0.9 || cells.length < 2) return null;
    let shape = 0;
    let repeat = 0;
    let mixed = 0;
    for (let j = 0; j < k; j++) {
      const shapes = new Map();
      const values = new Set();
      for (const c of cells) {
        const s = cellShape(c[j]);
        shapes.set(s, (shapes.get(s) || 0) + 1);
        values.add(c[j].toLowerCase());
        // a cell holding both an ID/number and a plain word ("ORD-1 Ravi") is almost always a bad split
        const ws = c[j].split(' ');
        if (ws.length > 1 && ws.some((w) => /\d/.test(w)) && ws.some((w) => /^[A-Za-z]+$/.test(w))) mixed++;
      }
      shape += Math.max(...shapes.values()) / cells.length;
      if (cells.length >= 4) repeat += 1 - values.size / cells.length;
    }
    const extra = counts.reduce((a, c, j) => a + (j === v ? 0 : c - 1), 0);
    const score = shape / k + 0.5 * (repeat / k) + (v === k - 1 ? 0.15 : 0) - 0.03 * extra + (feasible === rowsTok.length ? 0.05 : 0)
      - 1.0 * (mixed / (cells.length * k));
    return { score, shape: shape / k, feasible: feasible / rowsTok.length };
  }

  function bestLayout(rowsTok, k) {
    const maxCount = k <= 6 ? 3 : 2;
    let best = null;
    const counts = new Array(k).fill(1);
    const walk = (j, v) => {
      if (j === k) {
        const s = scoreLayout(rowsTok, k, v, counts);
        if (s && (!best || s.score > best.score)) best = Object.assign(s, { k, v, counts: counts.slice() });
        return;
      }
      if (j === v) { counts[j] = 0; walk(j + 1, v); return; }
      for (let c = 1; c <= maxCount; c++) { counts[j] = c; walk(j + 1, v); }
    };
    for (let v = 0; v < k; v++) walk(0, v);
    return best;
  }

  // Returns { rows, header, confident } or null when the text doesn't look like a table.
  function inferSpaceTable(text) {
    if (!text || text.includes('\t')) return null;
    const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 3 || lines.length > 5000) return null;
    if (lines.filter((l) => /[{};=<>]|^\/\/|^#/.test(l)).length > lines.length * 0.3) return null; // code
    const toks = lines.map((l) => l.split(/\s+/));
    const lens = toks.map((t) => t.length);
    if (Math.min(...lens) < 2 || Math.max(...lens) > 16) return null;

    const first = toks[0];
    const rest = toks.slice(1);
    const digitRows = rest.filter((t) => t.some((w) => /\d/.test(w))).length;
    // A header row: capitalised words without digits, above data that is not itself only capitalised words
    // (otherwise a plain list such as names would be mistaken for a table).
    const headerLike = first.length <= 16 && first.every((w) => UNIT_WORD.test(w) || (/^[A-Z(][A-Za-z0-9.%/()#&_-]*$/.test(w) && !/^\(?\d/.test(w))) &&
      !first.some((w) => /\d/.test(w) && !UNIT_WORD.test(w)); // header words carry no digits, except units like (ms)
    const dataDiffers = digitRows > 0 || rest.some((t) => t.some((w) => !/^[A-Z][a-z]+$/.test(w)));
    let header = headerLike && dataDiffers ? headerCells(first) : null;
    let data = header ? rest : toks;
    if (data.length < 2) return null;
    let sample = data.slice(0, 120);
    let minTok = Math.min(...sample.map((t) => t.length));

    // 1) Columns come from the data alone.
    let best = null;
    for (let k = 2; k <= Math.min(minTok, 8); k++) {
      const b = bestLayout(sample, k);
      if (b && (!best || b.score + 0.02 * k > best.score + 0.02 * best.k)) best = b;
    }
    if (!best) return null;
    let rows = data.map((t) => splitRow(t, best.k, best.v, best.counts) || t.slice(0, best.k - 1).concat([t.slice(best.k - 1).join(' ')]));

    // 2) Two neighbouring columns that are both unique capitalised single words are usually one value
    //    split in two (first + last name): merge them.
    const nameLike = (col) => col.every((x) => /^[A-Z][a-z]+$/.test(x)) && new Set(col).size >= col.length * 0.9;
    for (let j = 0; j < rows[0].length - 1; j++) {
      if (header && rows[0].length <= header.length) break;
      if (nameLike(rows.map((r) => r[j])) && nameLike(rows.map((r) => r[j + 1]))) {
        rows = rows.map((r) => r.slice(0, j).concat([r[j] + ' ' + r[j + 1]], r.slice(j + 2)));
        j--;
      }
    }

    // 3) Fit the header words to the columns found.
    if (header) {
      const cols = rows[0].length;
      header = first.length === cols ? first.slice() : fitHeader(first, cols);
      if (!header) rows = [first].concat(rows); // could not align: keep the first line as data
    }
    const out = header ? [header].concat(rows) : rows;
    const confident = !!header && best.feasible === 1 && best.shape >= 0.7 && rows.length >= 2;
    const plausible = best.shape >= 0.75 && (header || digitRows >= rest.length * 0.5);
    if (!confident && !plausible) return null;
    return { rows: rectangular(out), header: !!header, confident };
  }

  // Try every supported text layout.
  function parseTableText(text) {
    if (!text || !text.trim()) return null;
    return parsePipeTable(text) || parseTsv(text) || parseCsvTable(text) || parseAligned(text);
  }

  function strWidth(s) {
    let w = 0;
    for (const ch of String(s)) {
      w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1;
    }
    return w;
  }

  function pad(s, w) {
    return s + ' '.repeat(Math.max(0, w - strWidth(s)));
  }

  function oneLine(s) {
    return String(s).replace(/[\t\r\n]+/g, ' ');
  }

  function formatRows(rowsIn, fmt) {
    const rows = rectangular(rowsIn.map((r) => r.map(oneLine)));
    if (!rows.length) return '';
    const cols = rows[0].length;
    const widthsFor = (cells, min) => {
      const w = [];
      for (let c = 0; c < cols; c++) w.push(Math.max(min, ...cells.map((r) => strWidth(r[c]))));
      return w;
    };

    switch (fmt) {
      case 'tsv':
        return rows.map((r) => r.join('\t')).join('\n');
      case 'csv':
        return rows
          .map((r) => r.map((c) => (/[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c)).join(','))
          .join('\n');
      case 'aligned': {
        const w = widthsFor(rows, 1);
        return rows.map((r) => r.map((c, i) => pad(c, w[i])).join('  ').replace(/\s+$/, '')).join('\n');
      }
      case 'grid': {
        const g = rows.map((r) => r.map((c) => c.replace(/\|/g, '\\|')));
        const w = widthsFor(g, 1);
        const line = (ch) => '+' + w.map((x) => ch.repeat(x + 2)).join('+') + '+';
        const fmtRow = (r) => '| ' + r.map((c, i) => pad(c, w[i])).join(' | ') + ' |';
        const out = [line('-'), fmtRow(g[0])];
        if (g.length > 1) {
          out.push(line('='));
          for (const r of g.slice(1)) out.push(fmtRow(r));
        }
        out.push(line('-'));
        return out.join('\n');
      }
      case 'markdown':
      default: {
        const esc = rows.map((r) => r.map((c) => c.replace(/\|/g, '\\|')));
        const w = widthsFor(esc, 3);
        const fmtRow = (r) => '| ' + r.map((c, i) => pad(c, w[i])).join(' | ') + ' |';
        const out = [fmtRow(esc[0]), '| ' + w.map((x) => '-'.repeat(x)).join(' | ') + ' |'];
        for (const r of esc.slice(1)) out.push(fmtRow(r));
        return out.join('\n');
      }
    }
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Rich HTML so that pasting into Word / Outlook / Excel keeps a real table.
  function rowsToHtml(rowsIn) {
    const rows = rectangular(rowsIn);
    const cell = (tag, c) =>
      `<${tag} style="border:1px solid #999;padding:4px 8px;text-align:left">${escHtml(c)}</${tag}>`;
    let h = '<table style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:11pt" border="1" cellspacing="0" cellpadding="4">';
    rows.forEach((r, i) => {
      h += '<tr>' + r.map((c) => cell(i === 0 ? 'th' : 'td', c)).join('') + '</tr>';
    });
    return h + '</table>';
  }

  return {
    FORMATS,
    extractTableFromHtml,
    parseTsv,
    parseCsvTable,
    parsePipeTable,
    parseAligned,
    parseTableText,
    inferSpaceTable,
    headerCells,
    formatRows,
    rowsToHtml,
    strWidth,
  };
});
