// core/storage.js — read/write wt_state.
// Still backed by localStorage for this pass (do NOT switch to IndexedDB
// here — that's an explicitly later step). persistState()/loadStoredData()
// are the only functions that touch localStorage directly; everything else
// in core/ goes through them.

      // Export & Import Data Features
      function exportData() {
        const backupPayload = {
          version: "1.0",
          exportDate: new Date().toISOString(),
          hourlyRate: hourlyRate,
          currentShift: currentShift,
          logs: logs,
          expenses: expenses,
        };

        const jsonStr = JSON.stringify(backupPayload, null, 2);
        const blob = new Blob([jsonStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = `WorkLogPro_Backup_${new Date().toISOString().split("T")[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      function importData(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function (e) {
          try {
            const data = JSON.parse(e.target.result);

            if (data.logs && Array.isArray(data.logs)) logs = data.logs;
            consolidateDailyLogs();
            if (data.expenses && Array.isArray(data.expenses))
              expenses = data.expenses;
            if (data.hourlyRate) {
              hourlyRate = parseFloat(data.hourlyRate) || 20.0;
              document.getElementById("hourlyRate").value = hourlyRate;
            }
            if (data.currentShift !== undefined) {
              if (data.currentShift && data.currentShift.startTime) {
                currentShift = {
                  ...data.currentShift,
                  startTime: getMsTimestamp(data.currentShift.startTime),
                  breakStart: data.currentShift.breakStart
                    ? getMsTimestamp(data.currentShift.breakStart)
                    : null,
                  totalBreakMs: Number(data.currentShift.totalBreakMs) || 0,
                };
              } else {
                currentShift = null;
              }
            }

            saveRate();
            saveShift();
            saveLogs();
            saveExpenses();
            renderUI();

            alert("WorkLog Pro data restored successfully!");
          } catch (err) {
            alert("Invalid backup file structure. Restoration failed.");
          }
        };
        reader.readAsText(file);
      }

      // Helpers & Persistence
      //
      // All state lives in one versioned localStorage envelope (STORAGE_KEY) instead of
      // four independent keys, so future changes to the stored shape can be migrated in
      // one place (see loadStoredData) instead of silently corrupting old users' data.
      function persistState() {
        try {
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
              schemaVersion: SCHEMA_VERSION,
              hourlyRate,
              currentShift,
              logs,
              expenses,
              invoices,
              nextInvoiceNumber,
              businessName,
              signatureImage,
              projects,
              activeProjectId,
            }),
          );
        } catch (e) {}
      }

      function saveShift() {
        persistState();
      }

      function saveLogs() {
        persistState();
      }

      function saveExpenses() {
        persistState();
      }

      function loadStoredData() {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);

          if (!raw) {
            migrateLegacyKeys();
          } else {
            const parsed = JSON.parse(raw);
            const storedVersion = Number(parsed.schemaVersion) || 1;

            hourlyRate = parseFloat(parsed.hourlyRate) || 20.0;
            currentShift = normalizeShift(parsed.currentShift);
            logs = normalizeLogs(parsed.logs);
            expenses = Array.isArray(parsed.expenses) ? parsed.expenses : [];
            consolidateDailyLogs();

            // v1 -> v2: added invoicing. Old state objects simply lack these
            // fields, so default them in here and persist once below to
            // stamp the envelope as schemaVersion 2 without touching
            // anything else that was already stored.
            invoices = Array.isArray(parsed.invoices) ? parsed.invoices : [];
            nextInvoiceNumber = Number.isFinite(parsed.nextInvoiceNumber)
              ? parsed.nextInvoiceNumber
              : 1;
            businessName =
              typeof parsed.businessName === "string"
                ? parsed.businessName
                : "";
            // Added alongside v2 but needs no version bump of its own — a
            // missing field on old state objects just defaults to null,
            // same as a user who's never uploaded a signature.
            signatureImage =
              typeof parsed.signatureImage === "string"
                ? parsed.signatureImage
                : null;

            // v2 -> v3: added multi-project support. Reaching this branch
            // at all means a wt_state envelope already existed, so this is
            // unconditionally an "existing user" — even one with zero
            // history yet still gets a (possibly empty) default project.
            projects = Array.isArray(parsed.projects) ? parsed.projects : [];
            activeProjectId =
              typeof parsed.activeProjectId === "string"
                ? parsed.activeProjectId
                : null;

            if (storedVersion < 3) {
              migrateToProjectModel();
            }

            if (storedVersion < SCHEMA_VERSION) {
              persistState();
            }
          }
        } catch (e) {
          console.error("Error loading stored data:", e);
        }
      }
