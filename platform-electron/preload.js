const { contextBridge, ipcRenderer } = require('electron');

// Minimal, safe bridge: the renderer can only ask the main process to export
// a given HTML string to a PDF the user picks via a native save dialog. No
// filesystem or Node API is exposed directly to the renderer.
contextBridge.exposeInMainWorld('invoiceAPI', {
  exportPDF: (htmlString, suggestedFileName) =>
    ipcRenderer.invoke('export-invoice-pdf', { html: htmlString, suggestedFileName }),
});

// Separate global, not folded into invoiceAPI — this is about auth/deep
// links, not invoices. One purpose-built method, same "no generic IPC
// passthrough" design as invoiceAPI above: the renderer can only register
// a callback for the one 'auth-callback' message main.js sends (a
// worklogpro://auth#... URL string — see main.js's sendAuthCallbackToRenderer()
// and core/auth.js's handleElectronAuthCallback()), nothing else.
contextBridge.exposeInMainWorld('authAPI', {
  onAuthCallback: (callback) =>
    ipcRenderer.on('auth-callback', (event, url) => callback(url)),
});
