const CACHE_NAME = 'tnt-v3';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/style.css',
  '/test-ui.css',
  '/app.js',
  '/rapier-physics.js',
  '/vendor/@dimforge/rapier3d-compat/rapier.mjs',
  '/vendor/@dimforge/rapier3d-compat/rapier_wasm3d_bg.wasm',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((r) => r || fetch(e.request))
  );
});
