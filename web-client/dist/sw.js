// Giano Reader Service Worker
// Full offline support for the installed PWA: the entire app shell (index.html,
// hashed JS/CSS bundles, icons, manifest) is precached at install time, so the
// app starts even when the GianoReader server is unreachable.
//
// BUILD_VERSION and PRECACHE_URLS below are placeholders: during `npm run build`
// the script scripts/generate-sw.mjs rewrites them with the real content hash
// and the full list of files emitted into dist/. The defaults keep the file
// valid when served by the Vite dev server.

const BUILD_VERSION = '84da3f44673d';
const CACHE_NAME = `giano-reader-${BUILD_VERSION}`;

const PRECACHE_URLS = [
  "/",
  "/assets/index-DZD5xQs0.js",
  "/assets/index-xRpeU4Wy.css",
  "/favicon.ico",
  "/icons/book-bookmark.svg",
  "/icons/gear.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/star.svg",
  "/icons/upload.svg",
  "/icons/xmark.svg",
  "/index.html",
  "/manifest.json"
];

// Minimal last-resort page: only shown if the app shell was never cached
// (e.g. very first visit happens while already offline).
const OFFLINE_PAGE = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Giano Reader</title>
  <style>
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
           background: #121212; color: #eee; font-family: system-ui, sans-serif; text-align: center; padding: 1.5rem; }
    p { color: #aaa; line-height: 1.5; }
  </style>
</head>
<body>
  <div>
    <h1>Giano Reader</h1>
    <p>L'app non è ancora disponibile offline.<br/>
       Connettiti al server almeno una volta per completare l'installazione, poi riprova.</p>
  </div>
</body>
</html>`;

self.addEventListener('install', (event) => {
  // Activate the new SW immediately, without waiting for old clients to close
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Cache each asset independently: a single failure must not abort the rest
      Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) => console.warn('[SW] precache failed for', url, err))
        )
      )
    )
  );
});

self.addEventListener('activate', (event) => {
  // Remove caches from previous versions
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

/**
 * Navigations: network-first so updates are picked up when the server is
 * reachable; on network failure serve the cached app shell; as a last resort
 * return the inline offline page — never let respondWith reject, otherwise
 * Chrome shows its own "site unreachable" error page.
 */
async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached =
      (await caches.match(request)) ||
      (await caches.match('/index.html')) ||
      (await caches.match('/'));
    if (cached) return cached;
    return new Response(OFFLINE_PAGE, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

/** Static assets: cache-first, with runtime caching of successful responses. */
async function handleStaticAsset(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // API requests always go to the network — never served from cache.
  // The app handles API failures itself (disconnected overlay / offline mode).
  if (url.pathname.startsWith('/api/')) return;

  // Vite dev-server internals: never cache, to avoid stale modules in dev
  if (
    url.pathname.startsWith('/@') ||
    url.pathname.startsWith('/src/') ||
    url.pathname.startsWith('/node_modules/')
  ) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(handleStaticAsset(request));
  }
});
