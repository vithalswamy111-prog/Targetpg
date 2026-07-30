// Minimal app-shell service worker: caches the static shell so the app
// still opens (and shows cached data-free UI) offline, while all real data
// (Firestore/Cloudinary/Firebase Auth) always goes over the network as
// normal — this only ever intercepts requests for files that live on this
// same origin (index2.html, manifest.json, icons), never API calls.
const CACHE_NAME = 'qbank-console-v1';
const APP_SHELL = [
  './',
  './index2.html',
  './fb-adapter.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event)=>{
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache=> cache.addAll(APP_SHELL)).catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event)=>{
  event.waitUntil(
    caches.keys().then(keys=>
      Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event)=>{
  const url = new URL(event.request.url);
  // Only handle same-origin GET requests for the app shell itself — every
  // Firebase/Firestore/Cloudinary/Google API call goes straight to the
  // network untouched, so auth/data is always fresh.
  if(event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then(cached=>{
      const fetchPromise = fetch(event.request).then(networkRes=>{
        if(networkRes && networkRes.ok){
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then(cache=> cache.put(event.request, clone));
        }
        return networkRes;
      }).catch(()=> cached);
      return cached || fetchPromise;
    })
  );
});
