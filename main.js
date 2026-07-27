/* STREAMING_CHUNK:Defining Electron main process window management */
const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

let win = null;
let tray = null;
let isQuitting = false;

function createWindow() {
win = new BrowserWindow({
width: 1100,
height: 800,
minWidth: 800,
minHeight: 600,
icon: path.join(__dirname, 'icon.png'),
webPreferences: {
nodeIntegration: false,
contextIsolation: true
}
});

// Remove top menu bar for a clean desktop app look
win.setMenuBarVisibility(false);

// Load the single HTML file
win.loadFile('index.html');

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
let iconPath = path.join(__dirname, 'icon.png');
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
