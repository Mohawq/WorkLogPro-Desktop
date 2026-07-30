# CLAUDE.md - Project Context & Assistant Rules for WorkLog Pro Desktop

## 1. Executive Overview

WorkLog Pro Desktop is an Electron-based desktop application designed for tracking employee shift hours, managing daily time cards, and logging reimbursable expenses.

- **Core Stack**: Electron, Vanilla JavaScript, HTML5, Tailwind CSS (CDN), FontAwesome icons.
- **Architecture Style**: Single-file frontend architecture (`index.html` holds UI layout, styling, and application logic) coupled with an Electron main process (`main.js`).

## 2. Quick Reference Commands

### Development & Build Commands

- `npm start` — Launches the application in Electron development mode.
- `npm run build` — Compiles and packages the standalone Windows installer (.exe) into `dist/`.

### Graphify Knowledge Graph Commands

- `graphify extract . --code-only` — Re-scans code files and updates AST indexing.
- `graphify cluster-only .` — Re-clusters communities and updates `GRAPH_REPORT.md` + `graph.html`.
- `graphify query "<question>"` — Traverses the project dependency graph to answer structural queries.
- `graphify affected "<file>"` — Lists all dependent functions/modules affected by changes to a file.
- `graphify god-nodes` — Lists key architectural hub nodes in the graph.

## 3. Project Structure & Key Files

```
WorkLogPro-Desktop/
├── index.html            # Main UI layout, styles, and full JS frontend logic
├── main.js               # Electron main process (window management & system tray)
├── package.json          # App metadata, npm scripts, and electron dependencies
├── icon.png               # Application icon for system tray and window
└── graphify-out/          # Generated knowledge graph artifacts
    ├── graph.json          # Machine-readable AST index used by Claude Code
    ├── graph.html           # Interactive visual dependency graph
    └── GRAPH_REPORT.md      # Summary of detected communities & architecture
```

## 4. Key Application Logic & Architecture Principles

### A. Single-File Frontend Principle

All HTML markup, embedded JavaScript logic, and Tailwind CSS utility classes reside strictly inside `index.html`. Do not create separate `.js` or `.css` files for the web frontend unless explicitly requested.

### B. Core Functions (index.html)

- `consolidateDailyLogs()`: Automatically groups and merges multiple work sessions logged on the same calendar day into a single daily shift entry.
- `renderUI()` / `renderLogsTable()` / `renderExpensesTable()`: Updates status badges, active timers, time card tables, and expense tables.
- `clockIn()`, `startBreak()`, `endBreak()`, `clockOut()`: State transitions for real-time shift timing.

**Local Storage Persistence Keys:**

- `wt_active_shift`: Current active shift timing object.
- `wt_shift_logs`: Completed daily time card records.
- `wt_expenses`: Reimbursable expense entries and base64 attachments.
- `wt_hourly_rate`: Set hourly pay rate.

### C. Electron Main Process (main.js)

Manages window lifecycle, system tray integration, and background minimization (`win.hide()` on window close).

## 5. Rules for Claude Code

- **Graph-First Query Navigation**: Whenever asked a question about how a feature works, where logic is located, or how components interact, always query the knowledge graph first (via `graphify query "<question>"` or checking `graphify-out/graph.json`). Use the graph nodes to jump directly to the precise function or code section, rather than reading through project files one by one.
- **Consult Knowledge Graph Before Changes**: Before undertaking multi-file refactors or structural updates, check `graphify-out/graph.json` or execute `graphify affected "<file>"` to understand caller/callee dependencies.
- **Preserve Authentic Single-File Web Structure**: Ensure modifications to `index.html` keep JavaScript and CSS inline without breaking existing state or LocalStorage persistence keys.
- **Keep Graph Updated**: If you rename, add, or refactor functions, run `graphify extract . --code-only` to maintain graph synchronization.
