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
              pendingDeletions,
              syncCursor,
              userSettingsUpdatedAt,
              syncConflicts,
            }),
          );
        } catch (e) {}
      }

      // Maps a wt_state array name to the Supabase table it syncs to —
      // only "logs" differs (the server table is "shifts", covering both
      // completed logs and the single in-progress currentShift via
      // status). Exported as a function (not a bare object literal at
      // module scope) so core/sync.js can reuse the exact same mapping
      // rather than hardcoding its own copy that could drift.
      function syncTableNameFor(localTable) {
        return localTable === "logs" ? "shifts" : localTable;
      }

      // Called at every mutation site that creates or edits a
      // project/shift/expense/invoice record — see CLAUDE.md section 5 for
      // the full rule. Deliberately explicit per call site rather than
      // diffing the envelope automatically: a forgotten stampAndSync() call
      // means the feature visibly never syncs during testing, instead of
      // silently missing updatedAt for reasons that surface weeks later.
      //
      // Does NOT call persistState() — callers still do that themselves
      // exactly as before. This only stamps the timestamp and enqueues the
      // local (IndexedDB) sync-queue write; the actual network push happens
      // later, in core/sync.js's pushPendingOps().
      //
      // record.syncId is assigned here the first time a record is stamped
      // (i.e. at creation) and left untouched on every later edit — see
      // generateUUID()'s comment in state.js for why this is a separate
      // field from the local `id`.
      function stampAndSync(table, record) {
        if (!record.syncId) record.syncId = generateUUID();
        record.updatedAt = getMsTimestamp();
        if (typeof enqueueSyncOp === "function") {
          enqueueSyncOp(syncTableNameFor(table), record);
        }
      }

      // Sibling to stampAndSync() for businessName/signatureImage — the
      // two global (not per-project, not array-item) fields that also have
      // server-side sync support via user_settings (see
      // migrations/002_worklogpro_sync_rpc.sql's upsert_user_settings).
      // Not in the original mutation-site list, added because skipping a
      // feature the applied schema already supports would silently leave
      // it unsynced forever. Call sites: handleSignatureUpload(),
      // removeSignature(), and saveInvoiceRecord()'s businessName update
      // (all in core/invoicing.js).
      function stampAndSyncSettings() {
        userSettingsUpdatedAt = getMsTimestamp();
        if (typeof enqueueSyncOp === "function") {
          enqueueSyncOp("user_settings", {
            // Sentinel syncId used only for local queue coalescing — the
            // server row is a singleton keyed by auth.uid(), and
            // upsert_user_settings takes no p_id param at all.
            syncId: "__user_settings__",
            businessName,
            signatureImage,
            updatedAt: userSettingsUpdatedAt,
          });
        }
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

            // projects[]/activeProjectId are read as early as possible —
            // deliberately BEFORE logs/expenses/consolidateDailyLogs()
            // below, which can throw (see consolidateDailyLogs()'s own
            // hardening comment) on malformed date data. This whole
            // function is one try/catch with a silent console.error and no
            // recovery (see the bottom of this function) — if anything
            // downstream of this point throws, execution stops right
            // there. initProjectFlow() runs immediately afterward with no
            // success/failure signal in between, so if projects[] hadn't
            // been read yet at that point, it would still be sitting at
            // the empty [] state.js declares it with — indistinguishable
            // from a genuine fresh install, even though logs/expenses/
            // invoices might already be fully loaded. That's exactly what
            // caused a duplicate project + orphaned history in production
            // (see CLAUDE.md section 4H) — reading projects here first is
            // the fix, and initProjectFlow() has its own defense-in-depth
            // check as a second layer.
            projects = Array.isArray(parsed.projects) ? parsed.projects : [];
            activeProjectId =
              typeof parsed.activeProjectId === "string"
                ? parsed.activeProjectId
                : null;

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

            // v2 -> v3: added multi-project support (migration only —
            // projects[]/activeProjectId themselves are already read
            // above). Reaching this branch at all means a wt_state
            // envelope already existed, so this is unconditionally an
            // "existing user" — even one with zero history yet still gets
            // a (possibly empty) default project.
            if (storedVersion < 3) {
              migrateToProjectModel();
            }

            // v3 -> v4: added Supabase sync. Reaching this branch means a
            // wt_state envelope already existed, so pendingDeletions/
            // syncCursor just default to "nothing pending yet" / "never
            // synced" for an existing install — same treatment as every
            // other new-field-on-old-state case above.
            pendingDeletions = Array.isArray(parsed.pendingDeletions)
              ? parsed.pendingDeletions
              : [];
            syncCursor = Number.isFinite(parsed.syncCursor)
              ? parsed.syncCursor
              : null;
            userSettingsUpdatedAt = Number.isFinite(parsed.userSettingsUpdatedAt)
              ? parsed.userSettingsUpdatedAt
              : null;

            if (storedVersion < 4) {
              migrateV3ToV4();
            }

            // v4 -> v5: invoice numbering reconciliation + syncConflicts.
            syncConflicts = Array.isArray(parsed.syncConflicts)
              ? parsed.syncConflicts
              : [];

            if (storedVersion < 5) {
              migrateV4ToV5();
            }

            // v5 -> v6: invoice paid/paidAt (see migrateV5ToV6()).
            if (storedVersion < 6) {
              migrateV5ToV6();
            }

            if (storedVersion < SCHEMA_VERSION) {
              persistState();
            }
          }
        } catch (e) {
          console.error("Error loading stored data:", e);
        }
      }
