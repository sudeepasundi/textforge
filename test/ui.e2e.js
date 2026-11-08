/* UI test suite: layout at several window sizes, overlaps, Copilot pane resizing, colour contrast in every
   theme and accent, keyboard focus, accessible names, the welcome screen and console errors.
   Runs against the web build in Chromium: node test/ui.e2e.js [url] [--shots dir] */
const path = require('path');
const fs = require('fs');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(process.env.HOME || '', '.npm-global/lib/node_modules/playwright')); }
const { chromium } = playwright;
const URL_ = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'http://127.0.0.1:8765/';
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) fs.mkdirSync(shots, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|fonts\.g/.test(m.text())) consoleErrors.push(m.text()); });
  await page.goto(URL_);
  await page.waitForFunction(() => window.__tf && window.__tf.active && document.querySelector('.monaco-editor .view-lines'), null, { timeout: 30000 });
  await page.waitForTimeout(700);
  const E = (fn, a) => page.evaluate(fn, a);
  const results = [];
  const ok = (pass, detail) => ({ pass: !!pass, detail });
  async function check(group, name, fn) {
    let r;
    try { r = await fn(); } catch (e) { r = { pass: false, detail: 'Error: ' + e.message.split('\n')[0] }; }
    results.push(Object.assign({ group, name }, r));
    await page.keyboard.press('Escape').catch(() => {});
  }
  const shot = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, name + '.png') }); };
  const reset = () => E(() => {
    __tf.closeCopilot(); __tf.settings.cpDock = false; __tf.settings.cpRect = null; __tf.settings.cpDockW = 420;
    const p = document.getElementById('panel-close'); if (!document.getElementById('panel').hidden) p.click();
    if (__tf.active.preview) __tf.setPreview(false);
    document.getElementById('toast').hidden = true;
  });

  // Overflow / clipping helpers ------------------------------------------------------------------
  const layoutProblems = () => E(() => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const issues = [];
    if (document.documentElement.scrollWidth > W) issues.push('page scrolls sideways (' + document.documentElement.scrollWidth + ' > ' + W + ')');
    if (document.documentElement.scrollHeight > H + 1) issues.push('page scrolls vertically');
    const vis = (el) => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null; };
    for (const sel of ['#topbar', '#rail', '#statusbar', '#main', '#side', '#cp-host', '#panel', '#preview']) {
      const el = document.querySelector(sel);
      if (!el || el.hidden || !vis(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > W + 1 || r.left < -1 || r.bottom > H + 1) issues.push(sel + ' outside the window');
    }
    const ed = document.querySelector('#editor').getBoundingClientRect();
    const st = document.querySelector('#statusbar').getBoundingClientRect();
    if (ed.bottom > st.top + 1) issues.push('editor runs under the status bar');
    return { issues, editorW: Math.round(ed.width) };
  });

  // =================================================================================================
  // 1. Layout at five window sizes, in six states
  // =================================================================================================
  const states = {
    'plain': async () => {},
    'sidebar': async () => { await E(() => __tf.showView('insights', { toggle: false })); },
    'Copilot docked': async () => { await E(() => { __tf.settings.cpDock = true; __tf.openCopilot({ toggle: false }); }); },
    'Copilot floating': async () => { await E(() => { __tf.settings.cpDock = false; __tf.openCopilot({ toggle: false }); }); },
    'bottom panel': async () => { await E(() => __tf.runCommand('Find in all open tabs')); },
    'preview': async () => { await E(() => { __tf.setPreview(true); }); },
  };
  await E(() => __tf.openSample());
  for (const width of [1440, 1280, 1024, 800, 400]) {
    await page.setViewportSize({ width, height: width < 600 ? 820 : 900 });
    for (const [state, apply] of Object.entries(states)) {
      await check('Layout', `${width}px wide, ${state}: nothing clipped, no page scrolling`, async () => {
        await reset();
        await E(() => document.getElementById('side-close').click());
        await apply();
        await page.waitForTimeout(250);
        const r = await layoutProblems();
        if (width === 1440 || width === 400) await shot(`layout-${width}-${state.replace(/\s/g, '-')}`);
        const minEditor = width >= 1024 && state !== 'Copilot floating' ? 300 : width >= 800 ? 200 : 0;
        if (r.editorW < minEditor && !(width < 800)) r.issues.push('editor only ' + r.editorW + 'px wide');
        return ok(r.issues.length === 0, r.issues.length ? r.issues.join('; ') : `editor ${r.editorW}px wide`);
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await reset();

  // =================================================================================================
  // 2. Overlaps
  // =================================================================================================
  await check('Overlaps', 'Copilot button hides while the pane is open, returns when closed', async () => {
    await E(() => __tf.openCopilot({ toggle: false }));
    await page.waitForTimeout(250);
    const open = await E(() => getComputedStyle(document.getElementById('cp-fab')).opacity);
    await E(() => __tf.closeCopilot());
    await page.waitForTimeout(250);
    const closed = await E(() => getComputedStyle(document.getElementById('cp-fab')).opacity);
    return ok(open === '0' && closed === '1', `opacity open ${open}, closed ${closed}`);
  });
  // 0.15.1: the button no longer climbs above the results panel (it ended up over the editor text when the panel
  // was tall). It stays in the bottom-right corner, clear of the status bar, the panel's toolbar and its scrollbar.
  await check('Overlaps', 'Copilot button stays in its corner, clear of the status bar and the panel controls', async () => {
    const a = await E(() => { const f = document.getElementById('cp-fab').getBoundingClientRect(); const s = document.getElementById('statusbar').getBoundingClientRect(); return f.bottom <= s.top; });
    await E(() => __tf.runCommand('Find in all open tabs'));
    await page.waitForTimeout(200);
    const b = await E(() => {
      const f = document.getElementById('cp-fab').getBoundingClientRect(), head = document.getElementById('panel-head').getBoundingClientRect(), body = document.getElementById('panel-body');
      const br = body.getBoundingClientRect(); const scrollbarLeft = br.left + body.clientWidth;
      const main = document.getElementById('main').getBoundingClientRect();
      return { belowHead: f.top >= head.bottom, clearOfScrollbar: f.right <= scrollbarLeft, corner: main.bottom - f.bottom <= 30 && main.right - f.right <= 30 };
    });
    await reset();
    return ok(a && b.belowHead && b.clearOfScrollbar && b.corner, `above status bar ${a}, ${JSON.stringify(b)}`);
  });
  await check('Overlaps', 'Welcome screen sits above the minimap and is fully clickable', async () => {
    await E(() => { const t = __tf.newTab({}); __tf.activate(t); });
    await page.waitForTimeout(250);
    const r = await E(() => {
      const card = document.querySelector('#welcome .wl-card');
      const btns = Array.from(card.querySelectorAll('button'));
      return btns.every((b) => { const r = b.getBoundingClientRect(); const pts = [[r.left + 6, r.top + r.height / 2], [r.right - 6, r.top + r.height / 2]]; return pts.every(([x, y]) => b.contains(document.elementFromPoint(x, y))); });
    });
    await shot('welcome');
    return ok(r, r ? 'every welcome button is reachable edge to edge' : 'something covers a welcome button');
  });

  // =================================================================================================
  // 3. Copilot pane resizing (docked and floating)
  // =================================================================================================
  const drag = async (sel, dx, dy, { dbl } = {}) => {
    const r = await E((s) => { const g = document.querySelector(s).getBoundingClientRect(); return { x: g.x + g.width / 2, y: g.y + Math.min(g.height / 2, 200) }; }, sel);
    if (dbl) { await page.mouse.dblclick(r.x, r.y); return; }
    await page.mouse.move(r.x, r.y);
    await page.mouse.down();
    await page.mouse.move(r.x + dx / 2, r.y + dy / 2, { steps: 4 });
    await page.mouse.move(r.x + dx, r.y + dy, { steps: 4 });
    await page.mouse.up();
  };
  const paneBox = () => E(() => { const b = document.getElementById('body').getBoundingClientRect(); const r = document.getElementById('cp-host').getBoundingClientRect(); return { x: Math.round(r.left - b.left), y: Math.round(r.top - b.top), w: Math.round(r.width), h: Math.round(r.height), bw: Math.round(b.width), bh: Math.round(b.height) }; });
  await check('Copilot pane', 'Docked: drag the left edge wider and narrower; editor follows', async () => {
    await E(() => { __tf.settings.cpDock = true; __tf.openCopilot({ toggle: false }); });
    await page.waitForTimeout(200);
    const a = await paneBox();
    const e0 = await E(() => monaco.editor.getEditors()[0].getLayoutInfo().width);
    await drag('.cp-grip[data-dir="l"]', -180, 0);
    const b = await paneBox();
    const e1 = await E(() => monaco.editor.getEditors()[0].getLayoutInfo().width);
    await drag('.cp-grip[data-dir="l"]', 120, 0);
    const c = await paneBox();
    return ok(b.w - a.w >= 170 && a.w - c.w <= 70 && b.w - c.w >= 110 && e1 < e0, `${a.w}px -> ${b.w}px -> ${c.w}px; editor ${e0}px -> ${e1}px`);
  });
  await check('Copilot pane', 'Docked: width is clamped (min 300px, editor keeps 420px)', async () => {
    await drag('.cp-grip[data-dir="l"]', 2000, 0);
    const min = await paneBox();
    await drag('.cp-grip[data-dir="l"]', -3000, 0);
    const max = await paneBox();
    return ok(min.w === 300 && max.w <= max.bw - 420 + 1, `smallest ${min.w}px, largest ${max.w}px of ${max.bw}px`);
  });
  await check('Copilot pane', 'Docked: width is remembered, double-click the edge resets it', async () => {
    await drag('.cp-grip[data-dir="l"]', 2000, 0);
    await drag('.cp-grip[data-dir="l"]', -150, 0);
    const saved = await E(() => __tf.settings.cpDockW);
    await E(() => { __tf.closeCopilot(); __tf.openCopilot({ toggle: false }); });
    const again = await paneBox();
    await drag('.cp-grip[data-dir="l"]', 0, 0, { dbl: true });
    const reset_ = await paneBox();
    return ok(saved === again.w && reset_.w === 420, `saved ${saved}px, reopened at ${again.w}px, reset to ${reset_.w}px`);
  });
  await check('Copilot pane', 'Floating: resize from the bottom-right and bottom-left corners', async () => {
    await E(() => { __tf.settings.cpDock = false; __tf.settings.cpRect = null; __tf.applyCopilotLayout(); });
    await page.waitForTimeout(200);
    const a = await paneBox();
    await drag('.cp-grip[data-dir="bl"]', -160, -100);
    const b = await paneBox();
    await drag('.cp-grip[data-dir="br"]', -60, 60);
    const c = await paneBox();
    return ok(b.w - a.w >= 150 && b.x < a.x && a.h - b.h >= 90 && c.w < b.w && c.h > b.h, `${a.w}x${a.h} -> ${b.w}x${b.h} -> ${c.w}x${c.h}`);
  });
  await check('Copilot pane', 'Floating: never smaller than 300x260 and never outside the window', async () => {
    await drag('.cp-grip[data-dir="br"]', -2000, -2000);
    const small = await paneBox();
    await drag('.cp-grip[data-dir="br"]', 3000, 3000);
    const big = await paneBox();
    const head = await E(() => { const r = document.getElementById('cp-head').getBoundingClientRect(); return { x: r.x + 60, y: r.y + 15 }; });
    await page.mouse.move(head.x, head.y); await page.mouse.down(); await page.mouse.move(head.x + 3000, head.y + 3000, { steps: 6 }); await page.mouse.up();
    const moved = await paneBox();
    const inside = (p) => p.x >= 0 && p.y >= 0 && p.x + p.w <= p.bw + 1 && p.y <= p.bh;
    return ok(small.w === 300 && small.h === 260 && inside(big) && inside(moved), `min ${small.w}x${small.h}; max ${big.w}x${big.h} inside; dragged far away stays at ${moved.x},${moved.y}`);
  });
  await check('Copilot pane', 'Floating: size and place survive close and reopen', async () => {
    const before = await paneBox();
    await E(() => { __tf.closeCopilot(); __tf.openCopilot({ toggle: false }); });
    const after = await paneBox();
    await shot('copilot-floating');
    await reset();
    return ok(before.w === after.w && before.h === after.h && before.x === after.x && before.y === after.y, `${before.w}x${before.h} at ${before.x},${before.y} -> ${after.w}x${after.h} at ${after.x},${after.y}`);
  });

  // =================================================================================================
  // 4. Colour contrast in every theme and accent (WCAG 2.1)
  // =================================================================================================
  const contrast = await E(() => {
    const hex = (c) => { c = c.trim(); if (c.startsWith('#')) { const n = parseInt(c.slice(1, 7), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; } const m = c.match(/\d+/g); return m.slice(0, 3).map(Number); };
    const L = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const x = L(hex(a)); const y = L(hex(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const v = (n) => getComputedStyle(document.documentElement).getPropertyValue('--' + n);
    const out = [];
    for (const theme of Object.keys(__tf.THEMES)) {
      for (const accent of __tf.ACCENTS) {
        __tf.setTheme(theme, accent);
        out.push({ theme, accent, text: ratio(v('fg'), v('bg')), textOnPanel: ratio(v('fg'), v('surface')), muted: ratio(v('muted'), v('surface')), button: ratio(v('accent-fg'), v('accent')), accentText: ratio(v('accent-text'), v('editor')), err: ratio(v('err'), v('editor')), warn: ratio(v('warn'), v('editor')) });
      }
    }
    __tf.setTheme('slate', '#4c9aff');
    return out;
  });
  const fails = (key, min) => contrast.filter((c) => c[key] < min);
  const worst = (key) => contrast.reduce((a, c) => (c[key] < a[key] ? c : a));
  for (const [key, min, label] of [['text', 7, 'Body text on background (AAA, 7:1)'], ['textOnPanel', 7, 'Text on panels (AAA, 7:1)'], ['muted', 4.5, 'Secondary text on panels (AA, 4.5:1)'], ['button', 4.5, 'Text on accent buttons, every accent (AA, 4.5:1)'], ['accentText', 4.5, 'Accent-coloured text such as links and your stack frames (AA, 4.5:1)'], ['err', 3, 'Error colour in the editor (3:1)'], ['warn', 3, 'Warning colour in the editor (3:1)']]) {
    await check('Contrast', label + ', all 6 themes', async () => {
      const f = fails(key, min);
      const w = worst(key);
      return ok(f.length === 0, f.length ? f.map((c) => `${c.theme}/${c.accent} ${c[key].toFixed(2)}`).slice(0, 4).join(', ') : `lowest ${w[key].toFixed(2)}:1 (${w.theme})`);
    });
  }

  // =================================================================================================
  // 5. Keyboard and accessible names
  // =================================================================================================
  await check('Accessibility', 'Every visible button has a name (text, title or aria-label)', async () => {
    await E(() => __tf.showView('insights', { toggle: false }));
    const bad = await E(() => Array.from(document.querySelectorAll('button')).filter((b) => b.offsetParent && !(b.textContent.trim() || b.title || b.getAttribute('aria-label'))).map((b) => b.id || b.className || b.outerHTML.slice(0, 60)));
    return ok(bad.length === 0, bad.length ? 'unnamed: ' + bad.slice(0, 5).join(', ') : 'all named');
  });
  await check('Accessibility', 'Every form field has a label or placeholder', async () => {
    const bad = await E(() => Array.from(document.querySelectorAll('input:not([type=checkbox]):not([type=radio]), select, textarea')).filter((f) => f.offsetParent && !f.closest('.monaco-editor') && !(f.placeholder || f.title || f.getAttribute('aria-label') || (f.id && document.querySelector(`label[for="${f.id}"]`)) || f.closest('label') || (f.closest('.field') && f.closest('.field').querySelector('label')))).map((f) => f.id || f.outerHTML.slice(0, 60)));
    return ok(bad.length === 0, bad.length ? 'unlabelled: ' + bad.join(', ') : 'all labelled');
  });
  await check('Accessibility', 'Keyboard focus is visible on buttons (Tab)', async () => {
    await E(() => document.querySelector('#topbar [data-act="new"]').focus());
    const styles = [];
    for (let i = 0; i < 4; i++) {
      styles.push(await E(() => { const el = document.activeElement; const s = getComputedStyle(el); return { el: el.title || el.textContent.trim().slice(0, 20), visible: (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2) || s.boxShadow !== 'none' }; }));
      await page.keyboard.press('Tab');
    }
    return ok(styles.every((s) => s.visible), styles.map((s) => `${s.el}: ${s.visible ? 'ring' : 'NO ring'}`).join(', '));
  });

  // =================================================================================================
  // 6. Welcome screen
  // =================================================================================================
  await check('Welcome', 'Shown on an empty new tab, hidden after typing', async () => {
    await E(() => { const t = __tf.newTab({}); __tf.activate(t); });
    await page.waitForTimeout(150);
    const a = await E(() => !document.getElementById('welcome').hidden);
    await E(() => monaco.editor.getEditors()[0].trigger('kbd', 'type', { text: 'hello' }));
    const b = await E(() => !document.getElementById('welcome').hidden);
    return ok(a && !b, `before typing ${a}, after ${b}`);
  });
  await check('Welcome', '"Try the sample log" opens a log tab', async () => {
    await E(() => { const t = __tf.newTab({}); __tf.activate(t); });
    await page.waitForTimeout(150);
    await page.click('#welcome [data-wl="sample"]');
    await page.waitForTimeout(400);
    const r = await E(() => ({ name: __tf.active.name, lang: __tf.active.model.getLanguageId(), welcome: !document.getElementById('welcome').hidden }));
    return ok(r.lang === 'log' && !r.welcome, `${r.name} (${r.lang})`);
  });

  // =================================================================================================
  // 7. Visual review shots of every theme
  // =================================================================================================
  if (shots) {
    await E(() => { __tf.showView('insights', { toggle: false }); __tf.settings.cpDock = true; __tf.openCopilot({ toggle: false }); });
    for (const theme of ['slate', 'graphite', 'deepsea', 'plum', 'paper', 'sand']) {
      await E((t) => __tf.setTheme(t), theme);
      await page.waitForTimeout(200);
      await shot('theme-' + theme);
    }
    await E(() => __tf.setTheme('slate', '#4c9aff'));
  }
  await check('Stability', 'No errors in the console during the whole run', async () => ok(consoleErrors.length === 0, consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : 'none'));

  // ---------- report ----------
  let pass = 0;
  for (const g of [...new Set(results.map((r) => r.group))]) {
    const rs = results.filter((r) => r.group === g);
    const p = rs.filter((r) => r.pass).length;
    pass += p;
    console.log(`\n${g}  (${p}/${rs.length})`);
    for (const r of rs) if (!r.pass || g !== 'Layout') console.log((r.pass ? '  PASS ' : '  FAIL ') + r.name + '  —  ' + (r.detail || ''));
  }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exitCode = pass === results.length ? 0 : 1;
})().catch((e) => { console.error('UI TESTS FAILED', e); process.exit(2); });
