const CACHE_NAME = 'okatan-v83-cache';
const ASSETS = [
  'index.html',
  'manifest.json',
  'okatan-icon-192.png',
  'okatan-icon-512.png'
];

// Installs the app and saves files for offline use
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

// Controls how the app loads when there is no internet
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      // Returns the saved file if offline, otherwise fetches from web
      return response || fetch(event.request);
    })
  );
});
