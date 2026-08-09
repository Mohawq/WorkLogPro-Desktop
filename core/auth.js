// core/auth.js — thin wrappers over Supabase auth, so ui.js (and the
// settings UI in each shell) can react to sign-in/sign-out without
// importing the Supabase client directly. Like sync.js, this is allowed to
// reference the global `supabase` object: the Supabase JS client behaves
// identically in the Electron renderer and a browser, so per CLAUDE.md
// section 4A this is NOT platform-specific behavior and doesn't need
// window.platformAdapter — only genuinely platform-different capabilities
// (PDF export, filesystem) go through that boundary.

async function signInWithMagicLink(email) {
  const client = initSupabaseClient();
  if (!client) throw new Error("Supabase isn't configured yet.");
  const { error } = await client.auth.signInWithOtp({ email });
  if (error) throw error;
}

async function getSession() {
  const client = initSupabaseClient();
  if (!client) return null;
  const {
    data: { session },
  } = await client.auth.getSession();
  return session;
}

// callback(session, event) — event is the raw Supabase auth event name
// (SIGNED_IN, TOKEN_REFRESHED, SIGNED_OUT, ...), passed through so callers
// can distinguish a genuine new sign-in from a token refresh on an
// already-active session. Session stays the first argument for backward
// compatibility with the original (session-only) call signature.
function onAuthStateChange(callback) {
  const client = initSupabaseClient();
  if (!client) return { unsubscribe() {} };
  const {
    data: { subscription },
  } = client.auth.onAuthStateChange((event, session) => callback(session, event));
  return subscription;
}

async function signOut() {
  const client = initSupabaseClient();
  if (!client) return;
  const { error } = await client.auth.signOut();
  if (error) throw error;
  // Ops queued under this account must not silently push under whatever
  // account signs in next on this device (auth.uid() is stamped
  // server-side at push time, not by the client) — see core/sync.js's
  // header comment on this being a deliberate addition beyond the
  // original mutation-site list.
  if (typeof clearAllPendingOps === "function") {
    await clearAllPendingOps();
  }
}

// ---------------------------------------------------------------------
// Settings-sheet UI wiring (see section 7 of the sync task — both shells
// need this markup, ids match here). Lives here rather than ui.js so the
// auth feature stays self-contained, same convention core/invoicing.js
// already uses for renderSignatureSettings() and core/projects.js for
// renderProjectBadge() — renderUI() just calls it alongside the others.
// ---------------------------------------------------------------------

let _lastKnownSession = null;

// Called once from ui.js's DOMContentLoaded bootstrap, after
// loadStoredData()/initProjectFlow(). Fire-and-forget from the caller's
// point of view — DOMContentLoaded's handler isn't async.
async function initAuthUI() {
  if (!isSupabaseConfigured()) return;
  _lastKnownSession = await getSession();
  renderAuthSettings();
  if (_lastKnownSession) {
    // An existing session restored at app launch — this is the actual
    // "signed out (queue cleared) -> reopen the app -> still signed in"
    // scenario reconcileLocalWithServer() exists for. The magic-link
    // SIGNED_IN event below only fires for a FRESH sign-in, never for a
    // session that was already valid when the page loaded, so this call
    // has to be here too, not just in the callback.
    await reconcileLocalWithServer();
    runSyncCycle();
  }

  // Covers the magic-link redirect completing mid-session (the user
  // wasn't signed in at page load) — runSyncCycle()'s own network
  // listener/interval (registered unconditionally in sync.js) only need
  // an active session to stop no-op'ing; this is what actually gets the
  // FIRST cycle running right when sign-in completes, instead of waiting
  // for the next 5-minute tick.
  onAuthStateChange(async (session, event) => {
    _lastKnownSession = session;
    renderAuthSettings();
    if (!session) return;

    if (event === "SIGNED_IN") {
      // Reconciliation is a one-time pass per sign-in, not something to
      // repeat on every auth event (e.g. TOKEN_REFRESHED fires on an
      // already-active session and shouldn't re-run this).
      await reconcileLocalWithServer();
    }
    runSyncCycle();
  });
}

function renderAuthSettings() {
  const signedOutEl = document.getElementById("authSignedOutSection");
  const signedInEl = document.getElementById("authSignedInSection");
  if (!signedOutEl || !signedInEl) return; // shell markup not present

  const signedIn = !!_lastKnownSession;
  signedOutEl.classList.toggle("hidden", signedIn);
  signedInEl.classList.toggle("hidden", !signedIn);

  if (signedIn) {
    const emailEl = document.getElementById("authUserEmail");
    if (emailEl) {
      emailEl.textContent = _lastKnownSession.user.email || "Signed in";
    }
  }
  renderLastSyncedText();
  renderSyncConflicts();
}

// A genuine invoice-number collision (see core/sync.js's pushOneOp(), the
// SQLSTATE 23505 branch) — two already-exported invoices from different
// devices landed on the same number. Deliberately not auto-resolved (it
// may involve a document already in a client's inbox); this just surfaces
// it for the user to open the invoice, pick a new number, and re-export.
function renderSyncConflicts() {
  const section = document.getElementById("syncConflictsSection");
  const list = document.getElementById("syncConflictsList");
  if (!section || !list) return;

  const invoiceConflicts = (syncConflicts || []).filter(
    (c) => c.table === "invoices",
  );
  if (invoiceConflicts.length === 0) {
    section.classList.add("hidden");
    list.innerHTML = "";
    return;
  }

  section.classList.remove("hidden");
  list.innerHTML = invoiceConflicts
    .map((c) => {
      const inv = invoices.find((i) => i.id === c.id);
      const label = inv
        ? `Invoice #${escapeHtml(String(inv.invoiceNumber))} — ${escapeHtml(inv.dateIssued || "")}`
        : `An invoice (no longer in your local history)`;
      return `<li class="flex items-start gap-1.5">
        <i class="fa-solid fa-triangle-exclamation text-rose-500 mt-0.5 shrink-0"></i>
        <span>${label}: number conflicts with an invoice from another device. Open it, change the number, and re-export if needed.</span>
      </li>`;
    })
    .join("");
}

function renderLastSyncedText() {
  const el = document.getElementById("authLastSyncedText");
  if (!el) return;
  el.textContent = syncCursor
    ? `Last synced ${new Date(syncCursor).toLocaleString()}`
    : "Not synced yet";
}

async function handleSendMagicLink(event) {
  event.preventDefault();
  const emailInput = document.getElementById("authEmailInput");
  const statusEl = document.getElementById("authStatusMessage");
  const btn = document.getElementById("authSendMagicLinkBtn");
  const email = emailInput.value.trim();
  if (!email) return;

  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = "";
  try {
    await signInWithMagicLink(email);
    if (statusEl) {
      statusEl.textContent = "Check your email for a sign-in link.";
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = `Error: ${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleSyncNowClick() {
  const btn = document.getElementById("authSyncNowBtn");
  const originalLabel = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = "Syncing...";
  }
  try {
    await runSyncCycle();
  } finally {
    renderLastSyncedText();
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalLabel;
    }
  }
}

async function handleSignOutClick() {
  await signOut();
  _lastKnownSession = null;
  renderAuthSettings();
}
