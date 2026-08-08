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

        const modal = document.getElementById("createInvoiceModal");
        modal.classList.remove("hidden");
        modal.classList.add("flex");
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
                      <input type="checkbox" class="inv-shift-check" value="${log.id}" checked />
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
                      <input type="checkbox" class="inv-expense-check" value="${exp.id}" checked />
                      <span class="flex-1">${escapeHtml(exp.date || "")} — ${escapeHtml(exp.title)} — $${(Number(exp.amount) || 0).toFixed(2)}</span>
                    </label>`,
                )
                .join("");

        document.getElementById("invRecordsPicker").classList.remove("hidden");
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

      function renderInvoiceEditor() {
        if (!invoiceDraft) return;

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
          .map(
            (item) => `
              <tr>
                <td class="px-2 py-1.5"><input type="text" value="${escapeHtml(item.description)}" oninput="updateExpenseItem('${item.id}','description',this.value)" class="w-full text-xs border border-slate-200 rounded-lg px-2 py-1" /></td>
                <td class="px-2 py-1.5"><input type="number" step="0.01" min="0" value="${item.amount}" oninput="updateExpenseItem('${item.id}','amount',this.value)" class="w-24 text-xs border border-slate-200 rounded-lg px-2 py-1" /></td>
                <td class="px-2 py-1.5 text-right"><button type="button" onclick="removeExpenseItem('${item.id}')" class="text-slate-400 hover:text-rose-600"><i class="fa-solid fa-xmark"></i></button></td>
              </tr>`,
          )
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

        const workSection = invoiceData.workItems.length
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
