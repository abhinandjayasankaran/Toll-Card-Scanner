/* Caches the scanner (including the 13 MB OpenCV engine) so it opens instantly. */
'use strict';

const CACHE = 'toll-card-scanner-v1';
const SHELL = [
  './',
  'index.html',
  'scanner.css',
  'scanner.js',
  'detector-worker.js',
  'lib/card-detector.js',
  'vendor/opencv.js',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/scan/')) return;
  if (url.pathname.endsWith('manifest.webmanifest')) return;

  // App code: network first (picks up updates from the Mac), cache as fallback.
  // OpenCV: cache first (large and never changes between releases).
  const cacheFirst = url.pathname.endsWith('/vendor/opencv.js');
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cacheFirst && cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch (err) {
        if (cached) return cached;
        throw err;
      }
    })()
  );
});
