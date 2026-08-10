// core/projects.js — wt_state.projects[], activeProjectId, and all
// project-scoping logic: the active-project accessors (getActiveProject,
// getActiveRate, getActiveLogs, getActiveExpenses, ...), the startup
// picker/switch flow, and per-project rate editing (saveRate).

      // Project Management
      //
      // Every project/client is kept fully separate: its own hourly rate,
      // and its own slice of the flat logs/expenses/invoices arrays (via
      // projectId). Only signatureImage stays global — a freelancer signs
      // the same way regardless of client.

      function getActiveProject() {
        return projects.find((p) => p.id === activeProjectId) || null;
      }

      function getProjectRate(projectId) {
        const project = projects.find((p) => p.id === projectId);
        return project ? Number(project.hourlyRate) || 0 : 0;
      }

      function getActiveRate() {
        return activeProjectId ? getProjectRate(activeProjectId) : 0;
      }

      // logs/expenses stay one flat array each (tagged with projectId) rather
      // than nested per-project collections, so these two filters are the
      // single choke point every render function reads through.
      function getActiveLogs() {
        return logs.filter((l) => l.projectId === activeProjectId);
      }

      function getActiveExpenses() {
        return expenses.filter((e) => e.projectId === activeProjectId);
      }

      // Decides what happens at startup, once loadStoredData() has already
      // resolved `projects`/`activeProjectId` (including running the v2->v3
      // migration if needed). Runs before renderUI() paints the dashboard.
      function initProjectFlow() {
        if (projects.length === 0) {
          // projects.length === 0 SHOULD mean "genuinely fresh install,"
          // but it can also mean loadStoredData() didn't finish reading
          // projects[] before something downstream threw (see
          // core/storage.js's loadStoredData() and CLAUDE.md section 4H —
          // this happened in production). logs/expenses/invoices already
          // having data is a cheap, always-available signal that this
          // ISN'T a fresh install even when projects[] looks empty.
          // Force-creating a project in that case is actively harmful: the
          // user has no way to tell anything's wrong, so they just retype
          // their existing project's name, which creates a DUPLICATE under
          // a new id and orphans every log/expense/invoice still tagged
          // with the old, no-longer-listed id. So: only force the
          // no-escape flow for an actually-empty install; otherwise show
          // the picker closable, with a warning, so the user can back out
          // and investigate instead of being walked into that.
          const hasExistingHistory =
            logs.length > 0 || expenses.length > 0 || invoices.length > 0;

          if (hasExistingHistory) {
            console.error(
              `WorkLog Pro: projects[] is empty but logs (${logs.length})/expenses (${expenses.length})/invoices (${invoices.length}) are not — this indicates a load problem, not a fresh install. See CLAUDE.md section 4H.`,
            );
            openProjectPicker(
              true,
              "Existing shift/expense/invoice records were found, but no matching project. Adding a new project below will NOT reconnect them — this usually means something went wrong loading your existing project, not that this is a first-time setup. Close this and check your data (e.g. Backup Data) before continuing.",
            );
            return;
          }

          // Nothing to pick, and no existing history either — force the
          // "Add New Project" flow, no way to close back to a dashboard
          // that has no project to show yet.
          openProjectPicker(false);
          return;
        }

        if (projects.length === 1) {
          // Common case: don't make the user click through a picker just to
          // confirm the one project they have.
          if (activeProjectId !== projects[0].id) {
            activeProjectId = projects[0].id;
            persistState();
          }
          return;
        }

        // 2+ projects: always confirm which one this launch is for, rather
        // than silently reusing whatever was last active.
        openProjectPicker(!!activeProjectId);
      }

      // Injects the orphaned-data warning banner into the project picker on
      // first use, same "build markup from core/ so no per-shell HTML edit
      // is needed" convention core/invoicing.js's
      // ensureProductInvoiceCreateUI() already established. Starts hidden;
      // openProjectPicker() toggles it per call.
      function ensureOrphanDataWarning() {
        if (document.getElementById("orphanDataWarning")) return;
        const anchor = document.getElementById("projectPickerList");
        if (!anchor) return;
        anchor.insertAdjacentHTML(
          "beforebegin",
          `<div id="orphanDataWarning" class="hidden mb-3 p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800 flex items-start gap-2">
            <i class="fa-solid fa-triangle-exclamation mt-0.5"></i>
            <span id="orphanDataWarningText"></span>
          </div>`,
        );
      }

      // allowClose: whether a close button is offered (there's nothing to
      // go back to on a forced first-run pick, or when zero projects exist
      // with no orphaned-history warning). warningMessage: optional — shown
      // above the project list when initProjectFlow() detects projects[]
      // is empty despite existing logs/expenses/invoices (see CLAUDE.md
      // section 4H); omitted/undefined hides it, matching every other call
      // site (requestSwitchProject(), the normal 2+/0-with-no-history
      // paths) unchanged.
      function openProjectPicker(allowClose, warningMessage) {
        renderProjectPickerList();
        document
          .getElementById("projectPickerCloseBtn")
          .classList.toggle("hidden", !allowClose);
        document.getElementById("newProjectName").value = "";
        document.getElementById("newProjectRate").value = "";

        ensureOrphanDataWarning();
        const warningEl = document.getElementById("orphanDataWarning");
        if (warningEl) {
          warningEl.classList.toggle("hidden", !warningMessage);
          if (warningMessage) {
            document.getElementById("orphanDataWarningText").textContent =
              warningMessage;
          }
        }

        const screen = document.getElementById("projectPickerScreen");
        screen.classList.remove("hidden");
        screen.classList.add("flex");
      }

      function closeProjectPicker() {
        const screen = document.getElementById("projectPickerScreen");
        screen.classList.add("hidden");
        screen.classList.remove("flex");
      }

      // Clicking "Switch Project" in the header routes through here rather
      // than calling openProjectPicker() directly, so the active-shift
      // guard holds even if the button's disabled state hasn't repainted
      // yet for some reason.
      function requestSwitchProject() {
        if (currentShift) {
          alert(
            "Clock out before switching projects — an active shift belongs to one project at a time.",
          );
          return;
        }
        openProjectPicker(true);
      }

      function renderProjectPickerList() {
        const list = document.getElementById("projectPickerList");
        if (!list) return;

        if (projects.length === 0) {
          list.innerHTML =
            '<p class="text-xs text-slate-400 italic">No projects yet — add your first one below.</p>';
          return;
        }

        list.innerHTML = projects
          .map((p) => {
            const totalHours =
              logs
                .filter((l) => l.projectId === p.id)
                .reduce((sum, l) => sum + (Number(l.netDurationMs) || 0), 0) /
              (1000 * 60 * 60);
            return `
              <div class="flex items-center gap-2">
                <button type="button" onclick="selectProject('${p.id}')" class="flex-1 min-w-0 flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-indigo-50 border border-slate-200 hover:border-indigo-300 rounded-xl transition text-left">
                  <div class="min-w-0">
                    <div class="text-sm font-semibold text-slate-800 truncate">${escapeHtml(p.name)}</div>
                    <div class="text-xs text-slate-400">${totalHours.toFixed(2)} hrs logged · $${(Number(p.hourlyRate) || 0).toFixed(2)}/hr</div>
                  </div>
                  <i class="fa-solid fa-chevron-right text-slate-300 shrink-0"></i>
                </button>
                <button type="button" onclick="confirmDeleteProject('${p.id}')" title="Delete Project" class="shrink-0 w-9 h-9 flex items-center justify-center text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-xl transition">
                  <i class="fa-solid fa-trash-can"></i>
                </button>
              </div>`;
          })
          .join("");
      }

      // Confirmation gate for deleteProject() below — this is destructive
      // and irreversible (every log/expense/invoice under the project goes
      // with it), so the dialog names the project and the exact counts
      // being removed rather than a generic "are you sure?".
      function confirmDeleteProject(id) {
        const project = projects.find((p) => p.id === id);
        if (!project) return;

        // Same guard requestSwitchProject() uses, but scoped to just this
        // project — there's only ever one currentShift, tagged with one
        // projectId, so an active shift on a DIFFERENT project doesn't
        // block deleting this one.
        if (currentShift && currentShift.projectId === id) {
          alert(
            "Clock out before deleting this project — it has a shift in progress.",
          );
          return;
        }

        const logCount = logs.filter((l) => l.projectId === id).length;
        const expenseCount = expenses.filter(
          (e) => e.projectId === id,
        ).length;
        const invoiceCount = invoices.filter(
          (inv) => inv.projectId === id,
        ).length;

        const confirmed = confirm(
          `Delete "${project.name}"?\n\nThis will permanently delete ${logCount} shift ${logCount === 1 ? "entry" : "entries"}, ${expenseCount} expense${expenseCount === 1 ? "" : "s"}, and ${invoiceCount} invoice${invoiceCount === 1 ? "" : "s"} tied to this project. This cannot be undone.`,
        );
        if (!confirmed) return;

        deleteProject(id);
      }

      // Full delete only — there is no "keep the records, drop the
      // project" option. Cascades through every flat array tagged with
      // this projectId using the exact same per-record
      // stampAndSync()+pendingDeletions pattern every other delete
      // function in this app already uses (see deleteLog()/
      // deleteExpense()/deleteInvoice()), just applied to every record
      // under one project instead of one record at a time — the existing
      // push/pull machinery in core/sync.js needs no changes to support
      // this, since each record already carries stampAndSync's own
      // table-name mapping and deletion (deleted_at set) is already
      // handled generically per table there.
      function deleteProject(id) {
        const project = projects.find((p) => p.id === id);
        if (!project) return;

        const deletedAt = getMsTimestamp();

        logs
          .filter((l) => l.projectId === id)
          .forEach((record) => {
            record.deletedAt = deletedAt;
            stampAndSync("logs", record);
            pendingDeletions.push({
              table: "logs",
              id: record.id,
              deletedAt,
              synced: false,
              record: { ...record },
            });
          });
        logs = logs.filter((l) => l.projectId !== id);

        expenses
          .filter((e) => e.projectId === id)
          .forEach((record) => {
            record.deletedAt = deletedAt;
            stampAndSync("expenses", record);
            pendingDeletions.push({
              table: "expenses",
              id: record.id,
              deletedAt,
              synced: false,
              record: { ...record },
            });
          });
        expenses = expenses.filter((e) => e.projectId !== id);

        invoices
          .filter((inv) => inv.projectId === id)
          .forEach((record) => {
            record.deletedAt = deletedAt;
            stampAndSync("invoices", record);
            pendingDeletions.push({
              table: "invoices",
              id: record.id,
              deletedAt,
              synced: false,
              record: { ...record },
            });
          });
        invoices = invoices.filter((inv) => inv.projectId !== id);

        project.deletedAt = deletedAt;
        stampAndSync("projects", project);
        pendingDeletions.push({
          table: "projects",
          id: project.id,
          deletedAt,
          synced: false,
          record: { ...project },
        });
        projects = projects.filter((p) => p.id !== id);

        if (activeProjectId === id) {
          // Can't leave activeProjectId pointing at something that no
          // longer exists. initProjectFlow() already knows how to
          // auto-select the sole remaining project or force the picker if
          // none remain — reuse that instead of duplicating its
          // zero-or-one-project logic here. Close first: initProjectFlow()
          // only OPENS the picker when it needs to (0 or 2+ projects); the
          // exactly-1-project case just silently re-selects and leaves an
          // already-open picker open, which would look wrong here since
          // the picker is exactly where this delete was triggered from.
          activeProjectId = null;
          persistState();
          closeProjectPicker();
          initProjectFlow();
        } else {
          // Deleted project wasn't active — the picker (where this was
          // triggered from) stays open, just refreshed to drop the row.
          persistState();
          renderProjectPickerList();
        }

        renderUI();
      }

      function selectProject(id) {
        const project = projects.find((p) => p.id === id);
        if (!project) return;

        activeProjectId = id;
        persistState();
        closeProjectPicker();
        renderUI();
      }

      function handleAddProject(event) {
        event.preventDefault();

        const name = document.getElementById("newProjectName").value.trim();
        const rate = parseFloat(
          document.getElementById("newProjectRate").value,
        );

        if (!name || isNaN(rate) || rate < 0) {
          alert("Enter a project name and a valid hourly rate.");
          return;
        }

        const project = {
          id: generateId(),
          name,
          hourlyRate: rate,
          createdAt: new Date().toISOString(),
        };
        stampAndSync("projects", project);
        projects.push(project);
        activeProjectId = project.id;

        persistState();
        closeProjectPicker();
        renderUI();
      }

      // Keeps the header badge, the "Switch" control, and the (now
      // per-project) hourly rate input all in sync with whichever project
      // is active. Called from renderUI() so it stays current after every
      // state change, not just after switching.
      function renderProjectBadge() {
        const nameEl = document.getElementById("activeProjectName");
        const switchBtn = document.getElementById("switchProjectBtn");
        const rateInput = document.getElementById("hourlyRate");
        const rateHint = document.getElementById("rateProjectHint");
        if (!nameEl || !switchBtn) return;

        const project = getActiveProject();
        nameEl.textContent = project ? project.name : "No project selected";

        const disabled = !!currentShift;
        switchBtn.disabled = disabled;
        switchBtn.title = disabled
          ? "Clock out before switching projects"
          : "Switch Project";

        if (rateInput) {
          rateInput.value = project ? project.hourlyRate : "";
        }
        if (rateHint) {
          rateHint.textContent = project
            ? `Applies to ${project.name}`
            : "Select a project to set its rate";
        }
      }

      // Remembers the description used for this project's last Product
      // Invoice (see core/invoicing.js's isProductInvoice mode), so the next
      // one can pre-fill it. Caller is responsible for persisting —
      // invoicing.js's saveInvoiceRecord() already calls persistState()
      // right after this, so this doesn't call it a second time itself.
      //
      // Deliberately does NOT call stampAndSync(): the projects table has
      // no lastProductInvoiceDescription column (see
      // migrations/001_worklogpro_schema.sql), so there's nothing for a
      // push to actually carry — stamping updatedAt here would just make
      // this project look edited every time an invoice is created, for a
      // field the server can never receive.
      function setProjectLastProductInvoiceDescription(projectId, description) {
        const project = projects.find((p) => p.id === projectId);
        if (!project || !description) return;
        project.lastProductInvoiceDescription = description;
      }

      // saveRate/saveShift/saveLogs/saveExpenses are kept as named entry points (the
      // hourlyRate input's onchange calls saveRate() directly) but now just persist the
      // whole envelope, so callers no longer need to know which key backs which field.
      function saveRate() {
        const project = getActiveProject();
        const value =
          parseFloat(document.getElementById("hourlyRate").value) || 0;
        if (project) {
          project.hourlyRate = value;
          stampAndSync("projects", project);
          persistState();
        }
        renderStats();
        renderLogsTable();
      }
