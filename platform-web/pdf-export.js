// platform-web/pdf-export.js
//
// Web implementation of the platformAdapter.exportPDF method. Unlike the
// Electron adapter, this never produces a file directly — it triggers the
// browser's native print dialog on the same generateInvoiceHTML() output
// used everywhere else, and the user picks "Save as PDF" (or an actual
// printer) themselves from there.
//
// suggestedFileName can't be used to auto-name anything on this platform —
// browser print/save-as-PDF dialogs let the user name the file, with no JS
// hook into that step. Kept as a parameter for interface parity with the
// Electron adapter (core/invoicing.js calls both the same way), and
// intentionally unused rather than worked around with a hack.
//
// Mechanism chosen: open a blank window SYNCHRONOUSLY, before any other
// work, so the browser still counts this as a direct result of the user's
// click and doesn't treat it as a blocked popup — then write the invoice
// HTML into that window via document.write() and call print() on it.
// Chosen over two alternatives:
//   - Hidden same-page iframe + iframe.contentWindow.print(): this is the
//     actual print path most associated with iOS Safari's "known quirks" —
//     blank pages, incomplete content, and inconsistent rendering across
//     browsers are all documented issues with iframe-based printing.
//   - Blob URL + window.open(blobUrl): Safari has a history of treating a
//     Blob URL opened this way as a *download* rather than a navigation,
//     which would defeat the point entirely (no print dialog would appear
//     at all). document.write() sidesteps that because there's no Blob URL
//     involved.
// The invoice document has zero external dependencies (inline <style>, and
// the signature image — if present — is an embedded base64 data URL, not a
// network fetch), so there's no asynchronous "wait for resources to load"
// race to handle either: document.write() + document.close() leaves the
// new window fully ready to print immediately, no onload listener needed.
function webPrintExport(html, suggestedFileName) {
  const printWindow = window.open("", "_blank");

  if (!printWindow) {
    return {
      success: false,
      error:
        "Pop-up blocked — please allow pop-ups for this site and try exporting again.",
    };
  }

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();

  // Calling print() as close as possible to the original click (no
  // setTimeout, no extra awaits) matters on iOS Safari, which has been
  // known to show a "this website was blocked for automatic printing"
  // dialog if print() fires too far removed from the user gesture.
  printWindow.focus();
  printWindow.print();

  // Best-effort cleanup once the print dialog is dismissed. `afterprint`
  // fires whether the user actually printed/saved or cancelled — there is
  // no browser API to distinguish the two, so (like the return value below)
  // this can only report "the print dialog was shown," not "a PDF was
  // actually saved."
  printWindow.addEventListener("afterprint", () => {
    printWindow.close();
  });

  return {
    success: true,
    // Not a real path — the web adapter never touches the filesystem. This
    // human-readable string exists only because exportInvoiceToPDF() in
    // core/invoicing.js (intentionally left unmodified — see the platform
    // split rule in CLAUDE.md) interpolates result.filePath directly into
    // its success message.
    filePath: "the location you chose in your browser's print dialog",
  };
}
