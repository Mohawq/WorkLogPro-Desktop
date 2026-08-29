// core/auth.js — thin wrappers over Supabase auth, so ui.js (and the
// settings UI in each shell) can react to sign-in/sign-out without
// importing the Supabase client directly. Like sync.js, this is allowed to
// reference the global `supabase` object: the Supabase JS client behaves
// identically in the Electron renderer and a browser, so per CLAUDE.md
// section 4A this is NOT platform-specific behavior and doesn't need
// window.platformAdapter — only genuinely platform-different capabilities
// (PDF export, filesystem) go through that boundary.

// Password is the only sign-in method — magic link was removed (see
// CLAUDE.md section 4L for why: an installed iOS home-screen PWA has a
// storage context isolated from Safari, and completing a magic link
// always bounces through Safari at some point, so the resulting session
// never reached the installed app. Password auth completes entirely
// in-process with no redirect, so it works everywhere magic link
// couldn't, including there.
async function signUpWithPassword(email, password) {
  const client = initSupabaseClient();
  if (!client) throw new Error("Supabase isn't configured yet.");
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) throw error;

  // Supabase's anti-enumeration behavior: signing up again with an email
  // that already has a CONFIRMED account returns success with no error at
  // all (deliberately, so a signup form can't be used to probe which
  // emails are registered) — but with an empty identities array instead
  // of a new identity. This is the only way to tell "already registered"
  // apart from a genuine new signup needing confirmation.
  if (
    data.user &&
    Array.isArray(data.user.identities) &&
    data.user.identities.length === 0
  ) {
    throw new Error("An account with this email already exists.");
  }

  // Whether a session comes back immediately depends on the Supabase
  // dashboard's "Confirm email" setting, not anything this code controls
  // — self-adapts to either: no session means confirmation is required
  // before this account can sign in; a session means it's already
  // active, and onAuthStateChange's SIGNED_IN handler (see initAuthUI())
  // takes over exactly like any other sign-in.
  return { needsConfirmation: !data.session, user: data.user };
}

async function signInWithPassword(email, password) {
  const client = initSupabaseClient();
  if (!client) throw new Error("Supabase isn't configured yet.");
  const { error } = await client.auth.signInWithPassword({ email, password });
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
    // scenario reconcileLocalWithServer() exists for. The SIGNED_IN event
    // below only fires for a FRESH sign-in, never for a session that was
    // already valid when the page loaded, so this call has to be here
    // too, not just in the callback.
    await reconcileLocalWithServer();
    runSyncCycle();
  }

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

// Maps a handful of common Supabase auth error messages to friendlier
// text — deliberately not an exhaustive error-code table (see the task
// this was built for), just the cases a user actually hits often enough
// to be worth a clearer message. Anything else falls through to
// Supabase's own error.message as-is.
function friendlyAuthError(err) {
  const message = (err && err.message) || "Something went wrong.";
  const lower = message.toLowerCase();
  if (lower.includes("invalid login credentials")) {
    return "Incorrect email or password.";
  }
  if (lower.includes("email not confirmed")) {
    return "Please confirm your email first — check your inbox for the confirmation link.";
  }
  if (lower.includes("already registered") || lower.includes("already exists")) {
    return "An account with this email already exists — try signing in instead.";
  }
  return message;
}

// Sub-toggle inside the password form itself: signing in vs. creating a
// new account. authPasswordFormMode is a hidden input (same "small hidden
// input tracks a mode string" pattern invoicing.js's
// invProductAmountMode already uses) rather than a second JS variable, so
// handlePasswordAuthSubmit() below can read it without any extra state
// to keep in sync.
function setPasswordFormSignUpMode(isSignUp) {
  const modeInput = document.getElementById("authPasswordFormMode");
  const submitBtn = document.getElementById("authPasswordSubmitBtn");
  const toggleLink = document.getElementById("authSignUpToggle");
  const statusEl = document.getElementById("authStatusMessage");
  if (!modeInput) return;

  modeInput.value = isSignUp ? "signup" : "signin";
  if (submitBtn) submitBtn.textContent = isSignUp ? "Create Account" : "Sign In";
  if (toggleLink) {
    toggleLink.textContent = isSignUp
      ? "Already have an account? Sign in"
      : "New here? Create an account";
  }
  if (statusEl) statusEl.textContent = "";
}

function togglePasswordSignUpMode() {
  const modeInput = document.getElementById("authPasswordFormMode");
  setPasswordFormSignUpMode(!(modeInput && modeInput.value === "signup"));
}

// Nice-to-have, not required — a plain password field would have been
// fine, but this is cheap on a mobile-first form.
function togglePasswordVisibility() {
  const input = document.getElementById("authPasswordInput");
  const icon = document.getElementById("authPasswordToggleIcon");
  if (!input) return;
  const nowShowing = input.type === "password";
  input.type = nowShowing ? "text" : "password";
  if (icon) {
    icon.classList.toggle("fa-eye", !nowShowing);
    icon.classList.toggle("fa-eye-slash", nowShowing);
  }
}

async function handlePasswordAuthSubmit(event) {
  event.preventDefault();
  const emailInput = document.getElementById("authPasswordEmailInput");
  const passwordInput = document.getElementById("authPasswordInput");
  const modeInput = document.getElementById("authPasswordFormMode");
  const statusEl = document.getElementById("authStatusMessage");
  const btn = document.getElementById("authPasswordSubmitBtn");

  const email = emailInput.value.trim();
  const password = passwordInput.value;
  if (!email || !password) return;

  const isSignUp = modeInput && modeInput.value === "signup";

  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = "";
  try {
    if (isSignUp) {
      const result = await signUpWithPassword(email, password);
      // A confirmed-immediately signup already transitions to the
      // signed-in view via onAuthStateChange; one still needing
      // confirmation stays here so the message set below is visible —
      // flip back to sign-in mode so a repeat visit doesn't look like
      // another signup attempt. Done BEFORE setting the message, not
      // after — setPasswordFormSignUpMode() clears authStatusMessage
      // itself (see its own definition), so calling it afterward would
      // immediately wipe whatever this just set.
      if (result.needsConfirmation) setPasswordFormSignUpMode(false);
      if (statusEl) {
        statusEl.textContent = result.needsConfirmation
          ? "Check your email to confirm your account, then sign in."
          : "Account created and signed in.";
      }
    } else {
      // A successful sign-in transitions renderAuthSettings() to the
      // signed-in view immediately (via onAuthStateChange), so there's no
      // "success" message to show here — same as the existing magic-link
      // handler below only messaging on its own async-wait state.
      await signInWithPassword(email, password);
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = friendlyAuthError(err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// A user-initiated click gets a much more generous bound than
// STARTUP_SYNC_TIMEOUT_MS (core/sync.js) — that one exists so app launch
// is never blocked waiting on the network, and 4s is fine for a "proceed
// with local data regardless" background attempt. Here the user is
// actively watching the button, so it needs to tolerate a genuinely slow
// (not dead) connection rather than flip back to "Sync Now" prematurely.
const SYNC_NOW_BUTTON_TIMEOUT_MS = 20000;

async function handleSyncNowClick() {
  const btn = document.getElementById("authSyncNowBtn");
  const originalLabel = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = "Syncing...";
  }
  try {
    // runSyncCycle() already swallows its own errors (see its try/catch)
    // and never rejects, but it can still hang indefinitely if the
    // underlying fetch never settles at all (dropped connection, a
    // backgrounded tab/app, the device sleeping mid-request) — Promise
    // rejection and Promise never-resolving are different failure modes,
    // and only the first one was handled before. Without this bound, an
    // unresolved await here left the button permanently disabled: a
    // disabled button fires no click event at all, so every subsequent
    // real click produced zero effect, zero console output, and zero
    // network activity — exactly the reported symptom — with no recovery
    // short of a full app reload. withTimeout() just stops the button
    // from waiting on it; the original call (if it was ever going to
    // finish) keeps running in the background and still applies its
    // results normally, same as the startup-sync usage of this helper.
    await withTimeout(() => runSyncCycle(), SYNC_NOW_BUTTON_TIMEOUT_MS);
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
  // Don't leave a typed plaintext password sitting in the DOM after
  // signing out — the field is hidden again (authSignedOutSection), not
  // destroyed, so its value would otherwise persist.
  const passwordInput = document.getElementById("authPasswordInput");
  if (passwordInput) passwordInput.value = "";
}
