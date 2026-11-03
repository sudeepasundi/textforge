const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, screen, shell } = require('electron');

// Present a normal Chromium user agent so Microsoft sign-in pages treat the embedded Copilot like a browser.
app.userAgentFallback = app.userAgentFallback.replace(/\s?(Electron|textforge|TextForge)\/\S+/gi, '');
const path = require('path');
const fs = require('fs');

const MAX_BYTES = 500 * 1024 * 1024; // ~500 MB: JavaScript strings top out near 512 million characters

// Big logs need more than the default JavaScript heap (the file, the editor's copy and the log index).
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=6144');
const sessionPath = () => path.join(app.getPath('userData'), 'session.json');
const boundsPath = () => path.join(app.getPath('userData'), 'window.json');

let win = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function fileArgs(argv) {
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((a) => a && !a.startsWith('-'))
    .filter((a) => {
      try { return fs.statSync(a).isFile(); } catch { return false; }
    })
    .map((a) => path.resolve(a));
}

// ---------- encoding ----------
function decode(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { content: buf.subarray(3).toString('utf8'), enc: 'utf8-bom' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { content: buf.subarray(2).toString('utf16le'), enc: 'utf16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return { content: swapped.toString('utf16le'), enc: 'utf16le' };
  }
  if (buf.subarray(0, 8000).includes(0)) return { error: 'This looks like a binary file, not text.' };
  try {
    return { content: new TextDecoder('utf-8', { fatal: true }).decode(buf), enc: 'utf8' };
  } catch {
    return { content: buf.toString('latin1'), enc: 'latin1' };
  }
}

function encode(content, enc) {
  switch (enc) {
    case 'utf8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf8')]);
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]);
    case 'latin1':
      return Buffer.from(content, 'latin1');
    default:
      return Buffer.from(content, 'utf8');
  }
}

function readFileSafe(p) {
  try {
    const st = fs.statSync(p);
    if (st.size > MAX_BYTES) return { path: p, error: 'File is larger than 500 MB. Split it first (for example with a log rotation tool or: split -l 2000000).' };
    const d = decode(fs.readFileSync(p));
    if (d.error) return { path: p, error: d.error };
    return { path: p, content: d.content, enc: d.enc };
  } catch (e) {
    return { path: p, error: e.message };
  }
}

// ---------- window ----------
function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(boundsPath(), 'utf8'));
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
    });
    if (visible) return b;
  } catch { /* first run */ }
  return { width: 1200, height: 780 };
}

function createWindow() {
  const b = loadBounds();
  win = new BrowserWindow({
    ...b,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#1a2029',
    title: 'TextForge',
    // One title bar: TextForge's own top bar, with the system window buttons drawn over its right end
    // (Windows / Linux) or the traffic lights on the left (macOS).
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? true : { color: '#212833', symbolColor: '#8994a6', height: 40 },
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  if (b.maximized) win.maximize();
  Menu.setApplicationMenu(null);
  win.loadFile('index.html');

  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.on('close', () => {
    try {
      const nb = win.getNormalBounds();
      fs.writeFileSync(boundsPath(), JSON.stringify({ ...nb, maximized: win.isMaximized() }));
    } catch { /* ignore */ }
  });
  win.on('closed', () => { win = null; });
}

app.on('second-instance', (_e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  const files = fileArgs(argv);
  if (files.length) win.webContents.send('open-paths', files);
});

if (app.hasSingleInstanceLock()) {
  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
}

app.on('window-all-closed', () => app.quit());

// ---------- IPC ----------
ipcMain.handle('startup-files', () => fileArgs(process.argv).map(readFileSafe));

ipcMain.handle('dialog:open', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  if (r.canceled) return [];
  // Big files are read in a second step so the window can show progress first.
  return r.filePaths.map((p) => {
    let size = 0;
    try { size = fs.statSync(p).size; } catch { /* readFileSafe reports it */ }
    return size > 30 * 1024 * 1024 ? { path: p, size, deferred: true } : readFileSafe(p);
  });
});

ipcMain.handle('file:read', (_e, p) => readFileSafe(p));

// Change detection for open tabs (the window polls every couple of seconds).
ipcMain.handle('file:stat', (_e, p) => {
  try { const st = fs.statSync(p); return { ok: true, size: st.size, mtime: st.mtimeMs }; }
  catch (e) { return { ok: false, reason: e.code === 'ENOENT' ? 'missing' : 'error' }; }
});
// Bytes appended after an offset (big logs: avoids re-reading the whole file).
ipcMain.handle('file:readFrom', (_e, p, offset) => {
  let fd;
  try {
    const size = fs.statSync(p).size;
    const len = Math.max(0, Math.min(size - offset, 50 * 1024 * 1024));
    const buf = Buffer.alloc(len);
    fd = fs.openSync(p, 'r');
    fs.readSync(fd, buf, 0, len, offset);
    return { path: p, content: buf.toString('utf8'), size };
  } catch (e) {
    return { path: p, error: e.message };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
});
ipcMain.handle('sample', () => readFileSafe(path.join(__dirname, 'samples', 'order-service.log')));

ipcMain.handle('file:save', (_e, { path: p, content, enc }) => {
  try {
    fs.writeFileSync(p, encode(content, enc));
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('dialog:saveAs', async (_e, { defaultPath, content, enc }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(r.filePath, encode(content, enc));
    return { ok: true, path: r.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('session:load', () => {
  try { return JSON.parse(fs.readFileSync(sessionPath(), 'utf8')); } catch { return null; }
});
ipcMain.handle('session:save', (_e, data) => {
  try { fs.writeFileSync(sessionPath(), JSON.stringify(data)); return true; } catch { return false; }
});
ipcMain.on('session:saveSync', (e, data) => {
  try { fs.writeFileSync(sessionPath(), JSON.stringify(data)); } catch { /* ignore */ }
  e.returnValue = true;
});

ipcMain.handle('clipboard:write', (_e, { text, html }) => {
  clipboard.write(html ? { text, html } : { text });
  return true;
});

ipcMain.handle('win:title', (_e, title) => { if (win) win.setTitle(title); });

// Keep the system window buttons in the theme's colours.
ipcMain.handle('win:titlebar', (_e, { color, symbolColor }) => {
  if (!win || process.platform === 'darwin' || typeof win.setTitleBarOverlay !== 'function') return false;
  try { win.setTitleBarOverlay({ color, symbolColor, height: 40 }); return true; } catch { return false; }
});

ipcMain.handle('open-external', (_e, url) => {
  if (/^https:\/\//i.test(url)) shell.openExternal(url);
});

// ---------- embedded Copilot (webview) hardening ----------
const SIGN_IN_HOSTS = /(^|\.)(microsoft\.com|microsoftonline\.com|live\.com|office\.com|office\.net|cloud\.microsoft|microsoft365\.com|sharepoint\.com|bing\.com|msauth\.net|msftauth\.net|windows\.net)$/i;
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (_ev, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
  });
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      let host = '';
      try { host = new URL(url).hostname; } catch { /* ignore */ }
      if (SIGN_IN_HOSTS.test(host)) return { action: 'allow' }; // sign-in popups
      if (/^https:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  }
});

// ---------- live tail ("follow file") ----------
const tails = new Map(); // path -> { size, timer }
function stopTail(p) {
  const t = tails.get(p);
  if (t) { clearInterval(t.timer); tails.delete(p); }
}
ipcMain.handle('tail:start', (_e, p) => {
  stopTail(p);
  let size;
  try { size = fs.statSync(p).size; } catch (err) { return { ok: false, error: err.message }; }
  const state = { size };
  state.timer = setInterval(() => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.size === state.size) return;
    if (!win) return;
    if (st.size < state.size) { // truncated / rotated: reload everything
      state.size = st.size;
      const r = readFileSafe(p);
      if (!r.error) win.webContents.send('tail:data', { path: p, reset: true, text: r.content });
      return;
    }
    const len = Math.min(st.size - state.size, 20 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    let fd;
    try {
      fd = fs.openSync(p, 'r');
      fs.readSync(fd, buf, 0, len, state.size);
    } catch { return; } finally { if (fd !== undefined) fs.closeSync(fd); }
    state.size += len;
    win.webContents.send('tail:data', { path: p, reset: false, text: buf.toString('utf8') });
  }, 1000);
  tails.set(p, state);
  return { ok: true };
});
ipcMain.handle('tail:stop', (_e, p) => { stopTail(p); return true; });
