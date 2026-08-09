/* STREAMING_CHUNK:Defining Electron main process window management */
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Custom protocol for magic-link sign-in — Electron has no localhost web
// server to redirect a browser to, so Supabase hands the confirmed
// session back to a worklogpro://auth#access_token=... URL instead (see
// platform-electron/shell.html's platformAdapter.getAuthRedirectUrl() and
// core/auth.js's handleElectronAuthCallback()). This constant is the one
// source of truth every place below that needs the scheme string.
const PROTOCOL_SCHEME = 'worklogpro';

// Windows/Linux: a protocol click while the app is already running just
// launches a SECOND process, whose only job is to hand its argv to the
// first instance (via 'second-instance' below) and exit — never allowed
// to open its own window. See the tray-icon duplicate-instance bug fixed
// elsewhere in this project for exactly what skipping this check looks
// like. Must run before any window/tray setup below.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

let win = null;
let tray = null;
let isQuitting = false;
// Held here when a worklogpro:// URL arrives before the renderer is ready
// to receive it (a cold start via a protocol click, with no earlier
// instance running) — flushed once shell.html finishes loading, in
// createWindow()'s did-finish-load handler below.
let pendingAuthUrl = null;

// Windows needs this called on every launch (cheap/idempotent — it just
// re-registers the association); dev mode (running via `electron .`, not
// a packaged .exe) needs the exact invocation Windows should replay on a
// protocol click, or it registers electron.exe itself with no arguments
// and a click just opens a blank Electron window instead of this app.
// process.defaultApp is Electron's own flag for "running unpackaged."
function registerProtocolClient() {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
  }
}

function extractProtocolUrl(argv) {
  return argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`)) || null;
}

function focusExistingWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show(); // the window may be hidden to tray, not minimized
  win.focus();
}

function sendAuthCallbackToRenderer(url) {
  if (!url) return;
  if (win && win.webContents && !win.webContents.isLoading()) {
    win.webContents.send('auth-callback', url);
  } else {
    pendingAuthUrl = url;
  }
}

function createWindow() {
win = new BrowserWindow({
width: 1100,
height: 800,
minWidth: 800,
minHeight: 600,
icon: path.join(__dirname, '..', 'icon.png'),
webPreferences: {
nodeIntegration: false,
contextIsolation: true,
preload: path.join(__dirname, 'preload.js')
}
});

// Remove top menu bar for a clean desktop app look
win.setMenuBarVisibility(false);

// Load the platform shell (loads core/*.js, then defines window.platformAdapter)
win.loadFile(path.join(__dirname, 'shell.html'));

win.webContents.on('did-finish-load', () => {
if (pendingAuthUrl) {
win.webContents.send('auth-callback', pendingAuthUrl);
pendingAuthUrl = null;
}
});

// Intercept the close (X) button click
win.on('close', (event) => {
if (!isQuitting) {
event.preventDefault(); // Stop window from closing/destroying
win.hide();             // Hide window to system tray
return false;
}
});
}

function createTray() {
let iconPath = path.join(__dirname, '..', 'icon.png');
let icon;

try {
icon = nativeImage.createFromPath(iconPath);
if (icon.isEmpty()) {
// Create empty fallback image if icon.png is missing
icon = nativeImage.createEmpty();
}
} catch (e) {
icon = nativeImage.createEmpty();
}

tray = new Tray(icon);
tray.setToolTip('WorkLog Pro - Time Tracker');

// Context menu when you right-click the system tray icon
const contextMenu = Menu.buildFromTemplate([
{
label: 'Open WorkLog Pro',
click: () => {
win.show();
win.focus();
}
},
{ type: 'separator' },
{
label: 'Quit',
click: () => {
isQuitting = true;
app.quit();
}
}
]);

tray.setContextMenu(contextMenu);

// Left-clicking the system tray icon toggles the window view
tray.on('click', () => {
if (win.isVisible()) {
win.hide();
} else {
win.show();
win.focus();
}
});
}

// Renders a fully self-contained invoice HTML string to PDF via a hidden,
// offscreen window (the renderer has no filesystem/print access under
// contextIsolation), then writes it to a path the user picks.
ipcMain.handle('export-invoice-pdf', async (event, { html, suggestedFileName }) => {
const { canceled, filePath } = await dialog.showSaveDialog(win, {
title: 'Export Invoice PDF',
defaultPath: suggestedFileName || 'Invoice.pdf',
filters: [{ name: 'PDF Documents', extensions: ['pdf'] }]
});

if (canceled || !filePath) {
return { success: false, error: 'canceled' };
}

const tempHtmlPath = path.join(app.getPath('temp'), `worklogpro-invoice-${Date.now()}.html`);
let pdfWin = null;

try {
fs.writeFileSync(tempHtmlPath, html, 'utf-8');

pdfWin = new BrowserWindow({
show: false,
webPreferences: {
nodeIntegration: false,
contextIsolation: true
}
});

// loadFile's promise resolves after did-finish-load, so the page (and its
// inline styles/content) is fully ready before we print it.
await pdfWin.loadFile(tempHtmlPath);

const pdfBuffer = await pdfWin.webContents.printToPDF({
printBackground: true,
pageSize: 'A4',
margins: { top: 0, bottom: 0, left: 0, right: 0 }
});

await fs.promises.writeFile(filePath, pdfBuffer);

return { success: true, filePath };
} catch (err) {
return { success: false, error: err.message };
} finally {
if (pdfWin) pdfWin.destroy();
fs.unlink(tempHtmlPath, () => {});
}
});

// Windows/Linux: fired on the FIRST (already-running) instance whenever a
// second launch is attempted — argv is that new process's command line,
// which is where a worklogpro:// URL from a protocol click lives (Windows
// never fires open-url below; this is its equivalent).
app.on('second-instance', (event, argv) => {
focusExistingWindow();
const url = extractProtocolUrl(argv);
if (url) sendAuthCallbackToRenderer(url);
});

// macOS: fired instead of second-instance for a protocol click, whether
// the app was already running or this launch IS the first instance.
// Registered at top level (not inside whenReady().then()) since macOS can
// fire this very early during launch — Electron's own docs recommend
// listening as soon as possible.
app.on('open-url', (event, url) => {
event.preventDefault();
focusExistingWindow();
sendAuthCallbackToRenderer(url);
});

app.whenReady().then(() => {
registerProtocolClient();
createWindow();
createTray();

// Cold start via a protocol click on Windows/Linux (app wasn't running
// at all) — the triggering URL is just another entry in THIS process's
// own argv; there was no earlier instance for 'second-instance' to have
// fired on.
const coldStartUrl = extractProtocolUrl(process.argv);
if (coldStartUrl) sendAuthCallbackToRenderer(coldStartUrl);
});

// Ensure flag is set when quitting via taskbar or system commands
app.on('before-quit', () => {
isQuitting = true;
});

app.on('window-all-closed', () => {
// Keep app active in tray on Windows even if all windows are hidden
if (process.platform !== 'darwin') {
// Intentionally empty
}
});

app.on('activate', () => {
if (BrowserWindow.getAllWindows().length === 0) {
createWindow();
} else {
win.show();
}
});
