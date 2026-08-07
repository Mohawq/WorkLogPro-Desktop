// core/ui.js — shared render/DOM update functions, plus record CRUD that
// is fundamentally about rendering tables and handling modal forms (manual
// shift-log entry, expense entry) rather than the live clock mechanism
// itself. Also owns the app's DOMContentLoaded bootstrap, since it's the
// natural top of the dependency stack (references functions from every
// other core file). Not Electron-specific — safe to reuse from any shell.

      // Load persisted state on startup
      window.addEventListener("DOMContentLoaded", () => {
        loadStoredData();
        initProjectFlow();
        updateClock();
        setInterval(updateClock, 1000);
        renderUI();

        // Set default dates in inputs
        const today = new Date().toISOString().split("T")[0];
        document.getElementById("mDate").value = today;
        document.getElementById("eDate").value = today;
      });

      // Render UI state based on currentShift and stored logs
      function renderUI() {
        const statusBadge = document.getElementById("statusBadge");
        const clockInBtn = document.getElementById("clockInBtn");
        const startBreakBtn = document.getElementById("startBreakBtn");
        const endBreakBtn = document.getElementById("endBreakBtn");
        const clockOutBtn = document.getElementById("clockOutBtn");
        const timerDisplay = document.getElementById("timerDisplay");
        const breakDurationSub = document.getElementById("breakDurationSub");

        if (!currentShift) {
          // Clocked Out State
          statusBadge.className =
            "flex items-center justify-center gap-2 p-3 rounded-xl bg-slate-100 text-slate-600 font-medium text-sm";
          statusBadge.innerHTML = `<span class="w-3 h-3 rounded-full bg-slate-400"></span> Current Status: <strong>Clocked Out</strong>`;

          clockInBtn.disabled = false;
          startBreakBtn.disabled = true;
          endBreakBtn.disabled = true;
          clockOutBtn.disabled = true;

          timerDisplay.classList.add("hidden");
          stopTimer();
        } else if (currentShift.breakStart) {
          // On Break State
          statusBadge.className =
            "flex items-center justify-center gap-2 p-3 rounded-xl bg-amber-50 text-amber-700 border border-amber-200 font-medium text-sm pulse-subtle";
          statusBadge.innerHTML = `<span class="w-3 h-3 rounded-full bg-amber-500 animate-ping"></span> Current Status: <strong>On Break</strong>`;

          clockInBtn.disabled = true;
          startBreakBtn.disabled = true;
          endBreakBtn.disabled = false;
          clockOutBtn.disabled = false;

          timerDisplay.classList.remove("hidden");
          breakDurationSub.classList.remove("hidden");
          startTimer();
        } else {
          // Working State
          statusBadge.className =
            "flex items-center justify-center gap-2 p-3 rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium text-sm";
          statusBadge.innerHTML = `<span class="w-3 h-3 rounded-full bg-emerald-500"></span> Current Status: <strong>Working</strong>`;

          clockInBtn.disabled = true;
          startBreakBtn.disabled = false;
          endBreakBtn.disabled = true;
          clockOutBtn.disabled = false;

          timerDisplay.classList.remove("hidden");
          breakDurationSub.classList.add("hidden");
          startTimer();
        }

        renderProjectBadge();
        renderLogsTable();
        renderExpensesTable();
        renderStats();
        renderInvoiceHistory();
        renderSignatureSettings();
      }

      // Render shift logs table (active project only)
      function renderLogsTable() {
        const tbody = document.getElementById("logsTableBody");
        const emptyState = document.getElementById("emptyState");
        const activeLogs = getActiveLogs();

        tbody.innerHTML = "";

        if (activeLogs.length === 0) {
          emptyState.classList.remove("hidden");
          return;
        }

        emptyState.classList.add("hidden");

        activeLogs.forEach((log) => {
          const startObj = new Date(log.startTimeISO);
          const endObj = new Date(log.endTimeISO);

          const startTimeStr = startObj.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
          const endTimeStr = endObj.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });

          const netMs = Number(log.netDurationMs) || 0;
          const netHours = (netMs / (1000 * 60 * 60)).toFixed(2);
          const breakMins = Math.round(
            (Number(log.breakMs) || 0) / (1000 * 60),
          );
          const pay = (
            netHours * (Number(log.hourlyRate) || getActiveRate())
          ).toFixed(2);

          const sessionBadge =
            log.sessionCount && log.sessionCount > 1
              ? `<span class="ml-2 px-1.5 py-0.5 text-[10px] bg-indigo-100 text-indigo-700 font-semibold rounded-md">${log.sessionCount} shifts assembled</span>`
              : "";

          const tr = document.createElement("tr");
          tr.className = "hover:bg-slate-50/80 transition";
          tr.innerHTML = `
                    <td class="px-6 py-4 font-medium text-slate-800 whitespace-nowrap">${log.date || "N/A"}${sessionBadge}</td>
                    <td class="px-6 py-4 whitespace-nowrap">
                        <div class="font-medium text-slate-700">${startTimeStr} - ${endTimeStr}</div>
                        <div class="text-xs text-slate-400">${escapeHtml(log.notes)}</div>
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap"><span class="px-2 py-1 text-xs rounded-lg font-medium bg-amber-50 text-amber-700 border border-amber-200">${breakMins} mins</span></td>
                    <td class="px-6 py-4 font-semibold text-slate-800 whitespace-nowrap">${netHours} hrs</td>
                    <td class="px-6 py-4 font-semibold text-emerald-600 whitespace-nowrap">$${pay}</td>
                    <td class="px-6 py-4 text-right whitespace-nowrap">
                        <div class="flex items-center justify-end gap-1">
                            <button onclick="editLog(${log.id})" class="text-slate-400 hover:text-indigo-600 transition px-2 py-1" title="Edit Entry">
                                <i class="fa-solid fa-pen"></i>
                            </button>
                            <button onclick="deleteLog(${log.id})" class="text-slate-400 hover:text-rose-600 transition px-2 py-1" title="Delete Entry">
                                <i class="fa-solid fa-trash-can"></i>
                            </button>
                        </div>
                    </td>
                `;
          tbody.appendChild(tr);
        });
      }

      // Manual Shift Add/Edit Modal
      function toggleManualEntryModal() {
        const modal = document.getElementById("manualEntryModal");
        const isOpening = modal.classList.contains("hidden");
        if (isOpening) {
          editingLogId = null;
          document.getElementById("modalTitle").textContent =
            "Add Past Work Entry";
          document.getElementById("manualForm").reset();
          document.getElementById("mDate").value = new Date()
            .toISOString()
            .split("T")[0];
          document.getElementById("mRate").value = getActiveRate();
        }
        modal.classList.toggle("hidden");
        modal.classList.toggle("flex");
      }

      function editLog(id) {
        const log = logs.find((l) => l.id === id);
        if (!log) return;

        editingLogId = id;
        document.getElementById("modalTitle").textContent = "Edit Work Entry";

        const startObj = new Date(log.startTimeISO);
        const endObj = new Date(log.endTimeISO);

        document.getElementById("mDate").value = startObj
          .toISOString()
          .split("T")[0];
        document.getElementById("mStart").value = startObj
          .toTimeString()
          .substring(0, 5);
        document.getElementById("mEnd").value = endObj
          .toTimeString()
          .substring(0, 5);
        document.getElementById("mBreak").value = Math.round(
          log.breakMs / (1000 * 60),
        );
        document.getElementById("mRate").value =
          log.hourlyRate || getActiveRate();
        document.getElementById("mNotes").value = log.notes || "";

        const modal = document.getElementById("manualEntryModal");
        modal.classList.remove("hidden");
        modal.classList.add("flex");
      }

      function handleManualSubmit(e) {
        e.preventDefault();

        const dateVal = document.getElementById("mDate").value;
        const startVal = document.getElementById("mStart").value;
        const endVal = document.getElementById("mEnd").value;
        const breakMins =
          parseInt(document.getElementById("mBreak").value) || 0;
        const rateVal =
          parseFloat(document.getElementById("mRate").value) ||
          getActiveRate();
        const notesVal = document.getElementById("mNotes").value.trim();

        if (!dateVal || !startVal || !endVal) return;

        const startISO = new Date(`${dateVal}T${startVal}:00`).toISOString();
        const endISO = new Date(`${dateVal}T${endVal}:00`).toISOString();

        const startMs = new Date(startISO).getTime();
        const endMs = new Date(endISO).getTime();

        if (endMs <= startMs) {
          alert("End time must be after start time.");
          return;
        }

        const breakMs = breakMins * 60 * 1000;
        const grossMs = endMs - startMs;
        const netMs = Math.max(0, grossMs - breakMs);

        if (editingLogId) {
          const index = logs.findIndex((l) => l.id === editingLogId);
          if (index !== -1) {
            logs[index] = {
              ...logs[index],
              date: new Date(startISO).toLocaleDateString(),
              startTimeISO: startISO,
              endTimeISO: endISO,
              breakMs: breakMs,
              netDurationMs: netMs,
              hourlyRate: rateVal,
              notes: notesVal || "Manual Entry",
            };
          }
        } else {
          const newLog = {
            id: Date.now(),
            projectId: activeProjectId,
            date: new Date(startISO).toLocaleDateString(),
            startTimeISO: startISO,
            endTimeISO: endISO,
            breakMs: breakMs,
            netDurationMs: netMs,
            hourlyRate: rateVal,
            notes: notesVal || "Manual Entry",
          };
          logs.unshift(newLog);
        }

        consolidateDailyLogs();
        saveLogs();
        renderUI();
        toggleManualEntryModal();
      }

      function deleteLog(id) {
        logs = logs.filter((l) => l.id !== id);
        saveLogs();
        renderUI();
      }

      // Expenses Logic
      function toggleExpenseModal() {
        const modal = document.getElementById("expenseModal");
        const isOpening = modal.classList.contains("hidden");
        if (isOpening) {
          document.getElementById("expenseForm").reset();
          document.getElementById("eDate").value = new Date()
            .toISOString()
            .split("T")[0];
        }
        modal.classList.toggle("hidden");
        modal.classList.toggle("flex");
      }

      function handleExpenseSubmit(e) {
        e.preventDefault();

        const dateVal = document.getElementById("eDate").value;
        const titleVal = document.getElementById("eTitle").value.trim();
        const amountVal =
          parseFloat(document.getElementById("eAmount").value) || 0;
        const categoryVal = document.getElementById("eCategory").value;
        const fileInput = document.getElementById("eFile");

        if (!dateVal || !titleVal || amountVal <= 0) return;

        const newExpense = {
          id: Date.now(),
          projectId: activeProjectId,
          date: new Date(dateVal + "T00:00:00").toLocaleDateString(),
          title: titleVal,
          amount: amountVal,
          category: categoryVal,
          fileName: null,
          fileType: null,
          fileData: null,
        };

        if (fileInput.files && fileInput.files[0]) {
          const file = fileInput.files[0];
          const reader = new FileReader();
          reader.onload = function (evt) {
            newExpense.fileName = file.name;
            newExpense.fileType = file.type;
            newExpense.fileData = evt.target.result;

            expenses.unshift(newExpense);
            saveExpenses();
            renderUI();
            toggleExpenseModal();
          };
          reader.readAsDataURL(file);
        } else {
          expenses.unshift(newExpense);
          saveExpenses();
          renderUI();
          toggleExpenseModal();
        }
      }

      function renderExpensesTable() {
        const tbody = document.getElementById("expensesTableBody");
        const emptyState = document.getElementById("emptyExpensesState");
        const activeExpenses = getActiveExpenses();

        tbody.innerHTML = "";

        if (activeExpenses.length === 0) {
          emptyState.classList.remove("hidden");
          return;
        }

        emptyState.classList.add("hidden");

        activeExpenses.forEach((item) => {
          const tr = document.createElement("tr");
          tr.className = "hover:bg-slate-50/80 transition";

          let fileButtonHtml =
            '<span class="text-slate-300 text-xs">No attachment</span>';
          if (item.fileData) {
            fileButtonHtml = `
                        <button onclick="viewAttachment(${item.id})" class="inline-flex items-center gap-1.5 px-2.5 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-medium rounded-lg border border-indigo-200 transition">
                            <i class="fa-solid fa-paperclip"></i> View File
                        </button>
                    `;
          }

          tr.innerHTML = `
                    <td class="px-6 py-4 font-medium text-slate-800 whitespace-nowrap">${item.date}</td>
                    <td class="px-6 py-4 font-medium text-slate-700">${escapeHtml(item.title)}</td>
                    <td class="px-6 py-4"><span class="px-2.5 py-1 text-xs rounded-lg font-medium bg-slate-100 text-slate-600">${escapeHtml(item.category)}</span></td>
                    <td class="px-6 py-4 font-semibold text-purple-600 whitespace-nowrap">$${item.amount.toFixed(2)}</td>
                    <td class="px-6 py-4 whitespace-nowrap">${fileButtonHtml}</td>
                    <td class="px-6 py-4 text-right whitespace-nowrap">
                        <button onclick="deleteExpense(${item.id})" class="text-slate-400 hover:text-rose-600 transition px-2 py-1" title="Delete Expense">
                            <i class="fa-solid fa-trash-can"></i>
                        </button>
                    </td>
                `;
          tbody.appendChild(tr);
        });
      }

      function deleteExpense(id) {
        expenses = expenses.filter((e) => e.id !== id);
        saveExpenses();
        renderUI();
      }

      function viewAttachment(id) {
        const item = expenses.find((e) => e.id === id);
        if (!item || !item.fileData) return;

        const modal = document.getElementById("fileViewerModal");
        const container = document.getElementById("fileViewerContent");
        const title = document.getElementById("fileViewerTitle");
        const downloadBtn = document.getElementById("fileDownloadBtn");

        title.textContent = `Receipt: ${item.title} (${item.fileName || "Attachment"})`;
        downloadBtn.href = item.fileData;
        downloadBtn.download = item.fileName || "invoice_receipt";

        container.innerHTML = "";

        if (item.fileType && item.fileType.startsWith("image/")) {
          const img = document.createElement("img");
          img.src = item.fileData;
          img.className =
            "max-h-[60vh] max-w-full rounded-lg shadow-sm object-contain";
          container.appendChild(img);
        } else if (item.fileType === "application/pdf") {
          const embed = document.createElement("iframe");
          embed.src = item.fileData;
          embed.className =
            "w-full h-[60vh] rounded-lg border border-slate-200";
          container.appendChild(embed);
        } else {
          container.innerHTML = `
                    <div class="text-center p-6">
                        <i class="fa-solid fa-file-lines text-5xl text-indigo-400 mb-3"></i>
                        <p class="text-sm font-medium text-slate-700">${escapeHtml(item.fileName || "Document File")}</p>
                        <p class="text-xs text-slate-400 mt-1">Preview not available directly for this file format.</p>
                    </div>
                `;
        }

        modal.classList.remove("hidden");
        modal.classList.add("flex");
      }

      function closeFileViewer() {
        const modal = document.getElementById("fileViewerModal");
        modal.classList.add("hidden");
        modal.classList.remove("flex");
      }

      // Render summary statistics
      function renderStats() {
        let totalWorkedMs = 0;
        let totalWorkEarnings = 0;
        let totalExpenses = 0;

        getActiveLogs().forEach((log) => {
          const netMs = Number(log.netDurationMs) || 0;
          totalWorkedMs += netMs;
          const hours = netMs / (1000 * 60 * 60);
          const rate = Number(log.hourlyRate) || getActiveRate();
          totalWorkEarnings += hours * rate;
        });

        getActiveExpenses().forEach((exp) => {
          totalExpenses += Number(exp.amount) || 0;
        });

        const totalWorkedHours = (totalWorkedMs / (1000 * 60 * 60)).toFixed(2);
        const grandTotalPayout = totalWorkEarnings + totalExpenses;

        document.getElementById("statWorkedHours").textContent =
          `${isNaN(totalWorkedHours) ? "0.00" : totalWorkedHours} hrs`;
        document.getElementById("statEarnings").textContent =
          `$${(isNaN(totalWorkEarnings) ? 0 : totalWorkEarnings).toFixed(2)}`;
        document.getElementById("statExpenses").textContent =
          `$${(isNaN(totalExpenses) ? 0 : totalExpenses).toFixed(2)}`;
        document.getElementById("statTotalPayout").textContent =
          `$${(isNaN(grandTotalPayout) ? 0 : grandTotalPayout).toFixed(2)}`;
      }

      function formatMs(ms, includeHours = true) {
        if (isNaN(ms) || ms === null || ms === undefined || ms < 0) {
          return includeHours ? "00:00:00" : "00:00";
        }
        const seconds = Math.floor((ms / 1000) % 60);
        const minutes = Math.floor((ms / (1000 * 60)) % 60);
        const hours = Math.floor(ms / (1000 * 60 * 60));

        const pad = (num) => String(num).padStart(2, "0");

        if (includeHours) {
          return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
        }
        return `${pad(minutes)}:${pad(seconds)}`;
      }

      function escapeHtml(str) {
        if (!str) return "";
        return str.replace(/[&<>"']/g, (match) => {
          const escapeMap = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          };
          return escapeMap[match];
        });
      }