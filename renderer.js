(function () {
  'use strict';

  const api = window.api;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (typeof v !== 'string' && k in el) el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of kids.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ---------------- state ----------------
  let editor = null;
  let active = null;
  let tabs = [];
  let idCounter = 0;
  let untitledCounter = 0;
  let plainNext = false;
  let currentView = null;
  let panelMode = null;
  let tableState = null;
  let copilotView = null;

  // ---------------- platform ----------------
  const IS_WEB = api.platform === 'web';
  const CAN = Object.assign({ embeddedCopilot: true, sessionStoresContent: false, canDownload: true }, api.capabilities || {});
  const WEB = window.TF_WEB || {};
  const APP_VERSION = WEB.version || api.version || '';

  // ---------------- Monaco bootstrap ----------------
  const baseDir = location.href.substring(0, location.href.lastIndexOf('/'));
  const monacoBase = WEB.monacoBase || 'node_modules/monaco-editor/min';
  const monacoRoot = (/^https?:/.test(monacoBase) ? monacoBase : baseDir + '/' + monacoBase) + '/';
  const workerCode = "self.MonacoEnvironment={baseUrl:'" + monacoRoot + "'};importScripts('" + monacoRoot + "vs/base/worker/workerMain.js');";
  self.MonacoEnvironment = IS_WEB
    ? { getWorker: () => new Worker(URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }))) }
    : { getWorkerUrl: () => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(workerCode) };
  // Monaco handles paste with its own window-level capture listener and stops propagation,
  // so ours is registered on window BEFORE Monaco loads, which makes it run first.
  window.addEventListener('paste', (e) => {
    if (editor && active && e.target instanceof Node && $('#editor').contains(e.target)) { lastPasteEvent = Date.now(); onPaste(e); }
  }, true);
  // Monaco throws harmless "Canceled" errors when async work is cancelled (e.g. switching tabs quickly).
  const isCanceled = (x) => x && (x.name === 'Canceled' || x.message === 'Canceled');
  window.addEventListener('error', (e) => { if (isCanceled(e.error)) e.preventDefault(); });
  window.addEventListener('unhandledrejection', (e) => { if (isCanceled(e.reason)) e.preventDefault(); });
  require.config(Object.assign({ paths: { vs: monacoBase + '/vs' } }, WEB.inlineMonacoCss ? { 'vs/css': { disabled: true } } : {}));
  require(['vs/editor/editor.main'], init);

  // ---------------- settings ----------------
  const DEFAULT_RULES = [
    { label: 'Slow calls (500 ms or more)', pattern: 'took\\s?([5-9]\\d{2}|[1-9]\\d{3,})\\s?ms', color: '#f5b84a', ci: true, on: true },
    { label: 'Connectivity problems', pattern: 'timed? ?out|connection refused|unavailable|circuit ?breaker|retry(ing)?', color: '#ff6b6b', ci: true, on: true },
    { label: 'Kafka positions', pattern: 'topic=[\\w.-]+|partition=\\d+|offset=\\d+', color: '#4fc1b0', ci: false, on: true },
  ];
  const defaults = {
    theme: 'slate', accent: '#4c9aff', density: 'comfortable', fontFamily: 'JetBrains Mono', fontSize: 14, lineHeight: 1.5, ligatures: false,
    wrap: false, whitespace: false, minimap: true, signal: true, pasteFormat: 'markdown', myPackages: 'com.example',
    rules: DEFAULT_RULES, groupWarn: false, mask: { emails: true, ips: false, cards: true, pan: true },
    copilotUrl: 'https://m365.cloud.microsoft/chat', copilotMask: true, copilotReview: true, sideWidth: 340, view: 'insights',
  };
  let settings = JSON.parse(JSON.stringify(defaults));
  try {
    const raw = localStorage.getItem('tf-settings2');
    if (!raw) {
      // first run: follow the system / host light-dark preference
      const forced = document.documentElement.getAttribute('data-theme');
      const light = forced ? forced === 'light' : window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
      if (light) settings.theme = 'paper';
    }
    const saved = JSON.parse(raw || '{}');
    Object.assign(settings, saved);
    settings.mask = Object.assign({}, defaults.mask, saved.mask || {});
    if (!Array.isArray(settings.rules)) settings.rules = DEFAULT_RULES;
  } catch { /* ignore */ }
  const writeSettings = () => { try { localStorage.setItem('tf-settings2', JSON.stringify(settings)); } catch { /* ignore */ } };
  const saveSettings = debounce(writeSettings, 300);
  // a change made just before closing must not be lost to the delay above
  window.addEventListener('pagehide', writeSettings);
  window.addEventListener('beforeunload', writeSettings);

  // ---------------- themes ----------------
  const THEMES = {
    slate: { label: 'Slate', dark: true, bg: '#1a2029', surface: '#212833', raised: '#2a3240', line: '#354050', fg: '#dfe5ee', muted: '#8994a6', editor: '#1a2029', lineHl: '#212935' },
    graphite: { label: 'Graphite', dark: true, bg: '#1c1c1f', surface: '#232327', raised: '#2c2c31', line: '#3a3a41', fg: '#e6e6ea', muted: '#8d8d97', editor: '#1c1c1f', lineHl: '#25252a' },
    deepsea: { label: 'Deep sea', dark: true, bg: '#0f2030', surface: '#13283b', raised: '#1a3348', line: '#24435c', fg: '#d8e7f2', muted: '#7f9bb0', editor: '#0f2030', lineHl: '#15293c' },
    plum: { label: 'Plum', dark: true, bg: '#1e1824', surface: '#251e2d', raised: '#2f2639', line: '#3e3249', fg: '#ebe3f2', muted: '#9a8ca8', editor: '#1e1824', lineHl: '#272030' },
    paper: { label: 'Paper', dark: false, bg: '#f4f5f7', surface: '#ffffff', raised: '#eef0f3', line: '#d9dde3', fg: '#1d232c', muted: '#667080', editor: '#ffffff', lineHl: '#f3f5f8' },
    sand: { label: 'Sand', dark: false, bg: '#f1efe9', surface: '#faf9f6', raised: '#e9e6de', line: '#d6d1c5', fg: '#2a2620', muted: '#756e61', editor: '#faf9f6', lineHl: '#f1eee7' },
  };
  const PAL_DARK = { err: '#ff6b6b', warn: '#f5b84a', info: '#5fb3ff', debug: '#8b95a7', trace: '#647083', date: '#7fa7b5', thread: '#b39ddb', logger: '#4fc1b0', exc: '#ff8a65', cause: '#ffab40', frame: '#6e7a8c', id: '#e88bc4', url: '#7cc4ff', num: '#b9de8e', str: '#e3c27e', konst: '#c792ea' };
  const PAL_LIGHT = { err: '#d23535', warn: '#a86a06', info: '#1f6fd1', debug: '#6b7686', trace: '#8c95a3', date: '#3d7385', thread: '#7e57c2', logger: '#00796b', exc: '#d84315', cause: '#b85600', frame: '#8a93a1', id: '#ad1f7a', url: '#1565c0', num: '#4b7a1a', str: '#946300', konst: '#8e44ad' };
  const ACCENTS = ['#4c9aff', '#8b7cf6', '#2fbf8f', '#f0a030', '#f05a7a', '#22b8cf'];

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return [76, 154, 255];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function luminance(hex) {
    const [r, g, b] = hexToRgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  // WCAG contrast helpers: text on accent buttons picks whichever of white / ink reads better, and
  // accent-coloured text is nudged toward the theme's text colour until it reaches 4.5:1.
  const contrastRatio = (a, b) => { const x = luminance(a); const y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bestOn = (bg) => (contrastRatio('#ffffff', bg) >= contrastRatio('#0f1720', bg) ? '#ffffff' : '#0f1720');
  function mixHex(a, b, t) {
    const A = hexToRgb(a); const B = hexToRgb(b);
    return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
  }
  function readableAccent(acc, bg, fg) {
    for (let t = 0; t <= 1.0001; t += 0.05) { const c = mixHex(acc, fg, t); if (contrastRatio(c, bg) >= 4.5) return c; }
    return fg;
  }
  const palette = () => ((THEMES[settings.theme] || THEMES.slate).dark ? PAL_DARK : PAL_LIGHT);

  function applyTheme() {
    const t = THEMES[settings.theme] || THEMES.slate;
    const pal = palette();
    const acc = /^#[0-9a-f]{6}$/i.test(settings.accent) ? settings.accent : '#4c9aff';
    const vars = {
      bg: t.bg, surface: t.surface, raised: t.raised, line: t.line, fg: t.fg, muted: t.muted, editor: t.editor,
      accent: acc, 'accent-fg': bestOn(acc), 'accent-text': readableAccent(acc, t.editor, t.fg), 'accent-soft': acc + (t.dark ? '2e' : '22'),
      err: pal.err, warn: pal.warn, info: pal.info, debug: pal.debug,
    };
    for (const k in vars) document.documentElement.style.setProperty('--' + k, vars[k]);
    document.documentElement.style.colorScheme = t.dark ? 'dark' : 'light';
    applyDensity();
    if (api.setTitleBar) api.setTitleBar({ color: t.surface, symbolColor: t.muted, height: barHeight() });
    if (!window.monaco) return;
    const c = (x) => x.replace('#', '');
    monaco.editor.defineTheme('tf', {
      base: t.dark ? 'vs-dark' : 'vs',
      inherit: true,
      rules: [
        { token: 'log.error', foreground: c(pal.err), fontStyle: 'bold' },
        { token: 'log.warn', foreground: c(pal.warn), fontStyle: 'bold' },
        { token: 'log.info', foreground: c(pal.info) },
        { token: 'log.debug', foreground: c(pal.debug) },
        { token: 'log.trace', foreground: c(pal.trace) },
        { token: 'log.date', foreground: c(pal.date) },
        { token: 'log.thread', foreground: c(pal.thread) },
        { token: 'log.logger', foreground: c(pal.logger) },
        { token: 'log.exception', foreground: c(pal.exc), fontStyle: 'bold' },
        { token: 'log.causedby', foreground: c(pal.cause), fontStyle: 'bold' },
        { token: 'log.frame', foreground: c(pal.frame) },
        { token: 'log.id', foreground: c(pal.id) },
        { token: 'log.url', foreground: c(pal.url), fontStyle: 'underline' },
        { token: 'log.ip', foreground: c(pal.url) },
        { token: 'log.number', foreground: c(pal.num) },
        { token: 'log.string', foreground: c(pal.str) },
        { token: 'log.key', foreground: c(acc) },
        { token: 'log.const', foreground: c(pal.konst) },
      ],
      colors: {
        'editor.background': t.editor, 'editor.foreground': t.fg, 'editor.lineHighlightBackground': t.lineHl,
        'editor.lineHighlightBorder': '#00000000', 'editorLineNumber.foreground': t.muted + 'aa',
        'editorLineNumber.activeForeground': t.fg, 'editorCursor.foreground': acc, 'editor.selectionBackground': acc + '55',
        'editor.inactiveSelectionBackground': acc + '30', 'editor.findMatchHighlightBackground': pal.warn + '40',
        'editorGutter.background': t.editor, 'minimap.background': t.editor, 'editorWidget.background': t.surface,
        'editorWidget.border': t.line, 'editorSuggestWidget.background': t.surface, 'input.background': t.bg,
        'input.border': t.line, focusBorder: acc, 'scrollbarSlider.background': t.muted + '33',
        'scrollbarSlider.hoverBackground': t.muted + '55', 'editorIndentGuide.background1': t.line,
        'editorOverviewRuler.border': '#00000000', 'list.activeSelectionBackground': acc + '40', 'list.hoverBackground': t.raised,
        'quickInput.background': t.surface, 'menu.background': t.surface, 'menu.foreground': t.fg,
        'menu.selectionBackground': acc + '40', 'editorBracketMatch.background': acc + '30', 'editorBracketMatch.border': acc,
      },
    });
    monaco.editor.setTheme('tf');
    if (active) { refreshDecorations(active); renderSignal(); }
  }

  // Density: "compact" tightens the bars, tabs, rail, panels and editor line spacing.
  function isCompact() { return settings.density === 'compact'; }
  function barHeight() { return isCompact() ? 32 : 40; }
  function applyDensity() {
    document.body.classList.toggle('compact', isCompact());
  }
  function editorLineHeight() { return Math.round(settings.fontSize * (isCompact() ? Math.max(1.2, settings.lineHeight - 0.15) : settings.lineHeight)); }

  function applyEditorOptions() {
    if (!editor) return;
    editor.updateOptions({
      fontFamily: `'${settings.fontFamily}', 'JetBrains Mono', Consolas, monospace`,
      fontSize: settings.fontSize,
      lineHeight: editorLineHeight(),
      fontLigatures: settings.ligatures,
      wordWrap: settings.wrap ? 'on' : 'off',
      renderWhitespace: settings.whitespace ? 'all' : 'none',
      minimap: { enabled: settings.minimap && !splitOpen() }, // panes are narrow: no minimap while split
    });
    for (const ped of paneEditors()) ped.updateOptions({ fontFamily: `'${settings.fontFamily}', 'JetBrains Mono', Consolas, monospace`, fontSize: settings.fontSize, lineHeight: editorLineHeight(), fontLigatures: settings.ligatures, wordWrap: settings.wrap ? 'on' : 'off' });
  }

  function updateRuleStyles() {
    let css = '';
    settings.rules.forEach((r, i) => {
      const col = /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : '#f5b84a';
      css += `.hl-r${i}{background:${col}38;border-bottom:1px solid ${col};border-radius:2px}`;
    });
    let el = $('#rule-style');
    if (!el) { el = h('style', { id: 'rule-style' }); document.head.appendChild(el); }
    el.textContent = css;
  }

  // ---------------- toast / modal ----------------
  function toast(msg, ms = 3200, action) {
    const t = $('#toast');
    t.textContent = msg;
    if (action) {
      t.append(h('button', { class: 'toast-action', onclick: () => { t.hidden = true; action.run(); } }, action.label));
      ms = Math.max(ms, 9000);
    }
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, ms);
  }

  function modal(title, body, buttons) {
    return new Promise((resolve) => {
      const box = $('#modal-box');
      box.innerHTML = '';
      const btns = h('div', { class: 'btns' });
      const bodyEl = h('div', { class: 'body' });
      if (typeof body === 'string') bodyEl.innerHTML = body; else bodyEl.append(body);
      box.append(h('h3', null, title), bodyEl, btns);
      const done = (v) => { $('#modal').hidden = true; document.removeEventListener('keydown', onEsc, true); resolve(v); };
      const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
      document.addEventListener('keydown', onEsc, true);
      buttons.forEach((b) => btns.append(h('button', { class: b.primary ? 'primary' : '', onclick: () => done(b.value) }, b.label)));
      $('#modal').hidden = false;
      const first = btns.querySelector('.primary') || btns.querySelector('button');
      if (first) first.focus();
    });
  }

  // ---------------- languages ----------------
  let langList = [];
  function langFromName(name) {
    const lower = name.toLowerCase();
    const ext = lower.includes('.') ? '.' + lower.split('.').pop() : null;
    for (const l of langList) if (l.filenames && l.filenames.some((f) => f.toLowerCase() === lower)) return l.id;
    for (const l of langList) if (ext && l.extensions && l.extensions.includes(ext)) return l.id;
    return 'plaintext';
  }

  function registerLogLanguage() {
    monaco.languages.register({ id: 'log', extensions: ['.log', '.out'], aliases: ['Log', 'log'] });
    monaco.languages.setMonarchTokensProvider('log', {
      tokenizer: {
        root: [
          [/^\s+at\s+.*$/, 'log.frame'],
          [/^\s*\.\.\. \d+ (more|common frames omitted)\s*$/, 'log.frame'],
          [/^\s*Caused by:/, 'log.causedby'],
          [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/, 'log.date'],
          [/\d{2}\/[A-Za-z]{3}\/\d{4}:\d{2}:\d{2}:\d{2}(?: [+-]\d{4})?/, 'log.date'],
          [/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/, 'log.date'],
          [/\s\d+ ---(?=\s)/, 'log.trace'], // Spring Boot "PID ---" columns: dimmed noise
          [/\[(?:FATAL|CRITICAL|SEVERE|ERROR)\]/, 'log.error'],
          [/\[(?:WARN|WARNING)\]/, 'log.warn'],
          [/\[(?:INFO|NOTICE)\]/, 'log.info'],
          [/\[(?:DEBUG|TRACE)\]/, 'log.debug'],
          [/\b(?:FATAL|CRITICAL|SEVERE|ERROR)\b/, 'log.error'],
          [/\b(?:WARN|WARNING)\b/, 'log.warn'],
          [/\b(?:INFO|NOTICE)\b/, 'log.info'],
          [/\b(?:DEBUG|FINE)\b/, 'log.debug'],
          [/\b(?:TRACE|FINER|FINEST)\b/, 'log.trace'],
          [/(?:[a-zA-Z_$][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error|Throwable)\b/, 'log.exception'],
          [/\[[^\]\n]{1,60}\]/, 'log.thread'],
          [/https?:\/\/[^\s"'<>)]+/, 'log.url'],
          [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/, 'log.id'],
          [/\b[0-9a-f]{16,32}\b/, 'log.id'],
          [/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?::\d{2,5})?\b/, 'log.ip'],
          [/\b[A-Z]{2,}[-_]?\d{3,}\b/, 'log.id'],
          [/\b[A-Za-z_][\w.-]*(?==)/, 'log.key'],
          [/"[^"\n]*"/, 'log.string'],
          [/\b(?:[a-z]\w*\.){2,}[A-Za-z_$][\w$]*\b/, 'log.logger'],
          [/\b\d+(?:\.\d+)?\s?(?:ms|sec|s|MB|KB|GB|%)(?=\W|$)/, 'log.number'],
          [/\b\d+(?:\.\d+)?\b/, 'log.number'],
          [/\b(?:true|false|null)\b/, 'log.const'],
        ],
      },
    });
    // Fold every multi-line entry (stack traces) under its header line.
    monaco.languages.registerFoldingRangeProvider('log', {
      provideFoldingRanges(model) {
        const tab = tabs.find((t) => t.model === model);
        const an = tab ? analyze(tab) : null;
        if (!an) return [];
        const out = [];
        for (const e of an.entries) {
          let end = e.end;
          while (end > e.start && an.lines[end].trim() === '') end--;
          if (end > e.start) out.push({ start: e.start + 1, end: end + 1, kind: monaco.languages.FoldingRangeKind.Region });
          if (out.length > 50000) break;
        }
        return out;
      },
    });
  }

  // ---------------- tabs ----------------
  const isDirty = (t) => t.forceDirty || t.model.getAlternativeVersionId() !== t.savedVersion;
  const isLogTab = (t) => !!t && t.model.getLanguageId() === 'log';
  const basename = (p) => p.replace(/^.*[\\/]/, '');

  function chooseLanguage(name, content) {
    let lang = langFromName(name);
    if (lang === 'log') return lang;
    if ((lang === 'plaintext' || /\.(txt|out|trace)$/i.test(name)) && Logs.isLogText(content.slice(0, 200000))) lang = 'log';
    return lang;
  }

  let useClock = 1e9; // ordering for "most recently used" (tab ids are smaller)
  function newTab({ path, name, content = '', enc = 'utf8', dirty = false, lang }) {
    const tabName = name || (path ? basename(path) : 'Untitled ' + ++untitledCounter);
    const model = monaco.editor.createModel(content, lang || chooseLanguage(tabName, content));
    const tab = {
      id: ++idCounter, path: path || null, name: tabName, model, enc, savedVersion: model.getAlternativeVersionId(),
      forceDirty: dirty, viewState: null, filter: emptyFilter(), an: null, decoIds: [], detectDone: !!content, tailing: false,
    };
    tab.used = ++useClock;
    model.onDidChangeContent(() => onContentChanged(tab));
    tabs.push(tab);
    return tab;
  }

  const onContentChanged = (tab) => {
    renderTabs();
    scheduleSession();
    if (!tab.detectDone && tab.model.getLanguageId() === 'plaintext') maybeDetectLog(tab);
    scheduleAnalysis(tab);
    if (tab === active && tab.preview) schedulePreview();
  };

  const maybeDetectLog = debounce((tab) => {
    if (tab.detectDone || !tabs.includes(tab)) return;
    const text = tab.model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: Math.min(tab.model.getLineCount(), 400), endColumn: 1 });
    if (tab.model.getLineCount() < 3) return;
    tab.detectDone = true;
    if (Logs.isLogText(tab.model.getValue().slice(0, 200000)) || Logs.isLogText(text)) {
      monaco.editor.setModelLanguage(tab.model, 'log');
      const an = analyze(tab);
      toast((an && an.formatLabel ? an.formatLabel + ' log' : 'Log') + ' detected. Log tools are on (Ctrl+1).');
    }
  }, 500);

  function activate(tab) {
    // Picking a tab while the incident covers the editor shows that tab; the incident can be reopened.
    if (typeof removeIncidentView === 'function' && $('#incident')) {
      removeIncidentView();
      toast('The incident is still there.', 7000, { label: 'Back to the incident', run: reopenIncident });
    }
    tab.used = ++useClock;
    if (active && active !== tab) active.viewState = editor.saveViewState();
    active = tab;
    editor.setModel(tab.model);
    if (tab.viewState) editor.restoreViewState(tab.viewState);
    if (tab.decoVersion !== tab.model.getVersionId()) refreshDecorations(tab);
    applyHiddenAreas(tab);
    updateWelcome();
    renderDiskNote();
    if (typeof applyPreview === 'function' && $('#preview')) applyPreview();
    renderTabs();
    updateStatus();
    updateTitle();
    onActiveAnalysisChanged();
    if (currentView === 'insights') renderInsights();
    if (currentView === 'extract') renderExtract();
    editor.focus();
    scheduleSession();
  }

  function renderTabs() {
    const bar = $('#tabs');
    if (bar.querySelector('.tab-rename')) return; // don't rebuild while a name is being typed
    bar.innerHTML = '';
    for (const t of tabs) {
      const el = h('div', {
        class: 'tab' + (t === active ? ' active' : '') + (isDirty(t) ? ' dirty' : '') + (isLogTab(t) ? ' is-log' : '') + (inSplit(t) && t !== active ? ' in-split' : ''),
        title: (t.path && !/^(web|download):/.test(t.path) ? t.path : t.name) + '\nDouble-click to rename, drag to move',
        role: 'tab', draggable: 'true', 'data-tab': String(t.id),
        onclick: () => activate(t),
        ondblclick: (e) => { if (!e.target.closest('.x')) startRename(t); },
        oncontextmenu: (e) => { e.preventDefault(); tabMenu(t, e.clientX, e.clientY); },
        onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t); } },
        ondragstart: (e) => {
          e.dataTransfer.setData('application/x-textforge-tab', String(t.id));
          e.dataTransfer.setData('text/plain', t.name);
          e.dataTransfer.effectAllowed = 'move';
          document.body.classList.add('tab-dragging');
          dragTab = t;
        },
        ondragend: () => endTabDrag(),
        ondragover: (e) => {
          if (!dragTab) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const r = el.getBoundingClientRect();
          const after = e.clientX > r.left + r.width / 2;
          clearTabDropMarks();
          if (dragTab !== t) el.classList.add(after ? 'drop-after' : 'drop-before');
        },
        ondragleave: () => el.classList.remove('drop-before', 'drop-after'),
        ondrop: (e) => {
          if (!dragTab) return;
          e.preventDefault();
          e.stopPropagation();
          const r = el.getBoundingClientRect();
          moveTab(dragTab, t, e.clientX > r.left + r.width / 2);
        },
      },
      h('span', { class: 'kind' }), h('span', { class: 'name' }, t.name),
      h('span', { class: 'x', title: 'Close (Ctrl+W)', html: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
        onclick: (e) => { e.stopPropagation(); closeTab(t); } }));
      bar.appendChild(el);
      if (t === active) setTimeout(() => el.scrollIntoView({ block: 'nearest', inline: 'nearest' }), 0);
    }
    updateTitle();
    if (splitOpen()) renderSplitHead();
    updateFilesBadge();
    if (currentView === 'files') renderFiles();
  }

  // ---------- reorder tabs by dragging ----------
  let dragTab = null;
  function clearTabDropMarks() { $$('#tabs .tab').forEach((x) => x.classList.remove('drop-before', 'drop-after')); }
  function moveTab(t, target, after) {
    clearTabDropMarks();
    if (!t || t === target) return;
    tabs.splice(tabs.indexOf(t), 1);
    let i = target ? tabs.indexOf(target) : tabs.length - 1;
    tabs.splice(after ? i + 1 : i, 0, t);
    renderTabs();
    scheduleSession();
  }

  // ---------- rename tabs (unsaved tabs too) ----------
  const BAD_NAME = /[\\/:*?"<>|]/;
  function startRename(t) {
    const el = $(`#tabs .tab[data-tab="${t.id}"]`);
    if (!el) return;
    const nameEl = el.querySelector('.name');
    const input = h('input', { class: 'tab-rename', value: t.name, spellcheck: false, 'aria-label': 'New name for ' + t.name });
    nameEl.replaceWith(input);
    el.draggable = false;
    input.focus();
    // select the name without the extension, like a file manager
    const dot = t.name.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : t.name.length);
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      input.remove();
      if (commit && value && value !== t.name) await renameTab(t, value);
      renderTabs();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    ['mousedown', 'click', 'dblclick'].forEach((ev) => input.addEventListener(ev, (e) => e.stopPropagation()));
  }
  async function renameTab(t, name) {
    name = String(name).trim();
    if (!name) return false;
    if (BAD_NAME.test(name)) { toast('A file name cannot contain \\ / : * ? " < > |', 4000); return false; }
    const old = t.name;
    const onDisk = t.path && !/^download:/.test(t.path);
    if (onDisk) {
      if (t.tailing) await api.tailStop(t.path);
      const r = await api.renameFile({ path: t.path, name });
      if (!r.ok) { toast('Could not rename: ' + r.error, 6000); if (t.tailing) api.tailStart(t.path); return false; }
      t.path = r.path;
      t.stamp = null;
      if (t.tailing) api.tailStart(t.path);
      if (r.labelOnly) toast('Renamed the tab. This browser can\'t rename the file on disk, so Save as will use the new name.', 5000);
      else toast('Renamed ' + old + ' to ' + name, 2200);
    } else {
      t.path = null;
      toast('Renamed to ' + name + '. Save (Ctrl+S) will suggest this name.', 2600);
    }
    t.name = name;
    // a new extension can mean a new language (.json, .log, .sql...)
    const lang = langFromName(name);
    if (lang !== 'plaintext' && lang !== t.model.getLanguageId()) { monaco.editor.setModelLanguage(t.model, lang); t.detectDone = true; scheduleAnalysis(t); }
    renderTabs();
    updateTitle();
    updateStatus();
    scheduleSession();
    return true;
  }

  // ---------- tab right-click menu ----------
  function tabMenu(t, x, y) {
    closeMenu();
    const others = tabs.filter((o) => o !== t);
    const items = [
      ['Rename', () => { activate(t); setTimeout(() => startRename(t), 0); }],
      [inSplit(t) ? 'Remove from split view' : 'Show beside (split view)', () => (inSplit(t) ? removeSplitTab(t) : addSplitPane(t))],
      null,
      ['Move to the start', () => moveTab(t, tabs[0], false), tabs[0] === t],
      ['Move to the end', () => moveTab(t, tabs[tabs.length - 1], true), tabs[tabs.length - 1] === t],
      t.path && !/^(web|download):/.test(t.path) ? ['Copy file path', () => api.clipboardWrite({ text: t.path }).then(() => toast('Path copied.', 1500))] : null,
      null,
      ['Close', () => closeTab(t)],
      ['Close other tabs', async () => { for (const o of others) if (!(await closeTab(o))) break; }, !others.length],
    ];
    const menu = h('div', { class: 'menu', role: 'menu' });
    for (const it of items) {
      if (it === null) { if (menu.lastChild && !menu.lastChild.classList.contains('sep')) menu.append(h('div', { class: 'sep' })); continue; }
      const [label, run, disabled] = it;
      menu.append(h('button', { role: 'menuitem', disabled: !!disabled, onclick: () => { closeMenu(); run(); } }, label));
    }
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - r.width - 6) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - r.height - 6) + 'px';
    const firstBtn = menu.querySelector('button:not([disabled])');
    if (firstBtn) firstBtn.focus();
    setTimeout(() => {
      document.addEventListener('mousedown', menuAway, true);
      document.addEventListener('keydown', menuKey, true);
    }, 0);
  }
  function menuAway(e) { if (!e.target.closest('.menu')) closeMenu(); }
  function menuKey(e) {
    const menu = $('.menu');
    if (!menu) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const btns = $$('.menu button:not([disabled])');
      const i = btns.indexOf(document.activeElement);
      btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length].focus();
    }
  }
  function closeMenu() {
    $$('.menu').forEach((m) => m.remove());
    document.removeEventListener('mousedown', menuAway, true);
    document.removeEventListener('keydown', menuKey, true);
  }

  function updateTitle() {
    if (active) api.setTitle((isDirty(active) ? '● ' : '') + (active.path || active.name) + ' - TextForge');
  }

  async function closeTab(tab, { force = false } = {}) {
    if (!force && isDirty(tab)) {
      const choice = await modal('Unsaved changes', `<p>Save changes to <b>${esc(tab.name)}</b> before closing?</p>`, [
        { label: 'Cancel', value: 'cancel' }, { label: "Don't save", value: 'discard' }, { label: 'Save', value: 'save', primary: true },
      ]);
      if (!choice || choice === 'cancel') return false;
      if (choice === 'save' && !(await saveTab(tab))) return false;
    }
    if (tab.tailing) api.tailStop(tab.path);
    const idx = tabs.indexOf(tab);
    removeSplitTab(tab);
    tabs.splice(idx, 1);
    if (active === tab) {
      active = null;
      if (!tabs.length) newTab({});
      activate(tabs[Math.min(idx, tabs.length - 1)]);
    }
    tab.model.dispose();
    renderTabs();
    scheduleSession();
    return true;
  }

  // ---------------- files ----------------
  const isPristineUntitled = (t) => !t.path && !isDirty(t) && t.model.getValueLength() === 0;

  function addOpened(results) {
    let firstTab = null;
    for (const r of results) {
      if (r.error) { toast('Could not open ' + basename(r.path) + ': ' + r.error, 6000); continue; }
      const existing = tabs.find((t) => t.path && t.path.toLowerCase() === r.path.toLowerCase());
      if (existing) { firstTab = firstTab || existing; continue; }
      const t = newTab({ path: r.path, content: r.content, enc: r.enc });
      firstTab = firstTab || t;
    }
    if (firstTab) {
      tabs.filter((t) => isPristineUntitled(t) && t !== firstTab).forEach((t) => { tabs.splice(tabs.indexOf(t), 1); t.model.dispose(); });
      activate(firstTab);
    }
  }
  const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
  const mb = (n) => (n / 1048576).toFixed(n > 10485760 ? 0 : 1) + ' MB';

  // Large files block the window while they load, so say so first (about 7 s per 100 MB on a slow PC).
  async function readDeferred(list) {
    const out = [];
    for (const r of list) {
      if (!r.deferred) { out.push(r); continue; }
      toast('Opening ' + basename(r.path) + ' (' + mb(r.size) + '). Large files take a few seconds per 100 MB…', 120000);
      await nextPaint();
      out.push(await api.readFile(r.path));
    }
    return out;
  }
  async function openFiles() { await openLoaded(await readDeferred(await api.openDialog())); }
  async function openPaths(paths) {
    toast('Opening ' + paths.length + ' file' + (paths.length === 1 ? '' : 's') + '…', 120000);
    await nextPaint();
    await openLoaded(await Promise.all(paths.map((p) => api.readFile(p))));
  }
  async function openLoaded(results) {
    const big = results.find((r) => r.content && r.content.length > 30 * 1024 * 1024);
    if (!big) { $('#toast').hidden = true; addOpened(results); return; }
    toast('Indexing ' + basename(big.path) + ' (' + mb(big.content.length) + ')…', 120000);
    await nextPaint();
    const t0 = performance.now();
    addOpened(results);
    const t = tabs.find((x) => x.path === big.path);
    toast('Opened ' + basename(big.path) + ': ' + (t ? t.model.getLineCount().toLocaleString() + ' lines' : mb(big.content.length)) + ' in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s.', 4000);
  }

  async function saveTab(tab, saveAs = false) {
    const content = tab.model.getValue();
    let res;
    if (!tab.path || saveAs) {
      res = await api.saveAs({ defaultPath: tab.path || tab.name, content, enc: tab.enc });
      if (res.canceled) return false;
    } else {
      res = await api.saveFile({ path: tab.path, content, enc: tab.enc });
    }
    if (!res.ok) { toast((/^Saving files/.test(res.error) ? '' : 'Save failed: ') + res.error, 7000); return false; }
    const renamed = tab.path !== res.path;
    tab.path = res.path;
    tab.name = basename(res.path);
    tab.savedVersion = tab.model.getAlternativeVersionId();
    tab.forceDirty = false;
    tab.stamp = null; // our own write: take the next check as the new baseline
    if (tab.disk) setDiskNote(tab, null);
    if (renamed) {
      const lang = langFromName(tab.name);
      if (lang !== 'plaintext') monaco.editor.setModelLanguage(tab.model, lang);
    }
    renderTabs();
    updateStatus();
    scheduleSession();
    toast((res.downloaded ? 'Downloaded ' : 'Saved ') + tab.name, 1800);
    return true;
  }

  // ---------------- session ----------------
  let sessionTimer = null;
  function sessionData() {
    return {
      version: 2,
      active: tabs.indexOf(active),
      tabs: tabs.map((t) => {
        const dirty = isDirty(t);
        // web: keep file contents so tabs survive a reload, except very large files (re-read on demand)
        // Unsaved text is kept so it survives a restart, but not for huge tabs (autosave would rewrite
        // hundreds of MB every few seconds); the web version also keeps small opened files.
        const size = t.model.getValueLength();
        const keep = size < 50 * 1024 * 1024 && (dirty || !t.path || (CAN.sessionStoresContent && size < 20 * 1024 * 1024));
        return { path: t.path, name: t.name, enc: t.enc, dirty, lang: t.model.getLanguageId(), content: keep ? t.model.getValue() : null };
      }),
    };
  }
  function scheduleSession() {
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => api.saveSession(sessionData()), 800);
  }
  window.addEventListener('beforeunload', () => { api.saveSessionSync(sessionData()); });

  async function restoreSession() {
    const sess = await api.loadSession();
    const startup = await api.startupFiles();
    if (sess && Array.isArray(sess.tabs)) {
      for (const s of sess.tabs) {
        if (s.content != null) {
          const t = newTab({ path: s.path, name: s.name, content: s.content, enc: s.enc, dirty: s.dirty, lang: s.lang });
          t.detectDone = true;
        } else if (s.path) {
          const r = await api.readFile(s.path);
          if (!r.error) newTab({ path: r.path, content: r.content, enc: r.enc, lang: s.lang });
        }
      }
    }
    if (!sess && WEB.sample) {
      // first visit to the web version: open a realistic example instead of an empty tab
      const t = newTab({ name: 'order-service-sample.log', content: WEB.sample, lang: 'log' });
      t.detectDone = true;
    }
    if (!tabs.length) newTab({});
    const idx = sess && sess.active >= 0 && sess.active < tabs.length ? sess.active : 0;
    activate(tabs[idx]);
    if (startup.length) addOpened(startup);
  }

  // ---------------- status bar ----------------
  function updateStatus() {
    if (!active) return;
    const pos = editor.getPosition() || { lineNumber: 1, column: 1 };
    const sel = editor.getSelection();
    let txt = 'Ln ' + pos.lineNumber + ', Col ' + pos.column;
    if (sel && !sel.isEmpty()) txt += '  (' + active.model.getValueInRange(sel).length + ' selected)';
    txt += '   ' + active.model.getLineCount().toLocaleString() + ' lines';
    $('#st-pos').textContent = txt;
    $('#st-eol').textContent = active.model.getEOL() === '\r\n' ? 'CRLF' : 'LF';
    $('#st-lang').value = active.model.getLanguageId();
    $('#st-enc').value = active.enc;
    const an = isLogTab(active) ? active.an : null;
    $('#st-log').hidden = !an;
    if (an) $('#st-log').textContent = (an.formatLabel || 'Log') + '  ' + an.counts.ERROR + ' errors  ' + an.counts.WARN + ' warnings';
    $('#st-follow').hidden = !(active.path && isLogTab(active));
    $('#st-preview').hidden = !(active.model.getLanguageId() === 'markdown' || active.preview);
    $('#st-follow').classList.toggle('on', !!active.tailing);
    $('#st-follow').textContent = active.tailing ? 'Following' : 'Follow';
  }

  // ---------------- table paste ----------------
  function insertText(text) {
    const sels = editor.getSelections();
    if (sels.length === 1) {
      const s = sels[0];
      const before = active.model.getValueInRange({ startLineNumber: s.startLineNumber, startColumn: 1, endLineNumber: s.startLineNumber, endColumn: s.startColumn });
      if (before.trim() !== '') text = '\n' + text;
    }
    editor.pushUndoStop();
    editor.executeEdits('table-paste', sels.map((range) => ({ range, text, forceMoveMarkers: true })));
    editor.pushUndoStop();
  }

  const TABLE_TARGETS = new Set(['plaintext', 'markdown']);
  const tableFormat = () => (settings.pasteFormat === 'off' ? 'markdown' : settings.pasteFormat);

  function onPaste(e) {
    if (plainNext) { plainNext = false; return; }
    if (settings.pasteFormat === 'off') return;
    const cd = e.clipboardData;
    if (!cd) return;
    let rows = null;
    let guessed = false;
    let offer = null;
    const html = cd.getData('text/html');
    const plain = cd.getData('text/plain');
    const lang = active.model.getLanguageId();
    if (html) rows = Tables.extractTableFromHtml(html);

    // Rich content with tables (an AI chat, a wiki page, a Teams or Outlook message): keep everything
    // as Markdown so headings, lists, code blocks and tables survive, like Teams renders them.
    if (!rows && html && TABLE_TARGETS.has(lang) && (Markdown.htmlTableCount(html) > 0 || (/<pre\b/i.test(html) && /<h[1-6]\b/i.test(html)))) {
      const md = Markdown.htmlToMarkdown(html);
      if (md.trim()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        insertText(md);
        announceMarkdownPaste(md, 'Pasted with formatting');
        return;
      }
    }
    if (rows) {
      e.preventDefault();
      e.stopImmediatePropagation();
      applyPlan({ rows }, plain, null);
      return;
    }
    const plan = planPlain(plain, lang);
    if (!plan) return; // ordinary paste
    e.preventDefault();
    e.stopImmediatePropagation();
    applyPlan(plan, plain, null);
  }

  // What to do with pasted plain text: aligned Markdown, a table, an offer to convert, or nothing.
  function planPlain(plain, lang) {
    if (!plain) return null;
    const tsv = Tables.parseTsv(plain);
    if (tsv) return { rows: tsv };
    if (!TABLE_TARGETS.has(lang)) return null;
    // Markdown text with tables (an AI chat's "copy" button): align the tables and show it as Markdown.
    if (Markdown.countTables(plain) > 0 && Markdown.looksLikeMarkdown(plain)) return { md: Markdown.alignTables(plain) };
    // Never touch logs; code and prose fall through every check below.
    if (Logs.isLogText(plain)) return null;
    const aligned = Tables.parseAligned(plain);
    if (aligned) return { rows: aligned };
    // Columns separated by single spaces (tabs lost when copied from chat, email or PDF).
    const inf = Tables.inferSpaceTable(plain);
    if (inf && inf.confident) return { rows: inf.rows, guessed: true };
    if (inf) return { offer: inf };
    // CSV is offered, not converted: a note that should stay CSV stays CSV unless asked.
    if (/,/.test(plain) && plain.trim().split(/\r?\n/).length >= 2) {
      const csv = Tables.parseCsvTable(plain.trim());
      if (csv) return { offer: { rows: csv, kind: 'csv' } };
    }
    return null;
  }

  // Apply a plan. range = null: insert at the cursor (paste event). range = Range: the text is already
  // in the editor there (phones and some keyboards insert pasted text without a paste event).
  function applyPlan(plan, plain, range) {
    const norm = plain.replace(/\r\n?/g, '\n');
    const put = (text) => {
      if (!range) {
        const start = editor.getSelection().getStartPosition();
        insertText(text);
        const end = editor.getPosition();
        return new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
      }
      editor.pushUndoStop();
      editor.executeEdits('table-paste', [{ range, text, forceMoveMarkers: true }]);
      editor.pushUndoStop();
      const end = active.model.getPositionAt(active.model.getOffsetAt(range.getStartPosition()) + text.length);
      return new monaco.Range(range.startLineNumber, range.startColumn, end.lineNumber, end.column);
    };
    if (plan.md) {
      put(plan.md);
      announceMarkdownPaste(plan.md, 'Pasted Markdown');
      return;
    }
    if (plan.offer) {
      const offer = plan.offer;
      const at = range || put(norm);
      toast(offer.kind === 'csv' ? 'This looks like CSV data.' : 'This looks like a table separated by spaces.', 9000, { label: 'Convert to table', run: () => {
        editor.pushUndoStop();
        editor.executeEdits('table-convert', [{ range: at, text: Tables.formatRows(offer.rows, tableFormat()) + '\n' }]);
        editor.pushUndoStop();
        toast('Converted (' + offer.rows.length + ' rows, ' + offer.rows[0].length + ' columns). Columns were guessed: Alt+T to adjust.', 5000);
      } });
      return;
    }
    const rows = plan.rows;
    const wasEmpty = active.model.getValueLength() === (range ? plain.length : 0);
    const at = put(Tables.formatRows(rows, tableFormat()) + '\n');
    // a tab that holds just this table becomes Markdown, so the Preview button (rendered table) is one tap away
    if (wasEmpty && tableFormat() === 'markdown' && active.model.getLanguageId() === 'plaintext') {
      monaco.editor.setModelLanguage(active.model, 'markdown');
      active.detectDone = true;
      updateStatus();
    }
    if (plan.guessed) {
      toast('Pasted as a table (' + rows.length + ' rows, ' + rows[0].length + ' columns). Columns were guessed from spaces.', 9000,
        { label: 'Keep as plain text', run: () => {
          editor.pushUndoStop();
          editor.executeEdits('table-revert', [{ range: at, text: norm }]);
          editor.pushUndoStop();
          editor.focus();
        } });
    } else {
      toast('Table pasted (' + rows.length + ' rows, ' + rows[0].length + ' columns). Ctrl+Shift+V pastes plain text.', 4500);
    }
  }

  // ---------- pasted text that arrives without a paste event (Android / iOS keyboards) ----------
  let lastPasteEvent = 0;
  let lastOwnEdit = 0;
  function watchKeyboardPaste() {
    const exec = editor.executeEdits.bind(editor);
    editor.executeEdits = (...a) => { lastOwnEdit = Date.now(); return exec(...a); };
    // A paste may arrive as one change or as a rapid series of single-character inserts (mobile keyboards,
    // IMEs). Either way it is far faster than anyone types, so collect bursts of edits and look at the
    // block they produced once the burst ends.
    let burst = null;
    let timer = null;
    editor.onDidChangeModelContent((e) => {
      const now = Date.now();
      if (now - lastPasteEvent < 1500 || now - lastOwnEdit < 300 || e.isFlush || e.isUndoing || e.isRedoing ||
          !active || active.tailing || settings.pasteFormat === 'off' || plainNext) { burst = null; return; }
      const model = active.model;
      if (!burst || burst.model !== model || now - burst.last > 120) {
        burst = { model, start: e.changes[0].rangeOffset, first: now, last: now, events: 0, chars: 0, bad: false };
      }
      burst.last = now;
      burst.events++;
      burst.chars += e.changes.reduce((a, c) => a + c.text.length, 0);
      if (e.changes.length !== 1) burst.bad = true; // multi-cursor typing, replace-all, formatting
      clearTimeout(timer);
      timer = setTimeout(checkBurst, 220);
    });
    function checkBurst() {
      const b = burst;
      burst = null;
      if (!b || b.bad || !active || b.model !== active.model || b.chars < 20) return;
      if (b.events > 1 && (b.last - b.first) / b.events > 25) return; // human typing speed
      const model = b.model;
      const pos = editor.getPosition();
      if (!pos) return;
      const endOff = model.getOffsetAt(pos);
      if (endOff <= b.start || Math.abs(endOff - b.start - b.chars) > Math.max(4, b.chars * 0.15)) return;
      const range = monaco.Range.fromPositions(model.getPositionAt(b.start), pos);
      const text = model.getValueInRange(range).replace(/\r\n?/g, '\n');
      if ((text.match(/\n/g) || []).length < 2) return;
      const plan = planPlain(text.replace(/\n$/, ''), model.getLanguageId());
      if (plan) applyPlan(plan, text, range);
    }
  }

  function announceMarkdownPaste(md, what) {
    if (active.model.getLanguageId() === 'plaintext') { monaco.editor.setModelLanguage(active.model, 'markdown'); active.detectDone = true; }
    const t = Markdown.countTables(md);
    const c = (md.match(/^\s*(```|~~~)/gm) || []).length / 2;
    const parts = [];
    if (t) parts.push(t + ' table' + (t === 1 ? '' : 's'));
    if (c >= 1) parts.push(Math.floor(c) + ' code block' + (c >= 2 ? 's' : ''));
    if (active.preview) { renderPreview(); toast(what + (parts.length ? ': ' + parts.join(', ') : '') + '.', 4000); return; }
    toast(what + (parts.length ? ': ' + parts.join(', ') : '') + '. Tables stay aligned as Markdown.', 9000,
      { label: 'Show preview', run: () => setPreview(true) });
  }

  // ======================================================================
  // FULL SCREEN for the preview, the comparison, the results panel and Copilot
  // ======================================================================
  // The area covers the whole app window, and the window itself goes full screen where that is
  // allowed (desktop app, browser tab). Esc, the same button or double-clicking the header exits.
  let fsEl = null;
  let fsExit = null;
  function isFullscreen(el) { return !!fsEl && (!el || fsEl === el); }
  function enterFullscreen(el, { label, onExit } = {}) {
    if (!el) return;
    if (fsEl) exitFullscreen();
    fsEl = el;
    fsExit = onExit || null;
    el.classList.add('fs-mode');
    document.body.classList.add('has-fs');
    try {
      const root = document.documentElement;
      if (settings.fsWindow !== false && document.fullscreenEnabled && root.requestFullscreen && !document.fullscreenElement) root.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    } catch { /* not allowed here: the in-app full screen still works */ }
    updateFsButtons();
    layoutEditors();
    toast((label || 'This view') + ' is full screen. Press Esc to exit.', 2600);
  }
  function exitFullscreen() {
    if (!fsEl) return;
    const el = fsEl;
    const cb = fsExit;
    fsEl = null;
    fsExit = null;
    el.classList.remove('fs-mode');
    document.body.classList.remove('has-fs');
    try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {}); } catch { /* ignore */ }
    updateFsButtons();
    layoutEditors();
    if (cb) cb();
  }
  function toggleFullscreen(el, opts) { if (isFullscreen(el)) exitFullscreen(); else enterFullscreen(el, opts); }
  function layoutEditors() {
    setTimeout(() => { if (editor) editor.layout(); if (typeof diffEditor !== 'undefined' && diffEditor) diffEditor.layout(); }, 30);
  }
  function updateFsButtons() {
    $$('.fs-btn').forEach((b) => {
      const host = b.closest('#preview, #diff, #panel, #cp-host');
      const on = !!host && host === fsEl;
      b.classList.toggle('on', on);
      b.title = on ? 'Exit full screen (Esc)' : (b.dataset.title || b.title);
      if (!b.dataset.title && !on) b.dataset.title = b.title;
      b.innerHTML = on ? '<svg viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
      b.setAttribute('aria-pressed', String(on));
    });
  }
  function wireFullscreen() {
    $$('.fs-btn').forEach((b) => { b.dataset.title = b.title; });
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && fsEl) exitFullscreen(); });
    // Esc leaves full screen; dialogs, menus, the palette, the find box and suggestions get Esc first.
    // (Capture phase: decided before those close themselves on the same key press.)
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !fsEl) return;
      if (!$('#modal').hidden || $('.menu') || $('#snap-picker') || !$('#palette').hidden || $('.tab-rename, .fl-rename')) return;
      const ae = document.activeElement;
      if (ae && ae.closest && (ae.closest('.find-widget') || ae.closest('.suggest-widget'))) return;
      if ($$('.monaco-editor .suggest-widget.visible, .monaco-editor .find-widget.visible').some((w) => fsEl.contains(w))) return;
      e.preventDefault();
      e.stopPropagation();
      exitFullscreen();
    }, true);
    const head = (sel, el, opts) => {
      const hd = $(sel);
      if (hd) hd.addEventListener('dblclick', (e) => { if (e.target.closest('button, select, input, a')) return; toggleFullscreen(el(), opts()); });
    };
    $('#pv-full').onclick = () => toggleFullscreen($('#preview'), { label: 'The preview' });
    head('#preview .pv-head', () => $('#preview'), () => ({ label: 'The preview' }));
    $('#panel-full').onclick = () => toggleFullscreen($('#panel'), { label: 'The results panel' });
    head('#panel-head', () => $('#panel'), () => ({ label: 'The results panel' }));
    $('#cp-full').onclick = () => toggleFullscreen($('#cp-host'), { label: 'Copilot' });
  }

  // ======================================================================
  // MARKDOWN PREVIEW
  // ======================================================================
  function setPreview(on, { full } = {}) {
    if (!active) return;
    active.preview = on;
    applyPreview();
    if (on && full) enterFullscreen($('#preview'), { label: 'The preview' });
    else if (on) toast('Preview on. Drag its left edge to resize, or press Alt+Shift+P for full screen. Copy as rich text pastes into Teams or Outlook with tables intact.', 5000);
  }

  function applyPreview() {
    const on = !!(active && active.preview);
    if (!on && isFullscreen($('#preview'))) exitFullscreen();
    $('#preview').hidden = !on;
    $('#preview').style.flexBasis = (settings.previewW || 50) + '%';
    $('#work').classList.toggle('with-preview', on);
    $('#st-preview').classList.toggle('on', on);
    if (on) renderPreview();
    setTimeout(() => editor && editor.layout(), 0);
  }

  const renderPreview = () => {
    if (!active || !active.preview) return;
    const scroller = $('#preview-body');
    const body = $('#preview-doc');
    const keep = scroller.scrollTop;
    $('#pv-name').textContent = active.name;
    body.innerHTML = '';
    if (active.model.getValueLength() > 3000000) {
      body.append(h('p', { class: 'hint' }, 'This tab is too large to preview.'));
      return;
    }
    if (active.model.getLanguageId() === 'markdown' || active.model.getLanguageId() === 'plaintext' && Markdown.looksLikeMarkdown(active.model.getValue().slice(0, 200000))) {
      body.append(Markdown.render(active.model.getValue(), document));
    } else {
      // logs, code, CSV: Markdown rules would reflow the lines, so show them exactly as written
      const pre = h('pre', { class: 'pv-plain' });
      pre.textContent = active.model.getValue().slice(0, 2000000);
      body.append(h('p', { class: 'hint', style: 'margin-top:0' }, 'This tab is ' + (active.model.getLanguageId() === 'log' ? 'a log' : 'not Markdown') + ', so the preview shows it as written. Paste a chat or Markdown to see formatted tables.'), pre);
    }
    body.querySelectorAll('table.md-table').forEach(decorateTable);
    if (!body.childNodes.length) body.append(h('p', { class: 'hint' }, 'Nothing to preview yet. Paste a chat or type Markdown.'));
    scroller.scrollTop = keep;
  };
  const schedulePreview = debounce(renderPreview, 180);

  // Drag the preview's left edge to make it wider or narrower (20%-85% of the editor area).
  function wirePreviewResize() {
    const g = $('#pv-resize');
    const set = (pct, save) => {
      const v = Math.max(20, Math.min(85, pct));
      $('#preview').style.flexBasis = v + '%';
      if (save) { settings.previewW = Math.round(v * 10) / 10; saveSettings(); }
      if (editor) editor.layout();
    };
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || isFullscreen($('#preview'))) return;
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      const box = $('#work').getBoundingClientRect();
      document.body.classList.add('col-resizing');
      const move = (ev) => set(((box.right - ev.clientX) / box.width) * 100);
      const up = () => {
        g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up);
        document.body.classList.remove('col-resizing');
        set(parseFloat($('#preview').style.flexBasis), true);
      };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up);
    });
    g.addEventListener('dblclick', () => set(50, true));
    g.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      set((parseFloat($('#preview').style.flexBasis) || 50) + (e.key === 'ArrowLeft' ? 5 : -5), true);
    });
  }

  function decorateTable(table) {
    const wrap = table.parentElement;
    const tools = h('div', { class: 'md-table-tools' },
      h('button', { onclick: async () => { const r = Markdown.tableRows(table); await api.clipboardWrite({ text: Tables.formatRows(r, 'tsv'), html: Tables.rowsToHtml(r) }); toast('Table copied. Paste into Teams, Outlook or Excel.'); } }, 'Copy table'),
      h('button', { onclick: () => editTableInView(wrap) }, 'Edit as table'));
    wrap.prepend(tools);
    table.querySelectorAll('td').forEach((td) => { if (td.textContent.length > 48) td.classList.add('long'); });
    const heads = Array.from(table.tHead.rows[0].cells);
    heads.forEach((th, ci) => {
      th.title = 'Sort by this column';
      th.addEventListener('click', () => {
        const asc = !(th.classList.contains('sorted') && th.classList.contains('asc'));
        heads.forEach((x) => x.classList.remove('sorted', 'asc'));
        th.classList.add('sorted');
        if (asc) th.classList.add('asc');
        const tb = table.tBodies[0];
        const rows = Array.from(tb.rows);
        const val = (r) => (r.cells[ci] ? r.cells[ci].textContent.trim() : '');
        const num = rows.every((r) => { const v = val(r).replace(/[,₹$%]/g, ''); return v === '' || !Number.isNaN(Number(v)); });
        rows.sort((a, b) => {
          const x = val(a); const y = val(b);
          const c = num ? (Number(x.replace(/[,₹$%]/g, '')) || 0) - (Number(y.replace(/[,₹$%]/g, '')) || 0) : x.localeCompare(y, undefined, { numeric: true });
          return asc ? c : -c;
        });
        rows.forEach((r) => tb.appendChild(r));
      });
    });
  }

  function editTableInView(wrap) {
    const start = +wrap.getAttribute('data-line');
    const rows = wrap.querySelectorAll('tr[data-line]');
    const end = rows.length ? Math.max(...Array.from(rows).map((r) => +r.getAttribute('data-line'))) : start + 1;
    editor.setSelection(new monaco.Range(start + 1, 1, end + 1, active.model.getLineMaxColumn(end + 1)));
    editor.revealLineInCenter(start + 1);
    openTableView();
  }

  // Rich HTML for Teams / Outlook / Word: the preview with inline styles, without our buttons.
  function previewRichHtml() { return richHtml($('#preview-doc')); }
  // A rendered Markdown element as HTML that keeps its look when pasted into Teams, Outlook or Word.
  function richHtml(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.md-table-tools, input').forEach((x) => x.remove());
    clone.querySelectorAll('[data-line]').forEach((x) => x.removeAttribute('data-line'));
    clone.querySelectorAll('table').forEach((t) => { t.removeAttribute('class'); t.setAttribute('border', '1'); t.setAttribute('cellspacing', '0'); t.setAttribute('cellpadding', '4'); t.style.cssText = 'border-collapse:collapse;font-family:Calibri,Segoe UI,Arial,sans-serif;font-size:11pt'; });
    clone.querySelectorAll('th').forEach((x) => { x.removeAttribute('class'); x.removeAttribute('title'); x.style.cssText += ';border:1px solid #999;padding:4px 8px;background:#f2f2f2;text-align:' + (x.style.textAlign || 'left'); });
    clone.querySelectorAll('td').forEach((x) => { x.style.cssText += ';border:1px solid #999;padding:4px 8px;text-align:' + (x.style.textAlign || 'left'); });
    clone.querySelectorAll('pre').forEach((x) => { x.style.cssText = 'background:#f6f8fa;border:1px solid #ddd;padding:8px;font-family:Consolas,monospace;font-size:10pt;white-space:pre-wrap'; });
    clone.querySelectorAll('code').forEach((x) => { if (x.parentElement.tagName !== 'PRE') x.style.cssText = 'font-family:Consolas,monospace;background:#f2f2f2;padding:0 3px'; });
    clone.querySelectorAll('.md-table-wrap').forEach((x) => { x.removeAttribute('class'); });
    return '<div style="font-family:Segoe UI,Calibri,Arial,sans-serif;font-size:11pt">' + clone.innerHTML + '</div>';
  }

  async function copyRichText() {
    if (!active) return;
    if (!active.preview) { active.preview = true; applyPreview(); }
    renderPreview();
    const ok = await api.clipboardWrite({ text: active.model.getValue(), html: previewRichHtml() });
    toast(ok === false ? 'Copying was blocked by the browser.' : 'Copied with formatting. Paste into Teams, Outlook or Word.', 4500);
  }

  function wirePreview() {
    $('#pv-close').onclick = () => setPreview(false);
    $('#pv-copy').onclick = copyRichText;
    $('#st-preview').onclick = () => setPreview(!(active && active.preview));
    $('#preview-body').addEventListener('click', (e) => {
      if (e.target.closest('button, a, th') || !window.getSelection().isCollapsed) return;
      const el = e.target.closest('[data-line]');
      if (!el) return;
      const ln = +el.getAttribute('data-line') + 1;
      editor.revealLineInCenter(ln);
      editor.setPosition({ lineNumber: ln, column: 1 });
    });
    editor.onDidScrollChange(() => {
      if (!active || !active.preview) return;
      const ranges = editor.getVisibleRanges();
      if (!ranges.length) return;
      const top = ranges[0].startLineNumber - 1;
      const body = $('#preview-body');
      let target = null;
      for (const el of body.querySelectorAll('[data-line]')) { if (+el.getAttribute('data-line') <= top) target = el; else break; }
      if (target) body.scrollTop = target.offsetTop - 8;
      else if (top === 0) body.scrollTop = 0;
    });
  }

  function findDuplicates() {
    if (!active) return;
    const log = isLogTab(active);
    const an = log ? analyze(active) : null;
    const lines = active.model.getLinesContent();
    const d = Logs.findDuplicates(an ? an.entries : [], lines, log);
    if (!d.length) { toast('No repeated ' + (log ? 'entries' : 'lines') + ' in this tab.'); return; }
    const cols = log ? ['message', 'level', 'count', 'first line', 'last line'] : ['line text', 'count', 'first line', 'last line'];
    showResults({ columns: cols, rows: d.map((g) => ({ line: g.first, values: log ? [g.text, g.level, String(g.count), String(g.first), String(g.last)] : [g.text, String(g.count), String(g.first), String(g.last)] })) },
      d.length + ' repeated ' + (log ? 'entries' : 'lines') + ' (' + d.reduce((a, g) => a + g.count - 1, 0) + ' extra copies)');
  }

  function shownText() {
    const an = isLogTab(active) ? analyze(active) : null;
    if (!an || !an.vis) return active.model.getValue();
    const out = [];
    an.entries.forEach((e, i) => { if (an.vis[i]) for (let l = e.start; l <= e.end; l++) out.push(an.lines[l]); });
    return out.join('\n');
  }
  async function copyShown() {
    if (!active) return;
    const text = shownText();
    const ok = await api.clipboardWrite({ text });
    const n = text ? text.split('\n').length : 0;
    toast(ok === false ? 'Copying was blocked by the browser.' : 'Copied ' + n.toLocaleString() + ' line' + (n === 1 ? '' : 's') + (active.an && active.an.vis ? ' shown by the filter.' : '.'), 3500);
  }

  // ---------- compare two tabs ----------
  let diffEditor = null;
  function compareWith(other) {
    if (!other || other === active) return false;
    closeCompare();
    const host = h('div', { id: 'diff' },
      h('div', { class: 'pv-head' }, h('strong', null, other.name + '  ↔  ' + active.name), h('span', { class: 'hint', style: 'margin:0 0 0 10px' }, 'left: ' + other.name + ', right: ' + active.name),
        h('span', { class: 'grow' }),
        h('button', { onclick: () => { if (diffEditor) diffEditor.goToDiff('next'); } }, 'Next change'),
        h('button', { onclick: () => { if (diffEditor) diffEditor.goToDiff('previous'); } }, 'Previous change'),
        h('button', { class: 'icon-btn small fs-btn', title: 'Full screen. Esc to exit', 'data-title': 'Full screen. Esc to exit', html: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>', onclick: () => toggleFullscreen($('#diff'), { label: 'The comparison' }) }),
        h('button', { class: 'icon-btn small', title: 'Close comparison', html: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>', onclick: closeCompare })),
      h('div', { class: 'diff-body' }));
    $('#work').append(host);
    host.querySelector('.pv-head').title = 'Double-click to toggle full screen';
    host.querySelector('.pv-head').addEventListener('dblclick', (e) => { if (!e.target.closest('button')) toggleFullscreen(host, { label: 'The comparison' }); });
    updateWelcome();
    diffEditor = monaco.editor.createDiffEditor(host.querySelector('.diff-body'), {
      automaticLayout: true, renderSideBySide: true, originalEditable: false, readOnly: false, theme: 'tf',
      renderGutterMenu: false, renderMarginRevertIcon: false, // no empty revert-arrow strip between the sides
      fontFamily: `'${settings.fontFamily}', 'JetBrains Mono', Consolas, monospace`, fontSize: settings.fontSize, ignoreTrimWhitespace: false,
    });
    diffEditor.setModel({ original: other.model, modified: active.model });
    return true;
  }
  function closeCompare() {
    if (isFullscreen($('#diff'))) exitFullscreen();
    if (diffEditor) { diffEditor.setModel(null); diffEditor.dispose(); diffEditor = null; }
    const d = $('#diff');
    if (d) d.remove();
    updateWelcome();
    if (editor) setTimeout(() => editor.layout(), 0);
  }
  async function pickCompare() {
    const others = tabs.filter((t) => t !== active && !isPristineUntitled(t));
    if (!others.length) { toast('Open another tab to compare with.'); return; }
    const sel = h('select', { style: 'width:100%' }, others.map((t, i) => h('option', { value: String(i) }, t.name)));
    const body = h('div', null, h('div', { class: 'field' }, h('label', null, 'Compare ' + active.name + ' with'), sel),
      h('p', { class: 'hint' }, 'Tip: to compare two parts of one log, copy each part into its own tab (Alt+N) first.'));
    const v = await modal('Compare tabs', body, [{ label: 'Cancel', value: null }, { label: 'Compare', value: 'go', primary: true }]);
    if (v) compareWith(others[+sel.value]);
  }

  // ======================================================================
  // INCIDENT (0.16.0): several logs on one clock. Each log is a lane, dots are entries (size = how many,
  // colour = level). Drag across the lanes for a time window; the reader on the right lists those entries
  // from every log in time order, and a click opens that line in its tab. Findings on the left are spotted
  // by the engine (Logs.incident): errors in several services at once, repeated errors, a service going
  // quiet, slow calls. It covers the editor area like the comparison does; the tabs stay as they are.
  // ======================================================================
  const INCIDENT_BUCKETS = 120;
  const LANE_TINTS = ['#5fb3ff', '#4fc1b0', '#b39ddb', '#e3a35b', '#e88bc4', '#9ccc65', '#7fa7b5', '#f06292'];
  const INCIDENT_SAMPLES = ['api-gateway.log', 'order-service.log', 'payment-service.log', 'inventory-service.log'];
  let incident = null; // { tabs, res, buckets, win: [from, to] | null, finding, reader }
  const maskText = (s) => Logs.maskSecrets(String(s || ''), settings.mask).text;

  async function sampleText(name) {
    if (name === 'order-service.log' && WEB.sample) return WEB.sample;
    if (WEB.samples && WEB.samples[name]) return WEB.samples[name];
    if (api.sample) { const r = await api.sample(name); return r && r.content; }
    return null;
  }
  async function openIncidentSample() {
    const list = [];
    for (const name of INCIDENT_SAMPLES) {
      let t = tabs.find((x) => x.name === name && !x.path);
      if (!t) {
        const text = await sampleText(name);
        if (!text) { toast('The incident sample is not available in this version.'); return; }
        t = newTab({ name, content: text, lang: 'log' });
        t.detectDone = true;
      }
      list.push(t);
    }
    activate(list[1]);
    openIncident(list);
  }
  async function pickIncident() {
    const logs = tabs.filter((t) => isLogTab(t) && t.model.getValueLength() > 0);
    if (logs.length < 2) {
      toast('Open two or more logs (for example one per service) to look at them together.', 7000, { label: 'Try the incident sample', run: openIncidentSample });
      return;
    }
    const boxes = logs.map((t) => h('input', { type: 'checkbox', checked: true }));
    const body = h('div', null,
      h('p', { class: 'hint', style: 'margin-top:0' }, 'Each log becomes a lane on one shared clock. TextForge looks for errors that hit several services at once, repeated errors, a service that goes quiet and slow calls.'),
      ...logs.map((t, i) => h('label', { class: 'check' }, boxes[i], t.name)));
    const v = await modal('Investigate logs together', body, [{ label: 'Cancel', value: null }, { label: 'Investigate', value: 'go', primary: true }]);
    if (!v) return;
    const chosen = logs.filter((t, i) => boxes[i].checked);
    if (chosen.length < 1) return;
    openIncident(chosen);
  }

  function openIncident(list) {
    closeCompare();
    removeIncidentView();
    const sources = list.map((t) => { const an = analyze(t) || { entries: [], lines: t.model.getLinesContent() }; return { name: t.name, lines: an.lines, entries: an.entries }; });
    const res = Logs.incident(sources);
    if (res.min == null) { toast('These logs have no timestamps, so they cannot be lined up on one clock.', 6000); return; }
    // reopening the same incident (for example after a log was closed) keeps the report; a new one starts empty
    const same = incident && list.every((t) => incident.tabs.includes(t));
    const kept = same && incident.pins && incident.pins.length ? { pins: incident.pins, report: incident.report } : null;
    incident = { tabs: list.slice(), res, buckets: res.services.map((s) => Logs.incidentBuckets(s, res.min, res.max, INCIDENT_BUCKETS)), win: null, finding: null, reader: null,
      pins: kept ? kept.pins : [], report: kept ? kept.report : { title: 'Incident ' + Logs.formatTs(res.min, true).slice(0, 16), summary: '' } };
    renderIncident();
  }
  function removeIncidentView() {
    if (isFullscreen($('#incident'))) exitFullscreen();
    const el = $('#incident');
    if (el) el.remove();
    document.body.classList.remove('incident-open');
    updateWelcome();
  }
  async function closeIncident() {
    if (incident && incident.pins.length) {
      const go = await modal('Close the incident?', '<p>Your report has ' + incident.pins.length + ' pinned item' + (incident.pins.length === 1 ? '' : 's') + '. Closing the incident forgets them. Copy the report or open it as a tab first if you want to keep it.</p>',
        [{ label: 'Keep it open', value: false }, { label: 'Close', value: true, primary: true }]);
      if (!go) return;
    }
    removeIncidentView(); incident = null; if (editor) setTimeout(() => editor.layout(), 0);
  }
  function reopenIncident() {
    if (!incident) return;
    const alive = incident.tabs.filter((t) => tabs.includes(t));
    if (alive.length < incident.tabs.length) { if (alive.length) openIncident(alive); else incident = null; return; }
    renderIncident();
  }

  const pctOf = (ts) => ((ts - incident.res.min) / Math.max(1, incident.res.max - incident.res.min)) * 100;
  const tsAt = (pct) => incident.res.min + (pct / 100) * Math.max(1, incident.res.max - incident.res.min);

  function renderIncident() {
    removeIncidentView();
    const st = incident;
    const res = st.res;
    const fsBtn = h('button', { class: 'icon-btn small fs-btn', title: 'Full screen. Esc to exit', 'data-title': 'Full screen. Esc to exit', html: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>', onclick: () => toggleFullscreen($('#incident'), { label: 'The incident' }) });
    const reqs = incidentRequests();
    const failedN = reqs.filter((r) => r.failed).length;
    const inRequests = st.mode === 'requests';
    const inReport = st.mode === 'report';
    const modes = h('div', { class: 'inc-modes', role: 'tablist', 'aria-label': 'Incident view' },
      h('button', { role: 'tab', class: inRequests || inReport ? '' : 'on', 'aria-selected': String(!inRequests && !inReport), onclick: () => setIncidentMode('timeline'), title: 'All logs on one clock, with findings' }, 'Timeline'),
      h('button', { role: 'tab', class: inRequests ? 'on' : '', 'aria-selected': String(inRequests), onclick: () => setIncidentMode('requests'), title: 'Follow one request across the logs' }, 'Requests',
        h('span', { class: 'inc-mode-n' + (failedN ? ' bad' : '') }, failedN ? failedN + ' failed' : String(reqs.length))),
      h('button', { role: 'tab', class: st.mode === 'report' ? 'on' : '', 'aria-selected': String(st.mode === 'report'), onclick: () => setIncidentMode('report'), title: 'What you pinned, with your notes, ready for Teams or a ticket' }, 'Report',
        h('span', { class: 'inc-mode-n inc-pin-count' + (st.pins.length ? ' pinned' : '') }, String(st.pins.length))));
    const head = h('div', { class: 'pv-head inc-head' },
      h('strong', null, 'Incident'), h('span', { class: 'inc-sub' }, res.services.length + ' logs · ' + Logs.formatTs(res.min) + ' to ' + Logs.formatTs(res.max) + ' · ' + Logs.formatDuration(res.max - res.min)),
      h('span', { class: 'grow' }), modes, h('span', { class: 'grow' }),
      h('button', { onclick: copyIncidentFindings, title: 'Copy the findings as text, with secrets masked' }, 'Copy findings'),
      fsBtn,
      h('button', { class: 'icon-btn small', title: 'Close the incident (your tabs stay open)', 'aria-label': 'Close the incident', html: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>', onclick: closeIncident }));
    head.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) toggleFullscreen($('#incident'), { label: 'The incident' }); });
    if (inReport) {
      $('#work').append(h('div', { id: 'incident', class: 'inc-report-mode' }, head, buildReportBody()));
      document.body.classList.add('incident-open');
      updateWelcome();
      renderReportPreview();
      return;
    }
    if (inRequests) {
      $('#work').append(h('div', { id: 'incident', class: 'inc-requests-mode' }, head, buildRequestsBody()));
      document.body.classList.add('incident-open');
      updateWelcome();
      drawRequestDetail();
      return;
    }

    // findings
    const fList = h('div', { class: 'inc-flist', role: 'list' });
    const KIND = { together: 'together', error: 'error', quiet: 'quiet', slow: 'slow' };
    res.findings.forEach((f, i) => {
      const when = f.from == null ? '' : Logs.formatTs(f.from) + (f.to && f.to - f.from >= 1000 ? ' to ' + Logs.formatTs(f.to) : '');
      const card = h('button', { class: 'inc-f k-' + f.kind + (st.finding === i ? ' on' : ''), onclick: () => pickFinding(i) },
        h('span', { class: 'inc-f-top' }, h('span', { class: 'inc-tag' }, KIND[f.kind] || f.kind), h('span', { class: 'inc-when' }, when)),
        h('span', { class: 'inc-f-title' }, maskText(f.title)),
        h('span', { class: 'inc-f-detail' }, maskText(f.detail)));
      fList.append(h('div', { class: 'inc-f-wrap', role: 'listitem' }, card, pinButton(findingKey(f), () => pinFinding(i))));
    });
    if (!res.findings.length) fList.append(h('p', { class: 'hint' }, 'Nothing stands out: no errors, quiet services or slow calls.'));
    const findings = h('aside', { class: 'inc-findings', 'aria-label': 'Findings' },
      h('div', { class: 'inc-col-head' }, h('strong', null, 'Findings'), h('span', null, String(res.findings.length))), fList);

    // ruler + lanes
    const ticks = h('div', { class: 'inc-ticks' });
    const ruler = h('div', { class: 'inc-ruler' }, h('span', { class: 'inc-lbl-sp' }), h('div', { class: 'inc-ruler-track' }, ticks, h('div', { class: 'inc-win-label', hidden: true })));
    const lanes = h('div', { class: 'inc-lanes' });
    res.services.forEach((s, si) => {
      const tab = st.tabs[si];
      const tint = LANE_TINTS[si % LANE_TINTS.length];
      const track = h('div', { class: 'inc-track', 'data-s': String(si) }, h('div', { class: 'inc-win', hidden: true }));
      st.buckets[si].forEach((b, bi) => {
        if (!b.total) return;
        const size = 6 + Math.min(12, Math.round(Math.log2(b.total + 1) * 2.6));
        const cls = b.error ? 'err' : b.warn ? 'warn' : 'other';
        const from = res.min + (res.max - res.min) * bi / INCIDENT_BUCKETS;
        track.append(h('span', { class: 'inc-dot ' + cls, style: `left:${(bi + 0.5) * 100 / INCIDENT_BUCKETS}%;width:${size}px;height:${size}px`,
          title: Logs.formatTs(from) + ' · ' + b.total + ' entr' + (b.total === 1 ? 'y' : 'ies') + (b.error ? ', ' + b.error + ' error' + (b.error === 1 ? '' : 's') : '') + (b.warn ? ', ' + b.warn + ' warning' + (b.warn === 1 ? '' : 's') : '') }));
      });
      const errs = s.counts.ERROR || 0;
      lanes.append(h('div', { class: 'inc-lane' },
        h('button', { class: 'inc-lbl', title: 'Open ' + tab.name, onclick: () => openIncidentLine(tab, 1) },
          h('span', { class: 'inc-svc' }, h('i', { style: 'background:' + tint }), s.name),
          h('span', { class: 'inc-meta' }, s.entries.length.toLocaleString() + ' entries', h('b', { class: errs ? 'bad' : '' }, errs + ' error' + (errs === 1 ? '' : 's')))),
        track));
    });
    const main = h('div', { class: 'inc-main' }, ruler, lanes,
      h('p', { class: 'inc-hint' }, 'Drag across the lanes to look at a time window; double-click to clear it. Click a dot for its entries.'));

    // reader
    const reader = h('aside', { class: 'inc-reader', 'aria-label': 'Entries' }, h('div', { class: 'inc-col-head' }, h('strong', { class: 'inc-r-title' }, 'Entries'), h('span', { class: 'inc-r-sub' }), h('div', { class: 'inc-r-follow' })), h('div', { class: 'inc-rlist' }));
    const host = h('div', { id: 'incident' }, head, h('div', { class: 'inc-body' }, findings, main, reader));
    $('#work').append(host);
    document.body.classList.add('incident-open');
    updateWelcome();
    wireIncidentLanes(lanes);
    drawTicks();
    drawWindow();
    if (st.reader) showReader(st.reader.title, st.reader.sub, st.reader.refs, true);
    else if (res.findings.length) pickFinding(0);
    else showReader('Entries', 'Pick a finding, drag a time window or click a dot.', []);
  }

  function wireIncidentLanes(lanes) {
    let drag = null;
    const pctFromX = (track, x) => { const r = track.getBoundingClientRect(); return Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100)); };
    lanes.addEventListener('pointerdown', (e) => {
      const track = e.target.closest('.inc-track');
      if (!track || e.button !== 0) return;
      drag = { track, x0: e.clientX, p0: pctFromX(track, e.clientX), moved: false, id: e.pointerId };
    });
    lanes.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!drag.moved && Math.abs(e.clientX - drag.x0) < 5) return;
      if (!drag.moved) { drag.moved = true; lanes.setPointerCapture(drag.id); lanes.classList.add('brushing'); }
      const p = pctFromX(drag.track, e.clientX);
      incident.win = [tsAt(Math.min(drag.p0, p)), tsAt(Math.max(drag.p0, p))];
      drawWindow();
    });
    const end = (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      lanes.classList.remove('brushing');
      if (d.moved) { incident.finding = null; markFinding(); showWindowEntries(); return; }
      // a click: the entries of the dot under the pointer (that log only)
      const si = +d.track.dataset.s;
      const bi = Math.min(INCIDENT_BUCKETS - 1, Math.floor(d.p0 / 100 * INCIDENT_BUCKETS));
      const near = [bi, bi - 1, bi + 1].find((k) => incident.buckets[si][k] && incident.buckets[si][k].total);
      if (near == null) return;
      const b = incident.buckets[si][near];
      const from = incident.res.min + (incident.res.max - incident.res.min) * near / INCIDENT_BUCKETS;
      showReader(incident.res.services[si].name + ' at ' + Logs.formatTs(from), b.total + ' entr' + (b.total === 1 ? 'y' : 'ies'), b.idx.map((i) => ({ s: si, e: i })));
    };
    lanes.addEventListener('pointerup', end);
    lanes.addEventListener('pointercancel', () => { drag = null; lanes.classList.remove('brushing'); });
    lanes.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.inc-track') || !incident.win) return;
      incident.win = null;
      incident.finding = null;
      markFinding();
      drawWindow();
      showReader('Entries', 'Pick a finding, drag a time window or click a dot.', []);
    });
  }

  // As many time labels as fit the ruler's width (about one per 110 px).
  function drawTicks() {
    const host = $('#incident');
    if (!host || !incident) return;
    const track = host.querySelector('.inc-ruler-track');
    const box = host.querySelector('.inc-ticks');
    const n = Math.max(1, Math.min(8, Math.floor(track.clientWidth / 110)));
    const res = incident.res;
    box.replaceChildren(...Array.from({ length: n + 1 }, (_, i) => h('span', { style: 'left:' + (i * 100 / n) + '%' }, Logs.formatTs(res.min + (res.max - res.min) * i / n))));
  }
  window.addEventListener('resize', debounce(() => { if ($('#incident')) drawTicks(); }, 120));

  function drawWindow() {
    const host = $('#incident');
    if (!host || !incident) return;
    const w = incident.win;
    const label = host.querySelector('.inc-win-label');
    host.querySelectorAll('.inc-win').forEach((el) => {
      el.hidden = !w;
      if (w) { el.style.left = pctOf(w[0]) + '%'; el.style.width = Math.max(0.4, pctOf(w[1]) - pctOf(w[0])) + '%'; }
    });
    label.hidden = !w;
    if (w) {
      // centred on the window, kept inside the ruler
      label.style.left = Math.max(7, Math.min(93, (pctOf(w[0]) + pctOf(w[1])) / 2)) + '%';
      label.textContent = Logs.formatTs(w[0]) + ' – ' + Logs.formatTs(w[1]);
    }
  }
  function windowRefs(w) {
    const out = [];
    incident.res.services.forEach((s, si) => s.entries.forEach((e, i) => { if (e.ts != null && e.ts >= w[0] && e.ts <= w[1]) out.push({ s: si, e: i }); }));
    return out;
  }
  function showWindowEntries() {
    const w = incident.win;
    const refs = windowRefs(w);
    showReader(Logs.formatTs(w[0]) + ' to ' + Logs.formatTs(w[1]), refs.length + ' entr' + (refs.length === 1 ? 'y' : 'ies') + ' from ' + new Set(refs.map((r) => r.s)).size + ' log' + (new Set(refs.map((r) => r.s)).size === 1 ? '' : 's'), refs);
  }
  function pickFinding(i) {
    const f = incident.res.findings[i];
    if (!f) return;
    incident.finding = i;
    markFinding();
    if (f.from != null) {
      const pad = Math.max(1000, (incident.res.max - incident.res.min) * 0.01);
      incident.win = [Math.max(incident.res.min, f.from - pad), Math.min(incident.res.max, (f.to ?? f.from) + pad)];
    }
    drawWindow();
    if (f.refs.length) showReader(maskText(f.title), maskText(f.detail), f.refs);
    else showReader(maskText(f.title), maskText(f.detail) + '. Below: everything the other logs wrote meanwhile.', windowRefs(incident.win));
  }
  function markFinding() {
    $$('#incident .inc-f').forEach((el, k) => el.classList.toggle('on', k === incident.finding));
  }
  const READER_MAX = 400;
  function showReader(title, sub, refs, restoring) {
    const host = $('#incident');
    if (!host) return;
    incident.reader = { title, sub, refs };
    host.querySelector('.inc-r-title').textContent = title;
    host.querySelector('.inc-r-sub').textContent = sub || '';
    // requests with more than one entry can be followed from here
    const reqById = new Map(incidentRequests().filter((x) => x.hits > 1).map((x) => [x.id, x]));
    const ids = [...new Set(refs.map((r) => { const e = incident.res.services[r.s].entries[r.e]; return e && e.traceId; }).filter((id) => id && reqById.has(id)))];
    const follow = host.querySelector('.inc-r-follow');
    follow.replaceChildren(...(ids.length === 1 ? [h('button', { class: 'inc-follow-btn', onclick: () => followRequest(ids[0]) }, 'Follow request ' + ids[0].slice(0, 8) + ' ›')] : []));
    const list = host.querySelector('.inc-rlist');
    list.replaceChildren();
    const svcs = incident.res.services;
    const rows = refs.map((r) => ({ r, e: svcs[r.s].entries[r.e] })).filter((x) => x.e).sort((a, b) => (a.e.ts ?? 0) - (b.e.ts ?? 0) || a.r.s - b.r.s);
    for (const { r, e } of rows.slice(0, READER_MAX)) {
      const s = svcs[r.s];
      const first = (s.lines[e.start] || '');
      const msg = e.message || first;
      const lvl = (e.level || '').toUpperCase();
      const rq = e.traceId ? reqById.get(e.traceId) : null;
      const row = h('button', { class: 'inc-row lv-' + (lvl || 'none').toLowerCase() + (rq ? ' has-req' : ''), title: 'Open ' + s.file + ' at line ' + (e.start + 1), onclick: () => openIncidentLine(incident.tabs[r.s], e.start + 1) },
        h('span', { class: 'inc-row-top' },
          h('span', { class: 'inc-row-ts' }, e.ts != null ? Logs.formatTs(e.ts) + '.' + String(Math.round(e.ts % 1000)).padStart(3, '0') : '—'),
          h('span', { class: 'inc-row-svc' }, h('i', { style: 'background:' + LANE_TINTS[r.s % LANE_TINTS.length] }), s.name),
          lvl ? h('span', { class: 'inc-row-lvl' }, lvl) : null,
          h('span', { class: 'inc-row-ln' }, 'line ' + (e.start + 1))),
        h('span', { class: 'inc-row-msg' }, msg.length > 400 ? msg.slice(0, 399) + '…' : msg));
      list.append(rq ? h('div', { class: 'inc-row-wrap' }, row, h('button', { class: 'inc-row-follow', title: 'Follow request ' + rq.id + ' across the logs', onclick: () => followRequest(rq.id) }, 'Request ›')) : row);
    }
    if (!rows.length) list.append(h('p', { class: 'hint inc-empty' }, refs === null ? '' : 'Nothing here. Pick a finding, drag a time window or click a dot.'));
    if (rows.length > READER_MAX) list.append(h('p', { class: 'hint inc-empty' }, 'Showing the first ' + READER_MAX + ' of ' + rows.length.toLocaleString() + '. Narrow the time window to see the rest.'));
    if (!restoring) list.scrollTop = 0;
  }
  function openIncidentLine(tab, line) {
    if (!tab || !tabs.includes(tab)) { toast('That log is no longer open.'); return; }
    removeIncidentView();
    activate(tab);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.revealLineInCenter(line);
    editor.focus();
    toast('Opened ' + tab.name + ' at line ' + line + '.', 8000, { label: 'Back to the incident', run: reopenIncident });
  }
  // ---------- requests: follow one request across the logs (0.17.0) ----------
  function incidentRequests() {
    if (!incident.requests) incident.requests = Logs.requests(incident.res);
    return incident.requests;
  }
  function setIncidentMode(mode) {
    if (!incident) return;
    incident.mode = mode;
    renderIncident();
  }
  function followRequest(id) {
    if (!incident) return;
    const rq = incidentRequests().find((r) => r.id === id);
    if (!rq) { toast('That request is not in these logs.'); return; }
    incident.mode = 'requests';
    incident.req = Object.assign(incident.req || {}, { filter: 'all', q: '', id, step: null });
    renderIncident();
  }
  function showRequestOnTimeline(rq) {
    const pad = Math.max(500, (rq.to - rq.from) * 0.2);
    incident.mode = 'timeline';
    incident.win = [Math.max(incident.res.min, rq.from - pad), Math.min(incident.res.max, rq.to + pad)];
    incident.finding = null;
    incident.reader = { title: 'Request ' + rq.id.slice(0, 8), sub: rq.hits + ' entr' + (rq.hits === 1 ? 'y' : 'ies') + ' in ' + rq.services.length + ' log' + (rq.services.length === 1 ? '' : 's'), refs: rq.steps.flatMap((s) => s.refs) };
    renderIncident();
  }
  const fmtMs = (ms) => (ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(ms < 10000 ? 2 : 1).replace(/\.?0+$/, '') + ' s');
  const rqState = (r) => (r.failed ? 'failed' : r.slow ? 'slow' : 'ok');

  function buildRequestsBody() {
    const st = incident;
    const all = incidentRequests();
    if (!st.req) st.req = { filter: all.some((r) => r.failed) ? 'failed' : 'all', q: '', id: null, step: null };
    const R = st.req;
    const counts = { failed: all.filter((r) => r.failed).length, slow: all.filter((r) => r.slow).length, all: all.length };
    const chip = (key, label) => h('button', { class: 'inc-chip' + (R.filter === key ? ' on' : ''), 'aria-pressed': String(R.filter === key), onclick: () => { R.filter = key; R.id = null; drawRequestList(); drawRequestDetail(); } }, label + ' · ' + counts[key]);
    const search = h('input', { type: 'search', class: 'inc-rq-search', placeholder: 'Trace ID, route or service', 'aria-label': 'Find a request', value: R.q, spellcheck: false,
      oninput: (e) => { R.q = e.target.value; drawRequestList(); } });
    const left = h('aside', { class: 'inc-findings inc-rq-side', 'aria-label': 'Requests' },
      h('div', { class: 'inc-col-head' }, h('strong', null, 'Requests'), h('span', null, all.length + ' in these logs')),
      h('div', { class: 'inc-rq-tools' }, search, h('div', { class: 'inc-chips' }, chip('failed', 'Failed'), chip('slow', 'Slow'), chip('all', 'All'))),
      h('div', { class: 'inc-flist inc-rq-list', role: 'listbox', 'aria-label': 'Requests' }));
    const main = h('div', { class: 'inc-rq-main' },
      h('section', { class: 'inc-rq-card inc-rq-summary', 'aria-label': 'Summary' }),
      h('section', { class: 'inc-rq-card inc-wf', 'aria-label': 'Steps' }),
      h('section', { class: 'inc-rq-card inc-rq-lines', 'aria-label': 'Lines for this step' }));
    const body = h('div', { class: 'inc-body inc-rq-body' }, left, main);
    setTimeout(drawRequestList, 0);
    return body;
  }
  function visibleRequests() {
    const R = incident.req;
    const q = (R.q || '').toLowerCase();
    return incidentRequests().filter((r) => (R.filter === 'all' || (R.filter === 'failed' ? r.failed : r.slow)) &&
      (!q || (r.id + ' ' + (r.route || '') + ' ' + r.services.join(' ')).toLowerCase().includes(q)));
  }
  function drawRequestList() {
    const host = $('#incident .inc-rq-list');
    if (!host) return;
    const R = incident.req;
    const list = visibleRequests();
    host.replaceChildren();
    for (const r of list.slice(0, 500)) {
      host.append(h('button', { class: 'inc-req s-' + rqState(r) + (r.id === R.id ? ' on' : ''), role: 'option', 'aria-selected': String(r.id === R.id),
        onclick: () => { R.id = r.id; R.step = null; drawRequestList(); drawRequestDetail(); } },
        h('span', { class: 'inc-req-top' }, h('i', { class: 'inc-req-dot' }), h('span', { class: 'inc-req-id' }, r.id.slice(0, 8)), h('span', { class: 'inc-req-ms' }, fmtMs(r.ms))),
        h('span', { class: 'inc-req-sub' }, (r.route || 'no route') + ' · ' + r.services.length + ' service' + (r.services.length === 1 ? '' : 's') + (r.status ? ' · ' + r.status : ''))));
    }
    if (!list.length) host.append(h('p', { class: 'hint inc-empty' }, 'No request matches.'));
    $$('#incident .inc-chip').forEach((c) => { const on = c.textContent.toLowerCase().startsWith(R.filter); c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on)); });
  }
  function drawRequestDetail() {
    const host = $('#incident');
    if (!host || !incident.req) return;
    const R = incident.req;
    const all = incidentRequests();
    const list = visibleRequests();
    let rq = all.find((r) => r.id === R.id);
    if (!rq) { rq = list[0] || all[0]; R.id = rq ? rq.id : null; drawRequestList(); }
    const sum = host.querySelector('.inc-rq-summary');
    const wf = host.querySelector('.inc-wf');
    const lines = host.querySelector('.inc-rq-lines');
    if (!rq) { sum.replaceChildren(h('p', { class: 'hint' }, 'These logs have no trace IDs, so requests cannot be followed across them.')); wf.replaceChildren(); lines.replaceChildren(); return; }
    // summary
    const state = rqState(rq);
    sum.replaceChildren(
      h('div', { class: 'inc-rq-head' },
        h('span', { class: 'inc-rq-id' }, rq.id),
        h('span', { class: 'inc-rq-state s-' + state }, state === 'failed' ? 'failed' + (rq.status ? ' · ' + rq.status : '') : state === 'slow' ? 'slow' : 'ok' + (rq.status ? ' · ' + rq.status : '')),
        h('span', { class: 'inc-rq-when' }, (rq.route ? rq.route + ' · ' : '') + Logs.formatTs(rq.from) + ' · ' + fmtMs(rq.ms))),
      h('p', { class: 'inc-rq-text' }, maskText(rq.summary)),
      h('div', { class: 'inc-rq-actions' },
        pinRequestButton(rq),
        h('button', { onclick: () => showRequestOnTimeline(rq), title: 'See these entries among everything else that happened at the time' }, 'Show on the timeline'),
        h('button', { onclick: async () => { const ok = await api.clipboardWrite({ text: 'Request ' + rq.id + '\n' + maskText(rq.summary) }); toast(ok === false ? 'Copying was blocked by the browser.' : 'Copied the summary (secrets masked).', 2500); } }, 'Copy summary')));
    // waterfall
    const span = Math.max(1, rq.to - rq.from);
    const pct = (t) => ((t - rq.from) / span) * 100;
    if (R.step == null || !rq.steps[R.step]) { const e = rq.steps.findIndex((s) => s.level === 'error'); R.step = e >= 0 ? e : 0; }
    const axis = h('div', { class: 'inc-wf-axis' }, h('span', { class: 'inc-wf-lblsp' }, 'Step'),
      h('div', { class: 'inc-wf-scale' }, ...[0, 1, 2, 3, 4].map((i) => h('span', { style: 'left:' + (i * 25) + '%' }, i ? fmtMs(span * i / 4) : '0'))));
    const rows = rq.steps.map((s, i) => {
      const left = pct(s.from);
      const width = Math.max(0.8, pct(s.to) - left);
      const ticks = s.refs.map((ref) => { const e = incident.res.services[ref.s].entries[ref.e]; return h('i', { class: 'inc-wf-tick', style: 'left:' + pct(e.ts) + '%' }); });
      return h('button', { class: 'inc-wf-row lv-' + s.level + (i === R.step ? ' on' : ''), 'aria-pressed': String(i === R.step), onclick: () => { R.step = i; drawRequestDetail(); } },
        h('span', { class: 'inc-wf-lbl' },
          h('span', { class: 'inc-row-svc' }, h('i', { style: 'background:' + LANE_TINTS[s.s % LANE_TINTS.length] }), s.service),
          h('span', { class: 'inc-wf-op' }, maskText(s.label))),
        h('span', { class: 'inc-wf-track' },
          h('span', { class: 'inc-wf-bar', style: `left:${left}%;width:${width}%` }), ...ticks,
          // after the bar when there is room; otherwise inside the bar's end
          h('span', { class: 'inc-wf-dur' + (left + width > 78 ? ' inside' : ''), style: left + width > 78 ? `right:${100 - left - width}%;padding-right:8px` : `left:${left + width}%;padding-left:8px` },
            fmtMs(s.to - s.from) + (s.level === 'error' ? ' · error' : s.level === 'warn' ? ' · warning' : ''))));
    });
    wf.replaceChildren(axis, ...rows);
    // the lines behind the chosen step
    const step = rq.steps[R.step];
    const svc = incident.res.services[step.s];
    const tab = incident.tabs[step.s];
    const out = [];
    for (const ref of step.refs) {
      const e = svc.entries[ref.e];
      for (let l = e.start; l <= Math.min(e.end, e.start + 12); l++) out.push({ l, text: svc.lines[l], lvl: (e.level || '').toLowerCase() });
    }
    lines.replaceChildren(
      h('div', { class: 'inc-rq-lhead' }, h('strong', null, 'Lines behind “' + maskText(step.label) + '”'), h('span', null, svc.file + ' · ' + step.refs.length + ' entr' + (step.refs.length === 1 ? 'y' : 'ies'))),
      h('div', { class: 'inc-rq-code' }, ...out.map((x) => h('button', { class: 'inc-code-line lv-' + (x.lvl || 'none'), title: 'Open ' + svc.file + ' at line ' + (x.l + 1), onclick: () => openIncidentLine(tab, x.l + 1) },
        h('span', { class: 'inc-code-n' }, String(x.l + 1)), h('span', { class: 'inc-code-t' }, x.text)))));
  }

  // ---------- pins and the report (0.18.0) ----------
  // Pinning copies what the report needs (title, detail, a few evidence lines, the request's steps) at that
  // moment, so the report stays as it was when you pinned it. Notes are typed in the Report tab.
  const findingKey = (f) => 'f|' + f.kind + '|' + f.title + '|' + f.from;
  const isPinned = (key) => !!(incident && incident.pins.some((p) => p.key === key));
  const PIN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l-1 6 4 3v2H6v-2l4-3zM12 14v7"/></svg>';
  function pinButton(key, onToggle) {
    const on = isPinned(key);
    const b = h('button', { class: 'inc-pin' + (on ? ' on' : ''), 'data-key': key, 'aria-pressed': String(on), title: on ? 'Pinned to the report. Click to unpin.' : 'Pin to the report', 'aria-label': on ? 'Unpin from the report' : 'Pin to the report', onclick: (e) => { e.stopPropagation(); onToggle(); } });
    b.innerHTML = PIN_SVG;
    return b;
  }
  function pinRequestButton(rq) {
    const on = isPinned('r|' + rq.id);
    return h('button', { class: 'inc-pin-req' + (on ? ' on' : ''), 'data-key': 'r|' + rq.id, 'aria-pressed': String(on), onclick: () => pinRequest(rq) }, on ? 'Pinned to the report ✓' : 'Pin to report');
  }
  function evidenceLines(refs, max = 4) {
    const svcs = incident.res.services;
    return refs.map((r) => ({ r, e: svcs[r.s].entries[r.e] })).filter((x) => x.e).sort((a, b) => (a.e.ts ?? 0) - (b.e.ts ?? 0)).slice(0, max)
      // short enough to read in Teams: time, level, service and the message (the file and line are listed below it)
      .map(({ r, e }) => {
        const msg = (e.message || svcs[r.s].lines[e.start] || '').replace(/\s+/g, ' ').trim().replace(/^trace[_-]?id[=:]\s*[\w-]+[\s,;]*/i, '');
        const ts = e.ts != null ? Logs.formatTs(e.ts) + '.' + String(Math.round(e.ts % 1000)).padStart(3, '0') + ' ' : '';
        const text = ts + (e.level ? e.level + ' ' : '') + svcs[r.s].name + ': ' + msg;
        return { file: svcs[r.s].file, line: e.start + 1, text: text.length > 220 ? text.slice(0, 219) + '…' : text };
      });
  }
  function togglePin(item) {
    const i = incident.pins.findIndex((p) => p.key === item.key);
    if (i >= 0) incident.pins.splice(i, 1);
    else incident.pins.push(item);
    refreshPins();
    toast(i >= 0 ? 'Unpinned.' : 'Pinned to the report (' + incident.pins.length + ').', 1800);
  }
  function pinFinding(i) {
    const f = incident.res.findings[i];
    if (!f) return;
    let refs = f.refs;
    if (!refs.length && f.kind === 'quiet') { // the quiet service's last entry before and first after the silence
      const si = incident.res.services.findIndex((s) => s.name === f.services[0]);
      refs = incident.res.services[si].entries.map((e, ei) => ({ s: si, e: ei, ts: e.ts })).filter((x) => x.ts === f.from || x.ts === f.to);
    }
    togglePin({ key: findingKey(f), type: 'finding', kind: f.kind, title: f.title, detail: f.detail,
      when: f.from == null ? '' : Logs.formatTs(f.from) + (f.to && f.to - f.from >= 1000 ? ' to ' + Logs.formatTs(f.to) : ''), evidence: evidenceLines(refs), note: '' });
  }
  function pinRequest(rq) {
    togglePin({ key: 'r|' + rq.id, type: 'request', id: rq.id, state: rqState(rq), status: rq.status, summary: rq.summary,
      steps: rq.steps.map((s) => ({ service: s.service, label: s.label, took: fmtMs(s.to - s.from), result: s.level === 'ok' ? 'ok' : s.level === 'warn' ? 'warning' : 'error' })), note: '' });
  }
  // Update every pin control and the Report count without rebuilding the view (lists keep their scroll).
  function refreshPins() {
    const host = $('#incident');
    if (!host) return;
    const n = incident.pins.length;
    const c = host.querySelector('.inc-pin-count');
    if (c) { c.textContent = String(n); c.classList.toggle('pinned', n > 0); }
    host.querySelectorAll('.inc-pin').forEach((b) => {
      const on = isPinned(b.dataset.key);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      b.title = on ? 'Pinned to the report. Click to unpin.' : 'Pin to the report';
      b.setAttribute('aria-label', on ? 'Unpin from the report' : 'Pin to the report');
    });
    host.querySelectorAll('.inc-pin-req').forEach((b) => {
      const on = isPinned(b.dataset.key);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      b.textContent = on ? 'Pinned to the report ✓' : 'Pin to report';
    });
  }
  function reportMarkdown() {
    const res = incident.res;
    const md = Logs.incidentReport({ title: incident.report.title, summary: incident.report.summary, from: res.min, to: res.max, services: res.services.map((s) => s.name), pins: incident.pins });
    return Logs.maskSecrets(md, settings.mask).text;
  }
  function buildReportBody() {
    const st = incident;
    const rp = st.report;
    const later = debounce(renderReportPreview, 200);
    const title = h('input', { type: 'text', value: rp.title, 'aria-label': 'Report title', oninput: (e) => { rp.title = e.target.value; later(); } });
    const summary = h('textarea', { rows: 4, placeholder: 'In a few lines: what broke, who was affected, what fixed it.', 'aria-label': 'What happened', oninput: (e) => { rp.summary = e.target.value; later(); } });
    summary.value = rp.summary;
    const list = h('div', { class: 'inc-pin-list' });
    const drawList = () => {
      list.replaceChildren();
      if (!st.pins.length) {
        list.append(h('p', { class: 'hint' }, 'Nothing pinned yet. Use the pin on a finding (Timeline) or "Pin to report" on a request (Requests) to collect what matters here.'));
        return;
      }
      st.pins.forEach((p, i) => {
        const note = h('textarea', { rows: 2, placeholder: 'Your note (optional)', 'aria-label': 'Note for ' + p.title, oninput: (e) => { p.note = e.target.value; later(); } });
        note.value = p.note || '';
        const move = (d) => { const j = i + d; if (j < 0 || j >= st.pins.length) return; [st.pins[i], st.pins[j]] = [st.pins[j], st.pins[i]]; drawList(); renderReportPreview(); };
        list.append(h('div', { class: 'inc-pin-item' },
          h('div', { class: 'inc-pin-top' },
            h('span', { class: 'inc-tag' + (p.type === 'request' ? ' req' : '') }, p.type === 'request' ? 'request' : p.kind),
            h('span', { class: 'inc-pin-title' }, maskText(p.type === 'request' ? p.id.slice(0, 8) + ' · ' + p.state + (p.status ? ' · ' + p.status : '') : p.title)),
            h('button', { class: 'icon-btn small', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(-1) }, '↑'),
            h('button', { class: 'icon-btn small', title: 'Move down', 'aria-label': 'Move down', disabled: i === st.pins.length - 1, onclick: () => move(1) }, '↓'),
            h('button', { class: 'icon-btn small', title: 'Remove from the report', 'aria-label': 'Remove from the report', onclick: () => { st.pins.splice(i, 1); drawList(); refreshPins(); renderReportPreview(); } }, '×')),
          note));
      });
    };
    drawList();
    const side = h('aside', { class: 'inc-findings inc-rep-side', 'aria-label': 'Report contents' },
      h('div', { class: 'inc-rep-form' },
        h('div', { class: 'field' }, h('label', null, 'Title'), title),
        h('div', { class: 'field' }, h('label', null, 'What happened'), summary),
        h('div', { class: 'inc-col-head inc-rep-pins-head' }, h('strong', null, 'Pinned'), h('span', null, 'Notes are optional; ↑ ↓ sets the order')),
        list));
    const copyRich = h('button', { class: 'primary', onclick: async () => {
      const md = reportMarkdown();
      const ok = await api.clipboardWrite({ text: md, html: richHtml($('#inc-rep-doc')) });
      toast(ok === false ? 'Copying was blocked by the browser.' : 'Copied with formatting. Paste into Teams, Outlook or Word.', 4500);
    } }, 'Copy for Teams / Outlook');
    const copyMd = h('button', { onclick: async () => { const ok = await api.clipboardWrite({ text: reportMarkdown() }); toast(ok === false ? 'Copying was blocked by the browser.' : 'Copied as Markdown (for Jira, GitHub, a wiki).', 3500); } }, 'Copy Markdown');
    const asTab = h('button', { onclick: () => {
      const t = newTab({ name: 'incident-report.md', content: reportMarkdown(), lang: 'markdown' });
      activate(t);
      setPreview(true);
      toast('The report is open as a Markdown tab, with its preview. The incident is still there.', 8000, { label: 'Back to the incident', run: reopenIncident });
    }, title: 'Open the report as a Markdown tab to edit it further' }, 'Open as a tab');
    const main = h('div', { class: 'inc-rep-main' },
      h('div', { class: 'inc-rep-tools' }, copyRich, copyMd, asTab, h('span', { class: 'hint' }, 'Secrets are masked in everything you copy.')),
      h('div', { class: 'inc-rq-card inc-rep-paper' }, h('div', { id: 'inc-rep-doc', class: 'md' })));
    return h('div', { class: 'inc-body inc-rep-body' }, side, main);
  }
  function renderReportPreview() {
    const doc = $('#inc-rep-doc');
    if (!doc || !incident) return;
    doc.replaceChildren(Markdown.render(reportMarkdown(), document));
  }

  async function copyIncidentFindings() {
    const res = incident.res;
    const out = ['Incident: ' + res.services.map((s) => s.name).join(', '), Logs.formatTs(res.min, true) + ' to ' + Logs.formatTs(res.max) + ' (' + Logs.formatDuration(res.max - res.min) + ')', ''];
    for (const f of res.findings) out.push('- [' + f.kind + '] ' + f.title + (f.from != null ? ' (' + Logs.formatTs(f.from) + (f.to && f.to - f.from >= 1000 ? ' to ' + Logs.formatTs(f.to) : '') + ')' : '') + '\n  ' + f.detail);
    const m = Logs.maskSecrets(out.join('\n'), settings.mask);
    const ok = await api.clipboardWrite({ text: m.text });
    toast(ok === false ? 'Copying was blocked by the browser.' : 'Copied ' + res.findings.length + ' findings' + (m.count ? ', ' + m.count + ' secret value' + (m.count === 1 ? '' : 's') + ' masked' : '') + '.', 4000);
  }

  // Convert the selection (or whole tab) to a table, using every layout we know.
  function convertToTable() {
    const sel = editor.getSelection();
    const range = sel && !sel.isEmpty() ? sel : active.model.getFullModelRange();
    const text = active.model.getValueInRange(range);
    let rows = Tables.parseTsv(text) || Tables.parseAligned(text);
    if (!rows) { const inf = Tables.inferSpaceTable(text); rows = inf && inf.rows; }
    if (!rows) rows = Tables.parseTableText(text);
    if (!rows) { toast('Could not find columns in ' + (sel && !sel.isEmpty() ? 'the selection' : 'this tab') + '. Each line should be one row.', 5000); return; }
    editor.pushUndoStop();
    editor.executeEdits('table-convert', [{ range, text: Tables.formatRows(rows, tableFormat()) }]);
    editor.pushUndoStop();
    toast('Converted to a table (' + rows.length + ' rows, ' + rows[0].length + ' columns). Ctrl+Z undoes it.', 5000);
  }

  function selectAll() {
    if (!editor || !active) return;
    editor.focus();
    editor.setSelection(active.model.getFullModelRange());
  }

  // ======================================================================
  // LOG ANALYSIS
  // ======================================================================
  function emptyFilter() {
    return { levels: new Set(Logs.LEVEL_CHIPS), include: '', includeMode: 'any', exclude: '', logger: '', trace: '', from: '', to: '', took: '' };
  }
  // Multi-line filter boxes: each non-empty line is one pattern.
  const filterLines = (v) => String(v || '').split('\n').map((x) => x.trim()).filter(Boolean);
  function linesRegex(v, mode) {
    const list = filterLines(v);
    if (!list.length) return { re: null };
    const bad = [];
    const res = list.map((src, i) => { try { return new RegExp(src, 'i'); } catch (e) { bad.push('line ' + (i + 1) + ': ' + e.message); return null; } }).filter(Boolean);
    if (!res.length) return { re: null, error: bad.join('; ') };
    const re = mode === 'all' ? res : new RegExp(res.map((r) => '(?:' + r.source + ')').join('|'), 'i');
    return { re, error: bad.length ? bad.join('; ') : null };
  }

  function filterActive(f) {
    return !!f.lines || f.levels.size !== Logs.LEVEL_CHIPS.length || filterLines(f.include).length || filterLines(f.exclude).length || f.logger || filterLines(f.trace).length || f.from || f.to || !!f.took;
  }
  function safeRegex(src) {
    if (!src) return { re: null };
    try { return { re: new RegExp(src, 'i') }; } catch (e) { return { re: null, error: e.message }; }
  }

  function analyze(tab) {
    if (!isLogTab(tab)) { tab.an = null; return null; }
    const v = tab.model.getVersionId();
    const key = settings.myPackages + '|' + settings.groupWarn;
    if (tab.an && tab.an.version === v && tab.an.key === key) return tab.an;
    const lines = tab.model.getLinesContent();
    const p = Logs.parseEntries(lines);
    const an = Object.assign({ version: v, key, lines }, p);
    an.counts = Logs.levelCounts(p.entries);
    an.groups = Logs.groupErrors(p.entries, lines, { myPackages: settings.myPackages, levels: settings.groupWarn ? ['ERROR', 'WARN'] : ['ERROR'] });
    an.timeline = Logs.timeline(p.entries, 90);
    tab.an = an;
    computeVisibility(tab);
    return an;
  }

  function computeVisibility(tab) {
    const an = tab.an;
    if (!an) return;
    const f = tab.filter;
    an.vis = null;
    an.filterError = null;
    if (!filterActive(f)) return;
    const inc = linesRegex(f.include, f.includeMode);
    const exc = linesRegex(f.exclude, 'any');
    an.filterError = inc.error || exc.error || null;
    const ref = an.entries.find((e) => e.ts != null);
    const ids = filterLines(f.trace);
    const trace = ids.length ? ids : '';
    an.vis = Logs.filterEntries(an.entries, an.lines, {
      levels: f.levels, include: inc.re, exclude: exc.re, logger: f.logger.trim(), trace,
      from: Logs.parseTimeInput(f.from, ref ? ref.ts : null), to: Logs.parseTimeInput(f.to, ref ? ref.ts : null),
    });
    if (an.vis && f.to && /^\d{1,2}:\d{2}$/.test(f.to.trim())) {
      // "to 10:16" should include the whole minute
      const toMs = Logs.parseTimeInput(f.to, ref ? ref.ts : null) + 59999;
      an.vis = Logs.filterEntries(an.entries, an.lines, {
        levels: f.levels, include: inc.re, exclude: exc.re, logger: f.logger.trim(), trace,
        from: Logs.parseTimeInput(f.from, ref ? ref.ts : null), to: toMs,
      });
    }
    if (an.vis && f.lines) {
      // only entries that produced a row in the extract results
      an.entries.forEach((e, i) => {
        if (!an.vis[i]) return;
        let hit = false;
        for (let l = e.start + 1; l <= e.end + 1 && !hit; l++) hit = f.lines.has(l);
        if (!hit) an.vis[i] = 0;
      });
    }
    if (an.vis && f.took) {
      // took>N: entries that report a duration ("took 1534ms", "took: 2.1 s") of at least N ms
      const min = Number(f.took);
      an.entries.forEach((e, i) => {
        if (!an.vis[i]) return;
        const m = TOOK_RE.exec(an.lines[e.start] || '');
        if (!m || tookMs(m) < min) an.vis[i] = 0;
      });
    }
  }
  const TOOK_RE = /\btook[\s:=]*(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?)?\b/i;
  const tookMs = (m) => Number(m[1]) * (m[2] && /^s/i.test(m[2]) ? 1000 : 1);

  const scheduleAnalysis = debounce((tab) => {
    if (!tabs.includes(tab)) return;
    if (!isLogTab(tab)) { if (tab.an) { tab.an = null; refreshDecorations(tab); if (tab === active) onActiveAnalysisChanged(); } else refreshDecorations(tab); return; }
    analyze(tab);
    refreshDecorations(tab);
    if (tab === active) {
      applyHiddenAreas(tab);
      onActiveAnalysisChanged();
      if (currentView === 'insights') updateInsights();
    }
  }, 350);

  function onActiveAnalysisChanged() {
    const an = active && isLogTab(active) ? analyze(active) : null;
    // Highlighting every repeated word (timestamps, "INFO") is noise in logs; keep it for code.
    editor.updateOptions({ occurrencesHighlight: an ? 'off' : 'singleFile', selectionHighlight: !an });
    renderSignal();
    renderFilterBar();
    updateStatus();
    updateCopilotBadge();
    if (currentView === 'extract') renderPatternList($('.view[data-view="extract"] .pf-group'));
    const badge = $('.rail-btn[data-view="insights"] .badge');
    if (badge) badge.remove();
    if (an && an.counts.ERROR) {
      $('.rail-btn[data-view="insights"]').append(h('span', { class: 'badge' }, an.counts.ERROR > 99 ? '99+' : an.counts.ERROR));
    }
  }

  // ---------- hidden areas (filtering) ----------
  function applyHiddenAreas(tab) {
    if (!editor || typeof editor.setHiddenAreas !== 'function') return;
    const eds = (tab === active ? [editor] : []).concat(split ? split.panes.filter((p) => p.tab === tab).map((p) => p.editor) : []);
    if (!eds.length) return;
    const an = tab.an;
    const ranges = [];
    if (an && an.vis && an.vis.some((x) => x)) {
      let start = -1;
      let end = -1;
      an.entries.forEach((e, i) => {
        if (!an.vis[i]) {
          if (start < 0) start = e.start;
          end = e.end;
        } else if (start >= 0) {
          ranges.push({ startLineNumber: start + 1, startColumn: 1, endLineNumber: end + 1, endColumn: 1 });
          start = -1;
        }
      });
      if (start >= 0) ranges.push({ startLineNumber: start + 1, startColumn: 1, endLineNumber: end + 1, endColumn: 1 });
      // blank lines after the last entry are not part of any entry: hide them too while filtering
      const lastEnd = an.entries.length ? an.entries[an.entries.length - 1].end : -1;
      if (lastEnd >= 0 && lastEnd < an.lines.length - 1) ranges.push({ startLineNumber: lastEnd + 2, startColumn: 1, endLineNumber: an.lines.length, endColumn: 1 });
    }
    for (const ed of eds) ed.setHiddenAreas(ranges);
  }

  function setFilter(patch) {
    if (!active) return;
    if (!isLogTab(active)) treatAsLog(active);
    Object.assign(active.filter, patch);
    analyze(active);
    computeVisibility(active);
    applyHiddenAreas(active);
    if (splitOpen()) for (const t of new Set(split.panes.map((p) => p.tab))) shareFilter(active, t);
    renderFilterBar();
    renderSignal();
    if (currentView === 'insights') updateInsights();
    const an = active.an;
    if (an && an.vis) {
      const first = an.vis.indexOf(1);
      if (first >= 0) {
        const ln = an.entries[first].start + 1;
        const cur = editor.getPosition();
        const curIdx = cur ? Logs.entryIndexAt(an.entries, cur.lineNumber - 1) : -1;
        if (curIdx < 0 || !an.vis[curIdx]) { editor.setPosition({ lineNumber: ln, column: 1 }); editor.revealLineNearTop(ln); }
      }
    }
  }

  function clearFilter() {
    if (!active) return;
    active.filter = emptyFilter();
    setFilter({});
    if (currentView === 'insights') renderInsights();
  }

  // ---------- query bar (0.14.0): the active filter as chips in the title bar; type to add more ----------
  // Syntax: level:error  level:warn+  logger:Payment  thread:exec-3  trace:<id>  after:10:15  before:10:17
  // time:10:15..10:17  took>1000  -word (hide)  re:<regex>  "a phrase"  plain words.  Starting with > runs a command.
  const LEVEL_ORDER = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];
  const LEVEL_WORDS = { error: 'ERROR', err: 'ERROR', fatal: 'ERROR', warn: 'WARN', warning: 'WARN', info: 'INFO', debug: 'DEBUG', trace: 'TRACE', other: 'OTHER' };
  const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reUnescape = (s) => s.replace(/\\(.)/g, '$1');
  const shortTime = (v) => String(v).replace(/^\d{4}-\d{2}-\d{2}[ T]/, '');
  const CLOCK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

  function parseLevels(v) {
    const out = new Set();
    for (let w of v.toLowerCase().split(/[,|]/).map((x) => x.trim()).filter(Boolean)) {
      const plus = w.endsWith('+');
      if (plus) w = w.slice(0, -1);
      const lv = LEVEL_WORDS[w];
      if (!lv) return null;
      if (plus && LEVEL_ORDER.includes(lv)) LEVEL_ORDER.slice(LEVEL_ORDER.indexOf(lv)).forEach((x) => out.add(x));
      else out.add(lv);
    }
    return out.size ? out : null;
  }
  function parseDuration(v) {
    const m = /^(\d+(?:\.\d+)?)\s*(ms|s|sec)?$/i.exec(v.trim());
    return m ? Math.round(Number(m[1]) * (m[2] && /^s/i.test(m[2]) ? 1000 : 1)) : null;
  }

  // The active filter as removable chips. Each chip knows the patch that removes it.
  function filterChips(f) {
    const chips = [];
    const without = (key, p) => ({ [key]: filterLines(f[key]).filter((x) => x !== p).join('\n') });
    if (f.from || f.to) {
      chips.push({ key: 'time', val: (f.from ? shortTime(f.from) : 'start') + ' to ' + (f.to ? shortTime(f.to) : 'end'), time: true,
        title: 'Drag on the timeline to change the range. Double-click the timeline, or ×, to clear it.', clear: { from: '', to: '' } });
    }
    if (f.levels.size !== Logs.LEVEL_CHIPS.length) chips.push({ key: 'level', val: Array.from(f.levels).map((x) => x.toLowerCase()).join(', ') || 'none', clear: { levels: new Set(Logs.LEVEL_CHIPS) } });
    if (f.logger) chips.push({ key: 'logger', val: f.logger, clear: { logger: '' } });
    const ids = filterLines(f.trace);
    if (ids.length) chips.push({ key: 'trace', val: ids.length === 1 ? ids[0] : ids.length + ' IDs', title: ids.join('\n'), clear: { trace: '' } });
    for (const p of filterLines(f.include)) chips.push({ key: f.includeMode === 'all' && filterLines(f.include).length > 1 ? 'all' : 'text', val: reUnescape(p), title: 'Pattern: ' + p, clear: without('include', p) });
    for (const p of filterLines(f.exclude)) chips.push({ key: 'not', val: reUnescape(p), title: 'Hidden: ' + p, clear: without('exclude', p) });
    if (f.took) chips.push({ key: 'took', op: '>', val: f.took + ' ms', clear: { took: '' } });
    if (f.lines) chips.push({ key: 'lines', val: 'from the results', clear: { lines: null } });
    return chips;
  }

  function renderFilterBar() {
    const bar = $('#filterbar');
    const box = bar.querySelector('.qb-chips');
    const input = $('#qb-input');
    const cnt = bar.querySelector('.qb-count');
    const clr = bar.querySelector('.qb-clear');
    const st = $('#st-filter');
    const log = !!(active && isLogTab(active));
    const an = log ? active.an : null;
    const filtering = !!(an && filterActive(active.filter));
    input.placeholder = !log ? 'Find in this tab, or type > for a command'
      : filtering ? 'Add a filter…' : 'Filter: level:error  logger:Payment  took>1000  after:10:15  -noise';
    box.innerHTML = '';
    if (!filtering) {
      cnt.hidden = clr.hidden = st.hidden = true;
      bar.classList.remove('active');
      return;
    }
    for (const c of filterChips(active.filter)) {
      const chip = h('span', { class: 'qb-chip' + (c.time ? ' time' : ''), title: c.title || '' },
        h('span', { class: 'qb-k' }, c.key + (c.op || ':')), h('b', null, c.val),
        h('button', { class: 'qb-x', title: 'Remove', 'aria-label': 'Remove the ' + c.key + ' filter', onclick: (e) => { e.stopPropagation(); setFilter(c.clear); if (currentView === 'insights') renderInsights(); } }, '×'));
      if (c.time) chip.insertAdjacentHTML('afterbegin', CLOCK_SVG);
      box.append(chip);
    }
    const shown = an.vis ? an.vis.reduce((a, b) => a + b, 0) : an.entries.length;
    const total = an.entries.length.toLocaleString();
    cnt.textContent = shown.toLocaleString() + ' of ' + total;
    cnt.title = shown.toLocaleString() + ' of ' + total + ' entries shown';
    cnt.hidden = clr.hidden = false;
    bar.classList.add('active');
    bar.classList.toggle('has-error', !!an.filterError);
    st.innerHTML = '';
    st.append(...[
      h('span', null, h('b', null, shown.toLocaleString()), ' of ' + total + ' entries shown'),
      an.filterError ? h('span', { class: 'st-err' }, 'Invalid regex: ' + an.filterError) : null,
      shown === 0 ? h('span', { class: 'st-warn' }, 'Nothing matches, so the full log is shown') : null,
      h('button', { onclick: copyShown, title: 'Copy only the entries the filter shows' }, 'Copy shown'),
      h('button', { onclick: clearFilter, title: 'Show every entry again' }, 'Clear filter')].filter(Boolean));
    st.hidden = false;
  }

  // Typed text -> filter changes. Returns the parts it could not understand.
  function applyQuery(text) {
    const q = text.trim();
    if (!q) return [];
    if (q.startsWith('>')) { openPalette(q.slice(1).trim()); return []; }
    if (!active) return [];
    if (!isLogTab(active)) { findInEditor(q); return []; }
    const an = analyze(active);
    const ref = an && an.entries.find((e) => e.ts != null);
    const validTime = (v) => Logs.parseTimeInput(v, ref ? ref.ts : null) != null;
    const f = active.filter;
    const patch = {};
    const bad = [];
    const add = (key, val) => {
      const cur = filterLines(key in patch ? patch[key] : f[key]);
      if (!cur.includes(val)) cur.push(val);
      patch[key] = cur.join('\n');
    };
    const tokens = q.match(/-?[a-z]+(?::|>=|>)"[^"]*"|-?"[^"]*"|\S+/gi) || [];
    for (let tok of tokens) {
      const neg = tok.length > 1 && tok.startsWith('-');
      if (neg) tok = tok.slice(1);
      const m = /^([a-z]+)(:|>=|>)(.+)$/i.exec(tok);
      const unq = (s) => s.replace(/^"(.*)"$/, '$1');
      if (!m) { const v = unq(tok); add(neg ? 'exclude' : 'include', reEscape(v)); continue; }
      const key = m[1].toLowerCase();
      const val = unq(m[3]);
      if ((key === 'level' || key === 'lvl') && m[2] === ':') { const lv = parseLevels(val); if (lv) patch.levels = lv; else bad.push(tok); }
      else if (['logger', 'thread', 'class', 'service'].includes(key)) patch.logger = val;
      else if (['trace', 'traceid', 'id', 'request', 'span'].includes(key)) add('trace', val);
      else if (['after', 'from', 'since'].includes(key)) { if (validTime(val)) patch.from = val; else bad.push(tok); }
      else if (['before', 'to', 'until'].includes(key)) { if (validTime(val)) patch.to = val; else bad.push(tok); }
      else if (key === 'time') {
        const [a, b] = val.split(/\.\.|\s+to\s+/i).map((x) => x.trim());
        if (a && validTime(a)) patch.from = a; else if (a) bad.push(tok);
        if (b && validTime(b)) patch.to = b; else if (b) bad.push(tok);
      }
      else if (key === 'took' && m[2] !== ':') { const ms = parseDuration(val); if (ms != null) patch.took = String(ms); else bad.push(tok); }
      else if (key === 're' || key === 'regex') add(neg ? 'exclude' : 'include', val);
      else if (key === 'not' || key === 'exclude') add('exclude', reEscape(val));
      else if (key === 'text' || key === 'has') add(neg ? 'exclude' : 'include', reEscape(val));
      else add(neg ? 'exclude' : 'include', reEscape(tok)); // unknown key: treat the whole thing as text, e.g. "orderId=90002"
    }
    if (Object.keys(patch).length) {
      setFilter(patch);
      if (currentView === 'insights') renderInsights();
    }
    if (bad.length) toast('Not understood: ' + bad.join(' ') + '. Times look like 10:15 or 10:15:30; levels like error or warn+; took>500ms.', 6000);
    return bad;
  }

  function findInEditor(q) {
    const fc = editor.getContribution('editor.contrib.findController');
    if (!fc) return;
    fc.start({ forceRevealReplace: false, seedSearchStringFromSelection: 'none', seedSearchStringFromNonEmptySelection: false, seedSearchStringFromGlobalClipboard: false, shouldFocus: 0, shouldAnimate: true, updateSearchScope: false, loop: true });
    fc.getState().change({ searchString: q }, false);
    editor.focus();
  }

  const QB_EXAMPLES = [
    ['level:error', 'only errors'], ['level:warn+', 'warnings and errors'], ['logger:Payment', 'logger or thread contains'],
    ['trace:c3e09f1a', 'one request across the log'], ['after:10:15 before:10:17', 'a time range'], ['took>1000', 'calls that took 1 s or more'],
    ['-healthcheck', 'hide entries with a word'], ['re:timed? ?out', 'a regular expression'], ['> split', 'run a command'],
  ];
  function wireQueryBar() {
    const bar = $('#filterbar');
    const input = $('#qb-input');
    const help = bar.querySelector('.qb-help');
    const showHelp = (on) => {
      if (on && !help.childElementCount) {
        help.append(h('div', { class: 'qb-help-head' }, 'Type a filter and press Enter. Each part becomes a chip.'));
        for (const [ex, what] of QB_EXAMPLES) {
          help.append(h('button', { class: 'qb-ex', onmousedown: (e) => { e.preventDefault(); input.value = (input.value ? input.value + ' ' : '') + ex.replace(/^> /, '>'); input.focus(); } }, h('code', null, ex), h('span', null, what)));
        }
      }
      help.hidden = !on || !(active && isLogTab(active));
    };
    input.addEventListener('focus', () => { bar.classList.add('focus'); showHelp(!input.value); });
    input.addEventListener('blur', () => { bar.classList.remove('focus'); showHelp(false); });
    input.addEventListener('input', () => showHelp(!input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const bad = applyQuery(input.value);
        input.value = bad.join(' '); // keep only what was not understood, so it can be corrected
        showHelp(false);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (input.value) input.value = ''; else { input.blur(); editor.focus(); }
      } else if (e.key === 'Backspace' && !input.value && active && isLogTab(active)) {
        const chips = filterChips(active.filter);
        if (chips.length) { e.preventDefault(); setFilter(chips[chips.length - 1].clear); if (currentView === 'insights') renderInsights(); }
      }
    });
    bar.addEventListener('mousedown', (e) => { if (!e.target.closest('button') && e.target !== input) { e.preventDefault(); input.focus(); } });
    bar.querySelector('.qb-clear').onclick = () => { clearFilter(); input.focus(); };
  }
  function focusQueryBar() { const i = $('#qb-input'); i.focus(); i.select(); }

  // ---------- decorations ----------
  function refreshDecorations(tab) {
    if (!tab || !tabs.includes(tab)) return;
    const decos = [];
    const pal = palette();
    const R = monaco.editor.OverviewRulerLane.Right;
    const an = isLogTab(tab) ? analyze(tab) : null;
    if (an) {
      const pkgRe = Logs.packagesRegex(settings.myPackages);
      for (const e of an.entries) {
        if (e.level === 'ERROR' || e.level === 'WARN') {
          const isErr = e.level === 'ERROR';
          decos.push({
            range: new monaco.Range(e.start + 1, 1, e.start + 1, 1),
            options: {
              isWholeLine: true, linesDecorationsClassName: isErr ? 'gut-error' : 'gut-warn',
              overviewRuler: { color: isErr ? pal.err : pal.warn, position: R },
              minimap: { color: isErr ? pal.err : pal.warn, position: monaco.editor.MinimapPosition.Inline },
            },
          });
          decos.push({ range: new monaco.Range(e.start + 1, 1, e.end + 1, 1), options: { isWholeLine: true, className: isErr ? 'ln-error' : 'ln-warn' } });
        }
        if (e.hasStack && pkgRe && decos.length < 40000) {
          for (let i = e.start + 1; i <= e.end; i++) {
            const m = Logs.FRAME_RE.exec(an.lines[i]);
            if (!m) continue;
            const own = pkgRe.test(m[1]);
            decos.push({ range: new monaco.Range(i + 1, 1, i + 1, an.lines[i].length + 1), options: { inlineClassName: own ? 'own-frame' : 'lib-frame' } });
          }
        }
        if (decos.length > 60000) break;
      }
    }
    settings.rules.forEach((r, i) => {
      if (!r.on || !r.pattern) return;
      let matches;
      try { new RegExp(r.pattern); matches = tab.model.findMatches(r.pattern, false, true, !r.ci, null, false, 5000); } catch { return; }
      for (const m of matches) decos.push({ range: m.range, options: { inlineClassName: 'hl-r' + i, hoverMessage: { value: r.label || r.pattern } } });
    });
    tab.decoIds = tab.model.deltaDecorations(tab.decoIds, decos);
    tab.decoVersion = tab.model.getVersionId();
  }

  // ---------- signal strip ----------
  // "4 errors" / "3 warnings": one click shows only that level, a second click shows everything again.
  function levelPill(level, n, word, cls) {
    const f = active.filter;
    const on = f.levels.size === 1 && f.levels.has(level);
    const stop = (e) => e.stopPropagation();
    return h('button', {
      class: 'sig-pill ' + cls + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false',
      title: on ? 'Show all levels again' : 'Show only ' + word + 's',
      onpointerdown: stop, ondblclick: stop,
      onclick: (e) => { stop(e); setFilter({ levels: on ? new Set(Logs.LEVEL_CHIPS) : new Set([level]) }); if (currentView === 'insights') renderInsights(); },
    }, n + ' ' + word + (n === 1 ? '' : 's'));
  }
  function renderSignal() {
    const box = $('#signal');
    const an = active && isLogTab(active) ? active.an : null;
    if (!settings.signal || !an) { box.hidden = true; return; }
    box.hidden = false;
    const meta = box.querySelector('.signal-meta');
    const tl = an.timeline;
    meta.innerHTML = '';
    meta.append(
      h('span', null, an.formatLabel || 'Log'),
      h('span', null, an.entries.length.toLocaleString() + ' entries'),
      levelPill('ERROR', an.counts.ERROR, 'error', 'e'),
      levelPill('WARN', an.counts.WARN, 'warning', 'w'),
      h('span', { class: 'grow' }),
      tl ? h('span', null, Logs.formatTs(tl.min, true) + '  to  ' + Logs.formatTs(tl.max) + '   (' + Logs.formatDuration(tl.max - tl.min) + ', bars of ' + Logs.formatDuration(tl.size) + ')') : h('span', null, 'No timestamps found'));
    const svg = $('#signal-svg');
    svg.innerHTML = '';
    renderSignalRange(tl);
    if (!tl) return;
    const n = tl.buckets.length;
    const max = Math.max(1, ...tl.buckets.map((b) => b.total));
    svg.setAttribute('viewBox', `0 0 ${n} 100`);
    const pal = palette();
    const acc = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const y = (v) => 100 - (v / max) * 92;
    let d = `M0 100`;
    tl.buckets.forEach((b, i) => { d += ` L${i} ${y(b.total)} L${i + 1} ${y(b.total)}`; });
    d += ` L${n} 100 Z`;
    const ns = 'http://www.w3.org/2000/svg';
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', acc + '30');
    path.setAttribute('stroke', acc);
    path.setAttribute('stroke-width', '1.2');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(path);
    tl.buckets.forEach((b, i) => {
      const bar = (count, color, offset) => {
        if (!count) return;
        const r = document.createElementNS(ns, 'rect');
        const hgt = Math.max(8, (count / max) * 92);
        r.setAttribute('x', i + 0.18);
        r.setAttribute('width', 0.64);
        r.setAttribute('y', 100 - hgt - offset);
        r.setAttribute('height', hgt);
        r.setAttribute('fill', color);
        svg.appendChild(r);
        return hgt;
      };
      const eh = bar(b.error, pal.err, 0) || 0;
      bar(b.warn, pal.warn, eh);
    });
    if (an.vis && active.filter) {
      // dim time ranges that the filter hides entirely
      const visTl = Logs.timeline(an.entries, 90, an.vis);
      if (visTl) {
        tl.buckets.forEach((b, i) => {
          const inVis = visTl.buckets.some((vb) => vb.total && vb.start < b.start + tl.size && vb.start + visTl.size > b.start);
          if (inVis) return;
          const r = document.createElementNS(ns, 'rect');
          r.setAttribute('x', i); r.setAttribute('width', 1); r.setAttribute('y', 0); r.setAttribute('height', 100);
          r.setAttribute('fill', getComputedStyle(document.documentElement).getPropertyValue('--editor').trim() + 'b0');
          svg.appendChild(r);
        });
      }
    }
  }

  // The time range from the filter, shaded on the strip (everything outside it is dimmed).
  function renderSignalRange(tl) {
    const box = $('#signal');
    let shade = box.querySelector('.range');
    if (!shade) { shade = h('div', { class: 'range', hidden: true }, h('i', { class: 'l' }), h('i', { class: 'r' })); box.append(shade); }
    const f = active && active.filter;
    if (!tl || !f || (!f.from && !f.to)) { shade.hidden = true; return; }
    const an = active.an;
    const ref = an.entries.find((e) => e.ts != null);
    const start = tl.buckets[0].start, span = tl.buckets.length * tl.size;
    let a = f.from ? Logs.parseTimeInput(f.from, ref ? ref.ts : null) : start;
    let b = f.to ? Logs.parseTimeInput(f.to, ref ? ref.ts : null) : start + span;
    if (f.to && /^\d{1,2}:\d{2}$/.test(f.to.trim())) b += 59999;
    if (a == null || b == null) { shade.hidden = true; return; }
    const pa = Math.max(0, Math.min(1, (a - start) / span)), pb = Math.max(0, Math.min(1, (b - start) / span));
    shade.hidden = false;
    shade.querySelector('.l').style.width = (pa * 100) + '%';
    shade.querySelector('.r').style.width = ((1 - pb) * 100) + '%';
  }

  function signalBucketAt(clientX) {
    const an = active && active.an;
    if (!an || !an.timeline) return null;
    const rect = $('#signal').getBoundingClientRect();
    const n = an.timeline.buckets.length;
    const i = Math.min(n - 1, Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * n)));
    return { i, b: an.timeline.buckets[i], x: clientX - rect.left, tl: an.timeline };
  }

  function wireSignal() {
    const box = $('#signal');
    const cursor = h('div', { class: 'cursor', hidden: true });
    const tip = h('div', { class: 'tip', hidden: true });
    box.append(cursor, tip);
    box.addEventListener('mousemove', (e) => {
      const r = signalBucketAt(e.clientX);
      if (!r) return;
      cursor.hidden = tip.hidden = false;
      cursor.style.left = r.x + 'px';
      const flip = r.x > box.clientWidth - 260;
      tip.style.left = r.x + 'px';
      tip.style.transform = flip ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)';
      tip.textContent = Logs.formatTs(r.b.start) + '  ' + r.b.total + ' entries' + (r.b.error ? ', ' + r.b.error + ' errors' : '') + (r.b.warn ? ', ' + r.b.warn + ' warnings' : '');
    });
    box.addEventListener('mouseleave', () => { cursor.hidden = tip.hidden = true; });
    // Drag across the strip to show only that time range; double-click clears it.
    const band = h('div', { class: 'drag', hidden: true });
    box.append(band);
    let drag = null;
    box.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !signalBucketAt(e.clientX)) return;
      drag = { x0: e.clientX, moved: false, id: e.pointerId };
    });
    box.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!drag.moved && Math.abs(e.clientX - drag.x0) < 5) return;
      if (!drag.moved) { drag.moved = true; box.setPointerCapture(drag.id); box.classList.add('dragging'); }
      const rect = box.getBoundingClientRect();
      const a = Math.max(rect.left, Math.min(drag.x0, e.clientX)), b = Math.min(rect.right, Math.max(drag.x0, e.clientX));
      band.hidden = false;
      band.style.left = (a - rect.left) + 'px';
      band.style.width = (b - a) + 'px';
      const ra = signalBucketAt(a), rb = signalBucketAt(b - 1);
      if (ra && rb) {
        tip.hidden = false;
        tip.textContent = Logs.formatTs(ra.b.start) + '  to  ' + Logs.formatTs(rb.b.start + rb.tl.size);
      }
    });
    const endDrag = (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      box.classList.remove('dragging');
      band.hidden = true;
      if (!d.moved) return;
      d.consumed = true;
      suppressClick = true;
      const rect = box.getBoundingClientRect();
      const a = Math.max(rect.left, Math.min(d.x0, e.clientX)), b = Math.min(rect.right, Math.max(d.x0, e.clientX));
      const ra = signalBucketAt(a), rb = signalBucketAt(b - 1);
      if (!ra || !rb) return;
      const from = ra.b.start;
      const to = Math.ceil((rb.b.start + rb.tl.size) / 1000) * 1000 - 1;
      setFilter({ from: Logs.formatTs(Math.floor(from / 1000) * 1000, true), to: Logs.formatTs(to, true) });
      toast('Showing ' + Logs.formatTs(from) + ' to ' + Logs.formatTs(to + 1) + '. Double-click the strip to show all times again.', 3500);
    };
    let suppressClick = false;
    box.addEventListener('pointerup', endDrag);
    box.addEventListener('pointercancel', () => { drag = null; band.hidden = true; box.classList.remove('dragging'); });
    box.addEventListener('dblclick', () => {
      if (!active || !active.filter || (!active.filter.from && !active.filter.to)) return;
      setFilter({ from: '', to: '' });
      toast('Showing all times.', 1800);
    });
    box.addEventListener('click', (e) => {
      if (suppressClick) { suppressClick = false; return; }
      const r = signalBucketAt(e.clientX);
      if (!r || r.b.first < 0) return;
      const an = active.an;
      let idx = r.b.first;
      // prefer the first error in that bucket, then first visible entry
      for (let i = r.b.first; i < an.entries.length && an.entries[i].ts != null && an.entries[i].ts < r.b.start + r.tl.size; i++) {
        if (an.entries[i].level === 'ERROR' && (!an.vis || an.vis[i])) { idx = i; break; }
      }
      revealEntry(idx);
    });
  }

  function revealEntry(idx) {
    const an = active && active.an;
    if (!an || !an.entries[idx]) return;
    if (an.vis && !an.vis[idx]) { toast('That entry is hidden by the filter. Clear the filter to see it.'); }
    const ln = an.entries[idx].start + 1;
    editor.setSelection(new monaco.Range(ln, 1, ln, an.lines[ln - 1].length + 1));
    editor.revealLineInCenter(ln);
    editor.focus();
  }

  function treatAsLog(tab) {
    if (!tab) return;
    tab.detectDone = true;
    monaco.editor.setModelLanguage(tab.model, 'log');
    tab.an = null;
    analyze(tab);
    refreshDecorations(tab);
    if (tab === active) { onActiveAnalysisChanged(); renderTabs(); }
  }

  // ======================================================================
  // SIDEBAR
  // ======================================================================
  const VIEW_TITLES = { files: 'Open files', insights: 'Log insights', extract: 'Extract data', highlight: 'Highlight rules', copilot: 'Copilot', appearance: 'Appearance and settings' };

  function showView(name, { toggle = true } = {}) {
    if (name === 'copilot') { openCopilot({ toggle }); return; }
    const side = $('#side');
    if (toggle && currentView === name && !side.hidden) { hideSide(); return; }
    currentView = name;
    settings.view = name;
    saveSettings();
    side.hidden = false;
    document.body.classList.add('side-open');
    $('#side-title').textContent = VIEW_TITLES[name];
    $$('#rail .rail-btn[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
    $$('#side .view').forEach((v) => v.classList.toggle('on', v.dataset.view === name));
    if (name === 'copilot') side.style.setProperty('--side-w', Math.max(settings.sideWidth, 420) + 'px');
    else side.style.setProperty('--side-w', settings.sideWidth + 'px');
    ({ files: renderFiles, insights: renderInsights, extract: renderExtract, highlight: renderHighlight, copilot: renderCopilot, appearance: renderAppearance })[name]();
    setTimeout(() => editor && editor.layout(), 0);
  }
  function hideSide() {
    $('#side').hidden = true;
    document.body.classList.remove('side-open');
    $$('#rail .rail-btn').forEach((b) => b.classList.remove('on'));
    currentView = null;
    setTimeout(() => editor && editor.layout(), 0);
  }
  const view = (name) => (name === 'copilot' ? $('#cp-body') : $(`#side .view[data-view="${name}"]`));

  // ---------- open files (all tabs as a list) ----------
  const filesState = { q: '', sort: 'open' };
  function fileDir(t) {
    if (!t.path || /^(web|download):/.test(t.path)) return t.path ? '' : 'not saved';
    const parts = t.path.replace(/\\/g, '/').split('/');
    parts.pop();
    const dir = parts.join('/') || '/';
    return dir.length > 48 ? '…' + dir.slice(-47) : dir;
  }
  function updateFilesBadge() {
    const b = $('#rail .files-count');
    if (!b) return;
    const n = tabs.length;
    b.hidden = n < 2;
    b.textContent = n > 99 ? '99+' : String(n);
  }
  function renderFiles() {
    const v = view('files');
    if (!v) return;
    const prevScroll = v.querySelector('.fl-list') ? v.querySelector('.fl-list').scrollTop : 0;
    const hadFocus = document.activeElement && document.activeElement.closest && document.activeElement.closest('.view[data-view="files"]');
    const focusId = hadFocus && document.activeElement.dataset ? document.activeElement.dataset.tab : null;
    const searchFocused = hadFocus && document.activeElement.classList.contains('fl-search');
    const caret = searchFocused ? document.activeElement.selectionStart : null;
    if (v.querySelector('.fl-rename')) return; // a name is being typed
    v.innerHTML = '';
    const dirty = tabs.filter(isDirty).length;
    const search = h('input', { class: 'fl-search', type: 'search', value: filesState.q, placeholder: 'Filter ' + tabs.length + ' open file' + (tabs.length === 1 ? '' : 's'), 'aria-label': 'Filter open files', spellcheck: false,
      oninput: (e) => { filesState.q = e.target.value; renderFiles(); },
      onkeydown: (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); const first = v.querySelector('.fl-item'); if (first) first.focus(); } else if (e.key === 'Enter') { const first = v.querySelector('.fl-item'); if (first) first.click(); } } });
    const sortSel = h('select', { class: 'fl-sort', 'aria-label': 'Sort', onchange: (e) => { filesState.sort = e.target.value; renderFiles(); } },
      [['open', 'Tab order'], ['name', 'Name'], ['recent', 'Recently used'], ['type', 'Type']].map(([val, l]) => h('option', { value: val, selected: filesState.sort === val }, l)));
    v.append(h('div', { class: 'fl-tools' }, search, sortSel),
      h('div', { class: 'fl-summary' }, tabs.length + ' open' + (dirty ? ', ' + dirty + ' unsaved' : '') + (splitOpen() ? ', ' + (split.panes.filter((p) => p.tab).length + 1) + ' on screen' : '')));
    if (tabs.filter((t) => isLogTab(t) && t.model.getValueLength() > 0).length >= 2) {
      v.append(h('button', { class: 'fl-incident', onclick: pickIncident, title: 'Line the open logs up on one clock and look for what went wrong (Alt+I)' }, 'Investigate these logs together'));
    }
    const q = filesState.q.trim().toLowerCase();
    let list = tabs.slice();
    if (q) list = list.filter((t) => t.name.toLowerCase().includes(q) || (t.path || '').toLowerCase().includes(q));
    const ext = (t) => (t.name.includes('.') ? t.name.split('.').pop().toLowerCase() : '');
    if (filesState.sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    else if (filesState.sort === 'recent') list.sort((a, b) => (b.used || 0) - (a.used || 0));
    else if (filesState.sort === 'type') list.sort((a, b) => ext(a).localeCompare(ext(b)) || a.name.localeCompare(b.name));
    const ul = h('div', { class: 'fl-list', role: 'listbox', 'aria-label': 'Open files' });
    const canReorder = filesState.sort === 'open' && !q;
    for (const t of list) {
      const where = t === active ? 'main' : inSplit(t) ? 'split' : '';
      const item = h('div', {
        class: 'fl-item' + (t === active ? ' active' : '') + (isDirty(t) ? ' dirty' : ''),
        role: 'option', tabindex: '0', 'aria-selected': String(t === active), 'data-tab': String(t.id), draggable: 'true',
        title: (t.path && !/^(web|download):/.test(t.path) ? t.path : t.name) + '\nClick to open, double-click to rename, drag onto the editor to show it side by side',
        onclick: () => { activate(t); renderFiles(); },
        ondblclick: (e) => { if (!e.target.closest('.fl-x')) startListRename(t); },
        oncontextmenu: (e) => { e.preventDefault(); tabMenu(t, e.clientX, e.clientY); },
        onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t); } },
        onkeydown: (e) => {
          const items = $$('.view[data-view="files"] .fl-item');
          const i = items.indexOf(e.currentTarget);
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = items[i + (e.key === 'ArrowDown' ? 1 : -1)]; if (n) n.focus(); else if (e.key === 'ArrowUp') search.focus(); }
          else if (e.key === 'Enter') { e.preventDefault(); activate(t); renderFiles(); }
          else if (e.key === 'F2') { e.preventDefault(); startListRename(t); }
          else if (e.key === 'Delete') { e.preventDefault(); closeTab(t); }
        },
        ondragstart: (e) => {
          e.dataTransfer.setData('application/x-textforge-tab', String(t.id));
          e.dataTransfer.setData('text/plain', t.name);
          e.dataTransfer.effectAllowed = 'move';
          document.body.classList.add('tab-dragging');
          dragTab = t;
        },
        ondragend: () => { endTabDrag(); $$('.fl-item').forEach((x) => x.classList.remove('drop-before', 'drop-after')); },
        ondragover: (e) => {
          if (!dragTab || !canReorder) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          $$('.fl-item').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
          if (dragTab !== t) e.currentTarget.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before');
        },
        ondrop: (e) => {
          if (!dragTab || !canReorder) return;
          e.preventDefault();
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          moveTab(dragTab, t, e.clientY > r.top + r.height / 2);
        },
      },
      h('span', { class: 'fl-kind' + (isLogTab(t) ? ' log' : '') }),
      h('span', { class: 'fl-text' }, h('span', { class: 'fl-name' }, t.name), h('span', { class: 'fl-dir' }, fileDir(t))),
      where ? h('span', { class: 'fl-where ' + where, title: where === 'main' ? 'In the main editor' : 'Shown in split view' }, where === 'main' ? 'open' : 'split') : null,
      h('span', { class: 'fl-dot', title: 'Unsaved changes' }),
      h('button', { class: 'fl-x icon-btn small', title: 'Close', 'aria-label': 'Close ' + t.name, tabindex: '-1', onclick: (e) => { e.stopPropagation(); closeTab(t); }, html: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>' }));
      ul.append(item);
    }
    if (!list.length) ul.append(h('div', { class: 'msg' }, q ? 'No open file matches "' + filesState.q + '".' : 'No files open.'));
    const saved = tabs.filter((t) => !isDirty(t));
    v.append(ul,
      h('div', { class: 'fl-foot' },
        h('button', { onclick: () => actions.new() }, 'New tab'),
        h('button', { onclick: () => actions.open() }, 'Open a file…'),
        h('button', { title: 'Close every tab without unsaved changes', disabled: saved.length === 0 || saved.length === tabs.length && tabs.length === 1, onclick: async () => { for (const t of saved.slice()) if (tabs.length > 1 || t.model.getValueLength()) await closeTab(t); } }, 'Close saved')),
      canReorder ? h('p', { class: 'hint' }, 'Drag files to change their order, or drag one onto the editor to show it side by side.') : h('p', { class: 'hint' }, 'Switch to "Tab order" with no filter to drag files into a new order.'));
    const nl = v.querySelector('.fl-list');
    if (nl) nl.scrollTop = prevScroll;
    if (searchFocused) { search.focus(); if (caret != null) search.setSelectionRange(caret, caret); }
    else if (focusId) { const el = v.querySelector(`.fl-item[data-tab="${focusId}"]`); if (el) el.focus(); }
  }
  function startListRename(t) {
    const item = $(`.view[data-view="files"] .fl-item[data-tab="${t.id}"]`);
    if (!item) return;
    const nameEl = item.querySelector('.fl-name');
    const input = h('input', { class: 'fl-rename', value: t.name, spellcheck: false, 'aria-label': 'New name for ' + t.name });
    nameEl.replaceWith(input);
    item.draggable = false;
    input.focus();
    const dot = t.name.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : t.name.length);
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      input.remove();
      if (commit && value && value !== t.name) await renameTab(t, value);
      renderFiles();
      renderTabs();
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
    input.addEventListener('blur', () => finish(true));
    ['mousedown', 'click', 'dblclick'].forEach((ev) => input.addEventListener(ev, (e) => e.stopPropagation()));
  }

  // ---------- insights ----------
  function renderInsights() {
    const v = view('insights');
    v.innerHTML = '';
    if (!active) return;
    if (!isLogTab(active)) {
      v.append(h('div', { class: 'empty' },
        h('p', null, 'This tab isn\'t recognised as a log, so log tools are off.'),
        h('p', { class: 'hint' }, 'Open a .log file or paste log lines into an empty tab and they are detected automatically. Spring Boot, Logback/Log4j, JSON, access logs and syslog are supported.'),
        h('button', { class: 'primary', onclick: () => { treatAsLog(active); renderInsights(); } }, 'Treat this tab as a log')));
      return;
    }
    const f = active.filter;
    const filterInput = (key, label, placeholder, mono) => h('div', { class: 'field' },
      h('label', null, label),
      h('input', { type: 'text', value: f[key], placeholder, spellcheck: false, style: mono ? 'font-family:var(--mono);font-size:12px' : null,
        oninput: debounce((e) => setFilter({ [key]: e.target.value }), 250) }));
    // Multi-line box: one pattern per line; grows with its content.
    const grow = (ta) => { ta.style.height = 'auto'; ta.style.height = Math.min(220, ta.scrollHeight + 2) + 'px'; };
    const filterLinesBox = (key, label, placeholder, extra) => {
      const ta = h('textarea', { id: 'flt-' + key, class: 'flt-lines', rows: 2, spellcheck: false, placeholder,
        oninput: (e) => { grow(e.target); setLater(key, e.target.value); } });
      ta.value = f[key] || '';
      setTimeout(() => grow(ta), 0);
      return h('div', { class: 'field' }, h('div', { class: 'row', style: 'justify-content:space-between' }, h('label', { for: 'flt-' + key }, label), extra || null), ta);
    };
    const setLater = debounce((key, val) => setFilter({ [key]: val }), 250);
    const modeSel = h('select', { class: 'mini', title: 'With several lines: show entries matching any line, or all of them',
      onchange: (e) => setFilter({ includeMode: e.target.value }) },
      h('option', { value: 'any', selected: f.includeMode !== 'all' }, 'any line'),
      h('option', { value: 'all', selected: f.includeMode === 'all' }, 'all lines'));

    v.append(
      h('div', { class: 'group' }, h('div', { id: 'ins-summary' })),
      h('div', { class: 'group' }, h('h3', null, 'Show levels'), h('div', { class: 'chips', id: 'ins-chips' })),
      h('div', { class: 'group' },
        h('h3', null, 'Filter'),
        h('p', { class: 'hint', style: 'margin-top:0' }, 'One pattern per line (press Enter for the next). Regex works too.'),
        filterLinesBox('include', 'Lines matching', 'orderId=90005\nSocketTimeout\nCRITICAL', h('span', { class: 'row', style: 'gap:6px;font-size:12px;color:var(--muted)' }, 'match', modeSel)),
        filterLinesBox('exclude', 'Hide lines matching', 'HealthCheck\nactuator'),
        filterInput('logger', 'Logger or thread contains', 'e.g. PaymentClient or exec-3'),
        filterLinesBox('trace', 'Trace / request IDs', 'One ID per line, or right-click an ID in the log'),
        h('div', { class: 'row' }, filterInput('from', 'From', '10:15 or 2026-11-02 10:15'), filterInput('to', 'To', '10:20')),
        h('button', { onclick: clearFilter }, 'Clear filter')),
      h('div', { class: 'group' },
        h('h3', null, 'Repeated errors ', h('span', { class: 'count', id: 'ins-gcount' })),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: settings.groupWarn,
          onchange: (e) => { settings.groupWarn = e.target.checked; saveSettings(); analyze(active); updateInsights(); } }), 'Include warnings'),
        h('div', { class: 'err-list', id: 'ins-groups' })),
      h('div', { class: 'group' },
        h('h3', null, 'Tools'),
        h('div', { class: 'row wrap' },
          h('button', { onclick: () => editor.trigger('tf', 'editor.foldAll') }, 'Fold stack traces'),
          h('button', { onclick: () => editor.trigger('tf', 'editor.unfoldAll') }, 'Unfold all'),
          h('button', { onclick: maskToNewTab }, 'Mask secrets to new tab'),
          h('button', { onclick: mergeOpenLogs }, 'Merge open logs by time'),
          active.path ? h('button', { onclick: toggleFollow }, active.tailing ? 'Stop following' : 'Follow file') : null)));
    updateInsights();
  }

  function updateInsights() {
    if (currentView !== 'insights' || !active || !isLogTab(active) || !$('#ins-summary')) { if (currentView === 'insights' && !$('#ins-summary')) renderInsights(); return; }
    const an = analyze(active);
    const shown = an.vis ? an.vis.reduce((a, b) => a + b, 0) : an.entries.length;
    const tl = an.timeline;
    const sum = $('#ins-summary');
    sum.innerHTML = '';
    sum.append(
      h('p', { class: 'hint', style: 'margin-top:0' }, (an.formatLabel || 'Generic') + ' log' + (an.vis ? ', ' + shown + ' entries match the filter' : '')),
      h('div', { class: 'summary' },
        h('div', { class: 'is-err' }, h('b', null, an.counts.ERROR), h('span', null, 'errors')),
        h('div', { class: 'is-warn' }, h('b', null, an.counts.WARN), h('span', null, 'warnings')),
        h('div', null, h('b', null, an.entries.length.toLocaleString()), h('span', null, 'entries')),
        h('div', null, h('b', null, tl ? Logs.formatDuration(tl.max - tl.min) : 'n/a'), h('span', null, tl ? 'from ' + Logs.formatTs(tl.min) : 'time span'))));
    const chips = $('#ins-chips');
    chips.innerHTML = '';
    for (const lvl of Logs.LEVEL_CHIPS) {
      const on = active.filter.levels.has(lvl);
      chips.append(h('button', {
        class: 'chip ' + (on ? 'on' : 'off'), 'data-level': lvl, title: 'Click to toggle, double-click to show only ' + lvl.toLowerCase(),
        onclick: (e) => {
          if (e.detail > 1) return;
          const s = new Set(active.filter.levels);
          if (s.has(lvl)) s.delete(lvl); else s.add(lvl);
          setFilter({ levels: s });
        },
        ondblclick: () => setFilter({ levels: new Set([lvl]) }),
      }, h('i'), lvl === 'OTHER' ? 'Other' : lvl[0] + lvl.slice(1).toLowerCase(), h('b', null, an.counts[lvl])));
    }
    const list = $('#ins-groups');
    list.innerHTML = '';
    $('#ins-gcount').textContent = an.groups.length ? an.groups.length + ' kinds' : '';
    if (!an.groups.length) list.append(h('p', { class: 'hint' }, 'No errors in this log.'));
    an.groups.slice(0, 60).forEach((g) => {
      let k = 0;
      const item = h('button', {
        class: 'err-item' + (g.level === 'WARN' ? ' warn' : ''),
        title: 'Click to jump through occurrences',
        onclick: () => { revealEntry(g.entries[k % g.entries.length]); k++; },
      },
      h('div', { class: 'top' }, h('span', { class: 'title' }, g.title), h('span', { class: 'n' }, g.count + '×')),
      h('div', { class: 'msg' }, g.sample),
      g.frame ? h('div', { class: 'where' }, 'at ' + g.frame) : null,
      g.firstTs != null ? h('div', { class: 'msg' }, g.count > 1 && g.lastTs !== g.firstTs ? 'first ' + Logs.formatTs(g.firstTs) + ', last ' + Logs.formatTs(g.lastTs) : 'at ' + Logs.formatTs(g.firstTs)) : null,
      g.rootCause && g.rootCause.split('.').pop() !== g.title ? h('div', { class: 'msg' }, 'Root cause: ' + g.rootCause) : null);
      const ask = h('button', { class: 'ghost', style: 'font-size:11.5px;padding:1px 6px;margin-top:4px',
        onclick: (e) => { e.stopPropagation(); const en = an.entries[g.entries[0]]; askCopilot('explain', Logs.entryText(an.lines, en, 80), 'This error happened ' + g.count + ' times.'); } }, 'Ask Copilot');
      item.append(ask);
      list.append(item);
    });
  }

  // ---------- extract ----------
  let extractState = { preset: 'auto', regex: '', ci: true, scope: 'line', onlyVisible: true, json: '@timestamp, level, message' };
  function renderExtract() {
    const v = view('extract');
    v.innerHTML = '';
    const preset = () => Logs.PRESETS.find((p) => p.id === extractState.preset) || Logs.PRESETS[0];
    if (!extractState.regex && preset().regex) extractState.regex = preset().regex;
    const regexBox = h('textarea', { rows: 4, spellcheck: false, style: 'font-family:var(--mono);font-size:12px;resize:vertical', placeholder: 'orderId=(?<orderId>\\d+).*?took (?<ms>\\d+)ms',
      oninput: (e) => { extractState.regex = e.target.value; } });
    regexBox.value = extractState.regex;
    const jsonBox = h('input', { type: 'text', value: extractState.json, spellcheck: false, oninput: (e) => { extractState.json = e.target.value; } });
    const regexField = h('div', { class: 'field' }, h('label', null, 'Pattern (regex)'), regexBox,
      h('p', { class: 'hint' }, 'Named groups like (?<orderId>\\d+) become columns. Each match is one row.'));
    const jsonField = h('div', { class: 'field' }, h('label', null, 'JSON fields (comma separated, dots for nesting)'), jsonBox);
    const sel = h('select', { onchange: (e) => {
      extractState.preset = e.target.value;
      const p = preset();
      if (p.regex !== undefined && p.id !== 'custom') { extractState.regex = p.regex; regexBox.value = p.regex; extractState.ci = p.flags.includes('i'); ci.checked = extractState.ci; }
      sync();
    } }, Logs.PRESETS.map((p) => h('option', { value: p.id, selected: p.id === extractState.preset }, p.label)));
    const ci = h('input', { type: 'checkbox', checked: extractState.ci, onchange: (e) => { extractState.ci = e.target.checked; } });
    const autoHint = h('p', { class: 'hint' }, 'TextForge finds the message patterns in this log by itself and builds one table per pattern. The parts that change between lines (IDs, users, durations, status words, key=value values, JSON fields) become columns.');
    const runBtn = h('button', { class: 'primary', onclick: runExtract }, 'Build tables');
    const sync = () => {
      const p = preset();
      runBtn.textContent = p.special === 'auto' ? 'Build tables' : 'Extract to table';
      autoHint.hidden = p.special !== 'auto';
      scopeGroup.hidden = p.special === 'auto';
      regexField.hidden = !!p.special;
      jsonField.hidden = p.special !== 'json';
      ciRow.hidden = !!p.special;
      patternBox.hidden = p.special !== 'auto';
    };
    const ciRow = h('label', { class: 'check' }, ci, 'Ignore case');
    const patternBox = h('div', { class: 'group pf-group' });
    const radio = (val, label) => h('label', { class: 'check' }, h('input', { type: 'radio', name: 'ex-scope', checked: extractState.scope === val, onchange: () => { extractState.scope = val; } }), label);
    const scopeGroup = h('div', { class: 'group' }, h('h3', null, 'Search in'),
      radio('line', 'Each line'),
      radio('entry', 'Whole entries, including stack traces'));
    v.append(
      h('div', { class: 'group' },
        h('div', { class: 'field' }, h('label', null, 'What to extract'), sel),
        autoHint, regexField, jsonField, ciRow),
      scopeGroup,
      h('div', { class: 'group' },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: extractState.onlyVisible, onchange: (e) => { extractState.onlyVisible = e.target.checked; } }), 'Only entries shown by the current filter')),
      h('div', { class: 'group' }, runBtn,
        h('p', { class: 'hint' }, 'Results open in the panel below the editor. Number columns get min, max, average and p95. Click a line number to jump to it.')),
      patternBox);
    sync();
    renderPatternList(patternBox);
  }

  // ---------- patterns found (0.15.0) ----------
  // The message patterns of the active tab, learned once per version of its text and listed in Extract data.
  // A click opens that pattern's table in the results panel.
  const PATTERN_AUTO_LINES = 20000; // bigger tabs wait for Build tables (learning takes about a second per 100k lines)
  function patternsFor(tab) {
    if (!tab) return null;
    const v = tab.model.getVersionId();
    if (tab.patterns && tab.patterns.version === v) return tab.patterns.res;
    if (autoState && autoState.tab === tab && autoState.version === v && !autoState.filtered) { tab.patterns = { version: v, res: autoState.res }; return autoState.res; }
    const lines = tab.model.getLinesContent();
    if (lines.length > PATTERN_AUTO_LINES || !lines.some((l) => l.trim())) return null;
    const an = isLogTab(tab) ? analyze(tab) : null;
    const res = Logs.autoTables(lines, an ? an.entries : Logs.parseEntries(lines).entries);
    tab.patterns = { version: v, res };
    return res;
  }
  function openPattern(tb, res) {
    if (!autoState || autoState.tab !== active || autoState.res !== res) {
      autoState = { res, tab: active, selected: null, side: null, shown: true, filtered: false, version: active.model.getVersionId() };
    }
    showAutoTable(tb);
    const box = $('.view[data-view="extract"] .pf-group');
    if (box) renderPatternList(box);
  }
  const PATTERN_LIST_MAX = 12;
  function renderPatternList(box) {
    if (!box) return;
    box.replaceChildren();
    if (!active) return;
    const res = patternsFor(active);
    const head = (n) => h('h3', null, 'Patterns found' + (n != null ? ' · ' + n : ''));
    if (!res) {
      const big = active.model.getLineCount() > PATTERN_AUTO_LINES;
      box.append(head(), h('p', { class: 'hint' }, big ? 'Large file: press Build tables to find the patterns.' : 'Nothing to find in this tab yet.'));
      return;
    }
    if (!res.tables.length) { box.append(head(0), h('p', { class: 'hint' }, 'No repeating patterns here. Build tables shows every entry as a row.')); return; }
    box.append(head(res.tables.length));
    const list = h('div', { class: 'pf-list', role: 'list' });
    for (const tb of res.tables.slice(0, PATTERN_LIST_MAX)) {
      const on = autoState && autoState.res === res && autoState.selected === tb && !$('#panel').hidden;
      list.append(h('button', { class: 'pf-item' + (on ? ' on' : ''), role: 'listitem', title: tb.template + (tb.logger ? '\n' + tb.logger : '') + '\nColumns: ' + tb.columns.join(', '), onclick: () => openPattern(tb, res) },
        h('span', { class: 'pf-top' }, levelDot(tb.levels), tplNode(tb.title), h('span', { class: 'pf-count' }, tb.count.toLocaleString() + (tb.count === 1 ? ' row' : ' rows'))),
        h('span', { class: 'pf-cols' }, tb.columns.join(' · '))));
    }
    box.append(list);
    if (res.tables.length > PATTERN_LIST_MAX) {
      box.append(h('button', { class: 'pf-more', onclick: () => openPattern(res.tables[0], res) }, 'See all ' + res.tables.length + ' patterns in the results'));
    }
  }

  function extractUnits() {
    const lines = active.model.getLinesContent();
    const an = isLogTab(active) ? analyze(active) : null;
    const vis = extractState.onlyVisible && an && an.vis ? an.vis : null;
    const units = [];
    if (extractState.scope === 'entry' && an) {
      an.entries.forEach((e, i) => { if (!vis || vis[i]) units.push({ line: e.start + 1, text: Logs.entryText(lines, e, 400) }); });
    } else if (vis && an) {
      an.entries.forEach((e, i) => { if (vis[i]) for (let l = e.start; l <= e.end; l++) units.push({ line: l + 1, text: lines[l] }); });
    } else {
      lines.forEach((t, i) => units.push({ line: i + 1, text: t }));
    }
    return units;
  }

  function runExtract() {
    if (!active) return;
    const p = Logs.PRESETS.find((x) => x.id === extractState.preset);
    if (p && p.special === 'auto') return runAutoTables();
    const units = extractUnits();
    let res;
    if (p && p.special === 'kv') res = Logs.extractKeyValues(units);
    else if (p && p.special === 'json') res = Logs.extractJsonFields(units, extractState.json.split(','));
    else {
      if (!extractState.regex.trim()) { toast('Enter a pattern first.'); return; }
      res = Logs.extractRegex(units, extractState.regex, extractState.ci ? 'i' : '');
    }
    if (res.error) { toast('Pattern error: ' + res.error, 6000); return; }
    showResults(res, (p ? p.label : 'Custom') + ' from ' + active.name);
    return res;
  }

  let lastResults = null;
  // Run a preset by id (used by the command palette and the automated checklist).
  function extractPreset(id) {
    const p = Logs.PRESETS.find((x) => x.id === id);
    if (!p) return null;
    extractState.preset = id;
    if (p.regex) { extractState.regex = p.regex; extractState.ci = (p.flags || '').includes('i'); }
    extractState.scope = 'line';
    if (currentView === 'extract') renderExtract();
    return runExtract();
  }

  // ---------- automatic tables ----------
  let autoState = null;
  async function runAutoTables() {
    if (!active) return null;
    const t = active;
    const lines = t.model.getLinesContent();
    if (!lines.some((l) => l.trim())) { toast('This tab is empty.'); return null; }
    const big = lines.length > 100000;
    if (big) { toast('Finding patterns in ' + lines.length.toLocaleString() + ' lines…', 60000); await nextPaint(); }
    const an = isLogTab(t) ? analyze(t) : null;
    let entries = an ? an.entries : Logs.parseEntries(lines).entries;
    let filtered = false;
    if (an && extractState.onlyVisible && an.vis) { entries = entries.filter((e, i) => an.vis[i]); filtered = entries.length < an.entries.length; }
    const t0 = performance.now();
    const res = Logs.autoTables(lines, entries);
    if (big) $('#toast').hidden = true;
    autoState = { res, tab: t, selected: null, side: null, shown: true, filtered, ms: performance.now() - t0, version: t.model.getVersionId() };
    if (!res.tables.length) {
      showAutoTable(res.overview);
      toast('No repeating patterns found, so here is every entry as a row.', 5000);
      return res;
    }
    showAutoTable(res.tables[0]);
    return res;
  }

  // A pattern's most serious level as a coloured dot, and its template with the changing parts marked.
  function levelDot(levels) {
    const order = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];
    const top = order.find((l) => levels && levels[l]);
    return top ? h('span', { class: 'at-dot lv-' + top.toLowerCase(), title: Object.entries(levels).map(([k, v]) => k + ' ' + v).join(', ') }) : h('span', { class: 'at-dot' });
  }
  function tplNode(text) {
    const out = h('span', { class: 'at-tpl' });
    text.split(/(‹[^›]*›)/).forEach((part) => {
      if (!part) return;
      out.append(part[0] === '‹' ? h('span', { class: 'at-var' }, part.slice(1, -1)) : document.createTextNode(part));
    });
    return out;
  }

  function autoSide() {
    const st = autoState;
    const list = h('div', { class: 'at-list' });
    const items = h('div', { class: 'at-items', role: 'listbox', 'aria-label': 'Detected patterns' });
    const q = h('input', { type: 'search', placeholder: 'Filter ' + st.res.tables.length + ' patterns', 'aria-label': 'Filter patterns', spellcheck: false,
      oninput: () => draw() });
    const item = (tb) => {
      const el = h('button', { class: 'at-item' + (st.selected === tb ? ' on' : ''), role: 'option', 'aria-selected': String(st.selected === tb), title: tb.template + (tb.logger ? '\n' + tb.logger : ''),
        onclick: () => showAutoTable(tb) },
        h('span', { class: 'at-count' }, tb.count.toLocaleString()), levelDot(tb.levels), tplNode(tb.title));
      return el;
    };
    const draw = () => {
      items.innerHTML = '';
      const f = q.value.trim().toLowerCase();
      if (!f) items.append(item(st.res.overview));
      let n = 0;
      for (const tb of st.res.tables) {
        if (f && !(tb.template.toLowerCase().includes(f) || (tb.logger || '').toLowerCase().includes(f) || tb.columns.some((c) => c.toLowerCase().includes(f)))) continue;
        if (++n > 400) break;
        items.append(item(tb));
      }
      if (f && !n) items.append(h('div', { class: 'msg' }, 'No pattern matches.'));
    };
    draw();
    list.append(q, items);
    return list;
  }

  function showAutoTable(tb) {
    const st = autoState;
    if (!st) return;
    st.selected = tb;
    const prev = st.side;
    const prevScroll = prev && prev.isConnected ? prev.querySelector('.at-items').scrollTop : 0;
    const side = autoSide();
    st.side = side;
    const res = st.res;
    const where = (st.filtered ? 'shown ' : '') + res.processed.toLocaleString() + ' entr' + (res.processed === 1 ? 'y' : 'ies') + (res.truncated ? ' (first ' + res.processed.toLocaleString() + ' of ' + res.total.toLocaleString() + ')' : '');
    showResults({ columns: tb.columns, rows: tb.rows, truncated: tb.truncated }, res.tables.length + ' pattern' + (res.tables.length === 1 ? '' : 's') + ' in ' + where + ' · ' + tb.count.toLocaleString() + ' rows', { side });
    side.querySelector('.at-items').scrollTop = prevScroll;
    st.shown = true;
  }

  // Group the last results by one column: value, count, share.
  function countByColumn(ci) {
    if (!lastResults || !lastResults.rows.length) return null;
    const vals = lastResults.rows.map((r) => r.values[ci]);
    const counted = Logs.countBy(vals);
    const firstLine = new Map();
    lastResults.rows.forEach((r) => { if (!firstLine.has(r.values[ci])) firstLine.set(r.values[ci], r.line); });
    const col = lastResults.columns[ci];
    showResults({ columns: [col, 'count', 'share'], rows: counted.map(([v, n]) => ({ line: firstLine.get(v), values: [v, String(n), (Math.round((n / vals.length) * 1000) / 10) + '%'] })) },
      'Count by ' + col + ': ' + counted.length + ' unique of ' + vals.length, { keepLast: true, autoSide: true });
    return counted;
  }

  function showResults(res, title, opts = {}) {
    if (!opts.keepLast) lastResults = res;
    const sideEl = opts.side || (opts.autoSide && autoState && autoState.shown ? autoState.side : null);
    const sideScroll = sideEl ? sideEl.scrollTop : 0;
    openPanel('extract', title);
    let body = $('#panel-body');
    body.classList.toggle('at-split', !!sideEl);
    if (sideEl) {
      const main = h('div', { class: 'at-main' });
      body.append(sideEl, main);
      sideEl.scrollTop = sideScroll;
      body = main;
    }
    if (!sideEl && autoState) autoState.shown = false;
    if (!res.rows.length) { body.innerHTML = '<div class="msg">No matches. Check the pattern, or turn off "Only entries shown by the current filter".</div>'; return; }
    const state = { res, sortCol: -1, asc: true };
    const columns = ['line'].concat(res.columns);
    const asRows = () => [res.columns].concat(state.rows.map((r) => r.values));
    state.rows = res.rows.slice();
    const tools = (label, fn, title) => { const b = h('button', { onclick: fn, title }, label); $('#panel-tools').append(b); };
    tools('Copy as table', async () => { await api.clipboardWrite({ text: Tables.formatRows(asRows(), 'tsv'), html: Tables.rowsToHtml(asRows()) }); toast('Copied. Paste into Excel, Word or Outlook to get a real table.'); }, 'Copies a real table for Excel / Word / Outlook');
    tools('Copy CSV', async () => { await api.clipboardWrite({ text: Tables.formatRows(asRows(), 'csv') }); toast('Copied as CSV'); });
    tools('Open as new tab', () => { const t = newTab({ name: 'extract.csv', content: Tables.formatRows(asRows(), 'csv'), lang: 'plaintext' }); t.detectDone = true; activate(t); });
    if (!opts.keepLast && res.columns.length) {
      const colSel = h('select', { title: 'Column to count' }, res.columns.map((c, i) => h('option', { value: String(i) }, c)));
      $('#panel-tools').append(colSel);
      tools('Count by value', () => countByColumn(+colSel.value), 'Unique values with how often each occurs');
    }
    tools('Filter log to these lines', () => {
      if (!isLogTab(active)) return toast('Only available for logs.');
      setFilter({ lines: new Set(state.rows.map((r) => r.line)) });
    }, 'Hide every entry that produced no row');

    const statsEl = h('div', { class: 'stats' });
    statsEl.append(h('span', null, h('b', null, res.rows.length.toLocaleString()), ' rows' + (res.truncated ? ' (stopped at 200,000)' : '')));
    res.columns.forEach((c, i) => {
      const s = Logs.numericStats(res.rows.map((r) => r.values[i]));
      if (s) statsEl.append(h('span', null, c + ': min ', h('b', null, s.min), ', avg ', h('b', null, s.avg), ', p95 ', h('b', null, s.p95), ', max ', h('b', null, s.max)));
    });
    const table = h('table', { class: 'grid' });
    const MAX = 2000;
    const draw = () => {
      table.innerHTML = '';
      const tr = h('tr');
      columns.forEach((c, ci) => tr.append(h('th', {
        class: state.sortCol === ci ? 'sorted' + (state.asc ? ' asc' : '') : '',
        title: 'Sort', onclick: () => { state.asc = state.sortCol === ci ? !state.asc : true; state.sortCol = ci; sortRows(ci); draw(); },
      }, c === 'line' ? 'Line' : c)));
      table.append(tr);
      for (const r of state.rows.slice(0, MAX)) {
        const row = h('tr', null, h('td', { class: 'ln', title: 'Jump to line', onclick: () => gotoLine(r.line) }, r.line));
        r.values.forEach((v) => row.append(h('td', { title: v.length > 60 ? v : null }, v)));
        table.append(row);
      }
    };
    const sortRows = (ci) => {
      const get = (r) => (ci === 0 ? r.line : r.values[ci - 1]);
      const num = state.rows.every((r) => { const v = get(r); return v === '' || !Number.isNaN(parseFloat(v)); });
      state.rows.sort((a, b) => {
        const x = get(a); const y = get(b);
        const c = num ? (parseFloat(x) || 0) - (parseFloat(y) || 0) : String(x).localeCompare(String(y));
        return state.asc ? c : -c;
      });
    };
    draw();
    body.append(statsEl, table);
    if (res.rows.length > MAX) body.append(h('div', { class: 'msg' }, 'Showing the first ' + MAX + ' rows. Copy or open as a tab to get all of them.'));
  }

  function gotoLine(ln) {
    editor.setPosition({ lineNumber: ln, column: 1 });
    editor.revealLineInCenter(ln);
    editor.setSelection(new monaco.Range(ln, 1, ln, active.model.getLineMaxColumn(ln)));
    editor.focus();
  }

  // ---------- highlight rules ----------
  function renderHighlight() {
    const v = view('highlight');
    v.innerHTML = '';
    const refresh = debounce(() => { saveSettings(); updateRuleStyles(); tabs.forEach(refreshDecorations); }, 300);
    const pk = h('input', { type: 'text', value: settings.myPackages, spellcheck: false, placeholder: 'com.mycompany, com.example',
      oninput: debounce((e) => { settings.myPackages = e.target.value; saveSettings(); tabs.forEach((t) => { if (isLogTab(t)) { t.an = null; analyze(t); } refreshDecorations(t); }); onActiveAnalysisChanged(); }, 400) });
    const list = h('div');
    const drawRules = () => {
      list.innerHTML = '';
      settings.rules.forEach((r, i) => {
        list.append(h('div', { class: 'group', style: 'margin-top:12px' },
          h('div', { class: 'rule' },
            h('input', { type: 'checkbox', checked: r.on, title: 'On / off', style: 'accent-color:var(--accent)', onchange: (e) => { r.on = e.target.checked; refresh(); } }),
            h('input', { type: 'text', value: r.label || '', placeholder: 'Name', style: 'font-family:var(--ui);font-size:12.5px', oninput: (e) => { r.label = e.target.value; refresh(); } }),
            h('input', { type: 'color', value: r.color, title: 'Colour', oninput: (e) => { r.color = e.target.value; refresh(); } }),
            h('button', { class: 'icon-btn small', title: 'Delete rule', html: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>', onclick: () => { settings.rules.splice(i, 1); drawRules(); refresh(); } })),
          h('div', { class: 'rule' },
            h('input', { type: 'text', value: r.pattern, placeholder: 'regex, e.g. took \\d{4,}ms', spellcheck: false, oninput: (e) => { r.pattern = e.target.value; refresh(); } }),
            h('label', { class: 'check', style: 'margin:0;white-space:nowrap' }, h('input', { type: 'checkbox', checked: r.ci, onchange: (e) => { r.ci = e.target.checked; refresh(); } }), 'Ignore case'))));
      });
    };
    drawRules();
    v.append(
      h('div', { class: 'group' }, h('h3', null, 'Your code'),
        h('div', { class: 'field' }, h('label', null, 'Your packages (comma separated)'), pk),
        h('p', { class: 'hint' }, 'Stack-trace lines from these packages are highlighted in your accent colour and used to show where errors happen. Framework frames are dimmed.')),
      h('div', { class: 'group' }, h('h3', null, 'Highlight rules'),
        h('p', { class: 'hint' }, 'Any regex, any colour. Rules apply to every open tab and also show as hover labels.'),
        list,
        h('div', { class: 'row', style: 'margin-top:12px' },
          h('button', { onclick: () => { settings.rules.push({ label: '', pattern: '', color: ACCENTS[settings.rules.length % ACCENTS.length], ci: true, on: true }); drawRules(); refresh(); } }, 'Add rule'),
          h('button', { class: 'ghost', onclick: () => { settings.rules = JSON.parse(JSON.stringify(DEFAULT_RULES)); drawRules(); refresh(); } }, 'Reset to defaults'))));
  }

  // ---------- appearance ----------
  function renderAppearance() {
    const v = view('appearance');
    v.innerHTML = '';
    const set = (k, val) => { settings[k] = val; saveSettings(); };
    const themes = h('div', { class: 'themes' });
    for (const [id, t] of Object.entries(THEMES)) {
      const pal = t.dark ? PAL_DARK : PAL_LIGHT;
      themes.append(h('button', { class: 'theme-card' + (settings.theme === id ? ' on' : ''), onclick: () => { set('theme', id); applyTheme(); renderAppearance(); } },
        h('span', { class: 'sw', style: `background:${t.editor}` },
          h('i', { style: `background:${t.surface}` }),
          h('i', { class: 'code' }, h('s', { style: `background:${pal.err};width:40%` }), h('s', { style: `background:${pal.info};width:70%` }), h('s', { style: `background:${t.muted};width:55%` }))),
        h('span', { class: 'nm', style: `background:${t.surface};color:${t.fg}` }, t.label)));
    }
    const accents = h('div', { class: 'accents' });
    ACCENTS.forEach((a) => accents.append(h('button', { class: 'swatch' + (settings.accent.toLowerCase() === a ? ' on' : ''), style: `background:${a}`, title: a,
      onclick: () => { set('accent', a); applyTheme(); renderAppearance(); } })));
    accents.append(h('input', { type: 'color', value: settings.accent, title: 'Custom colour', oninput: debounce((e) => { set('accent', e.target.value); applyTheme(); }, 60) }));

    const fonts = ['JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', 'Consolas', 'Fira Code', 'Source Code Pro', 'Courier New'];
    const check = (k, label, after) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!settings[k], onchange: (e) => { set(k, e.target.checked); applyEditorOptions(); if (after) after(); } }), label);
    const maskCheck = (k, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!settings.mask[k], onchange: (e) => { settings.mask[k] = e.target.checked; saveSettings(); } }), label);
    const sizeLabel = h('span', null, settings.fontSize + ' px');
    const lhLabel = h('span', null, settings.lineHeight.toFixed(2));
    v.append(
      h('div', { class: 'group' }, h('h3', null, 'Theme'), themes),
      h('div', { class: 'group' }, h('h3', null, 'Accent colour'), accents),
      h('div', { class: 'group' }, h('h3', null, 'Density'),
        h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Density' },
          [['comfortable', 'Comfortable'], ['compact', 'Compact']].map(([val, label]) => h('button', {
            class: settings.density === val ? 'on' : '', role: 'radio', 'aria-checked': String(settings.density === val),
            onclick: () => { set('density', val); applyTheme(); applyEditorOptions(); if (editor) editor.layout(); renderAppearance(); },
          }, label))),
        h('p', { class: 'hint' }, 'Compact fits more on screen: smaller bars and tabs, and tighter line spacing in the editor.')),
      h('div', { class: 'group' }, h('h3', null, 'Editor text'),
        h('div', { class: 'field' }, h('label', null, 'Font'), h('select', { onchange: (e) => { set('fontFamily', e.target.value); applyEditorOptions(); } },
          fonts.map((f) => h('option', { value: f, selected: settings.fontFamily === f }, f)))),
        h('div', { class: 'field' }, h('label', null, 'Size ', sizeLabel), h('input', { type: 'range', min: 10, max: 24, step: 1, value: String(settings.fontSize),
          oninput: (e) => { set('fontSize', +e.target.value); sizeLabel.textContent = e.target.value + ' px'; applyEditorOptions(); } })),
        h('div', { class: 'field' }, h('label', null, 'Line spacing ', lhLabel), h('input', { type: 'range', min: 1.2, max: 2, step: 0.05, value: String(settings.lineHeight),
          oninput: (e) => { set('lineHeight', +e.target.value); lhLabel.textContent = (+e.target.value).toFixed(2); applyEditorOptions(); } })),
        check('ligatures', 'Font ligatures (=> becomes an arrow)'),
        check('wrap', 'Word wrap (Alt+Z)'),
        check('whitespace', 'Show whitespace'),
        check('minimap', 'Minimap'),
        check('signal', 'Signal strip above logs', renderSignal)),
      h('div', { class: 'group' }, h('h3', null, 'Pasting tables'),
        h('div', { class: 'field' }, h('label', null, 'Tables from Excel or web pages are pasted as'),
          h('select', { onchange: (e) => set('pasteFormat', e.target.value) },
            [['markdown', 'Markdown table'], ['grid', 'Grid with borders'], ['aligned', 'Aligned columns'], ['tsv', 'Tab-separated'], ['csv', 'CSV'], ['off', 'Plain text (off)']]
              .map(([val, l]) => h('option', { value: val, selected: settings.pasteFormat === val }, l))))),
      h('div', { class: 'group' }, h('h3', null, 'Copilot'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: settings.copilotMask, onchange: (e) => { settings.copilotMask = e.target.checked; saveSettings(); } }), 'Mask secrets in prompts'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: settings.copilotReview, onchange: (e) => { settings.copilotReview = e.target.checked; saveSettings(); } }), 'Review each prompt before sending'),
        h('div', { class: 'field' }, h('label', null, 'Copilot to use'), h('select', { onchange: (e) => { settings.copilotUrl = e.target.value; saveSettings(); if (copilotView) copilotView.setAttribute('src', e.target.value); } },
          COPILOT_SITES.map(([u, l]) => h('option', { value: u, selected: settings.copilotUrl === u }, l)))),
        api.copilotSignOut ? h('button', { onclick: signOutCopilot, title: 'Forget the Copilot sign-in on this computer' }, 'Sign out of Copilot') : null),
      h('div', { class: 'group' }, h('h3', null, 'Secret masking'),
        h('p', { class: 'hint' }, 'Passwords, tokens, JWTs, API keys and private keys are always masked. Also mask:'),
        maskCheck('emails', 'Email addresses'), maskCheck('cards', 'Card numbers'), maskCheck('pan', 'PAN numbers'), maskCheck('ips', 'IP addresses')));
  }

  // ---------- copilot ----------
  const COPILOT_SITES = [
    ['https://m365.cloud.microsoft/chat', 'Microsoft 365 Copilot (work account)'],
    ['https://copilot.microsoft.com', 'Copilot (personal account)'],
  ];
  let cpWin = null;
  // Microsoft does not allow Copilot inside other web pages, so the web version opens it as a slim
  // window docked to the right edge of the screen (Word / Excel style), next to this one.
  function openCopilotWindow() {
    const w = Math.min(480, Math.round((screen.availWidth || 1366) * 0.34));
    const left = (screen.availLeft || 0) + (screen.availWidth || 1366) - w;
    const top = screen.availTop || 0;
    try {
      cpWin = window.open(settings.copilotUrl, 'tf-copilot', 'popup=yes,width=' + w + ',height=' + (screen.availHeight || 800) + ',left=' + left + ',top=' + top);
    } catch { cpWin = null; }
    if (cpWin) { try { cpWin.focus(); } catch { /* ignore */ } }
    const fb = $('#cp-fallback');
    if (fb) fb.hidden = !!cpWin;
    return !!cpWin;
  }
  const copilotWindowOpen = () => { try { return !!cpWin && !cpWin.closed; } catch { return false; } };

  function copilotActions() {
    return h('div', { class: 'cp-bar' },
      h('div', { class: 'cp-actions' },
        h('button', { onclick: () => askCopilot('explain') }, 'Explain error'),
        h('button', { onclick: () => askCopilot('rootcause') }, 'Find root cause'),
        h('button', { onclick: () => askCopilot('summarize') }, 'Summarize log'),
        h('button', { onclick: () => askCopilot('fix') }, 'Suggest fix'),
        h('button', { onclick: () => askCopilot('custom') }, 'Ask about selection')),
      h('div', { class: 'row wrap' },
        h('label', { class: 'check', style: 'margin:0' }, h('input', { type: 'checkbox', checked: settings.copilotMask, onchange: (e) => { settings.copilotMask = e.target.checked; saveSettings(); } }), 'Mask secrets'),
        h('label', { class: 'check', style: 'margin:0' }, h('input', { type: 'checkbox', checked: settings.copilotReview, onchange: (e) => { settings.copilotReview = e.target.checked; saveSettings(); } }), 'Review before sending'),
        h('span', { class: 'grow' }),
        CAN.embeddedCopilot ? h('button', { class: 'icon-btn small', title: 'Reload', html: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>', onclick: () => copilotView && copilotView.reload() }) : null,
        CAN.embeddedCopilot ? h('button', { class: 'icon-btn small', title: 'Open in your browser', html: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>', onclick: () => api.openExternal(settings.copilotUrl) }) : null));
  }

  function renderCopilotWeb() {
    const v = view('copilot');
    v.innerHTML = '';
    const link = h('a', { class: 'btn-link', href: settings.copilotUrl, target: '_blank', rel: 'noopener' }, 'Open in a new tab instead');
    const siteSel = h('select', { onchange: (e) => { settings.copilotUrl = e.target.value; link.href = e.target.value; saveSettings(); } },
      COPILOT_SITES.map(([u, l]) => h('option', { value: u, selected: settings.copilotUrl === u }, l)));
    v.append(
      h('div', { class: 'cp-intro', style: 'padding-top:14px' },
        h('button', { class: 'primary', onclick: openCopilotWindow }, copilotWindowOpen() ? 'Show the Copilot window' : 'Open Copilot window'),
        h('p', { id: 'cp-fallback', class: 'hint', hidden: true }, 'Your browser blocked the window. ', link),
        h('ol', null,
          h('li', null, 'Copilot opens in a slim window on the right of your screen. Sign in once with your work account.'),
          h('li', null, 'Select log lines here (or put the cursor on an error), right-click and pick an Ask Copilot action.'),
          h('li', null, 'TextForge masks secrets, shows you the prompt and copies it. Click in the Copilot window and press Ctrl+V.')),
        h('div', { class: 'field' }, h('label', null, 'Copilot to use'), siteSel),
        h('p', { class: 'hint' }, 'Microsoft doesn\'t allow Copilot inside other web pages, so the browser version can\'t show it in this pane. The desktop app can. In Microsoft Edge, the Copilot button at the top right of the browser also opens Copilot in a sidebar next to this page.')));
  }

  // ---------- welcome screen (empty untitled tab) ----------
  function updateWelcome() {
    const w = $('#welcome');
    if (!w || !active) return;
    const show = !active.path && active.model.getValueLength() === 0 && !$('#diff') && !$('#incident') && !document.body.classList.contains('split-open');
    if (w.hidden !== !show) w.hidden = !show;
  }
  async function openSample() {
    let text = WEB.sample;
    if (!text && api.sample) { const r = await api.sample(); text = r && r.content; }
    if (!text) { toast('The sample log is not available.'); return; }
    const t = newTab({ name: 'order-service-sample.log', content: text, lang: 'log' });
    t.detectDone = true;
    activate(t);
  }
  function wireWelcome() {
    const acts = { open: () => actions.open(), sample: openSample, palette: () => openPalette() };
    $$('#welcome [data-wl]').forEach((b) => { b.onclick = () => acts[b.dataset.wl](); });
    // Clicking the card anywhere but its buttons starts typing, like clicking the editor behind it.
    const card = $('#welcome .wl-card');
    if (card) card.addEventListener('mousedown', (e) => { if (!e.target.closest('button')) { e.preventDefault(); editor.focus(); } });
  }

  // ---------- frameless window (desktop): the top bar is the title bar ----------
  function setupTitleBar() {
    if (!api.frameless) return;
    document.body.classList.add('frameless', 'os-' + api.os);
    const fit = () => {
      let left = api.os === 'darwin' ? 78 : 0;
      let right = api.os === 'darwin' ? 0 : 138;
      const wco = navigator.windowControlsOverlay;
      if (wco && wco.visible) {
        const r = wco.getTitlebarAreaRect();
        if (r && r.width) { left = Math.round(r.x); right = Math.max(0, Math.round(window.innerWidth - r.x - r.width)); }
      }
      document.documentElement.style.setProperty('--tb-left', left + 'px');
      document.documentElement.style.setProperty('--tb-right', right + 'px');
    };
    fit();
    if (navigator.windowControlsOverlay) navigator.windowControlsOverlay.addEventListener('geometrychange', fit);
    window.addEventListener('resize', debounce(fit, 100));
  }

  // ---------- Copilot button badge (0.15.0): the number of errors in this log it can explain ----------
  function updateCopilotBadge() {
    const fab = $('#cp-fab');
    if (!fab) return;
    let b = fab.querySelector('.cp-badge');
    const an = active && isLogTab(active) ? active.an : null;
    const n = an ? an.counts.ERROR : 0;
    if (!n) {
      if (b) b.remove();
      fab.title = 'Copilot (Alt+4)';
      fab.setAttribute('aria-label', 'Copilot');
      return;
    }
    if (!b) { b = h('span', { class: 'cp-badge', 'aria-hidden': 'true' }); fab.append(b); }
    b.textContent = n > 99 ? '99+' : String(n);
    fab.title = 'Copilot (Alt+4). ' + n + ' error' + (n === 1 ? '' : 's') + ' in this log: right-click one and pick Ask Copilot, or select lines and use Ask Copilot.';
    fab.setAttribute('aria-label', 'Copilot, ' + n + ' error' + (n === 1 ? '' : 's') + ' in this log');
  }

  // ---------- toolbar on selected text (0.15.0) ----------
  // Appears just above a selection once the mouse is released: Table from selection, Copy masked,
  // Show only entries with this (single-line selections in logs), Ask Copilot.
  let selBar = null;
  function wireSelectionBar() {
    const Pref = monaco.editor.ContentWidgetPositionPreference;
    let pos = null;
    let mouseDown = false;
    const run = (fn) => (e) => { e.preventDefault(); hide(); fn(); };
    const btn = (label, title, fn, cls) => h('button', { class: 'sb-btn' + (cls ? ' ' + cls : ''), title, onmousedown: (e) => e.preventDefault(), onclick: run(fn) }, label);
    const onlyBtn = btn('Show only entries with this', 'Filter the log to entries that contain the selected text', () => {
      const text = selectedText().trim();
      if (!text) return;
      const cur = filterLines(active.filter.trace);
      if (!cur.includes(text)) cur.push(text);
      setFilter({ trace: cur.join('\n') });
      if (currentView === 'insights') renderInsights();
    });
    const node = h('div', { class: 'selbar', role: 'toolbar', 'aria-label': 'Actions for the selected text' },
      btn('Table from selection', 'Open the selected lines as an editable table (Ctrl+Shift+T)', openTableView),
      btn('Copy masked', 'Copy with secrets masked', () => editor.getAction('tf.copyMasked').run()),
      onlyBtn,
      btn('Ask Copilot', 'Ask Copilot about the selected lines (secrets are masked first)', () => askCopilot('explain'), 'sb-cp'));
    const widget = {
      getId: () => 'tf.selbar',
      getDomNode: () => node,
      getPosition: () => (pos ? { position: pos, preference: [Pref.ABOVE, Pref.BELOW] } : null),
      allowEditorOverflow: true,
    };
    const selectedText = () => { const s = editor.getSelection(); return s && !s.isEmpty() ? active.model.getValueInRange(s) : ''; };
    function hide() { if (!pos) return; pos = null; node.classList.remove('on'); editor.layoutContentWidget(widget); }
    function show() {
      if (settings.selBar === false || mouseDown || !active) { hide(); return; }
      const s = editor.getSelection();
      if (!s || s.isEmpty() || active.model.getValueLengthInRange(s) < 2) { hide(); return; }
      const oneLine = s.startLineNumber === s.endLineNumber && active.model.getValueLengthInRange(s) <= 200;
      onlyBtn.hidden = !(oneLine && isLogTab(active));
      pos = { lineNumber: s.startLineNumber, column: s.startLineNumber === s.endLineNumber ? s.startColumn : 1 };
      node.classList.add('on');
      editor.layoutContentWidget(widget);
    }
    const later = debounce(show, 250);
    editor.addContentWidget(widget);
    // Monaco reports presses on its content widgets too; a press on the toolbar itself must not hide it,
    // or the button disappears before its click arrives.
    const onBar = (e) => e.target && e.target.type === monaco.editor.MouseTargetType.CONTENT_WIDGET && e.target.detail === 'tf.selbar';
    editor.onMouseDown((e) => { if (onBar(e)) return; mouseDown = true; hide(); });
    editor.onMouseUp((e) => { if (onBar(e)) return; mouseDown = false; later(); });
    editor.onDidChangeCursorSelection((e) => { if (editor.getSelection().isEmpty()) hide(); else if (!mouseDown && e.source === 'keyboard') later(); });
    editor.onDidChangeModel(hide);
    editor.onDidChangeModelContent(hide);
    node.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hide(); editor.focus(); } });
    selBar = { show, hide, node };
  }

  // ---------- floating / docked Copilot pane ----------
  function openCopilot({ toggle = true } = {}) {
    const host = $('#cp-host');
    if (toggle && !host.hidden) { closeCopilot(); return; }
    host.hidden = false;
    document.body.classList.add('cp-open');
    applyCopilotLayout();
    renderCopilot();
    $('#cp-fab').classList.add('on');
    $$('#rail .rail-btn[data-view="copilot"]').forEach((b) => b.classList.add('on'));
    setTimeout(() => editor && editor.layout(), 0);
  }
  function closeCopilot() {
    if (isFullscreen($('#cp-host'))) exitFullscreen();
    $('#cp-host').hidden = true;
    document.body.classList.remove('cp-open');
    $('#cp-fab').classList.remove('on');
    $$('#rail .rail-btn[data-view="copilot"]').forEach((b) => b.classList.remove('on'));
    setTimeout(() => { if (editor) { editor.layout(); editor.focus(); } }, 0);
  }
  const copilotOpen = () => !$('#cp-host').hidden;
  function applyCopilotLayout() {
    const host = $('#cp-host');
    const dock = !!settings.cpDock;
    host.classList.toggle('dock', dock);
    host.classList.toggle('float', !dock);
    host.style.cssText = '';
    if (dock) host.style.setProperty('--cp-dock-w', (settings.cpDockW || 420) + 'px');
    else if (settings.cpRect) {
      const b = $('#body').getBoundingClientRect();
      const r = settings.cpRect;
      const w = Math.min(r.w, b.width);
      const hh = Math.min(r.h, b.height);
      host.style.left = Math.max(0, Math.min(r.x, b.width - w)) + 'px';
      host.style.top = Math.max(0, Math.min(r.y, b.height - hh)) + 'px';
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      host.style.width = w + 'px';
      host.style.height = hh + 'px';
    }
    $('#cp-dock').title = dock ? 'Float over the editor' : 'Dock to the side';
    setTimeout(() => editor && editor.layout(), 0);
  }
  function wireCopilotPane() {
    const host = $('#cp-host');
    $('#cp-fab').onclick = () => openCopilot();
    $('#cp-close').onclick = closeCopilot;
    $('#cp-dock').onclick = () => { settings.cpDock = !settings.cpDock; saveSettings(); applyCopilotLayout(); };
    $('#cp-reload').hidden = $('#cp-external').hidden = !CAN.embeddedCopilot;
    $('#cp-reload').onclick = () => { if (copilotView) copilotView.reload(); };
    $('#cp-external').onclick = () => api.openExternal(settings.copilotUrl);
    const saveRect = () => {
      if (settings.cpDock || host.hidden) return;
      const b = $('#body').getBoundingClientRect();
      const r = host.getBoundingClientRect();
      settings.cpRect = { x: Math.round(r.left - b.left), y: Math.round(r.top - b.top), w: Math.round(r.width), h: Math.round(r.height) };
      saveSettings();
    };
    // drag by the title bar (floating only)
    $('#cp-head').addEventListener('mousedown', (e) => {
      if (settings.cpDock || e.target.closest('button') || e.button !== 0) return;
      e.preventDefault();
      const b = $('#body').getBoundingClientRect();
      const r = host.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      host.classList.add('dragging');
      Object.assign(host.style, { right: 'auto', bottom: 'auto', width: r.width + 'px', height: r.height + 'px' });
      const mm = (ev) => {
        host.style.left = Math.max(0, Math.min(ev.clientX - b.left - dx, b.width - r.width)) + 'px';
        host.style.top = Math.max(0, Math.min(ev.clientY - b.top - dy, b.height - r.height)) + 'px';
      };
      const mu = () => { host.classList.remove('dragging'); window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu); saveRect(); };
      window.addEventListener('mousemove', mm);
      window.addEventListener('mouseup', mu);
    });
    // Resize from the edges and corners. The grips sit above the embedded Copilot page, and while dragging
    // the page stops taking mouse events, so the drag cannot be swallowed by it.
    $$('#cp-host .cp-grip').forEach((grip) => {
      grip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const dir = grip.dataset.dir;
        const b = $('#body').getBoundingClientRect();
        const r = host.getBoundingClientRect();
        const MIN_W = 300;
        const MIN_H = 260;
        grip.setPointerCapture(e.pointerId);
        host.classList.add('dragging');
        document.body.classList.add('resizing-' + (dir === 'b' ? 'ns' : dir.length === 2 ? (dir === 'bl' ? 'nesw' : 'nwse') : 'ew'));
        if (!settings.cpDock) Object.assign(host.style, { left: (r.left - b.left) + 'px', top: (r.top - b.top) + 'px', right: 'auto', bottom: 'auto', width: r.width + 'px', height: r.height + 'px' });
        const move = (ev) => {
          if (settings.cpDock) {
            const w = Math.max(MIN_W, Math.min(b.right - ev.clientX, b.width - 420));
            host.style.setProperty('--cp-dock-w', Math.round(w) + 'px');
            return;
          }
          let { left, top, width, height } = { left: r.left - b.left, top: r.top - b.top, width: r.width, height: r.height };
          if (dir.includes('l')) { const nl = Math.max(0, Math.min(ev.clientX - b.left, left + width - MIN_W)); width += left - nl; left = nl; }
          if (dir.includes('r')) width = Math.max(MIN_W, Math.min(ev.clientX - r.left, b.right - r.left));
          if (dir.includes('b')) height = Math.max(MIN_H, Math.min(ev.clientY - r.top, b.bottom - r.top));
          Object.assign(host.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' });
        };
        const up = () => {
          grip.removeEventListener('pointermove', move);
          grip.removeEventListener('pointerup', up);
          grip.removeEventListener('pointercancel', up);
          host.classList.remove('dragging');
          document.body.className = document.body.className.replace(/\bresizing-\w+/g, '').trim();
          if (settings.cpDock) { settings.cpDockW = parseInt(host.style.getPropertyValue('--cp-dock-w'), 10) || 420; saveSettings(); }
          else saveRect();
          if (editor) editor.layout();
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
        grip.addEventListener('pointercancel', up);
      });
      grip.addEventListener('dblclick', () => {
        if (settings.cpDock) { settings.cpDockW = 420; } else { settings.cpRect = null; }
        saveSettings();
        applyCopilotLayout();
      });
    });
  }

  function renderCopilot() {
    if (!CAN.embeddedCopilot) { renderCopilotWeb(); return; }
    const v = view('copilot');
    if (copilotView && v.contains(copilotView)) return; // keep the live session
    v.innerHTML = '';
    const bar = null; // actions live in the editor's right-click menu; options in Appearance and settings
    const web = h('div', { class: 'cp-web' });
    // Signed in before: go straight to Copilot (the sign-in is kept between restarts).
    if (!copilotView && settings.cpStarted) loadCopilot();
    if (!copilotView) {
      web.style.background = 'transparent';
      const siteSel = h('select', { onchange: (e) => { settings.copilotUrl = e.target.value; saveSettings(); } },
        COPILOT_SITES.map(([u, l]) => h('option', { value: u, selected: settings.copilotUrl === u }, l)));
      web.append(h('div', { class: 'cp-intro' },
        h('p', null, 'Use the Copilot you already have, inside TextForge.'),
        h('ol', null,
          h('li', null, 'Sign in once with your work account. The sign-in is remembered.'),
          h('li', null, 'Select log lines (or just put the cursor on an error), right-click and pick an Ask Copilot action.'),
          h('li', null, 'TextForge masks secrets, shows you the prompt, then puts it in Copilot\'s message box. You press Enter.')),
        h('div', { class: 'field' }, h('label', null, 'Copilot to use'), siteSel),
        h('button', { class: 'primary', onclick: () => { settings.cpStarted = true; saveSettings(); loadCopilot(); renderCopilot(); } }, 'Open Copilot and sign in'),
        h('p', { class: 'hint', style: 'margin-top:12px' }, 'If your company only allows sign-in from managed browsers, use the open-in-browser button: prompts are copied to the clipboard so you can paste them in Edge.')));
    } else {
      web.append(copilotView);
    }
    v.append(...[bar, web].filter(Boolean));
  }

  async function signOutCopilot() {
    const ok = await modal('Sign out of Copilot', '<p>TextForge will forget the Copilot sign-in on this computer. Next time you open Copilot you sign in again.</p>',
      [{ label: 'Cancel', value: false }, { label: 'Sign out', value: true, primary: true }]);
    if (!ok) return;
    await api.copilotSignOut();
    if (copilotView) { copilotView.remove(); copilotView = null; }
    settings.cpStarted = false;
    saveSettings();
    if (document.body.classList.contains('cp-open')) renderCopilot();
    toast('Signed out of Copilot.');
  }

  function loadCopilot() {
    if (copilotView) return copilotView;
    // Tauri: Copilot is a native webview that the API keeps positioned over this placeholder.
    if (api.copilotView) { copilotView = api.copilotView(settings.copilotUrl); return copilotView; }
    const wv = document.createElement('webview');
    wv.setAttribute('partition', 'persist:copilot');
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('src', settings.copilotUrl);
    wv.addEventListener('did-fail-load', (e) => { if (e.errorCode !== -3 && e.isMainFrame) toast('Copilot did not load (' + e.errorDescription + '). Check your connection or open it in the browser.', 7000); });
    copilotView = wv;
    return wv;
  }

  async function injectPrompt(text) {
    const wv = copilotView;
    if (!wv) return false;
    if (api.copilotInsert) return api.copilotInsert(text).catch(() => false);
    try {
      wv.focus();
      const ok = await wv.executeJavaScript(`(() => {
        const c = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
          .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 120 && r.height > 14; });
        const el = c.find((e) => /ask|message|chat|prompt|copilot|type/i.test((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('placeholder') || ''))) || c[c.length - 1];
        if (!el) return false;
        el.focus();
        return true;
      })()`);
      if (!ok) return false;
      await wv.insertText(text);
      return true;
    } catch {
      return false;
    }
  }

  function currentEntryText(radius) {
    const an = isLogTab(active) ? analyze(active) : null;
    const pos = editor.getPosition();
    if (!an || !pos) return null;
    let idx = Logs.entryIndexAt(an.entries, pos.lineNumber - 1);
    if (idx < 0) return null;
    if (!radius) {
      // prefer the nearest error at or above the cursor
      for (let i = idx; i >= Math.max(0, idx - 3); i--) if (an.entries[i].level === 'ERROR') { idx = i; break; }
      return Logs.entryText(an.lines, an.entries[idx], 120);
    }
    const from = Math.max(0, idx - radius);
    const to = Math.min(an.entries.length - 1, idx + Math.ceil(radius / 3));
    const out = [];
    for (let i = from; i <= to; i++) if (!an.vis || an.vis[i]) out.push(Logs.entryText(an.lines, an.entries[i], 60));
    return out.join('\n');
  }

  function visibleLogText() {
    const an = isLogTab(active) ? analyze(active) : null;
    if (!an) return active.model.getValue();
    const out = [];
    an.entries.forEach((e, i) => { if (!an.vis || an.vis[i]) out.push(Logs.entryText(an.lines, e, 40)); });
    return out.join('\n');
  }

  // Web: prompt is on the clipboard; bring the Copilot window forward (or open it) to paste.
  function webCopied(ok) {
    if (ok === false) { toast('Copying was blocked by the browser. Turn on "Review before sending" to copy the prompt by hand.', 7000); return; }
    if (copilotWindowOpen()) { try { cpWin.focus(); } catch { /* ignore */ } toast('Prompt copied. Click in the Copilot window and press Ctrl+V.', 6000); return; }
    const opened = openCopilotWindow();
    if (!copilotOpen()) openCopilot({ toggle: false });
    toast(opened ? 'Prompt copied. Copilot is opening on the right: sign in if asked, then press Ctrl+V.' : 'Prompt copied. Open Copilot (button in the Copilot pane), then press Ctrl+V.', 7000);
  }

  async function askCopilot(kind, presetText, extraContext) {
    if (!active) return;
    const sel = editor.getSelection();
    const selected = sel && !sel.isEmpty() ? active.model.getValueInRange(sel) : '';
    let text = presetText || selected;
    let extra = extraContext || '';
    if (!text) {
      if (kind === 'explain' || kind === 'fix') text = currentEntryText(0);
      else if (kind === 'rootcause') text = currentEntryText(30);
      else if (kind === 'summarize') {
        text = visibleLogText();
        const an = isLogTab(active) ? active.an : null;
        if (an) extra = an.entries.length + ' entries, ' + an.counts.ERROR + ' errors, ' + an.counts.WARN + ' warnings. Repeated errors: ' +
          an.groups.slice(0, 10).map((g) => g.title + ' x' + g.count).join('; ');
      }
      if (!text && kind !== 'custom') text = active.model.getValue();
    }
    if (!text && kind !== 'custom') { toast('Nothing to send. Select some lines first.'); return; }
    let question = '';
    if (kind === 'custom') {
      question = await promptText('Ask Copilot', 'Your question about the ' + (selected ? 'selected lines' : 'current log'), 'Why does this request fail only for some users?');
      if (question == null) return;
      if (!text) text = visibleLogText();
    }
    let prompt = Logs.buildPrompt(kind === 'custom' ? 'custom' : kind, text, kind === 'custom' ? question : extra);
    let masked = 0;
    if (settings.copilotMask) { const m = Logs.maskSecrets(prompt, settings.mask); prompt = m.text; masked = m.count; }
    if (settings.copilotReview) {
      const ta = h('textarea', { spellcheck: false });
      ta.value = prompt;
      const body = h('div', null,
        h('p', { class: 'hint', style: 'margin-top:0' }, (masked ? masked + ' secret value' + (masked === 1 ? ' was' : 's were') + ' masked. ' : 'No secrets found. ') + 'Edit anything you don\'t want to share, then send.'), ta);
      const choice = await modal('Review prompt for Copilot', body, CAN.embeddedCopilot
        ? [{ label: 'Cancel', value: null }, { label: 'Copy only', value: 'copy' }, { label: 'Send to Copilot', value: 'send', primary: true }]
        : [{ label: 'Cancel', value: null }, { label: 'Copy prompt', value: 'copy', primary: true }]);
      if (!choice) return;
      prompt = ta.value;
      if (choice === 'copy') {
        const ok = await api.clipboardWrite({ text: prompt });
        if (!CAN.embeddedCopilot) { webCopied(ok); return; }
        toast(ok === false ? 'Copying was blocked by the browser. Select the text in the prompt box and copy it yourself.' : 'Prompt copied. Paste it into Copilot with Ctrl+V.', 6000);
        return;
      }
    }
    const copied = await api.clipboardWrite({ text: prompt });
    if (!CAN.embeddedCopilot) { webCopied(copied); return; }
    const fresh = !copilotView;
    loadCopilot();
    openCopilot({ toggle: false });
    if (fresh) { toast('Copilot is opening. Sign in if asked, then paste the prompt with Ctrl+V (it is on your clipboard).', 8000); return; }
    const ok = await injectPrompt(prompt);
    toast(ok ? 'Prompt is in Copilot\'s message box. Check it and press Enter.' : 'Prompt copied. Click Copilot\'s message box and press Ctrl+V.', 6000);
  }

  function promptText(title, label, placeholder) {
    const input = h('input', { type: 'text', placeholder, style: 'width:100%' });
    const body = h('div', null, h('div', { class: 'field' }, h('label', null, label), input));
    setTimeout(() => input.focus(), 30);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#modal-box .btns .primary').click(); });
    return modal(title, body, [{ label: 'Cancel', value: null }, { label: 'Continue', value: 'ok', primary: true }]).then((v) => (v ? input.value.trim() : null));
  }

  // ---------- log tools ----------
  function maskToNewTab() {
    if (!active) return;
    const sel = editor.getSelection();
    const src = sel && !sel.isEmpty() ? active.model.getValueInRange(sel) : active.model.getValue();
    const r = Logs.maskSecrets(src, settings.mask);
    const t = newTab({ name: active.name.replace(/(\.[^.]+)?$/, '.masked$1'), content: r.text, lang: active.model.getLanguageId() });
    t.detectDone = true;
    activate(t);
    toast(r.count + ' value' + (r.count === 1 ? '' : 's') + ' masked. The original tab is unchanged.');
  }

  function mergeOpenLogs() {
    const logs = tabs.filter(isLogTab);
    if (logs.length < 2) { toast('Open at least two log tabs to merge them by time.'); return; }
    const text = Logs.mergeLogs(logs.map((t) => ({ name: t.name.replace(/\.[^.]+$/, ''), text: t.model.getValue() })));
    const t = newTab({ name: 'merged.log', content: text, lang: 'log' });
    t.detectDone = true;
    activate(t);
    toast('Merged ' + logs.length + ' logs by timestamp. Each entry is tagged with its source.');
  }

  async function toggleFollow() {
    const t = active;
    if (!t || !t.path) { toast('Follow works for files saved on disk.'); return; }
    if (t.tailing) { await api.tailStop(t.path); t.tailing = false; toast('Stopped following ' + t.name); }
    else {
      if (isDirty(t)) { toast('Save or undo your changes before following the file.'); return; }
      const r = await api.tailStart(t.path);
      if (!r.ok) { toast('Cannot follow: ' + r.error); return; }
      t.tailing = true;
      const last = t.model.getLineCount();
      editor.revealLine(last);
      editor.setPosition({ lineNumber: last, column: 1 });
      toast('Following ' + t.name + '. New lines appear as they are written.');
    }
    updateStatus();
    if (currentView === 'insights') renderInsights();
  }

  function onTailData(d) {
    const t = tabs.find((x) => x.path === d.path && x.tailing);
    if (!t) return;
    const wasClean = !isDirty(t);
    const atEnd = t === active && editor.getVisibleRanges().some((r) => r.endLineNumber >= t.model.getLineCount() - 1);
    if (d.reset) t.model.setValue(d.text);
    else {
      const last = t.model.getLineCount();
      const col = t.model.getLineMaxColumn(last);
      t.model.applyEdits([{ range: new monaco.Range(last, col, last, col), text: d.text }]);
    }
    if (wasClean) { t.savedVersion = t.model.getAlternativeVersionId(); renderTabs(); }
    if (atEnd) editor.revealLine(t.model.getLineCount());
  }

  // ======================================================================
  // SPLIT VIEW with snap layouts (like Windows 11)
  // ======================================================================
  // The editor area is a grid. A layout decides where the main editor (zone "a") and up to three
  // panes (zones b, c, d) go. Pick a layout from the split button, or drag a tab onto the snap bar
  // or onto a zone. Empty zones show the open files to choose from (Snap Assist). Panes can scroll
  // together by time or line; filters and Ctrl+F search apply to every pane.
  const LAYOUTS = {
    cols2: { n: 2, label: 'Side by side', areas: ['a g1 b'], cols: ['c1', 'G', 'c2'], rows: ['r1'], gutters: { g1: ['x', 'c1', 'c2'] } },
    rows2: { n: 2, label: 'Top and bottom', areas: ['a', 'h1', 'b'], cols: ['c1'], rows: ['r1', 'G', 'r2'], gutters: { h1: ['y', 'r1', 'r2'] } },
    cols3: { n: 3, label: 'Three columns', areas: ['a g1 b g2 c'], cols: ['c1', 'G', 'c2', 'G', 'c3'], rows: ['r1'], gutters: { g1: ['x', 'c1', 'c2'], g2: ['x', 'c2', 'c3'] } },
    right2: { n: 3, label: 'One large, two stacked', areas: ['a g1 b', 'a g1 h1', 'a g1 c'], cols: ['c1', 'G', 'c2'], rows: ['r1', 'G', 'r2'], gutters: { g1: ['x', 'c1', 'c2'], h1: ['y', 'r1', 'r2'] } },
    grid4: { n: 4, label: 'Four in a grid', areas: ['a g1 b', 'h1 g1 h2', 'c g1 d'], cols: ['c1', 'G', 'c2'], rows: ['r1', 'G', 'r2'], gutters: { g1: ['x', 'c1', 'c2'], h1: ['y', 'r1', 'r2'], h2: ['y', 'r1', 'r2'] } },
  };
  const LAYOUT_ORDER = ['cols2', 'rows2', 'cols3', 'right2', 'grid4'];
  const SLOTS = ['a', 'b', 'c', 'd'];
  const GUTTER = 6;
  let split = null;
  let paneSeq = 0;
  function splitOptions() {
    return {
      model: null, theme: 'tf', automaticLayout: true, largeFileOptimizations: false, scrollBeyondLastLine: false,
      minimap: { enabled: false }, folding: true, showFoldingControls: 'mouseover', padding: { top: 8 }, renderLineHighlight: 'line',
      fixedOverflowWidgets: true, stickyScroll: { enabled: false }, unicodeHighlight: { ambiguousCharacters: false },
      fontFamily: `'${settings.fontFamily}', 'JetBrains Mono', Consolas, monospace`, fontSize: settings.fontSize,
      lineHeight: editorLineHeight(), wordWrap: settings.wrap ? 'on' : 'off', fontLigatures: settings.ligatures,
    };
  }
  function ensureSplit() {
    if (split) return split;
    split = { panes: [], layout: null, fr: {}, mode: 'auto', locks: new Map() };
    editor.onDidScrollChange((e) => { if (e.scrollTopChanged) syncScroll(editor); });
    wireFindMirror(editor);
    return split;
  }
  const splitOpen = () => !!(split && split.layout && split.panes.length);
  const inSplit = (t) => !!(split && split.panes.some((p) => p.tab === t));
  const paneEditors = () => (split ? split.panes.filter((p) => p.tab).map((p) => p.editor) : []);
  const tabOfEditor = (ed) => (ed === editor ? active : (split && (split.panes.find((p) => p.editor === ed) || {}).tab) || null);
  function focusedTab() {
    if (split) for (const p of split.panes) if (p.tab && p.editor.hasTextFocus()) return p.tab;
    return active;
  }
  function pickTabForPane(exclude = []) {
    const shown = new Set([active, ...(split ? split.panes.map((p) => p.tab) : []), ...exclude]);
    const others = tabs.filter((t) => !shown.has(t) && !isPristineUntitled(t));
    const pool = isLogTab(active) && others.some(isLogTab) ? others.filter(isLogTab) : others;
    return pool.slice().sort((a, b) => (b.used || b.id) - (a.used || a.id))[0] || null;
  }
  // Same filter on every pane (the extract "these lines" filter belongs to one file and stays put).
  function shareFilter(from, to) {
    if (!from || !to || from === to || !isLogTab(to)) return;
    const f = from.filter;
    const keep = to.filter && to.filter.lines;
    to.filter = Object.assign({}, f, { levels: new Set(f.levels) });
    if (keep) to.filter.lines = keep; else delete to.filter.lines;
    analyze(to);
    computeVisibility(to);
    applyHiddenAreas(to);
  }
  const stacked = () => window.innerWidth <= 760;
  // phones: whatever the layout, the files stack top to bottom
  function effectiveLayout() {
    const L = LAYOUTS[split.layout];
    if (!stacked() || L.n === 1) return L;
    const areas = [], rows = [], gutters = {};
    for (let i = 0; i < L.n; i++) {
      if (i) { areas.push('s' + i); rows.push('G'); gutters['s' + i] = ['y', 'q' + (i - 1), 'q' + i]; }
      areas.push(SLOTS[i]); rows.push('q' + i);
    }
    return { n: L.n, areas, cols: ['c1'], rows, gutters };
  }
  const track = (v) => (v === 'G' ? GUTTER + 'px' : 'minmax(0, ' + (split.fr[v] || 1) + 'fr)');
  function applyGrid() {
    const g = $('#editors');
    if (!splitOpen()) {
      g.style.gridTemplateAreas = '"a"'; g.style.gridTemplateColumns = 'minmax(0, 1fr)'; g.style.gridTemplateRows = 'minmax(0, 1fr)';
      g.querySelectorAll('.sp-gutter').forEach((x) => x.remove());
      return;
    }
    const L = effectiveLayout();
    g.style.gridTemplateAreas = L.areas.map((r) => '"' + r + '"').join(' ');
    g.style.gridTemplateColumns = L.cols.map(track).join(' ');
    g.style.gridTemplateRows = L.rows.map(track).join(' ');
    // gutters
    g.querySelectorAll('.sp-gutter').forEach((x) => x.remove());
    for (const [name, spec] of Object.entries(L.gutters)) {
      const el = h('div', { class: 'sp-gutter ' + (spec[0] === 'x' ? 'gx' : 'gy'), role: 'separator', tabindex: '0', 'aria-orientation': spec[0] === 'x' ? 'vertical' : 'horizontal', 'aria-label': 'Resize', title: 'Drag to resize. Double-click to make them equal.', style: 'grid-area:' + name });
      wireGutter(el, spec, L);
      g.append(el);
    }
    split.panes.forEach((p, i) => { p.el.style.gridArea = SLOTS[i + 1]; });
    $('#editor').style.gridArea = 'a';
  }
  function wireGutter(el, [axis, v1, v2], L) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const box = $('#editors').getBoundingClientRect();
      const list = axis === 'x' ? L.cols : L.rows;
      const size = axis === 'x' ? box.width : box.height;
      const gut = list.filter((v) => v === 'G').length * GUTTER;
      const sum = list.filter((v) => v !== 'G').reduce((a, v) => a + (split.fr[v] || 1), 0);
      const px = (v) => ((split.fr[v] || 1) / sum) * (size - gut);
      let start = axis === 'x' ? box.left : box.top;
      for (const v of list) { if (v === v1) break; start += v === 'G' ? GUTTER : px(v); }
      const pair = px(v1) + px(v2);
      const frPair = (split.fr[v1] || 1) + (split.fr[v2] || 1);
      const move = (ev) => {
        const pos = (axis === 'x' ? ev.clientX : ev.clientY) - start - GUTTER / 2;
        const a = Math.max(140, Math.min(pair - 140, pos));
        split.fr[v1] = frPair * (a / pair);
        split.fr[v2] = frPair - split.fr[v1];
        const g = $('#editors');
        if (axis === 'x') g.style.gridTemplateColumns = L.cols.map(track).join(' ');
        else g.style.gridTemplateRows = L.rows.map(track).join(' ');
      };
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    el.addEventListener('dblclick', () => { split.fr = {}; applyGrid(); });
    el.addEventListener('keydown', (e) => {
      const keys = axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      const d = (e.key === keys[0] ? -0.1 : 0.1) * ((split.fr[v1] || 1) + (split.fr[v2] || 1));
      const total = (split.fr[v1] || 1) + (split.fr[v2] || 1);
      split.fr[v1] = Math.max(total * 0.15, Math.min(total * 0.85, (split.fr[v1] || 1) + d));
      split.fr[v2] = total - split.fr[v1];
      applyGrid();
    });
  }

  function createPane() {
    const pane = { id: ++paneSeq, tab: null };
    const sel = h('select', { class: 'sp-tab', 'aria-label': 'File shown in this pane', onchange: (e) => setPaneTab(pane, tabs.find((x) => String(x.id) === e.target.value)) });
    pane.sel = sel;
    const body = h('div', { class: 'sp-editor' });
    pane.assist = h('div', { class: 'sp-assist', hidden: true });
    const wrap = h('div', { class: 'sp-body' }, body, pane.assist);
    pane.el = h('div', { class: 'sp-pane', 'data-pane': String(pane.id) },
      h('div', { class: 'sp-head' }, sel,
        h('span', { class: 'grow' }),
        h('button', { class: 'icon-btn small sp-swap', title: 'Swap with the main editor', onclick: () => swapPane(pane), html: '<svg viewBox="0 0 24 24"><path d="M7 7h13l-3-3M17 17H4l3 3"/></svg>' }),
        h('button', { class: 'icon-btn small sp-close', title: 'Close this pane', onclick: () => removePane(pane), html: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>' })),
      wrap);
    $('#editors').append(pane.el);
    pane.editor = monaco.editor.create(body, splitOptions());
    pane.editor.onDidScrollChange((e) => { if (e.scrollTopChanged) syncScroll(pane.editor); });
    pane.editor.onDidFocusEditorText(() => pane.el.classList.add('focused'));
    pane.editor.onDidBlurEditorText(() => pane.el.classList.remove('focused'));
    wireFindMirror(pane.editor);
    return pane;
  }
  function disposePane(pane) { pane.editor.dispose(); pane.el.remove(); }

  // Put the layout in place. place = { tab, slot }: that file goes in that zone; other files keep
  // their places in order; zones left over show Snap Assist.
  function applyLayout(id, { place, fill = false } = {}) {
    ensureSplit();
    const L = LAYOUTS[id];
    if (!L) return;
    let shown = [active, ...split.panes.map((p) => p.tab).filter(Boolean)];
    const slots = new Array(L.n).fill(null);
    if (place && place.tab) {
      shown = shown.filter((t) => t !== place.tab);
      slots[SLOTS.indexOf(place.slot)] = place.tab;
    }
    for (let i = 0; i < L.n; i++) if (!slots[i] && shown.length) slots[i] = shown.shift();
    if (!slots[0]) slots[0] = pickTabForPane(slots.filter(Boolean)) || active; // the main space can't be empty
    if (fill) for (let i = 1; i < L.n; i++) if (!slots[i]) slots[i] = pickTabForPane(slots.filter(Boolean));
    split.layout = id;
    split.fr = {};
    settings['layout' + L.n] = id;
    saveSettings();
    while (split.panes.length < L.n - 1) split.panes.push(createPane());
    while (split.panes.length > L.n - 1) disposePane(split.panes.pop());
    if (slots[0] !== active) activate(slots[0]);
    split.panes.forEach((p, i) => setPaneTab(p, slots[i + 1], { quiet: true }));
    $('#editors').classList.add('split');
    document.body.classList.add('split-open');
    applyGrid();
    applyEditorOptions();
    renderSplitHead();
    renderTabs();
    updateWelcome();
    syncScroll(editor, true);
  }
  function setPaneTab(pane, t, { quiet } = {}) {
    if (!pane) return;
    pane.tab = t || null;
    pane.editor.setModel(t ? t.model : null);
    pane.el.classList.toggle('no-file', !t);
    renderAssist(pane);
    if (t) { shareFilter(active, t); applyHiddenAreas(t); }
    if (quiet) return;
    renderSplitHead();
    renderTabs();
    syncScroll(editor, true);
  }
  // Snap Assist: an empty zone lists the open files to choose from.
  function renderAssist(pane) {
    const box = pane.assist;
    box.hidden = !!pane.tab;
    if (pane.tab) return;
    box.innerHTML = '';
    const list = tabs.filter((t) => !isPristineUntitled(t));
    box.append(h('div', { class: 'sa-title' }, list.length ? 'Choose a file for this space' : 'Open a file to show it here'));
    const grid = h('div', { class: 'sa-grid' });
    for (const t of list) {
      const shown = t === active || inSplit(t);
      grid.append(h('button', { class: 'sa-card' + (shown ? ' shown' : ''), title: t.path && !/^(web|download):/.test(t.path) ? t.path : t.name, onclick: () => setPaneTab(pane, t) },
        h('span', { class: 'kind' + (isLogTab(t) ? ' log' : '') }), h('span', { class: 'nm' }, t.name), shown ? h('span', { class: 'tag' }, 'shown') : null));
    }
    box.append(grid, h('div', { class: 'sa-foot' }, h('button', { onclick: () => actions.open() }, 'Open a file…'), h('button', { onclick: () => removePane(pane) }, 'Leave this space out')));
  }
  function preferredLayout(n) {
    const want = settings['layout' + n];
    if (want && LAYOUTS[want] && LAYOUTS[want].n === n) return want;
    return { 2: 'cols2', 3: 'cols3', 4: 'grid4' }[n];
  }
  // "Show beside": one more file; the layout grows (2 -> 3 -> 4 files)
  function addSplitPane(tab, { replace } = {}) {
    ensureSplit();
    if (replace) { setPaneTab(replace, tab); return replace; }
    const t = tab || pickTabForPane();
    if (t && inSplit(t)) { flashPane(split.panes.find((p) => p.tab === t)); return null; }
    if (splitOpen()) {
      const empty = split.panes.find((p) => !p.tab);
      if (empty) { setPaneTab(empty, t || null); return empty; }
      const n = split.panes.length + 2;
      if (n > 4) {
        const last = split.panes[split.panes.length - 1];
        toast('Up to 4 files fit side by side, so ' + last.tab.name + ' was swapped out.', 3500);
        setPaneTab(last, t);
        return last;
      }
      applyLayout(preferredLayout(n), { place: t ? { tab: t, slot: SLOTS[n - 1] } : null, fill: false });
      return split.panes[split.panes.length - 1];
    }
    if (!t) toast('Only one file is open: both sides show it, so you can compare two places. Pick another file at the top of the right side.', 4500);
    applyLayout(preferredLayout(2), { place: { tab: t || active, slot: 'b' }, fill: false });
    return split.panes[0];
  }
  function removePane(pane) {
    if (!split) return;
    const i = split.panes.indexOf(pane);
    if (i < 0) return;
    split.panes.splice(i, 1);
    disposePane(pane);
    const n = split.panes.length + 1;
    if (n < 2) { closeSplit(); return; }
    split.layout = preferredLayout(n);
    split.fr = {};
    applyGrid();
    renderSplitHead();
    renderTabs();
  }
  function removeSplitTab(t) { if (split) split.panes.filter((p) => p.tab === t).forEach(removePane); }
  function closeSplit() {
    if (!split) return;
    for (const p of split.panes) disposePane(p);
    split.panes = [];
    split.layout = null;
    $('#editors').classList.remove('split');
    document.body.classList.remove('split-open');
    applyGrid();
    applyEditorOptions();
    renderTabs();
    updateWelcome();
    setTimeout(() => editor.layout(), 0);
    editor.focus();
  }
  function toggleSplit() { if (splitOpen()) closeSplit(); else addSplitPane(); }
  function swapPane(pane) {
    pane = pane || (split && split.panes.find((p) => p.tab));
    if (!pane || !pane.tab || pane.tab === active) return;
    const left = active;
    activate(pane.tab);
    setPaneTab(pane, left);
  }
  const swapSplit = () => swapPane();
  function flashPane(pane) {
    if (!pane) return;
    pane.el.classList.remove('flash');
    void pane.el.offsetWidth;
    pane.el.classList.add('flash');
  }
  function effectiveSyncMode() {
    if (!split) return 'off';
    if (split.mode !== 'auto') return split.mode;
    const timed = (t) => t && isLogTab(t) && analyze(t) && t.an.timeline;
    const all = [active, ...split.panes.map((p) => p.tab).filter(Boolean)];
    const distinct = new Set(all).size === all.length;
    if (all.every(timed) && distinct) return 'time';
    return distinct ? 'line' : 'off';
  }
  function renderSplitHead() {
    if (!split) return;
    let syncDone = false;
    split.panes.forEach((pane) => {
      pane.sel.innerHTML = '';
      if (!pane.tab) pane.sel.append(h('option', { value: '', selected: true }, 'Choose a file…'));
      tabs.forEach((t) => pane.sel.append(h('option', { value: String(t.id), selected: t === pane.tab }, t.name + (t === active ? '  (main editor)' : ''))));
      const head = pane.el.querySelector('.sp-head');
      let sync = head.querySelector('.sp-sync');
      const want = !syncDone && !!pane.tab;
      if (want && !sync) {
        sync = h('label', { class: 'sp-sync', title: 'Scroll all panes together' }, h('span', null, 'Scroll together'),
          h('select', { 'aria-label': 'Scroll together', onchange: (e) => { split.mode = e.target.value; syncScroll(editor, true); } },
            h('option', { value: 'time' }, 'by time'), h('option', { value: 'line' }, 'by line'), h('option', { value: 'off' }, 'off')));
        pane.sel.after(sync);
      } else if (!want && sync) sync.remove();
      if (want) { sync.querySelector('select').value = effectiveSyncMode(); syncDone = true; }
      if (!pane.tab) renderAssist(pane);
    });
  }

  // ---------- the layout picker (split button) and the snap bar (while dragging a tab) ----------
  function layoutThumb(id, { onZone, current, dropTarget } = {}) {
    const L = LAYOUTS[id];
    const t = h('div', { class: 'snap-thumb' + (current ? ' current' : ''), 'data-layout': id, title: L.label, role: 'group', 'aria-label': L.label });
    t.style.gridTemplateAreas = L.areas.map((r) => '"' + r.replace(/\b[gh]\d\b/g, '.') + '"').join(' ');
    t.style.gridTemplateColumns = L.cols.map((v) => (v === 'G' ? '3px' : '1fr')).join(' ');
    t.style.gridTemplateRows = L.rows.map((v) => (v === 'G' ? '3px' : '1fr')).join(' ');
    for (let i = 0; i < L.n; i++) {
      const slot = SLOTS[i];
      const z = h('button', { class: 'snap-zone', 'data-slot': slot, style: 'grid-area:' + slot, 'aria-label': L.label + ', ' + (['left / first', 'second', 'third', 'fourth'][i]) + ' space', onclick: () => onZone && onZone(id, slot) });
      if (dropTarget) {
        z.addEventListener('dragover', (e) => { if (!dragTab) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; $$('.snap-zone.hot').forEach((x) => x.classList.remove('hot')); z.classList.add('hot'); showSnapPreview(zoneRect(id, slot), 'Snap ' + dragTab.name + ' here'); });
        z.addEventListener('dragleave', () => z.classList.remove('hot'));
        z.addEventListener('drop', (e) => { if (!dragTab) return; e.preventDefault(); e.stopPropagation(); const tb = dragTab; endTabDrag(); applyLayout(id, { place: { tab: tb, slot }, fill: false }); });
      }
      t.append(z);
    }
    return t;
  }
  // where a zone of a layout would be on screen (equal sizes)
  function zoneRect(id, slot) {
    const r = $('#editors').getBoundingClientRect();
    const w = r.width, hh = r.height, x = r.left, y = r.top;
    const geo = {
      cols2: { a: [0, 0, .5, 1], b: [.5, 0, .5, 1] },
      rows2: { a: [0, 0, 1, .5], b: [0, .5, 1, .5] },
      cols3: { a: [0, 0, 1 / 3, 1], b: [1 / 3, 0, 1 / 3, 1], c: [2 / 3, 0, 1 / 3, 1] },
      right2: { a: [0, 0, .5, 1], b: [.5, 0, .5, .5], c: [.5, .5, .5, .5] },
      grid4: { a: [0, 0, .5, .5], b: [.5, 0, .5, .5], c: [0, .5, .5, .5], d: [.5, .5, .5, .5] },
    }[id][slot];
    return { left: x + geo[0] * w, top: y + geo[1] * hh, width: geo[2] * w, height: geo[3] * hh };
  }
  function showSnapPreview(rect, label) {
    const pv = $('#snap-preview');
    const wr = $('#work').getBoundingClientRect();
    pv.hidden = false;
    pv.style.left = (rect.left - wr.left + 4) + 'px'; pv.style.top = (rect.top - wr.top + 4) + 'px';
    pv.style.width = Math.max(0, rect.width - 8) + 'px'; pv.style.height = Math.max(0, rect.height - 8) + 'px';
    pv.querySelector('span').textContent = label;
  }
  function hideSnapPreview() { const pv = $('#snap-preview'); if (pv) pv.hidden = true; $$('.snap-zone.hot').forEach((x) => x.classList.remove('hot')); }

  // Picker on the split button: click a zone of a layout = put this file there.
  let pickerTimer = null;
  function openLayoutPicker() {
    closeLayoutPicker();
    const btn = $('#topbar [data-act="split"]');
    const pick = h('div', { id: 'snap-picker', role: 'dialog', 'aria-label': 'Snap layouts' },
      h('div', { class: 'sp-title' }, 'Snap layouts', h('span', null, 'Click where this file should go')),
      h('div', { class: 'snap-grid' }, LAYOUT_ORDER.map((id) => layoutThumb(id, {
        current: split && split.layout === id,
        onZone: (lid, slot) => { closeLayoutPicker(); applyLayout(lid, { place: { tab: active, slot } }); },
      }))),
      splitOpen() ? h('button', { class: 'sp-off', onclick: () => { closeLayoutPicker(); closeSplit(); } }, 'Back to one editor (Ctrl+\\)') : null);
    document.body.append(pick);
    const r = btn.getBoundingClientRect();
    const pr = pick.getBoundingClientRect();
    pick.style.left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, r.left + r.width / 2 - pr.width / 2)) + 'px';
    pick.style.top = (r.bottom + 6) + 'px';
    pick.addEventListener('mouseenter', () => clearTimeout(pickerTimer));
    pick.addEventListener('mouseleave', () => { pickerTimer = setTimeout(closeLayoutPicker, 350); });
    setTimeout(() => document.addEventListener('mousedown', pickerAway, true), 0);
    document.addEventListener('keydown', pickerKey, true);
    return pick;
  }
  function pickerAway(e) { if (!e.target.closest('#snap-picker') && !e.target.closest('[data-act="split"]')) closeLayoutPicker(); }
  function pickerKey(e) { if (e.key === 'Escape' && $('#snap-picker')) { e.stopPropagation(); closeLayoutPicker(); } }
  function closeLayoutPicker() {
    clearTimeout(pickerTimer);
    const p = $('#snap-picker');
    if (p) p.remove();
    document.removeEventListener('mousedown', pickerAway, true);
    document.removeEventListener('keydown', pickerKey, true);
  }
  function wireLayoutButton() {
    const btn = $('#topbar [data-act="split"]');
    btn.title = 'Snap layouts: show files side by side (Ctrl+\\ for two side by side)';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.addEventListener('mouseenter', () => { clearTimeout(pickerTimer); pickerTimer = setTimeout(() => { if (!$('#snap-picker')) openLayoutPicker(); }, 450); });
    btn.addEventListener('mouseleave', () => { clearTimeout(pickerTimer); pickerTimer = setTimeout(() => { const p = $('#snap-picker'); if (p && !p.matches(':hover')) closeLayoutPicker(); }, 350); });
  }

  // While a tab is dragged over the editor: a snap bar with every layout at the top, and the
  // current zones as big targets ("show here").
  function wireSnapDrag() {
    const work = $('#work');
    const bar = $('#snapbar');
    const zoneUnder = (e) => {
      const zones = splitOpen() ? [{ slot: 'a', el: $('#editor') }, ...split.panes.map((p, i) => ({ slot: SLOTS[i + 1], el: p.el, pane: p }))] : null;
      if (zones) {
        for (const z of zones) { const r = z.el.getBoundingClientRect(); if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return Object.assign(z, { rect: r }); }
        return null;
      }
      // one editor: left half = show it here, right half = side by side
      const r = $('#editors').getBoundingClientRect();
      const right = e.clientX > r.left + r.width / 2;
      return { slot: right ? 'b' : 'a', rect: zoneRect('cols2', right ? 'b' : 'a'), beside: right };
    };
    work.addEventListener('dragenter', (e) => {
      if (!dragTab) return;
      if (bar.hidden) {
        bar.innerHTML = '';
        bar.append(h('div', { class: 'sb-title' }, 'Drop on a layout'), ...LAYOUT_ORDER.map((id) => layoutThumb(id, { dropTarget: true, current: split && split.layout === id })));
        bar.hidden = false;
      }
    });
    work.addEventListener('dragover', (e) => {
      if (!dragTab || e.target.closest('#snapbar')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const z = zoneUnder(e);
      if (!z) { hideSnapPreview(); return; }
      showSnapPreview(z.rect, z.slot === 'a' ? 'Show ' + dragTab.name + ' in the main editor' : z.beside ? 'Show ' + dragTab.name + ' side by side' : 'Show ' + dragTab.name + ' here');
    });
    work.addEventListener('dragleave', (e) => { if (!work.contains(e.relatedTarget)) { hideSnapPreview(); bar.hidden = true; } });
    work.addEventListener('drop', (e) => {
      if (!dragTab || e.target.closest('#snapbar')) return;
      e.preventDefault();
      e.stopPropagation();
      const t = dragTab;
      const z = zoneUnder(e);
      endTabDrag();
      if (!z) return;
      if (z.slot === 'a') { activate(t); return; }
      if (z.pane) setPaneTab(z.pane, t);
      else applyLayout(preferredLayout(2), { place: { tab: t, slot: 'b' }, fill: false });
    });
  }
  function endTabDrag() {
    hideSnapPreview();
    const bar = $('#snapbar');
    if (bar) bar.hidden = true;
    document.body.classList.remove('tab-dragging');
    dragTab = null;
    clearTabDropMarks();
  }
  window.addEventListener('resize', debounce(() => { if (splitOpen()) applyGrid(); }, 120));

  // first visible line -> timestamp of the entry it belongs to
  function entryTsAt(tab, line0) {
    const an = tab.an;
    if (!an || !an.entries.length) return null;
    let lo = 0, hi = an.entries.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (an.entries[mid].start <= line0) lo = mid; else hi = mid - 1; }
    for (let i = lo; i >= 0 && i > lo - 50; i--) if (an.entries[i].ts != null) return an.entries[i].ts;
    for (let i = lo; i < an.entries.length && i < lo + 50; i++) if (an.entries[i].ts != null) return an.entries[i].ts;
    return null;
  }
  function lineAtTs(tab, ts) {
    const an = tab.an;
    if (!an) return null;
    let best = null, bestD = Infinity;
    let lo = 0, hi = an.entries.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; const t = an.entries[mid].ts; if (t == null || t < ts) lo = mid + 1; else hi = mid; }
    for (let i = Math.max(0, lo - 30); i < Math.min(an.entries.length, lo + 30); i++) {
      const t = an.entries[i].ts;
      if (t == null) continue;
      if (an.vis && !an.vis[i]) continue; // land on an entry the filter shows
      const d = Math.abs(t - ts);
      if (d < bestD) { bestD = d; best = an.entries[i].start; }
    }
    return best;
  }
  // First line whose top half is on screen (a sliver of the line above does not count).
  function topFullLine(ed) {
    const ranges = ed.getVisibleRanges();
    if (!ranges.length) return 0;
    let line = ranges[0].startLineNumber;
    const lh = ed.getOption(monaco.editor.EditorOption.lineHeight);
    const max = ed.getModel() ? ed.getModel().getLineCount() : line;
    while (line < max && ed.getTopForLineNumber(line) < ed.getScrollTop() - lh / 2) line++;
    return line;
  }
  function syncScroll(src, force) {
    if (!splitOpen()) return;
    // ignore the scroll events we cause on the other editors (the one being scrolled always counts)
    const lock = split.locks.get(src);
    if (!force && lock && performance.now() < lock) return;
    const mode = effectiveSyncMode();
    if (mode === 'off') return;
    const srcTab = tabOfEditor(src);
    if (!srcTab) return;
    const top = topFullLine(src);
    if (!top) return;
    let ts = null;
    if (mode === 'time') {
      if (!srcTab.an) analyze(srcTab);
      ts = entryTsAt(srcTab, top - 1);
      if (ts == null) return;
    }
    for (const other of [editor, ...paneEditors()]) {
      if (other === src) continue;
      const dstTab = tabOfEditor(other);
      if (!dstTab) continue;
      let target = top;
      if (mode === 'time') {
        if (!dstTab.an) analyze(dstTab);
        const l0 = lineAtTs(dstTab, ts);
        if (l0 == null) continue;
        target = l0 + 1;
      }
      split.locks.set(other, performance.now() + 120);
      other.setScrollTop(other.getTopForLineNumber(Math.max(1, target)) - 2);
    }
  }
  // Ctrl+F in any pane searches every pane for the same text (same options).
  let mirroringFind = false;
  function wireFindMirror(ed) {
    const ctrl = ed.getContribution('editor.contrib.findController');
    if (!ctrl || !ctrl.getState) return;
    ctrl.getState().onFindReplaceStateChange((e) => {
      if (mirroringFind || !splitOpen()) return;
      if (!(e.searchString || e.isRegex || e.matchCase || e.wholeWord || e.isRevealed)) return;
      const st = ctrl.getState();
      mirroringFind = true;
      try {
        for (const other of [editor, ...paneEditors()]) {
          if (other === ed) continue;
          const oc = other.getContribution('editor.contrib.findController');
          if (!oc) continue;
          if (!st.isRevealed) { oc.closeFindWidget(); continue; }
          if (!oc.getState().isRevealed) oc.start({ forceRevealReplace: false, seedSearchStringFromSelection: 'none', seedSearchStringFromNonEmptySelection: false, seedSearchStringFromGlobalClipboard: false, shouldFocus: 0, shouldAnimate: false, updateSearchScope: false, loop: true });
          oc.getState().change({ searchString: st.searchString, isRegex: st.isRegex, matchCase: st.matchCase, wholeWord: st.wholeWord }, false);
        }
      } finally { mirroringFind = false; }
    });
  }
  // ======================================================================
  // CHANGED ON DISK: reload open files when another program changes them
  // ======================================================================
  // Every couple of seconds (and whenever the window gets focus) each open file is checked.
  //  - unchanged in the editor: the new text is loaded straight away (appended lines are just added,
  //    so the scroll position stays put, and the view follows the end if you were already there);
  //  - with unsaved edits: a notice asks whether to reload or keep your version;
  //  - web page opened through the browser's plain file dialog: the browser keeps a one-time copy and
  //    refuses to re-read it, so the notice offers to pick the file again.
  const BIG_TAB = 20 * 1024 * 1024;
  let watchBusy = false;
  async function checkDiskChanges() {
    if (watchBusy || !api.stat) return;
    watchBusy = true;
    try {
      for (const t of tabs.slice()) {
        if (!t.path || t.tailing || /^download:/.test(t.path) || !tabs.includes(t)) continue;
        const s = await api.stat(t.path);
        if (!tabs.includes(t)) continue;
        if (!s.ok) {
          if (s.reason === 'snapshot' && !t.disk) setDiskNote(t, 'snapshot');
          else if (s.reason === 'missing' && !t.disk) setDiskNote(t, 'missing');
          continue;
        }
        const prev = t.stamp;
        t.stamp = { size: s.size, mtime: s.mtime };
        if (!prev || (prev.size === s.size && prev.mtime === s.mtime)) { if (t.disk === 'missing') setDiskNote(t, null); continue; }
        if (isDirty(t)) setDiskNote(t, 'conflict');
        else await reloadFromDisk(t, prev);
      }
    } finally { watchBusy = false; }
  }

  async function reloadFromDisk(t, prev) {
    const oldLen = t.model.getValueLength();
    // Big log that only grew: read just the new bytes.
    if (prev && api.readFrom && s_grew(prev, t.stamp) && oldLen > BIG_TAB) {
      const r = await api.readFrom(t.path, prev.size);
      if (!r.error) { applyDiskText(t, r.content, true); return; }
    }
    const r = await api.readFile(t.path);
    if (r.error || typeof r.content !== 'string') return;
    const old = t.model.getValue();
    if (r.content === old) return;
    if (r.content.length > old.length && r.content.startsWith(old)) applyDiskText(t, r.content.slice(old.length), true);
    else applyDiskText(t, r.content, false);
  }
  const s_grew = (a, b) => b.size > a.size;

  function applyDiskText(t, text, append) {
    if (!text && append) return;
    const isActive = t === active;
    const atEnd = isActive && editor.getVisibleRanges().some((r) => r.endLineNumber >= t.model.getLineCount() - 1);
    const view = isActive ? editor.saveViewState() : null;
    t.model.pushStackElement(); // each reload is its own Ctrl+Z step
    if (append) {
      const last = t.model.getLineCount();
      const col = t.model.getLineMaxColumn(last);
      t.model.pushEditOperations([], [{ range: new monaco.Range(last, col, last, col), text }], () => null);
    } else {
      t.model.pushEditOperations([], [{ range: t.model.getFullModelRange(), text }], () => null);
    }
    t.model.pushStackElement();
    t.savedVersion = t.model.getAlternativeVersionId();
    t.forceDirty = false;
    setDiskNote(t, null);
    if (isActive) {
      if (view) editor.restoreViewState(view);
      if (atEnd && append) editor.revealLine(t.model.getLineCount());
    }
    renderTabs();
    updateStatus();
    if (!append) toast('Reloaded ' + t.name + ' — it changed on disk. Ctrl+Z brings back the previous text.', 3500);
  }

  // The notice for the active tab, shown at the top of the editor.
  function setDiskNote(t, kind) {
    t.disk = kind || null;
    if (t === active) renderDiskNote();
  }
  function renderDiskNote() {
    const bar = $('#diskbar');
    if (!bar) return;
    const t = active;
    if (!t || !t.disk) { bar.hidden = true; return; }
    bar.innerHTML = '';
    const btn = (label, fn, primary) => h('button', { class: primary ? 'primary' : '', onclick: fn }, label);
    const dismiss = () => { t.disk = 'dismissed'; bar.hidden = true; };
    if (t.disk === 'dismissed') { bar.hidden = true; return; }
    if (t.disk === 'conflict') {
      bar.append(h('span', null, t.name + ' changed on disk, and you have unsaved changes here.'),
        btn('Reload from disk', async () => { t.forceDirty = false; t.savedVersion = t.model.getAlternativeVersionId(); await reloadFromDisk(t, null); }, true),
        btn('Keep my version', dismiss));
    } else if (t.disk === 'snapshot') {
      bar.append(h('span', null, t.name + ' changed on disk. This browser page can only read the copy you picked, so pick the file again to load the new version.'),
        btn('Pick file again', async () => {
          const r = await api.repick(t.path);
          if (r.canceled) return;
          if (r.error) { toast('Could not read the file: ' + r.error, 6000); return; }
          t.stamp = null;
          if (r.content !== t.model.getValue()) {
            const old = t.model.getValue();
            if (!isDirty(t) && r.content.startsWith(old)) applyDiskText(t, r.content.slice(old.length), true);
            else applyDiskText(t, r.content, false);
          }
          setDiskNote(t, null);
        }, true),
        btn('Dismiss', dismiss));
    } else if (t.disk === 'missing') {
      bar.append(h('span', null, t.name + ' was moved or deleted on disk. Save to write it back.'), btn('Dismiss', dismiss));
    }
    bar.hidden = false;
  }

  function startDiskWatch() {
    setInterval(() => { if (!document.hidden) checkDiskChanges(); }, 2000);
    window.addEventListener('focus', () => checkDiskChanges());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkDiskChanges(); });
  }

  // ======================================================================
  // BOTTOM PANEL (table view, find in tabs, extract results)
  // ======================================================================
  // ---------- panel size: drag the top edge, double-click to reset, maximise button ----------
  const PANEL_DEFAULT = () => (window.innerWidth <= 760 ? Math.round(window.innerHeight * 0.45) : 300);
  function panelLimits() {
    const body = $('#body').getBoundingClientRect();
    return { min: 120, max: Math.max(160, Math.round(body.height - 90)) };
  }
  function setPanelHeight(px, save = true) {
    const { min, max } = panelLimits();
    const hgt = Math.round(Math.max(min, Math.min(max, px)));
    $('#panel').style.height = hgt + 'px';
    $('#panel').classList.toggle('maxed', hgt >= max - 2);
    if (save) { settings.panelH = hgt; saveSettings(); }
    // (0.15.1) the Copilot button no longer rides on top of the panel: it stays in the bottom-right corner
    if (editor) editor.layout();
    return hgt;
  }
  function togglePanelMax() {
    const p = $('#panel');
    if (p.hidden) return;
    const { max } = panelLimits();
    if (p.classList.contains('maxed')) setPanelHeight(settings.panelRestoreH || PANEL_DEFAULT());
    else { settings.panelRestoreH = p.offsetHeight; setPanelHeight(max); }
  }
  function wirePanelResize() {
    const g = $('#panel-grip');
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      const startY = e.clientY, startH = $('#panel').offsetHeight;
      document.body.classList.add('panel-resizing');
      const move = (ev) => setPanelHeight(startH + (startY - ev.clientY), false);
      const up = () => {
        g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up);
        document.body.classList.remove('panel-resizing');
        setPanelHeight($('#panel').offsetHeight);
      };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up);
    });
    g.addEventListener('dblclick', () => setPanelHeight(PANEL_DEFAULT()));
    g.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setPanelHeight($('#panel').offsetHeight + (e.key === 'ArrowUp' ? 30 : -30)); }
    });
    $('#panel-max').onclick = togglePanelMax;
    window.addEventListener('resize', debounce(() => { if (!$('#panel').hidden) setPanelHeight($('#panel').offsetHeight, false); }, 150));
  }

  function exitPanelFullscreen() { if (isFullscreen($('#panel'))) exitFullscreen(); }
  // Results tabs (0.14.0): one tab per kind of result (extract / auto tables, table view, find in tabs).
  // A tab keeps its own toolbar and content, so switching back shows it exactly as it was.
  let panelTabs = [];
  let panelCur = null;
  const PANEL_KIND = { extract: 'Results', table: 'Table view', search: 'Find in tabs' };
  function stashPanel() {
    if (!panelCur) return;
    panelCur.tools = Array.from($('#panel-tools').childNodes);
    panelCur.body = Array.from($('#panel-body').childNodes);
    panelCur.bodyClass = $('#panel-body').className;
    panelCur.scroll = $('#panel-body').scrollTop;
    $('#panel-tools').replaceChildren();
    $('#panel-body').replaceChildren();
  }
  function showPanelTab(t) {
    if (!t || t === panelCur) return;
    stashPanel();
    panelCur = t;
    panelMode = t.mode;
    $('#panel-tools').replaceChildren(...(t.tools || []));
    $('#panel-body').replaceChildren(...(t.body || []));
    $('#panel-body').className = t.bodyClass || '';
    $('#panel-body').scrollTop = t.scroll || 0;
    $('#panel-title').textContent = t.title;
    renderPanelTabs();
  }
  function closePanelTab(t) {
    const i = panelTabs.indexOf(t);
    if (i < 0) return;
    panelTabs.splice(i, 1);
    if (t !== panelCur) { renderPanelTabs(); return; }
    panelCur = null;
    $('#panel-tools').replaceChildren();
    $('#panel-body').replaceChildren();
    if (!panelTabs.length) { closePanel(); return; }
    showPanelTab(panelTabs[Math.min(i, panelTabs.length - 1)]);
  }
  function renderPanelTabs() {
    const box = $('#panel-tabs');
    const many = panelTabs.length > 1;
    box.hidden = !many;
    $('#panel-title').hidden = many;
    box.replaceChildren(...panelTabs.map((t) => h('div', { class: 'ptab' + (t === panelCur ? ' on' : ''), role: 'tab', 'aria-selected': t === panelCur ? 'true' : 'false', title: t.title },
      h('button', { class: 'ptab-name', onclick: () => showPanelTab(t) }, h('span', { class: 'ptab-kind' }, PANEL_KIND[t.mode] || t.mode), h('span', { class: 'ptab-title' }, t.title)),
      h('button', { class: 'ptab-x', title: 'Close this result', 'aria-label': 'Close ' + (PANEL_KIND[t.mode] || t.mode), onclick: () => closePanelTab(t) }, '×'))));
  }
  function openPanel(mode, title) {
    const wasHidden = $('#panel').hidden;
    if (wasHidden) { panelTabs = []; panelCur = null; }
    stashPanel();
    let t = panelTabs.find((x) => x.mode === mode);
    if (!t) { t = { mode }; panelTabs.push(t); }
    t.title = title;
    panelCur = t;
    panelMode = mode;
    $('#panel').hidden = false;
    if (wasHidden) setPanelHeight(settings.panelH || PANEL_DEFAULT(), false);
    $('#panel-title').textContent = title;
    $('#panel-tools').innerHTML = '';
    $('#panel-body').innerHTML = '';
    $('#panel-body').className = '';
    renderPanelTabs();
    editor.layout();
  }
  function closePanel() {
    exitPanelFullscreen();
    $('#panel').hidden = true;
    $('#cp-fab').style.bottom = '';
    panelMode = null;
    panelTabs = [];
    panelCur = null;
    editor.layout();
    editor.focus();
  }
  const panelButton = (label, onClick, title) => { const b = h('button', { onclick: onClick, title }, label); $('#panel-tools').append(b); return b; };

  function openTableView() {
    const sel = editor.getSelection();
    const useSel = sel && !sel.isEmpty();
    const range = useSel ? sel : active.model.getFullModelRange();
    const rows = Tables.parseTableText(active.model.getValueInRange(range));
    openPanel('table', 'Table view of ' + (useSel ? 'selection' : 'whole tab'));
    const body = $('#panel-body');
    if (!rows) {
      body.innerHTML = '<div class="msg">No table found. Select lines that contain a table (Markdown, grid, tab-separated, CSV or columns separated by two or more spaces) and press Ctrl+Shift+T again.</div>';
      return;
    }
    tableState = { range, rows };
    const table = h('table', { class: 'grid' });
    body.append(table);
    const renderGrid = () => {
      table.innerHTML = '';
      tableState.rows.forEach((r, i) => {
        const tr = h('tr');
        r.forEach((c) => tr.append(h(i === 0 ? 'th' : 'td', { contentEditable: 'true', spellcheck: false, style: 'cursor:text' }, c)));
        table.append(tr);
      });
    };
    const readGrid = () => Array.from(table.rows).map((tr) => Array.from(tr.cells).map((c) => c.innerText.replace(/\s+/g, ' ').trim()));
    renderGrid();
    const fmt = h('select', null, Tables.FORMATS.map((f) => h('option', { value: f, selected: f === settings.pasteFormat }, f === 'aligned' ? 'aligned columns' : f)));
    $('#panel-tools').append(fmt);
    panelButton('Copy as table', async () => { const r = readGrid(); await api.clipboardWrite({ text: Tables.formatRows(r, 'tsv'), html: Tables.rowsToHtml(r) }); toast('Copied. Paste into Word, Outlook or Excel to get a real table.'); });
    panelButton('Copy as text', async () => { await api.clipboardWrite({ text: Tables.formatRows(readGrid(), fmt.value) }); toast('Copied as ' + fmt.value); });
    panelButton('Write back to editor', () => {
      const text = Tables.formatRows(readGrid(), fmt.value);
      editor.pushUndoStop();
      editor.executeEdits('table-view', [{ range: tableState.range, text }]);
      editor.pushUndoStop();
      toast('Table written back as ' + fmt.value);
      closePanel();
    });
    panelButton('Add row', () => { tableState.rows = readGrid(); tableState.rows.push(tableState.rows[0].map(() => '')); renderGrid(); });
    panelButton('Add column', () => { tableState.rows = readGrid().map((r) => r.concat([''])); renderGrid(); });
    // Column fixes for guessed tables: act on the column of the last clicked cell.
    let col = 0;
    table.addEventListener('focusin', (e) => { const c = e.target.closest('td,th'); if (c) col = c.cellIndex; });
    panelButton('Merge column with next', () => {
      const rows = readGrid();
      if (col >= rows[0].length - 1) { toast('Click a cell in a column that has a column to its right.'); return; }
      tableState.rows = rows.map((r) => r.slice(0, col).concat([(r[col] + ' ' + r[col + 1]).trim()], r.slice(col + 2)));
      renderGrid();
    }, 'Joins the clicked column with the one to its right');
    panelButton('Split column', () => {
      const rows = readGrid();
      tableState.rows = rows.map((r) => {
        const v = r[col] || '';
        const i = v.lastIndexOf(' ');
        return r.slice(0, col).concat(i > 0 ? [v.slice(0, i), v.slice(i + 1)] : [v, ''], r.slice(col + 1));
      });
      renderGrid();
    }, 'Splits the clicked column at its last space');
    let sortAsc = true;
    panelButton('Sort by column', () => {
      const rows = readGrid();
      const head = rows[0];
      const body = rows.slice(1);
      const num = body.every((r) => { const v = (r[col] || '').replace(/[,₹$%]/g, ''); return v === '' || !Number.isNaN(Number(v)); });
      body.sort((a, b) => {
        const x = a[col] || ''; const y = b[col] || '';
        const c = num ? (Number(x.replace(/[,₹$%]/g, '')) || 0) - (Number(y.replace(/[,₹$%]/g, '')) || 0) : x.localeCompare(y, undefined, { numeric: true });
        return sortAsc ? c : -c;
      });
      tableState.rows = [head].concat(body);
      toast('Sorted by ' + (head[col] || 'column ' + (col + 1)) + (sortAsc ? ', ascending' : ', descending') + '. Click again to reverse.', 2500);
      sortAsc = !sortAsc;
      renderGrid();
    }, 'Sorts rows by the clicked column; click again to reverse');
    panelButton('Delete column', () => {
      const rows = readGrid();
      if (rows[0].length < 2) return;
      tableState.rows = rows.map((r) => r.slice(0, col).concat(r.slice(col + 1)));
      col = Math.max(0, col - 1);
      renderGrid();
    });
  }

  function openSearch() {
    openPanel('search', 'Find in open tabs');
    const input = h('input', { type: 'text', placeholder: 'Search text', style: 'width:240px' });
    const mk = (label) => { const c = h('input', { type: 'checkbox' }); $('#panel-tools').append(h('label', { class: 'check', style: 'margin:0' }, c, label)); return c; };
    $('#panel-tools').append(input);
    const cRegex = mk('Regex');
    const cCase = mk('Match case');
    const cWord = mk('Whole word');
    panelButton('Find all', run);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    const sel = editor.getSelection();
    if (sel && !sel.isEmpty() && sel.startLineNumber === sel.endLineNumber) input.value = active.model.getValueInRange(sel);
    input.focus();
    input.select();
    if (input.value) run();
    function run() {
      const q = input.value;
      const body = $('#panel-body');
      body.innerHTML = '';
      if (!q) return;
      const wordSep = cWord.checked ? editor.getOption(monaco.editor.EditorOption.wordSeparators) : null;
      let total = 0;
      try {
        for (const t of tabs) {
          const matches = t.model.findMatches(q, true, cRegex.checked, cCase.checked, wordSep, false, 2000);
          if (!matches.length) continue;
          total += matches.length;
          body.append(h('div', { class: 'result-file' }, t.name + '  (' + matches.length + ')'));
          for (const m of matches.slice(0, 500)) {
            body.append(h('div', { class: 'result', onclick: () => { activate(t); editor.setSelection(m.range); editor.revealRangeInCenter(m.range); editor.focus(); } },
              h('span', { class: 'ln' }, 'Ln ' + m.range.startLineNumber), t.model.getLineContent(m.range.startLineNumber).trim().slice(0, 240)));
          }
        }
      } catch (err) {
        body.innerHTML = '<div class="msg">Invalid search: ' + esc(err.message) + '</div>';
        return;
      }
      body.prepend(h('div', { class: 'msg' }, total ? total + ' match' + (total === 1 ? '' : 'es') + ' across open tabs' : 'No matches in any open tab.'));
    }
  }

  // ======================================================================
  // COMMAND PALETTE
  // ======================================================================
  function commands() {
    const log = active && isLogTab(active);
    const list = [
      ['New tab', 'File', 'Ctrl+N', actions.new],
      ['Open file', 'File', 'Ctrl+O', actions.open],
      ['Save', 'File', 'Ctrl+S', actions.save],
      ['Save as', 'File', 'Ctrl+Shift+S', actions.saveAs],
      ['Close tab', 'File', 'Ctrl+W', actions.close],
      ['Open files: list every open file', 'View', 'Ctrl+Shift+E', () => showView('files', { toggle: false })],
      ['Log insights: filters, levels, repeated errors', 'Logs', 'Ctrl+1', () => showView('insights', { toggle: false })],
      ['Auto tables: build tables from this log', 'Logs', '', () => { extractState.preset = 'auto'; if (currentView === 'extract') renderExtract(); return runAutoTables(); }],
      ['Extract data from log to a table', 'Logs', 'Ctrl+2', () => showView('extract', { toggle: false })],
      ['Highlight rules and your packages', 'Logs', 'Ctrl+3', () => showView('highlight', { toggle: false })],
      [log ? 'Treat tab as plain text' : 'Treat tab as a log', 'Logs', '', () => { if (log) { monaco.editor.setModelLanguage(active.model, 'plaintext'); active.detectDone = true; scheduleAnalysis(active); renderTabs(); if (currentView === 'insights') renderInsights(); } else { treatAsLog(active); if (currentView === 'insights') renderInsights(); } }],
      ['Show only errors', 'Logs', '', () => setFilter({ levels: new Set(['ERROR']) })],
      ['Show errors and warnings', 'Logs', '', () => setFilter({ levels: new Set(['ERROR', 'WARN']) })],
      ['Clear log filter', 'Logs', '', clearFilter],
      ['Fold all stack traces', 'Logs', '', () => editor.trigger('tf', 'editor.foldAll')],
      ['Unfold everything', 'Logs', '', () => editor.trigger('tf', 'editor.unfoldAll')],
      ['Next error', 'Logs', 'F8', () => jumpError(1)],
      ['Previous error', 'Logs', 'Shift+F8', () => jumpError(-1)],
      ['Mask secrets into a new tab', 'Logs', '', maskToNewTab],
      ['Find duplicate lines and repeated entries', 'Logs', '', findDuplicates],
      ['Copy shown entries (what the filter shows)', 'Logs', '', copyShown],
      ['Compare with another tab (side-by-side diff)', 'Edit', '', pickCompare],
      ['Investigate logs together (incident: one clock for several logs)', 'Logs', 'Alt+I', pickIncident],
      ['Try the incident sample (4 services)', 'Help', '', openIncidentSample],
      ...(incident && !$('#incident') ? [['Back to the incident', 'Logs', '', reopenIncident]] : []),
      ['Extract timestamps', 'Logs', '', () => extractPreset('timestamps')],
      ['Extract IP addresses', 'Logs', '', () => extractPreset('ips')],
      ['Merge open logs by time', 'Logs', '', mergeOpenLogs],
      ['Follow file (live tail)', 'Logs', '', toggleFollow],
      ['Copilot: explain this error', 'Copilot', '', () => askCopilot('explain')],
      ['Copilot: find root cause', 'Copilot', '', () => askCopilot('rootcause')],
      ['Copilot: summarize log', 'Copilot', '', () => askCopilot('summarize')],
      ['Copilot: suggest a fix', 'Copilot', '', () => askCopilot('fix')],
      ['Copilot: ask about selection', 'Copilot', '', () => askCopilot('custom')],
      ['Open Copilot panel', 'Copilot', 'Ctrl+4', () => openCopilot({ toggle: false })],
      ['Copilot: dock to the side / float', 'Copilot', '', () => { settings.cpDock = !settings.cpDock; saveSettings(); if (!copilotOpen()) openCopilot({ toggle: false }); else applyCopilotLayout(); }],
      ['Find in all open tabs', 'Search', 'Ctrl+Shift+F', openSearch],
      ['Filter the log (query bar)', 'Search', 'Ctrl+K', focusQueryBar],
      [(settings.selBar === false ? 'Show' : 'Hide') + ' the toolbar on selected text', 'View', '', () => {
        settings.selBar = settings.selBar === false; saveSettings();
        if (selBar) { if (settings.selBar) selBar.show(); else selBar.hide(); }
        toast(settings.selBar ? 'Selecting text now shows a small toolbar above it.' : 'The toolbar on selected text is off. Turn it back on from the command palette.', 4000);
      }],
      ['Table view of selection', 'Tables', 'Ctrl+Shift+T', openTableView],
      ['Convert selection to table', 'Tables', '', convertToTable],
      ['Toggle preview (rendered Markdown and tables)', 'View', 'Alt+P', () => setPreview(!(active && active.preview))],
      ['Copy as rich text (for Teams / Outlook)', 'Edit', '', copyRichText],
      ['Select all', 'Edit', 'Ctrl+A', selectAll],
      ['Pretty-print JSON', 'Edit', '', prettyJson],
      ['Editor commands (sort lines, change case, …)', 'Edit', 'F1', () => { editor.focus(); editor.trigger('tf', 'editor.action.quickCommand'); }],
      ['Toggle word wrap', 'View', 'Alt+Z', actions.wrap],
      [splitOpen() ? 'Close split view' : 'Split view: show another tab beside this one', 'View', 'Ctrl+\\', toggleSplit],
      ...LAYOUT_ORDER.map((id) => ['Snap layout: ' + LAYOUTS[id].label.toLowerCase(), 'View', '', () => applyLayout(id)]),
      ...(splitOpen() ? [['Split view: add another file', 'View', '', () => addSplitPane()], ['Split view: swap the first pane with the main editor', 'View', '', swapSplit]] : []),
      ['Preview in full screen', 'View', 'Alt+Shift+P', () => (active && active.preview ? enterFullscreen($('#preview'), { label: 'The preview' }) : setPreview(true, { full: true }))],
      ...(fsEl ? [['Exit full screen', 'View', 'Esc', exitFullscreen]] : []),
      ['Rename tab', 'File', 'double-click a tab', () => active && startRename(active)],
      ['Toggle sidebar', 'View', 'Ctrl+B', () => (currentView ? hideSide() : showView(settings.view || 'insights', { toggle: false }))],
      ['Appearance and settings', 'View', 'Ctrl+,', () => showView('appearance', { toggle: false })],
      ['Keyboard shortcuts', 'Help', '', showHelp],
    ];
    for (const [id, t] of Object.entries(THEMES)) list.push(['Theme: ' + t.label, 'View', '', () => { settings.theme = id; saveSettings(); applyTheme(); if (currentView === 'appearance') renderAppearance(); }]);
    const webKey = (key) => (!IS_WEB ? key : ({ 'Ctrl+N': 'Alt+N', 'Ctrl+W': 'Alt+W', 'Ctrl+Shift+T': 'Alt+T' }[key] || key.replace(/^Ctrl\+([1-4])$/, 'Alt+$1')));
    return list.map(([label, cat, key, run]) => ({ label, cat, key: webKey(key), run }));
  }

  function fuzzy(q, s) {
    const t = s.toLowerCase();
    q = q.toLowerCase().trim();
    if (!q) return { score: 0, idx: [] };
    const i = t.indexOf(q);
    if (i >= 0) return { score: 1000 - i, idx: Array.from({ length: q.length }, (_, k) => i + k) };
    const idx = [];
    let j = 0;
    for (let k = 0; k < t.length && j < q.length; k++) if (t[k] === q[j]) { idx.push(k); j++; }
    return j === q.length ? { score: 100 - (idx[idx.length - 1] - idx[0]), idx } : null;
  }

  function openPalette(initial) {
    const pal = $('#palette');
    const input = $('#palette-input');
    const list = $('#palette-list');
    const all = commands();
    let items = all;
    let sel = 0;
    const draw = () => {
      list.innerHTML = '';
      items.forEach((c, i) => {
        const set = new Set(c.m ? c.m.idx : []);
        const lbl = h('span', { class: 'lbl' });
        lbl.innerHTML = Array.from(c.label).map((ch, k) => (set.has(k) ? '<mark>' + esc(ch) + '</mark>' : esc(ch))).join('');
        list.append(h('div', { class: 'pal-item' + (i === sel ? ' sel' : ''), role: 'option', onmousemove: () => { if (sel !== i) { sel = i; draw(); } }, onclick: () => run(i) },
          lbl, h('span', { class: 'cat' }, c.cat), c.key ? h('kbd', null, c.key) : null));
      });
      const s = list.children[sel];
      if (s) s.scrollIntoView({ block: 'nearest' });
    };
    const filter = () => {
      const q = input.value;
      items = all.map((c) => Object.assign({}, c, { m: fuzzy(q, c.label + ' ' + c.cat) })).filter((c) => c.m).sort((a, b) => b.m.score - a.m.score);
      if (!q) items = all.map((c) => Object.assign({}, c, { m: null }));
      sel = 0;
      draw();
    };
    const close = () => { pal.hidden = true; input.oninput = input.onkeydown = null; pal.onmousedown = null; };
    const run = (i) => { const c = items[i]; close(); if (c) setTimeout(() => c.run(), 0); else editor.focus(); };
    input.value = typeof initial === 'string' ? initial : '';
    input.oninput = filter;
    input.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
      else if (e.key === 'Enter') { run(sel); e.preventDefault(); }
      else if (e.key === 'Escape') { close(); editor.focus(); e.preventDefault(); }
    };
    pal.onmousedown = (e) => { if (e.target === pal) { close(); editor.focus(); } };
    pal.hidden = false;
    filter();
    input.focus();
  }

  // ======================================================================
  // MISC ACTIONS
  // ======================================================================
  function jumpError(dir) {
    if (!active || !isLogTab(active)) return;
    const an = analyze(active);
    const cur = (editor.getPosition() || { lineNumber: 1 }).lineNumber - 1;
    const errs = an.entries.map((e, i) => i).filter((i) => an.entries[i].level === 'ERROR' && (!an.vis || an.vis[i]));
    if (!errs.length) { toast('No errors in this log.'); return; }
    let target = dir > 0 ? errs.find((i) => an.entries[i].start > cur) : errs.slice().reverse().find((i) => an.entries[i].start < cur);
    if (target === undefined) target = dir > 0 ? errs[0] : errs[errs.length - 1];
    revealEntry(target);
  }

  function prettyJson() {
    const sel = editor.getSelection();
    const range = sel && !sel.isEmpty() ? sel : active.model.getFullModelRange();
    try {
      const out = JSON.stringify(JSON.parse(active.model.getValueInRange(range)), null, 2);
      editor.pushUndoStop();
      editor.executeEdits('json', [{ range, text: out }]);
      editor.pushUndoStop();
      if (range === sel) return;
      monaco.editor.setModelLanguage(active.model, 'json');
    } catch (e) {
      toast('Not valid JSON: ' + e.message, 5000);
    }
  }

  function tokenAtCursor() {
    const sel = editor.getSelection();
    if (sel && !sel.isEmpty()) return active.model.getValueInRange(sel).trim();
    const pos = editor.getPosition();
    const line = active.model.getLineContent(pos.lineNumber);
    let s = pos.column - 1;
    let e = s;
    const ok = (c) => /[\w.\-:]/.test(c);
    while (s > 0 && ok(line[s - 1])) s--;
    while (e < line.length && ok(line[e])) e++;
    let tok = line.slice(s, e).replace(/^[:.]+|[:.]+$/g, '');
    const kv = /^[\w.-]+[=:](.+)$/.exec(tok);
    if (kv) tok = kv[1];
    return tok;
  }

  function showHelp() {
    const rows = IS_WEB ? [
      ['Ctrl+Shift+P', 'Search all commands'], ['Ctrl+K', 'Filter the log (query bar)'], ['Alt+N', 'New tab'], ['Ctrl+O / Ctrl+S', 'Open, save'], ['Alt+W', 'Close tab'],
      ['Alt+1 / 2 / 3 / 4', 'Log insights, extract, highlights, Copilot'], ['Ctrl+B', 'Show or hide the sidebar'],
      ['Alt+T', 'Table view of selection'], ['Alt+P', 'Preview: rendered Markdown and tables'],
    ] : [
      ['Ctrl+Shift+P', 'Search all commands'], ['Ctrl+N / O / S', 'New, open, save'], ['Ctrl+W', 'Close tab'], ['Ctrl+Tab', 'Next tab'],
      ['Ctrl+1 / 2 / 3 / 4', 'Log insights, extract, highlights, Copilot'], ['Ctrl+B', 'Show or hide the sidebar'],
      ['F8 / Shift+F8', 'Next or previous error'], ['Right-click an ID', 'Show only entries with that ID'],
      ['Ctrl+F / Ctrl+H', 'Find or replace (regex supported)'], ['Ctrl+Shift+F', 'Find in all open tabs'],
      ['Ctrl+Shift+T', 'Table view of selection'], ['Alt+P', 'Preview: rendered Markdown and tables'], ['Ctrl+Shift+V', 'Paste as plain text'],
      ['Alt+Shift+drag', 'Column selection'], ['Alt+click', 'Add a cursor'], ['Ctrl+D', 'Select next occurrence'],
      ['Ctrl+K', 'Filter the log (query bar); > runs a command'], ['Alt+Z', 'Word wrap'], ['Ctrl+= / - / 0', 'Zoom'], ['F1', 'Editor commands (sort, case, …)'],
    ];
    modal('Keyboard shortcuts', '<table>' + rows.map((r) => `<tr><td><kbd>${esc(r[0])}</kbd></td><td>${esc(r[1])}</td></tr>`).join('') + '</table>' +
      (APP_VERSION ? '<p class="hint tf-version" style="margin:14px 0 0">TextForge ' + esc(APP_VERSION) + '</p>' : ''), [{ label: 'Close', value: true, primary: true }]);
  }

  const actions = {
    new: () => activate(newTab({})),
    open: openFiles,
    save: () => { const t = focusedTab(); return t && saveTab(t); },
    saveAs: () => { const t = focusedTab(); return t && saveTab(t, true); },
    split: () => { const p = $('#snap-picker') || openLayoutPicker(); const z = p.querySelector('.snap-thumb.current .snap-zone, .snap-zone'); if (z) z.focus(); },
    close: () => active && closeTab(active),
    palette: openPalette,
    help: showHelp,
    wrap: () => { settings.wrap = !settings.wrap; saveSettings(); applyEditorOptions(); },
  };

  function cycleTab(dir) {
    if (tabs.length < 2) return;
    activate(tabs[(tabs.indexOf(active) + dir + tabs.length) % tabs.length]);
  }

  function onKeyDown(e) {
    if (!$('#modal').hidden || !$('#palette').hidden) return;
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    // Ctrl+1..4 on desktop; Alt+1..4 everywhere (browsers reserve Ctrl+digits for switching tabs)
    const alt = !e.shiftKey && ((ctrl && !e.altKey) || (e.altKey && !ctrl));
    if (ctrl && e.shiftKey && k === 'v') { plainNext = true; setTimeout(() => { plainNext = false; }, 600); return; }
    // Ctrl+A anywhere outside a text field selects the editor's text (not the app's buttons and labels).
    if (ctrl && !e.shiftKey && !e.altKey && k === 'a') {
      const t = e.target;
      const typing = t && (t.closest && t.closest('#editor') || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
      if (!typing) { e.preventDefault(); e.stopPropagation(); selectAll(); }
      return;
    }
    let handled = true;
    if (ctrl && e.shiftKey && k === 'p') openPalette();
    else if (ctrl && !e.shiftKey && !e.altKey && k === 'k') focusQueryBar();
    else if (ctrl && !e.shiftKey && !e.altKey && k === 'n') actions.new();
    else if (ctrl && !e.shiftKey && k === 'o') actions.open();
    else if (ctrl && !e.shiftKey && k === 's') actions.save();
    else if (ctrl && e.shiftKey && k === 's') actions.saveAs();
    else if (ctrl && !e.shiftKey && k === 'w') actions.close();
    else if (ctrl && e.shiftKey && k === 'f') openSearch();
    else if (ctrl && e.shiftKey && k === 't') openTableView();
    else if (ctrl && e.shiftKey && (k === 'e' || k === 'E')) showView('files');
    else if (alt && (k === '1' || e.code === 'Digit1')) showView('insights');
    else if (alt && (k === '2' || e.code === 'Digit2')) showView('extract');
    else if (alt && (k === '3' || e.code === 'Digit3')) showView('highlight');
    else if (alt && (k === '4' || e.code === 'Digit4')) openCopilot();
    else if (e.altKey && !ctrl && !e.shiftKey && e.code === 'KeyN') actions.new();
    else if (e.altKey && !ctrl && !e.shiftKey && e.code === 'KeyW') actions.close();
    else if (e.altKey && !ctrl && !e.shiftKey && e.code === 'KeyT') openTableView();
    else if (e.altKey && !ctrl && !e.shiftKey && e.code === 'KeyI') { if (incident && !$('#incident')) reopenIncident(); else pickIncident(); }
    else if (e.altKey && !ctrl && !e.shiftKey && e.code === 'KeyP') setPreview(!(active && active.preview));
    else if (e.altKey && !ctrl && e.shiftKey && e.code === 'KeyP') {
      if (isFullscreen($('#preview'))) exitFullscreen();
      else if (active && active.preview) enterFullscreen($('#preview'), { label: 'The preview' });
      else setPreview(true, { full: true });
    }
    else if (ctrl && !e.shiftKey && k === ',') showView('appearance');
    else if (ctrl && !e.shiftKey && (k === '\\' || e.code === 'Backslash')) toggleSplit();
    else if (ctrl && e.shiftKey && (k === 'm' || k === 'M')) togglePanelMax();
    else if (ctrl && !e.shiftKey && k === 'b') { if (currentView) hideSide(); else showView(settings.view || 'insights'); }
    else if (ctrl && k === 'tab') cycleTab(e.shiftKey ? -1 : 1);
    else if (e.key === 'F8' && active && isLogTab(active)) jumpError(e.shiftKey ? -1 : 1);
    else if (e.altKey && !ctrl && k === 'z') actions.wrap();
    else if (ctrl && !e.shiftKey && (k === '=' || k === '+')) { settings.fontSize = Math.min(32, settings.fontSize + 1); saveSettings(); applyEditorOptions(); }
    else if (ctrl && !e.shiftKey && k === '-') { settings.fontSize = Math.max(9, settings.fontSize - 1); saveSettings(); applyEditorOptions(); }
    else if (ctrl && !e.shiftKey && k === '0') { settings.fontSize = defaults.fontSize; saveSettings(); applyEditorOptions(); }
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  function wireSideResize() {
    const handle = $('#side-resize');
    const side = $('#side');
    handle.title = 'Drag to resize. Double-click to reset.';
    handle.addEventListener('dblclick', () => { side.style.removeProperty('--side-w'); delete settings.sideWidth; saveSettings(); if (editor) editor.layout(); });
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      handle.classList.add('drag');
      const startX = e.clientX;
      const startW = side.getBoundingClientRect().width;
      const mm = (ev) => { side.style.setProperty('--side-w', Math.max(260, Math.min(window.innerWidth * 0.7, startW + ev.clientX - startX)) + 'px'); editor.layout(); };
      const mu = () => {
        handle.classList.remove('drag');
        window.removeEventListener('mousemove', mm);
        window.removeEventListener('mouseup', mu);
        if (currentView !== 'copilot') { settings.sideWidth = Math.round(side.getBoundingClientRect().width); saveSettings(); }
      };
      window.addEventListener('mousemove', mm);
      window.addEventListener('mouseup', mu);
    });
  }

  // ======================================================================
  // INIT
  // ======================================================================
  async function init() {
    registerLogLanguage();
    langList = monaco.languages.getLanguages();
    if (IS_WEB) {
      document.body.classList.add('is-web');
      $$('[title]').forEach((el) => {
        el.title = el.title.replace(/Ctrl\+([1-4])\)/, 'Alt+$1)').replace('New tab (Ctrl+N)', 'New tab (Alt+N)');
      });
    }
    applyTheme();
    updateRuleStyles();

    editor = monaco.editor.create($('#editor'), {
      // Monaco's large-file mode (over 300k lines or 20 MB) ignores hidden areas, which would make the log
      // filter show everything. Tokenizing is lazy (only what is on screen), so big logs stay fast without it.
      largeFileOptimizations: false,
      model: null, theme: 'tf', automaticLayout: true, multiCursorModifier: 'alt', mouseWheelZoom: true, smoothScrolling: true,
      scrollBeyondLastLine: false, bracketPairColorization: { enabled: true }, unicodeHighlight: { ambiguousCharacters: false },
      folding: true, showFoldingControls: 'always', padding: { top: 8 }, cursorBlinking: 'smooth', cursorSmoothCaretAnimation: 'on',
      renderLineHighlight: 'all', fixedOverflowWidgets: true, stickyScroll: { enabled: false },
    });
    applyEditorOptions();

    const langSel = $('#st-lang');
    langList.slice().sort((a, b) => (a.aliases?.[0] || a.id).localeCompare(b.aliases?.[0] || b.id)).forEach((l) => {
      langSel.append(h('option', { value: l.id }, l.aliases && l.aliases[0] ? l.aliases[0] : l.id));
    });
    langSel.onchange = () => { if (active) { monaco.editor.setModelLanguage(active.model, langSel.value); active.detectDone = true; } };
    $('#st-enc').onchange = (e) => { if (active) { active.enc = e.target.value; active.forceDirty = true; renderTabs(); scheduleSession(); } };
    $('#st-eol').onclick = () => {
      if (!active) return;
      active.model.setEOL(active.model.getEOL() === '\r\n' ? monaco.editor.EndOfLineSequence.LF : monaco.editor.EndOfLineSequence.CRLF);
      updateStatus();
    };
    $('#st-log').onclick = () => showView('insights', { toggle: false });
    $('#st-follow').onclick = toggleFollow;

    $$('[data-act]').forEach((b) => { b.onclick = () => actions[b.dataset.act] && actions[b.dataset.act](); });
    $$('#rail .rail-btn[data-view]').forEach((b) => { b.onclick = () => showView(b.dataset.view); });
    $('#side-close').onclick = hideSide;
    // mouse wheel over the tab bar scrolls it sideways
    $('#tabs').addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); $('#tabs').scrollLeft += e.deltaY; } }, { passive: false });
    $('#panel-close').onclick = closePanel;
    wireSideResize();
    wireSignal();
    wireQueryBar();
    wireSnapDrag();
    wireLayoutButton();
    wirePanelResize();
    wirePreviewResize();
    wireFullscreen();
    wirePreview();
    wireCopilotPane();
    wireWelcome();
    setupTitleBar();
    editor.onDidChangeModelContent(() => updateWelcome());
    window.addEventListener('resize', debounce(renderSignal, 150));

    watchKeyboardPaste();
    editor.onDidChangeCursorPosition(updateStatus);
    editor.onDidChangeCursorSelection(updateStatus);
    editor.onDidChangeModelLanguage(() => {
      if (!active) return;
      active.an = null;
      scheduleAnalysis(active);
      renderTabs();
      updateStatus();
    });

    // context menu
    editor.addAction({ id: 'tf.filterId', label: 'Show only entries containing this', contextMenuGroupId: '0_tf', contextMenuOrder: 1,
      run: () => { const t = tokenAtCursor(); if (!t) return; const cur = filterLines(active.filter.trace); if (!cur.includes(t)) cur.push(t); setFilter({ trace: cur.join('\n') }); if (currentView === 'insights') renderInsights(); } });
    editor.addAction({ id: 'tf.hideLike', label: 'Hide entries containing this', contextMenuGroupId: '0_tf', contextMenuOrder: 2,
      run: () => { const t = tokenAtCursor(); if (!t) return; const ex = filterLines(active.filter.exclude); ex.push(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); setFilter({ exclude: ex.join('\n') }); if (currentView === 'insights') renderInsights(); } });
    editor.addAction({ id: 'tf.explain', label: 'Ask Copilot: explain this error', contextMenuGroupId: '1_copilot', contextMenuOrder: 1, run: () => askCopilot('explain') });
    editor.addAction({ id: 'tf.rootcause', label: 'Ask Copilot: find root cause', contextMenuGroupId: '1_copilot', contextMenuOrder: 2, run: () => askCopilot('rootcause') });
    editor.addAction({ id: 'tf.summarize', label: 'Ask Copilot: summarize log', contextMenuGroupId: '1_copilot', contextMenuOrder: 3, run: () => askCopilot('summarize') });
    editor.addAction({ id: 'tf.fix', label: 'Ask Copilot: suggest a fix', contextMenuGroupId: '1_copilot', contextMenuOrder: 4, run: () => askCopilot('fix') });
    editor.addAction({ id: 'tf.ask', label: 'Ask Copilot about this…', contextMenuGroupId: '1_copilot', contextMenuOrder: 5, run: () => askCopilot('custom') });
    editor.addAction({ id: 'tf.copyMasked', label: 'Copy with secrets masked', contextMenuGroupId: '0_tf', contextMenuOrder: 4,
      run: async () => { const sel = editor.getSelection(); const txt = sel && !sel.isEmpty() ? active.model.getValueInRange(sel) : active.model.getLineContent(editor.getPosition().lineNumber); const r = Logs.maskSecrets(txt, settings.mask); await api.clipboardWrite({ text: r.text }); toast('Copied, ' + r.count + ' value' + (r.count === 1 ? '' : 's') + ' masked.'); } });
    editor.addAction({ id: 'tf.table', label: 'Open selection in table view', contextMenuGroupId: '0_tf', contextMenuOrder: 5, run: openTableView });
    editor.addAction({ id: 'tf.toTable', label: 'Convert selection to table', contextMenuGroupId: '0_tf', contextMenuOrder: 6, run: convertToTable });
    editor.addAction({ id: 'tf.selectAll', label: 'Select all', contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 9, run: selectAll });
    wireSelectionBar();

    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragTab || Array.from(e.dataTransfer.types || []).includes('application/x-textforge-tab')) return; // a tab being moved, not a file
      if (api.dropPaths) { api.dropPaths(e.dataTransfer).then((paths) => { if (paths.length) openPaths(paths); }); return; }
      const paths = Array.from(e.dataTransfer.files).map((f) => api.pathForFile(f)).filter(Boolean);
      if (paths.length) openPaths(paths);
    });
    // Web: a new version was downloaded in the background (see the service worker in build-web.js).
    window.addEventListener('tf-update', () => toast('A new version of TextForge is ready. Reload to use it; your tabs are kept.', 30000,
      { label: 'Reload', run: () => { try { api.saveSessionSync(sessionData()); } catch { /* the regular autosave still has it */ } location.reload(); } }));
    if (APP_VERSION) { const brand = $('#topbar .brand'); if (brand) brand.title = 'TextForge ' + APP_VERSION; }
    api.onOpenPaths(openPaths);
    api.onTailData(onTailData);
    startDiskWatch();

    await restoreSession();
    // The sidebar opens only when asked for (rail buttons, Ctrl+1..3, Ctrl+B); the editor gets the whole width.
    // Hooks for the automated checklist (test/checklist.e2e.js).
    window.__tf = {
      get active() { return active; }, get tabs() { return tabs; }, setFilter, clearFilter, showView, askCopilot, openPalette, newTab, activate, treatAsLog,
      setPreview, copyRichText,
      runCommand: (label) => { const c = commands().find((x) => x.label.toLowerCase().startsWith(label.toLowerCase())); if (!c) throw new Error('No command ' + label); return c.run(); },
    };
    Object.defineProperty(window.__tf, 'autoState', { get: () => autoState });
    Object.defineProperty(window.__tf, 'panelTabs', { get: () => panelTabs.map((t) => ({ mode: t.mode, title: t.title, on: t === panelCur })) });
    Object.defineProperty(window.__tf, 'incident', { get: () => incident });
    Object.assign(window.__tf, { reportMarkdown: () => reportMarkdown(), pinFinding, followRequest, setIncidentMode, openIncident, openIncidentSample, closeIncident, reopenIncident, pickIncident, applyQuery, filterChips: () => (active ? filterChips(active.filter) : []), openSearch, showPanelTab: (mode) => showPanelTab(panelTabs.find((t) => t.mode === mode)), hideSide });
    Object.defineProperty(window.__tf, 'split', { get: () => split });
    Object.defineProperty(window.__tf, 'editor', { get: () => editor });
    Object.assign(window.__tf, { setTheme: (id, accent) => { settings.theme = id; if (accent) settings.accent = accent; applyTheme(); }, THEMES, ACCENTS, openSample, updateWelcome, openCopilot, closeCopilot, applyCopilotLayout, get settings() { return settings; }, enterFullscreen, exitFullscreen, isFullscreen: (sel) => isFullscreen(sel ? document.querySelector(sel) : null), openSplit: (t) => addSplitPane(t), addSplitPane, removePane, closeSplit, applyLayout, openLayoutPicker, LAYOUTS, swapSplit, topFullLine, renameTab, moveTab, extract: extractPreset, autoTables: () => runAutoTables(), showAutoTable, countBy: countByColumn, checkDiskChanges, compareWith, closeCompare, findDuplicates, copyShown });
  }
})();
