# CLAUDE.md - Project Context & Assistant Rules for WorkLog Pro Desktop

## 1. Executive Overview

WorkLog Pro Desktop is an Electron-based desktop application for tracking employee shift hours, managing daily time cards, logging reimbursable expenses, and generating client invoices — across multiple projects/customers, each tracked separately.

- **Core Stack**: Electron (desktop) + a PWA (web), Vanilla JavaScript, HTML5, Tailwind CSS (CDN), FontAwesome icons.
- **Architecture Style**: Split into a platform-agnostic `core/` layer (business logic, state, and rendering) and two thin shells that both load it unchanged: `platform-electron/` (the Windows desktop app — Electron main process, preload IPC bridge, single-page `shell.html`) and `platform-web/` (a PWA deployed to Vercel — see section 4J). Storage is still plain `localStorage` on **both** platforms, independently — there is no backend or sync between them yet (Supabase-backed sync has been discussed as a future `window.platformAdapter` backend but is not implemented anywhere).

## 2. Quick Reference Commands

### Development & Build Commands

- `npm start` — Launches the application in Electron development mode.
- `npm run build` — Compiles and packages the standalone Windows installer (.exe) into `dist/`.

### platform-web/ (PWA) Build & Deploy

- `cd platform-web && npm run build` — runs `build.js`, which copies `../core/*.js` and `../icon.png` into `platform-web/core/` and `platform-web/icon.png` (gitignored copies — see `platform-web/.gitignore`). Required before `platform-web/index.html` will actually load `core/` locally; Vercel runs this exact same command as its build step.
- Deployed on Vercel with **Root Directory** set to `platform-web/` and **"Include source files outside of the Root Directory in the Build Step"** enabled in Project Settings (a dashboard toggle, not a committed `vercel.json`) — without it, `../core` and `../icon.png` don't exist in the build container and the build fails. See section 4J for the full picture.

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
├── platform-electron/       # Electron-specific shell — desktop app, single-page shell.html layout (unaffected by the platform-web mobile redesign)
│   ├── main.js                # Electron main process (window management, system tray, PDF export IPC)
│   ├── preload.js               # contextBridge bridge exposing window.invoiceAPI.exportPDF to the renderer
│   └── shell.html                # Loads every core/*.js file, holds the app markup, defines window.platformAdapter
├── platform-web/            # PWA shell — deployed to Vercel, mobile-redesigned (tabbed layout) — see section 4J
│   ├── index.html              # Entry point — named index.html, not shell.html, so Vercel serves it at "/"; loads core/*.js + pdf-export.js + mobile-nav.js
│   ├── mobile-nav.js             # Tab-switching (#tab-timer/#tab-expenses/#tab-invoices) + settings-sheet toggle — pure DOM show/hide, no state access
│   ├── pdf-export.js              # window.platformAdapter.exportPDF via window.open()+document.write()+print() — no filesystem access on the web
│   ├── build.js                    # Vercel build step: copies ../core/*.js + ../icon.png into platform-web/core/ + platform-web/icon.png (gitignored)
│   ├── service-worker.js            # App-shell caching for PWA installability only — NOT an offline data-sync layer; storage.js is still plain localStorage
│   ├── manifest.json                 # PWA manifest (name, icons, theme-color)
│   ├── package.json                   # "build" script only — runs build.js
│   ├── .gitignore                      # Excludes the build-time copies (core/, icon.png) below — root core/ is always the source of truth
│   ├── core/                            # GITIGNORED — build.js's copy of ../core/*.js, regenerated every build, never hand-edited
│   └── icon.png                          # GITIGNORED — build.js's copy of ../icon.png
├── index.html                # DEPRECATED — unused rollback reference at the project ROOT, unrelated to platform-web/index.html above (same filename, different file). Do not edit; scheduled for deletion.
├── package.json              # App metadata, npm scripts, electron dependencies ("main": "platform-electron/main.js")
├── icon.png                   # Application icon for system tray and window (also the source build.js copies into platform-web/)
└── graphify-out/              # Generated knowledge graph artifacts (covers core/ + platform-electron/*.js — see section 5)
    ├── graph.json              # Machine-readable AST index used by Claude Code
    ├── graph.html               # Interactive visual dependency graph
    └── GRAPH_REPORT.md          # Summary of detected communities & architecture
```

## 4. Key Application Logic & Architecture Principles

### A. Core / Platform Split

The app is split into a shared `core/` layer (platform-agnostic business logic and UI rendering) and two shells that each load it unchanged: `platform-electron/` (the Electron-specific shell and main process) and `platform-web/` (the PWA shell — see section 4J).

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

This split is what lets `platform-web/` — a PWA that now **exists and is deployed to Vercel** (see section 4J for the full picture) — load the exact same `core/*.js` files, define its own `window.platformAdapter` (backed by `window.open()`+`print()` for PDF export and a service worker for install/offline-shell caching only — storage is still plain `localStorage`, same as Electron, **not** Supabase), and reuse all of the business logic with zero changes to `core/`.

**Old `index.html`** — the one at the project **root** (not `platform-web/index.html`, which is a different, currently-active file — see section 4J) — still exists but is **unused and deprecated**, kept temporarily as a rollback reference in case the split needs to be reverted, scheduled for deletion once the split is confirmed stable in production use. Do not edit it or add features to it; add new logic to the appropriate `core/*.js` file instead.

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

**Scope flag — this does NOT extend to the app shell.** EN/AR + RTL support is scoped **only** to `generateInvoiceHTML()`'s output (the generated/printed invoice document itself, rendered into an iframe or a print window). There is no bilingual toggle and no `dir="rtl"` anywhere in either shell's own UI — not `platform-electron/shell.html`, not `platform-web/index.html` (including its tab bar/header added in the mobile redesign, section 4J). `setInvoiceLanguage()` only ever mutates `invoiceDraft.language`; nothing sets `document.documentElement.dir` or swaps shell-level UI strings. Don't assume app-wide RTL/i18n exists in future work on either platform — building it would be new scope, not a fix.

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

### J. platform-web/ (PWA Shell)

`platform-web/` is the second shell alongside `platform-electron/` — a PWA that loads the exact same `core/*.js` files and is deployed to Vercel. It is not hypothetical or future work; it exists and is live.

**Deployment**: Vercel project configured with **Root Directory = `platform-web/`** and **"Include source files outside of the Root Directory in the Build Step" enabled** (a Project Settings dashboard toggle — there is no committed `vercel.json`). Without that toggle, Vercel's build container never checks out `../core` or `../icon.png`, and `build.js` fails fast with a message pointing at exactly this setting.

**Build step** (`platform-web/build.js`, run via `npm run build` inside `platform-web/`, and by Vercel automatically as its build command): copies `../core/*.js` → `platform-web/core/*.js` and `../icon.png` → `platform-web/icon.png`. These copies are gitignored (`platform-web/.gitignore`) — the root `core/` is always the one source of truth; the copies are regenerated on every build and must never be hand-edited.

**Entry point is `index.html`, not `shell.html`**: unlike `platform-electron/shell.html`, this file is named `index.html` because Vercel (like any static host) serves `index.html` automatically at `/` — a file named `shell.html` would need extra routing config to be the default page. `platform-web/index.html` loads `core/*.js` in the same dependency order as `platform-electron/shell.html` (`state → storage → i18n → projects → shift-tracking → invoicing → ui`), then `pdf-export.js`, then `mobile-nav.js`, and defines its own `window.platformAdapter`.

**`window.platformAdapter.exportPDF`** here is `webPrintExport()` (`platform-web/pdf-export.js`): opens a blank window synchronously (so the browser doesn't treat it as a blocked popup), `document.write()`s the same `generateInvoiceHTML()` output every other platform uses, and calls `.print()` — the user picks "Save as PDF" (or an actual printer) themselves from the native print dialog. There's no filesystem access on the web, so unlike Electron this never produces a real file path; `result.filePath` is a human-readable placeholder string only, present for interface parity with the Electron adapter.

**Mobile UI (tabbed layout)**: `platform-web/index.html`'s markup groups `core/ui.js`'s existing render targets into three named containers — `#tab-timer`, `#tab-expenses`, `#tab-invoices` — using plain wrapper `<div>`s in the markup, **not** a JS reparenting step. `core/ui.js`'s render functions only ever look elements up by `getElementById()`, so they don't care what container an element sits in; nothing in `core/` changed to support this. `platform-web/mobile-nav.js` owns `showTab()` (toggles the `hidden` class on the three containers plus the active/inactive state on the bottom tab bar buttons) and `openSettingsSheet()`/`closeSettingsSheet()` (a slide-up sheet holding Hourly Rate, Shift Notes, Signature, Switch Project, and Backup/Restore — moved out of the main Timer tab to keep it compact). This file never reads or writes app state; it is pure DOM show/hide. All modals (Manual Entry, Expense, Create Invoice, Invoice Preview, File Viewer, Project Picker) stay outside the three tab containers as `fixed inset-0` overlay siblings, so they display correctly regardless of which tab is active underneath.

iOS safe-area handling: the viewport meta tag includes `viewport-fit=cover`, and the header/bottom-tab-bar padding uses `env(safe-area-inset-top/bottom, <fallback>)` so content clears the iPhone notch/status bar and home indicator.

**Sizing convention going forward**: `platform-web/`'s mobile UI follows Apple Human Interface Guidelines — every interactive element (buttons, icon buttons, form fields) needs a minimum 44x44px tap target, and text inputs need a minimum 16px font-size (avoids iOS Safari's zoom-on-focus behavior). Apply this to any new element added to `platform-web/index.html`, not just the ones already sized this way.

**This mobile redesign is `platform-web/`-only.** `platform-electron/shell.html` still uses its original single-page, non-tabbed layout and was not touched by it — the desktop app's UI is unaffected. If a feature needs to add a new `core/ui.js`-rendered element, it must be given an id and manually placed inside the correct tab wrapper in `platform-web/index.html` — there's no automatic routing (see also Rule 6 in section 5).

**Service worker** (`platform-web/service-worker.js`): caches the app shell (`index.html`, `manifest.json`, `pdf-export.js`, `mobile-nav.js`, `core/*.js`) for PWA installability and faster repeat visits. It is **not** an offline data-sync layer — `core/storage.js` is still plain `localStorage`, entirely unaware this cache exists. `CACHE_NAME` must be bumped (see the file's own comments) any time `SHELL_ASSETS` changes, or returning visitors keep serving the stale asset list forever.

**No Supabase sync yet.** An earlier version of this document described a hypothetical `platform-web/` backed by "Supabase sync." That was aspirational and was never built — the actual adapter described above has no network or sync layer at all. Both platforms currently read/write the same `wt_state` shape independently to their own local `localStorage`, with no data sharing between them. If Supabase-backed sync is built later, it would replace/extend `window.platformAdapter` and `core/storage.js`'s load/save functions — not require a rewrite of `core/`'s business logic.

## 5. Rules for Claude Code

1. **The graph now covers the real logic — use it.** Unlike the old single-file `index.html` (whose inline `<script>` graphify could never parse), `core/*.js` and `platform-electron/*.js` are real `.js` files that graphify's AST extractor **does** index. Query the graph first (`graphify query "<question>"` or `graphify-out/graph.json`) for questions about clock-in logic, invoicing, projects, persistence, etc. The deprecated `index.html` and `shell.html`'s markup are still not indexed, but that no longer matters — `shell.html` has no logic of its own (just `<script src>` tags and the `window.platformAdapter` shim), and `index.html` is unused.
2. **Never resurrect `index.html`.** It's deprecated, kept only as a rollback reference. If asked to add or fix a feature, make the change in the appropriate `core/*.js` file (see section 4A for which file owns what), not in `index.html`.
3. **Preserve the core/platform split**: `core/*.js` files must never reference `window.invoiceAPI` or any other Electron-specific API directly — go through `window.platformAdapter`. This is what lets `platform-web/` (section 4J) reuse `core/` unchanged today, and what would let any future shell do the same. If a new platform capability is needed, add a method to `window.platformAdapter` in **both** `platform-electron/shell.html` and `platform-web/index.html` (and any future shell) rather than reaching into a platform API from `core/`.
4. **Don't break the versioned persistence pattern**: any new field added to `wt_state` needs a `SCHEMA_VERSION` bump and a migration block in `loadStoredData()` (`core/storage.js`) following the existing v1→v2→v3 pattern (section C) — never rename or repurpose an existing field in place.
5. **Keep the graph updated**: after renaming, adding, or refactoring functions in `core/*.js` or `platform-electron/*.js`, run `graphify extract . --code-only` — this is now genuinely useful for the whole app, not just the Electron main process.
6. **`platform-web/`'s tab grouping is markup-only.** `#tab-timer`/`#tab-expenses`/`#tab-invoices` are wrapper `<div>`s in `platform-web/index.html`; `core/ui.js` has no awareness of them and never will unless something is deliberately built to give it that awareness. If a new feature adds an element that `core/ui.js` renders into, remember to also place that element (by hand, in markup) inside the correct tab wrapper in `platform-web/index.html` — there's no automatic routing. `platform-electron/shell.html` doesn't need this at all, since it has no tabs (see section 4J).
7. **Don't assume app-wide RTL/bilingual support exists.** Only `generateInvoiceHTML()`'s output (the generated invoice document) has EN/AR + RTL — see section 4F. Neither shell's own UI has a language toggle. If asked to add one, treat it as new scope to be designed, not something already there to "fix."
8. **Storage is `localStorage` only, on both platforms, with no sync between them.** Supabase-backed sync has been discussed but is not implemented anywhere (see section 4J) — don't build features, docs, or explanations that assume `platform-electron/` and `platform-web/` share data, or that assume any backend/network layer exists today.
