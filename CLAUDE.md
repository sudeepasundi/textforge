# TextForge: project context for Claude Code

This file is the hand-off for continuing work on TextForge. Read it fully before changing anything.
Current version: **0.19.0** (see `package.json`). Owner: NUKE (GitHub `sudeepasundi`).

**Direction (agreed 2026-11-07):** move to Tauri 2 + a Rust log engine (also WASM on the web) + Svelte/TypeScript,
one phase per release; 0.13.0 added the Tauri preview. The UI follows design "D · Focus with tools" from the
claude.ai canvas https://claude.ai/artifact/J7UR17eqQ8EwLDqtidqo6c: 0.14.0 built the query bar, tab row, timeline
count filters, results tabs and status-bar summary; 0.15.0 added the "patterns found" list in Extract data,
the toolbar on selected text (a Monaco content widget, `wireSelectionBar()`) and the Copilot error badge. Design D is done.
**Releases:** each release has its own branch `release/vX.Y.Z` (from the previous release branch or `main`),
merged into `main` through a PR. The owner decides when to push; do not push unless asked.

## What TextForge is

A Notepad++-style text editor for backend developers (Java / Spring Boot / Kafka / microservices), in
two forms that share one code base:

- **Desktop app** (Electron, Windows): shipped as a **portable zip with no installer**, because the
  owner's work laptop is managed and blocks installers. Unsigned (see "Open items").
- **Web app**: GitHub Pages build (self-hosted), plus a single-file build published as a claude.ai
  artifact.

What it does that Notepad++ doesn't:

- **Logs:** detects Spring Boot / Logback / Log4j / JSON / access / syslog / k8s logs, colours
  levels, and draws an error and warning timeline. Filters cover levels, text, lines, logger, trace
  IDs and time ranges (including dragging a range on the timeline). It folds stack traces, groups
  duplicate errors, and has extractors.
- **Auto tables:** learns the message templates in a log and builds one table per pattern, with
  named columns (Drain-style template mining in `logs.js`).
- **Tables survive pasting:** rich HTML tables from AI chats, Excel and the web, CSV, and
  space-aligned text tables all stay tables. The Markdown preview has "Copy as rich text" for Teams
  and Outlook.
- **Microsoft 365 Copilot** (not GitHub Copilot, which the owner explicitly does not want): an
  embedded webview pane in the desktop app (dock or float, resizable, full screen), and a popup on
  the web. Right-click → "Ask Copilot" builds a prompt with secrets masked.
- **Editor workspace:**
  - Split view with Windows-11-style snap layouts (2/3/4 files), scrolling together by timestamp,
    with filters and Ctrl+F search shared across panes.
  - Open files list in the sidebar; renaming and reordering tabs.
  - Compare (diff) view.
  - Full screen for the preview, comparison, results panel and Copilot.
  - A resizable preview and a resizable results panel.
  - Files reload when they change on disk.
  - 6 themes × 6 accents, compact density, session restore.

## Live locations

- Repo: https://github.com/sudeepasundi/textforge (public, MIT)
- Website: https://sudeepasundi.github.io/textforge/ (GitHub Pages, deployed by Actions on push to `main`)
- Downloads: https://github.com/sudeepasundi/textforge/releases (Windows portable zip + web zip)
- claude.ai artifact (single-file web build): https://claude.ai/artifact/48BH3gBtdTHNq4M1Qgi9Bo

## Stack

- Vanilla JavaScript (no framework, no bundler, no TypeScript), HTML, CSS custom properties.
- Electron 33 (installed 33.4.x) with `contextIsolation: true`, `nodeIntegration: false` and the
  `webview` tag (Copilot only, partition `persist:copilot`).
- Monaco Editor 0.52.2, loaded with its AMD loader (`node_modules/monaco-editor/min`). The web
  single-file build loads it from jsDelivr.
- @electron/packager 18 for the win32-x64 portable build. It uses `resedit`, so the icon and exe
  metadata are set without Wine.
- Tests: plain Node scripts (`assert`) for units; Playwright (Chromium, and `_electron` for desktop)
  for end-to-end; `jsdom` for the markdown unit tests.
- CI: GitHub Actions. `pages.yml` builds and deploys the website; `release.yml` builds on
  `windows-latest` and attaches the zips to a Release.

## Repository map

| Path | What it is |
|---|---|
| `main.js` | Electron main: frameless window (`titleBarStyle: 'hidden'` + `titleBarOverlay`), file IO with encoding detection (UTF-8/BOM/UTF-16/latin1), 500 MB limit, IPC handlers, live tail, webview hardening, restoring window bounds after HTML full screen. |
| `preload.js` | Exposes `window.api` (the desktop side of the API contract) via `contextBridge`. |
| `web-api.js` | The web implementation of the same `window.api`: File System Access API, an `<input type=file>` fallback, IndexedDB session, clipboard, `launchQueue`, stat / reload / repick for changed files, drag-drop handles. |
| `renderer.js` | The whole UI (~4,000 lines, one IIFE). See the section map below. |
| `logs.js` | Log engine (UMD, also `require`-able in Node): format detection, entry parsing, filters, timeline, duplicates, count-by, extract presets, `autoTables` (template mining). |
| `tables.js` | Table inference from pasted text: delimiters, space-aligned layouts, header fitting with units such as "(ms)". |
| `markdown.js` | HTML→Markdown (paste), safe DOM renderer, table alignment. |
| `index.html` | Markup (top bar, rail, sidebar views, `#work` with `#editors` grid, preview, panel, Copilot host, status bar). |
| `style.css` | All styles. Long lines; later sections are dated by version (e.g. `/* ---- split view with snap layouts (0.10.0) ---- */`). |
| `build-web.js` | Builds `web-dist/selfhost/` (PWA with service worker and manifest) and `web-dist/artifact/TextForge.html` (one file, CSS inlined, Monaco from jsDelivr, `'vs/css': {disabled:true}`). |
| `assets/` | Icon sources (`icon.svg`, plus `icon-small.svg` for 16–32 px), generated PNGs and `icon.ico`. Regenerate with `node tools/make-icons.js`. |
| `samples/order-service.log` | Sample Spring Boot log (used by "Try the sample log" and many tests). |
| `samples/{api-gateway,payment-service,inventory-service}.log` | With order-service: the incident sample (0.16.0), one outage seen from four services. Embedded in the web builds as `TF_WEB.samples`; Electron reads them through `api.sample(name)`. |
| `packaging/README.txt` | The user-facing README shipped inside the zips. **Append a section for every release.** |
| `test/` | Unit tests (`*.test.js`) and browser/desktop suites (`*.e2e.js`); see Testing. |
| `.github/workflows/` | `pages.yml` (website) and `release.yml` (Windows build + Release). |
| `.gitattributes` | Forces LF everywhere (the Windows CI checkout broke CRLF-sensitive tests once). |
| `src-tauri/` | Tauri 2 desktop preview (0.13.0+): `src/main.rs` is the Rust side of `window.api` (file IO with the same encodings and 500 MB limit as `main.js`, session, clipboard, Copilot child webview). `capabilities/main.json` grants permissions to the `main` webview only; the Copilot webview gets none. |
| `tauri-api.js` | The Tauri implementation of `window.api` (third one, next to `preload.js` and `web-api.js`). Built into `web-dist/desktop/` by `build-web.js`, which Tauri embeds in the exe. |

### `renderer.js` section map (approximate line numbers)

`h()`/`$`/`$$` helpers and settings at the top · tabs, rename and reorder, tab menu (~330–600) ·
paste pipeline including the mobile "burst" paste (~860) · full screen helpers (~924) · Markdown
preview with resize (~1001) · compare (~1191) · log analysis: hidden areas, decorations, signal
strip (~1256–1680) · sidebar: open files, insights, extract, auto tables, highlight, appearance,
copilot views (~1683–2400) · frameless title bar, Copilot pane (~2395–2700) · log tools (~2709) ·
split view and snap layouts (~2765–3310) · changed on disk (~3312) · bottom panel (~3432) ·
command palette (~3628) · misc actions, keyboard shortcuts, init (~3745–end).

## Key conventions

- **One API contract, two implementations.** The UI only calls `window.api.*`. Desktop: `preload.js`
  + IPC in `main.js`. Web: `web-api.js`. Add new capabilities to **both** (or feature-detect, e.g.
  `if (api.stat)`).
- **Tab object:** `{ id, name, path, model, enc, savedVersion, forceDirty, preview, filter, an
  (analysis), used, stamp, disk, tailing, ... }`. On the web, paths are pseudo paths
  (`web:N/name`, `download:...`).
- **Settings:** `localStorage['tf-settings2']`. Use `saveSettings()` (debounced 300 ms); it is also
  flushed on `pagehide` / `beforeunload`.
- **Test hooks:** `window.__tf` exposes internals for Playwright (`newTab`, `activate`,
  `setFilter`, `runCommand(labelPrefix)`, `applyLayout`, `addSplitPane`, `enterFullscreen`, `split`,
  `autoState`, `editor`, `settings`, ...). Getters must use `Object.defineProperty`, because
  `Object.assign` freezes getter values. Keep hooks working when refactoring.
- **Themes:** CSS custom properties on `:root`, set by `applyTheme()`. Contrast is computed:
  `bestOn()` for text on the accent, and `readableAccent()` for `--accent-text`, kept at or above
  4.5:1.
- **Log bar (0.18.1, after the owner's tracepad app https://sudeepasundi.github.io/tracepad/):** `#logbar` under the tab row
  holds the timeline strip (`#signal`: div bars in `.lb-bars` from `stripBuckets(an)`, one bar per ~7 px (12–180) over the
  even time span like tracepad, sqrt heights, `.dim` outside the selected range, `.range`
  outline, hover readout in `.lb-hint`) and the filter row `#filterbar` (level chips `.lb-lvl`, the text box `#qb-input` with
  Aa / .* toggles = `filter.text/textCase/textRegex`, applied live after `Logs.filterEntries` in `computeVisibility()`,
  More filters `.lb-advanced`, count, Clear filters, Auto tables, error arrows). Text that looks like query syntax
  (`isQueryLike`) waits for Enter and goes through `applyQuery()`. The title bar holds the file tabs again (0.18.2;
  `#tabrow` is gone). Timeline extras (0.18.2): `renderTicks()`, `tab.tlZoom` via `zoomTimeline()`, `spanLabel()` in the hint.
  `showMenu(items, x, y)` is the shared small menu (tab menu, results Copy menu). Rail action buttons (`data-act` focus,
  compare, incident) sit under the view icons; focus mode is `body.focus-mode` via `toggleFocusMode()` (Alt+M, Esc). Levels are
  shown by the chips, not as a query chip. Chips come from
  `filterChips(tab.filter)`, each with the patch that removes it; typed text goes through `applyQuery()`. New filter
  syntax needs both: a branch in `applyQuery()` and a chip in `filterChips()`. `filter.took` (ms) is applied after
  `Logs.filterEntries` in `computeVisibility()`, like `filter.lines`.
- **Incident (0.16.0):** `Logs.incident(sources)` (pure, unit-tested) returns services, the shared span and findings;
  `Logs.incidentBuckets` feeds the lanes. The view (`renderIncident()` in renderer.js) covers `#work` like the
  comparison (`#diff`); `incident` keeps its state so "Back to the incident" and Alt+I restore it. Findings mask
  secrets for display and copying; the reader shows raw lines like the editor. Timestamps from different logs are
  compared as written (offsets such as +05:30 are not converted yet): logs from different time zones need that next.
  Requests (0.17.0): `Logs.requests(res)` groups entries by `traceId`; a step per service runs from its first entry
  (moved earlier by a reported duration: "took 1534ms") to its last; `describeRequest()` writes the summary. The
  incident has three modes (`incident.mode` timeline | requests | report); summaries are masked for display like findings.
  Report (0.18.0): pins (`incident.pins`) copy what the report needs when pinned (title, detail, evidence lines,
  steps) and carry the note; `Logs.incidentReport()` writes the Markdown; `reportMarkdown()` masks it;
  "Copy for Teams / Outlook" uses `richHtml()` (shared with the preview's Copy as rich text). Pins survive
  reopening the same incident; closing asks first.
- **Hidden text (0.19.0):** `settings.hideRules` ([{ pattern, example, on }]) hide matching parts of lines in every tab via
  decorations (`tf-hidden` = `display:none` with `inlineClassNameAffectsLetterSpacing: true`, so Monaco measures it as zero
  wide and the cursor stays right; a `before` injected "⋯" marks the spot). `likePattern()` turns a selection into "text like
  this". `settings.showHidden` (status chip `#st-hidden`) shows them, marked. `shownText()` / Copy shown drop hidden parts.
  `removeText()` really deletes, as one undo step. Rules are managed in the Highlight view.
- **Results tabs (0.14.0):** `openPanel(mode, title)` keeps one tab per `mode`; switching stashes the DOM nodes of
  `#panel-tools` / `#panel-body`, so code that fills the panel keeps using those ids as before.
- **Commands:** add new features to the command palette list (`commands()` in the COMMAND PALETTE
  section) and give them a keyboard shortcut where it makes sense.
- **Privacy:** no telemetry and no network calls except the Copilot pane and (on the web) loading
  Monaco. Mask secrets before anything goes to Copilot.
- **Git:** commit as `NUKE <sudeepasundi@users.noreply.github.com>` (keeps the owner's email private).
  Don't put personal or employer details in the public repo.

## Build, run, test

```bash
npm ci                      # Electron + Monaco + packager + jsdom
npm start                   # desktop app
node build-web.js           # web builds into web-dist/
npm run package:win         # dist/TextForge-win32-x64 (then prune node_modules except monaco-editor)
npm test                    # unit tests: tables 15, logs 15, markdown 8, autotables 9, incident 15
npm run package:tauri       # Tauri preview: src-tauri/target/release/textforge.exe (needs Rust + MSVC build tools)
```

**Tauri gotchas:** commands without `async` run on the window's thread: anything touching the disk is
`async` and uses `background()`, and creating a webview from a sync command deadlocks on Windows.
Native file drops are off (`disable_drag_drop_handler`) so HTML drag and drop (tabs, snap) works.
To drive the exe with Playwright, start it with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`
and use `chromium.connectOverCDP`; always put a timeout on the connection.

Browser suites expect `web-dist/selfhost` served at `http://127.0.0.1:8765/`:

```bash
node build-web.js
(cd web-dist/selfhost && python3 -m http.server 8765 --bind 127.0.0.1 &)
node test/checklist.e2e.js     # 59  feature checklist
node test/ui.e2e.js            # 52  layout at 5 widths, contrast (6 themes x 6 accents), a11y
node test/disk.e2e.js          # 11  changed-on-disk reload, Open inside a cross-origin frame
node test/autotables.e2e.js    # 10
node test/layout.e2e.js        # 16  sidebar, density, split basics, timeline drag
node test/workspace.e2e.js     # 22  panel resize, tab rename/reorder, multi-pane split, shared filters/search
node test/snap.e2e.js          # 19  snap layouts, Snap Assist, drag-to-snap
node test/files.e2e.js         # 25  Open files list, rail shortcut buttons, focus mode
node test/fullscreen.e2e.js    # 38  resize and full screen everywhere, including appearance checks
node test/incident.e2e.js      # 45  incident view: lanes, findings, time window, reader, jump to a line, requests, pins and report, phone
node test/querybar.e2e.js      # 87  log bar, Log insights, zoom/ticks, Copy menu, Compare with…, hidden text (timeline, level chips, live text, More filters), result tabs + copy, patterns, selection toolbar, badge
xvfb-run -a node test/ui-desktop.e2e.js   # 9  Electron: title bar, Copilot resize, full-screen window restore
```

Tests use `require('playwright')`, falling back to `~/.npm-global/lib/node_modules/playwright`. The
Electron tests need a display (`xvfb-run` on Linux).

**Always look at screenshots, not only numbers.** The owner rejected a release where every test
passed but the full-screen preview looked bad: content was capped at 1100 px and the scrollbar sat
in the middle of the screen. For any UI change, take Playwright screenshots at 1920×1080 and 1366×768
(no phone sizes: the owner dropped mobile checks on 2026-11-12), in the dark (`slate`) and a light theme, and **read them** before saying
it's done. Add assertions about appearance (widths used, scrollbar at the edge, controls next to
what they control), not just positions.

## Releasing

1. Bump `version` in `package.json` and append a section to `packaging/README.txt` (and update
   `README.md` features if needed).
2. Run `npm test`, the browser suites and the desktop suite.
3. Commit and push to `main`. `pages.yml` redeploys the website automatically.
4. Start the **Release** workflow (Actions tab → Release → Run workflow, or
   `gh workflow run release.yml --ref main`). It tags `v<version>` itself and uploads
   `TextForge-<v>-win-x64-portable.zip` and `TextForge-<v>-web.zip`.
   (Pushing a `v*` tag also works locally; Claude's web sessions could push branches but not tags,
   which is why the workflow tags itself.)
5. Optionally republish `web-dist/artifact/TextForge.html` to the claude.ai artifact.

GitHub runs occasionally sit in "queued" for a long time; re-dispatching usually unsticks them.

## Lessons and gotchas (each one was a real bug)

- **Monaco paste:** register the window capture `paste` listener **before** Monaco loads, or Monaco
  swallows the event. Phone keyboards insert pasted text without a paste event, so it is detected as
  a fast burst of typing.
- **Monaco hidden areas** (filtering) are ignored above ~300k lines unless
  `largeFileOptimizations: false`.
- **The 500 MB file limit** comes from the JS string limit (~512M chars). The main process raises
  the heap (`--max-old-space-size=6144`). Files over 30 MB load deferred with a progress toast.
- **CRLF:** `parseLine` strips a trailing `\r`; `.gitattributes` keeps the repo LF.
- **Web inside claude.ai** is a cross-origin iframe: the File System Access picker is blocked, so
  use `<input type=file>` synchronously. Picked files are one-time snapshots (`NotReadableError`
  once changed), so the UI offers "Pick file again". Copilot can't be iframed (Microsoft blocks
  framing), so the web version opens it in a popup.
- **Don't treat window `focus` as "file dialog cancelled".** OneDrive files can arrive seconds
  later; only the input's `cancel` event means cancel.
- **CSS class collisions:** the generic `.empty` class added padding to empty split panes (now
  `.no-file`). Check for existing generic class names first.
- **Preview layout:** the scroll container (`#preview-body`) must span the whole preview; the
  content lives in `#preview-doc.md`, and there is no `max-width` on it in side view.
- **Monaco diff:** `renderGutterMenu: false` removes an empty strip between the two sides.
- **Monaco find mirroring** across panes uses the internal `editor.contrib.findController`
  (`getState().change(...)`, `start(...)`). Re-check it if Monaco is upgraded.
- **Typed arrays:** `an.vis` is a `Uint8Array`. Use `Array.from(an.vis).map(...)` in tests.
- **Full screen:** request it on `document.documentElement` (so toasts, menus and dialogs stay
  visible) and cover the element with `.fs-mode`. Esc is handled in the **capture** phase so
  dialogs, palette, menus and the find box get Esc first. The desktop main process restores window
  bounds on `leave-html-full-screen`.
- **Electron `titleBarOverlay`** height follows density (40 / 32 px) via `win:titlebar` IPC.
- **Web updates (0.15.1):** the service worker used to be cache-first, so an open tab (or one reload) kept the
  old version for days; the owner reported 0.12 bugs after 0.15.0 was live. Now app files are network-first
  (cache only when offline), Monaco and fonts stay cache-first, the page calls `reg.update()` on
  visibilitychange and hourly, and `controllerchange` raises a "new version ready / Reload" toast. When the
  owner reports a bug, first check the version they run (help dialog, or hover the logo).
- **Copilot button:** it stays in the bottom-right corner of `#main`; don't move it with the results panel
  (it ended up over the editor text when the panel was tall).
- **Copilot sign-in** persists in partition `persist:copilot`. The pane auto-loads once
  `settings.cpStarted` is set; "Sign out of Copilot" clears that partition.

## Open items / backlog

Suggested next (agreed or offered to the owner):

- **Compare from the Open files list:** 0.18.2 added "Compare with…" to the tab menu and Alt+D; the Open files list
  could offer it too.
- **Filters in split view** always come from the main editor; setting a filter while a pane has
  focus could apply from that pane instead.
- **Incident next:** convert time-zone offsets so logs from different zones line up; keep incidents (with their
  report) in the session so they survive a restart; the phone layout from board 3 of the design canvas
  (https://claude.ai/artifact/2VGRdPu3k1zdigmbMLr3Pm).
- **Charts from auto tables:** a number column over time, p95 per endpoint, status breakdown.
- **One filter query box:** e.g. `level:error logger:Payment took>1000 after:10:15`, with chips.
- **Tabs in the bottom panel,** so several results stay open, with "pop out table".
- **Large files:** stream or chunk multi-GB logs, open rotated `.gz` logs, search a whole folder.
- **Code signing:** the repo meets most SignPath Foundation (free OSS signing) requirements: MIT,
  public, built by CI. It still needs a "Code signing policy" and privacy section in the README, and
  the application. Alternatively, IT approval or allow-listing on the work laptop.
- **Custom domain:** `textforge.js.org` and `textforge.is-a.dev` were both free (checked
  2026-11-04); this needs a PR to `js-org/js.org` `cnames_active.js` by the owner, then setting the
  domain in Pages settings after the merge.
- **Engineering:** split `renderer.js` into modules, and run the Playwright suites in GitHub
  Actions.

Known limitations: the Copilot pane can't be styled (Microsoft's page); the claude.ai-hosted copy
can't re-read changed files or go truly full screen (iframe limits); the desktop zip is unsigned, so
SmartScreen may warn.

## Working with the owner

- Explain changes in plain language, with what to click; the owner tests on a Windows laptop
  (1920×1080, dark theme, Chrome / the desktop app).
- Prefers Windows-like interactions (Snap Layouts were requested explicitly).
- Wants the UI to *look* right, not just pass tests: verify visually and say what you checked.
- Ship each change as a version: bump, release notes, push, release run, and confirm the website
  and the Release finished.
