// Shell-only service worker: caches the app shell so the PWA opens offline; API calls, boards and pages are never cached.
// Only a plain same-origin 200 is cached: after a sign-in expiry a subresource fetch follows the redirect to the IdP's
// login page, and caching that as /app.js would break the PWA until the cache name changes.
const CACHE = 'workbench-shell-v6';   // v6: the frame runtime loads babel.scm (hypernotes H1); v5: the Edwin runtime gains display.js (DT0); v4: app.js knows buf (edwind spec R8.20), the Edwin runtime joins the shell
// The Edwin frame runtime and console live under /edwin/ and are part of the shell (edwind spec R9.19): the page editor
// works offline-first like the rest of the app; pages themselves (buffers over /edit) are never cached.
const EDWIN = ['/edwin/', '/edwin/index.html', '/edwin/src/host-browser.js', '/edwin/src/scheme.js', '/edwin/src/runtime.js', '/edwin/src/text.js', '/edwin/src/editor-core.js', '/edwin/src/editor-prims.js', '/edwin/src/evil-core.js', '/edwin/src/pool.js', '/edwin/src/complete.js', '/edwin/src/extras.js', '/edwin/src/stack.js', '/edwin/src/ai.js', '/edwin/src/evil-ex.js', '/edwin/src/org.js', '/edwin/src/markdown.js', '/edwin/src/ot.js', '/edwin/src/sync.js', '/edwin/src/display.js',
  '/edwin/scm/emacs.scm', '/edwin/scm/evil.scm', '/edwin/scm/org.scm', '/edwin/scm/ai.scm', '/edwin/scm/init.scm', '/edwin/scm/notes-syntax.scm', '/edwin/scm/address.scm', '/edwin/scm/markdown.scm', '/edwin/scm/babel.scm'];
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/keys.js', '/bridge.js', '/vendor/vendor.js', '/vendor/xterm.css', '/fonts/fonts.css', '/manifest.webmanifest', '/icon.svg'];
const shell = (p: string) => SHELL.includes(p) || EDWIN.includes(p);
const cacheable = (r: Response) => r.ok && !r.redirected && r.type === 'basic';
const put = (c: Cache, p: string) => fetch(p, { cache: 'no-cache' }).then(r => { if (!cacheable(r)) throw new Error('not cacheable: ' + p); return c.put(p, r); });
// The font files are the ones fonts.css names (the build generates both), cached with the shell so that a launch after
// one visit renders in them offline, and fetched again whenever the cache name changes.
const fontFiles = (css: string) => [...css.matchAll(/url\("([^"]+)"\)/g)].map(m => new URL(m[1], location.origin + '/fonts/').pathname);
(self as unknown as ServiceWorkerGlobalScope).addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(SHELL.map(p => put(c, p)))
      .then(() => Promise.allSettled(EDWIN.map(p => put(c, p))))   // best effort: a wb-web that does not serve /edwin/ yet still gets its shell
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
