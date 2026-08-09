// core/sync-queue.js — local IndexedDB queue of not-yet-pushed sync
// operations. Knows nothing about Supabase or the network; core/sync.js is
// the only file that reads from this queue and talks to the server. Native
// indexedDB API only, no library — consistent with the rest of this repo
// (Tailwind/FontAwesome load via CDN, no bundler exists here).

const SYNC_DB_NAME = "worklogpro_sync";
const SYNC_DB_VERSION = 1;
const PENDING_OPS_STORE = "pending_ops";

let _syncDbPromise = null;

function openSyncDb() {
  if (_syncDbPromise) return _syncDbPromise;
  _syncDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(SYNC_DB_NAME, SYNC_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PENDING_OPS_STORE)) {
        const store = db.createObjectStore(PENDING_OPS_STORE, {
          keyPath: "opId",
          autoIncrement: true,
        });
        // Coalescing key is table + record.syncId, not the local record
        // `id` — some record shapes (an in-progress currentShift) never
        // get a local `id` at all, while syncId is always present once
        // storage.js's stampAndSync() has touched the record.
        store.createIndex("table_syncId", ["table", "recordSyncId"], {
          unique: false,
        });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _syncDbPromise;
}

// Writes { table, record, recordSyncId, queuedAt }, replacing (rather than
// duplicating) any existing queued op for the same table + record.syncId —
// so rapid edits to one record (clock in -> start break -> end break ->
// clock out are all the same shift row) coalesce into a single push
// instead of piling up duplicate ops.
async function enqueueSyncOp(table, record) {
  const db = await openSyncDb();
  const tx = db.transaction(PENDING_OPS_STORE, "readwrite");
  const store = tx.objectStore(PENDING_OPS_STORE);
  const index = store.index("table_syncId");

  const existingKey = await new Promise((resolve, reject) => {
    const req = index.getKey([table, record.syncId]);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const entry = {
    table,
    record,
    recordSyncId: record.syncId,
    queuedAt: getMsTimestamp(),
  };
  if (existingKey !== undefined) entry.opId = existingKey;
  store.put(entry);

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Oldest-first (insertion order — a coalesced op keeps its original
// opId/position, so this reflects when a record was FIRST queued, not when
// it was last edited).
async function getAllPendingOps() {
  const db = await openSyncDb();
  const tx = db.transaction(PENDING_OPS_STORE, "readonly");
  const store = tx.objectStore(PENDING_OPS_STORE);
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function removePendingOp(opId) {
  const db = await openSyncDb();
  const tx = db.transaction(PENDING_OPS_STORE, "readwrite");
  tx.objectStore(PENDING_OPS_STORE).delete(opId);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// "Reset local sync state" escape hatch — see core/sync.js.
async function clearAllPendingOps() {
  const db = await openSyncDb();
  const tx = db.transaction(PENDING_OPS_STORE, "readwrite");
  tx.objectStore(PENDING_OPS_STORE).clear();
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
