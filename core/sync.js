// core/sync.js — the only file allowed to reference the global `supabase`
// object (loaded via CDN UMD build in each shell) and the only file that
// talks to the network for sync. core/sync-queue.js knows nothing about
// Supabase; this file reads its queue and pushes/pulls against the tables
// and RPC functions defined in migrations/001_worklogpro_schema.sql and
// migrations/002_worklogpro_sync_rpc.sql — treated here as a fixed,
// already-applied contract, not re-derived.
//
// Three gaps between the local wt_state shape and that schema, resolved
// here rather than by touching the (already-applied) migrations:
//   1. Local record ids (Date.now() numbers, or generateId()'s
//      timestamp-random strings) are not uuids, but every table's primary
//      key is. Every synced record gets a separate `syncId` (a real uuid,
//      see generateUUID() in state.js) assigned once by stampAndSync() and
//      left untouched after — `id` keeps meaning what it always has
//      locally (DOM lookups, onclick handlers, array filters).
//   2. shifts.project_id / expenses.project_id / invoices.project_id are
//      uuid FKs against projects.id — but locally a record only knows the
//      other project's local `id`. resolveProjectSyncId()/
//      resolveLocalProjectId() translate between the two schemes on every
//      push/pull.
//   3. invoices has no clientDetails/dateIssued columns, and expenses has
//      no attachment columns. clientDetails/dateIssued/businessName-at-
//      creation-time are folded into the existing line_items jsonb
//      column's `meta` key (see invoiceToParams/applyInvoiceRow) so they
//      still round-trip; a receipt attachment (fileData) has nowhere to
//      go server-side at all and simply stays device-local — see
//      applyExpenseRow's comment.

// TODO: fill in with the real project values before sync can work at all.
// Safe to hardcode (not secret) — Supabase RLS is what actually protects
// the data, same as every anon-key Supabase client.
const SUPABASE_URL = "https://rawnbsszzdnoeeuzekce.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJhd25ic3N6emRub2VldXpla2NlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwOTI3MzIsImV4cCI6MjEwMTY2ODczMn0.cbC5LHzuSZraVBjO52hT-Yw0y9LZS40cktVkFcz5Dgk";

let _supabaseClient = null;
let _supabaseConfigWarned = false;

function isSupabaseConfigured() {
  const configured =
    !SUPABASE_URL.includes("YOUR-PROJECT-REF") &&
    !SUPABASE_ANON_KEY.includes("YOUR-ANON-KEY");
  if (!configured && !_supabaseConfigWarned) {
    _supabaseConfigWarned = true;
    console.warn(
      "WorkLog Pro: Supabase sync is not configured — set SUPABASE_URL/SUPABASE_ANON_KEY in core/sync.js. Sync stays disabled until then.",
    );
  }
  return configured;
}

function initSupabaseClient() {
  if (!_supabaseClient && typeof supabase !== "undefined") {
    _supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return _supabaseClient;
}

function msToISO(ms) {
  if (ms === null || ms === undefined) return null;
  return new Date(ms).toISOString();
}

function resolveProjectSyncId(localProjectId) {
  const project = projects.find((p) => p.id === localProjectId);
  return project ? project.syncId || null : null;
}

function resolveLocalProjectId(projectSyncId) {
  const project = projects.find((p) => p.syncId === projectSyncId);
  return project ? project.id : null;
}

function localTableNameFor(serverTable) {
  return serverTable === "shifts" ? "logs" : serverTable;
}

// Local ids for records synthesized from a pulled row must stay plain
// numbers, matching the Date.now()-based scheme every existing onclick
// handler / Number(checkbox.value) comparison in ui.js and invoicing.js
// already assumes (unlike projects, whose local id is already a string —
// generateId() is fine there). A bare Date.now() risks colliding when a
// pull applies many rows inside one tight loop, hence the small offset.
let _pullIdSeq = 0;
function nextLocalNumericId() {
  _pullIdSeq = (_pullIdSeq + 1) % 1000;
  return Date.now() + _pullIdSeq;
}

// expense.date is stored via toLocaleDateString() with no parallel ISO
// field (unlike logs' startTimeISO) — a locale-dependent, genuinely
// ambiguous format (this predates sync; not something this task's scope
// covers fixing). Best-effort parse for the server's `date` column, with a
// same-device round trip being the common case this actually needs to
// work for.
function expenseDateToISO(localeDateStr) {
  try {
    const parsed = new Date(localeDateStr);
    if (!isNaN(parsed.getTime())) return parsed.toISOString().split("T")[0];
  } catch (e) {}
  return new Date().toISOString().split("T")[0];
}

// ---------------------------------------------------------------------
// Per-table param builders (local record -> RPC params) and row appliers
// (pulled server row -> local record), keyed by SERVER table name.
// ---------------------------------------------------------------------

function projectToParams(record) {
  return {
    p_id: record.syncId,
    p_name: record.name,
    p_hourly_rate: Number(record.hourlyRate) || 0,
    p_created_at: record.createdAt || null,
    p_updated_at: msToISO(record.updatedAt),
    p_deleted_at: record.deletedAt ? msToISO(record.deletedAt) : null,
  };
}

function applyProjectRow(row) {
  const rowUpdated = getMsTimestamp(row.updated_at);
  const idx = projects.findIndex((p) => p.syncId === row.id);

  if (row.deleted_at) {
    if (idx !== -1) projects.splice(idx, 1);
    return;
  }
  if (idx !== -1 && rowUpdated <= (projects[idx].updatedAt || 0)) return;

  const merged = {
    id: idx !== -1 ? projects[idx].id : generateId(),
    syncId: row.id,
    name: row.name,
    hourlyRate: Number(row.hourly_rate) || 0,
    createdAt: row.created_at,
    updatedAt: rowUpdated,
    lastProductInvoiceDescription:
      idx !== -1 ? projects[idx].lastProductInvoiceDescription : undefined,
  };
  if (idx !== -1) projects[idx] = merged;
  else projects.push(merged);
}

// currentShift ({startTime, breakStart, totalBreakMs, ...}) and a
// completed logs[] entry ({startTimeISO, endTimeISO, breakMs, ...}) are
// different local shapes for the same server table — status distinguishes
// them server-side; presence of startTimeISO distinguishes them here.
function shiftToParams(record) {
  const isActive = record.startTimeISO === undefined;
  return {
    p_id: record.syncId,
    p_project_id: resolveProjectSyncId(record.projectId),
    p_status: isActive ? "active" : "completed",
    p_clock_in: isActive ? msToISO(record.startTime) : record.startTimeISO,
    p_clock_out: isActive ? null : record.endTimeISO,
    p_break_start:
      isActive && record.breakStart ? msToISO(record.breakStart) : null,
    p_total_break_ms: isActive
      ? Number(record.totalBreakMs) || 0
      : Number(record.breakMs) || 0,
    p_notes: record.notes || null,
    p_created_at: isActive ? msToISO(record.startTime) : record.startTimeISO,
    p_updated_at: msToISO(record.updatedAt),
    p_deleted_at: record.deletedAt ? msToISO(record.deletedAt) : null,
  };
}

function applyShiftRow(row) {
  const rowUpdated = getMsTimestamp(row.updated_at);
  const localProjectId = resolveLocalProjectId(row.project_id);
  const matchesCurrentShift = !!(
    currentShift && currentShift.syncId === row.id
  );
  const logIdx = logs.findIndex((l) => l.syncId === row.id);

  if (row.deleted_at) {
    if (matchesCurrentShift) currentShift = null;
    if (logIdx !== -1) logs.splice(logIdx, 1);
    return;
  }

  const localUpdated = matchesCurrentShift
    ? currentShift.updatedAt || 0
    : logIdx !== -1
      ? logs[logIdx].updatedAt || 0
      : 0;
  if ((matchesCurrentShift || logIdx !== -1) && rowUpdated <= localUpdated)
    return;

  if (row.status === "active") {
    // A DIFFERENT local currentShift already exists (two devices both
    // think they clocked in) — LWW: only replace if this row is newer.
    if (currentShift && currentShift.syncId !== row.id) {
      if (rowUpdated <= (currentShift.updatedAt || 0)) return;
    }
    // Was completed locally but the server says active again (a pulled
    // edit reopening it, or this device's own earlier completion hasn't
    // reached the server yet) — trust the newer server row (LWW already
    // confirmed above).
    if (logIdx !== -1) logs.splice(logIdx, 1);
    currentShift = {
      syncId: row.id,
      projectId: localProjectId,
      startTime: getMsTimestamp(row.clock_in),
      breakStart: row.break_start ? getMsTimestamp(row.break_start) : null,
      totalBreakMs: Number(row.total_break_ms) || 0,
      notes: row.notes || "",
      updatedAt: rowUpdated,
    };
    // Land the app in the shift's project, not just adopt the shift data —
    // an active shift pulled from another device (or adopted after a push
    // conflict via pushOneOp()'s "adopted-server" path) should open
    // straight into its project's timer. initProjectFlow() skips the
    // picker whenever currentShift is set, so this is what makes that land
    // on the right project.
    if (localProjectId) activeProjectId = localProjectId;
  } else {
    if (matchesCurrentShift) currentShift = null;
    const clockInMs = getMsTimestamp(row.clock_in);
    const clockOutMs = getMsTimestamp(row.clock_out);
    const breakMs = Number(row.total_break_ms) || 0;
    const merged = {
      id: logIdx !== -1 ? logs[logIdx].id : nextLocalNumericId(),
      syncId: row.id,
      projectId: localProjectId,
      date: new Date(clockInMs).toLocaleDateString(),
      startTimeISO: row.clock_in,
      endTimeISO: row.clock_out,
      breakMs,
      netDurationMs: Math.max(0, clockOutMs - clockInMs - breakMs),
      hourlyRate: getProjectRate(localProjectId),
      notes: row.notes || "",
      updatedAt: rowUpdated,
    };
    if (logIdx !== -1) logs[logIdx] = merged;
    else logs.unshift(merged);
  }
}

function expenseToParams(record) {
  return {
    p_id: record.syncId,
    p_project_id: resolveProjectSyncId(record.projectId),
    p_amount: Number(record.amount) || 0,
    p_description: record.title || null,
    p_expense_date: expenseDateToISO(record.date),
    p_created_at: null,
    p_updated_at: msToISO(record.updatedAt),
    p_deleted_at: record.deletedAt ? msToISO(record.deletedAt) : null,
  };
}

function applyExpenseRow(row) {
  const rowUpdated = getMsTimestamp(row.updated_at);
  const idx = expenses.findIndex((e) => e.syncId === row.id);

  if (row.deleted_at) {
    if (idx !== -1) expenses.splice(idx, 1);
    return;
  }
  if (idx !== -1 && rowUpdated <= (expenses[idx].updatedAt || 0)) return;

  const merged = {
    id: idx !== -1 ? expenses[idx].id : nextLocalNumericId(),
    syncId: row.id,
    projectId: resolveLocalProjectId(row.project_id),
    date: new Date(row.expense_date).toLocaleDateString(),
    title: row.description || "",
    amount: Number(row.amount) || 0,
    category: idx !== -1 ? expenses[idx].category : "Other",
    // The expenses table has no attachment columns at all — a receipt
    // uploaded on one device never reaches another. Preserve whatever is
    // already local (if any) instead of wiping it on every pull.
    fileName: idx !== -1 ? expenses[idx].fileName : null,
    fileType: idx !== -1 ? expenses[idx].fileType : null,
    fileData: idx !== -1 ? expenses[idx].fileData : null,
    updatedAt: rowUpdated,
  };
  if (idx !== -1) expenses[idx] = merged;
  else expenses.unshift(merged);
}

function invoiceToParams(record) {
  return {
    p_id: record.syncId,
    p_project_id: resolveProjectSyncId(record.projectId),
    p_invoice_number: parseInt(record.invoiceNumber, 10) || 0,
    p_language: record.language || "en",
    p_discount: Number(record.discount) || 0,
    p_include_signature: !!record.includeSignature,
    // invoices has no clientDetails/dateIssued/businessName columns — see
    // this file's header comment. Folded into the existing line_items
    // jsonb column instead of losing them on every sync.
    p_line_items: {
      meta: {
        clientDetails: record.clientDetails || "",
        dateIssued: record.dateIssued || "",
        businessName: record.businessName || "",
        isProductInvoice: !!record.isProductInvoice,
        productAmountMode: record.productAmountMode || "calculated",
      },
      items: record.lineItems || [],
    },
    p_created_at: record.createdAt || null,
    p_updated_at: msToISO(record.updatedAt),
    p_deleted_at: record.deletedAt ? msToISO(record.deletedAt) : null,
  };
}

function applyInvoiceRow(row) {
  const rowUpdated = getMsTimestamp(row.updated_at);
  const idx = invoices.findIndex((inv) => inv.syncId === row.id);

  if (row.deleted_at) {
    if (idx !== -1) invoices.splice(idx, 1);
    return;
  }
  if (idx !== -1 && rowUpdated <= (invoices[idx].updatedAt || 0)) return;

  const payload = row.line_items || {};
  const meta = payload.meta || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const discount = Number(row.discount) || 0;
  const itemsTotal = items.reduce(
    (sum, li) => sum + (Number(li.amount) || 0),
    0,
  );

  const merged = {
    id: idx !== -1 ? invoices[idx].id : nextLocalNumericId(),
    syncId: row.id,
    projectId: resolveLocalProjectId(row.project_id),
    invoiceNumber: row.invoice_number,
    clientDetails: meta.clientDetails || "",
    businessName: meta.businessName || businessName,
    dateIssued: meta.dateIssued || "",
    language: row.language || "en",
    isProductInvoice: !!meta.isProductInvoice,
    productAmountMode: meta.productAmountMode || "calculated",
    lineItems: items,
    discount,
    subtotal: itemsTotal,
    total: Math.max(0, itemsTotal - discount),
    includeSignature: !!row.include_signature,
    createdAt: row.created_at,
    updatedAt: rowUpdated,
  };
  if (idx !== -1) invoices[idx] = merged;
  else invoices.unshift(merged);
}

const TABLE_SYNC_CONFIG = {
  projects: {
    rpcName: "upsert_project",
    toParams: projectToParams,
    applyRow: applyProjectRow,
  },
  shifts: {
    rpcName: "upsert_shift",
    toParams: shiftToParams,
    applyRow: applyShiftRow,
  },
  expenses: {
    rpcName: "upsert_expense",
    toParams: expenseToParams,
    applyRow: applyExpenseRow,
  },
  invoices: {
    rpcName: "upsert_invoice",
    toParams: invoiceToParams,
    applyRow: applyInvoiceRow,
  },
};

// ---------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------

function markPendingDeletionSynced(serverTable, localId) {
  const localTable = localTableNameFor(serverTable);
  pendingDeletions.forEach((pd) => {
    if (pd.table === localTable && pd.id === localId) pd.synced = true;
  });
}

function prunePendingDeletions() {
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const now = getMsTimestamp();
  pendingDeletions = pendingDeletions.filter(
    (pd) => !(pd.synced && now - pd.deletedAt > THIRTY_DAYS_MS),
  );
}

// A2 (invoice numbering reconciliation): a locally-numbered, not-yet-sent
// invoice (numberSource "local", exported false — see the provisional save
// in core/invoicing.js's handleCreateInvoiceSubmit()) gets a
// server-authoritative number right before its first push, instead of only
// ever being checked once it's already been emailed to a client. Mutates
// BOTH the live `invoices[]` entry (so persistState()/renderInvoiceHistory()
// see the correction) and op.record (so the push right after this uses the
// new number) — they're separate objects (op.record came out of
// IndexedDB's structured clone, not a live reference).
//
// Already-exported invoices are left alone here on purpose: renumbering
// something that may already be in a client's inbox is exactly the wrong
// move — those fall through to the normal push, which is where a genuine
// same-number collision from two offline devices surfaces (see A3 in
// pushOneOp() below).
async function reconcileInvoiceNumberIfNeeded(client, op) {
  const liveIdx = invoices.findIndex((inv) => inv.id === op.record.id);
  const liveRecord = liveIdx !== -1 ? invoices[liveIdx] : op.record;

  if (liveRecord.numberSource !== "local" || liveRecord.exported === true) {
    return;
  }

  const { data, error } = await client.rpc("get_next_invoice_number");
  if (error || data === null || data === undefined) {
    // Leave it as a local number for now — better to retry the whole op
    // next cycle than push under a number that was never actually
    // reconciled.
    throw error || new Error("get_next_invoice_number returned no value");
  }

  const newNumber = String(data);
  if (liveIdx !== -1) {
    invoices[liveIdx].invoiceNumber = newNumber;
    invoices[liveIdx].numberSource = "server";
  }
  op.record.invoiceNumber = newNumber;
  op.record.numberSource = "server";

  // The editor/preview may still be open and showing the stale local
  // number if the user hasn't closed it — this is what CLAUDE.md's sync
  // section means by "any open UI... reflect the corrected number."
  if (invoiceDraft && invoiceDraft.savedInvoiceId === op.record.id) {
    invoiceDraft.invoiceNumber = newNumber;
    invoiceDraft.numberSource = "server";
    const pvInput = document.getElementById("pvInvoiceNumber");
    if (pvInput) pvInput.value = newNumber;
    if (typeof renderInvoiceEditor === "function") renderInvoiceEditor();
  }
  if (typeof renderInvoiceHistory === "function") renderInvoiceHistory();

  persistState();
}

async function pushOneOp(client, op) {
  const { table, record } = op;

  if (table === "user_settings") {
    const { data, error } = await client.rpc("upsert_user_settings", {
      p_business_name: record.businessName || null,
      p_signature_image: record.signatureImage || null,
      p_updated_at: msToISO(record.updatedAt),
    });
    if (error) throw error;
    if (!data || data.length === 0) {
      const { data: row, error: fetchErr } = await client
        .from("user_settings")
        .select("*")
        .maybeSingle();
      if (fetchErr) throw fetchErr;
      if (
        row &&
        getMsTimestamp(row.updated_at) > (userSettingsUpdatedAt || 0)
      ) {
        businessName = row.business_name || "";
        signatureImage = row.signature_image || null;
        userSettingsUpdatedAt = getMsTimestamp(row.updated_at);
      }
      return "adopted-server";
    }
    return "pushed";
  }

  // A2 — see reconcileInvoiceNumberIfNeeded()'s own comment. `record` (and
  // op.record — the same object) may come out of this with a corrected,
  // server-assigned invoiceNumber before the push below builds its params.
  if (table === "invoices") {
    await reconcileInvoiceNumberIfNeeded(client, op);
  }

  const config = TABLE_SYNC_CONFIG[table];
  const params = config.toParams(record);

  const { data, error } = await client.rpc(config.rpcName, params);

  if (error) {
    // A3 — a genuine invoice-number collision, not a stale-write LWW case:
    // two different invoice ids (different p_id -> ON CONFLICT (id) never
    // even triggers) landed on the same invoice_number from two offline
    // devices, and the separate invoices_user_number_idx unique constraint
    // rejects the second one to arrive with a real Postgres error
    // (SQLSTATE 23505), not an empty RPC result. This can only happen to
    // an ALREADY-exported invoice — reconcileInvoiceNumberIfNeeded() above
    // already renumbers anything still local+unexported before it gets
    // here, so a 23505 past that point means the number was already
    // handed to a client and must never be silently changed or retried.
    if (table === "invoices" && error.code === "23505") {
      syncConflicts.push({
        table: "invoices",
        id: record.id,
        detectedAt: getMsTimestamp(),
      });
      persistState();
      if (typeof renderSyncConflicts === "function") renderSyncConflicts();
      return "conflict"; // caller removes the op from the queue; record itself is left untouched
    }
    throw error;
  }

  if (!data || data.length === 0) {
    // The RPC's WHERE guard rejected this write (ON CONFLICT DO NOTHING) —
    // the server has something newer than what we just sent. Adopt it
    // locally instead of retrying the same stale push forever.
    const { data: row, error: fetchErr } = await client
      .from(table)
      .select("*")
      .eq("id", record.syncId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (row) config.applyRow(row);
    return "adopted-server";
  }

  return "pushed";
}

async function pushPendingOps() {
  if (!isSupabaseConfigured()) return;
  const client = initSupabaseClient();
  if (!client) return;

  const ops = await getAllPendingOps();
  if (ops.length === 0) return;

  // Projects first — shifts/expenses/invoices reference project_id as a
  // server-side uuid FK, so a brand-new project must land before any
  // child record that references it.
  const ordered = [
    ...ops.filter((o) => o.table === "projects"),
    ...ops.filter((o) => o.table !== "projects"),
  ];

  let anyApplied = false;
  for (const op of ordered) {
    try {
      await pushOneOp(client, op);
      await removePendingOp(op.opId);
      if (op.record.deletedAt)
        markPendingDeletionSynced(op.table, op.record.id);
      anyApplied = true;
    } catch (err) {
      console.error(
        "WorkLog Pro: sync push failed, leaving it queued for the next cycle:",
        err,
      );
      break; // stop this cycle; retry everything still queued next time
    }
  }

  if (anyApplied) {
    prunePendingDeletions();
    persistState();
  }
}

// ---------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------

async function pullUserSettingsRow(client) {
  const { data, error } = await client
    .from("user_settings")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) return;
  const rowUpdated = getMsTimestamp(data.updated_at);
  if (rowUpdated <= (userSettingsUpdatedAt || 0)) return;
  businessName = data.business_name || "";
  signatureImage = data.signature_image || null;
  userSettingsUpdatedAt = rowUpdated;
}

async function pullChanges() {
  if (!isSupabaseConfigured()) return;
  const client = initSupabaseClient();
  if (!client) return;

  const cursorISO = syncCursor ? msToISO(syncCursor) : "1970-01-01T00:00:00Z";
  let maxSeen = syncCursor || 0;

  for (const table of ["projects", "shifts", "expenses", "invoices"]) {
    const { data, error } = await client
      .from(table)
      .select("*")
      .gt("updated_at", cursorISO);
    if (error) throw error;
    (data || []).forEach((row) => {
      TABLE_SYNC_CONFIG[table].applyRow(row);
      const rowMs = getMsTimestamp(row.updated_at);
      if (rowMs > maxSeen) maxSeen = rowMs;
    });
  }

  await pullUserSettingsRow(client);

  syncCursor = maxSeen;
  persistState();
}

// ---------------------------------------------------------------------
// Sign-in reconciliation (B1)
// ---------------------------------------------------------------------

// signOut() (core/auth.js) clears the local push queue on purpose — an
// unpushed op has no per-record owner tag, so leaving it queued across a
// sign-out/sign-in-as-someone-else cycle on a shared device would risk
// attributing that data to the wrong account. The consequence is that any
// edit made between "last successful sync" and "sign out" has no trace
// left in the queue once it's cleared, even though it's still sitting
// right there in wt_state. This repopulates the queue by comparing local
// state against the server directly — id + updated_at only, not full
// rows, to keep it cheap — rather than trusting queue history that may no
// longer exist. Meant to run once per sign-in event (see
// core/auth.js's initAuthUI()), not on every sync cycle; pullChanges()'s
// cursor already handles the steady-state case on its own.
async function reconcileLocalWithServer() {
  if (!isSupabaseConfigured()) return;
  const client = initSupabaseClient();
  if (!client) return;

  try {
    for (const table of ["projects", "shifts", "expenses", "invoices"]) {
      const { data, error } = await client.from(table).select("id, updated_at");
      if (error) throw error;

      const remoteMap = new Map(
        (data || []).map((row) => [row.id, getMsTimestamp(row.updated_at)]),
      );

      const localArray =
        table === "shifts"
          ? logs
          : table === "projects"
            ? projects
            : table === "expenses"
              ? expenses
              : invoices;

      localArray.forEach((record) => {
        if (!record.syncId) return; // nothing to key a push on — shouldn't happen post-v4-migration, but a missing syncId here would just throw deep inside toParams()
        const remoteUpdated = remoteMap.get(record.syncId);
        const localUpdated = record.updatedAt || 0;
        if (remoteUpdated === undefined || localUpdated > remoteUpdated) {
          enqueueSyncOp(table, record);
        }
        // else: remote is >= local — the normal cursor-based pullChanges()
        // picks this up on its own; nothing to re-queue.
      });

      // currentShift lives in the same server table as logs (status
      // distinguishes them — see applyShiftRow()) but isn't in either
      // array above, so it needs its own check.
      if (table === "shifts" && currentShift && currentShift.syncId) {
        const remoteUpdated = remoteMap.get(currentShift.syncId);
        const localUpdated = currentShift.updatedAt || 0;
        if (remoteUpdated === undefined || localUpdated > remoteUpdated) {
          enqueueSyncOp("shifts", currentShift);
        }
      }
    }

    // Deletions that hadn't pushed yet when an earlier signOut() cleared
    // the queue are otherwise permanently invisible to sync — by the time
    // this runs, the underlying record is already gone from its array, so
    // pendingDeletions' own record snapshot (see deleteLog()/
    // deleteExpense()/deleteInvoice()) is the only way to rebuild the push.
    pendingDeletions
      .filter((pd) => pd.synced !== true && pd.record)
      .forEach((pd) => {
        enqueueSyncOp(syncTableNameFor(pd.table), pd.record);
      });
  } catch (err) {
    console.error(
      "WorkLog Pro: sign-in reconciliation failed (local edits made while signed out may not sync until the next sign-in):",
      err,
    );
  }
}

// ---------------------------------------------------------------------
// Orchestration + triggers
// ---------------------------------------------------------------------

async function runSyncCycle() {
  if (!isSupabaseConfigured() || typeof getSession !== "function") return;
  try {
    const session = await getSession();
    if (!session) return;
    await pushPendingOps();
    await pullChanges();
    if (typeof renderUI === "function") renderUI();
  } catch (err) {
    console.error("WorkLog Pro: sync cycle failed (will retry):", err);
  }
}

// How long the startup sync attempts below (core/ui.js's runStartupGate(),
// core/projects.js's handleFirstRunAuthSubmit()) wait for a sync pull
// before giving up and proceeding with local data — a few seconds' delay
// is worth it for freshly-synced data, but must never turn into an
// indefinite hang on a slow/offline connection. Not a spec'd value, just
// a reasonable pick within the 3-5s range; easy constant to tune later.
const STARTUP_SYNC_TIMEOUT_MS = 4000;

// Races an arbitrary promise-returning callback against a short timeout —
// used to bound the startup sync attempts so a slow/offline network can
// never block app startup. If the timeout wins, the original work (here,
// always some combination of reconcileLocalWithServer()/runSyncCycle(),
// both of which already handle their own errors internally and never
// throw) is simply left running in the background; the regular periodic
// interval and 'online' event listener below still pick up anything it
// didn't finish, completely unaffected by this. Callers should treat "did
// it finish" as advisory, not authoritative — proceeding regardless is
// the whole point.
function withTimeout(promiseFactory, timeoutMs) {
  return Promise.race([
    promiseFactory(),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

// Deliberately does NOT skip pullChanges() just because the local push
// queue is empty — the periodic/online triggers exist specifically to
// pick up changes pushed from OTHER devices, and an empty local queue
// says nothing about whether the server has new data. The only hard
// early-exit is "not signed in" (runSyncCycle() above), which also covers
// "Supabase isn't configured yet" — both make any network call pointless.
window.addEventListener("online", runSyncCycle);
// 5 minutes is a reasonable default, not a spec'd value — easy constant to
// tune later if it turns out too chatty or too slow to pick up changes.
setInterval(runSyncCycle, 5 * 60 * 1000);
