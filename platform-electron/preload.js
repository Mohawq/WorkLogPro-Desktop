const { contextBridge, ipcRenderer } = require('electron');

// Minimal, safe bridge: the renderer can only ask the main process to export
// a given HTML string to a PDF the user picks via a native save dialog. No
// filesystem or Node API is exposed directly to the renderer.
contextBridge.exposeInMainWorld('invoiceAPI', {
  exportPDF: (htmlString, suggestedFileName) =>
    ipcRenderer.invoke('export-invoice-pdf', { html: htmlString, suggestedFileName }),
});
