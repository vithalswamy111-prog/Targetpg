// QBank Console — service worker
// Purpose: (1) satisfy the "has a service worker" requirement browsers use
// to decide whether a site is installable as an app, and (2) let the app
// shell (HTML/JS/icons) load instantly offline or on a bad connection.
//
// Bump this version string whenever index.html / fb-adapter.js change, so
// returning users actually get the new file instead of a stale cached copy.
const CACHE_NAME = 'qbank-console-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './fb-adapter.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for same-origin app-shell files. Everything else — Firebase
// auth/Firestore calls, Cloudinary uploads, CDN libraries (html2canvas,
// jsPDF, Chart.js, fonts) — goes straight to the network untouched. Caching
// those would risk serving stale question data, breaking auth, or shipping
// outdated library code.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      }).catch(() => cached);
      // Serve cached instantly if we have it (fast + works offline), but
      // still refresh the cache in the background so the next load is current.
      return cached || network;
    })
  );
});
