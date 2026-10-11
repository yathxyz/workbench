// Shell-only service worker: caches the app shell so the PWA opens offline; API calls, boards and pages are never cached.
// Only a plain same-origin 200 is cached: after a sign-in expiry a subresource fetch follows the redirect to the IdP's
// login page, and caching that as /app.js would break the PWA until the cache name changes.
const CACHE = 'workbench-shell-v2';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/bridge.js', '/vendor/vendor.js', '/vendor/xterm.css', '/fonts/fonts.css', '/manifest.webmanifest', '/icon.svg'];
const cacheable = r => r.ok && !r.redirected && r.type === 'basic';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(SHELL.map(p => fetch(p, { cache: 'no-cache' }).then(r => { if (!cacheable(r)) throw new Error('not cacheable: ' + p); return c.put(p, r); }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname === '/rpc' || u.pathname === '/pty' || u.pathname === '/acp') return;
  // Font files: cache-first, cached on first fetch. fonts.css itself is part of the shell (network-first).
  if (u.pathname.startsWith('/fonts/') && !SHELL.includes(u.pathname)) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (cacheable(r)) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })));
    return;
  }
  e.respondWith(fetch(e.request).then(r => { if (cacheable(r) && SHELL.includes(u.pathname)) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; }).catch(() => caches.match(e.request)));
});
