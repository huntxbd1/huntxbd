/* HuntX BD — minimal service worker for install / offline shell only */
const CACHE = 'huntx-shell-v1';
const SHELL = ['/', '/index.html', '/styles.css', '/logo.png', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never cache API / Firebase — always network
  if (url.hostname.includes('googleapis') || url.hostname.includes('firebase') || url.hostname.includes('gstatic')) {
    return;
  }
  // app.js — network first so updates apply quickly
  if (url.pathname.endsWith('app.js')) {
    event.respondWith(
      fetch(req).then((res) => res).catch(() => caches.match(req))
    );
    return;
  }
  // Shell assets — cache first, then network
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      const copy = res.clone();
      if (res.ok && (url.origin === self.location.origin)) {
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => cached))
  );
});
