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
          // Nothing to pick — force the "Add New Project" flow, no way to
          // close back to a dashboard that has no project to show yet.
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

      // allowClose: whether a close button is offered (there's nothing to
      // go back to on a forced first-run pick, or when zero projects exist).
      function openProjectPicker(allowClose) {
        renderProjectPickerList();
        document
          .getElementById("projectPickerCloseBtn")
          .classList.toggle("hidden", !allowClose);
        document.getElementById("newProjectName").value = "";
        document.getElementById("newProjectRate").value = "";

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
              <button type="button" onclick="selectProject('${p.id}')" class="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-indigo-50 border border-slate-200 hover:border-indigo-300 rounded-xl transition text-left">
                <div>
                  <div class="text-sm font-semibold text-slate-800">${escapeHtml(p.name)}</div>
                  <div class="text-xs text-slate-400">${totalHours.toFixed(2)} hrs logged · $${(Number(p.hourlyRate) || 0).toFixed(2)}/hr</div>
                </div>
                <i class="fa-solid fa-chevron-right text-slate-300"></i>
              </button>`;
          })
          .join("");
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
          persistState();
        }
        renderStats();
        renderLogsTable();
      }
