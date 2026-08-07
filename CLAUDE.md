# CLAUDE.md - Project Context & Assistant Rules for WorkLog Pro Desktop

## 1. Executive Overview

WorkLog Pro Desktop is an Electron-based desktop application for tracking employee shift hours, managing daily time cards, logging reimbursable expenses, and generating client invoices — across multiple projects/customers, each tracked separately.

- **Core Stack**: Electron, Vanilla JavaScript, HTML5, Tailwind CSS (CDN), FontAwesome icons.
- **Architecture Style**: Split into a platform-agnostic `core/` layer (business logic, state, and rendering) and a thin `platform-electron/` shell (Electron main process, preload IPC bridge, and the HTML shell that loads `core/`). This split exists specifically so a future web/PWA shell can reuse `core/` unchanged — see section 4A.

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

**Coverage caveat**: see Rule 1 in section 5 — `core/*.js` and `platform-electron/*.js` **are** indexed now (they're real `.js` files); the deprecated `index.html` and `shell.html`'s markup are not, but neither has meaningful logic left to index.

## 3. Project Structure & Key Files

```
WorkLogPro-Desktop/
├── core/                    # Platform-agnostic business logic & rendering — shared by every shell
│   ├── state.js               # wt_state shape, SCHEMA_VERSION, migrations, generateId()/getMsTimestamp()
│   ├── storage.js              # persistState()/loadStoredData(), backup/restore (still localStorage)
│   ├── i18n.js                  # EN/AR invoice strings (INVOICE_I18N)
│   ├── projects.js               # Multi-project state, picker/switch flow, per-project rate editing
│   ├── shift-tracking.js          # Clock in/out, break start/end/adjust, timer display
│   ├── invoicing.js                # Invoice creation, editable preview, generateInvoiceHTML(), PDF export, signature — largest core file
│   └── ui.js                        # Shared render functions, expense/log CRUD, DOMContentLoaded bootstrap
├── platform-electron/       # Electron-specific shell — the only place platform-specific wiring lives
│   ├── main.js                # Electron main process (window management, system tray, PDF export IPC)
│   ├── preload.js               # contextBridge bridge exposing window.invoiceAPI.exportPDF to the renderer
│   └── shell.html                # Loads every core/*.js file, holds the app markup, defines window.platformAdapter
├── index.html                # DEPRECATED — unused rollback reference, scheduled for deletion. Do not edit.
├── package.json              # App metadata, npm scripts, electron dependencies ("main": "platform-electron/main.js")
├── icon.png                   # Application icon for system tray and window
└── graphify-out/              # Generated knowledge graph artifacts (covers core/ + platform-electron/*.js — see section 5)
    ├── graph.json              # Machine-readable AST index used by Claude Code
    ├── graph.html               # Interactive visual dependency graph
    └── GRAPH_REPORT.md          # Summary of detected communities & architecture
```

## 4. Key Application Logic & Architecture Principles

### A. Core / Platform Split

The app is split into a shared `core/` layer (platform-agnostic business logic and UI rendering) and `platform-electron/` (the Electron-specific shell and main process).

**`core/`** — no file here may reference `window.invoiceAPI` or any other Electron API directly. All platform-specific calls go through `window.platformAdapter`, defined once by whichever shell loads `core/`:

- `state.js` — `wt_state` shape, `SCHEMA_VERSION`, migrations, `generateId()`/`getMsTimestamp()` utilities.
- `storage.js` — `persistState()`/`loadStoredData()`, backup/restore (`exportData()`/`importData()`).
- `i18n.js` — EN/AR strings (`INVOICE_I18N`).
- `projects.js` — multi-project state, picker/switch logic, per-project rate editing.
- `shift-tracking.js` — clock in/out, break start/end/adjust, timer display logic.
- `invoicing.js` — invoice creation, editable preview, PDF HTML generation, and signature handling. The largest core file.
- `ui.js` — shared render/DOM update functions, expense/log CRUD, and the `DOMContentLoaded` bootstrap.

**`platform-electron/`** — the only place platform-specific wiring is allowed to live:

- `main.js` — Electron main process.
- `preload.js` — IPC bridge, exposes `window.invoiceAPI`.
- `shell.html` — loads every `core/*.js` file (in dependency order: `state → storage → i18n → projects → shift-tracking → invoicing → ui`), holds the app's HTML markup (byte-identical to the old `index.html`'s), and defines `window.platformAdapter`, which wraps `window.invoiceAPI` calls.

This split exists so a future `platform-web/` shell (a PWA — **not yet built**) can load the exact same `core/*.js` files, define its own `window.platformAdapter` (backed by Supabase sync and a service worker instead of Electron IPC), and reuse all of the business logic with zero changes to `core/`.

**Old `index.html`** still exists at the project root but is **unused and deprecated** — kept temporarily as a rollback reference in case the split needs to be reverted, scheduled for deletion once the split is confirmed stable in production use. Do not edit it or add features to it; add new logic to the appropriate `core/*.js` file instead.

### B. Core Functions

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

**PDF export**: `exportInvoiceToPDF()` (in `core/invoicing.js`) calls `window.platformAdapter.exportPDF(html, suggestedFileName)` — never `window.invoiceAPI` directly, per the core/platform split in section 4A. In `platform-electron/shell.html`, `window.platformAdapter.exportPDF` wraps `window.invoiceAPI.exportPDF`, which `platform-electron/preload.js` exposes via `contextBridge`. Because `platform-electron/main.js` sets `contextIsolation: true` (and `nodeIntegration: false`) on the `BrowserWindow`, the renderer has no direct filesystem or `printToPDF` access — `preload.js` is the only sanctioned bridge, forwarding to `ipcMain.handle('export-invoice-pdf', ...)` in `main.js`, which opens a native save dialog, renders the HTML in a hidden offscreen `BrowserWindow`, and calls `webContents.printToPDF()`. Do not "simplify" this by relaxing `contextIsolation`/adding `nodeIntegration`, or by having `core/invoicing.js` call `window.invoiceAPI` directly — extend `window.platformAdapter` and the preload bridge instead.

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

### I. Electron Main Process & Preload Bridge (platform-electron/main.js / platform-electron/preload.js)

`platform-electron/main.js` manages window lifecycle, system tray integration, and background minimization (`win.hide()` on window close), and loads `platform-electron/shell.html` (not `index.html`) into the `BrowserWindow`. It also owns the `ipcMain.handle('export-invoice-pdf', ...)` handler described in section E. `platform-electron/preload.js` is the only file exposed to the renderer via `webPreferences.preload`; it exposes exactly one method (`window.invoiceAPI.exportPDF`) through `contextBridge.exposeInMainWorld`, deliberately minimal — no generic IPC passthrough, no Node API surface. `shell.html` then wraps that in `window.platformAdapter` for `core/` to call — see section 4A.

## 5. Rules for Claude Code

1. **The graph now covers the real logic — use it.** Unlike the old single-file `index.html` (whose inline `<script>` graphify could never parse), `core/*.js` and `platform-electron/*.js` are real `.js` files that graphify's AST extractor **does** index. Query the graph first (`graphify query "<question>"` or `graphify-out/graph.json`) for questions about clock-in logic, invoicing, projects, persistence, etc. The deprecated `index.html` and `shell.html`'s markup are still not indexed, but that no longer matters — `shell.html` has no logic of its own (just `<script src>` tags and the `window.platformAdapter` shim), and `index.html` is unused.
2. **Never resurrect `index.html`.** It's deprecated, kept only as a rollback reference. If asked to add or fix a feature, make the change in the appropriate `core/*.js` file (see section 4A for which file owns what), not in `index.html`.
3. **Preserve the core/platform split**: `core/*.js` files must never reference `window.invoiceAPI` or any other Electron-specific API directly — go through `window.platformAdapter`. This is what lets a future `platform-web/` shell reuse `core/` unchanged. If a new platform capability is needed, add a method to `window.platformAdapter` in `platform-electron/shell.html` (and eventually every other shell) rather than reaching into a platform API from `core/`.
4. **Don't break the versioned persistence pattern**: any new field added to `wt_state` needs a `SCHEMA_VERSION` bump and a migration block in `loadStoredData()` (`core/storage.js`) following the existing v1→v2→v3 pattern (section C) — never rename or repurpose an existing field in place.
5. **Keep the graph updated**: after renaming, adding, or refactoring functions in `core/*.js` or `platform-electron/*.js`, run `graphify extract . --code-only` — this is now genuinely useful for the whole app, not just the Electron main process.
