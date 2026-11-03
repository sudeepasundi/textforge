# TextForge

A log-aware text editor for backend developers: a Notepad++-style editor that understands Spring Boot,
Logback/Log4j, JSON, access and syslog logs, keeps pasted tables as tables, and builds tables from your
logs automatically.

**Use it in the browser:** https://sudeepasundi.github.io/textforge/
**Download the portable Windows app (no installer):** [latest release](https://github.com/sudeepasundi/textforge/releases/latest)

## Features

- **Logs, detected automatically.** Levels are coloured, there's an error/warning timeline, stack traces fold,
  and you can jump between errors with F8. Filter by level, regex, logger/thread, trace ID or time range, and
  repeated errors are grouped with counts.
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
- **Editor:** Monaco (the editor from VS Code), with tabs, find in all tabs, multi-cursor, column select,
  diff/compare, themes and accent colours, and session restore.

## Run

- **Web:** open the link above in Chrome or Edge. Files opened with the Open button stay linked and reload
  when they change. Install it as an app from the browser menu if you like.
- **Windows:** download `TextForge-<version>-win-x64-portable.zip` from Releases, extract it to a folder you
  own and run `TextForge.exe`. The app is not code-signed yet, so Windows may warn before it opens. On a
  company laptop, ask IT to approve it.

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

Pushing to `main` publishes the web version to GitHub Pages. Pushing a tag such as `v0.7.0` builds the
portable Windows zip and the web zip and attaches them to a GitHub Release.

## Privacy

TextForge works on your files locally and sends nothing anywhere: no analytics, no telemetry. The only
network use is the Copilot pane, which loads Microsoft's own Copilot site when you open it, and, on the web
version, loading the editor's code from this site. Follow your company's policy on what log data you share
with Copilot.

## License

[MIT](LICENSE)
