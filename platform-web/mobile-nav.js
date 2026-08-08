// platform-web/mobile-nav.js — mobile tab bar + settings sheet wiring.
//
// Platform-web-only UI glue. It only shows/hides the #tab-timer /
// #tab-expenses / #tab-invoices containers that core/ui.js already renders
// into (by ID, same as everywhere else in this codebase) and toggles the
// #settingsSheet overlay. It never reads or writes app state/storage —
// core/*.js is untouched and unaware this file exists.

const WT_TABS = ["timer", "expenses", "invoices"];

function showTab(name) {
  WT_TABS.forEach((tab) => {
    const panel = document.getElementById(`tab-${tab}`);
    if (panel) panel.classList.toggle("hidden", tab !== name);

    const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
    if (btn) btn.classList.toggle("active", tab === name);
  });
}

function openSettingsSheet() {
  const sheet = document.getElementById("settingsSheet");
  if (sheet) sheet.classList.remove("hidden");
}

function closeSettingsSheet() {
  const sheet = document.getElementById("settingsSheet");
  if (sheet) sheet.classList.add("hidden");
}

document.addEventListener("DOMContentLoaded", () => {
  showTab("timer");
});
