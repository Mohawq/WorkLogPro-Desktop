// platform-web/service-worker.js
//
// Minimal service worker whose only job is to satisfy PWA installability
// criteria ("Add to Home Screen" on iOS, install prompts on
// Chrome/Android/desktop) and give repeat visits a small speed-up by
// caching the app shell. This is explicitly NOT an offline data strategy —
// core/storage.js still reads/writes localStorage directly and has no
// awareness of this cache. If the network is unavailable, cached shell
// files will still load, but nothing here queues writes or syncs data;
// that's future Supabase-backed work, out of scope for this pass.

// Bumped to v4 because index.html itself changed substantially (the
// Phase 1-3 UI/UX redesign — Cloud Sync promoted to its own card, Shift
// Settings split into sections, stacked mobile tables, etc.) — this is
// cache-first (see the fetch handler below), so a same-named cache would
// have kept serving the pre-redesign index.html to already-installed
// PWAs indefinitely, exactly the failure mode the v1->v2/v2->v3 bumps
// above were already guarding against.
const CACHE_NAME = "worklogpro-shell-v4";

// Paths are relative to this file's own location (platform-web/), matching
// how index.html references core/*.js.
const SHELL_ASSETS = [
  "index.html",
  "manifest.json",
  "pdf-export.js",
  "mobile-nav.js",
  "./core/state.js",
  "./core/storage.js",
  "./core/i18n.js",
  "./core/projects.js",
  "./core/shift-tracking.js",
  "./core/invoicing.js",
  "./core/ui.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Cache-first for the app shell files above; everything else (CDN
// Tailwind/FontAwesome/fonts, any future network calls) just passes through
// to the network untouched — no offline fallback is attempted for those.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request);
    }),
  );
});
