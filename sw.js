const CACHE = 'english-station-v3.1';
const scope = new URL('./', self.location.href);
const assets = ['index.html', 'manifest.webmanifest', 'station.svg'].map(path => new URL(path, scope).href);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(assets)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('english-station-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        if (response.ok && response.headers.get('Content-Type')?.includes('text/html')) {
          try {
            const cache = await caches.open(CACHE);
            await cache.put(new URL('index.html', scope).href, response.clone());
          } catch {
            // Cache quota must not prevent an online navigation.
          }
        }
        return response;
      } catch {
        return await caches.match(new URL('index.html', scope).href) || Response.error();
      }
    })());
    return;
  }
  if (assets.includes(url.href)) event.respondWith(caches.match(event.request).then(response => response || fetch(event.request)));
});
