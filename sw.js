const CACHE = 'cogniswift-v1';
const SHELL = [
  '/',
  '/manifest.json',
  '/icons/icon-dark-192.png',
  '/icons/icon-light-192.png',
  '/icons/icon-dark-512.png',
  '/icons/icon-light-512.png',
  '/icons/icon-light-180.png',
];

// Install: cache the app shell
self.addEventListener('install', function(e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(SHELL);
    })
  );
});

// Activate: clean up old caches
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// Fetch: cache-first for shell assets, network-first for API calls
self.addEventListener('fetch', function(e) {
  var url = new URL(e.request.url);

  // Never cache API calls — always go to network
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(function() {
        return new Response(JSON.stringify({ error: 'You are offline' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // For everything else: try network first, fall back to cache
  e.respondWith(
    fetch(e.request)
      .then(function(response) {
        // Cache successful GET responses
        if (e.request.method === 'GET' && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE).then(function(cache) {
            cache.put(e.request, clone);
          });
        }
        return response;
      })
      .catch(function() {
        // Offline: serve from cache
        return caches.match(e.request).then(function(cached) {
          return cached || caches.match('/');
        });
      })
  );
});
