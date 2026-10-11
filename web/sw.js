// Shell-only service worker: caches the app shell so the PWA opens offline; API calls, boards and pages are never cached.
const CACHE = 'workbench-shell-v1';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/bridge.js', '/vendor/vendor.js', '/vendor/xterm.css', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname === '/rpc' || u.pathname === '/pty') return;
  e.respondWith(fetch(e.request).then(r => { if (r.ok && SHELL.includes(u.pathname)) caches.open(CACHE).then(c => c.put(e.request, r.clone())); return r; }).catch(() => caches.match(e.request)));
});
