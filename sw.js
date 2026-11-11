/* Trail Mapper service worker: keeps the app itself and the map pieces you viewed for offline use.
   The app's own files come from the network first, so an update is never mixed with an old copy. */
const SHELL = 'tm-shell-v3';
const TILES = 'tm-tiles-v1';
const MAX_TILES = 4000;
const SHELL_FILES = ['./', 'index.html', 'app.css?v=4', 'app.js?v=4', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-180.png', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES.map((f) => new Request(f, { cache: 'reload' })))).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('tm-shell-') && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

let trimming = false;
async function trimTiles() {
  if (trimming) return; trimming = true;
  try {
    const c = await caches.open(TILES); const keys = await c.keys();
    if (keys.length > MAX_TILES) for (const k of keys.slice(0, keys.length - MAX_TILES)) await c.delete(k);
  } finally { trimming = false; }
}

self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'tile.openstreetmap.org') {
    // Map pieces: use the saved copy first, fetch and save when missing.
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(req, { ignoreVary: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok && res.type !== 'opaque') { c.put(req, res.clone()); if (Math.random() < 0.05) trimTiles(); }
        return res;
      } catch (err) { return new Response('', { status: 504 }); }
    }));
    return;
  }
  if (url.origin === self.location.origin && !url.pathname.includes('__tm-data/')) {
    // The app itself: newest copy from the network, the saved copy only when offline.
    e.respondWith(caches.open(SHELL).then(async (c) => {
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch (err) {
        return (await c.match(req)) || (await c.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' && (await c.match('index.html'))) || new Response('Offline', { status: 503 });
      }
    }));
  }
});
