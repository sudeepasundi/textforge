TextForge - log-aware text editor for backend developers (portable, no install)
===================================================================================

RUN IT
  1. Extract this whole zip to a folder you own, e.g. C:\Users\<you>\Tools\TextForge
  2. Double-click TextForge.exe. (Right-click > Send to > Desktop for a shortcut.)
  If Windows says "Windows protected your PC", click More info > Run anyway
  (the app is not code-signed). If your company blocks it, ask IT first.

TRY IT: open samples\order-service.log (inside resources\app\samples).

LOGS
  Logs are detected automatically when you open a .log file or paste log lines:
  Spring Boot, Logback/Log4j, JSON (Logstash/ECS), HTTP access logs, syslog, Tomcat.
  - Signal strip: errors and warnings over time. Click a spike to jump there.
  - Ctrl+1  Log insights: level toggles (double-click = only that level), regex filters,
            logger/thread, trace ID, time range, repeated errors grouped with counts.
  - Ctrl+2  Extract data: response times, HTTP calls, exceptions, IDs, Kafka offsets,
            key=value pairs, JSON fields or your own regex -> sortable table with
            min / avg / p95 / max. Copy as a real table for Excel/Outlook, or CSV.
  - Ctrl+3  Highlight rules: any regex, any colour. Set "Your packages"
            (e.g. com.mycompany) so your stack frames stand out and framework frames dim.
  - F8 / Shift+F8 next / previous error. Right-click an ID to filter by it.
  - Follow (status bar) tails a growing log file. Merge open logs by time.
  - Mask secrets: passwords, tokens, JWTs, keys, emails, cards, PAN.

COPILOT (Ctrl+4)
  Opens Microsoft 365 Copilot inside the app; sign in once with your work account.
  Explain error / Find root cause / Summarize / Suggest fix build a prompt from your
  log, mask secrets, let you review it, then put it in Copilot's message box.
  If your company only allows sign-in from managed browsers (Edge), the embedded
  sign-in may be refused: use the open-in-browser button instead. Prompts are always
  copied to the clipboard, so Ctrl+V into Copilot in Edge works too.
  Follow your company's policy on what log data may be shared with Copilot.

EVERYTHING ELSE
  Ctrl+Shift+P searches every command. Tabs, regex find/replace, find in all tabs
  (Ctrl+Shift+F), multi-cursor, column select (Alt+Shift+drag), folding, themes and
  accent colours, encodings, unsaved work restored on restart.
  Paste from Excel / web pages keeps tables (Ctrl+Shift+V pastes plain text).

YOUR DATA
  Settings and session: %APPDATA%\TextForge. Remove the app by deleting this folder.

WEB VERSION
  The same editor also runs in Edge / Chrome with nothing to install. Use the
  TextForge-0.5.1-web zip (host it, or run serve-web.bat) or the link you were given.
  Alt+1..4, Alt+N, Alt+W and Alt+T work in both versions.

TABLES WITHOUT TABS (0.2.2)
  Text whose columns are separated by single spaces (common when copied from chat,
  email or PDFs) is pasted as a table when it has a header row; the columns are
  guessed, so the toast offers "Keep as plain text". Without a header you get a
  "Convert to table" button. Fix any guessed column in Table View (Alt+T) with
  Merge column with next / Split column / Delete column.
  Ctrl+A selects all text even after clicking the sidebar; it is also on the right-click menu.

TEAMS-LIKE PASTE AND PREVIEW (0.3.0)
  Copy a whole AI chat (or a wiki page, Teams or Outlook message) and paste it: headings,
  lists, code blocks and every table are kept as Markdown with aligned columns.
  Alt+P opens the Preview: real tables (click a header to sort), code blocks, lists.
  "Copy as rich text" in the preview pastes into Teams, Outlook or Word with tables intact.
  Each preview table has "Copy table" and "Edit as table".

MORE LOG TOOLS (0.3.0)
  Find duplicate lines and repeated entries; Extract timestamps / IP addresses with
  "Count by value" for unique counts; Copy shown entries (only what the filter shows);
  Compare with another tab (side-by-side diff); stack traces logged one line at a time
  are joined to their error; IPs and IDs such as TXN90045 are highlighted.
  CSV pastes offer "Convert to table". Table View can sort by column.

FLOATING COPILOT (0.4.0)
  The round Copilot button at the bottom right of the editor (or Alt+4) opens Copilot
  in a pane over the editor: drag it by its title bar, resize it from the corner, or
  dock it to the right side (button next to X). Your sign-in and chat stay put when you
  dock or undock. In the web version Copilot opens as a slim window on the right of
  your screen, because Microsoft does not allow it inside other web pages.

MULTI-LINE FILTERS (0.4.0)
  "Lines matching", "Hide lines matching" and "Trace / request IDs" take one pattern
  per line (Enter for the next). Lines matching can match any line or all lines.
  Right-click "Show only entries containing this" / "Hide entries containing this"
  add a new line each time.

LARGE FILES (0.5.0)
  Files up to 500 MB open (was 100 MB). Measured on a 7 GB test machine without a GPU:
    250 MB / 2.5 million lines: ~16 s to open, error filter ~2 s, ~1.6 GB memory
    450 MB / 4.4 million lines: ~30 s to open, error filter ~4 s, ~3.2 GB memory
  Opening shows progress. Use a PC with 8 GB of RAM or more for files over 250 MB.
  500 MB is the ceiling: JavaScript cannot hold more text than that in one piece.
  For bigger files, split them first (e.g. Git Bash: split -l 2000000 big.log part_).

POLISHED UI (0.6.0)
  One title bar: the minimise / maximise / close buttons now sit in TextForge's own top
  bar and follow the theme colours; drag the empty part of the bar to move the window.
  Copilot pane resizing:
    Docked   - drag its left edge (300 px up to the window width minus 420 px).
    Floating - drag any edge or corner; drag the title to move it.
    Double-click an edge to reset the size. Sizes are remembered.
  The round Copilot button hides while the pane is open.
  An empty tab shows a welcome card (Open file / Try the sample log / Commands);
  clicking the card or typing starts editing.
  Tabs shrink to fit, the status bar is quieter, keyboard focus is visible, and
  button and link colours meet WCAG contrast in all 6 themes x 6 accent colours.
  Preview of a non-Markdown file shows it as plain text instead of reflowed lines.
  UI tests: npm run test:ui (web) and npm run test:ui:desktop (desktop window).

FILES CHANGED ON DISK (0.6.1)
  Open files are checked every 2 seconds (and when you switch back to TextForge).
  If another program changes a file:
    - no unsaved edits in TextForge: the new text loads by itself. New log lines are
      just added at the end; if you were at the bottom, the view follows them.
      A full rewrite reloads the tab; Ctrl+Z brings back the previous text.
    - unsaved edits: a notice asks "Reload from disk" or "Keep my version".
    - file deleted or moved: a notice says so; Save writes it back.
  Web version: in Chrome / Edge, a file opened with the Open button or dragged in
  stays linked and reloads the same way. Inside the claude.ai page the browser only
  allows a one-time copy, so a change shows "Pick file again" (one click to reload).
  For hands-free reloading on the web, use the self-hosted web version or the
  desktop app.
  Fixed: the Open button sometimes did nothing when Windows took a moment to hand
  over the file (OneDrive / network folders).

AUTO TABLES (0.7.0)
  Extract now starts on "Auto-detect tables": no pattern to choose or write.
  TextForge learns the message patterns in the log by itself and builds one table per
  pattern. Whatever changes between lines becomes a column, named from the words
  around it:
    "POST /api/orders userId=4512 orderId=90001 took 84ms"
        -> columns time | thread | traceId | userId | orderId | took (ms)
    "Payment succeeded/failed for order 1234 in 45 ms"
        -> one table, columns Payment | order | ms (similar messages are merged)
    "Order ORD-1 moved from PAID to SHIPPED by ravi" -> Order | from | to | by
    CPU_USAGE=64% MEM=8GB -> CPU_USAGE (%) | MEM (GB)
  It also adds level / thread / logger when they vary, the trace ID, and for errors
  the exception and its root cause ("caused by"). JSON logs get their other fields
  as columns; access logs get one request table with a "route" column
  (/api/orders/{id}) so you can count by endpoint.
  How to use: Ctrl+2 (Extract) -> Build tables, or Ctrl+Shift+P -> "Auto tables".
  The left list shows every pattern with its count (filter it by typing); click one
  to see its table. Copy as table, Copy CSV, Count by value and Filter log to these
  lines work as before, and number columns get min / avg / p95 / max.
  The first 300,000 entries are used (about 2 s); the title says when a log is
  bigger. The specific extractors (response times, SQL, Kafka, custom regex, ...)
  are still in the same list.

SPLIT VIEW, DENSITY AND NEW ICON (0.8.0)
  Split view (Ctrl+\ or the split button in the top bar) shows another tab on the
  right. Pick the tab at the top of the right side. "Scroll together" keeps both
  sides in step: by time (two services' logs stay at the same moment), by line, or
  off. Drag the divider to resize (double-click resets to half), and use the swap
  button to swap sides. Ctrl+S saves the side you are typing in.
  Appearance (Ctrl+,) > Density: Compact gives smaller bars, tabs and side rail, and
  tighter editor lines.
  The sidebar no longer opens by itself: click a rail button (or Ctrl+1/2/3) when you
  need it. Copilot lives on the round button (Alt+4); its rail button is gone.
  New app icon for the window, taskbar, exe and website.

TIMELINE RANGE AND COPILOT SIGN-IN (0.8.1)
  Drag across the timeline strip above a log to show only that time range (the rest
  of the strip is dimmed, and From / To in Log insights fill in). Double-click the
  strip to show all times again. A single click still jumps to that moment.
  Copilot: after the first sign-in, the Copilot pane opens straight into Copilot on
  every start. Appearance (Ctrl+,) > Copilot > "Sign out of Copilot" forgets it.

TABS, SPLIT VIEW AND RESULTS PANEL (0.9.0)
  Tabs: double-click a tab to rename it (Enter to keep, Esc to cancel). It works for
  unsaved tabs too: Save then suggests the new name. A saved file is renamed in its
  folder; an existing file is never overwritten. Drag tabs to change their order.
  Right-click a tab for Rename, Show beside, Move, Copy file path, Close and Close
  other tabs.
  Split view now holds up to 4 files: drag a tab onto the editor to add it beside, or
  onto a pane to show it there instead. Each pane has its own file list, swap and
  close buttons, and the dividers can be dragged. Filters (levels, text, logger,
  trace IDs, time range, including a range dragged on the timeline) and Ctrl+F
  search apply to every pane. "Scroll together" keeps every pane at the same time.
  Results panel (tables, counts, duplicates): drag its top edge to resize it,
  double-click the edge to reset, or use the expand button (Ctrl+Shift+M).

SNAP LAYOUTS (0.10.0)
  Split view now works like Windows 11 Snap Layouts.
  - Hover (or click) the split button in the top bar: five layouts appear - side by
    side, top and bottom, three columns, one large + two stacked, and a 2 x 2 grid.
    Click the space where the current file should go.
  - Spaces left empty show your open files as cards (Snap Assist): click one to fill
    the space, or "Leave this space out".
  - Drag a tab over the editor: the same layouts appear at the top. Drop the tab on a
    space in one of them. Or drop it straight onto the editor: the right half opens it
    side by side, and an existing pane shows it there instead. An outline shows where
    it will land.
  - Drag the dividers to resize; double-click a divider to make the spaces equal.
  - Ctrl+\ still opens / closes two files side by side in one step.
  - On a phone the files stack top to bottom.

OPEN FILES LIST (0.11.0)
  The top icon in the side rail (Ctrl+Shift+E) lists every open file, with its folder.
  It marks the file in the editor ("open"), files in split view ("split"), logs, and
  unsaved changes (dot). Type to filter (Enter opens the first match), sort by tab
  order, name, recently used or type, and use the arrow keys plus Enter to move around.
  Click a file to open it, double-click (or F2) to rename, Delete or the x to close,
  and right-click for the tab menu. Drag files to change their order, or drag one onto
  the editor or the snap bar to show it side by side.
  The tab bar stays: tab names are no longer squeezed, the bar scrolls sideways
  instead (the mouse wheel scrolls it).

RESIZABLE PREVIEW AND FULL SCREEN (0.12.0)
  Preview: drag its left edge to make it wider or narrower (double-click the edge to
  reset to half). The width is remembered.
  Full screen: the preview, the comparison, the results panel and the Copilot pane
  each have a full-screen button (four corners). Double-clicking the preview or
  comparison header does the same, and Alt+Shift+P opens the preview straight in full
  screen. Esc (or the same button) goes back; the window returns to exactly the size
  and position it had. Alt+P still shows / hides the preview beside the editor.
  Also: double-click the sidebar edge to reset its width, and settings changed just
  before closing the app are no longer lost.

PREVIEW LAYOUT FIXES (0.12.1)
  The preview uses the width you give it: no blank band on the right when it is
  stretched, and its scrollbar sits at the edge. Full screen is a proper reading view:
  a wide column, larger text, bigger tables and the file name in the header. Table
  buttons (Copy table / Edit as table) now sit at their own table's corner. The
  comparison view no longer shows an empty strip between its two sides.

TAURI PREVIEW BUILD (0.13.0)
  TextForge is moving to a new desktop engine (Tauri, written in Rust). This release
  adds a preview build next to the usual one; the usual Electron download is
  unchanged and still the main version.
  The preview is a single small TextForge.exe (about a tenth of the size). Like the
  main download it needs no installer: unzip and double-click. It uses the Edge
  WebView2 that comes with Windows 11.
  What to try: open, save and rename files, live tail, files changing on disk, split
  view, full screen, and the Copilot pane (sign in once; the sign-in is kept).
  Known differences in the preview: dragging a file from Explorer into the window
  opens a copy (Save asks where to save; File > Open keeps the link to the file),
  and hovering the maximize button does not show Windows snap layouts (Win+Z does).

QUERY BAR, TIME RANGE CHIP AND RESULT TABS (0.14.0)
  The title bar now holds one query bar (Ctrl+K). Type a filter and press Enter; each
  part becomes a chip you can remove with its x (or Backspace in the empty box):
    level:error   level:warn+   logger:Payment   trace:c3e09f1a   took>1000   took>1.5s
    after:10:15   before:10:17   time:10:15..10:17   -healthcheck   "a phrase"   re:regex
  Start with > to run a command (for example >split). In a file that is not a log, the
  box finds text instead.
  The time range is its own chip with a clock: drag on the timeline to set it, and
  remove the chip or double-click the timeline to clear it.
  "4 errors" and "3 warnings" on the timeline are buttons: one click shows only that
  level, a second click shows everything again.
  File tabs moved to their own row under the title bar. The status bar says how many
  entries the filter shows, with Copy shown and Clear filter.
  Results under the editor keep a tab per kind (auto tables / extract, table view, find
  in tabs), so you can switch between them without losing either.
  On a phone the query bar gets its own row under the title bar.

PATTERNS FOUND, TOOLBAR ON SELECTED TEXT, COPILOT BADGE (0.15.0)
  Extract data (Ctrl+2) now lists the message patterns of the log straight away, with
  row counts and columns. One click opens that pattern's table under the editor. (Files
  over 20,000 lines wait for Build tables so the panel stays quick.)
  Selecting text shows a small toolbar just above it: Table from selection, Copy masked,
  Show only entries with this (for a short one-line selection in a log) and Ask Copilot.
  Turn it off or on again from the command palette ("Hide the toolbar on selected text").
  The Copilot button shows a red number: how many errors the current log has.

UPDATES REACH OPEN TABS, COPILOT BUTTON STAYS PUT (0.15.1)
  Web version: a tab that stays open now finds new versions by itself (when you come
  back to it, and every hour) and shows "A new version of TextForge is ready" with a
  Reload button; your tabs are kept. A plain reload also always gets the newest version
  now (before, the browser could keep showing an old copy until it was reloaded twice).
  It still works offline.
  The Copilot button stays in the bottom-right corner instead of climbing up with the
  results panel, where it could end up over the editor text.
  Copilot in full screen (browser version) keeps its introduction at a readable width.
  Help (?) shows which version you are running; so does hovering the TextForge logo.

INVESTIGATE LOGS TOGETHER: THE INCIDENT VIEW (0.16.0)
  Open the logs of several services (one file each) and press Alt+I, or use "Investigate
  these logs together" at the top of the Open files list. Each log becomes a lane on one
  shared clock; dots are entries (bigger = more, red = errors, amber = warnings).
  On the left, findings TextForge spots by itself: errors that hit several services at
  the same moment, repeated errors, a service that goes quiet while the others report
  errors calling it, and slow calls. Click one to see its lines.
  Drag across the lanes to look at a time window: the list on the right shows every log's
  entries for that window in time order. Double-click clears it. Click a dot for its
  entries. Click any entry to open that log at that line; "Back to the incident" returns.
  Copy findings gives a short text report with secrets masked.
  To try it: command palette (Ctrl+Shift+P) > "Try the incident sample".
