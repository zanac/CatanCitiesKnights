// Service Worker — Catan PWA
const CACHE = 'catan-v2';
const PRECACHE = [
  '/',
  '/mobile',
  '/css/style.css',
  '/css/mobile.css',
  '/js/main.js',
  '/js/mobile.js',
  '/js/i18n.js',
  '/manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first: always try network, fall back to cache for offline
self.addEventListener('fetch', e => {
  // Skip WebSocket and API calls — never cache these
  if (e.request.url.includes('/api/') ||
      e.request.url.startsWith('ws') ||
      e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
