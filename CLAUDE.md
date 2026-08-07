# CLAUDE.md - Project Context & Assistant Rules for WorkLog Pro Desktop

## 1. Executive Overview

WorkLog Pro Desktop is an Electron-based desktop application for tracking employee shift hours, managing daily time cards, logging reimbursable expenses, and generating client invoices — across multiple projects/customers, each tracked separately.

- **Core Stack**: Electron, Vanilla JavaScript, HTML5, Tailwind CSS (CDN), FontAwesome icons.
- **Architecture Style**: Single-file frontend architecture (`index.html` holds UI layout, styling, and application logic) coupled with an Electron main process (`main.js`) and a minimal preload bridge (`preload.js`) for PDF export.

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

**Coverage caveat**: see Rule 1 in section 5 — the graph does not index anything inside `index.html`.

## 3. Project Structure & Key Files

```
WorkLogPro-Desktop/
├── index.html            # Main UI layout, styles, and full JS frontend logic
├── main.js               # Electron main process (window management, system tray, PDF export IPC)
├── preload.js             # contextBridge bridge exposing window.invoiceAPI.exportPDF to the renderer
├── package.json          # App metadata, npm scripts, and electron dependencies
├── icon.png               # Application icon for system tray and window
└── graphify-out/          # Generated knowledge graph artifacts (does not cover index.html — see section 5)
    ├── graph.json          # Machine-readable AST index used by Claude Code
    ├── graph.html           # Interactive visual dependency graph
    └── GRAPH_REPORT.md      # Summary of detected communities & architecture
```

## 4. Key Application Logic & Architecture Principles

### A. Single-File Frontend Principle

All HTML markup, embedded JavaScript logic, and Tailwind CSS utility classes reside strictly inside `index.html`. Do not create separate `.js` or `.css` files for the web frontend unless explicitly requested. `preload.js` is the one sanctioned exception — it's Electron main-process plumbing (same category as `main.js`), not frontend UI code.

### B. Core Functions (index.html)

- `consolidateDailyLogs()`: Groups and merges multiple work sessions on the same calendar day into a single daily shift entry. Runs over the full flat `logs[]` array across **all** projects, so it groups by a composite `projectId + date` key, not date alone — grouping by date alone would silently merge two different projects' shifts that happen to fall on the same day.
- `renderUI()`: Central re-render entry point — refreshes the clock status badge, the project badge, logs/expenses tables, stats, invoice history, and signature settings. Call this (or the more specific render function) after any state mutation.
- `renderLogsTable()` / `renderExpensesTable()` / `renderStats()`: Render the shift/expense tables and summary stats — all three read through `getActiveLogs()` / `getActiveExpenses()`, so they only ever show the **active project's** data.
- `clockIn()`, `startBreak()`, `endBreak()`, `clockOut()`: State transitions for real-time shift timing. `clockIn()` tags the new `currentShift` with `projectId: activeProjectId`; `clockOut()` tags the resulting log entry the same way and prices it at the active project's rate.

### C. State Persistence — the `wt_state` Versioned Envelope

All state lives under a **single** `localStorage` key, `wt_state` (constant `STORAGE_KEY`), as one JSON envelope — not separate flat keys. Current `SCHEMA_VERSION` is **3**.

**Envelope shape** (see `persistState()`):

```js
{
  schemaVersion,
  hourlyRate,       // legacy global rate — read-only migration source, see below
  currentShift, logs, expenses,
  invoices, nextInvoiceNumber, businessName, signatureImage,
  projects, activeProjectId,
}
```

**Load/save pattern**:

- `persistState()` — writes the entire envelope in one shot. `saveRate()/saveShift()/saveLogs()/saveExpenses()` are thin named wrappers kept only because HTML attributes (e.g. the rate input's `onchange="saveRate()"`) call them directly.
- `loadStoredData()` — reads and parses the envelope, normalizes shape via `normalizeShift()`/`normalizeLogs()`, and runs any pending schema migration based on the stored `schemaVersion` before persisting the upgraded shape once.
- `migrateLegacyKeys()` — one-time upgrade path for installs from **before** the `wt_state` envelope existed at all (the old flat `wt_hourly_rate` / `wt_active_shift` / `wt_shift_logs` / `wt_expenses` keys). Only runs when `wt_state` is entirely absent; removes the old keys once migrated.
- `migrateToProjectModel()` — the v2→v3 migration (see below); also invoked from `migrateLegacyKeys()` if that old-format data actually existed, so pre-v1 installs land directly on the current multi-project shape.

**What each schema version added:**

- **v2** — Invoicing: `invoices[]`, `nextInvoiceNumber`, `businessName`, `signatureImage`.
- **v3** — Multi-project support: `projects[]`, `activeProjectId`, and a `projectId` field tagged onto `currentShift` and every `logs[]`/`expenses[]`/`invoices[]` entry. The old global `hourlyRate` is kept in the envelope but is no longer the source of truth for new shifts — it's read-only, used only as the migration seed for the first auto-created project and as a last-resort fallback.

### D. Active Break Editing

`openEditActiveBreakModal()` / `closeEditBreakModal()` / `saveActiveBreakEdit()` let the user correct the accumulated break time on an **in-progress** shift (e.g. forgot to click "End Break"). Saving overwrites `currentShift.totalBreakMs` with the entered total and clears `currentShift.breakStart` — specifying the true total implies the break is over, so it also ends any break currently in progress.

### E. Invoicing

**Flow**: `openCreateInvoiceModal()` (prefills "Bill To" with the active project's name) → `loadInvoiceRecordsForRange()` (builds a checklist of the active project's shifts/expenses within a date range) → `handleCreateInvoiceSubmit()` (builds `invoiceDraft` from the checked items) → `openInvoicePreview()`.

**Editable preview**: the preview modal is a real editable form (`renderInvoiceEditor()` renders inline-editable work/expense line items, a manual "add line item" option, and a discount field) bound to `invoiceDraft`. Every edit calls `renderInvoiceLivePreview()`, which rebuilds a read-only iframe from `generateInvoiceHTML(invoiceData, lang)` — **the same function** used to generate the exported PDF, so the preview is guaranteed to match what gets printed.

**PDF export**: `exportInvoiceToPDF()` calls `window.invoiceAPI.exportPDF(html, suggestedFileName)`, exposed by `preload.js` via `contextBridge`. Because `main.js` sets `contextIsolation: true` (and `nodeIntegration: false`) on the `BrowserWindow`, the renderer has no direct filesystem or `printToPDF` access — `preload.js` is the only sanctioned bridge, forwarding to `ipcMain.handle('export-invoice-pdf', ...)` in `main.js`, which opens a native save dialog, renders the HTML in a hidden offscreen `BrowserWindow`, and calls `webContents.printToPDF()`. Do not "simplify" this by relaxing `contextIsolation` or adding `nodeIntegration` to make PDF export easier — extend the preload bridge instead.

**History & numbering**: successful exports call `saveInvoiceRecord()`, which upserts into `invoices[]` (tagged with `projectId`) and advances `nextInvoiceNumber`. `renderInvoiceHistory()` and `reopenInvoice()` are scoped to the active project the same way the shift/expense tables are.

### F. English/Arabic Invoice Language (RTL)

`setInvoiceLanguage(lang)` toggles `invoiceDraft.language` between `"en"`/`"ar"`; labels come from the `INVOICE_I18N` dictionary in `generateInvoiceHTML()`.

RTL is handled by setting `dir="rtl"` on the generated document (and its tables) and letting CSS `direction` do the work — **do not** manually reverse table cell/column arrays for Arabic. Table column order in the markup is always the same logical `date → description → … → amount` sequence in both languages; `direction: rtl` (inherited from `<html dir="rtl">`) automatically mirrors the visual column order, and manually reversing the array on top of that would double-flip it back to the wrong order. Block-level elements that need to visually mirror (the totals block, the signature block) use an explicit `isRTL ? … : …` ternary on `margin-left`/`margin-right` or `text-align` — when touching either, verify the two branches actually differ (a past regression here had both branches producing the same CSS).

### G. Signature

`signatureImage` is a base64 data URL stored **once**, globally, in `wt_state` — not per-project (a freelancer signs the same way regardless of client). Uploaded via `handleSignatureUpload()` in the Shift Settings card (PNG/JPEG only, ~1MB cap), previewed/cleared via `renderSignatureSettings()` / `removeSignature()`.

Rendering is per-invoice: `invoiceDraft.includeSignature` (checkbox, defaults to checked whenever a signature exists, hidden entirely when it doesn't) controls whether `buildInvoiceSnapshot()` passes the image through to `generateInvoiceHTML()`, which renders it as a capped-size image with a signature line and "Authorized Signature" / "التوقيع المعتمد" label near the bottom, mirrored for RTL per section F.

### H. Multi-Project / Multi-Customer Support

The app supports multiple projects/customers (e.g. "Almurooj School" plus others added later), each with its own hourly rate and its own slice of shift/expense/invoice history.

- **Shape**: `projects[]` is `{ id, name, hourlyRate, createdAt }`; `activeProjectId` selects the current one. `currentShift` and every `logs[]`/`expenses[]`/`invoices[]` entry carry a `projectId` — these remain flat arrays tagged with a project id, not nested per-project collections.
- **Scoping choke points**: `getActiveProject()`, `getActiveRate()` / `getProjectRate(projectId)`, and `getActiveLogs()` / `getActiveExpenses()` are the single source of truth for "what belongs to the current project." Any new feature that reads shifts, expenses, or the rate should go through these rather than reading `logs`/`expenses`/`hourlyRate` directly.
- **Startup flow**: `initProjectFlow()` runs after `loadStoredData()` and before the first `renderUI()`. Zero projects forces the picker with no way to close it (nothing to go back to); exactly one project auto-selects and skips the picker; two or more show the picker on every launch, requiring an explicit pick.
- **Switching**: the header's "Switch Project" control (`requestSwitchProject()`) is disabled — with an explanatory message — whenever `currentShift` is non-null, since an in-progress shift belongs to exactly one project.
- **Rate editing**: the existing Shift Settings hourly-rate field now edits the **active project's** rate (`saveRate()`), not a global value; a caption under it names which project it applies to.

### I. Electron Main Process & Preload Bridge (main.js / preload.js)

`main.js` manages window lifecycle, system tray integration, and background minimization (`win.hide()` on window close). It also owns the `ipcMain.handle('export-invoice-pdf', ...)` handler described in section E. `preload.js` is the only file exposed to the renderer via `webPreferences.preload`; it exposes exactly one method (`window.invoiceAPI.exportPDF`) through `contextBridge.exposeInMainWorld`, deliberately minimal — no generic IPC passthrough, no Node API surface.

## 5. Rules for Claude Code

1. **`index.html` is not in the knowledge graph — read it directly.** graphify's structural extractor parses `.js`/`.ts`/etc. files, but does **not** parse inline `<script>` blocks inside `.html` files. Since ~100% of this app's real logic lives in `index.html`'s inline script, the graph never indexes it, no matter how recently `graphify extract` was run. Querying the graph for anything about clock-in logic, invoicing, projects, persistence, etc. will waste a round-trip — go straight to reading/grepping `index.html`. The graph can still be useful for `main.js`/`preload.js`, which the AST extractor does cover.
2. **Consult the graph for `main.js`/`preload.js` changes only**: before refactoring the Electron main-process files, `graphify affected "main.js"` or checking `graphify-out/graph.json` is still worth doing — that part of the graph is accurate.
3. **Preserve the single-file web structure**: keep `index.html`'s JavaScript and CSS inline. Don't split frontend logic into new files; `preload.js` is main-process plumbing, not an exception to this rule.
4. **Don't break the versioned persistence pattern**: any new field added to `wt_state` needs a `SCHEMA_VERSION` bump and a migration block in `loadStoredData()` following the existing v1→v2→v3 pattern (section C) — never rename or repurpose an existing field in place.
5. **Keep the graph updated for what it can see**: if you rename, add, or refactor functions in `main.js` or `preload.js`, run `graphify extract . --code-only` to keep that part of the graph in sync. There's no equivalent benefit for `index.html` changes.
