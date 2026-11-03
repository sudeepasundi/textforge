/* Markdown support: HTML -> Markdown (rich paste from AI chats, web pages, Teams, Outlook)
   and Markdown -> DOM (safe preview, built with createElement only, never innerHTML).
   Works in the browser (window.Markdown) and in Node tests (pass a DOMParser / document). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./tables.js'));
  else root.Markdown = factory(root.Tables);
})(typeof self !== 'undefined' ? self : this, function (Tables) {
  'use strict';

  // ======================================================================
  // HTML -> Markdown
  // ======================================================================
  const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DETAILS', 'DIV', 'DL', 'FIELDSET', 'FIGURE', 'FOOTER', 'FORM',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'UL', 'SUMMARY']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'HEAD', 'TITLE', 'BUTTON', 'SVG', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'INPUT', 'SELECT', 'TEXTAREA']);

  // Pasted text is kept as typed (no backslash escapes), so it reads naturally in the editor.
  // The preview's inline rules are strict enough that stray * and _ in normal text stay literal.
  const escInline = (s) => s;

  function inline(node, opts = {}) {
    let out = '';
    for (const n of Array.from(node.childNodes)) {
      if (n.nodeType === 3) {
        let t = n.nodeValue.replace(/\s+/g, ' ');
        if (!opts.code) t = escInline(t);
        out += t;
        continue;
      }
      if (n.nodeType !== 1 || SKIP.has(n.tagName)) continue;
      const tag = n.tagName;
      if (tag === 'BR') { out += opts.cell ? '<br>' : '\n'; continue; }
      if (tag === 'IMG') { const alt = n.getAttribute('alt'); if (alt) out += alt; continue; }
      const inner = inline(n, Object.assign({}, opts, tag === 'CODE' ? { code: true } : {}));
      const trimmed = inner.trim();
      if (!trimmed) { out += inner; continue; }
      const lead = /^\s/.test(inner) ? ' ' : '';
      const trail = /\s$/.test(inner) ? ' ' : '';
      if (tag === 'STRONG' || tag === 'B') out += lead + '**' + trimmed + '**' + trail;
      else if (tag === 'EM' || tag === 'I') out += lead + '*' + trimmed + '*' + trail;
      else if (tag === 'DEL' || tag === 'S') out += lead + '~~' + trimmed + '~~' + trail;
      else if (tag === 'CODE' && !opts.code) out += lead + '`' + trimmed.replace(/`/g, "'") + '`' + trail;
      else if (tag === 'A') {
        const href = n.getAttribute('href') || '';
        out += /^https?:\/\//i.test(href) && trimmed !== href ? lead + '[' + trimmed + '](' + href + ')' + trail : inner;
      } else out += inner;
    }
    return out;
  }

  function cellText(td) {
    return inline(td, { cell: true }).replace(/\s*\n\s*/g, ' ').replace(/(<br>\s*)+$/g, '').replace(/^\s*(<br>\s*)+/g, '').trim();
  }

  function tableToMarkdown(table) {
    const rows = [];
    for (const tr of Array.from(table.rows)) {
      const cells = [];
      for (const td of Array.from(tr.cells)) {
        cells.push(cellText(td));
        const span = Math.max(1, Math.min(parseInt(td.colSpan, 10) || 1, 50));
        for (let i = 1; i < span; i++) cells.push('');
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return '';
    // markdown needs a header row: if the table has none, use the first row
    return Tables.formatRows(rows.map((r) => r.map((c) => c.replace(/\\\|/g, '|'))), 'markdown');
  }

  function listToMarkdown(list, depth) {
    const ordered = list.tagName === 'OL';
    let n = parseInt(list.getAttribute('start'), 10) || 1;
    const lines = [];
    for (const li of Array.from(list.children)) {
      if (li.tagName !== 'LI') continue;
      const marker = ordered ? n++ + '. ' : '- ';
      const pad = '   '.repeat(depth);
      const parts = [];
      let text = '';
      for (const c of Array.from(li.childNodes)) {
        if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) {
          if (text.trim()) { parts.push(text.trim()); text = ''; }
          parts.push({ nested: listToMarkdown(c, depth + 1) });
        } else if (c.nodeType === 1 && c.tagName === 'PRE') {
          if (text.trim()) { parts.push(text.trim()); text = ''; }
          parts.push({ block: blocks(c).trim() });
        } else if (c.nodeType === 1 && BLOCK.has(c.tagName)) {
          text += ' ' + inline(c);
        } else if (c.nodeType === 3 || c.nodeType === 1) {
          text += c.nodeType === 3 ? escInline(c.nodeValue.replace(/\s+/g, ' ')) : inline({ childNodes: [c] });
        }
      }
      if (text.trim()) parts.push(text.trim());
      let first = true;
      for (const p of parts) {
        if (typeof p === 'string') {
          lines.push((first ? pad + marker : pad + ' '.repeat(marker.length)) + p.replace(/\n/g, '\n' + pad + ' '.repeat(marker.length)));
          first = false;
        } else if (p.nested) {
          if (first) { lines.push(pad + marker.trim()); first = false; }
          lines.push(p.nested);
        } else if (p.block) {
          if (first) { lines.push(pad + marker.trim()); first = false; }
          lines.push(p.block.split('\n').map((l) => pad + ' '.repeat(marker.length) + l).join('\n'));
        }
      }
      if (first) lines.push(pad + marker.trim());
    }
    return lines.join('\n');
  }

  function blocks(node) {
    const out = [];
    let buf = '';
    const flush = () => { const t = buf.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); if (t) out.push(t); buf = ''; };
    for (const n of Array.from(node.childNodes)) {
      if (n.nodeType === 3) { buf += escInline(n.nodeValue.replace(/\s+/g, ' ')); continue; }
      if (n.nodeType !== 1 || SKIP.has(n.tagName)) continue;
      const tag = n.tagName;
      if (!BLOCK.has(tag)) {
        if (tag === 'BR') buf += '\n';
        else buf += inline({ childNodes: [n] });
        continue;
      }
      flush();
      if (/^H[1-6]$/.test(tag)) out.push('#'.repeat(+tag[1]) + ' ' + inline(n).trim());
      else if (tag === 'P' || tag === 'SUMMARY') { const t = inline(n).trim(); if (t) out.push(t); }
      else if (tag === 'HR') out.push('---');
      else if (tag === 'PRE') {
        const code = n.querySelector('code');
        const cls = ((code && code.getAttribute('class')) || n.getAttribute('class') || '') + ' ' + (n.getAttribute('data-language') || '');
        const lang = (/(?:language|lang)-([\w+-]+)/.exec(cls) || [])[1] || (n.getAttribute('data-language') || '');
        const text = (code || n).textContent.replace(/\n$/, '');
        const fence = /```/.test(text) ? '~~~' : '```';
        out.push(fence + lang + '\n' + text + '\n' + fence);
      } else if (tag === 'TABLE') { const t = tableToMarkdown(n); if (t) out.push(t); }
      else if (tag === 'UL' || tag === 'OL') out.push(listToMarkdown(n, 0));
      else if (tag === 'BLOCKQUOTE') out.push(blocks(n).split('\n').map((l) => '> ' + l).join('\n'));
      else { const inner = blocks(n); if (inner) out.push(inner); }
    }
    flush();
    return out.join('\n\n');
  }

  function htmlToMarkdown(html, DOMParserCtor) {
    const Ctor = DOMParserCtor || (typeof DOMParser !== 'undefined' ? DOMParser : null);
    if (!Ctor || !html) return '';
    const doc = new Ctor().parseFromString(html, 'text/html');
    return blocks(doc.body).replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  function htmlTableCount(html) {
    return (String(html).match(/<table\b/gi) || []).length;
  }

  // ======================================================================
  // Markdown text helpers
  // ======================================================================
  const TABLE_SEP = /^(?=.*\|)\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  const isRow = (l) => /\|/.test(l) && !/^\s*```/.test(l);

  function splitRow(line) {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
    return t.split(/(?<!\\)\|/).map((c) => c.trim());
  }

  function alignOf(sep) {
    return splitRow(sep).map((c) => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : null));
  }

  function looksLikeMarkdown(text) {
    if (!text) return false;
    const lines = text.split(/\r?\n/);
    let score = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^#{1,6}\s+\S/.test(l)) score += 2;
      if (/^\s*```/.test(l)) score += 2;
      if (isRow(l) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) score += 4;
      if (/^\s*[-*]\s+\S/.test(l)) score += 0.5;
      if (/\*\*[^*]+\*\*/.test(l)) score += 0.5;
    }
    return score >= 4;
  }

  // Re-align every pipe table in a Markdown text (AI chats often emit unaligned |a|b| tables).
  function alignTables(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*(```|~~~)/.test(l)) { inFence = !inFence; out.push(l); continue; }
      if (!inFence && isRow(l) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        const rows = [splitRow(l)];
        const align = alignOf(lines[i + 1]);
        let j = i + 2;
        while (j < lines.length && isRow(lines[j]) && lines[j].trim()) { rows.push(splitRow(lines[j])); j++; }
        const n = Math.max(...rows.map((r) => r.length));
        const full = rows.map((r) => { const c = r.map((x) => x.replace(/\\\|/g, '|')); while (c.length < n) c.push(''); return c; });
        let md = Tables.formatRows(full, 'markdown').split('\n');
        // keep the column alignment markers
        md[1] = '| ' + md[1].slice(2, -2).split(' | ').map((d, k) => {
          const a = align[k];
          if (a === 'center') return ':' + d.slice(1, -1) + ':';
          if (a === 'right') return d.slice(0, -1) + ':';
          if (a === 'left') return ':' + d.slice(1);
          return d;
        }).join(' | ') + ' |';
        out.push(...md);
        i = j - 1;
        continue;
      }
      out.push(l);
    }
    return out.join('\n');
  }

  function countTables(text) {
    const lines = text.split(/\r?\n/);
    let n = 0;
    for (let i = 0; i + 1 < lines.length; i++) if (isRow(lines[i]) && TABLE_SEP.test(lines[i + 1])) n++;
    return n;
  }

  // ======================================================================
  // Markdown -> DOM (safe: only createElement / textContent)
  // ======================================================================
  function render(md, doc) {
    const D = doc || document;
    const frag = D.createDocumentFragment();
    const lines = md.replace(/\r\n?/g, '\n').split('\n');
    const el = (tag, line, cls) => { const e = D.createElement(tag); if (line != null) e.setAttribute('data-line', String(line)); if (cls) e.className = cls; return e; };

    const addInline = (parent, text) => {
      // tokens: `code`, **bold**, *em*, _em_, ~~del~~, [text](url), <br>, bare URLs, \escapes
      const re = /(\\[\\`*_[\]{}()#+\-.!|>~])|(`+)([\s\S]*?[^`])\2(?!`)|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|~~([^~]+?)~~|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|<br\s*\/?>|(https?:\/\/[^\s<>)]+)/g;
      let last = 0;
      let m;
      while ((m = re.exec(text))) {
        if (m.index > last) parent.appendChild(D.createTextNode(text.slice(last, m.index)));
        if (m[1]) parent.appendChild(D.createTextNode(m[1].slice(1)));
        else if (m[2]) { const c = D.createElement('code'); c.textContent = m[3]; parent.appendChild(c); }
        else if (m[4] || m[5]) { const b = D.createElement('strong'); addInline(b, m[4] || m[5]); parent.appendChild(b); }
        else if (m[6] || m[7]) { const i = D.createElement('em'); addInline(i, m[6] || m[7]); parent.appendChild(i); }
        else if (m[8]) { const s = D.createElement('del'); addInline(s, m[8]); parent.appendChild(s); }
        else if (m[9]) { const a = D.createElement('a'); a.href = m[10]; a.target = '_blank'; a.rel = 'noopener'; addInline(a, m[9]); parent.appendChild(a); }
        else if (m[11]) { const a = D.createElement('a'); a.href = m[11]; a.target = '_blank'; a.rel = 'noopener'; a.textContent = m[11]; parent.appendChild(a); }
        else parent.appendChild(D.createElement('br'));
        last = re.lastIndex;
      }
      if (last < text.length) parent.appendChild(D.createTextNode(text.slice(last)));
    };

    let i = 0;
    const listRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      let m;
      if ((m = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(l))) {
        const fence = m[1];
        const pre = el('pre', i);
        const code = D.createElement('code');
        if (m[2]) { code.className = 'language-' + m[2]; pre.setAttribute('data-lang', m[2]); }
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence[0].repeat(3))) body.push(lines[i++]);
        i++;
        code.textContent = body.join('\n');
        pre.appendChild(code);
        frag.appendChild(pre);
        continue;
      }
      if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l))) {
        const hEl = el('h' + m[1].length, i);
        addInline(hEl, m[2]);
        frag.appendChild(hEl);
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l) && !isRow(l)) { frag.appendChild(el('hr', i)); i++; continue; }
      if (isRow(l) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        const align = alignOf(lines[i + 1]);
        const head = splitRow(l);
        const wrap = el('div', i, 'md-table-wrap');
        const table = D.createElement('table');
        table.className = 'md-table';
        const thead = D.createElement('thead');
        const tr = D.createElement('tr');
        head.forEach((c, k) => { const th = D.createElement('th'); if (align[k]) th.style.textAlign = align[k]; addInline(th, c); tr.appendChild(th); });
        thead.appendChild(tr);
        table.appendChild(thead);
        const tbody = D.createElement('tbody');
        let j = i + 2;
        while (j < lines.length && isRow(lines[j]) && lines[j].trim()) {
          const row = D.createElement('tr');
          row.setAttribute('data-line', String(j));
          const cells = splitRow(lines[j]);
          for (let k = 0; k < head.length; k++) {
            const td = D.createElement('td');
            if (align[k]) td.style.textAlign = align[k];
            addInline(td, cells[k] || '');
            row.appendChild(td);
          }
          tbody.appendChild(row);
          j++;
        }
        table.appendChild(tbody);
        wrap.appendChild(table);
        frag.appendChild(wrap);
        i = j;
        continue;
      }
      if (/^\s*>/.test(l)) {
        const start = i;
        const body = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
        const bq = el('blockquote', start);
        bq.appendChild(render(body.join('\n'), D));
        frag.appendChild(bq);
        continue;
      }
      if (listRe.test(l)) {
        // collect the list block, then build nested lists by indentation
        const items = [];
        while (i < lines.length && (listRe.test(lines[i]) || (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length))) {
          const lm = listRe.exec(lines[i]);
          if (lm) items.push({ indent: lm[1].replace(/\t/g, '    ').length, ordered: /\d/.test(lm[2]), text: lm[3], line: i, start: parseInt(lm[2], 10) });
          else items[items.length - 1].text += ' ' + lines[i].trim();
          i++;
        }
        const stack = [];
        let top = null;
        for (const it of items) {
          while (stack.length && it.indent < stack[stack.length - 1].indent) stack.pop();
          let cur = stack[stack.length - 1];
          if (!cur || it.indent > cur.indent) {
            const list = el(it.ordered ? 'ol' : 'ul', it.line);
            if (it.ordered && it.start > 1) list.setAttribute('start', String(it.start));
            if (cur && cur.lastLi) cur.lastLi.appendChild(list);
            else if (!top) top = list;
            else top.appendChild(list);
            cur = { indent: it.indent, list, lastLi: null };
            stack.push(cur);
          }
          const li = el('li', it.line);
          const tm = /^\[( |x|X)\]\s+(.*)$/.exec(it.text);
          if (tm) {
            const box = D.createElement('input');
            box.type = 'checkbox';
            box.disabled = true;
            box.checked = tm[1] !== ' ';
            li.appendChild(box);
            li.appendChild(D.createTextNode(' '));
            addInline(li, tm[2]);
          } else addInline(li, it.text);
          cur.list.appendChild(li);
          cur.lastLi = li;
        }
        if (top) frag.appendChild(top);
        continue;
      }
      // paragraph
      const start = i;
      const body = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s|^\s*(```|~~~)|^\s*>/.test(lines[i]) && !listRe.test(lines[i]) &&
        !(isRow(lines[i]) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]))) body.push(lines[i++].trim());
      if (!body.length) { body.push(lines[i++].trim()); }
      const p = el('p', start);
      body.forEach((t, k) => { if (k) p.appendChild(D.createElement('br')); addInline(p, t); });
      frag.appendChild(p);
    }
    return frag;
  }

  // Tables inside an element as row arrays (for "copy table", sorting, table view).
  function tableRows(table) {
    return Array.from(table.rows).map((tr) => Array.from(tr.cells).map((c) => c.textContent.trim()));
  }

  return { htmlToMarkdown, htmlTableCount, looksLikeMarkdown, alignTables, countTables, render, tableRows, splitRow };
});
