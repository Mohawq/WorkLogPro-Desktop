// core/shift-tracking.js — the live clock/timer/break mechanism only:
// clock in/out, break start/end/adjust, and the setInterval-driven display
// tick. Manual log-entry CRUD (add/edit/delete past shifts) lives in ui.js
// instead — see that file's header for why.

      // Update live header clock
      function updateClock() {
        const now = new Date();
        document.getElementById("liveClock").textContent =
          now.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
        document.getElementById("liveDate").textContent =
          now.toLocaleDateString([], {
            weekday: "long",
            month: "short",
            day: "numeric",
          });
      }

      // Live shift timer updates
      function startTimer() {
        if (timerInterval) clearInterval(timerInterval);
        updateTimerDisplay();
        timerInterval = setInterval(updateTimerDisplay, 1000);
      }

      function stopTimer() {
        if (timerInterval) clearInterval(timerInterval);
        document.getElementById("shiftTimer").textContent = "00h 00m 00s";
      }

      function updateTimerDisplay() {
        if (!currentShift) return;

        const now = Date.now();
        const startTime = getMsTimestamp(currentShift.startTime);
        const breakStart = currentShift.breakStart
          ? getMsTimestamp(currentShift.breakStart)
          : null;
        let accumulatedBreak = Number(currentShift.totalBreakMs) || 0;

        if (breakStart) {
          accumulatedBreak += now - breakStart;
        }

        const elapsedMs = Math.max(0, now - startTime - accumulatedBreak);
        const formatted = formatMs(elapsedMs);

        const activeDurationEl = document.getElementById("activeDuration");
        const shiftTimerEl = document.getElementById("shiftTimer");
        if (activeDurationEl) activeDurationEl.textContent = formatted;
        if (shiftTimerEl) shiftTimerEl.textContent = formatted;

        if (breakStart) {
          const breakDurationText =
            document.getElementById("breakDurationText");
          if (breakDurationText)
            breakDurationText.textContent = formatMs(accumulatedBreak, false);
        }
      }

      // Clock actions
      function clockIn() {
        if (!activeProjectId) {
          alert("Select a project first.");
          return;
        }
        currentShift = {
          startTime: Date.now(),
          breakStart: null,
          totalBreakMs: 0,
          notes: document.getElementById("notesInput").value.trim(),
          projectId: activeProjectId,
        };
        stampAndSync("logs", currentShift);
        saveShift();
        renderUI();
      }

      function startBreak() {
        if (!currentShift || currentShift.breakStart) return;
        currentShift.breakStart = Date.now();
        stampAndSync("logs", currentShift);
        saveShift();
        renderUI();
      }

      function endBreak() {
        if (!currentShift || !currentShift.breakStart) return;
        const breakDuration = Date.now() - currentShift.breakStart;
        currentShift.totalBreakMs =
          (Number(currentShift.totalBreakMs) || 0) + breakDuration;
        currentShift.breakStart = null;
        stampAndSync("logs", currentShift);
        saveShift();
        renderUI();
      }

      // Manually correct the active shift's break time, e.g. when the user
      // forgot to click "End Break". Overwrites the accumulated break total
      // and ends any break currently in progress, since specifying the true
      // total implies the break is over.
      function openEditActiveBreakModal() {
        if (!currentShift) return;

        const now = Date.now();
        let accumulatedBreak = Number(currentShift.totalBreakMs) || 0;
        if (currentShift.breakStart) {
          accumulatedBreak += now - getMsTimestamp(currentShift.breakStart);
        }

        document.getElementById("ebBreakMinutes").value = Math.round(
          accumulatedBreak / (1000 * 60),
        );

        const modal = document.getElementById("editBreakModal");
        modal.classList.remove("hidden");
        modal.classList.add("flex");
      }

      function closeEditBreakModal() {
        const modal = document.getElementById("editBreakModal");
        modal.classList.add("hidden");
        modal.classList.remove("flex");
      }

      function saveActiveBreakEdit(event) {
        event.preventDefault();
        if (!currentShift) {
          closeEditBreakModal();
          return;
        }

        const minutes = parseInt(
          document.getElementById("ebBreakMinutes").value,
        );
        if (isNaN(minutes) || minutes < 0) {
          alert("Enter a valid number of minutes.");
          return;
        }

        currentShift.totalBreakMs = minutes * 60 * 1000;
        currentShift.breakStart = null; // Correcting the total implies the break is now over

        stampAndSync("logs", currentShift);
        saveShift();
        renderUI();
        closeEditBreakModal();
      }

      function clockOut() {
        if (!currentShift) return;

        const now = Date.now();
        const startTime = getMsTimestamp(currentShift.startTime);
        const breakStart = currentShift.breakStart
          ? getMsTimestamp(currentShift.breakStart)
          : null;
        let totalBreak = Number(currentShift.totalBreakMs) || 0;

        if (breakStart) {
          totalBreak += now - breakStart;
        }

        const grossDuration = now - startTime;
        const netDuration = Math.max(0, grossDuration - totalBreak);

        const newLog = {
          id: Date.now(),
          // Carries the same syncId currentShift already had (assigned by
          // stampAndSync() at clockIn) so the eventual push updates the
          // server's shifts row status active -> completed in place,
          // instead of stampAndSync minting a fresh syncId here and
          // leaving a duplicate "active" row stuck server-side forever.
          syncId: currentShift.syncId,
          projectId: currentShift.projectId || activeProjectId,
          date: new Date(startTime).toLocaleDateString(),
          startTimeISO: new Date(startTime).toISOString(),
          endTimeISO: new Date(now).toISOString(),
          breakMs: totalBreak,
          netDurationMs: netDuration,
          hourlyRate: getProjectRate(currentShift.projectId || activeProjectId),
          notes:
            document.getElementById("notesInput").value.trim() ||
            currentShift.notes ||
            "Normal Shift",
        };
        stampAndSync("logs", newLog);

        logs.unshift(newLog);
        currentShift = null;
        document.getElementById("notesInput").value = "";

        consolidateDailyLogs();
        saveShift();
        saveLogs();
        renderUI();
      }

      // Consolidate multiple shift entries on the same date into one assembled daily shift.
      //
      // Runs over the FULL flat `logs` array (all projects), so the grouping
      // key must include projectId, not just the calendar date — otherwise
      // two different projects' shifts on the same day would get merged
      // into one entry, and rewriting `logs = consolidated` at the end would
      // silently destroy the project boundary (and any project not touched
      // by this call would still need to survive unchanged in the result).
      function consolidateDailyLogs() {
        if (!logs || logs.length === 0) return;

        const grouped = {};
        const groupOrder = [];

        logs.forEach((log) => {
          const startObj = new Date(log.startTimeISO || log.date);
          const dateKey = `${startObj.getFullYear()}-${String(startObj.getMonth() + 1).padStart(2, "0")}-${String(startObj.getDate()).padStart(2, "0")}`;
          const groupKey = `${log.projectId || ""}::${dateKey}`;

          if (!grouped[groupKey]) {
            grouped[groupKey] = [];
            groupOrder.push(groupKey);
          }
          grouped[groupKey].push(log);
        });

        const consolidated = groupOrder.map((groupKey) => {
          const group = grouped[groupKey];
          if (group.length === 1) {
            return group[0];
          }

          // Sync identity for the merged result: keep the oldest session's
          // id/syncId (smallest numeric id) rather than group[0] — logs
          // gets unshift()ed on every clockOut/manual entry, so group[0]
          // here is whichever session was added most recently, not
          // necessarily the one already reflected server-side. Note: if
          // more than one session in this group had ALREADY independently
          // synced before this merge (rare — requires two clock-outs on
          // the same project+day with a sync cycle running between them),
          // the other session(s)' server rows are left orphaned rather
          // than cleaned up — a known gap, not attempted here.
          const canonical = group.reduce((a, b) => (a.id < b.id ? a : b));

          const projectId = group[0].projectId;
          const fallbackRate = getProjectRate(projectId) || hourlyRate || 0;

          let minStartMs = Infinity;
          let maxEndMs = -Infinity;
          let totalNetMs = 0;
          let totalEarnings = 0;
          const notesArr = [];

          group.forEach((item) => {
            const s = new Date(item.startTimeISO).getTime();
            const e = new Date(item.endTimeISO).getTime();
            // Number.isFinite() guards, not a bare comparison — NaN < x and
            // NaN > x are both always false, so a malformed startTimeISO/
            // endTimeISO (e.g. from an old importData() restore, which
            // skips normalizeLogs() entirely) would otherwise silently
            // leave minStartMs/maxEndMs stuck at their Infinity/-Infinity
            // sentinels if EVERY item in the group has an invalid date.
            // new Date(Infinity).toISOString() below then throws a
            // RangeError, which — when this runs during loadStoredData()
            // — aborts that whole synchronous load past this point,
            // including projects[] not having been read yet on an older
            // build that read it later. See CLAUDE.md section 4H.
            if (Number.isFinite(s) && s < minStartMs) minStartMs = s;
            if (Number.isFinite(e) && e > maxEndMs) maxEndMs = e;

            const net = Number(item.netDurationMs) || 0;
            totalNetMs += net;

            const rate = Number(item.hourlyRate) || fallbackRate;
            totalEarnings += (net / (1000 * 60 * 60)) * rate;

            if (
              item.notes &&
              item.notes.trim() &&
              !notesArr.includes(item.notes.trim())
            ) {
              notesArr.push(item.notes.trim());
            }
          });

          if (!Number.isFinite(minStartMs) || !Number.isFinite(maxEndMs)) {
            console.error(
              `WorkLog Pro: consolidateDailyLogs() found a same-day group (key "${groupKey}") where every session has an invalid start/end time — falling back to "now" for the merged entry instead of throwing.`,
            );
            const now = Date.now();
            if (!Number.isFinite(minStartMs)) minStartMs = now;
            if (!Number.isFinite(maxEndMs)) maxEndMs = now;
          }

          const spanMs = Math.max(0, maxEndMs - minStartMs);
          const breakMs = Math.max(0, spanMs - totalNetMs);

          const totalNetHours = totalNetMs / (1000 * 60 * 60);
          const effectiveRate =
            totalNetHours > 0
              ? totalEarnings / totalNetHours
              : group[0].hourlyRate || fallbackRate;

          const sampleStart = new Date(minStartMs);

          const merged = {
            id: canonical.id,
            syncId: canonical.syncId,
            projectId: projectId,
            date: sampleStart.toLocaleDateString(),
            startTimeISO: new Date(minStartMs).toISOString(),
            endTimeISO: new Date(maxEndMs).toISOString(),
            breakMs: breakMs,
            netDurationMs: totalNetMs,
            hourlyRate: parseFloat(effectiveRate.toFixed(2)),
            notes:
              notesArr.length > 0
                ? notesArr.join(" | ")
                : `${group.length} shifts merged`,
            sessionCount: group.length,
          };
          // The merge itself changes what this record represents (totals,
          // session count), so it needs its own sync push — reuses
          // canonical's syncId if it had one, mints one if not.
          stampAndSync("logs", merged);
          return merged;
        });

        logs = consolidated;
      }
