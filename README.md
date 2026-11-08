<p align="center"><img src="assets/icon-128.png" width="96" height="96" alt="TextForge icon"></p>

<h1 align="center">TextForge</h1>

A log-aware text editor for backend developers: a Notepad++-style editor that understands Spring Boot,
Logback/Log4j, JSON, access and syslog logs, keeps pasted tables as tables, and builds tables from your
logs automatically.

**Use it in the browser:** https://sudeepasundi.github.io/textforge/
**Download the portable Windows app (no installer):** [latest release](https://github.com/sudeepasundi/textforge/releases/latest)

## Features

- **Logs, detected automatically.** Levels are coloured, there's an error/warning timeline, stack traces fold,
  and you can jump between errors with F8. Filter by level, regex, logger/thread, trace ID or time range, and
  repeated errors are grouped with counts.
- **Investigate logs together (Alt+I).** Open one log per service and see them as lanes on one clock, with
  findings spotted for you: errors that spread across services, repeated errors, a service that went quiet, slow
  calls. Drag a time window to read every log's entries in order; click one to jump to that line. Switch to
  Requests to follow one trace ID across services as a waterfall, with a plain-language summary of what broke.
  Pin findings and requests, add notes, and copy the incident report for Teams or Outlook (secrets masked).
- **One query bar (Ctrl+K).** Type `level:warn+ logger:Payment took>1000 after:10:15 -healthcheck` and each
  part becomes a chip; drag on the timeline for a time-range chip. Start with `>` to run a command.
- **Auto tables.** TextForge learns the message patterns in a log and builds one table per pattern. Whatever
  changes between lines (IDs, users, durations, status words, key=value values, JSON fields) becomes a named
  column, and number columns get min / avg / p95 / max. Copy the result as a real table for Excel or Outlook,
  or as CSV.
- **Pasted tables stay tables.** This covers rich-text tables from AI chats, Excel and web pages, CSV, and
  space-aligned text. A Markdown preview renders them.
- **Files that change on disk reload by themselves.** New log lines are appended, and unsaved edits are
  never overwritten.
- **Microsoft 365 Copilot** opens in a side or floating pane in the desktop app (in a window on the web). It
  can explain an error, find the root cause or summarise a log, with secrets masked first.
- **Snap layouts, like Windows 11:** hover the split button (or drag a tab) and pick a layout: side by side,
  top and bottom, three columns, one large + two stacked, or a 2 × 2 grid. Empty spaces offer your open
  files (Snap Assist). Panes scroll together by timestamp or line, and filters, time ranges and Ctrl+F
  search apply to every pane.
- **Open files list (Ctrl+Shift+E):** every open file in the sidebar with its folder, unsaved and split markers,
  a filter box and sorting. Click to open, drag to reorder or onto the editor to show side by side.
- **Tabs:** double-click to rename (unsaved tabs too; saved files are renamed on disk), drag to reorder,
  and right-click for more options.
- **Full screen** for the preview (Alt+Shift+P), the comparison, the results panel and Copilot; Esc exits.
  The preview can also be resized by dragging its edge.
- **Resizable results panel:** drag its top edge, or maximise it.
- **Compact or comfortable density**, 6 themes and accent colours.
- **Editor:** Monaco (the editor from VS Code), with tabs, find in all tabs, multi-cursor, column select,
  diff/compare, themes and accent colours, and session restore.

## Run

- **Web:** open the link above in Chrome or Edge. Files opened with the Open button stay linked and reload
  when they change. Install it as an app from the browser menu if you like.
- **Windows:** download `TextForge-<version>-win-x64-portable.zip` from Releases, extract it to a folder you
  own and run `TextForge.exe`. The app is not code-signed yet, so Windows may warn before it opens. On a
  company laptop, ask IT to approve it.

## Icons

The icon sources are `assets/icon.svg` (large sizes) and `assets/icon-small.svg` (16–32 px). Run
`node tools/make-icons.js` to regenerate the PNGs and the Windows `icon.ico`.

## Build from source

```bash
npm ci
npm start              # run the desktop app
npm test               # unit tests
node build-web.js      # web build into web-dist/selfhost (and a single-file build in web-dist/artifact)
npm run package:win    # portable Windows app into dist/
```

Browser tests (need Playwright and `web-dist/selfhost` served at http://127.0.0.1:8765/):
`npm run test:e2e`, `npm run test:ui`, `npm run test:disk`, `npm run test:auto`.

## Releases

Pushing to `main` publishes the web version to GitHub Pages. To publish downloads, run the **Release**
workflow from the Actions tab (or push a tag such as `v0.7.0`). It builds the portable Windows zip and the
web zip and attaches them to a GitHub Release tagged with the version in `package.json`.

## Privacy

TextForge works on your files locally and sends nothing anywhere: no analytics, no telemetry. The only
network use is the Copilot pane, which loads Microsoft's own Copilot site when you open it, and, on the web
version, loading the editor's code from this site. Follow your company's policy on what log data you share
with Copilot.

## License

[MIT](LICENSE)
