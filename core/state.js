// core/state.js — wt_state shape, SCHEMA_VERSION, and schema migrations.
// Owns every top-level state variable and the functions that normalize or
// migrate the persisted shape. Platform-agnostic: no DOM, no localStorage
// I/O (that's storage.js), no window.platformAdapter use.

      // State Variables
      const SCHEMA_VERSION = 5; // v5 adds invoice numberSource/exported + syncConflicts[] — see migrateV4ToV5()
      const STORAGE_KEY = "wt_state";
      // Whether the user has made a first-run choice (sign in, or
      // explicitly "Continue without an account") on the sign-in-or-skip
      // screen shown before initProjectFlow() — see core/projects.js's
      // showFirstRunScreen(). A standalone key, not a wt_state field: this
      // is local UI state only, never syncs, never needs a schema
      // migration, so it doesn't belong in the versioned envelope.
      const ONBOARDING_DISMISSED_KEY = "wt_first_run_dismissed";

      let currentShift = null; // { startTime, breakStart, totalBreakMs, notes, projectId }
      let logs = [];
      let expenses = [];
      // Legacy single global rate — no longer the source of truth for new
      // shifts (rate now lives per-project), kept only as a migration
      // source and read-only fallback. See getActiveRate()/getProjectRate().
      let hourlyRate = 20.0;
      let timerInterval = null;
      let editingLogId = null;

      // Invoicing state (schema v2)
      let invoices = [];
      let nextInvoiceNumber = 1;
      let businessName = "";
      let signatureImage = null; // base64 data URL, uploaded once and reused on every invoice — global, not per-project
      let invoiceDraft = null; // the invoice currently being built/edited in the preview

      // Multi-project state (schema v3)
      let projects = []; // { id, name, hourlyRate, createdAt }
      let activeProjectId = null;

      // Sync state (schema v4 — see core/sync.js / core/sync-queue.js)
      let pendingDeletions = []; // { table, id, deletedAt, synced } — local bookkeeping only, see storage.js
      let syncCursor = null; // ms timestamp of the last successful pullChanges()
      // businessName/signatureImage sync to the single-row user_settings
      // table (see migrations/002_worklogpro_sync_rpc.sql's
      // upsert_user_settings) but, unlike every array-based record, don't
      // carry their own per-item updatedAt — this is that field for the
      // two of them together. Set by storage.js's stampAndSyncSettings().
      let userSettingsUpdatedAt = null;
      // A genuine invoice-number collision between two already-exported
      // invoices from different devices (schema v5) — see
      // core/sync.js's pushOneOp() (SQLSTATE 23505 handling) and
      // core/auth.js's renderSyncConflicts(). Never auto-resolved; surfaced
      // in the Cloud Sync settings UI for the user to renumber by hand.
      let syncConflicts = []; // { table: 'invoices', id, detectedAt }

      // Helper to safely convert any date/timestamp format into numeric milliseconds
      function getMsTimestamp(val) {
        if (!val) return Date.now();
        if (typeof val === "number" && !isNaN(val)) return val;
        const parsed = new Date(val).getTime();
        return isNaN(parsed) ? Date.now() : parsed;
      }

      // Local id for line items within a single draft (separate from
      // sourceLogId/sourceExpenseId, which point back at the real records).
      function generateId() {
        return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      }

      // Stable per-record UUID used ONLY to correlate with Supabase rows
      // (their primary keys are uuid). Deliberately separate from the
      // local `id` field above (a plain timestamp/string) — every existing
      // onclick handler, findIndex(), and array filter in core/ui.js and
      // core/invoicing.js already assumes `id` is a small unquoted literal
      // it can inline into an HTML attribute; changing that scheme
      // app-wide to satisfy the server's uuid columns would be a much
      // larger, riskier refactor than this sync feature calls for. See
      // stampAndSync() in storage.js, which assigns this once per record
      // and then leaves it untouched on every subsequent edit.
      function generateUUID() {
        if (
          typeof crypto !== "undefined" &&
          typeof crypto.randomUUID === "function"
        ) {
          return crypto.randomUUID();
        }
        // Fallback for contexts where crypto.randomUUID isn't available
        // (e.g. a non-secure-context file:// load) — RFC 4122 v4 shape
        // using crypto.getRandomValues when present, Math.random() (same
        // source generateId() above already relies on) otherwise.
        const bytes = new Uint8Array(16);
        if (typeof crypto !== "undefined" && crypto.getRandomValues) {
          crypto.getRandomValues(bytes);
        } else {
          for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
        }
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
        return (
          hex.slice(0, 4).join("") +
          "-" +
          hex.slice(4, 6).join("") +
          "-" +
          hex.slice(6, 8).join("") +
          "-" +
          hex.slice(8, 10).join("") +
          "-" +
          hex.slice(10, 16).join("")
        );
      }

      function normalizeShift(raw) {
        if (!raw || typeof raw !== "object" || !raw.startTime) return null;
        return {
          ...raw,
          startTime: getMsTimestamp(raw.startTime),
          breakStart: raw.breakStart ? getMsTimestamp(raw.breakStart) : null,
          totalBreakMs: Number(raw.totalBreakMs) || 0,
        };
      }

      function normalizeLogs(rawLogs) {
        if (!Array.isArray(rawLogs)) return [];
        return rawLogs.map((log) => {
          const startISO =
            log.startTimeISO ||
            log.rawStartISO ||
            (log.date
              ? new Date(log.date).toISOString()
              : new Date().toISOString());
          const endISO = log.endTimeISO || log.rawEndISO || startISO;
          return { ...log, startTimeISO: startISO, endTimeISO: endISO };
        });
      }

      // v2 -> v3: introduces multi-project support. Existing users have one
      // undifferentiated set of shifts/expenses/invoices under the old
      // global hourlyRate — fold all of it into a single default project
      // ("Almurooj School") so nothing is lost, then everything going
      // forward is scoped by projectId. Called from exactly two gated call
      // sites below (each only reachable once per install), so this itself
      // doesn't need its own re-entrancy guard.
      function migrateToProjectModel() {
        const defaultProject = {
          id: generateId(),
          name: "Almurooj School",
          hourlyRate: hourlyRate,
          createdAt: new Date().toISOString(),
        };
        projects = [defaultProject];
        activeProjectId = defaultProject.id;

        logs = logs.map((log) => ({
          ...log,
          projectId: log.projectId || defaultProject.id,
        }));
        expenses = expenses.map((exp) => ({
          ...exp,
          projectId: exp.projectId || defaultProject.id,
        }));
        invoices = invoices.map((inv) => ({
          ...inv,
          projectId: inv.projectId || defaultProject.id,
        }));
        if (currentShift) {
          currentShift = {
            ...currentShift,
            projectId: currentShift.projectId || defaultProject.id,
          };
        }
      }

      // v3 -> v4: introduces Supabase sync. Every existing record needs an
      // updatedAt (seeded "now" — these are pre-existing local records with
      // no real edit history worth preserving) and a syncId (see
      // generateUUID() above) so the sync layer has something stable to
      // correlate against server rows. pendingDeletions/syncCursor are new
      // top-level fields with an obvious empty starting value, so there's
      // nothing to migrate for those beyond persisting once at the bottom
      // of loadStoredData(). Called from exactly one gated call site (see
      // storage.js's loadStoredData()), so no re-entrancy guard needed.
      function migrateV3ToV4() {
        const now = getMsTimestamp();

        projects = projects.map((p) => ({
          ...p,
          syncId: p.syncId || generateUUID(),
          updatedAt: p.updatedAt || now,
        }));
        logs = logs.map((log) => ({
          ...log,
          syncId: log.syncId || generateUUID(),
          updatedAt: log.updatedAt || now,
        }));
        expenses = expenses.map((exp) => ({
          ...exp,
          syncId: exp.syncId || generateUUID(),
          updatedAt: exp.updatedAt || now,
        }));
        invoices = invoices.map((inv) => ({
          ...inv,
          syncId: inv.syncId || generateUUID(),
          updatedAt: inv.updatedAt || now,
        }));
        if (currentShift) {
          currentShift = {
            ...currentShift,
            syncId: currentShift.syncId || generateUUID(),
            updatedAt: currentShift.updatedAt || now,
          };
        }
      }

      // v4 -> v5: invoice numbering reconciliation + syncConflicts. Every
      // pre-existing invoice was created and persisted under the OLD
      // export-gated flow (saveInvoiceRecord() was only ever called after
      // a successful PDF export — see core/invoicing.js), so "it already
      // exists in invoices[]" itself implies "it was already sent" for
      // every one of these records: exported defaults to true. numberSource
      // defaults to "local" since server-assigned numbering (A1 in the
      // sync-follow-ups task) didn't exist before this version — there is
      // no way to retroactively know which pre-v5 numbers came from the
      // (nonexistent-at-the-time) RPC. syncConflicts is new and starts
      // empty; nothing to migrate into it. Called from the same one gated
      // call site as migrateV3ToV4() (see storage.js's loadStoredData()).
      function migrateV4ToV5() {
        invoices = invoices.map((inv) => ({
          ...inv,
          numberSource: inv.numberSource || "local",
          exported: inv.exported !== undefined ? inv.exported : true,
        }));
      }

      // One-time upgrade path for data written before STORAGE_KEY existed (four
      // separate wt_* keys). Folds them into the versioned envelope, then removes them
      // so this only ever runs once per install.
      function migrateLegacyKeys() {
        const legacyRate = localStorage.getItem("wt_hourly_rate");
        const legacyShift = localStorage.getItem("wt_active_shift");
        const legacyLogs = localStorage.getItem("wt_shift_logs");
        const legacyExpenses = localStorage.getItem("wt_expenses");
        const hadLegacyData = !!(
          legacyRate ||
          legacyShift ||
          legacyLogs ||
          legacyExpenses
        );

        if (legacyRate) hourlyRate = parseFloat(legacyRate) || 20.0;

        if (legacyShift) {
          try {
            currentShift = normalizeShift(JSON.parse(legacyShift));
          } catch (e) {
            currentShift = null;
          }
        }

        if (legacyLogs) {
          try {
            logs = normalizeLogs(JSON.parse(legacyLogs));
            consolidateDailyLogs();
          } catch (e) {}
        }

        if (legacyExpenses) {
          try {
            const parsed = JSON.parse(legacyExpenses);
            expenses = Array.isArray(parsed) ? parsed : [];
          } catch (e) {}
        }

        // Only an install with real pre-v1 data needs a default project
        // created for it — a genuinely fresh install (nothing in any
        // legacy key either) should start with zero projects so the
        // picker's "Add New Project" flow is what creates the first one.
        if (hadLegacyData) {
          migrateToProjectModel();
          // These legacy records predate syncId/updatedAt entirely (v4
          // added both) — stamp them the same way any other pre-v4 install
          // gets stamped on load, so a pre-v1 install landing directly on
          // the current shape doesn't skip that step.
          migrateV3ToV4();
          // No invoices are possible on a pre-v1 install (invoicing itself
          // is a v2 feature), so this is a no-op in practice — called
          // anyway for the same "don't skip a version's migration just
          // because this path landed on the shape directly" consistency
          // as the call above.
          migrateV4ToV5();
        }

        persistState();
        [
          "wt_hourly_rate",
          "wt_active_shift",
          "wt_shift_logs",
          "wt_expenses",
        ].forEach((key) => localStorage.removeItem(key));
      }
