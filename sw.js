/* Drive to MEGA service worker.
 * Caches only this site's own static files. Google/MEGA API traffic is never intercepted or cached,
 * so tokens, file contents and encrypted chunks never touch the Cache Storage. */
'use strict';
const VERSION = '2.2.0';
const CACHE = 'd2m-' + VERSION;
const SHELL = [
  '/', '/index.html', '/offline.html', '/privacy.html', '/terms.html', '/how-to-transfer-google-drive-to-mega/', '/manifest.webmanifest', '/favicon.ico',
  '/assets/css/app.css', '/assets/js/app.js', '/assets/js/theme-init.js', '/assets/js/config.js', '/assets/js/mega-fast-crypto.js', '/assets/js/crypto-worker.js',
  '/assets/vendor/megajs-1.3.10.min.js',
  '/assets/icons/logo.svg', '/assets/icons/favicon.svg', '/assets/icons/icon-192.png', '/assets/icons/icon-512.png',
  '/assets/icons/maskable-512.png', '/assets/icons/apple-touch-icon.png', '/assets/icons/badge-96.png'
];
// Always try the network first for these so deploys (and a new Client ID) take effect immediately.
const NETWORK_FIRST = new Set(['/', '/index.html', '/assets/js/config.js', '/manifest.webmanifest']);

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('d2m-') && k !== CACHE) await caches.delete(k);
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch Google/MEGA traffic
  if (req.headers.has('range')) return;

  if (req.mode === 'navigate'){
    e.respondWith((async () => {
      try {
        const preload = await e.preloadResponse;
        const res = preload || await fetch(req);
        if (res.ok && (url.pathname === '/' || url.pathname === '/index.html')) (await caches.open(CACHE)).put('/', res.clone());
        return res;
      } catch {
        const c = await caches.open(CACHE);
        return (await c.match(url.pathname === '/' ? '/' : req, { ignoreSearch: true })) || (await c.match('/')) || c.match('/offline.html');
      }
    })());
    return;
  }

  if (NETWORK_FIRST.has(url.pathname)){
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
    return;
  }

  // Stale-while-revalidate for the rest of the static files.
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then(res => {
      if (res.ok && res.type === 'basic') c.put(req, res.clone());
      return res;
    }).catch(() => hit);
    if (hit){ e.waitUntil(net); return hit; }
    return net;
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = all.find(c => new URL(c.url).origin === self.location.origin);
    if (win) return win.focus();
    return self.clients.openWindow('/?tab=queue');
  })());
});
