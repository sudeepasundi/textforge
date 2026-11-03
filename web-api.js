/* Browser implementation of window.api (the desktop app gets it from preload.js).
   Uses the File System Access API in Chrome / Edge so Open + Save work on real files,
   and falls back to file inputs, downloads and the clipboard elsewhere. */
(function () {
  'use strict';
  const cfg = Object.assign({ target: 'selfhost', canDownload: true }, window.TF_WEB || {});

  // ---------- IndexedDB (session + file handles) ----------
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve) => {
        try {
          const req = indexedDB.open('textforge', 1);
          req.onupgradeneeded = () => { req.result.createObjectStore('kv'); };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
    }
    return dbp;
  }
  async function idbGet(key) {
    const d = await db();
    if (!d) return undefined;
    return new Promise((resolve) => {
      try {
        const r = d.transaction('kv').objectStore('kv').get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(undefined);
      } catch { resolve(undefined); }
    });
  }
  async function idbSet(key, val) {
    const d = await db();
    if (!d) return false;
    return new Promise((resolve) => {
      try {
        const tx = d.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch { resolve(false); }
    });
  }

  // ---------- files ----------
  // Browsers do not expose real paths, so each opened file gets a pseudo path "web:<n>/<name>".
  const handles = new Map(); // pseudo path -> FileSystemFileHandle
  const files = new Map(); // pseudo path -> File (no handle: drag-drop / file input)
  let seq = Date.now() % 100000;
  const pseudo = (name) => 'web:' + (++seq) + '/' + name;
  const hasFSA = 'showOpenFilePicker' in window;
  // claude.ai hosted page: ask for the downloads capability early so it is ready when Save is clicked.
  let downloadsP = Promise.resolve(null);
  try {
    if (cfg.target === 'artifact' && window.claude && typeof window.claude.use === 'function') {
      downloadsP = window.claude.use('downloads').catch(() => null);
    }
  } catch { /* not hosted */ }

  idbGet('handles').then((saved) => {
    if (saved && typeof saved === 'object') for (const [k, v] of Object.entries(saved)) if (!handles.has(k)) handles.set(k, v);
  });
  const persistHandles = () => {
    const obj = {};
    for (const [k, v] of handles) obj[k] = v;
    idbSet('handles', obj);
  };

  function decode(buf) {
    const b = new Uint8Array(buf);
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { content: new TextDecoder('utf-8').decode(b.subarray(3)), enc: 'utf8-bom' };
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { content: new TextDecoder('utf-16le').decode(b.subarray(2)), enc: 'utf16le' };
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return { content: new TextDecoder('utf-16be').decode(b.subarray(2)), enc: 'utf16le' };
    if (b.subarray(0, 8000).includes(0)) return { error: 'This looks like a binary file, not text.' };
    try { return { content: new TextDecoder('utf-8', { fatal: true }).decode(b), enc: 'utf8' }; }
    catch { return { content: new TextDecoder('windows-1252').decode(b), enc: 'latin1' }; }
  }
  function encode(content, enc) {
    if (enc === 'utf16le') {
      const out = new Uint8Array(2 + content.length * 2);
      out[0] = 0xff; out[1] = 0xfe;
      for (let i = 0; i < content.length; i++) { const c = content.charCodeAt(i); out[2 + i * 2] = c & 255; out[3 + i * 2] = c >> 8; }
      return out;
    }
    if (enc === 'latin1') {
      const out = new Uint8Array(content.length);
      for (let i = 0; i < content.length; i++) { const c = content.charCodeAt(i); out[i] = c < 256 ? c : 63; }
      return out;
    }
    const body = new TextEncoder().encode(content);
    if (enc === 'utf8-bom') { const out = new Uint8Array(body.length + 3); out.set([0xef, 0xbb, 0xbf]); out.set(body, 3); return out; }
    return body;
  }

  async function readFileObj(file, p) {
    if (file.size > 500 * 1024 * 1024) return { path: p, error: 'File is larger than 500 MB. Split it into smaller parts first.' };
    const d = decode(await file.arrayBuffer());
    return d.error ? { path: p, error: d.error } : { path: p, content: d.content, enc: d.enc };
  }

  // <input type=file> fallback (Firefox, Safari, and pages inside another site's frame such as claude.ai).
  // Windows can take several seconds to hand over a OneDrive / network file after the dialog closes,
  // so only the browser's own "cancel" event counts as cancelling.
  function pickWithInput({ multiple = true } = {}) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = multiple;
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('cancel', () => { input.remove(); resolve([]); });
      input.addEventListener('change', () => {
        const picked = Array.from(input.files || []);
        input.remove();
        resolve(picked);
      });
      input.click();
    });
  }
  async function readPicked(list) {
    const out = [];
    for (const f of list) {
      const p = pseudo(f.name);
      files.set(p, f);
      out.push(await readFileObj(f, p));
    }
    return out;
  }

  // Inside a frame from another site the modern picker always fails, and trying it first can use up
  // the click that the fallback needs, so go straight to the fallback there.
  let framed = false;
  try { framed = window.top !== window.self; } catch { framed = true; }
  const canPick = hasFSA && !framed;

  async function openDialog() {
    if (canPick) {
      try {
        const hs = await window.showOpenFilePicker({ multiple: true });
        const out = [];
        for (const h of hs) {
          const p = pseudo(h.name);
          handles.set(p, h);
          out.push(await readFileObj(await h.getFile(), p));
        }
        persistHandles();
        return out;
      } catch (e) {
        if (e && e.name === 'AbortError') return [];
        // SecurityError: fall through to <input type=file>
      }
    }
    return readPicked(await pickWithInput());
  }

  // Has the file changed on disk? Files opened with a handle can be checked and re-read at any time.
  // Files opened through <input type=file> are one-time copies: once the file changes the browser
  // refuses to read it again (NotReadableError), which is itself the sign that it changed.
  async function stat(p) {
    const h = handles.get(p);
    if (h) {
      try {
        if (h.queryPermission && (await h.queryPermission({ mode: 'read' })) !== 'granted') return { ok: false, reason: 'permission' };
        const f = await h.getFile();
        return { ok: true, size: f.size, mtime: f.lastModified };
      } catch (e) {
        return { ok: false, reason: e && e.name === 'NotFoundError' ? 'missing' : 'error' };
      }
    }
    const f = files.get(p);
    if (f) {
      try { await f.slice(0, 1).arrayBuffer(); return { ok: true, size: f.size, mtime: f.lastModified }; }
      catch { return { ok: false, reason: 'snapshot' }; }
    }
    return { ok: false, reason: 'unknown' };
  }

  // The bytes added to a file from a byte offset on (for appended log lines).
  async function readFrom(p, offset) {
    const h = handles.get(p);
    if (!h) return { path: p, error: 'not available' };
    try {
      const f = await h.getFile();
      return { path: p, content: await f.slice(offset, Math.min(f.size, offset + 50 * 1024 * 1024)).text(), size: f.size };
    } catch (e) {
      return { path: p, error: e.message };
    }
  }

  // Pick a one-time-copy file again so its new contents can be loaded into the same tab.
  async function repick(p) {
    const [f] = await pickWithInput({ multiple: false });
    if (!f) return { path: p, canceled: true };
    files.set(p, f);
    return readFileObj(f, p);
  }

  // Drag and drop: ask for a live file handle where the browser offers one, so the tab can follow
  // changes; otherwise keep the one-time copy. Must be called during the drop event.
  function dropPaths(dt) {
    const items = Array.from(dt.items || []).filter((it) => it.kind === 'file');
    const fileList = Array.from(dt.files || []);
    const handleP = items.map((it) => (typeof it.getAsFileSystemHandle === 'function' ? it.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null)));
    return Promise.all(handleP).then((hs) => {
      const out = [];
      fileList.forEach((f, i) => {
        const h = hs[i];
        const p = pseudo(f.name);
        if (h && h.kind === 'file') { handles.set(p, h); } else files.set(p, f);
        out.push(p);
      });
      if (hs.some((h) => h && h.kind === 'file')) persistHandles();
      return out;
    });
  }

  async function readFile(p) {
    try {
      if (files.has(p)) return readFileObj(files.get(p), p);
      const h = handles.get(p);
      if (h) {
        if (h.queryPermission && (await h.queryPermission({ mode: 'read' })) !== 'granted') return { path: p, error: 'Permission needed. Open the file again.' };
        return readFileObj(await h.getFile(), p);
      }
    } catch (e) {
      return { path: p, error: e.message };
    }
    return { path: p, error: 'File is no longer available. Open it again.' };
  }

  async function writeHandle(h, content, enc) {
    if (h.queryPermission && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Permission to save was not given.');
    }
    const w = await h.createWritable();
    await w.write(encode(content, enc));
    await w.close();
  }

  async function saveFile({ path: p, content, enc }) {
    const h = handles.get(p);
    if (!h) return saveAs({ defaultPath: p, content, enc });
    try {
      await writeHandle(h, content, enc);
      return { ok: true, path: p };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function saveAs({ defaultPath, content, enc }) {
    const name = String(defaultPath || 'untitled.txt').replace(/^.*\//, '') || 'untitled.txt';
    if ('showSaveFilePicker' in window) {
      try {
        const h = await window.showSaveFilePicker({ suggestedName: name });
        await writeHandle(h, content, enc);
        const p = pseudo(h.name);
        handles.set(p, h);
        persistHandles();
        return { ok: true, path: p };
      } catch (e) {
        if (e && e.name === 'AbortError') return { ok: false, canceled: true };
        if (!(e && e.name === 'SecurityError')) return { ok: false, error: e.message };
      }
    }
    // Hosted on claude.ai: files are handed over through the platform's downloads capability
    // (the viewer confirms each save). Only some extensions are allowed, so others get ".txt".
    const dl = await downloadsP;
    if (dl) {
      const allowed = /\.(txt|json|md|csv|html|svg)$/i.test(name);
      const filename = allowed ? name : name + '.txt';
      try {
        await dl.save({ filename, data: new Blob([encode(content, enc)]) });
        return { ok: true, path: 'download:' + (++seq) + '/' + name, downloaded: true };
      } catch (e) {
        if (e && e.code === 'declined') return { ok: false, canceled: true };
        if (e && e.code === 'rate_limited') return { ok: false, error: 'A save prompt is already open. Finish it, then try again.' };
        // anything else: fall through to the clipboard
      }
    }
    if (cfg.canDownload) {
      const blob = new Blob([encode(content, enc)], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      return { ok: true, path: 'download:' + (++seq) + '/' + name, downloaded: true };
    }
    // Hosted page: downloads are blocked, so hand the content over through the clipboard.
    const copied = await clipboardWrite({ text: content });
    return { ok: false, error: copied ? 'Saving files is not available on this page. The content was copied to your clipboard instead.' : 'Saving files is not available on this page.' };
  }

  // ---------- clipboard ----------
  function execCopy(text, html) {
    const el = document.createElement('div');
    el.contentEditable = 'true';
    el.style.cssText = 'position:fixed;left:-9999px;top:0;white-space:pre';
    if (html) el.innerHTML = html; else el.textContent = text;
    document.body.appendChild(el);
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    const onCopy = (e) => {
      if (!html) return;
      e.clipboardData.setData('text/html', html);
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
    };
    document.addEventListener('copy', onCopy, true);
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.removeEventListener('copy', onCopy, true);
    sel.removeAllRanges();
    el.remove();
    return ok;
  }

  async function clipboardWrite({ text, html }) {
    try {
      if (html && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        })]);
        return true;
      }
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch { /* fall back */ }
    return execCopy(text, html);
  }

  // ---------- live tail (Chrome / Edge with file handles) ----------
  const tails = new Map();
  let tailCb = null;
  async function tailStart(p) {
    const h = handles.get(p);
    if (!h) return { ok: false, error: 'Following needs a file opened with the Open button in Chrome or Edge.' };
    try {
      let size = (await h.getFile()).size;
      const timer = setInterval(async () => {
        let f;
        try { f = await h.getFile(); } catch { return; }
        if (f.size === size || !tailCb) return;
        if (f.size < size) {
          size = f.size;
          const r = await readFileObj(f, p);
          if (!r.error) tailCb({ path: p, reset: true, text: r.content });
          return;
        }
        const chunk = await f.slice(size, Math.min(f.size, size + 20 * 1024 * 1024)).text();
        size += new TextEncoder().encode(chunk).length;
        tailCb({ path: p, reset: false, text: chunk });
      }, 1000);
      tails.set(p, timer);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  function tailStop(p) { clearInterval(tails.get(p)); tails.delete(p); return Promise.resolve(true); }

  // ---------- session ----------
  let lastSession = null;
  async function loadSession() {
    const s = await idbGet('session');
    if (s) return s;
    try { return JSON.parse(localStorage.getItem('tf-session') || 'null'); } catch { return null; }
  }
  function saveSession(data) {
    lastSession = data;
    return idbSet('session', data);
  }

  // ---------- opened from the OS (installed PWA file handler) ----------
  let openCb = null;
  const pendingOpen = [];
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      const paths = [];
      for (const h of params.files || []) { const p = pseudo(h.name); handles.set(p, h); paths.push(p); }
      if (!paths.length) return;
      persistHandles();
      if (openCb) openCb(paths); else pendingOpen.push(...paths);
    });
  }

  window.api = {
    platform: 'web',
    capabilities: { embeddedCopilot: false, sessionStoresContent: true, canDownload: cfg.canDownload, fileAccess: hasFSA },
    startupFiles: async () => { const out = []; for (const p of pendingOpen.splice(0)) out.push(await readFile(p)); return out; },
    openDialog,
    readFile,
    saveFile,
    saveAs,
    loadSession,
    saveSession,
    saveSessionSync: (data) => { saveSession(data); },
    clipboardWrite,
    setTitle: (t) => { document.title = t; return Promise.resolve(); },
    openExternal: (url) => { try { window.open(url, '_blank', 'noopener'); } catch { /* blocked */ } return Promise.resolve(); },
    pathForFile: (file) => { const p = pseudo(file.name); files.set(p, file); return p; },
    onOpenPaths: (cb) => { openCb = cb; },
    tailStart,
    tailStop,
    stat,
    readFrom,
    repick,
    dropPaths,
    liveFiles: canPick,
    onTailData: (cb) => { tailCb = cb; },
    _last: () => lastSession,
  };
})();
