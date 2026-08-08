// core/invoicing.js — invoice creation, the editable preview, totals,
// generateInvoiceHTML() (shared verbatim between the on-screen preview and
// the PDF export), and signature handling (upload/remove/render — the
// signature feature has no purpose outside invoicing, even though its
// upload widget lives in the Shift Settings card in the shell markup).
//
// PDF export never calls window.invoiceAPI (or any Electron API) directly —
// it calls window.platformAdapter.exportPDF(), defined by whichever
// platform shell is loaded (platform-electron/shell.html today).

      // Invoicing Logic
      //
      // Flow: openCreateInvoiceModal() -> loadInvoiceRecordsForRange() picks
      // matching shifts/expenses -> handleCreateInvoiceSubmit() builds
      // `invoiceDraft` and opens the editable preview -> every edit in the
      // preview form re-renders both the totals and a read-only iframe whose
      // content comes from generateInvoiceHTML(), the exact same function
      // used to build the PDF, so what's previewed is what gets printed.

      function escapeHtmlForInvoice(val) {
        return escapeHtml(val === null || val === undefined ? "" : String(val));
      }

      // Signature Settings — stored once, reused on every invoice (see
      // signatureImage in the state block / persistState).
      const SIGNATURE_MAX_BYTES = 1024 * 1024;

      function handleSignatureUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        if (!["image/png", "image/jpeg"].includes(file.type)) {
          alert("Please upload a PNG or JPEG image.");
          event.target.value = "";
          return;
        }

        if (file.size > SIGNATURE_MAX_BYTES) {
          alert(
            "Signature image is too large (max ~1MB). Please choose a smaller file.",
          );
          event.target.value = "";
          return;
        }

        const reader = new FileReader();
        reader.onload = function (e) {
          signatureImage = e.target.result;
          persistState();
          renderSignatureSettings();
        };
        reader.readAsDataURL(file);
      }

      function removeSignature() {
        signatureImage = null;
        persistState();
        renderSignatureSettings();
        document.getElementById("signatureFileInput").value = "";
      }

      function renderSignatureSettings() {
        const preview = document.getElementById("signaturePreview");
        const emptyLabel = document.getElementById("signatureEmptyLabel");
        const removeBtn = document.getElementById("signatureRemoveBtn");
        if (!preview) return;

        if (signatureImage) {
          preview.src = signatureImage;
          preview.classList.remove("hidden");
          emptyLabel.classList.add("hidden");
          removeBtn.classList.remove("hidden");
        } else {
          preview.classList.add("hidden");
          preview.src = "";
          emptyLabel.classList.remove("hidden");
          removeBtn.classList.add("hidden");
        }
      }

      function openCreateInvoiceModal() {
        const project = getActiveProject();
        document.getElementById("invBusinessName").value = businessName;
        // Pre-fills "Bill To" with the active project's name — the user can
        // still freely retype it, that's just a manual override, not
        // cross-project data mixing.
        document.getElementById("invClientDetails").value = project
          ? project.name
          : "";
        document.getElementById("invNumber").value = nextInvoiceNumber;
        document.getElementById("invDateIssued").value = new Date()
          .toISOString()
          .split("T")[0];
        document.getElementById("invRangeStart").value = "";
        document.getElementById("invRangeEnd").value = "";
        document.getElementById("invRecordsPicker").classList.add("hidden");
        document.getElementById("invShiftChecklist").innerHTML = "";
        document.getElementById("invExpenseChecklist").innerHTML = "";

        ensureProductInvoiceCreateUI();
        document.getElementById("invIsProductInvoice").checked = false;
        document.getElementById("productInvoiceOptions").classList.add("hidden");
        document.getElementById("invProductDescription").value = "";
        document.getElementById("invProductAmount").value = "";
        setProductAmountMode("calculated");

        const modal = document.getElementById("createInvoiceModal");
        modal.classList.remove("hidden");
        modal.classList.add("flex");
      }

      // Product Invoice mode — a per-invoice toggle that hides shift-derived
      // line items from the client-facing preview/PDF, replacing them with
      // one editable manual line item. Injects its own markup into the
      // Create Invoice modal on first use rather than living in shell.html:
      // core/ must work identically across every platform shell (Electron,
      // web) without any of them needing a matching markup change.
      function ensureProductInvoiceCreateUI() {
        if (document.getElementById("productInvoiceSection")) return;

        const anchor = document.getElementById("invRecordsPicker");
        if (!anchor) return;

        anchor.insertAdjacentHTML(
          "beforebegin",
          `<div id="productInvoiceSection" class="border-t border-slate-100 pt-4 space-y-3">
            <div class="flex items-center gap-2">
              <input type="checkbox" id="invIsProductInvoice" onchange="handleProductInvoiceToggle(this.checked)" class="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
              <label for="invIsProductInvoice" class="text-xs font-medium text-slate-700">Product Invoice (hide shift details from client)</label>
            </div>
            <div id="productInvoiceOptions" class="hidden space-y-3 pl-6">
              <div>
                <label class="block text-xs font-medium text-slate-700 mb-1">Amount</label>
                <div class="flex gap-2">
                  <button type="button" id="pmCalculatedBtn" onclick="setProductAmountMode('calculated')" class="flex-1 py-1.5 text-xs font-semibold rounded-lg transition bg-indigo-600 text-white">Calculated from tracked hours</button>
                  <button type="button" id="pmManualBtn" onclick="setProductAmountMode('manual')" class="flex-1 py-1.5 text-xs font-semibold rounded-lg transition bg-slate-100 text-slate-600">Manual amount</button>
                </div>
                <input type="hidden" id="invProductAmountMode" value="calculated" />
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-700 mb-1">Line Item Description</label>
                <input type="text" id="invProductDescription" placeholder="Services Rendered" class="w-full px-3 py-2 border border-slate-300 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-700 mb-1">Amount ($)</label>
                <input type="number" step="0.01" min="0" id="invProductAmount" readonly class="w-full px-3 py-2 border border-slate-300 bg-slate-50 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
                <p id="invProductAmountHint" class="text-[11px] text-slate-400 mt-1">Automatically calculated from the checked shifts and expenses above.</p>
              </div>
            </div>
          </div>`,
        );
      }

      function handleProductInvoiceToggle(checked) {
        document
          .getElementById("productInvoiceOptions")
          .classList.toggle("hidden", !checked);

        if (checked) {
          // Only pre-fill if the user hasn't already typed something —
          // avoids clobbering their own edit on an uncheck/recheck cycle.
          const descInput = document.getElementById("invProductDescription");
          if (!descInput.value.trim()) {
            const project = getActiveProject();
            descInput.value =
              (project && project.lastProductInvoiceDescription) || "";
          }
          setProductAmountMode("calculated");
        }
      }

      // Shared by setProductAmountMode() (Create modal) and
      // renderProductInvoicePreviewControls() (Preview modal) — the two
      // button pairs live in different DOM regions with different ids, but
      // the active/inactive styling logic itself is identical.
      function applyProductModeButtonStyles(calcBtn, manualBtn, calculated) {
        calcBtn.classList.toggle("bg-indigo-600", calculated);
        calcBtn.classList.toggle("text-white", calculated);
        calcBtn.classList.toggle("bg-slate-100", !calculated);
        calcBtn.classList.toggle("text-slate-600", !calculated);
        manualBtn.classList.toggle("bg-indigo-600", !calculated);
        manualBtn.classList.toggle("text-white", !calculated);
        manualBtn.classList.toggle("bg-slate-100", calculated);
        manualBtn.classList.toggle("text-slate-600", calculated);
      }

      // Builds the Product Invoice auto-generated line item. Shared by
      // handleCreateInvoiceSubmit() (Create modal) and
      // updateInvoiceProductToggle() (Preview modal, toggling on mid-edit)
      // so the two entry points can never drift apart. rawDescription may be
      // empty (the Preview modal has no separate description input to read
      // at toggle time — the item's description is edited afterward through
      // the normal expense-row editing) — the fallback chain still resolves
      // the same way either way.
      function buildProductInvoiceLineItem(rawDescription, amount) {
        const project = getActiveProject();
        const description =
          (rawDescription || "").trim() ||
          (project && project.lastProductInvoiceDescription) ||
          "Services Rendered";
        return {
          id: generateId(),
          sourceExpenseId: null,
          description,
          amount: Number(amount) || 0,
          isAutoGenerated: true,
        };
      }

      function setProductAmountMode(mode) {
        document.getElementById("invProductAmountMode").value = mode;

        const calcBtn = document.getElementById("pmCalculatedBtn");
        const manualBtn = document.getElementById("pmManualBtn");
        const calculated = mode === "calculated";
        applyProductModeButtonStyles(calcBtn, manualBtn, calculated);

        const amountInput = document.getElementById("invProductAmount");
        const hint = document.getElementById("invProductAmountHint");
        if (calculated) {
          amountInput.readOnly = true;
          amountInput.classList.add("bg-slate-50");
          hint.textContent =
            "Automatically calculated from the checked shifts and expenses above.";
          // Re-syncs to the live total, discarding whatever manual edit was
          // there — switching back to calculated is meant to trust the
          // formula again, not preserve a manual override.
          recomputeProductInvoiceAmount();
        } else {
          // Deliberately do NOT reset the value here — whatever the
          // calculated amount currently was is a better starting point for
          // manual editing than 0.
          amountInput.readOnly = false;
          amountInput.classList.remove("bg-slate-50");
          hint.textContent = "Enter the amount to bill for this invoice.";
        }
      }

      // Live-sums the currently checked shift/expense checklist items — the
      // same data handleCreateInvoiceSubmit() reads at submit time — so
      // "Calculated" mode's displayed amount tracks the checklist selection
      // in real time rather than a one-time snapshot. No-op in manual mode.
      function recomputeProductInvoiceAmount() {
        const modeInput = document.getElementById("invProductAmountMode");
        if (!modeInput || modeInput.value !== "calculated") return;

        const checkedShiftIds = Array.from(
          document.querySelectorAll(".inv-shift-check:checked"),
        ).map((el) => Number(el.value));
        const checkedExpenseIds = Array.from(
          document.querySelectorAll(".inv-expense-check:checked"),
        ).map((el) => Number(el.value));

        const laborTotal = logs
          .filter((log) => checkedShiftIds.includes(log.id))
          .reduce((sum, log) => {
            const hours = (Number(log.netDurationMs) || 0) / (1000 * 60 * 60);
            const rate = Number(log.hourlyRate) || getActiveRate();
            return sum + hours * rate;
          }, 0);

        const expenseTotal = expenses
          .filter((exp) => checkedExpenseIds.includes(exp.id))
          .reduce((sum, exp) => sum + (Number(exp.amount) || 0), 0);

        const amountInput = document.getElementById("invProductAmount");
        if (amountInput) {
          amountInput.value = (laborTotal + expenseTotal).toFixed(2);
        }
      }

      function closeCreateInvoiceModal() {
        const modal = document.getElementById("createInvoiceModal");
        modal.classList.add("hidden");
        modal.classList.remove("flex");
      }

      function loadInvoiceRecordsForRange() {
        const startVal = document.getElementById("invRangeStart").value;
        const endVal = document.getElementById("invRangeEnd").value;
        if (!startVal || !endVal) {
          alert("Choose a start and end date first.");
          return;
        }

        const rangeStart = new Date(`${startVal}T00:00:00`).getTime();
        const rangeEnd = new Date(`${endVal}T23:59:59`).getTime();

        // Scoped to the active project — an invoice should never pull in
        // another project's shifts/expenses just because the dates overlap.
        const matchingLogs = logs.filter((log) => {
          if (log.projectId !== activeProjectId) return false;
          const t = new Date(log.startTimeISO || log.date).getTime();
          return !isNaN(t) && t >= rangeStart && t <= rangeEnd;
        });

        // expense.date is a locale-formatted string (no ISO field exists on
        // expense records), so this relies on it being parseable the same
        // way the rest of the app already assumes (see consolidateDailyLogs).
        const matchingExpenses = expenses.filter((exp) => {
          if (exp.projectId !== activeProjectId) return false;
          const t = new Date(exp.date).getTime();
          return !isNaN(t) && t >= rangeStart && t <= rangeEnd;
        });

        const shiftList = document.getElementById("invShiftChecklist");
        shiftList.innerHTML =
          matchingLogs.length === 0
            ? '<p class="text-xs text-slate-400 italic">No shifts in this range.</p>'
            : matchingLogs
                .map((log) => {
                  const hrs = (
                    (Number(log.netDurationMs) || 0) /
                    (1000 * 60 * 60)
                  ).toFixed(2);
                  return `
                    <label class="flex items-center gap-2 py-1.5 text-xs text-slate-600">
                      <input type="checkbox" class="inv-shift-check" value="${log.id}" checked onchange="recomputeProductInvoiceAmount()" />
                      <span class="flex-1">${escapeHtml(log.date || "")} — ${hrs} hrs — ${escapeHtml(log.notes || "Normal Shift")}</span>
                    </label>`;
                })
                .join("");

        const expenseList = document.getElementById("invExpenseChecklist");
        expenseList.innerHTML =
          matchingExpenses.length === 0
            ? '<p class="text-xs text-slate-400 italic">No expenses in this range.</p>'
            : matchingExpenses
                .map(
                  (exp) => `
                    <label class="flex items-center gap-2 py-1.5 text-xs text-slate-600">
                      <input type="checkbox" class="inv-expense-check" value="${exp.id}" checked onchange="recomputeProductInvoiceAmount()" />
                      <span class="flex-1">${escapeHtml(exp.date || "")} — ${escapeHtml(exp.title)} — $${(Number(exp.amount) || 0).toFixed(2)}</span>
                    </label>`,
                )
                .join("");

        document.getElementById("invRecordsPicker").classList.remove("hidden");
        // Checkboxes start checked, so the calculated amount (if Product
        // Invoice + Calculated mode is already on) should reflect that
        // immediately rather than waiting for the first manual toggle.
        recomputeProductInvoiceAmount();
      }

      function handleCreateInvoiceSubmit(event) {
        event.preventDefault();

        const checkedShiftIds = Array.from(
          document.querySelectorAll(".inv-shift-check:checked"),
        ).map((el) => Number(el.value));
        const checkedExpenseIds = Array.from(
          document.querySelectorAll(".inv-expense-check:checked"),
        ).map((el) => Number(el.value));

        const workItems = logs
          .filter((log) => checkedShiftIds.includes(log.id))
          .map((log) => ({
            id: generateId(),
            sourceLogId: log.id,
            date: log.date || "",
            description: log.notes || "Normal Shift",
            hours: parseFloat(
              (
                (Number(log.netDurationMs) || 0) /
                (1000 * 60 * 60)
              ).toFixed(2),
            ),
            rate: Number(log.hourlyRate) || getActiveRate(),
          }));

        const expenseItems = expenses
          .filter((exp) => checkedExpenseIds.includes(exp.id))
          .map((exp) => ({
            id: generateId(),
            sourceExpenseId: exp.id,
            description: exp.title,
            amount: Number(exp.amount) || 0,
          }));

        const invNumber =
          document.getElementById("invNumber").value.trim() ||
          String(nextInvoiceNumber);

        // Product Invoice: auto-create ONE manual line item via the same
        // mechanism addManualLineItem() uses (a plain expenseItems entry),
        // marked isAutoGenerated so toggling this off later can distinguish
        // it from the user's own manual lines. workItems/expenseItems above
        // are untouched either way — the underlying shift/expense selection
        // is always stored for the user's own records, regardless of this
        // toggle; it's purely a rendering decision (see generateInvoiceHTML).
        const isProductInvoice = document.getElementById(
          "invIsProductInvoice",
        ).checked;
        const productAmountMode =
          document.getElementById("invProductAmountMode").value === "manual"
            ? "manual"
            : "calculated";

        if (isProductInvoice) {
          const rawDescription = document.getElementById(
            "invProductDescription",
          ).value;
          const amount =
            parseFloat(document.getElementById("invProductAmount").value) ||
            0;
          expenseItems.push(buildProductInvoiceLineItem(rawDescription, amount));
        }

        invoiceDraft = {
          savedInvoiceId: null,
          projectId: activeProjectId,
          invoiceNumber: invNumber,
          businessName: document.getElementById("invBusinessName").value.trim(),
          clientDetails: document
            .getElementById("invClientDetails")
            .value.trim(),
          dateIssued:
            document.getElementById("invDateIssued").value ||
            new Date().toISOString().split("T")[0],
          language: "en",
          workItems,
          expenseItems,
          discount: 0,
          includeSignature: !!signatureImage,
          isProductInvoice,
          productAmountMode,
        };

        closeCreateInvoiceModal();
        openInvoicePreview();
      }

      function computeInvoiceTotals(draft) {
        const laborSubtotal = draft.workItems.reduce(
          (sum, item) =>
            sum + (Number(item.hours) || 0) * (Number(item.rate) || 0),
          0,
        );
        const expensesSubtotal = draft.expenseItems.reduce(
          (sum, item) => sum + (Number(item.amount) || 0),
          0,
        );
        const subtotal = laborSubtotal + expensesSubtotal;
        const discount = Number(draft.discount) || 0;
        const total = Math.max(0, subtotal - discount);
        return { laborSubtotal, expensesSubtotal, subtotal, discount, total };
      }

      function buildInvoiceSnapshot(draft) {
        const totals = computeInvoiceTotals(draft);
        return {
          invoiceNumber: draft.invoiceNumber,
          businessName: draft.businessName,
          clientDetails: draft.clientDetails,
          dateIssued: draft.dateIssued,
          // Rendering-only flag — generateInvoiceHTML() skips the
          // shift-derived work section when true. Doesn't affect which data
          // is stored (see workItems below, always populated in full).
          isProductInvoice: !!draft.isProductInvoice,
          workItems: draft.workItems.map((w) => ({
            date: w.date,
            description: w.description,
            hours: Number(w.hours) || 0,
            rate: Number(w.rate) || 0,
            amount: (Number(w.hours) || 0) * (Number(w.rate) || 0),
          })),
          expenseItems: draft.expenseItems.map((e) => ({
            description: e.description,
            amount: Number(e.amount) || 0,
            // Carried through so a reopened invoice can still tell which
            // line item is the auto-generated one (see reopenInvoice()).
            isAutoGenerated: !!e.isAutoGenerated,
          })),
          laborSubtotal: totals.laborSubtotal,
          expensesSubtotal: totals.expensesSubtotal,
          discount: totals.discount,
          total: totals.total,
          // The signature image itself is stored once in settings, not per
          // draft — only whether to include it is per-invoice.
          signatureImage: draft.includeSignature ? signatureImage : null,
        };
      }

      function openInvoicePreview() {
        if (!invoiceDraft) return;

        document.getElementById("pvBusinessName").value =
          invoiceDraft.businessName;
        document.getElementById("pvClientDetails").value =
          invoiceDraft.clientDetails;
        document.getElementById("pvInvoiceNumber").value =
          invoiceDraft.invoiceNumber;
        document.getElementById("pvDateIssued").value = invoiceDraft.dateIssued;
        document.getElementById("pvDiscount").value = invoiceDraft.discount;

        const sigWrap = document.getElementById("pvSignatureToggleWrap");
        if (signatureImage) {
          sigWrap.classList.remove("hidden");
          document.getElementById("pvIncludeSignature").checked =
            !!invoiceDraft.includeSignature;
        } else {
          sigWrap.classList.add("hidden");
        }

        setInvoiceLanguage(invoiceDraft.language || "en");

        const modal = document.getElementById("invoicePreviewModal");
        modal.classList.remove("hidden");
        modal.classList.add("flex");
      }

      function updateInvoiceSignatureToggle(checked) {
        invoiceDraft.includeSignature = checked;
        renderInvoiceEditor();
      }

      function closeInvoicePreviewModal() {
        const modal = document.getElementById("invoicePreviewModal");
        modal.classList.add("hidden");
        modal.classList.remove("flex");
      }

      // Same Product Invoice toggle + Calculated/Manual control as the
      // Create modal, mirrored into the Preview/Edit modal so an existing
      // invoice's mode can be changed after the fact, not just at creation.
      // No separate description/amount inputs here (unlike the Create
      // modal) — once invoiceDraft exists, the auto-generated item is just
      // a normal row in the expense table below, already editable through
      // the existing updateExpenseItem()/read-only-when-derived machinery.
      function ensureProductInvoicePreviewUI() {
        if (document.getElementById("pvProductInvoiceSection")) return;

        const anchor = document.getElementById("pvSignatureToggleWrap");
        if (!anchor) return;

        anchor.insertAdjacentHTML(
          "afterend",
          `<div id="pvProductInvoiceSection" class="space-y-2">
            <div class="flex items-center gap-2">
              <input type="checkbox" id="pvIsProductInvoice" onchange="updateInvoiceProductToggle(this.checked)" class="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
              <label for="pvIsProductInvoice" class="text-xs font-medium text-slate-700">Product Invoice (hide shift details from client)</label>
            </div>
            <div id="pvProductAmountModeWrap" class="hidden flex gap-2 pl-6">
              <button type="button" id="pvProductCalcBtn" onclick="updateInvoiceProductAmountMode('calculated')" class="flex-1 py-1.5 text-xs font-semibold rounded-lg transition bg-indigo-600 text-white">Calculated from tracked hours</button>
              <button type="button" id="pvProductManualBtn" onclick="updateInvoiceProductAmountMode('manual')" class="flex-1 py-1.5 text-xs font-semibold rounded-lg transition bg-slate-100 text-slate-600">Manual amount</button>
            </div>
          </div>`,
        );
      }

      // Keeps the preview's own checkbox/buttons in sync with invoiceDraft —
      // called on every renderInvoiceEditor() pass (same "resync from the
      // source of truth every render" approach as the totals/table bodies
      // below), so reopening an existing product invoice shows the toggle
      // already correctly set without any extra wiring at reopen time.
      function renderProductInvoicePreviewControls() {
        const checkbox = document.getElementById("pvIsProductInvoice");
        const modeWrap = document.getElementById("pvProductAmountModeWrap");
        if (!checkbox || !modeWrap) return;

        checkbox.checked = !!invoiceDraft.isProductInvoice;
        modeWrap.classList.toggle("hidden", !invoiceDraft.isProductInvoice);

        const calcBtn = document.getElementById("pvProductCalcBtn");
        const manualBtn = document.getElementById("pvProductManualBtn");
        const calculated =
          (invoiceDraft.productAmountMode || "calculated") === "calculated";
        applyProductModeButtonStyles(calcBtn, manualBtn, calculated);
      }

      // Toggling ON: synthesize the auto-generated line item (via the same
      // builder handleCreateInvoiceSubmit() uses) and add it to
      // expenseItems. Toggling OFF: remove ONLY that item — every other
      // manual/discount line item the user added themselves, even while
      // this was on, is left untouched. The shift/expense checklist data
      // underlying workItems is never discarded by this toggle either way
      // (see buildInvoiceSnapshot's comment), so turning it back off always
      // restores the full itemized view with nothing lost.
      function updateInvoiceProductToggle(checked) {
        if (!invoiceDraft) return;

        invoiceDraft.isProductInvoice = checked;

        if (checked) {
          const hasAutoItem = invoiceDraft.expenseItems.some(
            (e) => e.isAutoGenerated,
          );
          if (!hasAutoItem) {
            invoiceDraft.expenseItems.push(
              buildProductInvoiceLineItem("", 0),
            );
          }
          // Matches the Create modal's own toggle-on behavior (see
          // handleProductInvoiceToggle): always resets to "calculated" so a
          // fresh toggle-on starts from a live total, not a stale mode left
          // over from an earlier on/off cycle in this same session.
          invoiceDraft.productAmountMode = "calculated";
        } else {
          invoiceDraft.expenseItems = invoiceDraft.expenseItems.filter(
            (e) => !e.isAutoGenerated,
          );
        }

        renderInvoiceEditor();
      }

      // Switching modes while already on. The actual recompute/discard
      // behavior lives in the reactive block at the top of
      // renderInvoiceEditor() below — it already recomputes the
      // auto-item's amount from every other line item whenever mode is
      // "calculated", and leaves it exactly as-is (so it keeps whatever
      // value it last held) when "manual". That block was written mode-
      // generically from the start, so switching modes here needs nothing
      // more than flipping the field and re-rendering.
      function updateInvoiceProductAmountMode(mode) {
        if (!invoiceDraft) return;
        invoiceDraft.productAmountMode = mode === "manual" ? "manual" : "calculated";
        renderInvoiceEditor();
      }

      function renderInvoiceEditor() {
        if (!invoiceDraft) return;

        ensureProductInvoicePreviewUI();
        renderProductInvoicePreviewControls();

        // Product Invoice + "calculated" mode: keep the auto-generated line
        // item's amount derived from every OTHER work/expense item, fresh on
        // every render — the same "recompute, don't cache" pattern
        // computeInvoiceTotals() already uses, applied to one line item
        // instead of the grand total. No-op if the user removed that item.
        if (
          invoiceDraft.isProductInvoice &&
          invoiceDraft.productAmountMode === "calculated"
        ) {
          const autoItem = invoiceDraft.expenseItems.find(
            (e) => e.isAutoGenerated,
          );
          if (autoItem) {
            const laborTotal = invoiceDraft.workItems.reduce(
              (sum, w) => sum + (Number(w.hours) || 0) * (Number(w.rate) || 0),
              0,
            );
            const otherExpenseTotal = invoiceDraft.expenseItems
              .filter((e) => e !== autoItem)
              .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
            autoItem.amount = laborTotal + otherExpenseTotal;
          }
        }

        const workBody = document.getElementById("pvWorkItemsBody");
        workBody.innerHTML = invoiceDraft.workItems
          .map((item) => {
            const amount = (
              (Number(item.hours) || 0) * (Number(item.rate) || 0)
            ).toFixed(2);
            return `
              <tr>
                <td class="px-2 py-1.5"><input type="text" value="${escapeHtml(item.date)}" oninput="updateWorkItem('${item.id}','date',this.value)" class="w-24 text-xs border border-slate-200 rounded-lg px-2 py-1" /></td>
                <td class="px-2 py-1.5"><input type="text" value="${escapeHtml(item.description)}" oninput="updateWorkItem('${item.id}','description',this.value)" class="w-full text-xs border border-slate-200 rounded-lg px-2 py-1" /></td>
                <td class="px-2 py-1.5"><input type="number" step="0.01" min="0" value="${item.hours}" oninput="updateWorkItem('${item.id}','hours',this.value)" class="w-16 text-xs border border-slate-200 rounded-lg px-2 py-1" /></td>
                <td class="px-2 py-1.5"><input type="number" step="0.01" min="0" value="${item.rate}" oninput="updateWorkItem('${item.id}','rate',this.value)" class="w-16 text-xs border border-slate-200 rounded-lg px-2 py-1" /></td>
                <td class="px-2 py-1.5 text-xs font-semibold text-slate-700 whitespace-nowrap">$${amount}</td>
                <td class="px-2 py-1.5 text-right"><button type="button" onclick="removeWorkItem('${item.id}')" class="text-slate-400 hover:text-rose-600"><i class="fa-solid fa-xmark"></i></button></td>
              </tr>`;
          })
          .join("");

        const expenseBody = document.getElementById("pvExpenseItemsBody");
        expenseBody.innerHTML = invoiceDraft.expenseItems
          .map((item) => {
            // The auto-generated line item's amount is derived (not
            // user-entered) while in "calculated" mode — render it as
            // read-only text instead of an editable input so there's no
            // input to edit that would just get overwritten on the next
            // render anyway. Its description stays editable either way.
            const isDerivedAmount =
              item.isAutoGenerated &&
              invoiceDraft.isProductInvoice &&
              invoiceDraft.productAmountMode === "calculated";
            const amountCell = isDerivedAmount
              ? `<span class="text-xs font-semibold text-slate-700">$${(Number(item.amount) || 0).toFixed(2)}</span>`
              : `<input type="number" step="0.01" min="0" value="${item.amount}" oninput="updateExpenseItem('${item.id}','amount',this.value)" class="w-24 text-xs border border-slate-200 rounded-lg px-2 py-1" />`;

            return `
              <tr>
                <td class="px-2 py-1.5"><input type="text" value="${escapeHtml(item.description)}" oninput="updateExpenseItem('${item.id}','description',this.value)" class="w-full text-xs border border-slate-200 rounded-lg px-2 py-1" /></td>
                <td class="px-2 py-1.5">${amountCell}</td>
                <td class="px-2 py-1.5 text-right"><button type="button" onclick="removeExpenseItem('${item.id}')" class="text-slate-400 hover:text-rose-600"><i class="fa-solid fa-xmark"></i></button></td>
              </tr>`;
          })
          .join("");

        const totals = computeInvoiceTotals(invoiceDraft);
        document.getElementById("pvLaborSubtotal").textContent =
          `$${totals.laborSubtotal.toFixed(2)}`;
        document.getElementById("pvExpensesSubtotal").textContent =
          `$${totals.expensesSubtotal.toFixed(2)}`;
        document.getElementById("pvGrandTotal").textContent =
          `$${totals.total.toFixed(2)}`;

        renderInvoiceLivePreview();
      }

      function updateWorkItem(id, field, value) {
        const item = invoiceDraft.workItems.find((w) => w.id === id);
        if (!item) return;
        item[field] = field === "hours" || field === "rate"
          ? parseFloat(value) || 0
          : value;
        renderInvoiceEditor();
      }

      function removeWorkItem(id) {
        invoiceDraft.workItems = invoiceDraft.workItems.filter(
          (w) => w.id !== id,
        );
        renderInvoiceEditor();
      }

      function updateExpenseItem(id, field, value) {
        const item = invoiceDraft.expenseItems.find((e) => e.id === id);
        if (!item) return;
        item[field] = field === "amount" ? parseFloat(value) || 0 : value;
        renderInvoiceEditor();
      }

      function removeExpenseItem(id) {
        invoiceDraft.expenseItems = invoiceDraft.expenseItems.filter(
          (e) => e.id !== id,
        );
        renderInvoiceEditor();
      }

      function addManualLineItem() {
        invoiceDraft.expenseItems.push({
          id: generateId(),
          sourceExpenseId: null,
          description: "New line item",
          amount: 0,
        });
        renderInvoiceEditor();
      }

      function updateInvoiceDiscount(value) {
        invoiceDraft.discount = parseFloat(value) || 0;
        renderInvoiceEditor();
      }

      function setInvoiceLanguage(lang) {
        invoiceDraft.language = lang;
        [
          ["pvLangEnBtn", "en"],
          ["pvLangArBtn", "ar"],
        ].forEach(([btnId, code]) => {
          const btn = document.getElementById(btnId);
          const active = code === lang;
          btn.classList.toggle("bg-indigo-600", active);
          btn.classList.toggle("text-white", active);
          btn.classList.toggle("bg-slate-100", !active);
          btn.classList.toggle("text-slate-600", !active);
        });
        renderInvoiceEditor();
      }

      // Pulls the current header input values into invoiceDraft, then
      // rebuilds the read-only iframe from generateInvoiceHTML() so it
      // always mirrors exactly what Export PDF will produce.
      function renderInvoiceLivePreview() {
        if (!invoiceDraft) return;

        invoiceDraft.businessName =
          document.getElementById("pvBusinessName").value;
        invoiceDraft.clientDetails =
          document.getElementById("pvClientDetails").value;
        invoiceDraft.invoiceNumber =
          document.getElementById("pvInvoiceNumber").value;
        invoiceDraft.dateIssued = document.getElementById("pvDateIssued").value;

        const snapshot = buildInvoiceSnapshot(invoiceDraft);
        const html = generateInvoiceHTML(snapshot, invoiceDraft.language);
        document.getElementById("invoicePreviewFrame").srcdoc = html;
      }

      // Builds the fully self-contained invoice document (inline styles, no
      // CDN dependency) used for BOTH the on-screen iframe preview and the
      // PDF export, so what's previewed is exactly what gets printed.
      function generateInvoiceHTML(invoiceData, lang) {
        const t = INVOICE_I18N[lang] || INVOICE_I18N.en;
        const isRTL = lang === "ar";
        const dir = isRTL ? "rtl" : "ltr";

        // Column order in the markup below is always the natural
        // date->description->...->amount sequence, in BOTH languages. CSS
        // table layout automatically reverses visual column order when
        // `direction: rtl` applies (inherited here from <html dir="rtl">) —
        // that's the actual mechanism that flips columns for Arabic. Manually
        // reversing this array as well would double-flip it back to the
        // wrong (LTR) order while dir="rtl" is active.
        const workHeaders = [t.date, t.description, t.hours, t.rate, t.amount]
          .map((h) => `<th>${escapeHtmlForInvoice(h)}</th>`)
          .join("");

        const workRows = invoiceData.workItems
          .map((item) => {
            const cells = [
              escapeHtmlForInvoice(item.date),
              escapeHtmlForInvoice(item.description),
              item.hours.toFixed(2),
              `$${item.rate.toFixed(2)}`,
              `$${item.amount.toFixed(2)}`,
            ];
            return `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
          })
          .join("");

        const expenseHeaders = [t.description, t.amount]
          .map((h) => `<th>${escapeHtmlForInvoice(h)}</th>`)
          .join("");

        const expenseRows = invoiceData.expenseItems
          .map((item) => {
            const cells = [
              escapeHtmlForInvoice(item.description),
              `$${item.amount.toFixed(2)}`,
            ];
            return `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
          })
          .join("");

        // Product Invoice mode hides shift-derived rows from the
        // client-facing document entirely — the underlying data is still
        // fully present on invoiceData.workItems (see buildInvoiceSnapshot),
        // this is purely a rendering decision. Expense/manual line items
        // (including the auto-generated Product Invoice line item, which is
        // just a normal entry in expenseItems) render through the existing
        // expense path below, unaffected.
        const workSection =
          !invoiceData.isProductInvoice && invoiceData.workItems.length
            ? `
            <h2>${escapeHtmlForInvoice(t.workSummary)}</h2>
            <table class="items" dir="${dir}">
              <thead><tr>${workHeaders}</tr></thead>
              <tbody>${workRows}</tbody>
            </table>`
            : "";

        const expenseSection = invoiceData.expenseItems.length
          ? `
            <h2>${escapeHtmlForInvoice(t.expenses)}</h2>
            <table class="items" dir="${dir}">
              <thead><tr>${expenseHeaders}</tr></thead>
              <tbody>${expenseRows}</tbody>
            </table>`
          : "";

        // signatureImage is the raw base64 data URL (not user-authored
        // text), so it's inserted directly rather than through
        // escapeHtmlForInvoice — same precedent as the existing expense
        // attachment viewer (viewAttachment) elsewhere in this file.
        const signatureSection = invoiceData.signatureImage
          ? `
            <div class="signature-block">
              <div><img src="${invoiceData.signatureImage}" alt="${escapeHtmlForInvoice(t.authorizedSignature)}" /></div>
              <div class="signature-line"></div>
              <div class="signature-label">${escapeHtmlForInvoice(t.authorizedSignature)}</div>
            </div>`
          : "";

        return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="UTF-8" />
<title>${escapeHtmlForInvoice(t.invoice)} ${escapeHtmlForInvoice(invoiceData.invoiceNumber)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: "Segoe UI", Tahoma, Arial, sans-serif;
    color: #1e293b;
    margin: 0;
    padding: 40px;
    direction: ${dir};
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-bottom: 3px solid #4f46e5;
    padding-bottom: 20px;
    margin-bottom: 24px;
  }
  .header h1 { font-size: 26px; margin: 0 0 4px 0; color: #4f46e5; }
  .business-name { font-size: 15px; font-weight: 600; color: #334155; }
  .meta { text-align: ${isRTL ? "left" : "right"}; font-size: 12px; color: #64748b; }
  .meta div { margin-bottom: 4px; }
  .bill-to { margin-bottom: 28px; }
  .bill-to .label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #94a3b8;
    margin-bottom: 4px;
  }
  .bill-to .details { font-size: 13px; color: #334155; white-space: pre-line; }
  h2 {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #4f46e5;
    margin: 24px 0 10px 0;
  }
  table.items { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 8px; }
  table.items th {
    background: #f1f5f9;
    color: #64748b;
    text-transform: uppercase;
    font-size: 10px;
    padding: 8px 10px;
    text-align: ${isRTL ? "right" : "left"};
    border-bottom: 1px solid #e2e8f0;
  }
  table.items td {
    padding: 8px 10px;
    border-bottom: 1px solid #f1f5f9;
    text-align: ${isRTL ? "right" : "left"};
  }
  .totals {
    margin-top: 20px;
    width: 280px;
    /* LTR: pinned right (margin-left auto pushes it flush right).
       RTL: mirrored to the left, matching .signature-block's flip. */
    margin-left: ${isRTL ? "0" : "auto"};
    margin-right: ${isRTL ? "auto" : "0"};
    font-size: 13px;
  }
  .totals .row { display: flex; justify-content: space-between; padding: 6px 0; color: #475569; }
  .totals .grand {
    border-top: 2px solid #4f46e5;
    margin-top: 6px;
    padding-top: 10px;
    font-size: 16px;
    font-weight: 700;
    color: #1e293b;
  }
  .signature-block {
    margin-top: 40px;
    /* Mirrors to the same side the rest of the RTL layout reads from,
       instead of staying pinned to one physical side in both languages. */
    text-align: ${isRTL ? "right" : "left"};
  }
  .signature-block img {
    max-height: 70px;
    max-width: 220px;
    object-fit: contain;
  }
  .signature-line {
    display: inline-block;
    width: 220px;
    border-top: 1px solid #94a3b8;
    margin-top: 6px;
  }
  .signature-label {
    font-size: 11px;
    color: #64748b;
    margin-top: 4px;
  }
  .footer {
    margin-top: 48px;
    text-align: center;
    font-size: 12px;
    color: #94a3b8;
    border-top: 1px solid #e2e8f0;
    padding-top: 16px;
  }

  /* Print-only (web platform's window.print(), and — since printToPDF is
     also a print rendering pass — this affects the Electron PDF too, which
     is fine: printBackground:true already forces background colors there
     and its margins are already 0, so this just matches the desktop output
     rather than changing it. Deliberately does NOT touch margin-left,
     margin-right, or text-align anywhere (those are the RTL-mirroring
     properties on .totals/.signature-block/table.items th/td) so this
     cannot reintroduce the RTL double-flip regression from before — the
     existing dir="${dir}"-driven mirroring simply carries through
     untouched into print. */
  @media print {
    @page {
      size: A4;
      margin: 0;
    }
    body {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
  }
</style>
</head>
<body>
  <div class="header">
    <div>
      <h1>${escapeHtmlForInvoice(t.invoice)}</h1>
      <div class="business-name">${escapeHtmlForInvoice(invoiceData.businessName)}</div>
    </div>
    <div class="meta">
      <div><strong>${escapeHtmlForInvoice(t.invoiceNumber)}:</strong> ${escapeHtmlForInvoice(invoiceData.invoiceNumber)}</div>
      <div><strong>${escapeHtmlForInvoice(t.dateIssued)}:</strong> ${escapeHtmlForInvoice(invoiceData.dateIssued)}</div>
    </div>
  </div>

  <div class="bill-to">
    <div class="label">${escapeHtmlForInvoice(t.billTo)}</div>
    <div class="details">${escapeHtmlForInvoice(invoiceData.clientDetails)}</div>
  </div>

  ${workSection}
  ${expenseSection}

  <div class="totals">
    <div class="row"><span>${escapeHtmlForInvoice(t.subtotal)}</span><span>$${(invoiceData.laborSubtotal + invoiceData.expensesSubtotal).toFixed(2)}</span></div>
    <div class="row"><span>${escapeHtmlForInvoice(t.discount)}</span><span>-$${invoiceData.discount.toFixed(2)}</span></div>
    <div class="row grand"><span>${escapeHtmlForInvoice(t.total)}</span><span>$${invoiceData.total.toFixed(2)}</span></div>
  </div>

  ${signatureSection}

  <div class="footer">${escapeHtmlForInvoice(t.thankYou)}</div>
</body>
</html>`;
      }

      async function exportInvoiceToPDF() {
        if (!invoiceDraft) return;
        // Platform-agnostic: never call window.invoiceAPI (Electron-specific)
        // directly from core/. Every platform shell (Electron today, a future
        // PWA/Capacitor shell later) must define window.platformAdapter.exportPDF.
        if (!window.platformAdapter || typeof window.platformAdapter.exportPDF !== "function") {
          alert("PDF export isn't available — try restarting the app.");
          return;
        }

        renderInvoiceLivePreview(); // ensure latest header edits are captured

        const snapshot = buildInvoiceSnapshot(invoiceDraft);
        const html = generateInvoiceHTML(snapshot, invoiceDraft.language);
        const suggestedFileName = `Invoice-${invoiceDraft.invoiceNumber || "draft"}.pdf`;

        const exportBtn = document.getElementById("pvExportBtn");
        exportBtn.disabled = true;
        const originalLabel = exportBtn.innerHTML;
        exportBtn.innerHTML = "Exporting...";

        try {
          const result = await window.platformAdapter.exportPDF(
            html,
            suggestedFileName,
          );

          if (!result.success) {
            if (result.error !== "canceled") {
              alert(`PDF export failed: ${result.error || "Unknown error"}`);
            }
            return;
          }

          saveInvoiceRecord(snapshot);
          alert(`Invoice exported to:\n${result.filePath}`);
        } catch (err) {
          alert(`PDF export failed: ${err.message}`);
        } finally {
          exportBtn.disabled = false;
          exportBtn.innerHTML = originalLabel;
        }
      }

      function saveInvoiceRecord(snapshot) {
        const now = new Date().toISOString();
        const enteredNumber = parseInt(invoiceDraft.invoiceNumber, 10);
        const existingIdx = invoiceDraft.savedInvoiceId
          ? invoices.findIndex((inv) => inv.id === invoiceDraft.savedInvoiceId)
          : -1;

        const record = {
          id: invoiceDraft.savedInvoiceId || Date.now(),
          projectId: invoiceDraft.projectId || activeProjectId,
          invoiceNumber: invoiceDraft.invoiceNumber,
          clientDetails: invoiceDraft.clientDetails,
          businessName: invoiceDraft.businessName,
          dateIssued: invoiceDraft.dateIssued,
          language: invoiceDraft.language,
          isProductInvoice: !!invoiceDraft.isProductInvoice,
          productAmountMode: invoiceDraft.productAmountMode || "calculated",
          lineItems: [
            ...snapshot.workItems.map((w) => ({ type: "work", ...w })),
            ...snapshot.expenseItems.map((e) => ({ type: "expense", ...e })),
          ],
          discount: snapshot.discount,
          subtotal: snapshot.laborSubtotal + snapshot.expensesSubtotal,
          total: snapshot.total,
          // Only the on/off choice is saved, never the image itself — it
          // stays stored once in settings (signatureImage) and is resolved
          // fresh whenever this invoice is reopened or re-exported.
          includeSignature: !!invoiceDraft.includeSignature,
          createdAt: existingIdx !== -1 ? invoices[existingIdx].createdAt : now,
          updatedAt: now,
        };

        if (existingIdx !== -1) {
          invoices[existingIdx] = record;
        } else {
          invoices.unshift(record);
          invoiceDraft.savedInvoiceId = record.id;
        }

        if (!isNaN(enteredNumber)) {
          nextInvoiceNumber = Math.max(nextInvoiceNumber, enteredNumber + 1);
        }
        businessName = invoiceDraft.businessName;

        // Remember this project's Product Invoice description for next
        // time — only if the auto-generated line item is still present (the
        // user may have removed it manually in the preview, in which case
        // there's nothing worth remembering).
        if (invoiceDraft.isProductInvoice) {
          const autoItem = invoiceDraft.expenseItems.find(
            (e) => e.isAutoGenerated,
          );
          if (autoItem && autoItem.description) {
            setProjectLastProductInvoiceDescription(
              invoiceDraft.projectId,
              autoItem.description,
            );
          }
        }

        persistState();
        renderInvoiceHistory();
      }

      // Scoped to the active project, same as the shift/expense tables —
      // otherwise switching projects would still show another client's
      // invoice history, which defeats the point of separating them.
      function renderInvoiceHistory() {
        const tbody = document.getElementById("invoiceHistoryBody");
        const emptyState = document.getElementById("emptyInvoiceState");
        if (!tbody || !emptyState) return;

        const activeInvoices = invoices.filter(
          (inv) => inv.projectId === activeProjectId,
        );

        tbody.innerHTML = "";

        if (activeInvoices.length === 0) {
          emptyState.classList.remove("hidden");
          return;
        }
        emptyState.classList.add("hidden");

        activeInvoices.forEach((inv) => {
          const clientFirstLine = (inv.clientDetails || "").split("\n")[0] || "—";
          const tr = document.createElement("tr");
          tr.className = "hover:bg-slate-50/80 transition";
          tr.innerHTML = `
            <td class="px-6 py-4 font-medium text-slate-800 whitespace-nowrap">#${escapeHtml(String(inv.invoiceNumber))}</td>
            <td class="px-6 py-4 text-slate-600">${escapeHtml(clientFirstLine)}</td>
            <td class="px-6 py-4 whitespace-nowrap">${escapeHtml(inv.dateIssued || "")}</td>
            <td class="px-6 py-4 font-semibold text-emerald-600 whitespace-nowrap">$${(Number(inv.total) || 0).toFixed(2)}</td>
            <td class="px-6 py-4 whitespace-nowrap"><span class="px-2 py-1 text-xs rounded-lg font-medium bg-slate-100 text-slate-600">${inv.language === "ar" ? "AR" : "EN"}</span></td>
            <td class="px-6 py-4 text-right whitespace-nowrap">
              <div class="flex items-center justify-end gap-1">
                <button onclick="reopenInvoice(${inv.id})" class="text-slate-400 hover:text-indigo-600 transition px-2 py-1" title="Reopen Invoice">
                  <i class="fa-solid fa-arrow-up-right-from-square"></i>
                </button>
                <button onclick="deleteInvoice(${inv.id})" class="text-slate-400 hover:text-rose-600 transition px-2 py-1" title="Delete Invoice">
                  <i class="fa-solid fa-trash-can"></i>
                </button>
              </div>
            </td>
          `;
          tbody.appendChild(tr);
        });
      }

      function reopenInvoice(id) {
        const inv = invoices.find((i) => i.id === id);
        if (!inv) return;

        invoiceDraft = {
          savedInvoiceId: inv.id,
          projectId: inv.projectId || activeProjectId,
          invoiceNumber: inv.invoiceNumber,
          businessName: inv.businessName || businessName,
          clientDetails: inv.clientDetails || "",
          dateIssued: inv.dateIssued,
          language: inv.language || "en",
          // Older saved invoices (before this feature existed) won't have
          // these fields — default to non-product-invoice behavior.
          isProductInvoice: !!inv.isProductInvoice,
          productAmountMode: inv.productAmountMode || "calculated",
          workItems: inv.lineItems
            .filter((li) => li.type === "work")
            .map((li) => ({
              id: generateId(),
              sourceLogId: null,
              date: li.date,
              description: li.description,
              hours: Number(li.hours) || 0,
              rate: Number(li.rate) || 0,
            })),
          expenseItems: inv.lineItems
            .filter((li) => li.type === "expense")
            .map((li) => ({
              id: generateId(),
              sourceExpenseId: null,
              description: li.description,
              amount: Number(li.amount) || 0,
              isAutoGenerated: !!li.isAutoGenerated,
            })),
          discount: Number(inv.discount) || 0,
          // Older saved invoices (before this feature existed) won't have
          // this field — fall back to whatever's currently stored.
          includeSignature:
            inv.includeSignature !== undefined
              ? inv.includeSignature
              : !!signatureImage,
        };

        openInvoicePreview();
      }

      function deleteInvoice(id) {
        invoices = invoices.filter((inv) => inv.id !== id);
        persistState();
        renderInvoiceHistory();
      }
