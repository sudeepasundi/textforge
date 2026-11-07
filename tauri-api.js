/* TextForge desktop on Tauri 2: the `window.api` contract (same as preload.js / web-api.js),
 * backed by the Rust commands in src-tauri/src/main.rs. Loaded before renderer.js.
 */
(function () {
  'use strict';
  const T = window.__TAURI__;
  const invoke = T.core.invoke;
  const win = T.window.getCurrentWindow();
  const utf8 = new TextDecoder('utf-8');

  // File contents arrive as raw bytes: "<header>\n<UTF-8 text>".
  function splitHeader(buf) {
    const bytes = new Uint8Array(buf);
    const nl = bytes.indexOf(10);
    return [utf8.decode(bytes.subarray(0, nl)), utf8.decode(bytes.subarray(nl + 1))];
  }
  async function readFile(path) {
    try {
      const [enc, content] = splitHeader(await invoke('read_file', { path }));
      return { path, content, enc };
    } catch (e) {
      return { path, error: String(e) };
    }
  }

  // ---------- session: written to disk normally; on close, a copy also goes to localStorage synchronously ----------
  const SESSION_KEY = 'tf-session-closing';
  let lastSave = Promise.resolve();
  function saveSession(data) {
    const body = JSON.stringify({ t: Date.now(), data });
    lastSave = invoke('save_session', { data: body }).catch(() => false);
    return lastSave;
  }
  function saveSessionSync(data) {
    const body = JSON.stringify({ t: Date.now(), data });
    try { localStorage.setItem(SESSION_KEY, body); } catch { /* too big for localStorage: the disk copy below still runs */ }
    lastSave = invoke('save_session', { data: body }).catch(() => false);
    return true;
  }
  async function loadSession() {
    const parse = (s) => { try { const o = JSON.parse(s); return o && o.t ? o : null; } catch { return null; } };
    const disk = parse(await invoke('load_session').catch(() => null));
    let local = null;
    try { local = parse(localStorage.getItem(SESSION_KEY)); } catch { /* ignore */ }
    const best = [disk, local].filter(Boolean).sort((a, b) => b.t - a.t)[0];
    return best ? best.data : null;
  }

  // ---------- live tail ("follow file"): polls the size once a second ----------
  const tails = new Map();
  const tailListeners = [];
  const emitTail = (d) => tailListeners.forEach((cb) => cb(d));
  async function tailStart(path) {
    tailStop(path);
    const s = await invoke('stat', { path });
    if (!s.ok) return { ok: false, error: s.reason === 'missing' ? 'The file no longer exists.' : 'Cannot read the file.' };
    const state = { size: s.size, busy: false };
    state.timer = setInterval(async () => {
      if (state.busy) return;
      state.busy = true;
      try {
        const st = await invoke('stat', { path });
        if (!st.ok || st.size === state.size) return;
        if (st.size < state.size) { // truncated / rotated: reload everything
          state.size = st.size;
          const r = await readFile(path);
          if (!r.error) emitTail({ path, reset: true, text: r.content });
          return;
        }
        const [head, text] = splitHeader(await invoke('read_from', { path, offset: state.size }));
        state.size += Number(head.split(' ')[1]) || 0; // bytes actually read
        if (text) emitTail({ path, reset: false, text });
      } catch { /* try again next tick */ } finally { state.busy = false; }
    }, 1000);
    tails.set(path, state);
    return { ok: true };
  }
  function tailStop(path) {
    const t = tails.get(path);
    if (t) { clearInterval(t.timer); tails.delete(path); }
    return Promise.resolve(true);
  }

  // ---------- embedded Copilot: a native webview kept over the pane's placeholder element ----------
  let cpEl = null;
  let cpUrl = '';
  let cpShown = false;
  let cpLast = '';
  let cpFailed = false;
  // Native webviews sit above the page, so hide Copilot while a dialog, the palette or a menu is open.
  const covered = () => !!document.querySelector('#modal:not([hidden]), #palette:not([hidden]), .menu:not([hidden]), .monaco-menu-container');
  function cpTick() {
    if (!cpEl) return;
    requestAnimationFrame(cpTick);
    const r = cpEl.isConnected ? cpEl.getBoundingClientRect() : null;
    const visible = r && r.width > 20 && r.height > 20 && !cpEl.closest('[hidden]') && !covered();
    if (!visible) {
      if (cpShown) { cpShown = false; cpLast = ''; invoke('copilot_hide'); }
      return;
    }
    const key = [r.left, r.top, r.width, r.height].map(Math.round).join(',');
    if (cpShown && key === cpLast) return;
    const args = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    cpLast = key;
    if (!cpShown) {
      cpShown = true;
      invoke('copilot_show', Object.assign({ url: cpUrl }, args)).catch((e) => {
        if (cpFailed) return;
        cpFailed = true;
        cpEl.textContent = 'Copilot did not load (' + e + '). Use the open-in-browser button.';
      });
    } else {
      invoke('copilot_bounds', args);
    }
  }
  // Returns an element that stands in for Electron's <webview> inside the Copilot pane.
  function copilotView(url) {
    const el = document.createElement('div');
    el.className = 'cp-native';
    el.reload = () => invoke('copilot_reload');
    cpEl = el;
    cpUrl = url;
    cpShown = false;
    cpFailed = false;
    requestAnimationFrame(cpTick);
    return el;
  }
  async function copilotSignOut() {
    cpEl = null;
    cpShown = false;
    await invoke('copilot_hide').catch(() => {});
    return invoke('copilot_sign_out');
  }

  // ---------- window buttons (the top bar is the title bar; Windows draws no frame) ----------
  function windowControls() {
    const bar = document.getElementById('topbar');
    if (!bar || document.getElementById('wc')) return;
    const svg = (d) => '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="' + d + '"/></svg>';
    const box = document.createElement('div');
    box.id = 'wc';
    box.innerHTML =
      '<button class="wc-btn" data-wc="min" title="Minimize" aria-label="Minimize">' + svg('M0 5h10') + '</button>' +
      '<button class="wc-btn" data-wc="max" title="Maximize" aria-label="Maximize">' + svg('M.5.5h9v9h-9z') + '</button>' +
      '<button class="wc-btn wc-close" data-wc="close" title="Close" aria-label="Close">' + svg('M0 0l10 10M10 0 0 10') + '</button>';
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-wc]');
      if (!b) return;
      if (b.dataset.wc === 'min') win.minimize();
      else if (b.dataset.wc === 'max') win.toggleMaximize();
      else win.close();
    });
    bar.appendChild(box);
    const maxBtn = box.querySelector('[data-wc="max"]');
    const syncMax = async () => {
      const m = await win.isMaximized().catch(() => false);
      document.body.classList.toggle('win-max', m);
      maxBtn.title = maxBtn.ariaLabel = m ? 'Restore' : 'Maximize';
      maxBtn.innerHTML = m ? svg('M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z') : svg('M.5.5h9v9h-9z');
    };
    syncMax();
    win.onResized(syncMax);
    // Double-clicking the bar maximizes, as in any Windows title bar.
    bar.addEventListener('dblclick', (e) => { if (e.target === bar || e.target.closest('.brand')) win.toggleMaximize(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', windowControls);
  else windowControls();
  document.body && document.body.classList.add('tauri');
  document.addEventListener('DOMContentLoaded', () => document.body.classList.add('tauri'));

  // Closing the window (button, Alt+F4, taskbar): save the session first.
  win.onCloseRequested(async () => {
    try { window.dispatchEvent(new Event('beforeunload')); } catch { /* ignore */ }
    await Promise.race([lastSave, new Promise((r) => setTimeout(r, 2000))]);
  });

  // ---------- drag and drop ----------
  // Native file drops are turned off so the page's own drag and drop (tabs, snap layouts) keeps working,
  // which means the browser gives no file path. Dropped files open as new tabs; Save asks where to save.
  async function dropPaths(dt) {
    const files = Array.from((dt && dt.files) || []);
    for (const f of files) {
      if (f.size > 500 * 1024 * 1024) continue;
      const text = await f.text();
      if (window.__tf && window.__tf.newTab) window.__tf.activate(window.__tf.newTab({ name: f.name, content: text }));
    }
    return [];
  }

  window.api = {
    platform: 'tauri',
    os: 'win32',
    frameless: true,
    liveFiles: true,
    capabilities: { embeddedCopilot: true, nativeCopilot: true },
    setTitleBar: () => Promise.resolve(true), // the window buttons use the theme's CSS colours
    startupFiles: async () => Promise.all((await invoke('startup_files')).map(readFile)),
    async openDialog() {
      const picked = await invoke('open_dialog');
      // Big files are read in a second step so the window can show progress first.
      return Promise.all(picked.map((p) => (p.size > 30 * 1024 * 1024 ? { path: p.path, size: p.size, deferred: true } : readFile(p.path))));
    },
    readFile,
    stat: (path) => invoke('stat', { path }),
    async readFrom(path, offset) {
      try {
        const [head, content] = splitHeader(await invoke('read_from', { path, offset }));
        return { path, content, size: Number(head.split(' ')[0]) };
      } catch (e) { return { path, error: String(e) }; }
    },
    sample: async () => ({ content: await invoke('sample') }),
    saveFile: ({ path, content, enc }) => invoke('save_file', { path, content, enc: enc || 'utf8' }),
    renameFile: ({ path, name }) => invoke('rename_file', { path, name }),
    saveAs: ({ defaultPath, content, enc }) => invoke('save_as', { defaultPath: defaultPath || '', content, enc: enc || 'utf8' }),
    loadSession,
    saveSession,
    saveSessionSync,
    clipboardWrite: ({ text, html }) => invoke('clipboard_write', { text: text || '', html: html || null }),
    setTitle: (t) => win.setTitle(t),
    openExternal: (url) => invoke('open_external', { url }),
    copilotView,
    copilotInsert: (text) => invoke('copilot_insert', { text }),
    copilotSignOut,
    dropPaths,
    pathForFile: () => '',
    onOpenPaths: (cb) => T.event.listen('open-paths', (e) => cb(e.payload)),
    tailStart,
    tailStop,
    onTailData: (cb) => tailListeners.push(cb),
  };
})();
