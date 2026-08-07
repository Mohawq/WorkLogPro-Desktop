// core/state.js — wt_state shape, SCHEMA_VERSION, and schema migrations.
// Owns every top-level state variable and the functions that normalize or
// migrate the persisted shape. Platform-agnostic: no DOM, no localStorage
// I/O (that's storage.js), no window.platformAdapter use.

      // State Variables
      const SCHEMA_VERSION = 3; // v3 adds multi-project support (projects, activeProjectId, projectId on shifts/expenses/invoices)
      const STORAGE_KEY = "wt_state";

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
        }

        persistState();
        [
          "wt_hourly_rate",
          "wt_active_shift",
          "wt_shift_logs",
          "wt_expenses",
        ].forEach((key) => localStorage.removeItem(key));
      }
