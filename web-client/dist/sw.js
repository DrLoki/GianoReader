// Giano Reader Service Worker
// Minimal SW required for PWA installability.
// The app is not designed for offline use — it requires the GianoReader server.
// This SW fulfills the browser installability requirement without hiding connectivity errors.

const CACHE_NAME = 'giano-reader-v1';

// Only cache the app shell (static assets), not API responses
const SHELL_ASSETS = [
  '/',
  '/manifest.json',
  '/favicon.ico',
];

self.addEventListener('install', (event) => {
  // Skip waiting so the new SW activates immediately
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS).catch(() => {
      // Silently ignore caching failures (e.g. when offline at install time)
    }))
  );
});

self.addEventListener('activate', (event) => {
  // Remove old caches
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Let API requests always go to the network — never serve from cache
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // For navigation requests, try network first (app requires server),
  // fall back to cache only if completely offline
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match('/').then((cached) => cached || fetch(event.request))
      )
    );
    return;
  }

  // For static assets: cache-first strategy
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache only successful same-origin responses
        if (
          response.ok &&
          url.origin === self.location.origin &&
          !url.pathname.startsWith('/api/')
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
