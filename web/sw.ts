// Shell-only service worker: caches the app shell so the PWA opens offline; API calls, boards and pages are never cached.
// Only a plain same-origin 200 is cached: after a sign-in expiry a subresource fetch follows the redirect to the IdP's
// login page, and caching that as /app.js would break the PWA until the cache name changes.
const CACHE = 'workbench-shell-v8';   // v8: the Edwin runtime is what its manifest.json lists; v7: pdf, op cards (F-A40, F-A41); v6: the frame runtime loads babel.scm (hypernotes H1); v5: the Edwin runtime gains display.js (DT0); v4: app.js knows buf (edwind spec R8.20), the Edwin runtime joins the shell
// The Edwin frame runtime and console live under /edwin/ and are part of the shell (edwind spec R9.19): the page editor
// works offline-first like the rest of the app; pages themselves (buffers over /edit) are never cached. Install caches
// the console and what the runtime's manifest.json lists; every file under /edwin/ is cached as it is fetched.
const EDWIN_MANIFEST = '/edwin/manifest.json';
const edwinFiles = (m: { files: string[]; scm: string[] }) => ['/edwin/', '/edwin/index.html', ...[...m.files, ...m.scm].map(f => '/edwin/' + f)];
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/keys.js', '/bridge.js', '/vendor/vendor.js', '/vendor/xterm.css', '/fonts/fonts.css', '/manifest.webmanifest', '/icon.svg'];
// pdf.js (1.7 MB) is cached the first time a pdf card loads it, not at install: most boards hold no PDF. So is each
// CMap a PDF asks for.
const PDFJS = ['/vendor/pdfjs/pdf.min.mjs', '/vendor/pdfjs/pdf.worker.min.mjs'];
const shell = (p: string) => SHELL.includes(p) || p.startsWith('/edwin/') || PDFJS.includes(p) || /^\/vendor\/pdfjs\/cmaps\/[\w.-]+\.bcmap$/.test(p);
const cacheable = (r: Response) => r.ok && !r.redirected && r.type === 'basic';
const put = (c: Cache, p: string) => fetch(p, { cache: 'no-cache' }).then(r => { if (!cacheable(r)) throw new Error('not cacheable: ' + p); return c.put(p, r); });
// The font files are the ones fonts.css names (the build generates both), cached with the shell so that a launch after
// one visit renders in them offline, and fetched again whenever the cache name changes.
const fontFiles = (css: string) => [...css.matchAll(/url\("([^"]+)"\)/g)].map(m => new URL(m[1], location.origin + '/fonts/').pathname);
(self as unknown as ServiceWorkerGlobalScope).addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(SHELL.map(p => put(c, p)))
      .then(() => put(c, EDWIN_MANIFEST).then(() => c.match(EDWIN_MANIFEST)).then(r => r!.json()).then(m => Promise.allSettled(edwinFiles(m).map(p => put(c, p))))   // best effort: a wb-web that does not serve /edwin/ yet still gets its shell
        .catch(e => console.warn('sw: Edwin runtime not cached', e)))
      .then(() => c.match('/fonts/fonts.css')).then(r => r!.text())
      .then(css => Promise.all(fontFiles(css).map(p => put(c, p)))))
    .then(() => (self as unknown as ServiceWorkerGlobalScope).skipWaiting()));
});
(self as unknown as ServiceWorkerGlobalScope).addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => (self as unknown as ServiceWorkerGlobalScope).clients.claim())); });
(self as unknown as ServiceWorkerGlobalScope).addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname === '/rpc' || u.pathname === '/pty' || u.pathname === '/acp' || u.pathname === '/edit') return;
  // Font files: cache-first, from install. fonts.css itself is part of the shell (network-first).
  if (u.pathname.startsWith('/fonts/') && !shell(u.pathname)) return void e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
  e.respondWith(fetch(e.request).then(r => { if (cacheable(r) && shell(u.pathname)) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; }).catch(() => caches.match(e.request) as Promise<Response>));
});
// F-A12: a notification names its card's sid. A click focuses an open Workbench page, which shows the card full
// screen, or opens one at /?focus=SID.
(self as unknown as ServiceWorkerGlobalScope).addEventListener('notificationclick', e => {
  const sid = String(e.notification.data?.sid || e.notification.tag || ''); e.notification.close();
  const sw = self as unknown as ServiceWorkerGlobalScope;
  e.waitUntil(sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs.find(c => new URL(c.url).origin === location.origin);
    if (c) { c.postMessage({ t: 'focus', sid }); return c.focus().then(() => undefined); }
    return sw.clients.openWindow('/?focus=' + encodeURIComponent(sid)).then(() => undefined);
  }));
});
