/* STREAMING_CHUNK:Defining Electron main process window management */
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let tray = null;
let isQuitting = false;

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

app.whenReady().then(() => {
createWindow();
createTray();
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
