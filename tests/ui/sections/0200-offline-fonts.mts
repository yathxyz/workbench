import { check, section, state } from '../shared.mts';
import { ORIGIN, api } from '../daemon.mts';

const { browser } = state;

// DELTA-1 §A.4: index.html preloads a font file, and the service worker caches every font file fonts.css names at
// install, so a launch after one visit renders in them offline. Its own context: the daemon context blocks workers.
await section('§A.4', async () => {
  const css = await (await api('/fonts/fonts.css')).text(), want = [...css.matchAll(/url\("([^"]+)"\)/g)].map(m => '/fonts/' + m[1]);
  const html = await (await api('/')).text(), pre = [...html.matchAll(/<link [^>]*rel="preload"[^>]*>/g)].map(l => l[0].match(/href="([^"]+)"/)?.[1]).filter(Boolean).map(h => new URL(h!, ORIGIN + '/').pathname);
  check('§A.4: index.html preloads a font file fonts.css names', pre.length > 0 && pre.every(h => want.includes(h)), JSON.stringify({ pre, want }));
  const sctx = await browser.newContext({ serviceWorkers: 'allow' });
  try {
    const p = await sctx.newPage(); await p.goto(ORIGIN + '/icon.svg');
    const have = await p.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js');
      await Promise.race([navigator.serviceWorker.ready, new Promise((_, no) => setTimeout(() => no(new Error('no active service worker after 15 s')), 15000))]);
      const out = []; for (const k of await caches.keys()) for (const q of await (await caches.open(k)).keys()) out.push(new URL(q.url).pathname);
      return out;
    });
    check('§A.4: the service worker caches every font file fonts.css names when it installs', want.length >= 4 && want.every(w => have.includes(w)), JSON.stringify({ want, have }));
    const man = await (await api('/edwin/manifest.json')).json(), runtime = ['/edwin/manifest.json', ...[...man.files, ...man.scm].map((f: string) => '/edwin/' + f)];
    check('§A.4: the service worker caches the Edwin runtime /edwin/manifest.json lists when it installs', man.api === 1 && runtime.length > 20 && runtime.every(w => have.includes(w)), JSON.stringify({ missing: runtime.filter(w => !have.includes(w)) }));
  } finally { await sctx.close(); }
});
