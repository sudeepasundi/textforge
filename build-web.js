#!/usr/bin/env node
/* Builds the browser versions of TextForge from the same source as the desktop app.
 *   web-dist/selfhost/        offline PWA: host on any static server (or run serve-web.bat), installable from Edge/Chrome
 *   web-dist/artifact/TextForge.html   single page that loads Monaco from the jsDelivr CDN
 * Usage: node build-web.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'web-dist');
const MONACO_SRC = path.join(ROOT, 'node_modules/monaco-editor/min/vs');
const MONACO_VERSION = require('monaco-editor/package.json').version;
const APP_VERSION = require('./package.json').version;
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function copyDir(src, dst, skip = () => false) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (skip(s)) continue;
    if (e.isDirectory()) copyDir(s, d, skip);
    else fs.copyFileSync(s, d);
  }
}
function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}

// Body markup shared by every build (everything between <body> and the first <script>).
const indexHtml = read('index.html');
const bodyMarkup = indexHtml.slice(indexHtml.indexOf('<body>') + 6, indexHtml.indexOf('<script')).trim();
const sample = read('samples/order-service.log');
// The incident sample (0.16.0): four services that fail together. Small, so they travel inside the page.
const incidentSamples = {};
for (const n of ['api-gateway.log', 'order-service.log', 'payment-service.log', 'inventory-service.log']) incidentSamples[n] = read('samples/' + n);
const samplesJs = JSON.stringify(incidentSamples).replace(/<\//g, '<\\/');
const css = read('style.css');
const scripts = ['tables.js', 'markdown.js', 'logs.js', 'web-api.js', 'renderer.js'];
const ICON_SVG = read('assets/icon.svg');
const FAVICON_SVG = read('assets/icon-small.svg');

fs.rmSync(OUT, { recursive: true, force: true });

// ---------------------------------------------------------------- self-host PWA
const SH = path.join(OUT, 'selfhost');
fs.mkdirSync(SH, { recursive: true });
copyDir(MONACO_SRC, path.join(SH, 'monaco/vs'), (p) => /\.map$/.test(p));
copyDir(path.join(ROOT, 'fonts'), path.join(SH, 'fonts'));
copyDir(path.join(ROOT, 'samples'), path.join(SH, 'samples'));
fs.writeFileSync(path.join(SH, 'style.css'), css);
for (const s of scripts) fs.copyFileSync(path.join(ROOT, s), path.join(SH, s));
fs.writeFileSync(path.join(SH, 'icon.svg'), ICON_SVG);
fs.writeFileSync(path.join(SH, 'favicon.svg'), FAVICON_SVG);
for (const size of [180, 192, 512]) fs.copyFileSync(path.join(ROOT, 'assets', `icon-${size}.png`), path.join(SH, `icon-${size}.png`));

const manifest = {
  name: 'TextForge',
  short_name: 'TextForge',
  description: 'Log-aware text editor for backend developers',
  start_url: './',
  scope: './',
  display: 'standalone',
  background_color: '#0e1422',
  theme_color: '#212833',
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
  ],
  file_handlers: [{ action: './', accept: { 'text/plain': ['.log', '.txt', '.out', '.json', '.csv', '.md', '.xml', '.yml', '.yaml', '.properties', '.sql', '.java'] } }],
};
fs.writeFileSync(path.join(SH, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2));

const shHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TextForge</title>
  <meta name="theme-color" content="#212833">
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="icon" href="favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="icon-180.png">
  <meta name="description" content="TextForge: a log-aware text editor for backend developers. Auto tables from logs, table paste, live reload.">
  <link rel="stylesheet" href="style.css">
</head>
<body>
${bodyMarkup}
  <script>window.TF_WEB = { target: 'selfhost', version: '${APP_VERSION}', monacoBase: 'monaco', canDownload: true, sample: ${JSON.stringify(sample)}, samples: ${samplesJs} };</script>
  <script src="monaco/vs/loader.js"></script>
${scripts.map((s) => `  <script src="${s}"></script>`).join('\n')}
  <script>
    // Offline support. A new version takes over as soon as it is downloaded; the page then offers a reload
    // (tabs are kept). Updates are looked for when the tab comes back into view and every hour, so a tab
    // that stays open for days still gets new versions.
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      var hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        var check = function () { reg.update().catch(function () {}); };
        document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') check(); });
        setInterval(check, 60 * 60 * 1000);
      }).catch(function () {});
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (hadController) window.dispatchEvent(new CustomEvent('tf-update'));
        hadController = true;
      });
    }
  </script>
</body>
</html>
`;
fs.writeFileSync(path.join(SH, 'index.html'), shHtml);

// Service worker: precache the app shell, cache everything else (Monaco language files) on first use.
const core = ['./', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.svg', 'favicon.svg', ...scripts,
  ...listFiles(path.join(SH, 'fonts')).map((f) => 'fonts/' + f),
  'monaco/vs/loader.js', 'monaco/vs/editor/editor.main.js', 'monaco/vs/editor/editor.main.css', 'monaco/vs/base/worker/workerMain.js'];
const hash = crypto.createHash('sha1');
for (const f of core.filter((f) => f !== './')) hash.update(fs.readFileSync(path.join(SH, f)));
const version = hash.digest('hex').slice(0, 10);
fs.writeFileSync(path.join(SH, 'sw.js'), `/* TextForge offline cache, build ${version} */
const CACHE = 'textforge-${version}';
const CORE = ${JSON.stringify(core)};
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// The app itself (page, scripts, styles) comes from the network first, so a reload always shows the
// latest version; the cache is the fallback when offline. Monaco is large and versioned: cache first.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const keep = (res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; };
  if (url.pathname.includes('/monaco/') || url.pathname.includes('/fonts/')) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then(keep)));
    return;
  }
  e.respondWith(fetch(req, { cache: 'no-cache' }).then(keep).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || Response.error())));
});
`);

fs.writeFileSync(path.join(SH, 'serve-web.bat'), `@echo off
rem Serves TextForge at http://localhost:8765 using Python (no admin rights needed), then opens it.
cd /d "%~dp0"
start "" http://localhost:8765/
python -m http.server 8765 --bind 127.0.0.1 || py -m http.server 8765 --bind 127.0.0.1
`);
fs.writeFileSync(path.join(SH, 'README.txt'), `TextForge web version (self-hosted)
=====================================

This folder is a complete static website. Two ways to use it:

1. Put the folder on any web server (GitHub Pages, an internal server, IIS, nginx) and open its URL.
2. On your own machine: double-click serve-web.bat (needs Python), which serves it at
   http://localhost:8765 and opens your browser. Or run:  npx serve .   in this folder.

Opening index.html straight from disk (file://) works for viewing, but offline mode,
installing and saving back to files need it to be served over http(s).

INSTALL AS AN APP (Edge / Chrome): open the page, then use the "Install" icon in the
address bar (Edge: ... > Apps > Install this site as an app). No admin rights needed.
The installed app works offline and can open .log files from Explorer (Open with).

FILES: in Edge / Chrome, Open and Save work directly on your files. Other browsers
open files through a file picker and save by downloading.

SHORTCUTS: browsers reserve some keys, so the web version uses Alt+N (new tab),
Alt+W (close tab), Alt+1..4 (sidebar tools), Alt+T (table view).

COPILOT: Microsoft does not allow Copilot inside other web pages, so open it in its own
tab (Alt+4 > Open Copilot) and paste the prompts TextForge copies for you.
`);

// ---------------------------------------------------------------- Tauri desktop (0.13.0 preview)
// Same page as the desktop Electron app, but window.api comes from tauri-api.js (Rust commands).
// Tauri embeds this folder in the exe (src-tauri/tauri.conf.json -> frontendDist).
const DK = path.join(OUT, 'desktop');
fs.mkdirSync(DK, { recursive: true });
copyDir(MONACO_SRC, path.join(DK, 'monaco/vs'), (p) => /\.map$/.test(p));
copyDir(path.join(ROOT, 'fonts'), path.join(DK, 'fonts'));
fs.writeFileSync(path.join(DK, 'style.css'), css);
const desktopScripts = ['tables.js', 'markdown.js', 'logs.js', 'tauri-api.js', 'renderer.js'];
for (const s of desktopScripts) fs.copyFileSync(path.join(ROOT, s), path.join(DK, s));
fs.writeFileSync(path.join(DK, 'favicon.svg'), FAVICON_SVG);
fs.writeFileSync(path.join(DK, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>TextForge</title>
  <link rel="icon" href="favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="style.css">
</head>
<body>
${bodyMarkup}
  <script>window.TF_WEB = { target: 'tauri', version: '${APP_VERSION}', monacoBase: 'monaco', samples: ${samplesJs} };</script>
  <script src="monaco/vs/loader.js"></script>
${desktopScripts.map((s) => `  <script src="${s}"></script>`).join('\n')}
</body>
</html>
`);

// ---------------------------------------------------------------- hosted single page
const AR = path.join(OUT, 'artifact');
fs.mkdirSync(AR, { recursive: true });
const cdn = `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min`;
const monacoCss = fs.readFileSync(path.join(MONACO_SRC, 'editor/editor.main.css'), 'utf8');
const pageCss = css.replace(/@font-face\s*\{[^}]*\}\s*/g, '');
const inline = (f) => read(f).replace(/<\/script/gi, '<\\/script');
const arHtml = `<title>TextForge</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
${monacoCss}
</style>
<style>
${pageCss}
</style>
${bodyMarkup}
<script>window.TF_WEB = { target: 'artifact', version: '${APP_VERSION}', monacoBase: '${cdn}', inlineMonacoCss: true, canDownload: false, sample: ${JSON.stringify(sample).replace(/<\//g, '<\\/')}, samples: ${samplesJs} };</script>
<script src="${cdn}/vs/loader.js"></script>
${scripts.map((s) => `<script>\n${inline(s)}\n</script>`).join('\n')}
`;
fs.writeFileSync(path.join(AR, 'TextForge.html'), arHtml);

const kb = (p) => Math.round(fs.statSync(p).size / 1024) + ' KB';
console.log('self-host  ->', path.relative(ROOT, SH), '(' + listFiles(SH).length + ' files)');
console.log('desktop    ->', path.relative(ROOT, DK), '(' + listFiles(DK).length + ' files, for Tauri)');
console.log('hosted     ->', path.relative(ROOT, path.join(AR, 'TextForge.html')), kb(path.join(AR, 'TextForge.html')));
console.log('monaco', MONACO_VERSION, 'sw build', version);
